import type { Job } from "./store.ts";

/**
 * How a job runs. "local" is a lean process: fast to start, and its session is kept so a follow-up can resume it.
 * "thread" is a bb child thread: slower to start, but visible and openable in bb's sidebar, and it is also how Claude
 * and Codex run, because bb holds their logins (the plain CLIs are not signed in on a server).
 */
export type Mode = "local" | "thread";

export function chooseMode(input: { inBb: boolean; watch?: boolean; worker: string; previous?: Job }): Mode {
  if (!input.inBb) return "local";
  if (input.watch) return "thread";
  if (input.worker !== "pi") return "thread";
  if (input.previous?.childThreadId) return "thread";
  return "local";
}

/** The earlier job a follow-up can really resume: a thread job needs its thread, a local job needs its session. */
export function resumable(previous: Job | undefined, mode: Mode): Job | undefined {
  if (!previous) return undefined;
  if (mode === "thread") return previous.childThreadId ? previous : undefined;
  return previous.options.sessionKey ? previous : undefined;
}

export const newSessionKey = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
