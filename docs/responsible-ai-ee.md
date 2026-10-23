# Responsible AI Review: WO-C2E5A3 "AI tmux" (`ait`)

## Scope and assumptions
- `ait` contains no model and makes no automated decisions about people. It supervises Claude Code agent sessions for one user on one machine.
- The responsible-AI surface is therefore: (a) a classifier that infers agent state and drives alerts, (b) a control surface sitting next to agents that can run code with the user's authority, (c) transparency about what is inferred versus known, and (d) accountability logging.
- Fairness and bias in the demographic sense do not apply: there are no people-scoring features, no profiles, and a single user. I note the one analogue (fallback detection tuned to English prompt wording) below.
- This is a static review of the supplied documents and code. I ran nothing. The build shows 170 of 171 tests passing with the failure unnamed.

## Findings

1. **High: the HTTP API lets a third party start AI agents with the user's authority (misuse and abuse).**
   - `src/server.js` binds to `0.0.0.0`, trusts any loopback caller when no token is set, and checks neither `Content-Type`, `Origin` nor `Host`. A web page can therefore launch Claude sessions with chosen `dir` and `args` (for example `--dangerously-skip-permissions`) without the user knowing. This is the largest misuse risk: autonomous agent execution with no human decision.
   - It was added after the threat model and PIA, which assumed no listener. The README claim "nothing is transmitted" is no longer reliable.
   - Mitigation: default to `127.0.0.1`. Require `Content-Type: application/json`, validate `Host` and `Origin`, and always require a generated random token (0600). Add tests for each rejection. Ship the API off unless `ait serve` is run deliberately. Update the threat model, PIA and README.

2. **High: human oversight can be bypassed through dangerous launch flags.**
   - `launchSession` accepts any Claude args. Permission-skipping flags, a user-supplied `--settings` that overrides the injected hooks, and `--mcp-config` all pass unchecked. The permission prompt is the main human-in-the-loop control for agent actions, and the tool can remove it silently, including through the API.
   - Mitigation: reject user-supplied `--settings`. Require explicit confirmation (`--yes` on the CLI, `confirmDangerousArgs: true` on the API, a dialog in the TUI) for permission-bypass flags. Show an unmistakable `NO-PERMISSION-PROMPTS` marker on any such session's row.

3. **High: the dashboard can show a false "not waiting" state, undermining oversight (transparency and accuracy).**
   - After a permission prompt is approved, no hook fires until `Stop`, so the row can show a stale state (QA D2). Detection errors also run the other way: a missed `waiting` leaves an agent blocked unnoticed, and a spoofed or stale `idle` can hide a pending approval.
   - Because the user relies on this view to decide when to review an agent, an inaccurate state weakens oversight.
   - Mitigation: map `PreToolUse` and `PostToolUse` to `running` and extend the tests. Keep the target of 100% waiting recall. Show event age so a silent hook is visible.

4. **Medium: the project-hooks confirmation fails open (human oversight).**
   - `detectProjectHooks` skips settings files over 1 MiB and ignores unparseable ones, so a hostile repo can pad its file and avoid the warning. This is the main path by which untrusted content gains execution under the user's authority.
   - Mitigation: fail closed. Treat oversize, unreadable or invalid settings as "has hooks" and require confirmation. Name what will run in the confirmation text.

5. **Medium: state inference is not clearly presented as inference (transparency).**
   - Fallback detection is labelled "degraded" in a header line, but the per-row cue is weak, and the `unknown` state is shown only when detection fails. The README's "Known limitation" about stale waiting is not visible in the UI.
   - Mitigation: mark every fallback-derived row with a visible `(fallback)` tag, show "last hook event Ns ago", and state in `?` help that states are inferred. Also resolve QA D6: `doctor` returns hardcoded `notificationKindsDistinguished: false` and similar values, so the transparency report is itself unreliable.

