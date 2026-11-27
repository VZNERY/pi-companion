import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseMode, newSessionKey, resumable } from "../extensions/companion/route.ts";
import type { Job } from "../extensions/companion/store.ts";

const job = (over: Partial<Job>): Job => ({
  id: "j1", task: "t", worker: "pi", model: null, cwd: "/", origin: "thr_a", status: "done", pid: null, result: null, error: null,
  createdAt: 0, startedAt: null, finishedAt: null, announced: true, childThreadId: null, options: {}, ...over,
});

test("outside bb everything runs as a local lean process", () => {
  assert.equal(chooseMode({ inBb: false, worker: "claude", watch: true }), "local");
});

test("inside bb: Pi runs local by default, a watched or Claude/Codex job runs as a bb thread", () => {
  assert.equal(chooseMode({ inBb: true, worker: "pi" }), "local");
  assert.equal(chooseMode({ inBb: true, worker: "pi", watch: true }), "thread");
  assert.equal(chooseMode({ inBb: true, worker: "claude" }), "thread");
  assert.equal(chooseMode({ inBb: true, worker: "codex" }), "thread");
});

test("a follow-up to a worker that lives in a thread stays in that thread", () => {
  assert.equal(chooseMode({ inBb: true, worker: "pi", previous: job({ childThreadId: "thr_c" }) }), "thread");
  assert.equal(chooseMode({ inBb: true, worker: "pi", previous: job({ options: { sessionKey: "k" } }) }), "local");
});

test("a job can be resumed only when the mode has what it needs: a thread, or a session", () => {
  const thread = job({ childThreadId: "thr_c" });
  const local = job({ options: { sessionKey: "k" } });
  assert.equal(resumable(thread, "thread"), thread);
  assert.equal(resumable(local, "local"), local);
  assert.equal(resumable(local, "thread"), undefined);
  assert.equal(resumable(thread, "local"), undefined);
  assert.equal(resumable(undefined, "local"), undefined);
});

test("session keys are unique", () => {
  assert.notEqual(newSessionKey(), newSessionKey());
});
