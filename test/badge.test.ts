import { test } from "node:test";
import assert from "node:assert/strict";
import { isBbThread, refreshBadge, stripMarker, withMarker, type Exec } from "../extensions/companion/badge.ts";

test("the marker is added with the right plural, replaced when the count changes, and removed at zero", () => {
  assert.equal(withMarker("My thread", 1), "[1 agent working] My thread");
  assert.equal(withMarker("[1 agent working] My thread", 3), "[3 agents working] My thread");
  assert.equal(withMarker("[3 agents working] My thread", 0), "My thread");
  assert.equal(stripMarker("My [work] thread"), "My [work] thread");
});

test("only bb thread ids are touched", () => {
  assert.ok(isBbThread("thr_abc123"));
  assert.ok(!isBbThread("cwd:/home/me"));
});

function fakeBb(title: string) {
  const calls: string[][] = [];
  let current = title;
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args[1] === "show") return JSON.stringify({ thread: { title: current } });
    current = args[args.indexOf("--title") + 1]!;
    return "{}";
  };
  return { exec, calls, title: () => current };
}

test("refreshBadge sets the count, keeps a title the user renamed, and does nothing when it is already right", async () => {
  const bb = fakeBb("Renamed by me");
  assert.equal(await refreshBadge("thr_a", 2, bb.exec), true);
  assert.equal(bb.title(), "[2 agents working] Renamed by me");
  assert.equal(await refreshBadge("thr_a", 2, bb.exec), false);
  assert.equal(await refreshBadge("thr_a", 0, bb.exec), true);
  assert.equal(bb.title(), "Renamed by me");
});

test("refreshBadge never throws, and ignores a non-bb origin without calling bb", async () => {
  const failing: Exec = async () => { throw new Error("bb is down"); };
  assert.equal(await refreshBadge("thr_a", 1, failing), false);
  const bb = fakeBb("t");
  assert.equal(await refreshBadge("cwd:/tmp", 1, bb.exec), false);
  assert.equal(bb.calls.length, 0);
});
