# COMPLIANCE REPORT: WO-C2E5A3 "AI tmux" (`ait`), Revision v2

**Framework:** OWASP ASVS 4.x, Level 2, chapters V1-V9 and V12-V14.
**Method:** document and static-code review of earlier station outputs. I ran nothing. The build report shows syntax, test and run all PASS with `GET /health` returning 200, and I rely on it. The v1 failing test was a test bug and is fixed.

**Assumptions**
- ASVS is web-oriented. I apply it to the HTTP API (`src/server.js`, `src/serve.js`, `src/port.js`) and, by analogy, to the CLI/TUI, hook and file interfaces.
- Single user, single machine. The HTTP API was added after the threat model and PIA, which still assume no network listener.
- Change request v2 has two parts: (1) `npm start` moves to another port on conflict; (2) README completeness.

**What changed since v1**
- The build is green.
- The Critical CSRF/DNS-rebinding finding (SR-01) is resolved.
- Bidi and format characters are now stripped.
- `PreToolUse`/`PostToolUse` hooks clear the stale "waiting" state.
- Project-hook detection fails closed.
- `--settings` is rejected.
- Port fallback was added.
- The README is much fuller.
- The High finding SR-02 (all-interface bind, loopback trusted without a token) is **still open**.

---

## 1. Scope and system summary

`ait` is a Node.js 22 terminal dashboard (zero npm dependencies, `package.json` version 1.2.1) layered on tmux. It lists Claude Code sessions with their state, alerts once per transition into `waiting`, and switches between sessions. State comes from Claude hooks written to per-session event files, with a degraded pane-capture fallback.

| Surface | Description |
|---|---|
| CLI and TUI | `bin/ait.js`, `src/dashboard.js` |
| Hook script | `bin/ait-hook.js`, writes `events/<name>.json` |
| HTTP API | `src/server.js`, started by `npm start` (`bin/serve.js` → `src/serve.js`) or `ait serve`. Default bind `0.0.0.0`, port from `PORT` (default 3000). Optional bearer token. Without a token, loopback peer plus loopback `Host` is trusted. `GET /health` is unauthenticated. |
| Port fallback (new) | `src/port.js: findFreePort` tries `PORT`, then `PORT+1..+50`, then an OS-assigned port. It logs "Port N is in use. Using port M instead." `AIT_PORT_STRICT=1` disables the fallback. |
| Local state | `AIT_HOME` (0700/0600): registry, events, settings, audit log, hook-errors log, lock |
| Subprocesses | tmux (`-L ait`), claude, git, ps, osascript/notify-send |
| Deployment note | README §12 and the DevOps plan describe an optional container/Railway run of the API only. tmux and `claude` are absent there. |

**Out of scope:** Claude Code itself, tmux internals, the OS, the terminal emulator, Railway platform controls.

**Delivery status (from earlier stations)**

| Station | Result |
|---|---|
| Build gate | PASS (syntax, test, run) |
| QA | PASS; minor defects only |
| Security Reviewer | **FAIL**: SR-02 High blocking, SR-03, SR-12, SR-13 open |
| Code Reviewer | **CHANGES REQUESTED**: H1 (same root cause as SR-02), M1-M6 |
| Responsible AI Reviewer | FAIL (v1 findings; HTTP-exposure findings remain) |
| Accessibility Auditor | PASS WITH CONDITIONS |
| AI Evaluation | PASS WITH CONDITIONS |
| Privacy Engineer (PIA) | PASS WITH CONDITIONS, written before the API existed |

---

## 2. Data inventory

