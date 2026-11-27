import { REPORT_RULE } from "./workers.ts";

/**
 * When the companion runs inside a bb thread, delegate hands a job to a real bb child thread instead of a hidden
 * background process, so the user can see it in bb's sidebar: a visible child thread with its own task, provider and
 * status, under the companion thread that spawned it. Outside bb (plain Pi, or bb's own env vars missing) delegate
 * falls back to the local-process worker in workers.ts/runner.ts, unchanged.
 */
export interface BbContext { projectId: string; environmentId: string; parentThreadId: string }

/** bb sets these on every thread's agent process; their absence means we are not running inside bb. */
export function bbContext(env: NodeJS.ProcessEnv = process.env): BbContext | undefined {
  const projectId = env.BB_PROJECT_ID;
  const environmentId = env.BB_ENVIRONMENT_ID;
  const parentThreadId = env.BB_THREAD_ID;
  return projectId && environmentId && parentThreadId ? { projectId, environmentId, parentThreadId } : undefined;
}

/** Maps a companion worker name to the bb provider id that runs it. */
export function bbProviderFor(worker: string): string {
  switch (worker) {
    case "pi":
      return "pi";
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      throw new Error(`no bb provider for worker "${worker}"`);
  }
}

const titleOf = (task: string, max = 60) => {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
};

/** Argv for `bb thread spawn`. The child is lifecycle-owned by the parent, so it never outlives the companion thread. */
export function spawnArgs(ctx: BbContext, worker: string, task: string, model?: string | null): string[] {
  const args = [
    "thread",
    "spawn",
    "--project",
    ctx.projectId,
    "--environment",
    ctx.environmentId,
    "--parent-thread",
    ctx.parentThreadId,
    "--lifecycle-owner-thread",
    ctx.parentThreadId,
    "--provider",
    bbProviderFor(worker),
    "--title",
    `Companion: ${titleOf(task)}`,
    "--json",
    "--prompt",
    task + REPORT_RULE,
  ];
  if (model) args.push("--model", model);
  return args;
}

export type SpawnResult = { ok: true; id: string } | { ok: false; error: string };

/** Parses `bb thread spawn --json` stdout. Never throws: a malformed or error response becomes a readable failure. */
export function parseSpawnOutput(stdout: string): SpawnResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `bb did not return JSON: ${stdout.slice(0, 200)}` };
  }
  const obj = data as { ok?: boolean; error?: { message?: string }; id?: string };
  if (obj.ok === false) return { ok: false, error: obj.error?.message ?? "bb thread spawn failed" };
  if (typeof obj.id === "string" && obj.id) return { ok: true, id: obj.id };
  return { ok: false, error: `bb thread spawn returned no thread id: ${stdout.slice(0, 200)}` };
}

export interface WaitResult { matched: boolean }

/** Parses `bb thread wait --json` stdout, the same tolerant way. */
export function parseWaitOutput(stdout: string): WaitResult | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `bb did not return JSON: ${stdout.slice(0, 200)}` };
  }
  const obj = data as { ok?: boolean; error?: { message?: string }; matched?: boolean };
  if (obj.ok === false) return { ok: false, error: obj.error?.message ?? "bb thread wait failed" };
  return { matched: obj.matched === true };
}

/** Parses `bb thread output --json` stdout. */
export function parseThreadOutput(stdout: string): { output: string } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `bb did not return JSON: ${stdout.slice(0, 200)}` };
  }
  const obj = data as { ok?: boolean; error?: { message?: string }; output?: string };
  if (obj.ok === false) return { ok: false, error: obj.error?.message ?? "bb thread output failed" };
  return { output: typeof obj.output === "string" ? obj.output : "" };
}
