# ait: AI tmux — User Manual

## 1. What it is

`ait` is a terminal dashboard for people who run several Claude Code sessions at once. It is a thin layer on top of **tmux**. It does three things:

1. **Shows** every session it manages: name, folder, state, and how long it has been in that state.
2. **Alerts** you once when a session starts waiting for you (a permission prompt or a question).
3. **Jumps** you into any session with one key, and back to the dashboard with one key.

Sessions run inside tmux, so closing the dashboard never stops them.

**States you will see**

| State | Meaning |
|---|---|
| WAITING | Claude is blocked on a permission prompt or a question. You get an alert. |
| RUNNING | Claude is working. |
| IDLE | Claude finished its turn and is ready for a new prompt. No alert by default. |
| DONE | The Claude process exited. The exit code is shown. The row stays until you remove it. |
| UNKNOWN | The state could not be detected. |

**Things to know up front**

- Only sessions started with `ait new` (or the `n` key in the dashboard) are tracked. Sessions you already have running elsewhere are not adopted.
- `ait` uses its own tmux server (socket `ait`). Your normal `tmux ls` will not list these sessions, and your `~/.tmux.conf` does not apply to them.
- Known limitation: after you approve a permission prompt, the row can keep showing WAITING until Claude finishes its turn.
- Known status of the delivered build: its automated test run had one failing test, and review stations raised security concerns about the optional HTTP API (see section 3, task 9). Use the command line and dashboard for day-to-day work.

---

## 2. Quick start

**Requirements:** Node.js 22 or newer, tmux 3.2 or newer, Claude Code (`claude`) on your PATH, macOS or Linux.

```
npm link             # puts `ait` on your PATH (run in the ait folder)
ait doctor           # checks tmux, claude, prefix, socket, state folder
ait new api-refactor ~/code/api
ait                  # opens the dashboard
```

In the dashboard, press `Enter` on a session to open it. Inside a session, press your tmux prefix and then `Tab` (by default `Ctrl-b` then `Tab`) to return to the dashboard. Press `q` to quit the dashboard. Your sessions keep running.

---

## 3. Core tasks

### Task 1: Check your setup

1. Run `ait doctor`.
2. Read each line. It reports the tmux version, the `claude` path, whether `claude` supports `--settings`, your tmux prefix, the return key, the socket, the notifier, and the state folder.
3. If `--settings flag` says "not detected", `ait` falls back to reading the screen to guess state. This works, but is less precise.

Add `--json` for machine-readable output.

### Task 2: Start a session

1. Run:
   ```
   ait new api-refactor ~/code/api
   ```
2. The folder defaults to your current folder if you leave it out.
3. To pass extra options to Claude, put them after `--`:
   ```
   ait new fix-tests ~/code/web -- --model sonnet
   ```
4. If the folder has project-level Claude hooks, `ait` asks you to confirm. Answer `y`, or add `--yes` to skip the question.

Names may use lowercase letters, digits, `-` and `_`, up to 24 characters. `dash` is reserved.

You can also launch from inside the dashboard: press `n`, fill in Name and Directory, press `Tab` to switch fields and `Enter` to launch. If you leave Name empty, it is derived from the folder name.

### Task 3: Watch your sessions

1. Run `ait` to open the dashboard.
2. Sessions are sorted with WAITING first (longest wait first), then RUNNING, IDLE, DONE.
3. The number in the `#` column is fixed for the life of the session. It does not change when the list reorders.
4. For a plain list without the dashboard: `ait ls` (or `ait ls --json`).

The terminal must be at least 60 columns by 15 rows. If it is too small you will see "Terminal too small".

### Task 4: Respond to a waiting session

1. When a session starts waiting, you hear the terminal bell and, if available, get a desktop notification.
2. In the dashboard press `w` to jump the selection to the next waiting session.
3. Press `Enter` to open it, or press its number (`1`-`9`).
4. Answer the prompt inside the session.
5. Press prefix then `Tab` to go back to the dashboard.