6. **Medium: no accessible text alert for state changes (equitable access to oversight).**
   - Alerts rely on a bell and a desktop notice. A user who cannot hear the bell or see the notice, or who uses a screen reader, has no reliable cue that an agent needs approval (Accessibility A1, A10). Unequal access to the review prompt means unequal oversight.
   - Mitigation: add a persistent text line such as `api-refactor is now WAITING`, a visual-only mode, and an option to turn the bell off. Keep the other accessibility conditions open.

7. **Medium: secrets leak into agent-readable environments (misuse).**
   - The tmux server and Claude inherit the environment of the first `ait` process, including `AIT_API_TOKEN` and shell API keys. A prompt-injected agent can read and exfiltrate them.
   - Mitigation: start tmux sessions with an explicit minimal environment and strip `AIT_API_TOKEN`.

8. **Medium: the kill action can leave an agent's work half-applied, and the HTTP/CLI paths are less guarded than the TUI (human oversight and appeal).**
   - The dashboard defaults to "keep" and warns about partly applied edits. The CLI and API resolve by name only, and the API needs only `confirm=true` as a query parameter, which a forged request can supply. There is no undo or recovery path.
   - Mitigation: use id plus name in every path. Offer the gentle stop (`/exit`) as an option once the `send-keys` prohibition is explicitly revisited by the owner. Until then, document that kill is irreversible.

9. **Low: accountability logging is incomplete.**
   - `audit.log` records only successes. Denied or failed requests, such as a bad token or forbidden origin, leave no trace, and API calls carry no caller attribution. Nobody can later establish which actor launched an agent or why a request was refused.
   - Mitigation: log `denied` and `error` results with route and remote address. Record the launch args (flagging dangerous ones) in the audit entry. Keep log rotation and `--purge-log`.

10. **Low: the fallback detector is English-only and wording-dependent (fairness analogue).**
    - Patterns match English prompt text, so users running Claude Code in another locale or UI wording get `unknown` or missed waiting more often. This is a reliability gap that falls unevenly across users.
    - Mitigation: state the limitation in the README, prefer hooks, and include non-English or changed-wording cases in the golden set. The ambiguity bias toward `waiting` is a sound design choice and should stay.

11. **Low: the spoofing and injection controls are good but need confirmed tests.**
    - Forged events are dropped (future `ts`, unknown session, earlier than `createdAt`), `send-keys` is forbidden and test-enforced, and escape sequences are stripped. The failing unit test is unnamed, so I cannot confirm these suites are green. Bidi and format characters are not stripped (SR-09), so names can be visually spoofed.
    - Mitigation: name and fix the failing test without weakening assertions, and extend `sanitize()` to strip `\p{Cf}` and line separators.

12. **Low: gate evidence for the success claims is missing.**
    - The baseline, kill-or-shrink verdict and hook spike are unrecorded, and bell delivery is unverified. Without these, the claim that the tool improves oversight is unproven.
    - Mitigation: record the results in the README, run the 20-transition test at 100% waiting recall, and verify bell delivery while attached to another session.

## Positive observations
- No `send-keys`, `paste-buffer`, `run-shell` or `pipe-pane`; the tool never answers or approves agent prompts, and a test enforces it.
- Alerts are biased toward false `waiting` over missed `waiting`.
- Kill defaults to "keep", with wording about partial edits.
- State is stored locally, with no telemetry, minimal data, export and purge paths, and notifications that show the name only by default.
- Rollback is simple and global config is untouched.

## Verdict

The local tool is respectful of human oversight by design, but the HTTP API (Findings 1 and 2) allows unattended, unauthorised agent launches with permission prompts removed, the state view has a known inaccuracy (Finding 3), and the build is not green.

Verdict: FAIL

Conditions to reach PASS WITH CONDITIONS: fix Findings 1 and 2 (loopback bind, Content-Type/Host/Origin checks, mandatory generated token, confirmation for dangerous flags); fix Finding 3 (tool-finished hooks); name and fix the failing test; fail closed on project hooks (Finding 4); then update the threat model, PIA and README for the HTTP surface. Findings 5 to 12 should be fixed or have a recorded reason for deferral.
