# Security Review v2: WO-C2E5A3 "AI tmux" (`ait`)

## Summary

This is a static review of the v2 code against the threat model (T-01 to T-30, SEC-REQ-1 to 24), OWASP Top 10 and ASVS L2. I ran nothing. I assume the build report is accurate: syntax, test and run all PASS, with `/health` returning 200. The v1 failing test was a test bug and is fixed.

**Change request v2.**
- **CR1 (port fallback):** `port.js`, `serve.js` and `bin/serve.js` add no injection, traversal or privilege path. They do add a small port-hijack risk and one unhandled-error path (SR-12, SR-13). They also leave the existing exposure problem unchanged.
- **CR2 (README):** it is now thorough, but it documents the API as "loopback is trusted" and gives no exposure or TLS guidance (SR-14).

**Status of v1 findings.**

| v1 finding | v2 status |
|---|---|
| SR-01 Critical (CSRF, DNS rebinding) | **Resolved.** `server.js: guard` refuses any request with an `Origin` header. It checks `Host` against a loopback allowlist in no-token mode. `jsonBody` enforces `application/json`. `onlyKeys` rejects unknown fields. Tests in `server.test.js` cover Host, Origin, token and content type. |
| SR-02 High | **Partly fixed, still High.** See the rewritten SR-02 below. |
| SR-03 Medium (dangerous args) | **Partly fixed.** `--settings` is rejected. Bypass flags need confirmation, but see the new gap in SR-03. |
| SR-04 Medium (hooks fail open) | **Fixed** in `projectHooks`; a Low residual remains. |
| SR-05 | Partly fixed (`AIT_API_TOKEN` stripped from the tmux environment only). |
| SR-06 | Partly fixed (timeouts and `maxConnections` added). |
| SR-07, SR-08, SR-11 | Unchanged, still Low. |
| SR-09 | **Fixed.** `sanitize()` strips `\p{Cf}` and U+2028/2029. |
| SR-10 | Partly fixed (denied requests are now audited). |
| Failing unit test | **Resolved.** |

**Automated scan.** It reports 0 findings of any severity, so there is nothing to triage as real or false positive. A clean scan does not cover design-level issues. The blind spots are local multi-user trust, bind address, cleartext transport and confirmation-flag logic, and those are where my findings sit.

**Test evidence.** The security tests now live in `core.test.js`, `launch.test.js`, `service.test.js` and `server.test.js`. There is no test for these:
- SEC-REQ-10 ("modify the settings file, launch must fail")
- SEC-REQ-19
- SEC-REQ-22
- symlinked state directory refusal
- file modes under umask 000 for event and settings files

**Blocking issue.** The no-token API mode trusts any local caller, and the default bind is all interfaces. The threat model treats other local OS users as untrusted (A2). Anyone on the machine can therefore launch Claude as the owner, with a prompt and permission checks off (SR-02).

## SEC-REQ coverage

