# Spec: WO-C2E5A3 "AI tmux"

## Goal
Give a developer running several Claude Code sessions in parallel a single terminal dashboard, built as a thin layer over tmux, to see every session's state, be alerted when one needs input, and jump into any session in one keystroke.

## In scope
- Dashboard listing all Claude Code sessions launched under the manager: name, project, state (running / waiting for input / idle).
- Detection of the "waiting for input" state, preferably via Claude Code hooks, with output-pattern matching as a fallback.
- Alerts (terminal bell and/or desktop notification) when a session transitions to waiting.
- One-keystroke jump into a session and a one-keystroke return to the dashboard.
- A simple command to launch a new Claude Code session inside the manager, with a name and working directory.
- Single user, single machine.

## Out of scope
- Building a terminal emulator or multiplexer (reuse tmux).
- Theming, custom layouts, split-pane editors, plugin system.
- Remote/multi-user sharing, cross-machine sync, mobile notifications.
- Session history search, transcripts, cost/token dashboards.
- Auto-answering or orchestrating agents.
- GUI.
- Automated cleanup/archiving of sessions.

## User stories
1. As a developer, I want to launch a Claude Code session with a name and directory inside the manager, so that it is tracked from the start.
2. As a developer, I want to see all sessions with their project and state at a glance, so that I know what needs attention.
3. As a developer, I want to be notified when a session is waiting for my input, so that it doesn't sit blocked unnoticed.
4. As a developer, I want to jump into a session with one keystroke and return to the list with one keystroke, so that switching costs almost nothing.
5. As a developer, I want the dashboard to reflect state changes without manual refresh, so that I can trust it.
6. As a developer, I want sessions to survive closing the dashboard, so that work is not lost.

## Acceptance criteria
- [ ] A launch command starts Claude Code in a new tmux session with a given name and working directory, and it appears in the dashboard within 2s.
- [ ] The dashboard lists every managed session with name, project (directory), and state.
- [ ] State is one of running / waiting for input / idle, and updates automatically within 2s of a change.
- [ ] Waiting sessions are visually highlighted and sorted or marked distinctly.
- [ ] On transition to waiting, a bell or desktop notification fires once per transition (no repeat spam).
- [ ] Selecting a session (single key or number) attaches to it in under 3s; a documented key returns to the dashboard without terminating the session.
- [ ] Closing or detaching the dashboard leaves all sessions running.
- [ ] Sessions that exit are shown as done or removed from the list, without crashing the dashboard.
- [ ] State detection is correct in at least 95% of transitions in a manual test of 20 transitions across 3+ concurrent sessions.
- [ ] No custom terminal emulation; tmux is used for session/PTY handling.
- [ ] Setup and usage are documented in a short README.

## Gating checks (before build)
- [ ] Spike: confirm "waiting for input" can be detected reliably via hooks or output patterns.
- [ ] Kill-or-shrink check: try plain tmux with window naming and activity/bell alerts for a day; if it meets the goals, reduce scope accordingly.

## Assumptions
- tmux is installed and acceptable as a dependency; the user launches Claude Code through the manager rather than from arbitrary terminals.
- Single user, single machine; macOS/Linux terminal environment.
- Claude Code hooks (or equivalent) can expose input-needed events; if not, output-pattern matching is accepted as a less precise fallback.
- Implementation language and exact keybindings are left to the architect.
- Size M (~1 week) is sufficient for the three-step minimum delivery above.
- Success is judged by the requester using it for real parallel work for a week and beating baseline on idle wait time, switch time, and state accuracy.