| Data | Where stored | Purpose or lawful basis | Retention |
|---|---|---|---|
| Session name, directory, branch, extra Claude args, ids, createdAt, exit, hookName, settingsHash | `registry.json` (0600) | Operate the tool; own use (personal tool) | Until `ait rm`, `kill` or `purge` |
| Claude session ID | `registry.json`, `events/<name>.json` | Future resume; medium sensitivity | Same; omitted from default output |
| Last hook event (type, kind, ts) | `events/<name>.json` | State detection | Overwritten per event; pruned at dashboard start. The API hook route can create files for any valid name (SR-15). |
| Per-session hook config | `settings/<name>.json` | Hook injection | Deleted with session |
| Audit trail (action, session, id, result) | `audit.log` (0600) | Accountability | Rotated at 1 MiB; `--purge-log` |
| Denied API requests | `audit.log` as `denied` with session `-` | Accountability | Same. No route or remote address is recorded (SR-10). |
| Hook errors | `hook-errors.log` | Diagnostics | Rotated at 1 MiB |
| Pane text (last 40 lines) | Memory only, fallback mode | State detection; high sensitivity | Never persisted |
| API bearer token | Environment variable `AIT_API_TOKEN` | API auth | Process lifetime. Now stripped from the tmux child environment, but other shell secrets are still inherited (SR-05). |
| Notification text | OS notification service | Alert; name only by default | Transient |
| API request bodies (names, dirs, args) | In memory; effective data lands in the registry | Operate the tool | As registry |
| Export file | User-chosen path, 0600, `wx` | Data-subject access | User-managed; contains `claudeSessionId` and `args` |

No credentials, prompts or transcripts are stored by `ait`. The README states that nothing is transmitted. The CLI and dashboard make no outbound calls. The API listener answers inbound requests, and its token travels in cleartext over plain HTTP if used off-box.

---

## 3. Control mapping

### OWASP ASVS L2

