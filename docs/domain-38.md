# Domain Review: WO-C2E5A3 "AI tmux"

## Assumptions
- Domain: terminal multiplexing (tmux) and Claude Code CLI session management.
- Claude Code behaviours below (hooks, permission prompts, session resume) reflect my understanding of its documented features. The Architect should verify them against the installed version during the gating spike.

## Key terms (exact meanings)

| Term | Exact meaning in this domain |
|---|---|
| tmux session / window / pane | Hierarchy: server → session → window → pane. A "Claude session" maps to one tmux session (UX choice), but is **not** the same thing as a Claude Code conversation session. |
| Claude Code session | A conversation with its own ID and transcript, resumable (`--resume`, `--continue`). It can outlive the tmux session. |
| Attach / detach | Attaching connects a client to a session; detaching leaves it running. "Return to dashboard" must be a client switch, not a detach. |
| Waiting for input | Ambiguous in Claude Code. It covers (a) a permission prompt for a tool call, (b) a question to the user, and (c) the idle prompt after a turn is finished. These are different states. |
| Hook | A Claude Code configured command that runs on events (Notification, Stop, SessionStart, etc.). |

## DOMAIN-REQ items

**DOMAIN-REQ-1: Split "waiting" into two meanings.**
"Needs your decision" (permission prompt or question) is different from "turn finished, idle at prompt". The spec's three states (running / waiting / idle) are right, but the definitions must be written down. Recommended: *waiting* = blocked on a permission prompt or question; *idle* = turn complete, ready for a new prompt. Both deserve a notification, but only *waiting* should be urgent. The Developer must not notify on every idle.

**DOMAIN-REQ-2: Hooks are the primary detection source.**
Use Claude Code hooks (Notification for permission and idle prompts, Stop for turn end, UserPromptSubmit/SessionStart for running) to write state into a per-session file or socket. Screen scraping is a fallback only and must be marked "degraded" in the UI, as already specified. Hook configuration must be injected per launch (for example via a settings file or flag) rather than by silently editing the user's global settings. If global edits are unavoidable, they must be explicit, reversible, and merged with the user's existing hooks, never overwritten.

**DOMAIN-REQ-3: Map hook events to sessions with a stable key.**
Hooks fire inside the Claude process, so the hook script needs to know which managed session it belongs to. Pass the session name through an environment variable set at launch (for example `AIT_SESSION`), and don't infer it from the working directory. Two sessions in the same directory are common (parallel work on one repo) and must not collide.

**DOMAIN-REQ-4: Same directory, several sessions.**
The spec treats "project" as the directory. Domain reality: users run multiple sessions in the same repo, often in different git worktrees. Names must be unique, the project column must not be assumed unique, and the display should show the git branch or worktree name when available. Do not key anything on the path.

**DOMAIN-REQ-5: Tmux session naming constraints.**
tmux disallows `.` and `:` in session names (they are target separators) and mangles them. The UX name rule (`a-z 0-9 - _`, prefix `ait-`) is compatible. Targets should be addressed with the `=` exact-match prefix (`-t =ait-name`) so a name like `api` doesn't prefix-match `api-refactor`.

**DOMAIN-REQ-6: Launch must not be shell-string concatenation.**
Directories with spaces, quotes, or `$` are common on macOS (for example `~/My Projects`). Pass the working directory with `new-session -c <dir>` and the command as separate arguments. Expand `~` before use. Resolve symlinks for display only.

**DOMAIN-REQ-7: Process exit does not equal Claude finished.**
When the `claude` process exits, tmux destroys the session by default, so "DONE" rows would vanish and the user would lose the scrollback and exit message. To show DONE, either set `remain-on-exit` for managed sessions or keep a registry of launched sessions. Decide this explicitly. Also distinguish a clean exit (user typed `/exit`) from a crash (non-zero exit status) and show the exit code.

**DOMAIN-REQ-8: Resume is the natural recovery path.**
After a reboot or crash, tmux sessions are gone but Claude conversations are resumable. Out of scope for the first release, but the registry should store the working directory and, if obtainable, the Claude session ID so that "resume" can be added without redesign. Flag as a likely first follow-up.

**DOMAIN-REQ-9: "Return to dashboard" must be a switch, not a new attach.**
Inside tmux, nested attach causes the "sessions should be nested with care" error. Use `switch-client` when the user is already in tmux, and `attach-session` only from outside. Bind the return key through `bind-key` in the root or prefix table for managed sessions only, not as a global change to the user's tmux config. Note that `Ctrl-b Tab` may already be bound for some users, and the prefix may not be `Ctrl-b` (many remap to `Ctrl-a`). Derive the prefix from `tmux show -g prefix` in all help text instead of hardcoding it.

**DOMAIN-REQ-10: Dedicated tmux server option.**
Decide whether to use the user's default tmux server or a separate socket (`tmux -L ait`). A separate socket isolates the manager from the user's own tmux config and sessions (a strong domain argument for it), but then the user's `~/.tmux.conf` doesn't apply, and they cannot see these sessions from their normal tmux. Recommended: a separate socket by default, plus a documented option to use the default server. List only the manager's sessions either way.

