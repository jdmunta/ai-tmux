# SRE Runbook: WO-C2E5A3 "AI tmux" (`ait`)

## 0. Assumptions and release status

- **Shape of the service.** `ait` is a single-user, single-machine tool: Node 22 CLI and TUI over tmux (`-L ait`). It has no server in normal use. The only deployable piece is the optional HTTP API (`npm start`, port 3000, `GET /health`), which I assume is hosted on Railway as a health-checked API shell. The dashboard, tmux and `claude` do not work in a container.
- **Monitoring.** There is no hosted telemetry, by design. "Dashboards" and "alerts" are local commands, logs and a small watcher script. Railway provides health and log monitoring for the API only.
- **Release gate.** Do not declare the service production-ready or expose the API publicly until these are closed:
  1. One unidentified failing unit test (170/171).
  2. SR-01 (Critical): CSRF and DNS rebinding on the API.
  3. SR-02 (High): bind to `0.0.0.0`, loopback trusted without a token.
  4. QA D2: a row stays `waiting` after a permission approval.
  5. Gate results (baseline, kill-or-shrink verdict, hook spike) are unrecorded.
- **Interim control.** If the API is run at all, `AIT_API_TOKEN` (32+ random bytes) is mandatory. Never open the API URL in a browser session that holds the token.

## 1. Service overview and ownership

| Item | Detail |
|---|---|
| Purpose | See, get alerted about, and jump between parallel Claude Code sessions. |
| Components | `ait` CLI and dashboard; `ait-hook.js` (Claude hooks write `events/<name>.json`); tmux server on socket `ait`; optional HTTP API (`bin/serve.js`). |
| State | `AIT_HOME` (default `~/.local/state/ait`, dir 0700, files 0600): `registry.json`, `events/`, `settings/`, `audit.log`, `hook-errors.log`, `dashboard.lock`. |
| Dependencies | tmux ≥ 3.2, Node 22, `claude` on PATH (absolute, not world-writable), Claude Code hooks and `--settings`, optional `osascript`/`notify-send`. |
| Data sensitivity | Local only. Pane text is memory-only and never persisted. Claude session IDs are medium sensitivity. |
| Owner | The requester (service owner and sole on-call). |
| SRE | Maintains this runbook, SLOs and the watcher. |
| Deployed API (if any) | Railway service `ait-api` with a volume at `/data`. |

## 2. SLIs and SLOs

Measured over a rolling 7-day window (matching the dogfood week).

| # | SLI | How measured | SLO |
|---|---|---|---|
| 1 | **Waiting recall**: true needs-decision transitions shown as `waiting` | Manual 20-transition test, plus the "missed waiting" note log | **100%** hook path; ≥ 98% fallback |
| 2 | **State accuracy** | Same test, all transitions | ≥ 95% |
| 3 | **Detection latency**: event to correct display | Timestamp of hook event vs. dashboard redraw | p95 ≤ 2 s |
| 4 | **False-waiting rate** | Review of alerts | ≤ 10% hook, ≤ 20% fallback; ≤ 3 false alerts/day |
| 5 | **Notify-once**: notifications per waiting transition | Review of alerts | Exactly 1; 0 if attached or cleared within 500 ms |
| 6 | **Time to reach a session** | Stopwatch sample | < 3 s, one keystroke |
| 7 | **Hook health**: sessions on hook source (not fallback) | `ait ls --json` | ≥ 70% of session-hours |
| 8 | **Dashboard availability**: start or attach succeeds | `ait` exit code 0 | 99% of attempts |
| 9 | **API availability** (if deployed) | Railway healthcheck on `/health` | 99.5% monthly |
| 10 | **API 5xx rate** (if deployed) | Railway logs | < 1% of authorised requests |
| 11 | **Control-surface safety** | `npm test` (static scans) | 0 uses of `send-keys`, `paste-buffer`, `run-shell`, `pipe-pane`, or shell strings |

**Error budget.** For SLO 1 the budget is zero. Any missed `waiting` opens an incident (Sev-2) and triggers a rollback decision (section 7). For SLO 9 the monthly budget is about 3.6 h of downtime.

## 3. Dashboards and key metrics

There is no hosted dashboard. These are the "dashboards":

