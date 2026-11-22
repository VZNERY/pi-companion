import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The companion's prompt is built from three small files. A size budget keeps it from growing without anyone noticing. */
export const PROMPT_BUDGET_CHARS = 9000; // about 2,200 tokens

export interface PromptParts { profile: string; routing: string; learned: string }

export function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function buildPrompt(parts: PromptParts, budget = PROMPT_BUDGET_CHARS): { text: string; overBudget: boolean } {
  const sections = [
    parts.profile && `<companion_profile>\n${parts.profile}\n</companion_profile>`,
    parts.routing && `<companion_skill_routing>\n${parts.routing}\n</companion_skill_routing>`,
    parts.learned && `<companion_learned_preferences>\n${parts.learned}\n</companion_learned_preferences>`,
  ].filter(Boolean) as string[];
  const text = sections.join("\n\n");
  return { text, overBudget: text.length > budget };
}

/** On/off switch, kept on disk so it survives restarts. The environment variable wins, so workers can force it off. */
export function isEnabled(statePath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_COMPANION === "off") return false;
  if (env.PI_COMPANION === "on") return true;
  try {
    return (JSON.parse(readFileSync(statePath, "utf8")) as { enabled?: boolean }).enabled !== false;
  } catch {
    return true; // installed and never switched off
  }
}

export function setEnabled(statePath: string, enabled: boolean): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ enabled, changedAt: new Date().toISOString() }));
}

const MAX_LEARNED_LINES = 60;

/** Saves one thing the user taught the companion. Returns false when the same line is already saved. */
export function learn(learnedPath: string, rule: string, today = new Date().toISOString().slice(0, 10)): boolean {
  const clean = rule.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("nothing to remember");
  const existing = existsSync(learnedPath) ? readFileSync(learnedPath, "utf8") : "";
  const lines = existing.split("\n").filter((line) => line.startsWith("- "));
  if (lines.some((line) => line.replace(/^- \(\d{4}-\d{2}-\d{2}\) /, "").toLowerCase() === clean.toLowerCase())) return false;
  mkdirSync(dirname(learnedPath), { recursive: true });
  if (lines.length >= MAX_LEARNED_LINES) {
    throw new Error(`the learned list is full (${MAX_LEARNED_LINES} lines); ask the user which old lines to merge or drop`);
  }
  appendFileSync(learnedPath, `- (${today}) ${clean}\n`);
  return true;
}