| SEC-REQ | Implemented? | Evidence |
|---|---|---|
| 1 Socket dir ownership and mode | Yes | `security.js: checkSocketDir/assertSocketSafe`; called from `bin/ait.js: prepareTmux` and `server.js: prepare`. Test: `core.test.js` socket test. |
| 2 Name regex at every entry point | Yes | `validate.js: NAME_RE`; enforced in `tmux.js: target`, `paths.js: sessionFile`, `hook.js: ingest/cleanEvent`, `registry.js: cleanEntry`, `server.js` route (`NAME_RE.test`). |
| 3 Single path helper, prefix assert, no symlinks | Yes | `paths.js: safeFile/sessionFile/ensureStateDir`. `lstat` covers the leaf; parent folders are checked in `ensureStateDir`. |
| 4 argv-only execution plus enforcing test | Yes | `execFile`/`spawn` only. The static test in `core.test.js` is regex-based and would miss a default-import call such as `cp.exec(...)` (see the positive observations). |
| 5 Notification via argv, sanitised | Yes | `notify.js: osascriptArgs/notifySendArgs/buildNotification`. Test with an injection string. |
| 6 State dir 0700, files 0600, symlink refusal | Yes | `paths.js: ensureStateDir/atomicWrite`; `launch.js: writeSettings` (`wx`, 0600). |
| 7 Schema-validate registry and events, size caps | Yes | `registry.js: validateRegistry/loadRegistry` (1 MiB); `hook.js: cleanEvent/readEvent` (64 KiB). |
| 8 Drop forged events | Yes | `state.js: validEvent` (session, `ts >= createdAt`, 5 s skew). Test: `core.test.js`. |
| 9 Absolute, non-world-writable `claude` | Yes | `launch.js: resolveClaude`. The path is shown by CLI `new` and `doctor`, not by dashboard or API launches. |
| 10 Settings file `O_EXCL`, fixed hook argv, hash verified | Partly | `writeSettings` is correct. The hash is stored as `settingsHash` and checked only against the file just written. It is never re-checked before Claude reads it (SR-07). |
| 11 Project-hooks warning and confirmation | Yes | `launch.js: projectHooks` now fails closed (oversize, unreadable or invalid counts as hooks). Only `<dir>/.claude` is inspected (SR-04). |
| 12 Single `sanitize()` | Yes | `sanitize.js` strips OSC, CSI, C0/C1 and `\p{Cf}`. Used in `render.js`, `tmux.js: setStatus`, `notify.js` and CLI output. |
| 13 tmux subcommand allowlist plus test | Yes | `tmux.js: ALLOWED` and `run()`. It is wider than specified (adds `list-panes`, `kill-server`, `rename-session`, `list-keys`), but nothing forbidden is present. |
| 14 Kill and rm by id plus name, explicit `y` | Partly | The dashboard passes id and name (`ui.js`, `service.js`). CLI and API resolve by name only, and the API needs only `?confirm=true`. |
| 15 Append-only audit log | Partly | `audit.js` covers new, kill, rm, rename, open and dangerous-args launches. `server.js` now logs denied requests. Launch failures other than tmux errors and the remote address are not recorded (SR-10). |
| 16 Hook exits 0, 64 KiB cap, error log, 10 s fallback | Yes | `bin/ait-hook.js`, `hook.js: runHookFromStdin`, `state.js: GRACE_MS`. |
| 17 2 s tmux timeout, UI not blocked | Yes | `tmux.js: run` (timeout, SIGKILL); `dashboard.js: refresh/draw` separated. |
| 18 Once per transition, debounce, coalesce, 10/min | Partly | `state.js: createTracker` and the `notify.js` cap are correct. Coalescing is same-poll only, with no 2 s window. |
| 19 Lock trusted only for live `ait` PID | Partly | `lock.js: acquireLock`. The match `/ait/` is too loose and the write is not atomic (SR-08). |
| 20 Fixed error text, no raw capture or env on disk | Yes | `bin/ait.js: fail`, `server.js` generic 500. One gap: an unhandled `listen` error would print a Node stack trace (SR-13). |
| 21 Name-only notifications by default | Yes | `notify.js` with `notifyShowPath`. |
| 22 Return key bound on the ait socket only | Yes | `tmux.js: bindReturnKey` leaves an existing key untouched on the default socket. |
| 23 `--json` omits `claudeSessionId` and `args` | Yes | `service.js: listSessions(verbose)`. |
| 24 Fallback degraded, last 40 lines, bias to waiting | Yes | `detect-fallback.js`, `state.js: resolve`. |

The HTTP API has no SEC-REQs and is not in the threat model or the PIA. Both documents still say "no network listener". The API-specific controls that now exist (Origin, Host, token, content type) are implemented but untracked.

## Findings