| View | Command | What to read |
|---|---|---|
| Live session view | `ait` | Waiting count in header, `[stale]` marker, "fallback mode" banner |
| Machine-readable state | `ait ls --json` | `stale`, `degraded`, `counts`, each session's `source` (`hook` or `fallback`) and `since` |
| Environment health | `ait doctor` | tmux version, claude path, `--settings` support, prefix, socket ownership, state dir modes, remaining state |
| Audit trail | `tail -n 50 ~/.local/state/ait/audit.log` | `new/kill/rm/rename/open` with result |
| Hook errors | `tail -n 50 ~/.local/state/ait/hook-errors.log` | Hook failures and dropped events |
| tmux server | `tmux -L ait ls` | Sessions alive on the dedicated socket |
| API (Railway) | `railway logs`, `curl -s $URL/health` | Startup line `ait API listening on port <PORT>`, 401/403/503 counts |

**Key metrics to note weekly:**

- Share of sessions on `source: fallback`.
- Count of `hook-errors.log` lines.
- Count of "no event within 10 s" occurrences.
- Missed-waiting notes.
- False alerts per day.
- Size of `audit.log`.

**Optional watcher.** Run it from cron every 5 minutes. It needs `jq`:

```bash
#!/bin/sh
# ait-watch.sh: prints a line per problem; wire to cron or a notifier.
out=$(ait ls --json 2>/dev/null) || { echo "AIT-DOWN: ait ls failed"; exit 1; }
echo "$out" | jq -e '.stale' >/dev/null && echo "AIT-STALE: tmux unreachable"
echo "$out" | jq -e '.degraded' >/dev/null && echo "AIT-DEGRADED: fallback detection active"
echo "$out" | jq -r '.sessions[] | select(.state=="waiting") | "AIT-WAITING-LONG: \(.name) since \(.since)"' \
  | while read -r l; do echo "$l"; done
```

## 4. Alerts

Severities: **Sev-1** (data loss or security exposure), **Sev-2** (core goal broken), **Sev-3** (degraded), **Sev-4** (info).

| Alert | Condition | Severity | First action |
|---|---|---|---|
| `MissedWaiting` | User reports a session was blocked and the dashboard did not show `waiting` | Sev-2 | Run `ait ls --json`, check the session's `source`; save `events/<name>.json`; go to FM-1 or FM-2 |
| `StaleWaitingRow` | A row stays `waiting` after you approved a prompt (known defect D2) | Sev-3 | Press the next prompt or wait for `Stop`; record it; fix is the `PreToolUse`/`PostToolUse` mapping |
| `HooksSilent` | `source: fallback` or "fallback mode" banner for a session older than 10 s | Sev-3 | `ait doctor` (check `--settings flag`), `tail hook-errors.log`; go to FM-2 |
| `FallbackShareHigh` | Fallback > 30% of session-hours after a Claude Code update | Sev-2 | Roll back Claude Code or run the hook spike again; see FM-2 and rollback trigger 3 |
| `TmuxUnreachable` | Header shows `[stale]` or `ait ls` returns `stale: true` for > 10 s | Sev-3 | `tmux -L ait ls`; go to FM-3 |
| `DashboardWontStart` | `ait` exits non-zero | Sev-3 | Read the stderr message and exit code; go to FM-4, FM-5 or FM-6 |
| `RegistryCorrupt` | Banner "session registry was unreadable" | Sev-3 | Go to FM-7 |
| `SocketNotPrivate` | `ait doctor` shows `NOT PRIVATE` or the CLI says "tmux socket folder is not private" | Sev-2 | `chmod 700 /tmp/tmux-$(id -u)`; go to FM-5 |
| `NotifyFlood` | More than 3 false alerts/day for 2 days, or 10 desktop notices in a minute | Sev-3 | Check `AIT_NOTIFY_IDLE`; run `ait ls --json`; go to FM-9 |
| `ForbiddenTmuxCommand` | `npm test` static scan fails (`send-keys`, shell strings) | Sev-1 | Stop using the build; revert the change; do not merge |
| `BuildRed` | `npm test` has any failure | Sev-2 (release blocker) | `node --test --test-reporter=spec test/*.test.js 2>&1 \| grep -B2 -A25 "not ok"`; fix the root cause, never weaken the assertion |
| `ApiHealthDown` | Railway healthcheck on `/health` fails for 2 min | Sev-2 | `railway logs`; go to FM-11 |
| `ApiUnexpectedAccess` | Any 200 on a non-health route without your token, or a launch/purge you did not make in `audit.log` | **Sev-1** | Take the API down (`railway down`), rotate the token, go to FM-12 |
| `ApiNoToken403` | All non-health routes return 403 | Sev-3 | `AIT_API_TOKEN` missing; set it (FM-11) |
| `GateEvidenceMissing` | README gate results still say "record here" | Sev-3 | Run the baseline, kill-or-shrink and hook spike; record results |

