# Technical Design Document: WO-C2E5A3 "AI tmux" (`ait`)

## 1. Overview

`ait` is a terminal dashboard that sits as a thin layer over tmux. It lets a solo developer running 3-8 parallel Claude Code sessions see each session's state (running, waiting, idle, done, unknown), get alerted once when a session needs input, and jump into or return from any session with one keystroke.

Key design choices:
- **No terminal emulation.** tmux owns sessions and PTYs. `ait` is a Node.js 22 process with zero npm dependencies that drives tmux through `execFile`.
- **Hooks are the primary state source.** Claude Code hooks (SessionStart, UserPromptSubmit, Notification, Stop) write per-session event files. Pane capture is a flagged, degraded fallback.
- **Local only.** No network listener, no telemetry. State lives under `AIT_HOME` (default `~/.local/state/ait`).
- **Dedicated tmux socket** (`tmux -L ait`) by default, which isolates it from the user's own tmux config and sessions.

Size M (about one week), gated by a baseline, a kill-or-shrink check and a hook spike.

## 2. Goals and Non-goals

### Goals
- List all managed sessions with name, project directory, branch, state and time in state.
- Detect state changes within 2 s; notify once per transition into `waiting`.
- Open a session in one keystroke and return in one keystroke (`switch-client`, never nested attach).
- Sessions survive dashboard exit.
- 100% recall of `waiting` transitions and at least 95% overall in a 20-transition manual test across 3+ sessions.
- Safe by construction: no `send-keys`, no shell strings, owner-only state.

### Non-goals
- Terminal emulator or multiplexer, theming, layouts, plugins.
- Remote or multi-user use, cross-machine sync, mobile notifications.
- History search, transcripts, cost dashboards.
- Auto-answering or orchestrating agents.
- GUI.
- Adopting already-running Claude processes.
- Resume after reboot (v1 stores the data needed; feature deferred).

## 3. Architecture

Assumptions: tmux 3.0 or newer, macOS/Linux, Node 22, and the installed Claude Code supports `--settings <file>` and distinguishes Notification kinds (confirmed in the spike; otherwise fall back as described under Risks).

```mermaid
flowchart LR
    U[User keyboard] --> CLI[ait CLI / Dashboard TUI]
    CLI -- execFile argv --> TM[tmux server -L ait]
    CLI --> REG[(registry.json)]
    CLI --> SET[(settings/name.json)]
    TM -- spawn claude --settings, AIT_SESSION --> CL[Claude Code]
    CL -- hook JSON on stdin --> HK[ait-hook.js]
    HK -- atomic write --> EVT[(events/name.json)]
    EVT -- fs.watch + read --> ST[State resolver]
    TM -- list-sessions, pane_dead_status, capture-pane fallback --> ST
    REG --> ST
    ST --> CLI
    ST --> NT[Notifier: bell, osascript, notify-send]
```

**Runtime flow**
1. `ait new` validates input, writes the registry entry and a per-session settings file, creates the tmux session with `remain-on-exit on`, and sets the status line.
2. Claude runs inside tmux; hooks call `ait-hook.js`, which writes the latest event atomically and always exits 0.
3. The dashboard polls `list-sessions` every 1 s and watches `events/`. The state resolver merges registry, tmux info and events, applies a 500 ms debounce, and emits transitions.
4. Transitions drive redraw and notifications (once per transition, coalesced, suppressed for the attached session).

## 4. Components

| Component | File | Responsibility |
|---|---|---|
| CLI | `bin/ait.js` | Argument parsing, subcommand dispatch, exit codes |
| Hook script | `bin/ait-hook.js` | Read stdin (cap 64 KiB), validate `AIT_SESSION`, write whitelisted event, exit 0 |
| Config | `src/config.js` | Paths, env (`AIT_HOME`, `AIT_SOCKET`), prefix, `notifyIdle` |
| tmux wrapper | `src/tmux.js` | `execFile` only, 2 s timeout, subcommand allowlist, version check, `=ait-<name>` targets |
| Registry | `src/registry.js` | Atomic read/write, stable IDs, schema validation, prune, backup on corruption |
| State | `src/state.js` | Event to state mapping, debounce, transition diff |
| Fallback detector | `src/detect-fallback.js` | Last 40 lines of `capture-pane`, ambiguous resolves to `waiting`, `degraded=true` |
| Notifier | `src/notify.js` | Bell, desktop notification via argv, burst coalescing, rate cap |
| Launcher | `src/launch.js` | Validation, claude path resolution, settings file, `new-session` |
| Dashboard | `src/dashboard.js`, `src/render.js`, `src/keys.js` | Raw-mode TUI, pure render functions, dialogs, resize, ASCII/NO_COLOR |
| Validation | `src/validate.js` | Name and directory validation, path helper with prefix assertion |
| Sanitizer | in `render.js`/shared | Strips ESC and C0/C1 control characters from all external strings |