| ID | Severity | CWE | Location | Description | Recommended fix |
|---|---|---|---|---|---|
| SR-02 | **High** | CWE-306, CWE-1188, CWE-319 | `config.js: host '0.0.0.0'`; `server.js: guard`, `POST /sessions`, `/export`, `/purge` | With no `AIT_API_TOKEN`, `guard` accepts any connection from `127.0.0.1` with a `localhost` Host header. That includes other local OS users, whom the threat model treats as untrusted (A2, T-01). Any such user can call `POST /sessions` with `args: ["--dangerously-skip-permissions", "<prompt>"]` and `confirmProjectHooks: true`. The last field bypasses the dangerous-args confirmation (SR-03), so the result is code execution as the owner. They can also read `/export` (`claudeSessionId`, `args`, paths) and call `/purge`, which ends every session. The default bind is all interfaces. In token mode the static bearer token travels over plain HTTP, with no minimum strength, no failure throttling and no TLS. A same-host reverse proxy does not help much if it preserves a `localhost` Host header. This is the same class as T-01, which is rated High, but with a much weaker control than the tmux socket's ownership check. | (1) Always require a token. Generate 256 bits on first start, store it 0600 in `AIT_HOME`, and have the CLI read it. Never fall back to "loopback is trusted". (2) Default `host` to `127.0.0.1`. Make non-loopback an explicit opt-in (`AIT_HOST`), allowed only with a token of at least 32 random bytes. Document that managed platforms need `AIT_HOST=0.0.0.0`. (3) Require TLS or a tunnel off-box, and add per-IP failure throttling. (4) Add API SEC-REQs and tests, and update the threat model and PIA. |
| SR-03 | Medium | CWE-88, CWE-863 | `launch.js: launchSession`; `server.js` POST `/sessions` (`confirmProjectHooks`) | `dangerous && !(confirmDangerousArgs \|\| confirmProjectHooks)` lets the project-hooks flag confirm dangerous args. The API schema allows only `confirmProjectHooks`, so there is no separate consent. The dashboard's hook-confirmation `y` also confirms dangerous args if they were ever set. Flags such as `--add-dir`, `--allowedTools` and `--permission-mode acceptEdits` pass unchecked. The row shows no marker that permission prompts are off. | Keep two independent flags. Add `confirmDangerousArgs` to the API's `onlyKeys` list and to a CLI option. Add a deny or confirm list for tool and directory-widening flags, and mark such rows `NO-PROMPTS` in the dashboard. |
| SR-12 | Low | CWE-923, CWE-300 | `port.js: probePort/findFreePort`; `serve.js` | The port moves silently to the next free port. If another local process holds `3000`, clients configured for `3000` keep sending the bearer token to it. The probe binds only `0.0.0.0`. A listener bound to `127.0.0.1:PORT` can still win traffic for `localhost` (QA D1), so the server can start on a port that `localhost` does not reach. The probe and `listen` are also not atomic. | Probe `127.0.0.1` and `::1` as well. Make `listen` itself the test: try to listen, and on `EADDRINUSE` move to the next port. Print the final port in a stable `PORT=N` line. Default to strict mode when a token is set or `PORT` is injected by a platform. |
| SR-13 | Low | CWE-755, CWE-209 | `serve.js`, `server.js: startServer`, `bin/serve.js` | `startServer` returns before the server is listening and has no `error` handler. A bind failure after the probe (race) becomes an uncaught exception. That crashes the process and prints a Node stack trace with file paths, contrary to SEC-REQ-20. The `try/catch` in `bin/serve.js` does not cover it. | In `serve`, await `listening` or `error`. On `EADDRINUSE`, retry with the next port unless strict, otherwise print the fixed message. Add `server.on('error')`. |
| SR-14 | Low | CWE-1059 | `README.md` sections 7, 10, 12 | The README documents the loopback-trusted mode as normal and does not say that: the default bind is all interfaces; the token is sent in cleartext; a managed platform should set `AIT_PORT_STRICT=1`; `npm start` exits 1 and `ait serve` exits 7 in strict mode. The Docker note says to set a token but gives no warning for no-token mode. | Add an "API exposure" paragraph covering bind address, token strength, TLS or tunnel, and strict mode. Update it after SR-02 is fixed. |
| SR-15 | Low | CWE-770 | `server.js` `POST /hooks/{event}`, `hook.js: ingest` | `ingest` writes `events/<name>.json` for any valid name, whether or not it is in the registry. A caller can create unbounded files, because validation is read-side only (T-20). Files are pruned only at dashboard start. | Accept hook events only for names in the registry, or cap the count in `events/`. |
| SR-04 | Low | CWE-693 | `launch.js: projectHooks` | Fail-closed handling is fixed. Only `<dir>/.claude/settings*.json` is checked. Settings in a parent or git-root `.claude` are not examined if Claude reads them. | Also check the git root when it differs from the launch directory. |
| SR-05 | Low | CWE-526 | `tmux.js: createTmux`, `launch.js` | Only `AIT_API_TOKEN` is stripped. The tmux server and Claude still inherit the rest of the starting shell's environment (T-30). Claude may need some of those variables. | Pass an explicit allowlist (`PATH`, `HOME`, `TERM`, `LANG`, Claude-required variables). Document the remainder. |
| SR-06 | Low | CWE-400 | `server.js` | Timeouts and `maxConnections` are set. The `serial` queue is unbounded and every request runs `tmux -V` in `prepare`. | Cache the version check and bound the queue. |
| SR-07 | Low | CWE-367 | `launch.js: writeSettings` | The hash is checked immediately after the write and never again. `rmSync` then `wx` leaves a short race window (SEC-REQ-10, T-09). | Make the file 0400 and re-check the hash on each dashboard refresh. Add a "modify file, launch fails" test. |
| SR-08 | Low | CWE-367, CWE-283 | `lock.js: acquireLock` | The lock is non-atomic, and `/ait/` matches any command containing "ait". | Use `O_EXCL` and match the full command. |
| SR-10 | Low | CWE-778 | `audit.js`, `server.js` | Denied requests are logged without route or remote address. Launch failures other than tmux errors are not logged. | Add the route and `remoteAddress` to denied entries. Log `error` outcomes. |
| SR-11 | Low | CWE-426 | `launch.js: gitBranch`, `lock.js`, `notify.js`, `tmux.js` | `git`, `ps`, `tmux`, `osascript` and `notify-send` are found through `PATH`. `git` runs in a possibly untrusted repo. | Resolve helper binaries to absolute paths once. Run `git` with `-c core.fsmonitor=false --no-optional-locks`. |

