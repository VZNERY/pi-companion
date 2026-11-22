import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore, processAlive } from "../extensions/companion/store.ts";

const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "companion", "runner.ts");
const newDb = () => join(mkdtempSync(join(tmpdir(), "pi-companion-")), "jobs.sqlite");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startRunner(db: string, id: string, timeoutMs = 20_000) {
  const child = spawn(process.execPath, [runnerPath, db, id, String(timeoutMs)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_COMPANION_ALLOW_SHELL_WORKER: "1" },
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited };
}

async function waitFor(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error("condition not reached in time");
}

test("the runner finishes a job on its own and writes the result to the job list", async () => {
  const db = newDb();
  const store = new JobStore(db);
  const job = store.create({ task: "echo worker says hi", worker: "shell", cwd: tmpdir(), origin: "t" });
  await startRunner(db, job.id).exited;
  const after = store.get(job.id)!;
  assert.equal(after.status, "done");
  assert.equal(after.result, "worker says hi");
  assert.equal(after.pid, null);
  store.close();
});

test("the runner records a failing worker as failed with the reason", async () => {
  const db = newDb();
  const store = new JobStore(db);
  const job = store.create({ task: "echo half; exit 7", worker: "shell", cwd: tmpdir() });
  await startRunner(db, job.id).exited;
  const after = store.get(job.id)!;
  assert.equal(after.status, "failed");
  assert.match(after.error!, /exit code 7/);
  assert.equal(after.result, "half");
  store.close();
});

test("the runner records an unknown worker as failed instead of leaving the job queued", async () => {
  const db = newDb();
  const store = new JobStore(db);
  const job = store.create({ task: "x", worker: "no-such-worker", cwd: tmpdir() });
  await startRunner(db, job.id).exited;
  assert.equal(store.get(job.id)!.status, "failed");
  assert.match(store.get(job.id)!.error!, /unknown worker/);
  store.close();
});

test("cancelling stops the runner and the worker's own child processes, and the job stays cancelled", async () => {
  const db = newDb();
  const store = new JobStore(db);
  const job = store.create({ task: "sleep 60 & echo $! ; wait", worker: "shell", cwd: tmpdir() });
  const { exited } = startRunner(db, job.id);
  await waitFor(() => store.get(job.id)!.status === "running");
  const runnerPid = store.get(job.id)!.pid!;
  assert.ok(processAlive(runnerPid));

  store.finish(job.id, "cancelled", { error: "cancelled by the user" });
  process.kill(-runnerPid, "SIGTERM");
  await exited;
  await sleep(300);
  assert.equal(processAlive(runnerPid), false);
  assert.equal(store.get(job.id)!.status, "cancelled");
  assert.equal(store.get(job.id)!.error, "cancelled by the user");
  store.close();
});

test("a job cancelled before its runner starts is not run", async () => {
  const db = newDb();
  const store = new JobStore(db);
  const job = store.create({ task: "echo should not run", worker: "shell", cwd: tmpdir() });
  store.finish(job.id, "cancelled");
  await startRunner(db, job.id).exited;
  assert.equal(store.get(job.id)!.status, "cancelled");
  assert.equal(store.get(job.id)!.result, null);
  store.close();
});