## 5. Common failure modes

Commands assume `ait` is on your PATH. `S=~/.local/state/ait` (or your `AIT_HOME`).

### FM-1. A waiting session was not shown or alerted

**Diagnose**
```bash
ait ls --json | jq '.sessions[] | {name,state,kind,source,degraded,since}'
cat "$S/events/<name>.json"          # last hook event
tmux -L ait capture-pane -p -t '=ait-<name>:' -S -40   # what the pane shows now
```
**Cause and fix**
- The event file is old, or the session is on `fallback`: go to FM-2.
- The state is `waiting` but there was no sound: the bell did not reach the terminal. Go to FM-8.
- Attached sessions never alert. This is by design.
- The state was `waiting` for under 500 ms. This is debounce by design.

### FM-2. Hooks not firing, so the session is on fallback

**Diagnose**
```bash
ait doctor                                  # "--settings flag": supported?
tail -n 30 "$S/hook-errors.log"
cat "$S/settings/<name>.json"               # four hooks present?
ls -l "$S/events/"
claude --version
```
**Fix**
1. If `--settings` is not supported, update Claude Code, then restart the session: `ait kill <name> --yes && ait new <name> <dir>`.
2. If the settings file is missing or edited, kill and relaunch (a new file is written with a verified hash).
3. If `hook-errors.log` shows permission or path errors: `ait doctor`, then `chmod 700 "$S" "$S/events" "$S/settings"`.
4. Until fixed, treat the fallback labels as degraded and prefer false `waiting` over trust in `idle`.

### FM-3. tmux unreachable, `[stale]` in the header

```bash
tmux -V                         # must be ≥ 3.2
tmux -L ait ls                  # "no server running" = normal if no sessions
pgrep -fl "tmux -L ait"
```
- "No server running" with an empty registry is normal.
- If the server hangs (calls time out at 2 s), find its PID and stop it. This ends all sessions, so see FM-10 first:
  ```bash
  tmux -L ait kill-server
  ```
- The dashboard recovers on its own within about 2 s once tmux answers.

### FM-4. Dashboard already running, or a stale lock

```bash
cat "$S/dashboard.lock"; ps -p "$(cat "$S/dashboard.lock")" -o command=
```
- If the PID is alive and its command is `ait`, attach with `tmux -L ait attach -t =ait-dash`.
- If the PID is dead or unrelated, remove the lock: `rm -f "$S/dashboard.lock"`, then run `ait`.

### FM-5. Socket folder not private (exit 7)

```bash
ls -ld /tmp/tmux-$(id -u)
chmod 700 /tmp/tmux-$(id -u)
ait doctor
```
Make sure the folder is owned by you. If it is owned by another user, stop and investigate before continuing (Sev-2).

### FM-6. tmux missing or too old (exit 10)

```bash
brew install tmux        # macOS
# or: sudo apt-get install tmux
tmux -V
```

### FM-7. Corrupt registry

The tool backs up the bad file to `registry.json.bak` and starts empty. Live tmux sessions stay running but become untracked.

**Restore**
```bash
ls -l "$S/registry.json" "$S/registry.json.bak"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$S/registry.json.bak" && echo valid
cp -p "$S/registry.json.bak" "$S/registry.json" && chmod 600 "$S/registry.json"
ait ls
```
If the backup is also invalid, rebuild by hand: run `ait export` from a good copy, or kill and relaunch the sessions.

### FM-8. Bell not heard

```bash
printf '\a'                                     # does the terminal beep?
tmux -L ait show -gv bell-action
tmux -L ait set -g bell-action any              # only on the ait server
```
Check terminal settings (audible bell) and Do Not Disturb. Over SSH there is no desktop notice. Set `AIT_DESKTOP=0` for a bell-only setup. Record the result in the README gate section.

### FM-9. Too many alerts

```bash
env | grep ^AIT_NOTIFY
unset AIT_NOTIFY_IDLE          # idle alerts are off by default
ait ls --json | jq '.sessions[] | {name,state,source}'
```
A flapping fallback session is the usual cause: fix hooks (FM-2). The tool caps desktop notices at 10/min.

### FM-10. Reboot or crash: sessions gone

tmux sessions end, and Claude conversations remain resumable by hand.
```bash
ait ls                                   # shows DONE (exit -1) for lost sessions
ait rm <name>                            # clear the entry
ait new <name> <dir> -- --resume         # relaunch; pass resume flags to claude
```
The registry keeps dir and Claude session ID (use `ait ls --json --verbose`).

### FM-11. API problems on Railway

