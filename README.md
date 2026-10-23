# ait: AI tmux

A terminal dashboard for many Claude Code sessions, built as a thin layer over tmux.
It shows each session's state (waiting / running / idle / done), alerts you once when a
session starts waiting for you, and jumps into any session with one key.
The same operations are available as a small local HTTP API (`npm start`).

No npm dependencies. Everything uses Node built-ins.

## 1. Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22 or newer | everything |
| tmux | 3.2 or newer | the dashboard and sessions (not needed to run `npm test` or `/health`) |
| Claude Code (`claude`) | any with hooks | launching sessions; must be on `PATH`, in a folder that is not world-writable |
| macOS or Linux | | Windows is not supported |

Check versions: `node -v`, `tmux -V`, `claude --version`.

## 2. Install

```
git clone https://github.com/jdmunta/ai-tmux.git
cd ai-tmux
npm link        # puts `ait` on your PATH
ait doctor      # checks tmux, claude, prefix, socket, state folder
```

There is nothing to build and no `npm install` step. Without `npm link` you can run
`node bin/ait.js` from the project folder instead.

To remove the command later: `npm unlink -g ait`.

## 3. Quick start

```
ait new api-refactor ~/code/api    # start a Claude Code session
ait                                # open the dashboard
```

In the dashboard press `Enter` on a session to open it. Inside a session press your tmux
prefix then `Tab` (default `Ctrl-b` then `Tab`) to return to the dashboard. Press `q` to
quit the dashboard; your sessions keep running because they live in tmux.

The dashboard needs a real terminal. It will fail with "not a terminal" if started from a
non-interactive shell.

## 4. Session states

| State | Meaning |
|---|---|
| WAITING | Claude is blocked on a permission prompt or a question. You get an alert. |
| RUNNING | Claude is working. |
| IDLE | Claude finished its turn and is ready for a new prompt. No alert by default. |
| DONE | The Claude process exited. The exit code is shown. The row stays until you remove it. |
| UNKNOWN | The state could not be detected. |

Rows are sorted WAITING (longest wait first), RUNNING, IDLE, DONE. The `#` column is fixed
for the life of a session and does not change when the list reorders.

State comes from Claude Code hooks that `ait` supplies per session with
`claude --settings <file>`. If no hook event arrives within 10 seconds, `ait` falls back to
reading the screen to guess the state (less precise; screen text is never saved).

## 5. Commands

```
ait                                  open the dashboard
ait new <name> [dir] [-- claude args]
ait ls [--json]                      plain list of sessions
ait open <name>                      switch to / attach to a session
ait rename <old> <new>
ait kill <name> [--yes]              stop a session (asks to confirm)
ait rm <name>                        remove a finished (DONE) row
ait doctor [--json]                  check your setup
ait export [--out <file>]            back up registry data (will not overwrite)
ait purge [--confirm purge]          stop the ait tmux server, delete ait's files
ait serve                            start the HTTP API (same as `npm start`)
```

Details:

- **Names** use lowercase letters, digits, `-` and `_`, up to 24 characters. `dash` is reserved.
- **Directory** defaults to the current folder. Extra Claude options go after `--`, e.g.
  `ait new fix-tests ~/code/web -- --model sonnet`.
- If the folder has project-level Claude hooks, `ait` asks you to confirm (`y`, or `--yes`).
- **Kill** stops Claude immediately; files it was editing may be partly changed.
- **Export** includes extra Claude arguments and session IDs, so keep the file private.

## 6. Dashboard keys

| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` | Move selection |
| `g` / `G` | First / last |
| `Enter` | Open selected session |
| `1`-`9` | Open the session with that number |
| `w` | Next waiting session |
| `n` / `r` / `x` | New / rename / kill (or remove, if DONE) |
| `?` | Help |
| `q` or `Ctrl-c` | Quit dashboard (sessions keep running) |
| `Esc` | Close a dialog |
| prefix, then `Tab` (inside a session) | Return to dashboard |
| prefix, then `d` (inside a session) | Standard tmux detach |

The terminal must be at least 60 columns by 15 rows.

## 7. Alerts

When a session transitions into WAITING you hear the terminal bell and, if available, get a
desktop notification (`osascript` on macOS). You are alerted once per transition, and not
at all if you are already viewing that session. Over SSH only the bell is available.

## 8. Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `AIT_HOME` | `~/.local/state/ait` | Where `ait` stores its data (honours `XDG_STATE_HOME`) |
| `AIT_SOCKET` | `ait` | `ait` = separate tmux server; `default` = your normal tmux server |
| `AIT_NOTIFY_IDLE` | off | `1` = also give a quiet alert when a session goes idle |
| `AIT_NOTIFY_PATH` | off | `1` = include the folder in desktop notifications |
| `AIT_DESKTOP` | on | `0` = bell only, no desktop notifications |
| `AIT_RETURN_KEY` | `Tab` | Key (after the prefix) that returns to the dashboard |
| `AIT_API_TOKEN` | none | Bearer token for the HTTP API |
| `PORT` | `3000` | HTTP API port |
| `AIT_DEBUG` | off | `1` = show technical error details |
| `NO_COLOR` | unset | Any value = no colours (state labels still shown) |

The display switches to plain ASCII when your locale is not UTF-8.

**Separate tmux server.** By default sessions run on their own tmux server (socket `ait`),
so `tmux ls` will not list them and your `~/.tmux.conf` does not apply. Use `tmux -L ait ls`.

**What is stored** (in `AIT_HOME`, private to you): session names, folders, git branch,
extra Claude arguments, ids, exit codes, the last hook event per session, per-session hook
settings, an audit log, a hook error log and a lock file. `ait` sends nothing over the
network and does not change your global Claude or tmux settings.

## 9. HTTP API (optional)

Start with `ait serve` or `npm start`. It listens on `PORT` (default 3000).

> **Security:** this build listens on all interfaces by default, and a web page open in your
> browser could trigger requests to it. Do not use it on a shared network. Always set a long
> random token and never use the token in a browser.

```
export AIT_API_TOKEN=$(openssl rand -hex 32)
npm start