| Control | Requirement | How the delivery addresses it | Evidence | Status |
|---|---|---|---|---|
| **V1.1** | Secure SDLC, threat modelling | Threat model T-01..T-30 and SEC-REQ-1..24 exist. The HTTP API and port fallback have no threat-model entry, no SEC-REQs and no PIA update. The new API controls (Origin, Host, token, content type) are implemented but untracked. | Threat Modeler doc §1 ("no network listener"); Security Reviewer coverage table | Partial |
| V1.2 | Authentication architecture | The local design relies on the OS account. The API uses an optional static token, and without it falls back to "loopback is trusted". | `server.js: guard` | Partial |
| V1.4 | Access control architecture | The trust boundary is the OS user (threat model A2: other local users are untrusted). The API trusts every loopback caller when no token is set, and that includes other local users. | `server.js: guard`; Security Reviewer SR-02 | **Gap** |
| V1.5 | Input and output architecture | Single validators (`validate.name`, `safeFile`, `sanitize`) at every entry point. `onlyKeys` rejects unknown JSON fields. | `validate.js`, `paths.js`, `sanitize.js`, `server.js` | Met |
| V1.6 | Cryptographic architecture | No custom crypto. SHA-256 for the settings hash and the token digest, `timingSafeEqual` for the compare. | `launch.js`, `server.js: tokenOk` | Met |
| V1.7 | Errors and logging architecture | Fixed microcopy, audit log. Denials are logged but without route or peer address. | `errors.js`, `audit.js`, `server.js` | Partial |
| V1.8 | Data protection architecture | Data classification in the threat model and PIA (PIA not updated for the API). | PIA, Threat Model | Partial |
| V1.9 | Communications architecture | No transport security. The API is plain HTTP on all interfaces by default. Neither the README nor the code provides TLS, a tunnel, or exposure guidance. | `config.js: host`, `server.js`, README §7/§12 | **Gap** |
| V1.14 | Configuration architecture | Dedicated tmux socket, no global config edits. `PORT` is validated (invalid → 3000). Default bind is unsafe. | `launch.js`, `tmux.js`, `config.js` | Partial |
| **V2.1** | Password security | No passwords or accounts. | n/a by design | Met (N/A) |
| V2.2 | General authenticator security | A single static bearer token. No strength minimum, no generation, no throttling, no rotation. The no-token loopback mode is an optional bypass. | `server.js: guard/tokenOk`; SR-02 | **Gap** |
| V2.7-V2.10 | Out-of-band, credential, service authentication | Not implemented. The service credential is optional, plaintext in the environment, and sent over HTTP. | `server.js`, `config.js` | **Gap** |
| **V3.1-V3.7** | Session management | Stateless API with no web sessions or cookies. | n/a | Met (N/A) |
| V3.5 | Token-based session management | Static bearer token, no expiry or revocation. | `config.js` | Partial |
| **V4.1** | General access control | The server enforces checks. Without a token, any loopback caller is fully authorised for launch, export and purge. | `server.js: guard` | **Gap** |
| V4.2 | Operation-level access control | The dashboard passes id and name together. The CLI and API resolve by name only. | `service.js`; SEC-REQ-14 "Partly" | Partial |
| V4.3 | Other access-control considerations | Admin functions (purge, export, launch with args) share the same authorisation. `confirmProjectHooks` also satisfies the dangerous-args confirmation, and the API has no separate `confirmDangerousArgs` field (SR-03). | `launch.js: launchSession`, `server.js` | **Gap** |
| **V5.1** | Input validation | Name regex at every entry point. Schema validation of registry and events. Size caps (registry 1 MiB, event/body 64 KiB). Arg count and length caps. | `validate.js`, `registry.js`, `hook.js`, `launch.js: checkArgs`; tests | Met |
| V5.1 (HTTP) | Content-type and origin validation | `application/json` required (415 otherwise). Any `Origin` header is refused (403). Host allow-list in no-token mode. Unknown fields rejected (400). | `server.js: guard/jsonBody/onlyKeys`; `server.test.js` | Met |
| V5.2 | Sanitisation | One `sanitize()` strips ESC, OSC, CSI, C0/C1 and `\p{Cf}` (bidi and format) plus U+2028/2029. | `sanitize.js`; `core.test.js` | Met |
| V5.3 | Output encoding and injection prevention | `execFile` argv only, AppleScript via argv, exact tmux targets (`=ait-<name>`), tmux subcommand allowlist. The static scan is regex-based and would miss a default-import call such as `cp.exec(...)` (L10). | `core.test.js` static scan, `security.test`, `notify.js` | Met |
| V5.5 | Deserialization | JSON only, validated, prototype keys rejected, `Object.hasOwn` lookups. | `registry.js`, `core.test.js` | Met |
| V5 (args) | Safe argument handling | A user `--settings` is rejected. Bypass flags (`--dangerously-skip-permissions`, `--mcp-config`, `--permission-mode bypassPermissions`) need confirmation, but the flag is conflated with project hooks. `--add-dir`, `--allowedTools` and `acceptEdits` are unchecked. | `launch.js: checkArgs`; SR-03; Code Review M4 | Partial |
| **V6.1** | Data classification for crypto | None needed beyond file permissions. | PIA | Met |
| V6.2 | Algorithms | SHA-256 and `timingSafeEqual` only. | `launch.js`, `server.js` | Met |
| V6.3-V6.4 | Random values and secret management | `crypto.randomBytes` for temp names. No generated API token, and the user supplies a token of any strength. Only `AIT_API_TOKEN` is stripped from the tmux environment, and other secrets are still inherited by tmux and Claude (SR-05). | `paths.js`, `tmux.js` | Partial |
| **V7.1** | Log content | The audit log records time, action, name, id and result. No raw capture or environment is logged. | `audit.js`, `service.test.js` | Met |
| V7.2 | Log processing | Successes and denials are logged. The route, remote address and non-tmux launch failures are missing. | `server.js`, SR-10 | Partial |
| V7.3 | Log protection | 0600, size-rotated, sanitised. Not tamper-proof against the same user (accepted R-6). | `audit.js` | Met (accepted risk) |
| V7.4 | Error handling | Fixed messages, a generic 500, and stack traces only with `AIT_DEBUG=1`. A listen error after the port probe is unhandled and would print a Node stack trace and crash (SR-13). | `bin/ait.js: fail`, `server.js`, `serve.js` | Partial |
| **V8.1** | General data protection | Minimal persisted fields. Pane text in memory only. | PIA; `core.test.js` | Met |
| V8.2 | Client-side data protection | `Cache-Control: no-store`, `nosniff`. | `server.js: send` | Met |
| V8.3 | Sensitive private data | Name-only notifications. `--json` omits ids and args. Export writes 0600 and refuses overwrite. Other shell secrets leak into tmux and Claude environments. | `notify.js`, `service.js`, `cmdExport`; SR-05 | Partial |
| **V9.1** | Client communication security | HTTP only, no TLS. Default bind `0.0.0.0`. The token is sent in cleartext. | `config.js`, `server.js` | **Gap** |
| V9.1 (port fallback) | Credential delivery to the intended endpoint | If a foreign process holds the preferred port, clients configured for it send their bearer token to that process. The port probe checks only `0.0.0.0`, so a loopback-only listener can be missed. Probe and listen are not atomic. There is no stable machine-readable port line. | `port.js`, `serve.js`; SR-12; Code Review M1/M2 | Partial |
| V9.2 | Server communication security | No outbound calls from `src/` or `bin/` (test-enforced, excluding the server and port modules). | `core.test.js` static scan | Met |
| **V12.1** | File upload | No uploads. | n/a | Met (N/A) |
| V12.3 | File execution | The hook command is a fixed absolute `node` plus script. `claude` is resolved to an absolute path and refused in world-writable locations. The settings hash is checked only once, at write time (SR-07). | `launch.js`, `launch.test.js` | Partial |
| V12.4-V12.5 | File storage and download | One path helper with prefix assertion and symlink refusal. 0700/0600 modes. Atomic writes. Export uses `wx` 0600. | `paths.js`, `core.test.js` | Met |
| V12.6 | SSRF | No outbound requests. | n/a | Met |
| **V13.1** | Generic web service security | Method and route checks, body cap 64 KiB, `requestTimeout` 15 s, `headersTimeout` 5 s, `maxConnections` 100. The serial queue is unbounded, `tmux -V` runs per mutating request, and hook events can be written for unregistered names (SR-15). | `server.js` | Partial |
| V13.2 | RESTful web service | The JSON contract exists (OpenAPI). CSRF protection is in place: Origin refused, `Content-Type` enforced, Host checked in no-token mode. Tested. | OpenAPI; `server.js`; `server.test.js` | Met |
| V13.4 | GraphQL | Not applicable. | n/a | Met (N/A) |
| **V14.1** | Build | Zero dependencies, `engines` pinned (`node >=22`), build gate green. | `package.json`; build report | Met |
| V14.2 | Dependency | No third-party packages. | `package.json` | Met |
| V14.3 | Unintended security disclosure | No stack traces by default and no environment printing. Exception: the unhandled listen error (SR-13). | `bin/ait.js`, `bin/serve.js` | Partial |
| V14.4 | HTTP security headers | `nosniff` and `no-store` only. No CSP or other headers, which is low value for a JSON-only API. | `server.js: send` | Partial |
| V14.5 | HTTP request header validation | `Origin` is rejected and `Content-Type` enforced. `Host` is validated only in no-token mode. In token mode the token is the only guard. | `server.js: guard` | Partial |

