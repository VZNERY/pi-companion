/**
 * The companion's hard rules (probability check before a build decision, per-generation OK before spending
 * credits) live in PROFILE.md as prose. A model can read a standing instruction and still skip it on a real
 * question — confirmed 2026-11-13: two separate build/feasibility questions got a reasonable answer with no
 * `P = ... PROCEED/FIND ALTERNATIVE` line. Prose alone is not enough for a rule with real consequences
 * (unauthorized builds, spent credits), so this file detects the two situations by keyword and returns a short,
 * impossible-to-miss reminder injected only on a matching turn — the profile text is unchanged and still carries
 * the full rule; this is a deterministic backstop, not a replacement for it.
 */

export type GuardrailKind = "build" | "generation";
export interface Guardrail { kind: GuardrailKind; reminder: string }

const BUILD_PATTERN =
  /\b(should (we|i) build|can (we|you|i) build|will (we|it|that) work|is (it|this) (possible|doable|feasible)|worth building|should (we|i) (make|create|launch)|can (we|you) (make|create)|will (we|i|you) (be )?able to|can we (actually )?(do|pull off|manage) (it|this|that))\b/i;

const GENERATION_PATTERN =
  /\b(generate|make|create|render)\b[^.?!]{0,60}\b(image|images|photo|photos|video|videos|clip|clips|reel|picture|pictures|render|animation)\b/i;

const RESOLUTION_PATTERN = /\b(720p|1080p|4k|higher resolution|upscale|re-?roll|regenerate|try again with)\b/i;

const REMINDERS: Record<GuardrailKind, string> = {
  build:
    "This message asks whether to build, make or launch something. Before any other reply, state the probability line " +
    'exactly as the profile requires: "P = [past pattern] x [current evidence] = LOW/MEDIUM/HIGH, then PROCEED or ' +
    'FIND ALTERNATIVE". Do not skip it because the question sounds informal or you already have an answer in mind.',
  generation:
    "This message asks for an image, video or similar generation, or a resolution change. Before creating or " +
    "upgrading anything: state the exact model and the credit cost, then stop and wait for the user's explicit OK " +
    "for this one generation. Never pick a higher resolution or re-roll on your own.",
};

/** Looks only at what the user actually typed this turn; never fires on the companion's own or a worker's text. */
export function detectGuardrail(userText: string): Guardrail | undefined {
  const text = userText.toLowerCase();
  if (BUILD_PATTERN.test(text)) return { kind: "build", reminder: REMINDERS.build };
  if (GENERATION_PATTERN.test(text) || RESOLUTION_PATTERN.test(text)) return { kind: "generation", reminder: REMINDERS.generation };
  return undefined;
}
