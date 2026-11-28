import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorker, tail, workerCommand } from "../extensions/companion/workers.ts";

const sh = (script: string) => ({ command: "sh", args: ["-c", script], env: {} });

test("each worker gets its own command, and Pi workers have the companion switched off", () => {
  const pi = workerCommand("pi", "do it", "provider/model-a");
  assert.equal(pi.command, "pi");
  assert.deepEqual(pi.args.slice(0, 7), ["-p", "--no-session", "-ne", "-ns", "-nc", "--model", "provider/model-a"]);
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

test("a lean Pi worker loads no extensions and no MCP unless asked, and a full worker loads everything", () => {
  const lean = workerCommand("pi", "x");
  assert.ok(lean.args.includes("-ne") && lean.args.includes("-ns") && lean.args.includes("-nc"));
  assert.ok(!lean.args.includes("builtin:mcp"));
  assert.equal(lean.env.PI_CODING_AGENT_DIR, undefined);
  const full = workerCommand("pi", "x", null, { full: true });
  assert.ok(!full.args.includes("-ne") && !full.args.includes("-ns") && !full.args.includes("-nc"));
});

test("a lean worker loads only the skills a job names, and every worker is told the safety rules", () => {
  const cmd = workerCommand("pi", "x", null, { skills: ["/s/research", "/s/council"] });
  assert.deepEqual(cmd.args.filter((a, i) => cmd.args[i - 1] === "--skill"), ["/s/research", "/s/council"]);
  assert.ok(!workerCommand("pi", "x").args.includes("--skill"));
  for (const worker of ["pi", "claude", "codex"]) assert.match(workerCommand(worker, "x").args.at(-1)!, /Do not send emails or messages, publish or post anything, push code, deploy/);
});

test("a worker that needs MCP servers gets the MCP extension and may use only those servers' tools", () => {
  const cmd = workerCommand("pi", "x", null, { mcp: ["images", "memory", "memory"] });
  assert.deepEqual(cmd.args.slice(cmd.args.indexOf("-e"), cmd.args.indexOf("-e") + 2), ["-e", "builtin:mcp"]);
  const tools = cmd.args[cmd.args.indexOf("--tools") + 1]!;
  assert.match(tools, /^read,bash,edit,write,grep,find,ls,codemode,mcp__images__\*,mcp__memory__\*$/);
  assert.ok(!tools.includes("video"));
  assert.ok(!workerCommand("pi", "x").args.includes("--tools"));
});

test("a worker with a session key resumes the same session; without one it keeps nothing", () => {
  const first = workerCommand("pi", "x", null, { sessionKey: "k1", sessionDir: "/tmp/s" });
  assert.deepEqual(first.args.slice(1, 5), ["--session-dir", "/tmp/s", "--session-id", "k1"]);
  assert.ok(!first.args.includes("--no-session"));
  assert.ok(workerCommand("pi", "x").args.includes("--no-session"));
});

test("web access is loaded only when its path is given", () => {
  assert.ok(workerCommand("pi", "x", null, { webExtension: "/p/web" }).args.includes("/p/web"));
  assert.ok(!workerCommand("pi", "x").args.includes("/p/web"));
});