---

## 4. Privacy and data-protection checks

| Check | Result | Evidence |
|---|---|---|
| Data minimisation | Pass. Only the listed fields are persisted. Pane text is never written. Hook payloads are whitelisted and size-capped. | PIA §2; `hook.js`; `core.test.js` |
| Access (export) | Pass. `ait export [--out]` writes 0600 and never overwrites. `GET /export` is available over the API, but it is reachable by any loopback caller when no token is set (SR-02). | `bin/ait.js: cmdExport`; `service.js: exportState` |
| Erasure | Pass. `ait rm`, `kill` and `purge` (typed confirmation) delete only files `ait` created. `--purge-log` removes audit rows. `doctor` reports remaining state. | `service.test.js` |
| Rectification | Pass. `ait rename` (registry, tmux; the hook identity is preserved). | `service.js: renameSession`; tests |
| Breach handling | **Gap.** No breach or incident procedure exists for the privacy side. The SRE runbook covers technical incidents (FM-12 for suspected unauthorised API use) but has no notification or assessment step. For a single-user local tool the impact is low, but the open API surface raises it. | SRE runbook; not evidenced elsewhere |
| Retention | Partial. DONE entries persist until removed, and `retainDoneDays` (PRIV-REQ-11) is not implemented. Logs rotate at 1 MiB. Event files can accumulate through the hook route until the dashboard next starts (SR-15). | PIA; code |
| Transparency | Partial. The README §9 lists what is stored, and §7 and §10 describe API guards. It does not warn about the all-interface default, cleartext token, or loopback-trust risk, and it says to set a token only in the Docker note (SR-14). Gate results (baseline, kill-or-shrink, hook spike) still read "record here". | README; Security SR-14 |
| PIA currency | **Gap.** The PIA assumes "no network service" and was not updated for the HTTP API, the port fallback or the Railway/container option. | PIA §1, §3 |
| Consent for dangerous capability | Partial. Project-hooks and bypass flags require confirmation, but one consent flag covers both. | `launch.js`; SR-03 |

