import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../extensions/companion/store.ts";

const newStore = () => new JobStore(":memory:");

test("a new job is queued and can be found by a unique prefix", () => {
  const store = newStore();
  const job = store.create({ task: "check sales", worker: "pi", cwd: "/tmp" });
  assert.equal(job.status, "queued");
  assert.equal(store.get(job.id.slice(0, 6))?.id, job.id);
  assert.equal(store.get("zz"), undefined);
});

test("an empty task is refused", () => {
  assert.throws(() => newStore().create({ task: "   ", worker: "pi", cwd: "/tmp" }), /needs a task/);
});

test("a cancelled job keeps its status when the worker exits later", () => {
  const store = newStore();
  const job = store.create({ task: "long work", worker: "pi", cwd: "/tmp" });
  store.markRunning(job.id, 4242);
  assert.equal(store.finish(job.id, "cancelled", { error: "cancelled by the user" }), true);
  assert.equal(store.finish(job.id, "done", { result: "late result" }), false);
  const after = store.get(job.id)!;
  assert.equal(after.status, "cancelled");
  assert.equal(after.result, null);
  assert.equal(after.pid, null);
});

test("after a restart, jobs whose process is gone are closed as interrupted and reported once", () => {
  const store = newStore();
  const dead = store.create({ task: "dead worker", worker: "pi", cwd: "/tmp" });
  const alive = store.create({ task: "live worker", worker: "pi", cwd: "/tmp" });
  const neverStarted = store.create({ task: "never started", worker: "pi", cwd: "/tmp" });
  store.markRunning(dead.id, 111);
  store.markRunning(alive.id, 222);

  const lost = store.reconcile((pid) => pid === 222, 0);
  assert.deepEqual(lost.map((j) => j.id).sort(), [dead.id, neverStarted.id].sort());
  assert.equal(store.get(alive.id)!.status, "running");
  assert.equal(store.get(dead.id)!.status, "interrupted");

  assert.equal(store.unannounced().length, 2);
  for (const job of store.unannounced()) assert.equal(store.claimAnnouncement(job.id), true);
  assert.equal(store.unannounced().length, 0);
  assert.equal(store.reconcile((pid) => pid === 222, 0).length, 0);
});

test("a failed job stores the reason and its last output", () => {
  const store = newStore();
  const job = store.create({ task: "will fail", worker: "claude", cwd: "/tmp" });
  store.markRunning(job.id, 5);
  store.finish(job.id, "failed", { result: "partial", error: "exit code 1" });
  const after = store.get(job.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.error, "exit code 1");
  assert.equal(after.result, "partial");
  assert.equal(store.active().length, 0);
});

test("the job list survives closing and reopening the file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-companion-")), "jobs.sqlite");
  const first = new JobStore(path);
  const job = first.create({ task: "persist me", worker: "pi", cwd: "/tmp" });
  first.close();
  const second = new JobStore(path);
  assert.equal(second.get(job.id)?.task, "persist me");
  second.close();
});

test("a freshly queued job is left alone, because its runner may still be starting", () => {
  let clock = 1_000_000;
  const store = new JobStore(":memory:", () => clock);
  const job = store.create({ task: "just queued", worker: "pi", cwd: "/tmp" });
  assert.equal(store.reconcile(() => false).length, 0);
  assert.equal(store.get(job.id)!.status, "queued");
  clock += 31_000;
  assert.equal(store.reconcile(() => false).length, 1);
  assert.equal(store.get(job.id)!.status, "interrupted");
});

test("a finished job is reported once, and only to the conversation that started it", () => {
  const store = newStore();
  const mine = store.create({ task: "mine", worker: "pi", cwd: "/tmp", origin: "thr_a" });
  const theirs = store.create({ task: "theirs", worker: "pi", cwd: "/tmp", origin: "thr_b" });
  store.finish(mine.id, "done", { result: "ok" });
  store.finish(theirs.id, "done", { result: "ok" });
  assert.deepEqual(store.unannounced("thr_a").map((j) => j.id), [mine.id]);
  assert.equal(store.claimAnnouncement(mine.id), true);
  assert.equal(store.claimAnnouncement(mine.id), false);
  assert.equal(store.unannounced("thr_a").length, 0);
  assert.equal(store.unannounced("thr_b").length, 1);
});

test("a cancelled job is never reported", () => {
  const store = newStore();
  const job = store.create({ task: "x", worker: "pi", cwd: "/tmp", origin: "thr_a" });
  store.finish(job.id, "cancelled");
  assert.equal(store.unannounced("thr_a").length, 0);
});

test("a job's bb child thread id is recorded and read back", () => {
  const store = newStore();
  const job = store.create({ task: "x", worker: "pi", cwd: "/tmp" });
  assert.equal(job.childThreadId, null);
  store.setChildThread(job.id, "thr_abc123");
  assert.equal(store.get(job.id)!.childThreadId, "thr_abc123");
});

test("an older job list with no child_thread_id column still opens and defaults to null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-companion-")), "jobs.sqlite");
  const first = new JobStore(path);
  first.create({ task: "old job", worker: "pi", cwd: "/tmp" });
  first.close();
  const second = new JobStore(path); // must add the missing column itself, not just the origin one
  assert.equal(second.list()[0]!.childThreadId, null);
  second.close();
});

test("recent work in one conversation: open jobs and jobs finished within the window, newest first", () => {
  let clock = 1_000_000;
  const store = new JobStore(":memory:", () => clock);
  const old = store.create({ task: "old", worker: "pi", cwd: "/tmp", origin: "thr_a" });
  store.finish(old.id, "done", { result: "x" });
  clock += 2 * 60 * 60_000; // two hours later: the first job is outside the window
  const open = store.create({ task: "image of a camel", worker: "pi", cwd: "/tmp", origin: "thr_a", childThreadId: "thr_child" });
  const other = store.create({ task: "other conversation", worker: "pi", cwd: "/tmp", origin: "thr_b" });
  const ids = store.recentFor("thr_a", 60 * 60_000).map((j) => j.id);
  assert.deepEqual(ids, [open.id]);
  assert.equal(store.get(open.id)!.childThreadId, "thr_child");
  assert.ok(!ids.includes(other.id));
});

test("job options are stored and read back, an old job list gets the column, and the active count is per conversation", () => {
  const store = newStore();
  const a = store.create({ task: "a", worker: "pi", cwd: "/tmp", origin: "thr_a", options: { mcp: ["images"], sessionKey: "k1" } });
  store.create({ task: "b", worker: "pi", cwd: "/tmp", origin: "thr_a" });
  store.create({ task: "c", worker: "pi", cwd: "/tmp", origin: "thr_b" });
  assert.deepEqual(store.get(a.id)!.options, { mcp: ["images"], sessionKey: "k1" });
  assert.deepEqual(store.create({ task: "d", worker: "pi", cwd: "/tmp" }).options, {});
  assert.equal(store.activeCount("thr_a"), 2);
  store.finish(a.id, "done", { result: "x" });
  assert.equal(store.activeCount("thr_a"), 1);
  assert.equal(store.activeCount("thr_none"), 0);
});