```bash
railway logs
curl -si $URL/health                              # 200 {"status":"ok"}
curl -si -H "Authorization: Bearer $TOKEN" $URL/sessions
```
| Symptom | Cause | Fix |
|---|---|---|
| 403 on all non-health routes | `AIT_API_TOKEN` unset | `railway variables --set "AIT_API_TOKEN=$(openssl rand -hex 32)"`, then `railway up --detach` |
| 401 with the right token | Wrong or rotated token | Re-read the variable and retry |
| 503 `{"error":10}` | No tmux in the image | Expected without the Dockerfile; add tmux or accept `/health` only |
| 424 on `POST /sessions` | `claude` not in the container | Expected; use `ait` locally |
| Registry lost after redeploy | No volume | `railway volume add --mount-path /data` and set `AIT_HOME=/data/ait` |
| Crash loop | Bad `PORT` or unwritable `AIT_HOME` | Check logs; the server falls back to 3000 for an invalid `PORT` |

### FM-12. Suspected unauthorised API use (Sev-1)

1. Contain: `railway down` (or unset the public domain).
2. Review:
   ```bash
   tail -n 200 "$S/audit.log"
   tmux -L ait ls
   ```
   Look for sessions you did not launch, especially any using permission-skipping flags (`ait ls --json --verbose | jq '.sessions[] | {name,args,dir}'`).
