#!/usr/bin/env node
// End-to-end check against the real Pi: keeps one session open over RPC, delegates a real job, and waits for the
// worker's report to come back into the same conversation. Run it after every Pi upgrade (npm run e2e).
// It spends a few model calls. Exit code 0 = pass, 1 = fail.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.PI_E2E_MODEL ?? null;
const work = mkdtempSync(join(tmpdir(), "pi-companion-e2e-"));
const target = join(work, "hello.txt");
const DEADLINE_MS = 240_000;

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-e", join(root, "extensions", "companion", "index.ts"), ...(model ? ["--model", model] : [])], {
  cwd: work,
  // A private data folder, so the test never touches the real job list or learned rules.
  env: { ...process.env, PI_COMPANION: "on", PI_COMPANION_DATA_DIR: join(work, "data") },
  stdio: ["pipe", "pipe", "inherit"],
});

const seen = { delegateCalled: false, jobReport: false, replyAfterReport: "", settledAfterReport: false };
let buffer = "";
let finished = false;

function finish(ok, why) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const fileOk = existsSync(target) && readFileSync(target, "utf8").trim() === "hi";
  const checks = {
    "the model called delegate": seen.delegateCalled,
    "the worker's report arrived in the conversation": seen.jobReport,
    "the companion answered after the report": seen.replyAfterReport.length > 0,
    "the worker really created the file": fileOk,
  };
  const pass = ok && Object.values(checks).every(Boolean);
  for (const [name, value] of Object.entries(checks)) console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (seen.replyAfterReport) console.log(`\nCompanion said: ${seen.replyAfterReport.slice(0, 400)}`);
  console.log(`\n${pass ? "E2E PASSED" : `E2E FAILED (${why})`}`);
  pi.stdin.end();
  setTimeout(() => { pi.kill("SIGTERM"); process.exit(pass ? 0 : 1); }, 3000).unref();
  pi.on("exit", () => process.exit(pass ? 0 : 1));
}

const deadline = setTimeout(() => finish(false, "deadline reached"), DEADLINE_MS);

const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

pi.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "response" && event.success === false) finish(false, `command failed: ${event.error}`);
    if (event.type === "tool_execution_start" && event.toolName === "delegate") seen.delegateCalled = true;
    if (event.type === "message_end") {
      const message = event.message ?? {};
      if (message.customType === "companion-job" || (message.role === "custom" && /Background job/.test(textOf(message)))) seen.jobReport = true;
      else if (seen.jobReport && message.role === "assistant") seen.replyAfterReport = textOf(message) || seen.replyAfterReport;
    }
    if (event.type === "agent_settled" && seen.jobReport && seen.replyAfterReport) finish(true, "");
  }
});
pi.on("error", (error) => finish(false, `could not start pi: ${error.message}`));
pi.on("exit", (code) => finish(false, `pi exited early with code ${code}`));

pi.stdin.write(
  JSON.stringify({
    id: "p1",
    type: "prompt",
    message: `I say go. Call delegate with worker pi${model ? `, model ${model}` : ""}, and this task: "Create the file ${target} containing exactly the word: hi". Then tell me in one sentence that it started.`,
  }) + "\n",
);
