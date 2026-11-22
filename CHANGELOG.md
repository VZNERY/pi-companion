# Changelog

## 0.4.1 (2026-11-22)

No code changes. Verified against Pi 1.6.0 after the user upgraded Pi: 41 unit tests and the live end-to-end delegate test (bb child thread path) both pass. Audited 1.6.0's changelog first — its one breaking change affects extension UI rendering (`render()`, `Container`), which this package never uses; its grep-confirmed API surface (`registerTool`, `registerCommand`, `on`, `sendMessage`, `setActiveTools`, `getActiveTools`) is untouched by the release.

## 0.4.0 (2026-11-13)

the user asked to see delegated work as real bb child threads, not hidden processes.

- **Delegate spawns a real bb child thread when run inside bb.** `bb.ts` builds the `bb thread spawn` call (parented and lifecycle-owned by the companion thread, so it never outlives it); `bb-runner.ts` is the detached process that spawns it, waits for it with `bb thread wait --status idle`, and reads its result with `bb thread output`. Outside bb, delegate is unchanged: a local background process via `workers.ts`/`runner.ts`.
- Jobs and reports now carry the child thread's id and show it as a clickable `@thread:<id>` link.
- Cancelling a bb-thread job calls `bb thread stop` on the real thread, in addition to stopping the wrapper process.
- Verified live end to end in a real bb thread: a delegated job appeared as a visible child thread titled "the assistant: ...", did real work, finished, and its report in the parent thread correctly linked the child. A second test confirmed cancel stops the child thread (`bb thread stop` moves it back to idle) and the file it would have written was never created.

41 unit tests (32 prior + 9 new) and the live e2e test pass.

## 0.3.0 (2026-11-13)

Audit after the user reported the companion skipped the probability rule in a real bb conversation. Confirmed and fixed two gaps, found and left one open:

- **Fixed — rule skipped on a real question.** Reproduced: two separate build/feasibility questions in a live bb thread got a reasonable answer with no `P = ... PROCEED/FIND ALTERNATIVE` line, even though the exact rule was present word-for-word in the system prompt. Added `guardrails.ts`: a deterministic, keyword-based check in `before_agent_start` that re-injects the probability rule on a build/feasibility message, and the per-generation-OK rule on a generation or resolution message. This is a backstop on top of the prose rule, not a replacement for it. Verified end to end: the exact question that failed before now produces the rule, and the reminder held even when the user's own message asked for no special format.
- **Fixed — `/companion` unreachable through bb.** The slash command itself works correctly (confirmed over Pi's raw RPC protocol: `disposition: "handled"`, no model call). But bb does not forward typed slash text to Pi's command dispatcher the way typing in the Pi TUI does; in a bb thread, "/companion status" was sent to the model as plain text, and the model ran `bb companion status` as a shell command instead, which is not a real command. Added a `companion` tool (on/off/status) that works identically to the slash command and is reachable through bb's normal tool-calling path. Confirmed in a live bb thread.
- **Open, not caused by this package.** Some natural-language questions to the companion (worded to prompt a Cortex recall or a live web check) hung for several minutes on MiniMax-M3 in this environment; a plain `curl` to Cortex's endpoint was fast, so the hang is not a dead network path. Not traced further — it did not block the fixes above, which were verified with equivalent questions that completed normally.

28 pre-existing unit tests plus 4 new guardrail tests (32 total) and the live end-to-end test all pass.

## 0.2.0 (2026-11-12)

- Workers now run as their own detached processes (`runner.ts`), so a job keeps going when the session that started it closes.
- A finished job is reported to the conversation that started it (the bb thread, or the folder outside bb), exactly once, including after that conversation reopens.
- Cancelling a job stops the worker and everything it started.
- Installed in Pi and tested in a bb thread. 28 unit tests and the end-to-end test pass.

## 0.1.0 (2026-11-12)

First version, built and tested against Pi 1.5.2 and Node 26.8.

- Profile and skill routing added to the system prompt, with a size budget.
- `delegate`, `jobs` and `remember` tools.
- Job list on SQLite; worker reports posted back into the conversation.
- `/companion on|off|status`.
- 20 unit tests and one end-to-end test over Pi's RPC mode.
