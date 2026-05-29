# Controlled Production Rollout Protocol (Go-Live + First 24h)

Status: Active (production rollout mode)
Owner: Jarrett (operator) + ClawPilot (automation)
Scope: Operations only (no feature changes)

## 0) Immediate go-live checks (T+0 to T+15m)
Run in order. Any fail => incident mode.

Precondition: final gate in `docs/operations/FINAL_PRODUCTION_GATE.md` must be passed, including canonical dev→prod promotion flow.

1. **Stable runtime truth (4001)**
- `curl -sS http://127.0.0.1:4001/api/health` => status ok
- `curl -sS http://127.0.0.1:4001/api/runtime` must include:
  - `lane=stable`
  - `repoPath=/Users/agentsuburbiasandwich/Desktop/clawd-app`
  - `port=4001`
- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/` => non-5xx

2. **Watchdog evidence path**
- Confirm scheduler job exists and enabled (`stable-runtime-watchdog-120s`).
- Confirm latest watchdog entry exists in:
  - `data-dev/logs/stable-runtime-watchdog.jsonl`

3. **Agent chat path health (sanity)**
- In app: open a task-linked chat from Projects/Agents.
- Confirm selected task + assigned product agent are visible.
- Send one test message and confirm reply appears (no silent failure notice).

4. **Task creation governance sanity**
- Confirm dashboard shows task creation telemetry:
  - Tasks created (24h)
  - Last task created (source/actor)
- Confirm creation audit file is updating:
  - `data-dev/task-creation-audit.jsonl`

5. **Dashboard/operator sanity**
- Dashboard loads without spinner lock.
- Do This Now panel and completion reconciliation render.
- Projects board loads active cards as expected.

## 1) First 24h monitoring cadence

### Every 15 minutes (first 2 hours)
- Check stable runtime truth (same 3 checks above).
- Check watchdog logs for incidents in last 15m.
- Confirm no unexplained spike in task creation audit.

### Every 60 minutes (hour 3 to hour 24)
- Repeat stable runtime truth checks.
- Review watchdog logs + alert log:
  - `data-dev/logs/stable-runtime-watchdog.jsonl`
  - `data-dev/logs/stable-runtime-watchdog-alerts.log`
- Run lightweight app sanity pass (Dashboard + Projects + task-linked chat).

## 2) Rollback triggers (explicit)
Rollback immediately if any of the following are true:

1. Stable invariant breach persists >5 minutes after watchdog recovery attempt:
- `/api/health` not 200, or
- `/api/runtime` lane/repo/port mismatch, or
- root `/` returns 5xx.

2. Repeated watchdog hard failures:
- `STABLE_HARD_FAILURE` occurs 2+ times in 30 minutes.

3. Critical operator workflow broken:
- task-linked agent chat unusable,
- Projects board cannot load active tasks,
- dashboard/operator sanity checks fail repeatedly.

## 3) Incident response steps (operator-friendly)
1. Declare incident + freeze non-essential changes.
2. Capture latest evidence:
- last 20 lines of watchdog jsonl
- last 20 lines of watchdog alerts log
- current `/api/runtime`, `/api/health`, root status code
3. Attempt canonical recovery once:
- `scripts/stable-runtime-watchdog.sh`
4. If still failing, execute rollback trigger decision.
5. Notify operator (Jarrett) with:
- impact
- failed invariant(s)
- actions taken
- current state (recovered / rollback needed)
6. Log incident summary in `docs/operations/` (timestamped note).

## 4) Exit criteria after 24h
Rollout is considered stable if all are true:
- No unresolved stable runtime incidents.
- No persistent watchdog hard-failure pattern.
- Operator sanity checks remain green.
- Task creation governance/audit remained expected and explainable.