You are alerted once per transition into waiting. If you are already viewing that session, no alert fires.

### Task 5: Rename, kill, or remove a session

- **Rename:** press `r`, edit the name, `Enter`. Or `ait rename <old> <new>`.
- **Kill:** press `x`, then `y` to confirm (`Enter` or `n` keeps it). Or `ait kill <name>`, which asks for confirmation (add `--yes` to skip). Killing stops Claude immediately, and files it was editing may be partly changed.
- **Remove a finished (DONE) row:** press `x` then `y`, or run `ait rm <name>`. `rm` only works on finished sessions.

### Task 6: Open a session from the command line

Run `ait open <name>`. Inside tmux this switches to the session; outside it attaches.

### Task 7: Back up your data

```
ait export --out ~/ait-backup.json
```
The file includes extra Claude arguments and Claude session IDs, so keep it private. It will not overwrite an existing file. Without `--out`, the export prints to the screen.

### Task 8: Erase everything

```
ait purge
```
Type `purge` when asked (or use `--confirm purge`). This stops the `ait` tmux server (ending its sessions) and deletes only the files `ait` created in its state folder.

### Task 9: Use the HTTP API (optional)

Start it with `ait serve` or `npm start`. It listens on `PORT` (default 3000). It is separate from the dashboard and is **not recommended on a shared network** in this build: it listens on all interfaces by default, and reviewers flagged that a web page open in your browser could trigger requests to it. Always set a long random token and never use the token in a browser.

```
export AIT_API_TOKEN=$(openssl rand -hex 32)
npm start
```

Examples (`$T` is your token):

```
curl -s http://localhost:3000/health
curl -s -H "Authorization: Bearer $T" http://localhost:3000/sessions
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"name":"api-refactor","dir":"/Users/me/code/api"}' http://localhost:3000/sessions
curl -s -X PATCH -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"name":"api-v2"}' http://localhost:3000/sessions/api-refactor
curl -s -X DELETE -H "Authorization: Bearer $T" "http://localhost:3000/sessions/api-v2?confirm=true"
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

Without a token, only requests from the same machine are accepted; with a token, send `Authorization: Bearer <token>`. Errors look like `{"error": <code>, "message": "..."}`.

---

## 4. Dashboard keys

| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` | Move selection |
| `g` / `G` | First / last |
| `Enter` | Open selected session |
| `1`-`9` | Open the session with that number |
| `w` | Next waiting session |
| `n` / `r` / `x` | New / rename / kill |
| `?` | Help |
| `q` or `Ctrl-c` | Quit dashboard (sessions keep running) |
| `Esc` | Close a dialog |
| prefix, then `Tab` (inside a session) | Return to dashboard |
| prefix, then `d` (inside a session) | Standard tmux detach |

Tip: scroll back inside a session with prefix then `[`, then PgUp; `q` leaves scroll mode.

---

## 5. Configuration reference

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `AIT_HOME` | `~/.local/state/ait` | Where `ait` stores its data |
| `AIT_SOCKET` | `ait` | `ait` = separate tmux server; `default` = your normal tmux server |
| `AIT_NOTIFY_IDLE` | off | `1` = also give a quiet alert when a session goes idle |
| `AIT_NOTIFY_PATH` | off | `1` = include the folder in desktop notifications (default shows name only) |
| `AIT_DESKTOP` | on | `0` = bell only, no desktop notifications |
| `AIT_RETURN_KEY` | `Tab` | Key (after the prefix) that returns to the dashboard |
| `AIT_API_TOKEN` | none | Bearer token for the HTTP API |
| `PORT` | `3000` | HTTP API port |
| `AIT_DEBUG` | off | `1` = show technical error details |
| `NO_COLOR` | unset | Any value = no colours (state labels still shown) |

The display switches to plain ASCII symbols when your locale is not UTF-8 (for example `LANG=C`).

