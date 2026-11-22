import { JobStore } from "./store.ts";
import { runWorker, workerCommand } from "./workers.ts";

/**
 * Runs one job as its own detached process, so the job keeps going when the Pi session that started it closes.
 * Usage: node runner.ts <jobs.sqlite> <job id> <timeout ms>
 * It writes the outcome into the job list itself; whichever session is watching that conversation reports it.
 */
const [dbPath, jobId, timeoutArg] = process.argv.slice(2);
if (!dbPath || !jobId) {
  console.error("usage: runner.ts <jobs.sqlite> <job id> [timeout ms]");
  process.exit(2);
}

const store = new JobStore(dbPath);
const job = store.get(jobId);
if (!job || job.status !== "queued") {
  // Cancelled before it started, or already picked up: nothing to do.
  store.close();
  process.exit(0);
}

let stopping = false;
try {
  const handle = runWorker(workerCommand(job.worker, job.task, job.model), job.cwd, Number(timeoutArg) || 45 * 60_000);
  // The runner's own pid is stored: it is the process a cancel signals, and the one a restart checks for.
  store.markRunning(job.id, process.pid);
  const stop = () => {
    stopping = true;
    handle.kill();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const outcome = await handle.done;
  if (stopping) store.finish(job.id, "cancelled", { error: "stopped before it finished" }); // no-op when already cancelled
  else if (outcome.ok) store.finish(job.id, "done", { result: outcome.output });
  else store.finish(job.id, "failed", { result: outcome.output || undefined, error: outcome.error });
} catch (error) {
  store.finish(job.id, "failed", { error: error instanceof Error ? error.message : String(error) });
} finally {
  store.close();
}
