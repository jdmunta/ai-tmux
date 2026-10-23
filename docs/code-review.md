# Code Review v2: WO-C2E5A3 "AI tmux" (`ait`)

**Method.** Static review only; nothing was run. I assume the build report is accurate: syntax, test and run all PASS, and `GET /health` returns 200. I traced the code by hand, including the new files `src/port.js`, `src/serve.js` and `bin/serve.js`. Findings from other stations are used as evidence, and I re-checked each one I cite against the code shown.

## Change request verification

| CR | Result | Evidence |
|---|---|---|
| 1. Start on another port if there is a port conflict | Implemented, with a race and an address-mismatch defect (M1, M2) | `bin/serve.js` calls `serve()`. `serve()` calls `findFreePort(cfg.port, cfg.host, {strict})`, which tries `PORT`, then `PORT+1..+50`, then an OS-assigned port. `serve()` sets `env.PORT`, logs "Port N is in use. Using port M instead.", and starts the server. `AIT_PORT_STRICT=1` throws `EADDRINUSE` and exits 1. `ait serve` exits 7 through `fail()`. `test/port.test.js` covers each path. |
| 2. README full instructions | Implemented; a few inaccuracies and omissions remain (L9) | The README now covers requirements, install, quick start, commands and exit codes, keys, states, the API with curl examples, port conflicts, configuration, stored data, security notes, troubleshooting, Docker/Railway and tests. |

## Status of v1 findings

| v1 | Status in v2 |
|---|---|
| C1 CSRF / DNS rebinding | **Resolved.** `guard()` refuses any `Origin`. In no-token mode it requires a loopback peer and a loopback `Host`. `jsonBody` enforces `application/json`, and `onlyKeys` rejects unknown fields. Tests exist. |
| H1 bind `0.0.0.0` + loopback trusted | **Open, still High** (see H1 below). |
| H2 failing test | **Resolved.** It was a test bug and the build is green. |
| M1 stale "waiting" | **Resolved.** `PreToolUse`/`PostToolUse` are in `EVENTS`, `mapEvent` and `writeSettings`, and are tested. |
| M2 project hooks fail open | **Resolved.** `projectHooks()` fails closed. |
| M3 dangerous args | **Partly resolved.** `--settings` is rejected. The confirmation flags are conflated (M4). |
| M4 debounce latency | **Open** (M5). |
| M5 secrets in the tmux environment | **Partly resolved.** Only `AIT_API_TOKEN` is stripped (M6). |
| L1, L2, L5, L8 | Open (L1 to L4, L7). |
| L3 sanitizer | **Resolved.** `\p{Cf}`, U+2028 and U+2029 are stripped. |
| L4 HTTP hardening | **Partly resolved.** Timeouts and `maxConnections` are set. The queue is unbounded and `tmux -V` still runs per request. |
| L6 `doctor` constants | **Partly resolved.** `notificationKindsDistinguished` is still hardcoded `true`. |
| L7 audit | **Partly resolved.** Denials are logged without route or peer address. |

## Findings by severity

### Critical

None.

### High

**H1. The API trusts any local caller and binds all interfaces by default.**
- Files: `src/config.js` (`host: '0.0.0.0'`), `src/server.js` `guard()`.
- Without `AIT_API_TOKEN`, any process or user on the machine that connects from loopback with a `localhost` Host is fully trusted. The threat model treats other local users as untrusted.
- Such a caller can send `POST /sessions` with `args: ["--dangerously-skip-permissions"]` and `confirmProjectHooks: true`. The `confirmProjectHooks` flag also satisfies the dangerous-args check (M4), so this launches Claude with permission prompts off. The caller can also read `/export` and call `/purge`.
- A same-host reverse proxy that forwards `Host: localhost` makes the API effectively public with no authentication.
- Token mode uses a static bearer token over plain HTTP, with no minimum strength and no failure throttling.
- Fix:
  1. Always require a token. Generate 32 random bytes on first start, store them 0600 in `AIT_HOME`, and have the CLI read them. Remove the "loopback is trusted" path.
  2. Default `host` to `127.0.0.1`. Allow another bind only through an explicit `AIT_HOST`, and refuse to start without a token of at least 32 bytes in that case. Managed platforms then set `AIT_HOST=0.0.0.0` deliberately.
  3. Add per-IP failure throttling and a note to put TLS or a tunnel in front.
  4. Add tests for each rule. Update the threat model and PIA, which still assume no listener.