**What is stored** (in `AIT_HOME`, folder private to you): session names, folders, git branch, extra Claude arguments, ids, exit codes, the last hook event per session, per-session hook settings, an audit log, a hook error log, and a lock file. Screen text is read in memory only in fallback mode and never saved. `ait` itself sends nothing over the network (the optional HTTP API only answers requests). It does not change your global Claude or tmux settings.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "AI tmux needs tmux 3.2 or newer…" (exit 10) | tmux missing or too old | `brew install tmux` or your package manager; check with `tmux -V` |
| "The tmux socket folder is not private" | `/tmp/tmux-<your id>` is readable by others | `chmod 700 /tmp/tmux-$(id -u)`, then retry |
| "Couldn't start Claude Code: `claude` isn't on your PATH." (exit 6) | `claude` not found, or it sits in a world-writable folder | Install Claude Code or fix PATH; run `ait doctor` |
| "That folder doesn't exist." (4) / "That path is a file" (5) | Bad directory | Check the path |
| "A session called X already exists." (3) | Name in use | Pick another name |
| "Use letters, numbers, - and _ only." (2) | Invalid name | Use `a-z 0-9 - _`, max 24 characters |
| "This folder has project hooks…" | The project has its own Claude hooks | Confirm with `y`, or `--yes`, only if you trust the project |
| Header shows `[stale]` / "Can't reach tmux…" | tmux server not answering | Wait a few seconds; check `tmux -L ait ls`. Sessions may still be running |
| "State detection: fallback mode" | No hook events arrived within 10 s | Run `ait doctor`; update Claude Code if `--settings` is unsupported; relaunch the session |
| State shows UNKNOWN | Fallback detection could not match the screen | Prefer hook mode (see above) |
| Row stays WAITING after you approved a prompt | Known limitation: no hook marks the end of a tool call | It clears when the turn finishes |
| Waiting but no sound | Bell not reaching your terminal | Check your terminal's bell setting and Do Not Disturb; over SSH only the bell is available |
| "A dashboard is already running." | Another `ait` dashboard is open | Run `ait` to attach to it |
| "Terminal too small. Need at least 60×15." | Window too small | Enlarge it, or use `ait ls` |
| Session shown as DONE with "(gone)" | The tmux session was closed outside `ait` | `ait rm <name>`, then relaunch |
| Registry banner: "session registry was unreadable" | Damaged `registry.json` | A backup was saved as `registry.json.bak`; check it and copy it back if valid. Running sessions will be untracked until restored |
| API returns 403 | No token set and request not from this machine | Set `AIT_API_TOKEN` and send the Bearer header |
| API returns 503 with error 10 | tmux missing where the API runs | Install tmux there |
| After a reboot, sessions are gone | tmux does not survive reboots | `ait rm <name>`, then `ait new <name> <dir> -- --resume` (resume flag passed to Claude) |

---

## 7. FAQ

**Does closing the dashboard stop my sessions?** No. Only `kill` or `purge` stops them.

**Can I use it with sessions I started before?** No. Only sessions launched through `ait` are tracked.

**Why don't I see these sessions in `tmux ls`?** They live on a separate tmux server. Use `tmux -L ait ls`, or set `AIT_SOCKET=default` to share your normal server.

**Will it answer prompts for me?** No. `ait` never types into a session.

**What's the difference between WAITING and IDLE?** WAITING means Claude is blocked on a permission prompt or question. IDLE means a turn finished and Claude is ready for a new prompt.

**My tmux prefix isn't `Ctrl-b`.** `ait` reads your prefix from tmux; the help overlay and status bar use it. The return key is the prefix followed by `Tab` unless you change `AIT_RETURN_KEY`.

**Does it change my Claude or tmux settings?** No. Hooks are supplied per session with `claude --settings <file>`. The return key is bound only on the `ait` tmux server (on the default server it will not overwrite a key you already use).

**How do I get alerts for idle sessions?** Set `AIT_NOTIFY_IDLE=1`.

**How do I remove all traces?** `ait purge`, then `npm unlink -g ait` if you want the command gone.

**Is the HTTP API required?** No. It is optional. Skip it unless you need scripting, and protect it with a strong token.
