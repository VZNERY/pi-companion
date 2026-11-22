#!/usr/bin/env node
// Builds your personal profile from existing notes (for example a CLAUDE.md file and memory notes) and saves it in
// your local data folder, outside this package. Nothing is sent anywhere; the result is only written to disk.
// Usage: node scripts/import-profile.mjs <file-or-folder> [more files or folders...]
// Then review the file it prints, and trim it: the companion sends the profile with every message, so keep it short.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUDGET_CHARS = 9000; // the companion's prompt budget, kept in sync with extensions/companion/prompt.ts
const dataDir = process.env.PI_COMPANION_DATA_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-companion");
const out = join(dataDir, "profile", "PROFILE.md");

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: node scripts/import-profile.mjs <file-or-folder> [more...]");
  process.exit(2);
}

function collect(path) {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  if (statSync(path).isDirectory()) {
    return readdirSync(path).sort().filter((name) => name.endsWith(".md")).flatMap((name) => collect(join(path, name)));
  }
  return [path];
}

const files = inputs.flatMap(collect);
const sections = files.map((file) => `<!-- source: ${file} -->\n${readFileSync(file, "utf8").trim()}`);
const body = sections.join("\n\n");
mkdirSync(join(dataDir, "profile"), { recursive: true });
writeFileSync(out, body + "\n");

console.log(`Wrote ${files.length} file(s) to ${out}`);
console.log(`Size: ${body.length} characters (budget ${BUDGET_CHARS}).`);
if (body.length > BUDGET_CHARS) {
  console.log("Over budget: open the file, keep the rules that matter, and cut the rest before using it.");
}
