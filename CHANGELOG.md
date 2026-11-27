# Changelog

## 0.6.0

Speed, briefs, quality tiers, and a visible count of working agents. Every number below was measured here with `npm run bench`.

- **Lean workers (speed).** A worker now starts with no extensions and no MCP servers unless the job needs them. A trivial task took 8s lean, against 41s with everything loaded and 34s as a bb thread. When a job needs MCP, only those servers' tools are allowed (`--tools` allowlist), so a memory job cannot reach a video service or an image service: 10s with the memory service. Runs as a local process by default; `watch: true` gives a visible bb child thread instead.
- **Follow-ups resume the same worker, lean too.** A lean worker keeps its session, so a follow-up reaches a worker that remembers its work (6s; tested with a remembered number).
- **Briefs.** `delegate` takes `task` (goal), `context`, and `expected_output`, and builds a structured brief with a size cap. The raw conversation is opt-in (`include_conversation`): in testing it made a weaker worker go investigating, and one job took 259s instead of 37s.
- **Quality tiers.** `tier: "best"` runs Claude through bb (14s on the trivial task); `fast` runs Pi. The mapping is the user's own `workers.json`. Claude and Codex always run through bb, because the plain CLIs are not signed in on a server.
- **Agent count in bb.** The thread title shows `[2 agents working]`, set by code, updated as jobs start and finish, and cleared when none are left. Updates are queued and the count is read at write time; the first version let two jobs started together overwrite each other with an older number.
- **Time limit per job** (`max_minutes`, default 20, at most 120).
- Tried and dropped: per-server agent folders (profiles). They connected only the chosen server but started slower (10–21s) than the normal folder, because they lose its caches. The allowlist gives the same safety without the cost.
- 67 unit tests, the end-to-end test and the benchmark pass.

## 0.5.0

- **Continue open work instead of starting a new worker.** Each turn the companion sees the recent jobs in this conversation (open, or finished in the last hour) with what they did. A follow-up such as "make it darker" sets `continue_job` on `delegate`, and the request goes to the same bb child thread as a follow-up message, so the worker keeps its context. A new subject starts a new job. If the request is unclear, the companion asks one question.
- Verified live in bb: a file created by one job was extended by a follow-up sent to the same worker thread.
- 42 unit tests pass.

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
- **Open, not caused by this package.** Some natural-language questions to the companion (worded to prompt a the memory service recall or a live web check) hung for several minutes on the default model in this environment; a plain `curl` to the memory service's endpoint was fast, so the hang is not a dead network path. Not traced further — it did not block the fixes above, which were verified with equivalent questions that completed normally.

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