**DOMAIN-REQ-11: Claude Code is a full-screen TUI.**
Output patterns are fragile because Claude's UI redraws and wording changes between versions, so the fallback must be version-tolerant and its accuracy claims must be conservative. Also, `capture-pane` returns rendered text, not a log, so detect from the last N lines only. Never scan scrollback for historical prompts.

**DOMAIN-REQ-12: Notifications on macOS and Linux.**
macOS: `osascript` / `terminal-notifier`; Linux: `notify-send`. Notification text includes the user's session name and directory, so escape quotes when building the AppleScript string (injection risk with names or paths). Respect Do Not Disturb silently. Over SSH or headless there is no desktop, so fall back to bell only. A bell fires only in the terminal that has focus, and tmux's `bell-action` and `monitor-bell` settings affect it, so verify the bell actually reaches the user's terminal.

**DOMAIN-REQ-13: Suppress notifications for the attached session.**
The UX spec already says this. The domain meaning: "attached" means a client is currently displaying that session (`#{session_attached}` and client's current session), not merely that the session exists. Several clients may be attached.

**DOMAIN-REQ-14: Kill semantics.**
Killing a tmux session sends SIGHUP to Claude. Claude may be mid-edit of files, leaving half-applied changes. The confirm dialog should say "stops Claude immediately; files it was editing may be partly changed" rather than only "unsaved work lost". Consider offering to send `Ctrl-c` / `/exit` first as the gentle option.

**DOMAIN-REQ-15: Never type into sessions.**
The dashboard must not use `send-keys` to answer prompts (auto-answering is out of scope, and a mis-targeted keystroke could approve a destructive tool call). Treat `send-keys` as forbidden in v1.

**DOMAIN-REQ-16: Contradiction to resolve: 1-9 hotkeys vs. "8 sessions".**
The persona runs 3-8 sessions, but the numbered key scheme covers only 9, and numbers shift as sessions are sorted by state. Pressing `3` when the list reorders between glance and keypress could open the wrong session, and that is a real danger when one of them is a destructive task. Domain recommendation: number by stable creation order, not by state-sorted position, or require the number key to match the row currently shown and keep order stable (the UX spec's "stable except on state change" is not sufficient, since state change is exactly when users act).

**DOMAIN-REQ-17: Contradiction to resolve: 95% accuracy target.**
"95% of 20 transitions" allows one miss. In this domain, a missed *waiting* is the costly error (a blocked session unnoticed), while a false *waiting* is cheap. Define the accuracy target separately: recall of waiting transitions should be 100% in the manual test, and false positives are tolerated at a higher rate.

**DOMAIN-REQ-18: Flicker debounce conflicts with latency.**
A 500ms hold before display plus 2s update limit is fine, but permission prompts can resolve in under a second when the user answers inside an attached session. Don't fire a notification for a waiting state that clears within the debounce window.

**DOMAIN-REQ-19: Edge cases the Developer must handle.**
- tmux server not running (no sessions yet) is the normal first-run state, not an error.
- tmux version differences: pin a minimum (3.x) and check at startup; `display-popup`, format strings and `switch-client -l` differ.
- Session killed externally via `tmux kill-session` or the user closing a terminal: show "no longer running", not a crash.
- Stale state files from dead sessions: clean up on startup and ignore files whose session no longer exists.
- Clock jumps and laptop sleep: "Since" should use monotonic or recorded timestamps and not display negative or huge values after resume.
- Claude Code launched with extra flags (for example `--model`, `--dangerously-skip-permissions`) is common; the launch command should allow optional extra args, or at least not preclude them.
- `claude` on PATH may differ inside tmux (a non-login shell). Resolve the absolute path at launch and pass the environment through.
- Locale and Unicode width: the ASCII fallback should also trigger on `LANG=C`.

**DOMAIN-REQ-20: Kill-or-shrink check is domain-valid.**
Plain tmux (`monitor-activity`, `monitor-bell`, a status-line format reading hook-written files, `choose-tree -s`) can plausibly cover most of the value. Hook-based state writes plus a tmux status segment plus `choose-tree` is a legitimate "build less" outcome. Keep the check as a hard gate and record the result.

## Requirements flagged as contradicting domain practice
1. **DONE state vs. default tmux behaviour** (REQ-7): impossible without `remain-on-exit` or a registry.
2. **Number hotkeys on a reordering list** (REQ-16): unsafe.
3. **Single 95% accuracy figure** (REQ-17): wrong metric for an asymmetric-cost error.
4. **Hardcoded `Ctrl-b Tab`** (REQ-9): the prefix is user-configurable and may collide.
5. **"Idle" vs "waiting"** (REQ-1): the spec's states are undefined against Claude's real prompt types.

## Handoff
The Architect should settle REQ-1, 7, 10 and 16 first, since they change the data model (state definitions, registry, socket choice, numbering). The Developer must honour REQ-2, 3, 6, 9, 12 and 15 as hard constraints.