**State definitions:** `waiting` = blocked on a permission prompt or question; `idle` = turn complete; `running` = working; `done` = process exited (exit code shown); `unknown` = detection failed.

**Sorting and numbering:** rows sort waiting (oldest first), running, idle, done. The `#` on each row is a stable creation-order ID, never reassigned, so hotkeys `1-9` always hit the session the user saw. Selection is keyed by session name.

## 5. Data model

Base directory `AIT_HOME` (0700, files 0600).

```
registry.json        { version:1, nextId:int, sessions:{ [name]: Session } }   (max 1 MiB)
events/<name>.json   latest hook event, atomic rename
settings/<name>.json per-session Claude settings with hooks (O_EXCL, hash-verified)
dashboard.lock       PID of running dashboard
audit.log            append-only, size-rotated
hook-errors.log      sanitized, size-rotated
```

**Session (registry entry)**

| Field | Type | Notes |
|---|---|---|
| id | int | Stable, never reused |
| name | string | `^[a-z0-9_-]{1,24}$`, unique; tmux name `ait-<name>` |
| dir | string | Absolute, `~` expanded; not unique across sessions |
| branch | string or null | Display only |
| args | string[] | Extra claude args |
| createdAt | epoch ms | |
| claudeSessionId | string or null | For future resume |
| exit | `{code, at}` or null | From `#{pane_dead_status}` |

**Event file:** `{ session, event, kind: permission|question|idle|null, ts, claudeSessionId }`.

**Derived runtime state (memory only):** `{ name, state, since, source: hook|fallback, degraded, attached, stale }`.

**Event to state mapping**

| Event | State |
|---|---|
| SessionStart, UserPromptSubmit | running |
| Notification (permission/question) | waiting |
| Notification (idle), Stop | idle |
| Pane dead | done |
| No event within 10 s and fallback match | per pattern, `degraded=true` |

## 6. API summary

`ait` has no network listener. The contract is documented in the OpenAPI 3.1 spec (**AI tmux (ait) Local Control Contract**), where each operation maps to a CLI subcommand (`x-cli`) and HTTP status maps to the CLI exit code (`x-exit-code`). The same schemas describe `--json` output and the file formats.

| Operation | CLI | Notes |
|---|---|---|
| `GET /sessions` | `ait ls [--json] [--verbose]` | `claudeSessionId` and `args` only with `--verbose` |
| `POST /sessions` | `ait new <name> [dir] [-- args]` | Exit 2-7 on error |
| `GET/PATCH /sessions/{name}` | `ait ls`, `ait rename` | |
| `DELETE /sessions/{name}` | `ait kill <name>` | Requires confirm |
| `POST /sessions/{name}/open` | `ait open <name>` | switch-client or attach |
| `DELETE /sessions/{name}/entry` | `ait rm <name>` | Only for `done` |
| `POST /dashboard` | `ait` | Start or attach |
| `POST /hooks/{event}` | `ait hook <event>` | Internal, always exit 0 |
| `GET /doctor` | `ait doctor` | Environment check |
| `GET /export`, `POST /purge` | `ait export`, `ait purge` | Data-subject rights |

Exit codes: 0 ok; 2 invalid name; 3 name taken; 4 directory missing; 5 not a folder; 6 claude not found; 7 tmux or other error (including project-hooks confirmation missing); 8 not found; 10 tmux missing or older than 3.0.

## 7. Error handling

| Condition | Handling |
|---|---|
| tmux missing or older than 3.0 | Exit 10 with install hint |
| tmux server not running | Normal first-run state; empty list |
| tmux call timeout (2 s) | Keep last data, mark `stale`, retry every 2 s; never await tmux on the render path |
| Session killed externally | Shown "no longer running"; no crash |
| Corrupt `registry.json` | Back up to `.bak`, start empty, show banner |
| Stale event/settings files | Pruned at startup when not in registry |
| Hook failure or malformed stdin | Hook exits 0, logs sanitized line |
| No hook event within 10 s | Session switches to fallback, `degraded=true`, visible marker |
| Second dashboard | Lock check (PID alive and command matches `ait`), attach to existing |
| Notification command fails | Swallow; bell only |
| Terminal under 60x15 | "Terminal too small" message; `q` still works |
| Unhandled render exception | Restore terminal (leave raw mode, show cursor), print fixed error, exit 1 |

