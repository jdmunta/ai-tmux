# QA Review v2: WO-C2E5A3 "AI tmux" (`ait`)

**Method.** I read the code and the tests and traced them by hand. I ran nothing. Assumption: the build report is accurate. It shows syntax, test and run all PASS, with `GET /health` returning 200, so the v1 failing test is gone.

## Change request verification

| CR | Requirement | Verified? | Evidence |
|---|---|---|---|
| 1 | If `npm start` hits a port conflict, start on another port | Yes, statically | `bin/serve.js` calls `src/serve.js: serve`, which calls `port.js: findFreePort`. It tries `PORT`, then `PORT+1` to `PORT+50`, then an OS-assigned port. `serve` then sets `env.PORT` and logs "Port N is in use. Using port M instead." `server.js` reads the final `PORT` via `getConfig`. `AIT_PORT_STRICT=1` throws `EADDRINUSE`, and `bin/serve.js` prints the message and exits 1. Tests in `test/port.test.js` cover a fake probe, the maxTries fallback to port 0, strict mode, a really busy port, and `serve()` updating `PORT` and logging. `ait serve` uses the same path. |
| 2 | README has full instructions | Yes, with caveats | `README.md` has requirements, install (`npm link`, `ait doctor`), quick start, a command table with exit codes, dashboard keys, states, HTTP API with curl examples, a "Port conflicts" section, a configuration table including `PORT` and `AIT_PORT_STRICT`, stored data, security notes, troubleshooting, a Docker/Railway note, and tests. Caveats: D1 and D2 below. |

## Acceptance criteria (regression pass)

| # | Criterion | Verified? | Evidence |
|---|---|---|---|
| 1 | Launch starts Claude in a new tmux session with name and dir; shown in the dashboard within 2s | Yes, statically | `launch.js: launchSession` writes the registry entry, then `tmux.newSession`. Tests: `launch.test.js`. The 2s timing was not measured. |
| 2 | Dashboard lists name, project and state | Yes | `render.js: lines`, `service.js: listSessions`. Test: `core.test.js` render. |
| 3 | State is running/waiting/idle and updates within 2s | Partly | `state.js: mapEvent` and `createTracker`, 1s poll plus `fs.watch`. Hook-driven changes land in about 1s. tmux-only changes such as a dead pane can approach 2s (D3). |
| 4 | Waiting sessions are highlighted and sorted first | Yes | `render.js: sortSessions`, `styler.row`. |
| 5 | Once-per-transition bell or notification | Yes, statically | `state.js: createTracker`, `notify.js`. Whether the bell reaches the terminal is unverified (D4). |
| 6 | Select by key attaches; documented return key; session survives | Yes, statically | `ui.js: handleKey`, `tmux.js: switchOrAttach` and `bindReturnKey`, README keys section. |
| 7 | Closing the dashboard leaves sessions running | Yes | `ui.js` quit only returns `{type:'quit'}`, and `dashboard.js: finish` never kills. |
| 8 | Exited sessions are shown as done, no crash | Yes | `state.js: resolve` (dead pane, vanished session), `service.test.js`. |
| 9 | Detection is correct in ≥95% of 20 manual transitions (100% waiting recall) | No | The manual test was not run. The v1 permission-approval gap is closed: `PreToolUse` and `PostToolUse` are in `hook.js: EVENTS`, `state.js: mapEvent` and `launch.js: writeSettings`. Tests: `service.test.js` (approving a prompt returns the row to running) and `core.test.js`. |
| 10 | No custom terminal emulation | Yes | All tmux access goes through `tmux.js` with an allowlist. The static scan in `core.test.js` passes. |
| 11 | README with setup and usage | Yes | See CR2. It is no longer "short", but the change request asked for more. |

## Status of v1 defects

- **D1 (failing test): resolved.** The `ui: numbers are stable ids…` test now re-selects `e` before the kill step. I traced it and the assertions hold, and the build is green.
- **D2 (stale waiting): resolved.** See criterion 9.
- **D3 (2s latency): open, minor.** See criterion 3.
- **D4 (bell delivery): open, minor, unverified.**
- **D5 (gate results): open.** `README.md` section 13 still says "record here". It is now headed "record before relying on it". These results need the requester's real environment and cannot be invented by the Developer. This is not blocking.
- **D6 (`doctor` hardcoded values): partly resolved.** `returnKeyCollision` and `worldWritable` are now computed. `notificationKindsDistinguished` is still hardcoded `true` in `service.js: doctor`.

## New and remaining defects

- **D1 (minor): the port probe may miss a listener bound to a specific address.**
  - File: `src/port.js: probePort`.
  - Cause: it probes only `0.0.0.0`. On macOS, a wildcard bind can succeed while another process holds `127.0.0.1:PORT`. The server would then start on the "free" port while `localhost` requests reach the other process.
  - Fix: also probe `127.0.0.1` (and `::1` where available) and treat the port as free only if all probes succeed. Add a test.
- **D2 (minor): a listen failure after the probe is not handled.**
  - Files: `src/server.js: startServer` and `src/serve.js`.
  - Cause: `startServer` returns before the server is listening, and there is no `server.on('error')`. If the port is taken between probe and listen, the process dies with an unhandled `error` event instead of retrying.
  - Fix: in `serve`, wait for `listening` or `error`. On `EADDRINUSE`, re-run `findFreePort(port+1)` unless strict.
- **D3 (minor): the README does not warn against fallback on managed platforms.**
  - File: `README.md`, sections 7 and 12.
  - Cause: on Railway or Docker, `PORT` is assigned by the platform. A silent move to another port makes the platform health check on that port fail.
  - Fix: tell users to set `AIT_PORT_STRICT=1` there. Also add a line saying `ait serve` exits with code 7 and `npm start` with code 1 when strict.
- **D4 (minor): the fixed health probe in `factory.json` (port 3000) does not follow a moved server.** The README notes this. Consider printing a machine-readable `PORT=` line to stdout.
- **D5 (carry-over, not part of this change): the API still binds `0.0.0.0`.** `config.js` sets `host: '0.0.0.0'`. The RAI and security reviews raised this. Consider defaulting to `127.0.0.1` unless `AIT_API_TOKEN` is set.
- **D6 (minor): the port tests use real sockets.** `test/port.test.js` ("a really busy port is skipped") could flake if the next port is also busy. It is logically safe, because the loop continues.

## Not tested

- The 20-transition manual test and the dogfood week.
- Real tmux, Claude `--settings` and bell delivery.
- Actual port-fallback behaviour on macOS and Linux with a real conflict.
- The Railway path.

## Verdict

Both change requests are implemented and covered by tests. The v1 blockers (the failing test and the stale-waiting state) are fixed, and the build is green. What remains is minor hardening (D1–D4) plus the human-run gates (baseline, kill-or-shrink verdict, hook spike, 20-transition test). Those gates are tracked in the README and are not code defects.

VERDICT: PASS
