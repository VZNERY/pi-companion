import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, isEnabled, learn, PROMPT_BUDGET_CHARS, readIfExists, setEnabled } from "../extensions/companion/prompt.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = () => mkdtempSync(join(tmpdir(), "pi-companion-"));

test("the shipped profile and routing fit the prompt budget with room for learned rules", () => {
  const prompt = buildPrompt({
    profile: readIfExists(join(root, "profile", "PROFILE.md")),
    routing: readIfExists(join(root, "profile", "ROUTING.md")),
    learned: "",
  });
  assert.ok(prompt.text.includes("<companion_profile>"));
  assert.ok(prompt.text.includes("<companion_skill_routing>"));
  assert.equal(prompt.overBudget, false);
  assert.ok(prompt.text.length < PROMPT_BUDGET_CHARS - 1500, `prompt is ${prompt.text.length} chars`);
});

test("missing files produce no empty sections, and an oversized prompt is flagged", () => {
  assert.equal(buildPrompt({ profile: "", routing: "", learned: "" }).text, "");
  assert.equal(buildPrompt({ profile: "p", routing: "", learned: "" }).text, "<companion_profile>\np\n</companion_profile>");
  assert.equal(buildPrompt({ profile: "x".repeat(100), routing: "", learned: "" }, 50).overBudget, true);
  assert.equal(readIfExists("/no/such/file.md"), "");
});

test("the switch defaults to on, remembers off, and the environment overrides the file", () => {
  const state = join(dir(), "nested", "state.json");
  assert.equal(isEnabled(state, {}), true);
  setEnabled(state, false);
  assert.equal(isEnabled(state, {}), false);
  assert.equal(isEnabled(state, { PI_COMPANION: "on" }), true);
  setEnabled(state, true);
  assert.equal(isEnabled(state, { PI_COMPANION: "off" }), false);
  writeFileSync(state, "not json");
  assert.equal(isEnabled(state, {}), true);
});

test("a learned rule is saved once, with its date", () => {
  const file = join(dir(), "learned.md");
  assert.equal(learn(file, "  Always show   the credit cost first ", "2026-11-12"), true);
  assert.equal(learn(file, "always show the credit cost first", "2026-11-13"), false);
  assert.equal(readFileSync(file, "utf8"), "- (2026-11-12) Always show the credit cost first\n");
  assert.throws(() => learn(file, "   "), /nothing to remember/);
});

test("the learned list stops at its limit instead of growing the prompt forever", () => {
  const file = join(dir(), "learned.md");
  for (let i = 0; i < 60; i += 1) learn(file, `rule number ${i}`);
  assert.throws(() => learn(file, "one too many"), /learned list is full/);
});