User-facing errors use the fixed microcopy from the UX design; stack traces only under `AIT_DEBUG=1`.

## 8. Security

Threat model and privacy assessment (PASS WITH CONDITIONS) drive these hard requirements:

- **Process execution:** `execFile`/`spawn` with argv arrays only; no `shell:true`; `--` before Claude args; exact targets `=ait-<name>`. A test fails on `exec`, `shell: true` or template-built commands.
- **tmux allowlist:** `new-session, list-sessions, set-option, switch-client, attach-session, kill-session, capture-pane, bind-key, show, display-message`. `send-keys`, `paste-buffer`, `run-shell`, `pipe-pane` are forbidden and enforced by test.
- **Input validation:** names match the regex at every entry point (CLI, dialog, hook env, registry load, event file name). All paths are built by one helper that asserts the `AIT_HOME/<subdir>` prefix and rejects symlinks.
- **Filesystem:** state dir 0700, files 0600, `O_EXCL` plus rename, modes verified and repaired at startup, symlinked state dir refused.
- **Socket:** verify the tmux socket directory is owned by the current uid with no group/world bits, else refuse.
- **Settings injection:** per-launch `--settings`, no edits to global Claude or tmux config; hook command is a fixed argv of absolute `node` and `ait-hook.js`; hash verified before launch.
- **Event integrity:** dashboard drops events for unknown sessions, with `ts` before `createdAt` or more than 5 s in the future.
- **Output safety:** single `sanitize()` strips ESC and C0/C1 control characters before render, status line or notification. AppleScript reads `argv`; no interpolation.
- **Claude binary:** resolved to an absolute path once, rejected if relative or in a world-writable directory, shown at launch and in `doctor`.
- **Untrusted repos:** warn and require confirmation when the target directory has `.claude/settings*.json` with hooks.
- **Privacy:** no pane content, prompts or environment persisted; capture in memory only, fallback only, last 40 lines; notifications show name only by default; no network APIs in `src/` or `bin/` (test-enforced).
- **Kill safety:** confirm defaults to "keep"; wording warns that files may be partly changed; target re-verified by id and name.
- **Accepted:** a hostile process running as the same user bypasses file-level controls.

## 9. Performance and scaling

Scale is 3-8 sessions (design ceiling in the tens) on one machine.

- Poll `list-sessions` every 1 s plus `fs.watch` on `events/` with 100 ms coalescing; state changes display within 2 s.
- Capture only in fallback mode, 40 lines per session, per poll.
- "Since" ticks each second from recorded timestamps, clamped to at least 0 after sleep or clock jumps; no re-sort on tick.
- Per-render work is capped; all tmux calls have a 2 s timeout.
- Notifications: 500 ms debounce, once per transition, 2 s burst coalescing, max 10 desktop notifications per minute.
- Dashboard open under 3 s; session attach under 3 s; launch visible in under 2 s.
- Hooks must be negligible overhead: a short Node script that writes one small file.

## 10. Testing strategy

**Unit (`node:test`)**
- Validation fuzzing (`../`, `;`, quotes, NUL, unicode).
- State machine: mapping, debounce, notify-once, a waiting state clearing inside the debounce window produces no notification.
- Render at widths 60/80/100, ASCII and NO_COLOR modes, sanitization of OSC/CSI payloads.
- Registry: corrupt, oversize and malformed corpus; stable ID never reused.
- Notification escaping with quotes, backslashes, newlines, `$()`.
- Static checks: no forbidden `child_process` usage, no forbidden tmux subcommands, no network APIs.
- Permissions: `stat` after a fresh run with umask 000.

**Integration (real tmux on a throwaway socket)**
- Launch, list, open/switch, kill, DONE with exit code via `remain-on-exit`.
- Fake `claude` script emitting hook events; external `kill-session`; hung tmux stub produces `stale`.
- Same directory with two sessions; reorder during the kill dialog leaves the target unchanged.

**Manual and acceptance**
- 20 transitions across 3+ concurrent sessions: 100% `waiting` recall, at least 95% overall.
- Bell reaches the terminal; desktop notification on macOS and Linux.
- Dogfood week against baseline indicators (time to respond under 30 s, time to reach a session under 3 s).

**Gates before build is complete:** baseline recorded, kill-or-shrink verdict and hook spike results written in the README.

