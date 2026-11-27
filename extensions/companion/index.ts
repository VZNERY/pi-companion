import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bbContext } from "./bb.ts";
import { detectGuardrail } from "./guardrails.ts";
import { isFinished, JobStore, processAlive, type Job } from "./store.ts";
import { buildPrompt, isEnabled, learn, readIfExists, setEnabled } from "./prompt.ts";
import { killGroup, workerCommand, WORKERS } from "./workers.ts";

/**
 * pi-companion: turns a Pi session into a personal companion.
 *   1. Adds his profile, working rules and skill routing to the system prompt (small, size-budgeted).
 *   2. Adds three tools: delegate (hand work to a background worker), jobs (check or cancel), remember (learn a rule).
 *   3. Posts each worker's short report back into the same conversation when it finishes. Workers run as their own
 *      detached processes, so a job keeps going when this session closes and is reported when the conversation reopens.
 *   4. Inside bb, a delegated job is a real bb child thread (bb.ts, bb-runner.ts) — visible in the sidebar with its
 *      own task and provider, not a hidden process — so the user can open and watch exactly what each worker is
 *      doing. Outside bb, delegate falls back to a local background process (workers.ts, runner.ts).
 * Switch it with /companion on|off|status. With it off, Pi behaves exactly as without this package.
 * Fails open: if the job list cannot be opened Pi still starts, with the profile only.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = process.env.PI_COMPANION_DATA_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-companion");
const STATE_PATH = join(DATA_DIR, "state.json");
const LEARNED_PATH = join(DATA_DIR, "learned.md");
const JOBS_PATH = join(DATA_DIR, "jobs.sqlite");
const TOOL_NAMES = ["delegate", "jobs", "remember", "companion"];
const JOB_TIMEOUT_MS = 45 * 60_000;
const MAX_RUNNING = 4;
const POLL_MS = 4000;
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.ts");
const BB_RUNNER = join(dirname(fileURLToPath(import.meta.url)), "bb-runner.ts");
/** Reports go back to the conversation that started the job: the bb thread, or the folder when run outside bb. */
const originOf = (cwd: string) => process.env.BB_THREAD_ID ?? `cwd:${cwd}`;

const RECENT_WINDOW_MS = 60 * 60_000;

