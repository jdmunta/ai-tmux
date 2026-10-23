# Deployment and Adoption Plan: WO-C2E5A3 "AI tmux" (`ait`)

## Assumptions
- Customer = the requester, a solo power user on one macOS or Linux machine, 3-8 concurrent Claude Code sessions, keyboard-first.
- No server, no shared data, no IT department. "Integration" means the user's local tools: tmux, Claude Code, the shell, the OS notification system.
- Node 22 and tmux ≥ 3.0 are installable by the user.
- Smallest integration that works: hooks writing event files, read by the dashboard.

## 1. Integration points

| # | Integrates with | What | How | Owner |
|---|---|---|---|---|
| 1 | **Claude Code hooks** | Events: SessionStart, UserPromptSubmit, Notification, Stop | Per-launch `--settings <file>` calling `ait hook <event>`; `AIT_SESSION` env var identifies the session. No global edits. | Us (hook script); Claude Code version is the user's |
| 2 | **Claude CLI binary** | Launch `claude` with args | Resolve absolute path at launch; pass environment through; allow extra args after `--` | User (installation) |
| 3 | **tmux** | Sessions, `remain-on-exit`, `switch-client`, status line, return-key bind | `execFile` only, dedicated socket `-L ait` by default | Us (usage); user (install) |
| 4 | **OS notifications** | Desktop notice on waiting | `osascript` (macOS) / `notify-send` (Linux), bell as fallback; escape names | Us; OS settings (Do Not Disturb) belong to the user |
| 5 | **Local state** | `registry.json`, `events/`, `settings/` under `~/.local/state/ait` | Atomic writes, 0600 permissions | Us |
| 6 | **User's shell/terminal** | `ait` on PATH; bell reaching the terminal | `npm link` or a PATH symlink; check bell settings in the terminal app | User |
| 7 | **Git (read-only)** | Branch/worktree display | `git rev-parse` at launch, display only | Us |

**Not integrated in v1:** user's `~/.tmux.conf`, global Claude settings, existing tmux sessions, remote machines, CI, cloud anything.

**Data note:** nothing leaves the machine. Event files contain only session name, event type, timestamp, and Claude session ID.

## 2. Pilot and rollout plan (small steps)

| Step | Duration | Activity | Exit criterion |
|---|---|---|---|
| 0. Baseline | 1 day | Record, by hand, how often sessions sat blocked and how long (a short log or timer notes) | Baseline numbers for idle wait and switch time |
| 1. Kill-or-shrink | 1 day | Plain tmux with `monitor-activity`, `monitor-bell`, window names, `choose-tree -s` | Written verdict: sufficient / shrink / build |
| 2. Hook spike | 0.5-1 day | In a scratch dir, confirm the installed Claude Code supports `--settings`, hooks fire, and Notification payloads distinguish permission from idle | Result recorded in README; fallback chosen if hooks unavailable |
| 3. Walking skeleton | 2 days | `ait new`, `ait ls`, hook writes, state resolution, no TUI yet | 3 sessions shown with correct states via `ait ls` |
| 4. Dashboard + alerts | 2 days | TUI, bell/desktop notify, switch and return key | Meets spec acceptance criteria |
| 5. Dogfood week | 5 working days | Run all real parallel work through `ait`; keep the original terminals available as a fallback | Indicators beat baseline; 20-transition test: 100% waiting recall, ≥95% overall |
| 6. Decide | 0.5 day | Keep / tune / cut; list first follow-ups (resume after reboot is the likely one) | Decision recorded |

**Rollback is trivial:** quit the dashboard, `tmux -L ait kill-server`, delete `~/.local/state/ait`. Nothing global was modified.

## 3. Per-customer configuration

| Setting | Default | Why it varies |
|---|---|---|
| `AIT_HOME` | `~/.local/state/ait` | Preference |
| `AIT_SOCKET` | `ait` (separate server); `default` to share the user's tmux | Does the user want to see these in their normal tmux? |
| tmux prefix | Read from `tmux show -g prefix` | Many remap to `Ctrl-a` |
| Return key | `<prefix> Tab` | May collide with the user's binding |
| `notifyIdle` | false | Does the user want a quiet bell on idle? |
| Desktop notifications | on if available | SSH/headless, Do Not Disturb |
| Extra Claude args | none | e.g. `--model`, permission flags |
| ASCII/no-color | Auto-detected | `LANG=C`, `NO_COLOR` |
| Absolute `claude` path | Resolved by `ait doctor` | PATH differs inside tmux |