## Positive observations

- **Browser-origin attacks are closed.** Every request with an `Origin` header is refused, `Host` is allow-listed in no-token mode, JSON content type is required, and unknown body fields are rejected. A parsed `__proto__` key is also rejected. All of this is tested.
- **Token handling is sound.** Both sides are hashed and compared with `timingSafeEqual`. Responses carry `no-store` and `nosniff`. Errors are a fixed shape with no stack traces.
- **Zero npm dependencies.** There is no third-party supply-chain exposure, and Node 22 is pinned.
- **No shell anywhere.** argv arrays and `--` are used throughout, targets are exact (`=ait-<name>`), and there is a tmux subcommand allowlist with no `send-keys`. The static scan is regex-based, so it would not catch a default-import call such as `cp.exec(...)`. Strengthening it would be cheap.
- **Name and path validation.** The name regex is enforced at every entry, with `__proto__` and `dash` reserved, `Object.hasOwn` lookups and a single path helper with prefix and symlink checks.
- **State handling.** Directory and file modes are enforced, writes are atomic, and size caps apply to the registry and events. Forged events are dropped by session, `createdAt` and future-skew checks. Project-hook detection fails closed. `--settings` cannot be overridden.
- **Output safety.** One sanitiser, now including bidi and format characters, covers render, status line, notification and CLI output. AppleScript text goes through argv.
- **Privacy.** Pane text stays in memory. Notifications show the name only by default. `--json` omits sensitive fields. `export` refuses to overwrite and writes 0600. `purge` deletes only files `ait` created.
- **Port fallback design.** The fallback is bounded (50 ports, then an OS port) and strict mode is available. Port selection never relaxes the API guards, and `PORT` parsing is validated.

## Residual notes (not blocking)

- A hostile process running as the same user is out of scope (accepted R-1).
- Non-security items from earlier stations still stand: unrecorded gate results (baseline, kill-or-shrink, hook spike), bell delivery unverified, and `doctor` `notificationKindsDistinguished` hardcoded.

Verdict: FAIL

Blocking items:
1. **SR-02 (High):** the no-token mode trusts any local caller, and the default bind is all interfaces. Require a token on every request, with one auto-generated at first start and stored 0600. Bind `127.0.0.1` by default. Allow a non-loopback bind only as an explicit opt-in with a strong token and TLS or a tunnel. Add tests for each rule.

Conditions for PASS WITH CONDITIONS on re-review:
- Fix SR-03: separate the confirmation flags, and add a dangerous-args consent field to the API.
- Add the HTTP surface to the threat model and the PIA, with SEC-REQs and tests. Update the README (SR-14).
- Fix SR-12 and SR-13: probe loopback addresses, handle bind errors, and prefer strict mode when a token is set.
- Fix SR-04 to SR-11 and SR-15, or accept each with a recorded reason. Add the missing tests for SEC-REQ-10, 19 and 22.
