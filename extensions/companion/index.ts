import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { refreshBadge } from "./badge.ts";
import { bbContext } from "./bb.ts";
import { buildBrief, recentConversation } from "./brief.ts";
import { detectGuardrail } from "./guardrails.ts";
import { chooseMode, newSessionKey, resumable } from "./route.ts";
import { isFinished, JobStore, processAlive, type Job } from "./store.ts";
import { loadTiers, pickWorker } from "./tiers.ts";
import { buildPrompt, isEnabled, learn, readIfExists, setEnabled } from "./prompt.ts";
import { killGroup, workerCommand, WORKERS } from "./workers.ts";

/**
 * pi-companion: turns a Pi session into the user's personal companion.
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
const TIERS_PATH = join(DATA_DIR, "workers.json");
const TOOL_NAMES = ["delegate", "jobs", "remember", "companion"];
const DEFAULT_JOB_MINUTES = 20;
const MAX_JOB_MINUTES = 120;
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
  let lastBadge = 0; // the count last written to the thread title
  let tick = 0;
  let verifyIn = 0; // ticks until the title is checked once more after a change
  // Title updates run one at a time, and read the count when they run, so two jobs started together cannot overwrite
  // each other with an older number.
  let badgeChain: Promise<unknown> = Promise.resolve();
  const syncBadge = () => {
    badgeChain = badgeChain.then(() => refreshBadge(origin, openStore()?.activeCount(origin) ?? 0)).catch(() => undefined);
  };

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
      // Keep the thread title's agent count right: on every change, and re-checked about once a minute while any run.
      const working = jobs.activeCount(origin);
      tick += 1;
      if (working !== lastBadge || (working > 0 && tick % 15 === 0)) {
        lastBadge = working;
        verifyIn = 2;
        syncBadge();
      } else if (verifyIn > 0 && --verifyIn === 0) {
        syncBadge(); // a second look after a change, in case another process wrote an older count meanwhile
      }
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
      "The worker sees none of this conversation except the brief you write: put the goal in task, what it must know in " +
      "context, and what finished looks like in expected_output. Workers start lean (about 2 seconds) and load only the " +
      "MCP servers you list in mcp. tier chooses the quality: fast for routine work, best for work needing careful reasoning.",
    promptSnippet: "Hand long or multi-step work to a background worker and keep talking",
    promptGuidelines: [
      "Use delegate for any work that needs more than a few tool calls or more than about a minute; answer quick questions and do small checks yourself.",
      "Write a real brief: goal in task, what the worker must know in context (paths, ids, decisions already made, approvals already given), and what finished looks like in expected_output.",
      "Set mcp to the MCP server names the job needs, for example [\"memory\"]; leave it out when the job needs none, because every server slows the worker's start.",
      "Set skills to the names of skills the job needs; workers start without the skill catalog, so a job that needs a skill must name it.",
      "Use tier \"best\" when the work needs careful multi-step reasoning or the user asks for top quality; the default fast tier is for routine work.",
      "Do not set include_conversation unless the task truly depends on what was just said and you cannot put it in context.",
      "Set watch true only when the user wants to open and watch the worker; otherwise jobs start fast, and the thread title shows how many agents are working.",
      "After calling delegate, tell the user in one short sentence that the work has started, then stop. Never wait or poll in a loop.",
      "Never say a delegated job is done until its report has arrived in the conversation.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The goal: what the worker must do, in one clear instruction" }),
      context: Type.Optional(Type.String({ description: "What the worker must know: file paths, ids, decisions already made, approvals already given" })),
      expected_output: Type.Optional(Type.String({ description: "What finished looks like, and what the final report must contain" })),
      tier: Type.Optional(Type.String({ description: "fast (default) or best. Chooses the worker and model from the user's workers.json." })),
      worker: Type.Optional(Type.String({ description: `Only to override the tier: one of ${WORKERS.join(", ")}.` })),
      model: Type.Optional(Type.String({ description: "Only to override the tier's model." })),
      mcp: Type.Optional(Type.Array(Type.String(), { description: "MCP server names this job needs. Only these are loaded. Leave out if none." })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Names of skills the job needs. A lean worker loads none otherwise. Leave out if none." })),
      web: Type.Optional(Type.Boolean({ description: "True if the job needs web search or page fetching." })),
      watch: Type.Optional(Type.Boolean({ description: "True to run it as a visible bb child thread the user can open. Slower to start." })),
      include_conversation: Type.Optional(Type.Boolean({ description: "True to give the worker the last few messages of this conversation. Rarely needed: put what it must know in context instead." })),
      max_minutes: Type.Optional(Type.Number({ description: "Time limit for the job in minutes (default 20, at most 120). The worker is stopped when it runs out." })),
      cwd: Type.Optional(Type.String({ description: "Folder the worker runs in. Default: this session's folder." })),
      continue_job: Type.Optional(Type.String({ description: "Id of a recent job in this conversation whose work this request continues. Its worker gets the request as a follow-up and keeps its context." })),
    }),
    async execute(
      _id: string,
      params: { task: string; context?: string; expected_output?: string; tier?: string; worker?: string; model?: string; mcp?: string[]; skills?: string[]; web?: boolean; watch?: boolean; include_conversation?: boolean; max_minutes?: number; cwd?: string; continue_job?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string; sessionManager?: { getBranch?: () => unknown[] } },
    ) {
      const jobs = openStore();
      if (!jobs) throw new Error(`the job list is unavailable (${storeError}); do the work directly or tell the user`);
      if (jobs.active().length >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} jobs are already running; wait for one to finish or cancel one with the jobs tool`);
      const previous = params.continue_job ? jobs.get(params.continue_job) : undefined;
      if (params.continue_job && (!previous || previous.origin !== origin)) {
        throw new Error(`no recent job "${params.continue_job}" in this conversation; start a new job without continue_job`);
      }
      const picked = pickWorker({ tier: params.tier, worker: params.worker, model: params.model }, loadTiers(TIERS_PATH), previous);
      workerCommand(picked.worker, params.task, picked.model); // throws on an unknown worker before a job is created
      const mode = chooseMode({ inBb: bbContext() !== undefined, watch: params.watch, worker: picked.worker, previous });
      const resumed = resumable(previous, mode);

      // A follow-up goes to a worker that already has the context; a new worker gets a full brief.
      let task: string;
      if (resumed) {
        task = params.expected_output ? `${params.task}\n\nFinished means: ${params.expected_output}` : params.task;
      } else {
        let recent = "";
        try {
          // Off by default: a weaker worker can mistake the conversation for its instructions and wander off.
          if (params.include_conversation) recent = recentConversation(ctx.sessionManager?.getBranch?.() ?? []);
        } catch {
          // No conversation excerpt is better than a failed delegate.
        }
        task = buildBrief({ goal: params.task, context: params.context, expectedOutput: params.expected_output, recent, alreadyDone: previous?.result ?? undefined });
      }

      const job = jobs.create({
        task,
        worker: picked.worker,
        model: picked.model,
        cwd: params.cwd ?? resumed?.cwd ?? ctx.cwd,
        origin,
        childThreadId: mode === "thread" ? resumed?.childThreadId ?? null : null,
        options: {
          mcp: params.mcp?.length ? params.mcp : resumed?.options.mcp,
          skills: params.skills?.length ? params.skills : resumed?.options.skills,
          web: params.web ?? resumed?.options.web,
          sessionKey: mode === "local" ? resumed?.options.sessionKey ?? newSessionKey() : undefined,
        },
      });
      const script = mode === "thread" ? BB_RUNNER : RUNNER;
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        const log = openSync(join(DATA_DIR, "runner.log"), "a");
        // Detached and unref'd: the runner outlives this session and writes the outcome into the job list itself.
        const minutes = Math.min(MAX_JOB_MINUTES, Math.max(1, params.max_minutes ?? DEFAULT_JOB_MINUTES));
        const runner = spawn(process.execPath, [script, JOBS_PATH, job.id, String(Math.round(minutes * 60_000))], {
          cwd: job.cwd,
          detached: true,
          stdio: ["ignore", log, log],
          env: { ...process.env, PI_COMPANION: "off", PI_COMPANION_DATA_DIR: DATA_DIR },
        });
        runner.on("error", (error) => { jobs.finish(job.id, "failed", { error: `could not start the job runner: ${error.message}` }); });
        runner.unref();
      } catch (error) {
        jobs.finish(job.id, "failed", { error: `could not start the job runner: ${error instanceof Error ? error.message : String(error)}` });
        throw error;
      }
      const working = jobs.activeCount(origin);
      lastBadge = working;
      verifyIn = 2;
      syncBadge();
      return text(
        `Started job ${job.id} on ${resumed ? `the same worker (continuing job ${resumed.id})` : `${picked.worker}${picked.model ? `/${picked.model}` : ""}`}` +
          `${mode === "thread" ? " as a bb child thread you can open" : " (fast, lean start)"}. ${working} agent${working === 1 ? "" : "s"} working now. ` +
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
        const working = jobs.activeCount(origin);
        const header = `${working} agent${working === 1 ? "" : "s"} working now.`;
        return text(all.length ? `${header}\n${all.map(jobLine).join("\n")}` : "No background jobs yet.");
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
        const working = jobs.activeCount(origin);
        lastBadge = working;
        verifyIn = 2;
        syncBadge();
        return text(`Cancelled job ${job.id}${job.childThreadId ? ` and stopped @thread:${job.childThreadId}` : ""}. ${working} agent${working === 1 ? "" : "s"} working now.`);
      }
      throw new Error(`unknown action "${params.action}" (use list, status or cancel)`);
    },
  } as never);

  pi.registerTool({
    name: "remember",
    label: "Remember a preference",
    description:
      "Save one lasting preference or correction from the user so it applies in every future session. One short line, " +
      "written as a rule. Not for facts about projects or one-off task details (those belong in your memory service).",
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
      if (ctx.hasUI) ctx.ui.notify(`Companion: job list unavailable (${storeError}); profile only`, "warning");
      return;
    }
    startPolling();
    syncBadge(); // clears a stale count left by a session that ended
    if (ctx.hasUI) ctx.ui.notify(`Companion on (${jobs.active().length} jobs running)`, "info");
  });

  // Jobs are not stopped here: they run in their own processes and are reported when this conversation reopens.
  pi.on("session_shutdown", async () => {
    stopPolling();
  });

  pi.registerCommand("companion", {
    description: "Companion: on, off or status",
    handler: async (args: string, ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } }) => {
      const action = args.trim().toLowerCase();
      if (action === "on" || action === "off") {
        setEnabled(STATE_PATH, action === "on");
        applySwitch(action === "on");
        if (action === "on") startPolling();
        else stopPolling();
        ctx.ui.notify(`Companion ${action}`, "info");
        return;
      }
      const prompt = buildPrompt({
        profile: readIfExists(join(PACKAGE_ROOT, "profile", "PROFILE.md")),
        routing: readIfExists(join(PACKAGE_ROOT, "profile", "ROUTING.md")),
        learned: readIfExists(LEARNED_PATH),
      });
      const jobs = openStore();
      ctx.ui.notify(
        `Companion ${isEnabled(STATE_PATH) ? "on" : "off"} · prompt ${prompt.text.length} chars${prompt.overBudget ? " (OVER BUDGET)" : ""} · ` +
          (jobs ? `${jobs.active().length} jobs running` : `job list unavailable (${storeError})`),
        prompt.overBudget ? "warning" : "info",
      );
    },
  });
}