3. Stop rogue sessions: `ait kill <name> --yes`.
4. Rotate: a new `AIT_API_TOKEN`; assume the old one and any inherited environment values are exposed (tmux sessions inherit the starting process's environment, SR-05). Rotate other secrets from that shell.
5. Preserve evidence, then `ait export --out ./ait-incident-export.json`.
6. Do not redeploy the API until SR-01 and SR-02 are fixed.

## 6. Rollback procedure

**Local tool (nothing global was modified):**
```bash
# 1. Quit the dashboard (q). Sessions keep running.
# 2. Optional safety copy
ait export --out ~/ait-backup-$(date +%Y%m%d).json
# 3. Stop the managed sessions and the ait tmux server
tmux -L ait kill-server
# 4. Remove ait state (only files ait created)
ait purge --confirm purge
# 5. Remove the CLI if wanted
npm unlink -g ait
```
Then return to plain terminals or plain tmux with `monitor-activity` / `choose-tree -s`.

**Rollback triggers** (from the evaluation plan; any one is enough):
1. One missed `waiting` not explained and fixed within 24 h.
2. Any `send-keys`-style action or injection failure, even once.
3. Fallback share above 30% of session-hours after a Claude Code update, unfixed after one day.
4. More than 3 false alerts per day for 2 consecutive days.
5. You go back to scanning terminals by hand (trust lost).

**To a previous code version:** `git checkout <good-tag>`, `npm test`, then `npm link`. Existing sessions keep their old hook script path, so relaunch them if the hook script moved.

**API on Railway:**
```bash
railway redeploy          # or pick a previous deployment in the dashboard
railway down              # remove the latest deployment (takes the API offline)
```
State lives on the volume, and `POST /purge` with `{"confirm":"purge"}` wipes it.

## 7. Scaling and capacity

- **Design range:** 3–8 sessions; ceiling in the tens. Number hotkeys cover ids 1–9, beyond that use the arrow keys.
- **Load per session:** one `list-panes` call per second (shared), `fs.watch` on `events/`, one `capture-pane` of 40 lines only in fallback mode.
- **Watch for:** dashboard CPU above an agreed share at 8 sessions (check with `ps -o %cpu,command -p $(cat "$S/dashboard.lock")`), tmux calls timing out (`[stale]`), and slow redraw.
- **Disk:** `audit.log` and `hook-errors.log` rotate at 1 MiB (one backup). `events/` and `settings/` hold one small file per session. Clean up DONE rows with `ait rm`.
- **If capacity is exceeded:** reduce fallback sessions (fix hooks), poll less often, or split work across two `AIT_HOME` and `AIT_SOCKET` pairs.
- **API:** single instance, serial mutating requests, no request timeouts or connection cap yet (SR-06). Do not scale horizontally. Each replica would need its own tmux and volume, so keep one replica.

## 8. On-call and escalation

Solo project: the owner is the only responder, so escalation is by severity and by who can fix the cause.

| Level | Who | When | Response target |
|---|---|---|---|
| L1 | Owner (on-call) | Any alert | Sev-1: immediately; Sev-2: same day; Sev-3: within 2 working days |
| L2 | Developer station (code fix) | Defect confirmed (e.g. D2, SR-01, failing test) | Sev-1/2: fix before next use or the API stays down |
| L3 | Security Reviewer / Threat Modeler | Suspected exposure, new HTTP surface | Before any public exposure |
| External | Anthropic (Claude Code), tmux maintainers, Railway support | Hook payload or flag changes; platform outage | As available |

Escalate to L2 when the same alert recurs twice in a week or when a fix needs a code change. Name a backup contact if the tool is ever shared. Until then, a Sev-1 means stop using the API.

## 9. Backup and restore

**What to back up:** `registry.json`, `audit.log`, and the per-session `settings/` hashes (via export). Event files are transient. Never back up pane text, because none is stored.

```bash
# Backup (0600 file, refuses to overwrite)
ait export --out ~/ait-backup-$(date +%Y%m%d).json
# or a raw copy, preserving modes
umask 077; cp -p "$S/registry.json" ~/registry.json.$(date +%Y%m%d)
```

**Restore**
```bash
ait doctor                                    # creates the state dir with correct modes
cp -p ~/registry.json.<date> "$S/registry.json" && chmod 600 "$S/registry.json"
ait ls                                         # sessions whose tmux session is gone show DONE
ait rm <name>                                  # clear dead entries, then relaunch with ait new
```
The export JSON contains `claudeSessionId` and `args`: keep it private and delete it when done. Settings files are regenerated at launch, so they need no restore.

**Recovery targets:** RPO is the last export (take one before upgrades and purges); RTO is under 10 minutes. Running sessions cannot be restored after a reboot, but conversations can be resumed (FM-10).

**API volume (Railway):** the same state as above under `/data/ait`. Take `GET /export` with the token before redeploys or purges:
```bash
curl -s -H "Authorization: Bearer $TOKEN" $URL/export > ait-api-export.json && chmod 600 ait-api-export.json
```

## 10. Incident checklist

1. **Declare and classify:** severity, start time, who is responding.
2. **Contain:** if security-related, stop the API (`railway down`), stop using the dashboard for risky sessions, and do not approve prompts you did not expect.
3. **Preserve evidence** before cleanup:
   ```bash
   ait ls --json --verbose > incident-ls.json
   cp -p "$S/audit.log" "$S/hook-errors.log" .
   cp -rp "$S/events" ./incident-events
   ```
4. **Diagnose:** `ait doctor`, then the matching FM section above.
5. **Mitigate:** apply the fix or roll back (section 6). Do not weaken tests or checks to get green.
6. **Verify:** `npm test` (171/171), `ait doctor`, one live waiting transition per session type, and `curl $URL/health` if the API is deployed.
7. **Communicate:** note the impact and the state of the gate results in the README.
8. **Follow-ups:** open a ticket for each root cause; add a golden-set case for any missed or spoofed state.
9. **Postmortem** within 3 working days for Sev-1 and Sev-2.

## 11. Postmortem template

```markdown
# Postmortem: <title>
- Date / duration: 
- Severity: Sev-_
- Author / reviewers: 
- Status: draft | reviewed | actions complete

## Summary
One paragraph: what happened, who/what was affected, how it ended.

## Impact
- Sessions affected / alerts missed or false:
- SLO or error budget consumed (SLO #, amount):
- Data or security exposure (yes/no, what):

## Timeline (local time)
| Time | Event |
|---|---|
| | Detection (alert or user note) |
| | Containment |
| | Mitigation / rollback |
| | Resolution and verification |

## Root cause
Technical cause and contributing factors (config, Claude Code version, tmux version, missing test).

## Detection
How was it found? Could an alert have found it sooner? Time to detect:

## What went well / what went poorly / where we got lucky

## Evidence
Commands run, log excerpts (sanitised; no tokens, no pane text), export file location.

## Action items
| # | Action | Owner | Priority | Due | Ticket |
|---|---|---|---|---|---|
| 1 | Fix (code/config) | | | | |
| 2 | Add test or golden-set case | | | | |
| 3 | Add or tune alert | | | | |
| 4 | Update runbook / README | | | | |

## Lessons
```

## 12. Open items for the owner

1. Close the release blockers in section 0 before any public API exposure.
2. Identify and fix the failing unit test without weakening it.
3. Record the baseline, kill-or-shrink verdict, hook spike and bell-delivery check in the README.
4. Replace the hardcoded `doctor` fields (`notificationKindsDistinguished`, `worldWritable`, `returnKeyCollision`) with real checks. Until then, do not rely on them.
5. Decide whether to keep `ait-watch.sh` and an audit trail beyond the pilot.
