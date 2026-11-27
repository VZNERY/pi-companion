import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIERS, loadTiers, pickWorker } from "../extensions/companion/tiers.ts";

test("with no file the defaults apply: fast is Pi, best is Claude", () => {
  const tiers = loadTiers("/no/such/workers.json");
  assert.deepEqual(tiers, DEFAULT_TIERS);
  assert.equal(pickWorker({}, tiers).worker, "pi");
  assert.equal(pickWorker({ tier: "best" }, tiers).worker, "claude");
});

test("the user's file overrides a tier and can add new ones; a broken file falls back to the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "tiers-"));
  const file = join(dir, "workers.json");
  writeFileSync(file, JSON.stringify({ fast: { worker: "pi", model: "provider/model-a" }, design: { worker: "claude", model: "opus" } }));
  const tiers = loadTiers(file);
  assert.deepEqual(pickWorker({}, tiers), { worker: "pi", model: "provider/model-a" });
  assert.deepEqual(pickWorker({ tier: "design" }, tiers), { worker: "claude", model: "opus" });
  writeFileSync(file, "not json");
  assert.deepEqual(loadTiers(file), DEFAULT_TIERS);
});

test("an explicit worker or model beats the tier, and a follow-up keeps its worker", () => {
  const tiers = loadTiers("/no/such");
  assert.deepEqual(pickWorker({ worker: "codex" }, tiers), { worker: "codex", model: null });
  assert.deepEqual(pickWorker({ model: "m1" }, tiers), { worker: "pi", model: "m1" });
  assert.deepEqual(pickWorker({ tier: "best" }, tiers, { worker: "pi", model: "m2" }), { worker: "pi", model: "m2" });
});

test("an unknown tier is refused with the valid names", () => {
  assert.throws(() => pickWorker({ tier: "ultra" }, loadTiers("/no/such")), /unknown tier "ultra" \(use one of: fast, best\)/);
});
