# Architecture: WO-C2E5A3 "AI tmux" (`ait`)

## Assumptions
- Node.js 22, zero npm dependencies (only `node:` built-ins). tmux ≥ 3.0 on macOS/Linux.
- Single user, single machine. No HTTP server: the "API" is a CLI plus an internal hook-event interface (file-based) and the tmux command contract.
- Claude Code hooks (Notification, Stop, UserPromptSubmit, SessionStart) are verified in the gating spike. Pane-capture is a degraded fallback.
- `claude` hooks are injected per launch via `--settings <file>` (no global edits). If the installed version lacks this flag, the spike result must be recorded and the fallback mode used.

## Decisions on the domain items that change the model
| Item | Decision |
|---|---|
| REQ-1 | States: `running`, `waiting` (permission prompt/question), `idle` (turn complete), `done` (exited), `unknown`. Notify on `waiting` (urgent bell + desktop); on `idle` only a quiet single bell, off by default (`notifyIdle=false`). |
| REQ-7 | Registry file plus `remain-on-exit on` for managed sessions. Exit code captured via `#{pane_dead_status}`. Dead sessions are shown as DONE until the user removes them (`x`). |
| REQ-10 | Dedicated socket `tmux -L ait` by default; `AIT_SOCKET=default` uses the default server. |
| REQ-16 | Numbers are stable creation-order IDs (`#`), never reassigned during the lifetime of a registry entry. The row order may change, but the number printed on the row is fixed. Max display of 1-9 as hotkeys; beyond that, select with arrows. |
| REQ-9 | Return key is derived from the tmux prefix; bound on the `ait` socket only. Uses `switch-client`. |
| REQ-15 | `send-keys` is never used. The one exception is the optional gentle kill (deferred; v1 uses `kill-session` only). |

## Stack
Node.js 22 ESM, one process for the dashboard, a tiny hook script, tmux via `child_process.execFile` (never a shell string).

## File list
```
ait/
  package.json            # "type":"module", bin: { ait: bin/ait.js }
  README.md               # setup, keys, detection modes, kill-or-shrink result
  bin/ait.js              # CLI entry: arg parsing, subcommand dispatch
  bin/ait-hook.js         # hook script invoked by Claude; writes event file; always exit 0
  src/config.js           # paths, defaults, env (AIT_HOME, AIT_SOCKET, prefix, notifyIdle)
  src/tmux.js             # tmux wrapper (execFile), version check, parsing
  src/registry.js         # registry.json read/write (atomic), ids, cleanup
  src/state.js            # state resolution: hooks → fallback; debounce; transitions
  src/detect-fallback.js  # capture-pane last-N-lines matcher (degraded)
  src/notify.js           # bell, osascript/notify-send, burst coalescing, escaping
  src/launch.js           # new session: validation, settings file, tmux new-session
  src/dashboard.js        # TUI loop: render, input, dialogs, resize
  src/render.js           # pure view functions (rows, layout, ascii fallback)
  src/keys.js             # raw-mode key decoding
  src/validate.js         # name/dir validation
  test/*.test.js          # node:test: validate, state machine, render, registry
```

## Data model
Base dir `AIT_HOME` = `$XDG_STATE_HOME/ait` or `~/.local/state/ait`.

```
registry.json   { version:1, nextId:int, sessions:{ [name]: Session } }
events/<name>.json   latest hook event (atomic write via rename)
settings/<name>.json per-session Claude settings with hooks
dashboard.lock       pid of running dashboard
```

**Session**
```
{ id:int,                 // stable, never reused
  name:string,            // ^[a-z0-9_-]{1,24}$, unique; tmux name = "ait-"+name
  dir:string,             // absolute, ~ expanded
  branch:string|null,     // git branch/worktree, display only
  args:string[],          // extra claude args
  createdAt:number,       // epoch ms
  claudeSessionId:string|null,  // from hook payload, for future resume
  exit:{ code:int, at:number }|null }
```

**Event file** (written by `ait-hook.js`)
```
{ session:string, event:"SessionStart"|"UserPromptSubmit"|"Notification"|"Stop",
  kind:"permission"|"question"|"idle"|null, ts:number, claudeSessionId:string|null }
```

**Derived runtime state** (memory only)
```
{ name, state, since:number, source:"hook"|"fallback", degraded:boolean,
  attached:boolean, stale:boolean }
```

**Event → state mapping**
| Event | State |
|---|---|
| SessionStart, UserPromptSubmit | running |
| Notification (permission / question) | waiting |
| Notification (idle prompt), Stop | idle |
| pane dead | done (exit code shown) |
| no event within start grace and fallback match | per pattern, `degraded=true` |

Rules: debounce 500 ms before display and before notification (REQ-18); notify once per transition into `waiting`; suppress if a client currently displays that session; coalesce bursts within 2 s into one "N sessions are waiting".

## Interfaces

