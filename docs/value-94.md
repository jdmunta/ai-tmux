# Value Strategy: WO-C2E5A3 "AI tmux"

## Business outcome
A developer running several Claude Code sessions in parallel can see, switch between, and respond to all of them from one place, so no session sits blocked waiting for input unnoticed and no time is lost hunting through terminal windows.

**For whom:** a solo power user (the requester) running 3+ concurrent Claude Code sessions across projects.

## Three value drivers and indicators

| # | Value driver | Indicator |
|---|---|---|
| 1 | **Less idle wait time**: sessions needing input get noticed fast | Median time from "session needs input" to user response; target under 30s (baseline: measure today) |
| 2 | **Less context-switch cost**: one-step jump to any session | Time to reach a given session; target under 3s, one keystroke or fewer than 3 actions |
| 3 | **Situational awareness**: know the state of all sessions at a glance | Share of sessions whose state (running / waiting / idle / done) is correctly shown; target 95%+ |

## Eliminate, keep manual, or defer

**Eliminate (does not move a driver):**
- Re-implementing a terminal emulator or multiplexer: reuse tmux or existing PTY handling.
- Custom theming, layouts, split-pane editors, plugin system.
- Remote or multi-user sharing.

**Keep manual:**
- Creating sessions and choosing their working directories (the user can launch with a simple command).
- Session cleanup and archiving.

**Defer:**
- Session history search and transcripts.
- Cost/token dashboards.
- Auto-answering or orchestrating agents.
- Cross-machine sync and mobile notifications.
- A GUI; stay in the terminal.

## Smallest delivery that proves value
A single terminal dashboard (thin layer over tmux) that:
1. Lists all running Claude Code sessions with name, project, and state (running / waiting for input / idle).
2. Highlights sessions that need input and flags them with a desktop or bell notification.
3. Jumps into a chosen session with one keystroke and returns to the list.

Roughly one working week of effort, matching size M. Success: the requester uses it for their real parallel work for one week and the indicators above beat baseline.

## Assumptions to test first
1. **State detection is feasible:** "waiting for input" can be reliably inferred (Claude Code hooks, or terminal output patterns) without fragile screen-scraping. *Test first; it is the main technical risk and underpins drivers 1 and 3.*
2. **The user's pain is waiting and switching, not seeing output:** confirm via a quick baseline of how often sessions sit blocked.
3. **Plain tmux plus a status line is not already enough:** try a tmux config with window naming and activity alerts for a day; if it satisfies the drivers, build less.
4. **Sessions can be managed under tmux:** the user is willing to launch Claude Code inside the manager rather than from arbitrary terminals.
5. **One user, one machine** is sufficient for the first release.

## Handoff to Product Manager
Scope the first release around the three-step delivery above. Treat assumption 1 as a gating spike, and assumption 3 as a kill-or-shrink check before any build starts.
