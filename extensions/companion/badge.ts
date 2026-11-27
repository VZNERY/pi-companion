import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Shows how many background agents are working, in the one place bb always displays: the thread title.
 * "[2 agents working] My thread". It is set and removed by code, never by the model, so it is always accurate.
 */
const run = promisify(execFile);
export const MARKER = /^\[\d+ agents? working\] /;

export const stripMarker = (title: string): string => title.replace(MARKER, "");
export const withMarker = (title: string, count: number): string => {
  const base = stripMarker(title);
  return count > 0 ? `[${count} agent${count === 1 ? "" : "s"} working] ${base}` : base;
};
export const isBbThread = (origin: string): boolean => /^thr_[a-z0-9]+$/i.test(origin);

export type Exec = (file: string, args: string[]) => Promise<string>;
const realExec: Exec = async (file, args) => (await run(file, args, { timeout: 15_000, encoding: "utf8" })).stdout;

/**
 * Brings a bb thread's title in line with the count. Reads the current title first, so a title the user renamed keeps
 * its new name. Never throws: a failed title update must not break a job.
 */
export async function refreshBadge(threadId: string, count: number, exec: Exec = realExec): Promise<boolean> {
  if (!isBbThread(threadId)) return false;
  try {
    const shown = JSON.parse(await exec("bb", ["thread", "show", threadId, "--json"])) as { thread?: { title?: string }; title?: string };
    const current = shown.thread?.title ?? shown.title ?? "";
    if (!current) return false;
    const wanted = withMarker(current, count);
    if (wanted === current) return false;
    await exec("bb", ["thread", "update", threadId, "--title", wanted]);
    return true;
  } catch (error) {
    console.error(`companion: could not update the agent count on ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
