import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshBadge } from "./badge.ts";
import { assertServers } from "./mcp.ts";
import { JobStore } from "./store.ts";
import { runWorker, workerCommand, type WorkerOptions } from "./workers.ts";

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

// Where Pi keeps its settings and where this package keeps its own files, so the worker can reuse the real logins.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dataDir = process.env.PI_COMPANION_DATA_DIR ?? join(agentDir, "pi-companion");

let stopping = false;
try {
  const opts: WorkerOptions = { full: job.options.full };
  if (job.options.mcp?.length) {
    assertServers(job.options.mcp, agentDir); // an unknown server fails the job at once, with the configured names
    opts.mcp = job.options.mcp;
  }
  const web = join(agentDir, "npm", "node_modules", "pi-web-access");
  if (job.options.web && existsSync(web)) opts.webExtension = web;
  if (job.options.sessionKey) Object.assign(opts, { sessionKey: job.options.sessionKey, sessionDir: join(dataDir, "sessions") });
  const handle = runWorker(workerCommand(job.worker, job.task, job.model, opts), job.cwd, Number(timeoutArg) || 45 * 60_000);
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
  await refreshBadge(job.origin, store.activeCount(job.origin)); // the thread title drops this agent from its count
  // Another job may finish at the same moment and write an older count; a second look after a pause corrects it.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await refreshBadge(job.origin, store.activeCount(job.origin));
  store.close();
}
