# Stable Runtime Watchdog Proof (Green) — 2026-03-18

## Continuous activation
Watchdog is running automatically every 120 seconds:
- Job ID: `ddf6712f-d991-42ab-9209-0524d79f5b93`
- Name: `stable-runtime-watchdog-120s`
- Schedule: `everyMs=120000`
- Command: `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/stable-runtime-watchdog.sh`

## Controlled failure simulation (unattended recovery)
Simulation steps:
1. stop stable runtime (`stable-stop.sh`)
2. start non-stable process on 4001 (`python3 /tmp/fake4001.py`)
3. run watchdog once

### Before (failed state)
- Fake process listening on 4001 (PID `2651`)
- Runtime check from fake process: `{"lane":"dev","repoPath":"/tmp/fake","port":"4001"}`
- Root (`/`) returned `500`

### Watchdog action
- Detected invalid ownership/state
- Killed wrong process on 4001
- Ran deterministic recovery (`stable-stop.sh` → kill 4001 listeners → `stable-start.sh`)

### After (recovered state)
- Watchdog output: `STABLE_RECOVERED`
- `/api/health` = `200`
- `/api/runtime` = lane `stable`, repoPath `/Users/agentsuburbiasandwich/Desktop/clawd-app`, port `4001`
- `/` = `200` (non-5xx)

## Timestamped evidence
From `data-dev/logs/stable-runtime-watchdog.jsonl`:
- `2026-03-18T21:44:18Z` status=`recovered`
- `killedProcesses` includes:
  - pid `2651`
  - command `/opt/homebrew/.../Python /tmp/fake4001.py`
  - reason `wrong_owner_on_4001`
- `after` invariants:
  - `healthCode: 200`
  - `runtimeCode: 200`
  - `runtimeLane: stable`
  - `runtimeRepoPath: /Users/agentsuburbiasandwich/Desktop/clawd-app`
  - `runtimePort: 4001`
  - `rootCode: 200`

From `data-dev/logs/stable-runtime-watchdog-alerts.log`:
- `2026-03-18T21:44:20Z [WARN] STABLE_RECOVERED: watchdog recovered 4001 automatically`

## Conclusion
Stable watchdog now demonstrates unattended end-to-end detection + ownership enforcement + automatic recovery with all required post-recovery invariants green.
