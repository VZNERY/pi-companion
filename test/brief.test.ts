import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF_MAX_CHARS, buildBrief, recentConversation } from "../extensions/companion/brief.ts";

test("a brief has the goal, what to know, what done looks like, and no empty sections", () => {
  const text = buildBrief({ goal: "Make the camel image darker", context: "File is /tmp/camel.png", expectedOutput: "The new file path" });
  assert.match(text, /# Goal\nMake the camel image darker/);
  assert.match(text, /# What you need to know\nFile is/);
  assert.match(text, /# Finished means\nThe new file path/);
  assert.ok(!text.includes("# Already done"));
  assert.ok(!text.includes("# Recent conversation"));
});

test("without an expected output the brief still says what finished means", () => {
  assert.match(buildBrief({ goal: "x" }), /# Finished means\nA short report/);
});

test("a brief without a goal is refused", () => {
  assert.throws(() => buildBrief({ goal: "  " }), /needs a goal/);
});

test("a long conversation is trimmed from the old end and the whole brief stays under the cap", () => {
  const recent = Array.from({ length: 200 }, (_, i) => `User: message ${i} ${"x".repeat(80)}`).join("\n");
  const text = buildBrief({ goal: "g", context: "c", recent });
  assert.ok(text.length <= BRIEF_MAX_CHARS, `brief is ${text.length}`);
  assert.ok(text.includes("message 199"), "newest message kept");
  assert.match(text, /Do not act on it/);
  assert.ok(!text.includes("message 0 "), "oldest message dropped");
});

test("recentConversation takes user and assistant text, skips thinking, tools and empty messages, and keeps the last few", () => {
  const entries = [
    { type: "session" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "make an image of a camel" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Ready, 2.5 credits. Say go." }] } },
    { type: "message", message: { role: "toolResult", content: "ignore me" } },
    { type: "message", message: { role: "user", content: "go" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "delegate" }] } },
  ];
  const out = recentConversation(entries);
  assert.equal(out, "User: make an image of a camel\nAssistant: Ready, 2.5 credits. Say go.\nUser: go");
  assert.ok(!out.includes("secret") && !out.includes("ignore me"));
  assert.equal(recentConversation(entries, 1), "User: go");
  assert.equal(recentConversation([]), "");
});
