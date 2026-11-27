import { test } from "node:test";
import assert from "node:assert/strict";
import { bbContext, bbProviderFor, parseSpawnOutput, parseThreadOutput, parseWaitOutput, spawnArgs } from "../extensions/companion/bb.ts";

const CTX = { projectId: "proj_1", environmentId: "env_1", parentThreadId: "thr_1" };

test("bbContext needs all three bb environment variables, not just one or two", () => {
  assert.equal(bbContext({}), undefined);
  assert.equal(bbContext({ BB_PROJECT_ID: "p" }), undefined);
  assert.equal(bbContext({ BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e" }), undefined);
  assert.deepEqual(bbContext({ BB_PROJECT_ID: "p", BB_ENVIRONMENT_ID: "e", BB_THREAD_ID: "t" }), {
    projectId: "p",
    environmentId: "e",
    parentThreadId: "t",
  });
});

test("each worker maps to the bb provider that actually runs it", () => {
  assert.equal(bbProviderFor("pi"), "pi");
  assert.equal(bbProviderFor("claude"), "claude-code");
  assert.equal(bbProviderFor("codex"), "codex");
  assert.throws(() => bbProviderFor("gemini"), /no bb provider/);
});

test("spawnArgs sets the parent and the lifecycle owner to the companion thread, and ends with --prompt", () => {
  const args = spawnArgs(CTX, "pi", "do the thing", "provider/model-a");
  assert.deepEqual(args.slice(0, 2), ["thread", "spawn"]);
  assert.ok(args.includes("--parent-thread") && args[args.indexOf("--parent-thread") + 1] === "thr_1");
  assert.ok(args.includes("--lifecycle-owner-thread") && args[args.indexOf("--lifecycle-owner-thread") + 1] === "thr_1");
  assert.equal(args[args.indexOf("--provider") + 1], "pi");
  assert.equal(args[args.indexOf("--model") + 1], "provider/model-a");
  assert.match(args[args.indexOf("--prompt") + 1]!, /^do the thing[\s\S]*short report/);
});

test("spawnArgs leaves out --model when none is given, and shortens a long task into the title", () => {
  const args = spawnArgs(CTX, "claude", "x".repeat(200));
  assert.ok(!args.includes("--model"));
  const title = args[args.indexOf("--title") + 1]!;
  assert.ok(title.length < 80, `title was ${title.length} chars`);
  assert.ok(title.startsWith("the assistant: "));
});

test("parseSpawnOutput reads the thread id, and reports a clear error instead of throwing", () => {
  assert.deepEqual(parseSpawnOutput('{"id":"thr_abc"}'), { ok: true, id: "thr_abc" });
  assert.deepEqual(parseSpawnOutput('{"ok":false,"error":{"message":"no capacity"}}'), { ok: false, error: "no capacity" });
  assert.match(parseSpawnOutput("not json").error, /did not return JSON/);
  assert.match(parseSpawnOutput("{}").error, /no thread id/);
});

test("parseWaitOutput reports whether the thread reached the status in time", () => {
  assert.deepEqual(parseWaitOutput('{"threadId":"thr_abc","matched":true,"target":"idle"}'), { matched: true });
  assert.deepEqual(parseWaitOutput('{"matched":false}'), { matched: false });
  assert.deepEqual(parseWaitOutput('{"ok":false,"error":{"message":"timed out"}}'), { ok: false, error: "timed out" });
});

test("parseThreadOutput reads the final text", () => {
  assert.deepEqual(parseThreadOutput('{"output":"all done"}'), { output: "all done" });
  assert.deepEqual(parseThreadOutput('{"ok":false,"error":{"message":"no such thread"}}'), { ok: false, error: "no such thread" });
  assert.deepEqual(parseThreadOutput("{}"), { output: "" });
});