`ait doctor` is the single setup check: tmux version, claude path, hook support, prefix, bell, notification command.

## 4. Adoption risks and mitigations

| Risk | Type | Mitigation |
|---|---|---|
| Must launch sessions through `ait new`; habit of opening `claude` in any terminal bypasses tracking | Workflow change | Shell alias (e.g. `cc` → `ait new`), empty-state hint, `ait ls` showing only managed sessions explicitly |
| Existing running sessions are not adopted | Workflow change | State this in README; migrate at natural session boundaries, and don't try to adopt processes in v1 |
| Separate tmux socket hides sessions from normal `tmux ls` and ignores `~/.tmux.conf` | Surprise | Document at first run; offer `AIT_SOCKET=default`; `ait doctor` prints the socket |
| Wrong state shown erodes trust, and the user reverts to scanning terminals | Trust | Show degraded/unknown explicitly; prefer false waiting over missed waiting; keep a visible "fallback mode" marker |
| Notification fatigue (too many bells) | Resistance | Waiting-only by default, once per transition, burst coalescing, no notify for the attached session |
| Fear of an accidental kill | Safety | Confirm dialog defaulting to keep, wording about partly applied file edits; `send-keys` never used |
| tmux prefix collisions or muscle-memory conflicts | Training | Derived prefix in help text, configurable return key, `?` overlay |
| Claude Code update changes hook or prompt behaviour | Maintenance | `ait doctor` version check; automatic fallback when hooks go silent within 10s; spike results in README |
| tmux unfamiliarity (detach vs. switch, scrollback copy mode) | Training | A 10-line README "cheat sheet": return key, scrollback, detach |
| Reboot loses sessions | Expectation | State clearly in README that Claude conversations are resumable manually; registry keeps dir and Claude session ID for the likely follow-up |

## 5. Questions to ask on site

**Current workflow**
1. How many sessions do you run at once on a typical day, and how many in the same repo or worktree?
2. Where do you run them today: terminal tabs, iTerm panes, VS Code, existing tmux? Which terminal app?
3. When did a session last sit blocked unnoticed, and for how long? How do you find out today?

**tmux and environment**
4. Do you already use tmux? Which prefix, and what is in `~/.tmux.conf` we should avoid colliding with?
5. Is a separate tmux server acceptable, or must these sessions appear in your normal tmux?
6. Which OS and tmux/Node versions, and is Claude Code installed via npm, Homebrew, or the native installer?
7. Do you ever run Claude Code over SSH or on a remote host?

**Claude usage**
8. Which flags do you use (`--model`, permission-skipping, resume/continue)? Any project-level `.claude/settings.json` hooks that might interact with ours?
9. Does it matter more to be told about permission prompts, questions, or finished turns?

**Notifications**
10. Bell, desktop notification, or both? Do you use Do Not Disturb or Focus modes during work?
11. Is the terminal usually in front of you, or in the background behind an editor?

**Acceptance and safety**
12. Is a missed "waiting" worse for you than an occasional false one? (Our design assumes yes.)
13. What would make you stop using it after day two?
14. Would you want reboot recovery (resume) before any other follow-up?
15. Can we have one week of your real work as the pilot, and are you willing to log baseline numbers first?

## 6. Handoff notes
- **Gates first:** the baseline, kill-or-shrink verdict, and hook spike decide whether the full TUI is built at all. A "hook + status segment + `choose-tree`" outcome is a legitimate, cheaper result and reuses `hook`, `state.js`, and `tmux.js`.
- **Open items for the customer:** socket choice, return key, `notifyIdle`, and whether existing sessions need adopting.
- **Success definition for the pilot:** median time from needs-input to response under 30s, session reach under 3s, 100% waiting recall in the 20-transition test, and the user still choosing `ait` at the end of week one.
