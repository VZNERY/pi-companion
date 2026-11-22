# pi-companion

A Pi package that turns a Pi session into a personal companion. Pi itself is not forked or changed: this is an extension that loads on top of it.

What it adds:

- **Profile and skill routing** in the system prompt: how the assistant talks, when to confirm before acting, and which skill to use for which job. The profile is yours (see below); the package ships only a neutral template.
- **`delegate`**: hands a task to a background worker (`pi`, `claude` or `codex`) that runs in its own context. The conversation stays free, and the worker's short report is posted back when it ends. A job keeps running if the session closes and is reported when the conversation reopens.
- **`jobs`**: lists background jobs, shows one job's status and result, or cancels one.
- **`remember`**: saves a standing preference so it applies in every future session.
- **`companion`**: the on/off/status switch as a tool. Works in any client that routes tool calls.
- **A deterministic reminder** on two kinds of message: a build or feasibility question gets the probability-line rule re-injected that turn; a generation or resolution request gets the confirm-before-spending rule re-injected.

## Install

```sh
pi install <path-to-this-folder>    # load it in every Pi session
pi remove  <path-to-this-folder>    # take it out again
```

Or try it in one session without installing:

```sh
pi -e <path-to-this-folder>/extensions/companion/index.ts
```

## Make it yours

The package ships a neutral profile template at `profile/PROFILE.md` and `profile/ROUTING.md`. Replace them with your own without editing the package:

```sh
node scripts/import-profile.mjs ~/path/to/CLAUDE.md ~/path/to/memory-notes/
```

This reads the files you name, saves them to your data folder (outside the package, never committed anywhere), and reports the size. The companion sends the profile with every message, so trim it to what matters; it warns if it is over budget.

Inside a session: `/companion on`, `/companion off`, `/companion status`. Through a chat client that does not forward typed slash commands, use the `companion` tool instead.

## Where things live

| What | Where |
|---|---|
| Your profile and routing (preferred) | `<data dir>/profile/PROFILE.md` and `ROUTING.md` |
| Package template (fallback) | `profile/PROFILE.md` and `ROUTING.md` in this folder |
| Rules learned through `remember` | `<data dir>/learned.md` (max 60 lines) |
| Job list | `<data dir>/jobs.sqlite` |
| On/off switch | `<data dir>/state.json` |

`<data dir>` is `~/.pi/agent/pi-companion` by default. Set `PI_COMPANION_DATA_DIR` to move it. `PI_COMPANION=on|off` overrides the switch.

## Optional: running inside a bb thread

When Pi runs inside a bb thread (bb sets `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID` and `BB_THREAD_ID`), `delegate` starts each job as a visible bb child thread that you can open and stop. Outside bb, delegate runs jobs as local background processes.

## Test

```sh
npm test       # unit tests, no model calls
npm run e2e    # real Pi session over RPC: delegates a job and waits for the report (uses a few model calls)
```

Run both after every Pi upgrade before relying on the new version. `BLUEPRINT.md` covers the design, the known limits and the roadmap.

## Licence

PolyForm Noncommercial 1.0.0. Free to use, modify and share for noncommercial purposes. Commercial use needs a separate license from the copyright holder. See `LICENSE`. Contributions are welcome: see `CONTRIBUTING.md`.