---

## 5. Third-party components and licences

No SBOM was supplied. No formal SBOM was produced (low priority given zero dependencies).

- **npm dependencies:** none (`"dependencies": {}`). No third-party package licence obligations.
- **Runtime prerequisites** (not bundled): Node.js 22 (MIT), tmux 3.2+ (ISC-style), Claude Code CLI (proprietary, user-installed), git, ps, osascript/notify-send (OS tools).
- **Optional container image** (DevOps plan, README §12): `node:22-slim` plus apt packages `tmux`, `git` and `procps`. These carry their own licences (git is GPL-2.0; procps is GPL/LGPL). They are installed from distribution packages and not redistributed by `ait`. The user must still honour them if they publish an image. This is not evidenced as reviewed.
- **Project licence:** `UNLICENSED` / private in `package.json`. The OpenAPI spec says "Proprietary". These are consistent.
- **Status:** Met for dependency risk. The container-image licence position is unreviewed (Partial, Low).

---

## 6. Gaps and required actions

| # | Gap | Owner | Priority |
|---|---|---|---|
| 1 | **SR-02 / Code Review H1 (V1.4, V1.9, V2.2, V4.1, V9.1):** the API trusts any loopback caller when no token is set, and it binds `0.0.0.0` over plain HTTP. Required: always require a generated token (≥32 random bytes, stored 0600 in `AIT_HOME`); default bind `127.0.0.1`, with a non-loopback bind only via explicit opt-in and a strong token; document TLS or a tunnel; add failure throttling; add tests for each rule. | Developer | **High / blocking** |
| 2 | **SR-03 / M4 (V4.3, V5):** the project-hooks flag satisfies the dangerous-args confirmation. Add an independent `confirmDangerousArgs` (API and CLI), cover `--add-dir`, `--allowedTools` and `acceptEdits`, and mark such rows in the dashboard. | Developer | Medium (condition for re-review) |
| 3 | **SR-12 / SR-13 / M1 / M2 (port fallback, V9.1, V7.4, V14.3):** probe `127.0.0.1` and `::1` as well; make `listen` itself the test with retry on `EADDRINUSE`; add `server.on('error')` and a fixed error message instead of a stack trace; print a stable `PORT=N` line; prefer strict mode when a token is set or the platform injects `PORT`. Add tests for the race and the loopback-only blocker. | Developer | Medium (condition) |
| 4 | Update the threat model and PIA for the HTTP surface and port fallback. Add SEC-REQs and tests for Origin, Host, token, content type and port selection. | Threat Modeler, Privacy Engineer | High |
| 5 | **SR-14 / L9 (V1.9, transparency):** the README needs an "API exposure" paragraph (bind address, cleartext token, TLS or tunnel, `AIT_PORT_STRICT=1` on managed platforms, strict-mode exit codes 1 for `npm start` and 7 for `ait serve`). Correct the "loopback client or bearer token" wording to say that a set token is always required. | Developer | Medium |
| 6 | **Gate evidence:** README §13 still says "record here" for the baseline, kill-or-shrink verdict and hook spike. Run the 20-transition test (100% waiting recall) and verify bell delivery. | Requester / QA | Medium |
| 7 | SR-05 / M6 (V6.4, V8.3): pass an explicit environment allowlist to tmux and Claude, not only filter `AIT_API_TOKEN`. | Developer | Medium |
| 8 | SR-07 / L2 (V12.3): re-check the settings hash before launch and on refresh; make the file 0400; add a "modified file, launch fails" test (SEC-REQ-10). Add missing tests for SEC-REQ-19 and 22 and for symlinked-state-dir refusal. | Developer | Low |
| 9 | M3 (integrity): a registry lost update can reuse an id and orphan a session. Re-load before save, or lock read-modify-write. | Developer | Medium |
| 10 | SR-06 / SR-15 / L4 (V13.1): bound the serial queue, cache the tmux version check, accept hook events only for registered names. | Developer | Low |
| 11 | SR-10 / L6 (V7.2): add route and remote address to denied entries, and log failed launches. | Developer | Low |
| 12 | SR-04, SR-08, SR-11, M5 (latency), L7 (2 s coalescing), L8 (shutdown, `closeAllConnections`), L10 (stronger static scan): lock atomicity and loose PID match; helper binary paths; parent-folder project hooks; debounce confirm-refresh. | Developer | Low |
| 13 | V4.2: CLI and API kill/rm resolve by name only. | Developer | Low |
| 14 | `doctor` still hardcodes `notificationKindsDistinguished: true`. Compute it from observed payloads. | Developer | Low |
| 15 | Breach and incident-handling note for the privacy side, and `retainDoneDays`. | Privacy Engineer | Low |
| 16 | Accessibility conditions (A1-A12, notably A3 cursor, A4 dim text, A11/A12 README notes) and screen-reader/200% font test results in the README. | Developer | Medium |
| 17 | Licence review of the optional container image packages if an image is published. | Developer / Requester | Low |

