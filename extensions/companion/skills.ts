import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A lean worker starts without the skill catalog: Pi puts every installed skill's name and description in the prompt,
 * about 14,000 tokens here, and a worker with a brief does not need them. A job that needs a skill names it, and only
 * that skill's folder is loaded.
 */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Turns skill names into folder paths. Refuses anything that is not a plain name, or has no folder. */
export function resolveSkills(names: string[], skillsDir: string): string[] {
  return [...new Set(names)].map((name) => {
    if (!VALID_NAME.test(name)) throw new Error(`invalid skill name "${name}"`);
    const dir = join(skillsDir, name);
    if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`unknown skill "${name}" (no SKILL.md in ${skillsDir})`);
    return dir;
  });
}
