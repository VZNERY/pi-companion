import { execFileSync } from "node:child_process";
import { bbContext, parseSpawnOutput, parseThreadOutput, parseWaitOutput, spawnArgs } from "./bb.ts";
import { JobStore } from "./store.ts";

/**
 * Runs one job as a real bb child thread, so it shows up in bb's sidebar as its own thread with its own task,
 * provider and status — not a hidden process. Usage: node bb-runner.ts <jobs.sqlite> <job id> <timeout ms>
 * A detached process, like runner.ts: it outlives the Pi session that called delegate, and writes the outcome
 * into the job list itself. Reads BB_PROJECT_ID / BB_ENVIRONMENT_ID / BB_THREAD_ID from its own environment,
 * inherited from the session that spawned it.
 *
 * Cancelling does not signal this process: the jobs tool in index.ts stops the bb thread directly and writes
 * "cancelled" to the job list at once. This process's later finish() calls then simply no-op (store.finish only
 * updates a job that is still queued/running), so a late result can never overwrite a cancel.
 */
const [dbPath, jobId, timeoutArg] = process.argv.slice(2);
if (!dbPath || !jobId) {
  console.error("usage: bb-runner.ts <jobs.sqlite> <job id> [timeout ms]");
  process.exit(2);
}
const timeoutMs = Number(timeoutArg) || 45 * 60_000;

const store = new JobStore(dbPath);
const job = store.get(jobId);
if (!job || job.status !== "queued") {
  store.close();
  process.exit(0);
}

const ctx = bbContext();
if (!ctx) {
  store.finish(job.id, "failed", { error: "bb-runner started with no BB_PROJECT_ID/BB_ENVIRONMENT_ID/BB_THREAD_ID" });
  store.close();
  process.exit(1);
}

try {
  store.markRunning(job.id, process.pid);
  const spawnOut = execFileSync("bb", spawnArgs(ctx, job.worker, job.task, job.model), { encoding: "utf8", timeout: 30_000 });
  const spawned = parseSpawnOutput(spawnOut);
  if (!spawned.ok) {
    store.finish(job.id, "failed", { error: `could not spawn a bb child thread: ${spawned.error}` });
  } else {
    store.setChildThread(job.id, spawned.id);
    const waitOut = execFileSync(
      "bb",
      ["thread", "wait", spawned.id, "--status", "idle", "--timeout", `${Math.round(timeoutMs / 1000)}s`, "--json"],
      { encoding: "utf8", timeout: timeoutMs + 15_000 },
    );
    const waited = parseWaitOutput(waitOut);
    const outputOut = execFileSync("bb", ["thread", "output", spawned.id, "--json"], { encoding: "utf8", timeout: 15_000 });
    const output = parseThreadOutput(outputOut);
    const result = "output" in output ? output.output : undefined;
    if ("ok" in waited) store.finish(job.id, "failed", { result, error: `bb thread wait failed: ${waited.error}` });
    else if (!waited.matched) store.finish(job.id, "failed", { result, error: "the bb thread did not finish in time" });
    else if ("ok" in output) store.finish(job.id, "failed", { error: `the bb thread finished, but its output could not be read: ${output.error}` });
    else store.finish(job.id, "done", { result: output.output });
  }
} catch (error) {
  // execFileSync throws on a non-zero exit, a missing bb binary, a killed subprocess, or its own timeout: always
  // close the job (finish is a no-op if the jobs tool already cancelled it), never leave it running forever.
  store.finish(job.id, "failed", { error: error instanceof Error ? error.message : String(error) });
} finally {
  store.close();
}
