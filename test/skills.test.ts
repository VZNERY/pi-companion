import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkills } from "../extensions/companion/skills.ts";

function skillsDir(...names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  for (const name of names) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "SKILL.md"), "---\nname: x\n---\n");
  }
  return dir;
}

test("skill names become folder paths, once each", () => {
  const dir = skillsDir("research", "council");
  assert.deepEqual(resolveSkills(["research", "research", "council"], dir), [join(dir, "research"), join(dir, "council")]);
});

test("an unknown skill and a name that tries to leave the folder are both refused", () => {
  const dir = skillsDir("research");
  assert.throws(() => resolveSkills(["nope"], dir), /unknown skill "nope"/);
  assert.throws(() => resolveSkills(["../etc"], dir), /invalid skill name/);
  assert.throws(() => resolveSkills(["a/b"], dir), /invalid skill name/);
  assert.throws(() => resolveSkills([".hidden"], dir), /invalid skill name/);
});
