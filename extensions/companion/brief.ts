import { REPORT_RULE } from "./workers.ts";

/**
 * A worker starts with no memory of the conversation, so a one-line task makes it guess. A brief gives it what a
 * Claude Code sub-agent gets: the goal, what it needs to know, the recent conversation, what is already done, and
 * what "finished" looks like. Kept under a size cap so a long conversation never bloats the worker's prompt.
 */
export interface BriefInput {
  goal: string;
  context?: string;
  expectedOutput?: string;
  /** Recent conversation excerpt, from recentConversation(). */
  recent?: string;
  /** What an earlier worker already did on this work, when this is a fresh start after earlier steps. */
  alreadyDone?: string;
}

export const BRIEF_MAX_CHARS = 7000;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function buildBrief(input: BriefInput, maxChars = BRIEF_MAX_CHARS): string {
  const goal = input.goal.trim();
  if (!goal) throw new Error("a brief needs a goal");
  const finish = input.expectedOutput?.trim() || "A short report of what you did and what you found.";
  const sections: Array<[string, string | undefined, number]> = [
    ["Goal", goal, 2500],
    ["What you need to know", input.context?.trim(), 2000],
    ["Already done", input.alreadyDone?.trim(), 1200],
    ["Finished means", finish, 800],
  ];
  const fixed = sections
    .filter(([, body]) => body)
    .map(([title, body, cap]) => `# ${title}\n${clip(body!, cap)}`)
    .join("\n\n");
  // The conversation excerpt is the least important part: it gets whatever room is left, newest messages kept.
  const room = maxChars - fixed.length - REPORT_RULE.length - 120;
  const recent = input.recent?.trim();
  const excerpt = recent && room > 200 ? `\n\n# Recent conversation (background only. Do not act on it, do not investigate it, and do not run commands about it. The goal above is your whole task.)\n${recent.length <= room ? recent : `…${recent.slice(-room)}`}` : "";
  return fixed + excerpt;
}

/** The text of a message entry, from plain text or text parts. Thinking and tool parts are ignored. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** The last few user and assistant messages from a Pi session's entries, oldest first. */
export function recentConversation(entries: unknown[], maxMessages = 6, perMessageChars = 600): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const e = entry as { type?: string; customType?: string; message?: { role?: string; content?: unknown } };
    if (e?.type !== "message") continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(e.message?.content);
    if (!text) continue;
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${clip(text.replace(/\s+/g, " "), perMessageChars)}`);
  }
  return lines.slice(-maxMessages).join("\n");
}