/** What the companion needs to decide whether a new request continues open work: the recent jobs and what they did. */
function openWorkBlock(jobs: JobStore | undefined, origin: string): string {
  if (!jobs) return "";
  const recent = jobs.recentFor(origin, RECENT_WINDOW_MS);
  if (recent.length === 0) return "";
  const lines = recent.map((job) => {
    const outcome = job.status === "done" ? `result: ${short(job.result ?? "", 160)}` : job.status;
    return `- ${job.id} [${job.status}] ${job.worker}: asked "${short(job.task, 120)}" → ${outcome}`;
  });
  return (
    "Recent background work in this conversation:\n" + lines.join("\n") +
    "\nIf the user's new message is about the same thing as one of these (for example a change to the same image, file or document), " +
    "call delegate with continue_job set to that job's id, so the same worker keeps its context. If it is about something else, " +
    "leave continue_job out to start a new job. If it is genuinely unclear, ask the user one short question first."
  );
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
const age = (from: number | null) => (from === null ? "" : `${Math.max(1, Math.round((Date.now() - from) / 60000))} min`);
const short = (value: string, max = 90) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

// bb renders @thread:<id> as a clickable link; never build a thread URL by hand.
const threadRef = (job: Job) => (job.childThreadId ? ` (@thread:${job.childThreadId})` : "");

function jobLine(job: Job): string {
  const when = job.status === "running" ? `running ${age(job.startedAt)}` : job.status;
  return `${job.id} [${when}] ${job.worker}${job.model ? `/${job.model}` : ""}${threadRef(job)}: ${short(job.task)}`;
}

function report(job: Job): string {
  const head = `Background job ${job.id} (${job.worker}${threadRef(job)}) ${job.status === "done" ? "finished" : job.status}. Task: ${short(job.task, 160)}`;
  const body = job.status === "done" ? job.result ?? "" : `Reason: ${job.error ?? "unknown"}${job.result ? `\nLast output:\n${job.result}` : ""}`;
  return `${head}\n\n${body}\n\nTell the user the outcome in a few plain sentences, and mention the @thread: link above if one is present so they can open its full session. Do not claim more than this report says.`;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  if (process.env.PI_COMPANION === "off") return; // a background worker: stay plain Pi

  let store: JobStore | undefined;
  let storeError: string | undefined;
  let origin = originOf(process.cwd());
  let poller: ReturnType<typeof setInterval> | undefined;

  const openStore = (): JobStore | undefined => {
    if (store || storeError) return store;
    try {
      store = new JobStore(JOBS_PATH);
    } catch (error) {
      storeError = error instanceof Error ? error.message : String(error);
    }
    return store;
  };

  /** Reports this conversation's finished jobs. Each job is claimed first, so it is posted exactly once. */
  const announceFinished = () => {
    const jobs = openStore();
    if (!jobs) return;
    try {
      jobs.reconcile(processAlive);
      for (const job of jobs.unannounced(origin)) {
        if (!jobs.claimAnnouncement(job.id)) continue;
        pi.sendMessage(
          { customType: "companion-job", content: report(job), display: true, details: { jobId: job.id, status: job.status } },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }
    } catch (error) {
      // A locked or unreadable job list must not take the session down; the next tick tries again.
      storeError = undefined;
      console.error(`pi-companion: could not check jobs: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  pi.registerTool({
    name: "delegate",
    label: "Delegate to a background worker",
    description:
      "Hand a task to a background worker that runs in its own context, so this conversation stays free. Returns at once " +
      "with a job id; the worker's short report is posted here when it ends, even if this session was closed in between. " +
      "Workers: pi (default, general and coding), claude (frontend and visual design), codex. Write the task as one " +
      "complete instruction: the worker sees none of this conversation. Inside bb, the worker runs as a visible bb " +
      "child thread, so the user can open and watch it directly.",
    promptSnippet: "Hand long or multi-step work to a background worker and keep talking",
    promptGuidelines: [
      "Use delegate for any work that needs more than a few tool calls or more than about a minute; answer quick questions and do small checks yourself.",
      "After calling delegate, tell the user in one short sentence that the work has started, then stop. Never wait or poll in a loop.",
      "Never say a delegated job is done until its report has arrived in the conversation.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete, self-contained instruction for the worker, including paths and what a finished result looks like" }),
      worker: Type.Optional(Type.String({ description: `One of: ${WORKERS.join(", ")}. Default pi.` })),
      model: Type.Optional(Type.String({ description: "Model for the worker, for example minimax/MiniMax-M3. Leave out to use the worker's default." })),
      cwd: Type.Optional(Type.String({ description: "Folder the worker runs in. Default: this session's folder." })),
      continue_job: Type.Optional(Type.String({ description: "Id of a recent job in this conversation whose work this request continues. Its worker gets the request as a follow-up and keeps its context." })),
    }),
    async execute(_id: string, params: { task: string; worker?: string; model?: string; cwd?: string; continue_job?: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      const jobs = openStore();
      if (!jobs) throw new Error(`the job list is unavailable (${storeError}); do the work directly or tell the user`);
      if (jobs.active().length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} jobs are already running; wait for one to finish or cancel one with the jobs tool`);
      const worker = params.worker ?? "pi";
      workerCommand(worker, params.task, params.model); // throws on an unknown worker before a job is created
      // Continuing open work: the same bb child thread gets the follow-up, so the worker keeps its context.
      const previous = params.continue_job ? jobs.get(params.continue_job) : undefined;
      if (params.continue_job && (!previous || previous.origin !== origin)) {
        throw new Error(`no recent job "${params.continue_job}" in this conversation; start a new job without continue_job`);
      }
      const continuing = previous?.childThreadId ? previous : undefined;
      const job = jobs.create({
        task: params.task,
        worker: continuing?.worker ?? worker,
        model: continuing?.model ?? params.model,
        cwd: params.cwd ?? continuing?.cwd ?? ctx.cwd,
        origin,
        childThreadId: continuing?.childThreadId ?? null,
      });
      // Inside bb, hand the job to a real bb child thread so the user can see and open it; otherwise a local process.
      const runningInBb = bbContext() !== undefined;
      const script = runningInBb ? BB_RUNNER : RUNNER;
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        const log = openSync(join(DATA_DIR, "runner.log"), "a");
        // Detached and unref'd: the runner outlives this session and writes the outcome into the job list itself.
        const runner = spawn(process.execPath, [script, JOBS_PATH, job.id, String(JOB_TIMEOUT_MS)], {
          cwd: job.cwd,
          detached: true,
          stdio: ["ignore", log, log],
          env: { ...process.env, PI_COMPANION: "off" },
        });
        runner.on("error", (error) => { jobs.finish(job.id, "failed", { error: `could not start the job runner: ${error.message}` }); });
        runner.unref();
      } catch (error) {
        jobs.finish(job.id, "failed", { error: `could not start the job runner: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      return text(
        `Started job ${job.id} on ${continuing ? `the same worker (${continuing.worker}, continuing job ${continuing.id})` : worker}${runningInBb ? " as a bb child thread; its id will be announced shortly" : ""}. ` +
          "Its report will arrive in this conversation when it ends.",
      );
    },
  } as never);

  pi.registerTool({
    name: "jobs",
    label: "Background jobs",
    description: "List background jobs, read one job's status and result, or cancel a running job.",
    promptGuidelines: ["Use jobs when the user asks how a task is going or wants one stopped; answer from what jobs returns, in one or two sentences."],
    parameters: Type.Object({
      action: Type.String({ description: "list, status or cancel" }),
      id: Type.Optional(Type.String({ description: "Job id or a unique prefix (needed for status and cancel)" })),
    }),
    async execute(_id: string, params: { action: string; id?: string }) {
      const jobs = openStore();
      if (!jobs) throw new Error(`the job list is unavailable (${storeError})`);
      jobs.reconcile(processAlive);
      if (params.action === "list") {
        const all = jobs.list(12);
        return text(all.length ? all.map(jobLine).join("\n") : "No background jobs yet.");
      }
      const job = params.id ? jobs.get(params.id) : undefined;
      if (!job) throw new Error(params.id ? `no single job matches "${params.id}"` : `${params.action} needs a job id`);
      if (params.action === "status") {
        const detail = isFinished(job.status) ? `\n${job.status === "done" ? job.result ?? "" : `Reason: ${job.error ?? "unknown"}`}` : "";
        return text(jobLine(job) + detail);
      }
      if (params.action === "cancel") {
        if (isFinished(job.status)) return text(`Job ${job.id} had already ended (${job.status}).`);
        // Written first, so the job is correctly "cancelled" even if a stop command below fails or is slow.
        jobs.finish(job.id, "cancelled", { error: "cancelled by the user" });
        if (job.childThreadId) {
          try {
            execFileSync("bb", ["thread", "stop", job.childThreadId], { timeout: 15_000 });
          } catch (error) {
            // Best effort: the job is already recorded as cancelled regardless of whether bb could stop it.
            console.error(`pi-companion: could not stop bb thread ${job.childThreadId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // The stored pid is the runner (local worker or bb-runner); it stops whatever it started.
        if (job.pid !== null && processAlive(job.pid)) killGroup(job.pid);
        return text(`Cancelled job ${job.id}${job.childThreadId ? ` and stopped @thread:${job.childThreadId}` : ""}.`);
      }
      throw new Error(`unknown action "${params.action}" (use list, status or cancel)`);
    },
  } as never);

  pi.registerTool({
    name: "remember",
    label: "Remember a preference",
    description:
      "Save one lasting preference or correction from the user so it applies in every future session. One short line, " +
      "written as a rule. Not for facts about projects or one-off task details (those belong in Cortex).",
    promptGuidelines: ["Use remember when the user corrects how you work or states a standing preference; then confirm in one sentence what was saved."],
    parameters: Type.Object({ rule: Type.String({ description: "The preference as one short rule, with the reason if the user gave one" }) }),
    async execute(_id: string, params: { rule: string }) {
      return text(learn(LEARNED_PATH, params.rule) ? "Saved. It applies from the next message on." : "That rule was already saved.");
    },
  } as never);

  pi.registerTool({
    name: "companion",
    label: "Companion switch",
    description:
      "Turn the companion profile and tools on or off, or check status. Use this, not the /companion slash command: " +
      "typed slash commands do not reach this extension when run through bb, only this tool does.",
    parameters: Type.Object({ action: Type.String({ description: "on, off or status" }) }),
    async execute(_id: string, params: { action: string }) {
      const action = params.action.trim().toLowerCase();
      if (action === "on" || action === "off") {
        setEnabled(STATE_PATH, action === "on");
        applySwitch(action === "on");
        if (action === "on") startPolling();
        else stopPolling();
        return text(`Companion ${action}.`);
      }
      if (action === "status") {
        const prompt = buildPrompt({
          profile: readIfExists(join(PACKAGE_ROOT, "profile", "PROFILE.md")),
          routing: readIfExists(join(PACKAGE_ROOT, "profile", "ROUTING.md")),
          learned: readIfExists(LEARNED_PATH),
        });
        const jobs = openStore();
        return text(
          `Companion ${isEnabled(STATE_PATH) ? "on" : "off"} · prompt ${prompt.text.length} chars${prompt.overBudget ? " (OVER BUDGET)" : ""} · ` +
            (jobs ? `${jobs.active().length} jobs running` : `job list unavailable (${storeError})`),
        );
      }
      throw new Error(`unknown action "${params.action}" (use on, off or status)`);
    },
  } as never);

  const applySwitch = (enabled: boolean) => {
    const others = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
    pi.setActiveTools(enabled ? [...others, ...TOOL_NAMES] : others);
  };
  const stopPolling = () => {
    if (poller) clearInterval(poller);
    poller = undefined;
  };
  const startPolling = () => {
    stopPolling();
    announceFinished(); // jobs that ended while this conversation was closed
    poller = setInterval(announceFinished, POLL_MS);
    poller.unref(); // never keeps a finished Pi process alive
  };

  pi.on("before_agent_start", async (event) => {
    if (!isEnabled(STATE_PATH)) return undefined;
    const prompt = buildPrompt({
      profile: readIfExists(join(PACKAGE_ROOT, "profile", "PROFILE.md")),
      routing: readIfExists(join(PACKAGE_ROOT, "profile", "ROUTING.md")),
      learned: readIfExists(LEARNED_PATH),
    });
    // Deterministic backstop: confirmed 2026-11-13 that a model can read the probability rule in the profile and
    // still skip it on a real build question. This never trusts the model to remember; it checks what the user
    // actually typed this turn and, on a match, adds a reminder no model choice can omit.
    const guardrail = event.messageType === "user" && event.prompt ? detectGuardrail(event.prompt) : undefined;
    const work = openWorkBlock(openStore(), origin);
    const addition = [prompt.text, work, guardrail?.reminder].filter(Boolean).join("\n\n");
    return addition ? { systemPrompt: `${event.systemPrompt}\n\n${addition}` } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    origin = originOf(ctx.cwd);
    const enabled = isEnabled(STATE_PATH);
    applySwitch(enabled);
    if (!enabled) return;
    const jobs = openStore();
    if (!jobs) {
      if (ctx.hasUI) ctx.ui.notify(`the assistant companion: job list unavailable (${storeError}); profile only`, "warning");
      return;
    }
    startPolling();
    if (ctx.hasUI) ctx.ui.notify(`the assistant companion on (${jobs.active().length} jobs running)`, "info");
  });

  // Jobs are not stopped here: they run in their own processes and are reported when this conversation reopens.
  pi.on("session_shutdown", async () => {
    stopPolling();
  });

  pi.registerCommand("companion", {
    description: "the assistant companion: on, off or status",
    handler: async (args: string, ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } }) => {
      const action = args.trim().toLowerCase();
      if (action === "on" || action === "off") {
        setEnabled(STATE_PATH, action === "on");
        applySwitch(action === "on");
        if (action === "on") startPolling();
        else stopPolling();
        ctx.ui.notify(`the assistant companion ${action}`, "info");
        return;
      }
      const prompt = buildPrompt({
        profile: readIfExists(join(PACKAGE_ROOT, "profile", "PROFILE.md")),
        routing: readIfExists(join(PACKAGE_ROOT, "profile", "ROUTING.md")),
        learned: readIfExists(LEARNED_PATH),
      });
      const jobs = openStore();
      ctx.ui.notify(
        `the assistant companion ${isEnabled(STATE_PATH) ? "on" : "off"} · prompt ${prompt.text.length} chars${prompt.overBudget ? " (OVER BUDGET)" : ""} · ` +
          (jobs ? `${jobs.active().length} jobs running` : `job list unavailable (${storeError})`),
        prompt.overBudget ? "warning" : "info",
      );
    },
  });
}
