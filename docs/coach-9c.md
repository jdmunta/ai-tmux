# Outcome Coach Brief: WO-C2E5A3 "AI tmux"

*Assumption: you are the requester, a solo power user running 3–8 Claude Code sessions. I'm judging this against the outcome you were promised, not the volume of work done.*

## 1. Promised vs. delivered

**Promised:** see all your Claude sessions in one place, never leave one blocked unnoticed, and reach any session in one keystroke.

**Delivered:** a large, carefully built terminal tool (dashboard, alerts, one-key jump, stable session numbers, safe launch and kill) plus an HTTP API you did not ask for.

**But it is not yet proven, and it is not releasable:**
- The automated tests ran 170 of 171 passing. Nobody has named the failing one.
- The core promise (never miss a blocked session) is not met. After you approve a permission prompt, the row keeps saying "waiting" until the turn ends. You would stop trusting it.
- Three checks the plan said must come *before* building were never done: your baseline of how often sessions sit blocked, the "is plain tmux enough?" test, and the check that Claude Code's hooks actually report what we need. The README still says "record here."
- Reviewers for security, QA, code, compliance and responsible AI returned fail or changes-requested. Only the accessibility and AI-evaluation reviews passed with conditions.

## 2. Key trade-offs made

- **Hooks over screen-reading** for detecting "waiting": more accurate and harder to spoof, but it depends on Claude Code behaving as assumed (unverified).
- **Separate tmux server:** protects your own tmux setup, but these sessions won't appear in your normal `tmux ls`.
- **Only sessions launched through `ait` are tracked:** simple and safe, but your existing sessions are not adopted.
- **Err toward false "waiting" alerts** rather than missed ones: a few extra pings in exchange for never missing a blocked session.
- **Never types into sessions:** safest, but there's no "gentle stop" and no auto-answering.
- **The HTTP API (unrequested)** adds scripting convenience but is the single biggest risk.

## 3. Open risks and owners

| Risk | Owner |
|---|---|
| HTTP API: any web page you visit could start Claude sessions on your machine, because it listens on all interfaces and trusts local callers. Critical. | Developer |
| Row stuck on "waiting" after approval | Developer |
| Failing test unnamed, so security tests unconfirmed | Developer/QA |
| Claude Code hook behaviour and `--settings` support unverified | You (run the spike) |
| Bell may not reach you while you're in another session | You/QA |
| Dangerous Claude flags and oversized project hook files bypass confirmations | Developer |
| Terminal alerts lack a text-only cue (accessibility) | Developer |

## 4. What you need to decide

**Decision: keep the HTTP API or cut it?**

**Recommendation: cut it (or ship it off by default, loopback-only, with a mandatory generated token).** You asked for a terminal manager. The API adds the only critical vulnerability, and removing it clears the main blockers and shrinks the review surface. Keep the CLI and dashboard.

Second decision: if the kill-or-shrink test shows plain tmux plus a status line meets your needs, **stop and build the smaller version.** The hook script and state logic are reusable either way.

## 5. Three next steps

1. **Do the three gates first (about two days):** log your baseline of blocked time, try plain tmux with activity alerts for a day, and run the hook spike on your installed Claude Code. Record results in the README.
2. **Fix the blockers:** name and fix the failing test without weakening it; add tool-start/tool-finished hooks so "waiting" clears after approval; remove the API or lock it to loopback with a required token, Host/Origin/Content-Type checks, and fail-closed project-hook detection.
3. **Prove it on real work:** run the 20-transition test (100% of waiting transitions caught, including bell delivery while in another session), then spend a week using it. Judge by your own numbers: respond under 30 seconds, reach a session in under 3.