### Medium

**M1. Port fallback: probe and listen are not atomic, and a bind error is unhandled (new, CR1).**
- Files: `src/port.js` `probePort/findFreePort`, `src/serve.js`, `src/server.js` `startServer`, `bin/serve.js`.
- `probePort` binds and releases the port, and `startServer` binds it again later. If another process takes the port in between, `server.listen` emits `error`.
- `startServer` returns before the server is listening and has no `error` listener. `serve()` has already returned, so the `try/catch` in `bin/serve.js` does not cover it. The result is an uncaught exception, a crash and a Node stack trace. That also contradicts SEC-REQ-20 (fixed error text).
- For the OS-assigned fallback (`probe(0)`), the port is released and then reused, so the same race applies.
- Fix: make `listen` itself the test. `startServer` should accept `{ listen: false }` or return the unstarted server. `serve()` then loops:
  ```js
  function listenOn(server, port, host) {
    return new Promise((res, rej) => {
      const ok = () => { server.off('error', bad); res(); };
      const bad = (e) => { server.off('listening', ok); rej(e); };
      server.once('listening', ok); server.once('error', bad);
      server.listen({ port, host, exclusive: true });
    });
  }
  // for p of candidates: try listenOn; on EADDRINUSE and !strict continue; else throw
  ```
  Keep `findFreePort` only as a candidate generator. Add `server.on('error')` for later errors. Add a test that occupies the chosen port between probe and listen.

**M2. Port probe checks only the wildcard address, so the server can start on a port that `localhost` does not reach (new, CR1).**
- File: `src/port.js` `probePort`.
- It binds `cfg.host` (`0.0.0.0`) only. Node sets `SO_REUSEADDR` on Unix. On macOS, a wildcard bind can succeed while another process holds `127.0.0.1:PORT`.
- `ait` then reports success, but `curl localhost:PORT` and clients holding the bearer token reach the other process. This can leak the token.
- Fix: this is solved by the listen-as-test approach in M1. If a probe is kept, also probe `127.0.0.1` and `::1`, and treat the port as free only if all succeed. Add a test with a loopback-only blocker.

**M3. Registry lost update can roll back `nextId` and orphan a session (carry-over, newly confirmed).**
- Files: `src/service.js` `listSessions`, `src/launch.js` `launchSession`, `src/registry.js`.
- `listSessions` loads the registry, then awaits tmux calls and `capture()`. If it is "dirty" (a new `exit` or `claudeSessionId`), it saves the whole stale object.
- A concurrent `ait new` from another process, such as the CLI while the dashboard polls, may have saved a new entry in between. The dashboard's save then drops that entry and restores the old `nextId`.
- The result is a running tmux session that is untracked, and a reused id. That breaks the "ids are never reused" rule, which the numeric hotkeys depend on.
- Fix: in `listSessions`, re-load the registry synchronously right before saving and patch only the changed fields of existing entries. Better, add a lock around read-modify-write using `open(..., 'wx')` with retry. Add a test that interleaves a launch with a dirty list.

**M4. A single confirmation flag covers two different risks.**
- Files: `src/launch.js` (`dangerous && !(confirmDangerousArgs || confirmProjectHooks)`), `src/server.js` (`onlyKeys` allows only `confirmProjectHooks`), `bin/ait.js` (`--yes`).
- Confirming "this folder has project hooks" also confirms "remove permission prompts". The API has no separate consent field. `--mcp-config`, `--add-dir`, `--allowedTools` and `--permission-mode acceptEdits` get no check or marker.
- Fix: keep two independent flags. Add `confirmDangerousArgs` to the API's `onlyKeys` and a CLI option. Log dangerous launches (already done) and show a `NO-PROMPTS` marker on the row.

**M5. Debounce can still push latency past 2 s.**
- Files: `src/state.js` `createTracker`, `src/dashboard.js`.
- The tracker commits a new state only on a later `update()` after 500 ms. After the `fs.watch` refresh at about 100 ms, the next refresh is the 1 s interval tick. Worst case is about 2 s for hook events, and more for tmux-only changes.
- Fix: when a new candidate state appears, schedule a confirming `refresh()` at about 550 ms.

**M6. Secrets are still inherited by tmux and Claude.**
- Files: `src/tmux.js` `createTmux`, `src/launch.js`.
- Only `AIT_API_TOKEN` is filtered. Shell API keys and other variables go to the tmux server, and so to prompt-injectable Claude sessions.
- Fix: use an explicit allowlist (`PATH`, `HOME`, `TERM`, `LANG`, `LC_*`, `XDG_*`, the `ANTHROPIC_*` Claude needs) for `new-session`, and document the rest.

