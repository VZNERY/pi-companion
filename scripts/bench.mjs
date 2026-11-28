#!/usr/bin/env node
// Measures how long each kind of worker takes to answer a trivial task, and checks that a lean worker can resume its
// own session for a follow-up. Uses a throwaway data folder and a few tiny model calls. Run it after changing workers.
// Usage: [PI_BENCH_MCP=<server name>] node scripts/bench.mjs [model]   (default model: whatever Pi uses by default)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "../extensions/companion/store.ts";
import { newSessionKey } from "../extensions/companion/route.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "companion");
const dataDir = mkdtempSync(join(tmpdir(), "companion-bench-"));
const store = new JobStore(join(dataDir, "jobs.sqlite"));
const model = process.argv[2] ?? null;
const only = process.argv[3]; // optional: run only the rows whose name contains this text
const inBb = Boolean(process.env.BB_PROJECT_ID && process.env.BB_ENVIRONMENT_ID && process.env.BB_THREAD_ID);

async function run(label, task, options, script = "runner.ts", childThreadId = null) {
  const resumeRow = label === "first message" || label.startsWith("follow-up");
  if (only === "resume" ? !resumeRow : only && !label.includes(only)) return { status: "skipped" };
  const job = store.create({ task, worker: "pi", model, cwd: tmpdir(), origin: "bench", options, childThreadId });
  const started = Date.now();
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, script), join(dataDir, "jobs.sqlite"), job.id, "180000"], {
      env: { ...process.env, PI_COMPANION: "off", PI_COMPANION_DATA_DIR: dataDir },
      stdio: "ignore",
    });
    child.on("exit", resolve);
  });
  const done = store.get(job.id);
  done.seconds = (Date.now() - started) / 1000;
  return done;
}

// One run is not a measurement: model latency varies a lot from run to run (a single run of the same worker has
// taken 14s and 41s). Each row runs several times; the median is the number to trust.
const RUNS = Math.max(1, Number(process.env.PI_BENCH_RUNS ?? 3));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function row(label, task, options, script = "runner.ts", runs = RUNS) {
  const resumeRow = label === "first message" || label.startsWith("follow-up");
  if (only === "resume" ? !resumeRow : only && !label.includes(only)) return;
  const results = [];
  for (let i = 0; i < runs; i += 1) results.push(await run(label, task, options, script));
  const failed = results.filter((r) => r.status !== "done").length;
  console.log(`${label.padEnd(34)} median ${median(results.map((r) => r.seconds)).toFixed(1).padStart(5)}s  runs ${results.map((r) => r.seconds.toFixed(1)).join(", ")}${failed ? `  (${failed} FAILED)` : ""}`);
}

async function runOnce(label, task, options) {
  if (only && only !== "resume" && !label.includes(only)) return { status: "skipped" };
  const done = await run(label, task, options);
  console.log(`${label.padEnd(34)} ${done.seconds.toFixed(1).padStart(11)}s  ${done.status} ${(done.result ?? done.error ?? "").replace(/\s+/g, " ").slice(0, 50)}`);
  return done;
}

const TASK = "Reply with the single word: pong";
console.log(`Each row: ${RUNS} runs, median shown (set PI_BENCH_RUNS to change)`);
await row("lean (default)", TASK, {});
const mcpServer = process.env.PI_BENCH_MCP; // name of one MCP server from your mcp.json, to time a lean worker that uses it
if (mcpServer) await row(`lean + MCP server (${mcpServer})`, TASK, { mcp: [mcpServer] });
await row("full (everything loaded)", TASK, { full: true });
if (inBb) await row("bb thread (watchable)", TASK, {}, "bb-runner.ts", Math.min(RUNS, 2));
else console.log("bb thread (watchable)".padEnd(30), "skipped: not running inside bb");

if (only && only !== "resume") { store.close(); process.exit(0); }
console.log("\nresume test: a follow-up to the same lean worker");
const key = newSessionKey();
await runOnce("first message", "Remember this number: 7421. Reply with just: ok", { sessionKey: key });
const second = await runOnce("follow-up, same session", "What number did I ask you to remember? Reply with just the number.", { sessionKey: key });
const resumed = (second.result ?? "").includes("7421");
console.log(resumed ? "RESUME PASSED: the worker remembered the number" : "RESUME FAILED: the worker did not remember");
store.close();
process.exit(resumed ? 0 : 1);
