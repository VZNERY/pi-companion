import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorker, tail, workerCommand } from "../extensions/companion/workers.ts";

const sh = (script: string) => ({ command: "sh", args: ["-c", script], env: {} });

test("each worker gets its own command, and Pi workers have the companion switched off", () => {
  const pi = workerCommand("pi", "do it", "minimax/MiniMax-M3");
  assert.equal(pi.command, "pi");
  assert.deepEqual(pi.args.slice(0, 4), ["-p", "--no-session", "--model", "minimax/MiniMax-M3"]);
  assert.equal(pi.env.PI_COMPANION, "off");
  assert.match(pi.args.at(-1)!, /^do it[\s\S]*short report/);
  assert.equal(workerCommand("claude", "x").command, "claude");
  assert.deepEqual(workerCommand("codex", "x").args.slice(0, 1), ["exec"]);
});

test("an unknown worker is refused with the valid names", () => {
  assert.throws(() => workerCommand("gemini", "x"), /unknown worker "gemini".*pi, claude, codex/);
});

test("a worker that succeeds returns its output", async () => {
  const outcome = await runWorker(sh("echo all good"), process.cwd(), 5000).done;
  assert.deepEqual(outcome, { ok: true, output: "all good" });
});

test("a worker that exits non-zero is a failure with the reason and its last output", async () => {
  const outcome = await runWorker(sh("echo partial; echo boom >&2; exit 3"), process.cwd(), 5000).done;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.output, "partial");
  assert.match(outcome.error!, /exit code 3.*boom/);
});

test("a worker that exits cleanly with no output is a failure, not a silent success", async () => {
  const outcome = await runWorker(sh("exit 0"), process.cwd(), 5000).done;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /without any output/);
});

test("a program that does not exist is a failure, not a crash", async () => {
  const outcome = await runWorker({ command: "no-such-program-companion", args: [], env: {} }, process.cwd(), 5000).done;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /could not start no-such-program-companion/);
});

test("a worker that runs past the limit is stopped and reported as timed out", async () => {
  const handle = runWorker(sh("sleep 30"), process.cwd(), 300);
  const outcome = await handle.done;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /timed out/);
});

test("a cancelled worker is reported as stopped by a signal", async () => {
  const handle = runWorker(sh("sleep 30"), process.cwd(), 10_000);
  setTimeout(() => handle.kill(), 100);
  const outcome = await handle.done;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /SIGTERM/);
});

test("long output keeps only its end", () => {
  const long = "x".repeat(5000) + "FINAL REPORT";
  const kept = tail(long, 100);
  assert.ok(kept.endsWith("FINAL REPORT"));
  assert.ok(kept.startsWith("[earlier output omitted]"));
  assert.equal(tail("short"), "short");
});