---

## 7. Sign-off readiness

**Not ready for sign-off.**

- **Improved since v1:** V5 (including HTTP validation and sanitisation), V6.1/V6.2, V7.1/V7.3/V7.4 (local), V8.1/V8.2, V12.4-V12.6, V13.2, V14.1/V14.2 are Met. The Critical CSRF/rebinding risk is closed and tested. The build is green.
- **Still failing:** V1.4, V1.9, V2.2, V2.7-V2.10, V4.1, V4.3 and V9.1 are not satisfied for the HTTP API. With no token, any local OS user can launch Claude with permission prompts off (the confirmation can be satisfied through `confirmProjectHooks`), read `/export` and call `/purge`. The Security Reviewer rates this High and blocking, and the Code Reviewer independently reaches the same conclusion.
- **New in v2:** the port fallback is functionally correct and tested. It leaves a bind-race crash path, a loopback-address blind spot, and token disclosure to a foreign listener on the preferred port. It does not weaken the API guards.
- **Documentation:** the README now meets the "full instructions" request. It still lacks API exposure guidance, and the gate results are unrecorded.
- **Paperwork:** the threat model and PIA do not cover the HTTP surface, and no breach procedure exists.
- **Not independently confirmed:** I ran nothing, so the test evidence cited above rests on the build report and static reading. The 20-transition test and bell delivery are not evidenced.

**Conditions to reach PASS WITH CONDITIONS:** close gap 1 (blocking). Then address gaps 2, 3, 4 and 5, and record gap 6, then re-run this mapping.

Verdict: FAIL
