import { readFileSync } from "node:fs";

/**
 * Which worker and model run a job. "fast" is the everyday worker; "best" is for work where reliability matters more
 * than cost. The mapping is a small file you own (<data dir>/workers.json), so the choice never needs a code change.
 */
export interface TierChoice { worker: string; model: string | null }
export type Tiers = Record<string, TierChoice>;

export const DEFAULT_TIERS: Tiers = {
  fast: { worker: "pi", model: null },
  best: { worker: "claude", model: null },
};

export function loadTiers(path: string): Tiers {
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, Partial<TierChoice>>;
    const merged: Tiers = { ...DEFAULT_TIERS };
    for (const [name, choice] of Object.entries(file)) {
      if (choice && typeof choice.worker === "string") merged[name] = { worker: choice.worker, model: typeof choice.model === "string" ? choice.model : null };
    }
    return merged;
  } catch {
    return DEFAULT_TIERS; // no file, or a broken one: the defaults still work
  }
}

export interface PickInput { tier?: string; worker?: string; model?: string }
export interface Previous { worker: string; model: string | null }

/** An explicit worker or model wins; a follow-up keeps its worker; otherwise the tier decides. */
export function pickWorker(input: PickInput, tiers: Tiers, previous?: Previous): TierChoice {
  if (previous) return { worker: previous.worker, model: previous.model };
  const tier = tiers[input.tier ?? "fast"];
  if (input.tier && !tier) throw new Error(`unknown tier "${input.tier}" (use one of: ${Object.keys(tiers).join(", ")})`);
  if (input.worker) return { worker: input.worker, model: input.model ?? null };
  return { worker: tier!.worker, model: input.model ?? tier!.model };
}
