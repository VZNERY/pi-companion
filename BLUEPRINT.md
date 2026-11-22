# Blueprint: pi-companion

## Goal

One personal companion the user talks to, built on Pi without forking it: minimal prompt, knows his rules and preferences, picks the right skill, hands long work to background workers, and reports back in the same conversation.

## Design

```
You ──► Pi session (the companion)
          │  system prompt += PROFILE.md + ROUTING.md + learned.md   (before_agent_start)
          │
          ├─ delegate ──► background worker (pi / claude / codex), own context, own process group
          │                    │ writes nothing into the conversation while it runs
          │                    ▼
          │               jobs.sqlite  ◄── every state change is written at once
          │                    │
          │◄── short report ───┘  (pi.sendMessage, followUp, triggers a reply)
          ├─ jobs      list / status / cancel
          └─ remember  append one rule to learned.md
```

Files:

| File | Role |
|---|---|
| `extensions/companion/index.ts` | Pi wiring: tools, prompt injection, `/companion` command, session start and shutdown |
| `extensions/companion/store.ts` | Job list on SQLite (`node:sqlite`, no dependencies) |
| `extensions/companion/runner.ts` | Runs one job as a detached process and writes its outcome to the job list |
| `extensions/companion/workers.ts` | How each worker is started, stopped and its outcome judged |
| `extensions/companion/prompt.ts` | Prompt assembly with a size budget, the on/off switch, learned rules |
| `profile/PROFILE.md`, `profile/ROUTING.md` | The companion's rules, distilled from the Claude Code setup |
| `extensions/companion/bb.ts` | Builds the `bb thread spawn` call and parses `bb`'s JSON output; pure, unit-tested without a real bb process |
| `extensions/companion/bb-runner.ts` | Detached process: spawns the bb child thread, waits for it, records its result — the bb-thread analogue of `runner.ts` |
| `extensions/companion/guardrails.ts` | Deterministic backstop: catches a build/feasibility or generation message by keyword and re-injects the matching rule, because a model can read a standing rule in the prompt and still skip it |
| `scripts/e2e.mjs` | End-to-end test against the real Pi over RPC |

## Delegated work as bb child threads (0.4.0)

the user wanted to see what each background worker is doing, not just its final report. Inside bb, `delegate` now spawns a real `bb thread spawn` child, parented and lifecycle-owned by the companion thread. It shows up immediately in bb's sidebar with its own task-derived title and provider, can be opened and watched like any other thread, and is stopped with `bb thread stop` on cancel — no polling loop or log-scraping needed, since `bb thread wait --status idle` and `bb thread output --json` give a clean, structured way to block for completion and read the result. Outside bb (plain Pi, or bb's own environment variables missing), delegate is unchanged: a local detached process.

## Audit finding, 2026-11-13: a prose rule is not a guarantee

the user reported the companion skipped the probability line. Reproduced in a live bb thread on two separate build/feasibility questions: a reasonable answer came back with no `P = ... PROCEED/FIND ALTERNATIVE` line, even though the exact text of the rule was confirmed present, word-for-word, in that session's system prompt (the model quoted it back on request). The rule was readable and simply not applied.

**Lesson applied:** a standing instruction in a profile is advice to the model, not an enforced constraint. For the two rules in `PROFILE.md` with real consequences — an unauthorized build, a spent credit — `guardrails.ts` now detects the triggering situation from the user's own words and re-injects the rule as a fresh, this-turn instruction. This held even in a test where the user explicitly asked for no special format. The same pattern (detect-and-reinject, not trust-the-prompt) is the right default for any future rule where skipping it has a real cost, not just a style miss.

**Not fixed by this, and not meant to be:** a guardrail only fires on text matching its patterns. A rule with no detectable trigger phrase — most of the profile's softer style and tone rules — still depends on the model reading the prompt, same as before. This is a backstop for the few rules that need one, not a general proof that every rule in the profile is followed.

## Decisions

- **Extension, not a fork.** the assistant Core was a fork and every upstream change had to be merged by hand. Here Pi stays stock; an upgrade is a version bump followed by `npm test` and `npm run e2e`.
- **No runtime dependencies.** SQLite comes from Node, the tool schema library from Pi.
- **Only the report enters the conversation.** A worker's tool output never does. This is what lets one session carry many jobs.
- **Workers cannot delegate.** They run with `PI_COMPANION=off`, so a worker never loads the companion and starts a loop.
- **Honest job status.** A worker that is missing, crashes, exits non-zero, prints nothing or times out is closed as failed with the reason. A cancel is never overwritten by a late exit. A finished job is announced exactly once.
- **Prompt budget.** The assembled prompt is capped at 9,000 characters and a unit test fails if the shipped profile leaves less than 1,500 characters for learned rules.
- **Fails open.** If the job list cannot be opened, Pi still starts with the profile and says the job list is unavailable.

## Limits in 0.2.0

- **No service yet.** Jobs survive a closed session, but nothing keeps a session open or wakes it. A report is posted when the conversation is next opened, or at once if it is still open.
- **No heartbeat and no schedules.**
- **No self-check tools.** The self-check is a prompt rule only.
- **At most 4 jobs at once, 45 minutes each.**
- **`claude` and `codex` workers are untested.** Only the `pi` worker has been run end to end.
- **Outside bb, reports are keyed by folder.** A one-shot `pi -p` run that exits before its job ends leaves the report for the next session started in the same folder.
- **Cortex is not wired here.** Recall comes from the separate `pi-cortex-brain` package; the profile only tells the model to use it.
- **Unexplained:** during testing, one prompt that told plain Pi (without this extension) to "use the delegate tool with worker pi" stalled in print mode. It was not reproduced with the extension loaded, and the cause was not found.

## Roadmap

1. **0.3 Always-on:** a launcher and systemd service that keep one companion session alive, plus a heartbeat that checks stuck jobs and due work and stays silent when there is nothing.
2. **0.4 Self-check:** verify-before-done and a scratchpad that survives compaction; a nightly review that turns corrections into learned rules.
3. **0.5 Voice:** qwen-audio-agent in front of the same session.

## Failure paths covered by tests

Empty task, unknown worker (in the tool and in the runner), a job cancelled before its runner starts, a report claimed by two sessions, a report for another conversation, a freshly queued job during a restart check, program not found, non-zero exit, clean exit with no output, timeout, cancel (including the worker's own child processes), cancel followed by a late exit, restart with dead and live workers, job list reopened from disk, corrupt switch file, duplicate learned rule, full learned list, oversized prompt.