### Low

**L1. Lock is racy and its PID check is loose.** `src/lock.js` does check-then-`atomicWrite`, so two dashboards can start. `/ait/.test(cmd)` matches "wait" or "bait". Fix: use `wx` creation, and match `bin/ait.js` in the command.

**L2. Settings hash is checked only once.** `src/launch.js` `writeSettings` verifies the hash right after the write (SEC-REQ-10). `rmSync` then `wx` leaves a small race. Fix: write 0400, re-check the hash on refresh, and add a "modified file, launch fails" test.

**L3. Helper binaries resolve through PATH.** `git`, `ps`, `osascript`, `notify-send` and `tmux` are found through PATH. `git` runs in a possibly untrusted repo. Fix: resolve absolute paths once and run git with `-c core.fsmonitor=false --no-optional-locks`.

**L4. HTTP hardening is incomplete.** `server.js`: the `serial` queue is unbounded and each mutating request runs `tmux -V` in `prepare()`. `POST /hooks/{event}` writes `events/<name>.json` for any valid name, so files are unbounded until the next dashboard start. Fix: cache the version check, cap the queue, and accept hook events only for registered names.

**L5. `doctor` still reports a constant.** `notificationKindsDistinguished: true` is hardcoded in `service.js`. Compute it from observed payloads, or omit it.

**L6. Audit coverage is thin.** `server.js` logs denials as `session: '-'` with no route or peer address, and failed launches other than tmux errors are not logged. Fix: add `route` and `remoteAddress`.

**L7. Notification coalescing is per poll, not a 2 s window** (`src/notify.js`). Buffer transitions for about 2 s before `fire`.

**L8. Port change side effects and shutdown.**
- `serve()` mutates `process.env.PORT` through the `env` argument. That is acceptable, but pass the chosen port explicitly instead.
- The SIGTERM handler in `bin/serve.js` calls `server.close()`, which waits for keep-alive connections. Call `server.closeAllConnections()` first.
- `factory.json` still probes `/health` on port 3000, so a moved server fails the platform health check. Print a stable `PORT=N` line on stdout, and use strict mode on managed platforms.

**L9. README inaccuracies and omissions.**
- Section 7 says non-health routes need "a loopback client … or a bearer token". In the code, when `AIT_API_TOKEN` is set the token is always required.
- It gives no exit codes for strict mode: `npm start` exits 1 and `ait serve` exits 7.
- It does not tell Railway/Docker users to set `AIT_PORT_STRICT=1`.
- It has no API exposure warning (bind address, cleartext token, TLS or tunnel).
- Section 13 still says "record here" for all three gates.

**L10. The static security scan is regex-based.** The test in `core.test.js` would miss `cp.exec(...)` through a default import, and the tmux allowlist is wider than SEC-REQ-13 (adds `list-panes`, `kill-server`, `rename-session`, `list-keys`). Fix: also scan for `.exec(`, `.execSync(` and `shell:`, and record the extra subcommands in the requirements.

**L11. Port test fragility.** `test/port.test.js` ("a really busy port is skipped") and `server.test.js` `boot()` use real sockets and probe-then-listen. They are logically safe but could flake on a busy CI host.

## Performance notes

No blocking issues. Polling is 1 s plus `fs.watch`. Capture runs only in fallback mode, and tmux calls have a 2 s timeout. The port search costs at most 52 quick local bind attempts at startup. Two items are worth doing: skip the full-screen redraw when the frame is unchanged, and fix the lost-update risk (M3) before relying on multi-process use.

## Carried non-code conditions

- The baseline, kill-or-shrink verdict and hook spike results are still "record here" in the README.
- Update the threat model and PIA for the HTTP surface (CSRF, rebinding, local-user trust, remote exposure, port fallback).
- Run the live 20-transition test with 100% waiting recall, including bell delivery.

## Verdict

Both change requests are implemented and tested, and the v1 Critical, the failing test and the stale-waiting defect are fixed. The no-token loopback trust with an all-interface bind (H1) is a real remote-execution path as the owner. The new port fallback can also crash on a bind race (M1) or land on a port `localhost` does not reach (M2). These need fixing before this ships.

VERDICT: CHANGES REQUESTED
