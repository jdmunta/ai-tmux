# Privacy Impact Assessment: WO-C2E5A3 "AI tmux" (`ait`)

## 1. Scope and assumptions

- Single user, single machine, macOS/Linux. No network service, no telemetry, no accounts, no third-party processors. The data subject is the requester, who is also the data controller (a personal tool).
- GDPR-style obligations are largely moot for a purely local personal tool (household/personal-use context). This PIA applies them as engineering discipline: minimise, protect, and give the user control and deletion.
- `ait` stores no credentials and no conversation content. Claude Code itself stores transcripts. That is outside `ait`'s scope and is not changed by it.
- Assumption: if the tool is later shared or used on a multi-user machine, the risk rating below must be revisited.

## 2. Data inventory

| Field | Purpose | Lawful basis | Sensitivity | Retention | Who can access |
|---|---|---|---|---|---|
| Session `name` | Identify and display session | Own use / legitimate interest (user's own tool) | Low | Until `ait rm`/`kill` | Owner (0600/0700) |
| `dir` (absolute path) | Launch cwd, project display | Same | Low-medium (may reveal username, client or project names) | Until entry removed | Owner |
| `branch` | Display only | Same | Low | Until entry removed | Owner |
| `args` (extra claude flags) | Re-launch/resume | Same | Low-medium (may carry permission-skipping flags) | Until entry removed | Owner |
| `claudeSessionId` | Future resume | Same | Medium (resumes a transcript) | Until entry removed | Owner |
| `createdAt`, `exit {code, at}` | Ordering, DONE display | Same | Low | Until entry removed | Owner |
| Event file (`event`, `kind`, `ts`, `claudeSessionId`) | State detection | Same | Low-medium | Overwritten per event; pruned when session removed | Owner |
| Per-session `settings/<name>.json` | Hook injection | Same | Low | Deleted with session | Owner |
| `capture-pane` text (last 40 lines) | Fallback state detection | Same | **High** (may contain code, secrets, tokens) | Memory only, never persisted | The `ait` process only |
| `audit.log` (timestamp, action, name, id, result) | Accountability | Same | Low | Size-rotated; user-purgeable | Owner |
| `hook-errors.log` | Diagnostics | Same | Low (sanitised) | Size-rotated | Owner |
| Notification text (name; path optional) | Alert user | Same | Low-medium (screen-visible) | Transient | OS notification service, anyone viewing the screen |
| `dashboard.lock` (PID) | Single-instance | Same | Negligible | Process lifetime | Owner |

## 3. Data-flow notes

- All flows are local: user input → `ait` → tmux (`-L ait` socket) → Claude process → hook → event file → dashboard.
- **Third parties:** none for `ait` data. The OS notification subsystem (`osascript`/`notify-send`) receives the session name (and path only if enabled). Claude Code communicates with Anthropic as part of its own operation; `ait` neither adds to nor intercepts that traffic.
- Pane content is read via `capture-pane` into memory, matched, and discarded.
- Environment variables are passed minimally through `-e`; secrets are never put in argv, registry, or logs.
- Nothing leaves the machine. `ait ls --json` output may be piped by the user to other tools, which is user-initiated.

## 4. Requirements for the Developer

**Minimisation**
- **PRIV-REQ-1:** Persist only the fields listed in section 2. No pane content, prompts, transcripts, environment variables, or API keys are written to disk or logs.
- **PRIV-REQ-2:** Raw `capture-pane` output stays in memory, is never logged, and only the derived state is retained. Capture is limited to the last 40 lines and only when in fallback mode.
- **PRIV-REQ-3:** Default desktop notifications show session name only. Path appears only when `notifyShowPath=true`.
- **PRIV-REQ-4:** Event files store only whitelisted fields (`event`, `kind`, `ts`, `claudeSessionId`) with type and length checks.
- **PRIV-REQ-5:** `ait ls --json` omits `claudeSessionId` and `args` unless `--verbose`.
- **PRIV-REQ-6:** No network calls, analytics, crash reporting, or update checks. A test fails if `node:http`, `node:https`, `node:net` (outbound), or `fetch` is used in `src/` or `bin/`.
- **PRIV-REQ-7:** Error output uses fixed microcopy. Stack traces and environment are shown only with `AIT_DEBUG=1`, and never written to disk.

**Protection**
- **PRIV-REQ-8:** State directory is 0700 and files 0600, verified and repaired at startup. Symlinked state dirs are refused.
- **PRIV-REQ-9:** Logs (`audit.log`, `hook-errors.log`) are size-rotated (suggested 1 MiB, keep 1 backup) and contain no free text from panes.

**Retention**
- **PRIV-REQ-10:** Event and settings files for sessions not in the registry are pruned at startup. DONE entries persist only until the user removes them, with a README note on this.
- **PRIV-REQ-11:** Optional `retainDoneDays` setting (default off) auto-removes DONE entries after N days.

**Consent / transparency**
- **PRIV-REQ-12:** README and `ait doctor` list exactly what is stored, where, and that nothing is transmitted. First run prints the state directory path.
- **PRIV-REQ-13:** No global Claude or tmux config is modified. Any project-local settings file must be explicit, merged, reversible, and recorded.
- **PRIV-REQ-14:** Warn and require confirmation when launching in a directory with project-level hooks, since those run with the user's authority.

**Data-subject rights**
- **PRIV-REQ-15 (Access/export):** `ait export [--out file]` writes registry, audit log and settings metadata as JSON, with `claudeSessionId` and `args` included, to a 0600 file.
- **PRIV-REQ-16 (Erasure per session):** `ait rm <name>` and `ait kill <name>` delete the registry entry, event file and settings file. The audit log keeps a minimal "removed" record unless `--purge-log` is given.
- **PRIV-REQ-17 (Erasure all):** `ait purge` (with typed confirmation) removes the whole state directory and, if the dedicated socket is in use, stops the `ait` tmux server. It reports what was deleted.
- **PRIV-REQ-18 (Rectification):** `ait rename` updates the name consistently in the registry, event and settings files, and tmux.
- **PRIV-REQ-19:** Deletion must be complete and verifiable: after `ait purge`, `ait doctor` reports no remaining state.

## 5. Open risks

| # | Risk | Rating | Note |
|---|---|---|---|
| 1 | Pane capture may transiently hold secrets in memory | Low | In-memory, fallback-only, last 40 lines |
| 2 | Same-user hostile process can read all state | Medium, accepted | Not mitigable by file permissions |
| 3 | Shared multi-user machine exposes paths and Claude session IDs if permissions are lax | Medium | Mitigated by 0700/0600 and socket ownership check; reassess if shared |
| 4 | Notification text visible on lock screen or screen share | Low | Name-only default |
| 5 | `claudeSessionId` in registry enables resuming a transcript for anyone with file access | Medium | Owner-only, omitted from default output |
| 6 | Claude Code's own transcripts and Anthropic-side processing are out of `ait`'s control | Informational | Document in README |
| 7 | Audit log retains names and paths after session removal | Low | Rotation plus `--purge-log` |
| 8 | Future features (history search, transcripts, remote sync, mobile notifications) would materially change this assessment | Process | Re-run the PIA before adding any of them |

## 6. Conclusion

The design is privacy-friendly by construction: local-only, no third-party processors, no content persisted, minimal metadata, owner-only permissions, and explicit export and deletion paths. The conditions are the requirements above, especially PRIV-REQ-1, 2, 6, 8, 15, 16, 17 and 19, which must be demonstrated by tests before release.

Verdict: PASS WITH CONDITIONS
