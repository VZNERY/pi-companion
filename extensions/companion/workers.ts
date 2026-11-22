import { spawn } from "node:child_process";

/** How each background worker is started. A worker is a separate program with its own context window. */
export interface WorkerCommand { command: string; args: string[]; env: Record<string, string> }

export const WORKERS = ["pi", "claude", "codex"] as const;
export type WorkerName = (typeof WORKERS)[number];

/** Workers are told to end with a short report, because only that report enters the companion's conversation. */
export const REPORT_RULE =
  "\n\nWhen you finish, end with a short report (under 150 words): what you did, what you found, and anything that " +
  "needs the user's decision. If you could not finish, say exactly what is missing. Never claim something was done " +
  "that you did not do.";

export function workerCommand(worker: string, task: string, model?: string | null): WorkerCommand {
  const prompt = task + REPORT_RULE;
  // PI_COMPANION=off stops a Pi worker from loading the companion again and delegating in a loop.
  const env = { PI_COMPANION: "off" };
  switch (worker) {
    case "pi":
      return { command: "pi", args: ["-p", "--no-session", ...(model ? ["--model", model] : []), prompt], env };
    case "claude":
      return { command: "claude", args: ["-p", ...(model ? ["--model", model] : []), "--permission-mode", "acceptEdits", prompt], env };
    case "codex":
      return { command: "codex", args: ["exec", ...(model ? ["--model", model] : []), prompt], env };
    case "shell":
      // Test-only worker (runs the task as a shell script). Refused unless the test sets this variable.
      if (process.env.PI_COMPANION_ALLOW_SHELL_WORKER === "1") return { command: "sh", args: ["-c", task], env };
      throw new Error(`unknown worker "shell" (use one of: ${WORKERS.join(", ")})`);
    default:
      throw new Error(`unknown worker "${worker}" (use one of: ${WORKERS.join(", ")})`);
  }
}

export interface WorkerOutcome { ok: boolean; output: string; error?: string }

const TAIL_CHARS = 4000;
/** Keeps the end of a worker's output: the final report is at the end, and a long log must not fill the chat. */
export function tail(text: string, max = TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `[earlier output omitted]\n${trimmed.slice(-max)}`;
}

export interface RunningWorker { pid: number | undefined; done: Promise<WorkerOutcome>; kill: () => void }

/**
 * Starts a worker and resolves when it ends. It never rejects: a missing program, a crash, a non-zero exit and a
 * timeout all come back as ok=false with the reason, so the job is always closed with an honest status.
 */
export function runWorker(cmd: WorkerCommand, cwd: string, timeoutMs: number, spawnFn: typeof spawn = spawn): RunningWorker {
  // detached = the worker leads its own process group, so stopping it also stops the programs it started.
  const child = spawnFn(cmd.command, cmd.args, { cwd, env: { ...process.env, ...cmd.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const stop = () => { if (child.pid === undefined || !killGroup(child.pid)) child.kill("SIGTERM"); };
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-TAIL_CHARS * 4); });
  child.stderr?.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-TAIL_CHARS); });

  const done = new Promise<WorkerOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      stop();
      settle({ ok: false, output: tail(out), error: `timed out after ${Math.round(timeoutMs / 60000)} minutes` });
    }, timeoutMs);
    child.on("error", (error) => settle({ ok: false, output: tail(out), error: `could not start ${cmd.command}: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (code === 0) {
        if (out.trim()) settle({ ok: true, output: tail(out) });
        else settle({ ok: false, output: "", error: `${cmd.command} exited without any output${err.trim() ? `: ${tail(err, 600)}` : ""}` });
      } else {
        const why = signal ? `stopped by signal ${signal}` : `exit code ${code}`;
        settle({ ok: false, output: tail(out), error: `${cmd.command} failed (${why})${err.trim() ? `: ${tail(err, 600)}` : ""}` });
      }
    });
  });

  return { pid: child.pid, done, kill: stop };
}

/** Stops a worker and everything it started. Returns false when the group no longer exists. */
export function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