curl -s http://localhost:3000/health
curl -s -H "Authorization: Bearer $AIT_API_TOKEN" http://localhost:3000/sessions
curl -s -X POST -H "Authorization: Bearer $AIT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"api-refactor","dir":"/Users/me/code/api"}' http://localhost:3000/sessions
```

| Route | Same as |
|---|---|
| `GET /health` | (no login needed) |
| `GET /sessions`, `POST /sessions` | `ait ls`, `ait new` |
| `GET/PATCH/DELETE /sessions/{name}` (delete needs `?confirm=true`) | `ait ls`, `ait rename`, `ait kill` |
| `POST /sessions/{name}/open` | `ait open` |
| `DELETE /sessions/{name}/entry` | `ait rm` |
| `POST /dashboard` | `ait` |
| `GET /doctor`, `GET /export`, `POST /purge` | `ait doctor`, `export`, `purge` |

Without a token only requests from the same machine are accepted; with a token send
`Authorization: Bearer <token>`. Errors look like `{"error": <code>, "message": "..."}`.
The full contract is in `docs/openapi.yaml`.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "AI tmux needs tmux 3.2 or newer" (exit 10) | `brew install tmux` or your package manager; check `tmux -V` |
| "The tmux socket folder is not private" | `chmod 700 /tmp/tmux-$(id -u)` and retry |
| "Couldn't start Claude Code" (exit 6) | Put `claude` on `PATH`, not in a world-writable folder; run `ait doctor` |
| "That folder doesn't exist." (4) / "That path is a file" (5) | Check the directory path |
| "A session called X already exists." (3) | Pick another name |
| "Use letters, numbers, - and _ only." (2) | Use `a-z 0-9 - _`, max 24 characters |
| Header shows `[stale]` | tmux not answering; wait, or check `tmux -L ait ls` |
| "State detection: fallback mode" | Run `ait doctor`; update Claude Code if `--settings` is unsupported; relaunch the session |
| Row stays WAITING after you approved a prompt | Known limitation; clears when the turn finishes |
| Waiting but no sound | Check the terminal bell setting and Do Not Disturb |
| "A dashboard is already running." | Run `ait` to attach to it |
| "Terminal too small" | Enlarge the window or use `ait ls` |
| DONE with "(gone)" | Session was closed outside `ait`; `ait rm <name>` and relaunch |
| "session registry was unreadable" | A backup is at `registry.json.bak`; copy it back if valid |
| API returns 403 | Set `AIT_API_TOKEN` and send the Bearer header |
| Sessions gone after reboot | tmux does not survive reboots; `ait rm <name>`, then `ait new <name> <dir> -- --resume` |

## 11. Known limitations

- Only sessions started with `ait new` (or `n` in the dashboard) are tracked; existing
  sessions are not adopted.
- After approving a permission prompt the row can keep showing WAITING until the turn ends.
- The HTTP API has open security findings (see `docs/security-review.md`); prefer the CLI
  and dashboard for day-to-day work.
- `ait` never types into a session, so it cannot answer prompts for you.

## 12. Development

```
npm test        # node --test test/*.test.js (no tmux required)
```

Project layout:

| Path | Contents |
|---|---|
| `bin/ait.js` | CLI entry point |
| `bin/ait-hook.js` | Hook script that Claude Code calls to report state |
| `bin/serve.js` | HTTP API entry point (`npm start`) |
| `src/dashboard.js`, `render.js`, `ui.js`, `keys.js` | Dashboard loop, drawing, dialogs, key decoding |
| `src/tmux.js`, `launch.js` | tmux wrapper and session launching |
| `src/registry.js`, `state.js`, `hook.js`, `detect-fallback.js` | Session registry and state detection |
| `src/server.js`, `service.js`, `serve.js` | HTTP API and shared operations |
| `src/notify.js`, `audit.js`, `lock.js`, `paths.js`, `security.js`, `sanitize.js`, `validate.js`, `config.js`, `errors.js`, `port.js` | Support modules |
| `test/` | Test suites and a fake tmux |
| `docs/` | Requirements, architecture, design, user manual, runbook, security and QA reports |

## 13. Further reading

- `docs/user-manual.md`: full user manual and FAQ
- `docs/architecture.md`, `docs/technical-design.md`: how it works
- `docs/deployment.md`, `docs/sre-runbook.md`: running it
- `docs/threat-model.md`, `docs/security-review.md`: security
- `docs/openapi.yaml`: HTTP API contract

## License

UNLICENSED (private).