### CLI contract
| Command | Behaviour | Exit codes |
|---|---|---|
| `ait` | Start or attach to dashboard (session `ait-dash` on the ait socket) | 0; 10 tmux missing/too old |
| `ait new <name> [dir] [-- <claude args>]` | Launch session; dir defaults to cwd | 0; 2 invalid name; 3 name taken; 4 dir missing; 5 dir not a folder; 6 claude not found; 7 tmux error |
| `ait ls [--json]` | List sessions and states | 0 |
| `ait open <name>` | switch-client or attach | 0; 8 not found |
| `ait kill <name>` | kill session and remove entry | 0; 8 not found |
| `ait rm <name>` | Remove a DONE entry from the registry | 0; 8 not found |
| `ait doctor` | Check tmux version, claude path, hooks, prefix | 0 |
| `ait hook <event>` | Internal; reads hook JSON on stdin, writes event file | always 0 |

Errors go to stderr with the microcopy from the UX spec; `--json` outputs `{ "error": code, "message": str }`.

### tmux contract (signatures)
- `tmux.version(): Promise<{major,minor}>`
- `tmux.listSessions(): Promise<{name,attached:number,dead:boolean,deadStatus:number|null}[]>`
- `tmux.newSession({name,dir,env,argv}): Promise<void>` → `new-session -d -s ait-<name> -c <dir> -e AIT_SESSION=<name> -- <claudeAbs> --settings <file> ...args`, followed by `set-option -t =ait-<name> remain-on-exit on`.
- `tmux.capture(name, lines=40): Promise<string>`
- `tmux.switchOrAttach(name)`; target always `=ait-<name>`
- `tmux.bindReturnKey(prefix)`: `bind-key -T prefix Tab switch-client -t =ait-dash` on the ait socket only
- `tmux.setStatus(name, text)`: per-session `status-right` showing `‹name› · <prefix> Tab → dashboard · N waiting`

### Hook injection
Per-session `settings/<name>.json` contains hooks for the four events, each running `node <abs>/bin/ait-hook.js <event>`; the env var `AIT_SESSION` selects the session (REQ-3).

### Internal module signatures
- `validate.name(s): {ok,error?}`; `validate.dir(s): {ok,path?,error?}`
- `registry.load()/save()/add(session)/remove(name)/prune(liveNames)`
- `state.resolve(registryEntry, tmuxInfo, event|null, capture|null, now): DerivedState`
- `state.diff(prev[], next[]): Transition[]`
- `notify.fire(transitions, {desktop:boolean, notifyIdle:boolean})`
- `render.frame(model, {cols, rows, ascii, noColor}): string`
- `dashboard.run(): Promise<void>`

## Dashboard behaviour (summary)
- Poll `list-sessions` every 1 s plus `fs.watch` on `events/`; "Since" ticks every second from recorded timestamps (clamped ≥0 after sleep).
- Keys per the UX spec; Enter/number open via `switchOrAttach`. Number keys match the stable `id`.
- Sort: waiting (oldest first), running, idle, done. Selection keyed by session name.
- Terminal <60×15 shows only "Terminal too small".
- ASCII mode when `LANG=C` or non-UTF-8; honours `NO_COLOR`.

## Error handling
| Condition | Handling |
|---|---|
| tmux missing / <3.0 | Exit 10 with install hint |
| tmux server not running | Normal; empty list. Not an error. |
| tmux call timeout (2 s) | Keep last data, header `stale`, retry every 2 s |
| Session killed externally | Registry entry marked done "no longer running"; no crash |
| Corrupt `registry.json` | Back up to `registry.json.bak`, start empty, banner |
| Stale event/settings files | Pruned at startup when the session is not in registry |
| Hook script failure | Always exit 0; never blocks Claude |
| Hooks not firing within 10 s of start | Switch that session to fallback; `degraded=true` |
| Second dashboard | `dashboard.lock` check; attach to the existing one |
| Notification command fails | Swallow, bell only; escape quotes/backslashes for AppleScript, pass args via `execFile` |
| Unhandled exception in render | Restore terminal (leave raw mode, show cursor), print error, exit 1 |

## Security and safety constraints
- No `send-keys`, no shell strings; all args via `execFile`.
- No edits to the user's global Claude or tmux config.
- Registry and event files `0600`; the directory `0700`.

## Test plan hooks (for Developer/QA)
- Unit: validation, state machine incl. debounce and transition-once, render at widths 60/80/100, AppleScript escaping.
- Manual: 20 transitions across 3 concurrent sessions; target is 100% recall of `waiting` and ≥95% overall (REQ-17).
- Gating: spike result and kill-or-shrink outcome recorded in README before build is declared complete.

## Open risks
1. Hook payload fields for distinguishing permission vs. idle Notification may differ by version. The spike must confirm; otherwise treat all Notifications as `waiting`, which errs on the safe side.
2. `--settings` flag availability; the fallback is a merged project-local settings file, created explicitly and reversible via `ait doctor --uninstall`.
3. Kill-or-shrink may reduce scope to hook + status segment + `choose-tree`; this design keeps `state.js`, `hook`, and `tmux.js` reusable in that outcome.