## 11. Deployment

- Distribution: a local Node package, installed by `npm link` or a PATH symlink; `ait` on PATH. No server, no build step, zero dependencies.
- Setup: `ait doctor` checks tmux version, claude path, hook support, prefix, bell, notifier, socket ownership and state-dir modes.
- Configuration: `AIT_HOME`, `AIT_SOCKET` (`ait` or `default`), `notifyIdle` (default false), `notifyShowPath` (default false), return key (default `<prefix> Tab`, prefix derived from `tmux show -g prefix`), optional extra Claude args.
- First run prints the state directory and the socket in use.
- Rollout steps: baseline (1 day), kill-or-shrink (1 day), hook spike (0.5-1 day), walking skeleton with `ait new` and `ait ls` (2 days), dashboard and alerts (2 days), dogfood week, decision.
- Rollback: quit the dashboard, `tmux -L ait kill-server`, delete `AIT_HOME` (or `ait purge`). Nothing global was modified.

## 12. Risks and open questions

| # | Risk or question | Mitigation |
|---|---|---|
| 1 | Hook payload may not distinguish permission from idle Notification in the installed version | Spike confirms; otherwise treat all Notifications as `waiting` (safe side) |
| 2 | `--settings` flag unavailable or precedence differs from project hooks | Spike; fallback is an explicit, merged, reversible project-local file (`ait doctor --uninstall`) |
| 3 | Fallback pane matching is fragile across Claude versions | Mark degraded, last 40 lines, bias to false `waiting`, conservative claims |
| 4 | Plain tmux may already meet the goals | Hard kill-or-shrink gate; `hook.js`, `state.js`, `tmux.js` stay reusable for a "hook + status segment + choose-tree" outcome |
| 5 | Users launch `claude` outside `ait` and are untracked | Shell alias, empty-state hint, README; no adoption in v1 |
| 6 | Separate socket hides sessions from normal `tmux ls` and ignores `~/.tmux.conf` | Document, offer `AIT_SOCKET=default`, `doctor` prints socket |
| 7 | Return key or prefix collides with user bindings | Derive prefix; configurable; detect collisions; bind on `ait` socket only |
| 8 | Reboot loses sessions | Registry keeps dir and Claude session ID; resume is the likely first follow-up |
| 9 | Sleep or clock jumps distort "Since" | Clamp, use recorded timestamps |

Open questions:
1. Should `--dangerously-skip-permissions` in extra args be warned about or confirmed?
2. Is the machine shared with other accounts (raises socket and permission risk)?
3. Is `audit.log` wanted outside the pilot?
4. Is the project-hooks confirmation acceptable friction?
5. Which matters more to notify on: permission prompts, questions, or finished turns? (Current default: waiting only; idle quiet and off.)

## 13. Alternatives considered

| Alternative | Why not chosen |
|---|---|
| **Plain tmux config** (`monitor-activity`, `monitor-bell`, window names, `choose-tree -s`) | Cannot distinguish waiting from idle without hooks. Kept as the mandatory kill-or-shrink check and the fallback scope if it proves sufficient. |
| **Hook + tmux status segment + `choose-tree` only** | Cheaper and a legitimate shrink outcome; the full TUI adds sorted view, once-per-transition alerts and safe stable numbering. The design keeps these components reusable. |
| **Screen-scraping as primary detection** | Claude's TUI redraws and wording changes by version; unreliable and spoofable. Kept only as a degraded fallback. |
| **Own PTY multiplexer or terminal emulator** | Large effort, no value driver; tmux already solves it. |
| **Default tmux server instead of `-L ait`** | Would collide with user config and bindings. Available through `AIT_SOCKET=default`. |
| **Editing global Claude settings for hooks** | Silent mutation of user config. Per-launch `--settings` is isolated and reversible. |
| **Keying sessions by directory** | Several sessions in one repo or worktree are common; names and stable IDs are used instead. |
| **Numbering by sorted position** | Reordering at the moment of action could open or kill the wrong session; stable creation-order IDs chosen. |
| **`send-keys` for gentle kill or auto-answering** | Mis-targeted keystrokes could approve destructive actions; forbidden in v1. |
| **Polling only, or hooks only** | Polling alone adds latency; hooks alone miss dead sessions. Hybrid chosen: hooks + `list-sessions` poll + `fs.watch`. |
| **Daemon plus socket IPC, or a Go/Rust binary** | More moving parts than a single-user, one-week tool justifies; file-based events with Node built-ins suffice. |
