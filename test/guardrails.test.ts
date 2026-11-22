import { test } from "node:test";
import assert from "node:assert/strict";
import { detectGuardrail } from "../extensions/companion/guardrails.ts";

test("a build or feasibility question is caught, matching the two real misses from 2026-11-13", () => {
  for (const msg of [
    "Should we build a full admin dashboard for tracking every follower across platforms?",
    "can we create a cortex saas ?",
    "will we able to do it",
    "Should I build a landing page for this?",
    "Is it feasible to launch a second brand this month?",
    "Can you make a whole automation pipeline for leads?",
  ]) {
    const hit = detectGuardrail(msg);
    assert.equal(hit?.kind, "build", `expected a build guardrail for: ${msg}`);
    assert.match(hit!.reminder, /PROCEED or FIND ALTERNATIVE/);
  }
});

test("a generation or resolution request is caught", () => {
  for (const msg of [
    "Make me a video of a camel walking through a mall for the next reel.",
    "Generate an image of a person standing in a city street at night.",
    "Can you render a reel for the new drop?",
    "Upscale that to 1080p",
    "Try again with 4k",
  ]) {
    const hit = detectGuardrail(msg);
    assert.equal(hit?.kind, "generation", `expected a generation guardrail for: ${msg}`);
    assert.match(hit!.reminder, /explicit OK/);
  }
});

test("an ordinary message triggers nothing", () => {
  for (const msg of ["how is the job going?", "what's my schedule tomorrow", "thanks, that works", "read the file at /tmp/a.txt"]) {
    assert.equal(detectGuardrail(msg), undefined, `did not expect a guardrail for: ${msg}`);
  }
});

test("detection is case-insensitive and does not need the user to say the trigger word first", () => {
  assert.equal(detectGuardrail("CAN WE BUILD THIS")?.kind, "build");
  assert.equal(detectGuardrail("so, generate a picture of the stage please")?.kind, "generation");
});
