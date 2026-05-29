#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4002}"
BASE_URL="http://127.0.0.1:${PORT}"
RUNS_FILE="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/data-dev/agents/execution-runs.jsonl"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

RUN_RESPONSE=$(curl -s "${BASE_URL}/api/execution-selftest?agentId=nonexistent-agent" || true)
RUN_ID=$(python3 - <<'PY' "$RUN_RESPONSE"
import json,sys
try:
  data=json.loads(sys.argv[1])
  print(data.get('runId',''))
except Exception:
  print('')
PY
)

if [[ -z "$RUN_ID" ]]; then
  fail "Execution selftest did not return runId"
fi
ok "selftest runId ${RUN_ID:0:12}"

QUEUE_RESPONSE=$(curl -s "${BASE_URL}/api/execution-queue-selftest?agentId=nonexistent-agent" || true)
QUEUE_RUN_ID=$(python3 - <<'PY' "$QUEUE_RESPONSE"
import json,sys
try:
  data=json.loads(sys.argv[1])
  print(data.get('runId',''))
except Exception:
  print('')
PY
)

if [[ -z "$QUEUE_RUN_ID" ]]; then
  fail "Queue selftest did not return runId"
fi
ok "queue selftest runId ${QUEUE_RUN_ID:0:12}"

# Wait for run records to land (max 20s)
found="0"
for i in {1..20}; do
  if [[ -f "$RUNS_FILE" ]]; then
    if python3 - <<'PY' "$RUNS_FILE" "$RUN_ID" >/dev/null 2>&1
import json,sys
path=sys.argv[1]
run_id=sys.argv[2]
found=False
with open(path,'r',encoding='utf-8') as f:
  for line in f:
    line=line.strip()
    if not line:
      continue
    try:
      rec=json.loads(line)
    except Exception:
      continue
    if rec.get('runId')==run_id:
      found=True
      break
print('found' if found else '')
PY
    then
      if [[ "$(python3 - <<'PY' "$RUNS_FILE" "$RUN_ID"
import json,sys
path=sys.argv[1]
run_id=sys.argv[2]
found=False
with open(path,'r',encoding='utf-8') as f:
  for line in f:
    line=line.strip()
    if not line:
      continue
    try:
      rec=json.loads(line)
    except Exception:
      continue
    if rec.get('runId')==run_id:
      found=True
      break
print('found' if found else '')
PY
)" == "found" ]]; then
        found="1"
        break
      fi
    fi
  fi
  sleep 1
 done

if [[ "$found" != "1" ]]; then
  fail "No execution run records found for ${RUN_ID:0:12}"
fi

python3 - <<'PY' "$RUNS_FILE" "$RUN_ID"
import json,sys
path=sys.argv[1]
run_id=sys.argv[2]
records=[]
with open(path,'r',encoding='utf-8') as f:
  for line in f:
    line=line.strip()
    if not line:
      continue
    try:
      rec=json.loads(line)
    except Exception:
      continue
    if rec.get('runId')==run_id:
      records.append(rec)

statuses=[r.get('status') for r in records]
attempts=[r.get('attempt') for r in records if r.get('attempt') is not None]

required_statuses={'queued','running'}
if not required_statuses.issubset(set(statuses)):
  raise SystemExit(f"Missing required statuses: {required_statuses - set(statuses)}")

if not any(s in {'failed','timed_out','completed'} for s in statuses):
  raise SystemExit("Missing terminal status (failed/timed_out/completed)")

if 1 not in attempts or 2 not in attempts:
  raise SystemExit("Retry attempts not observed (expected attempts 1 and 2)")

print("Execution flow verification passed")
PY

ok "execution queue/retry verified"

# Execution-runs API retrieval semantics (must include selftest run records)
RUNS_API=$(curl -s "${BASE_URL}/api/execution-runs?runId=${RUN_ID}&limit=20" || true)
RUN_MATCHES=$(python3 - <<'PY' "$RUNS_API" "$RUN_ID"
import json,sys
payload=sys.argv[1]
run_id=sys.argv[2]
try:
  data=json.loads(payload)
except Exception:
  print('parse_error')
  raise SystemExit(0)
entries=data.get('entries')
if not isinstance(entries,list):
  print('bad_entries')
  raise SystemExit(0)
if len(entries)==0:
  print('empty')
  raise SystemExit(0)
count=sum(1 for e in entries if isinstance(e,dict) and e.get('runId')==run_id)
print(count)
PY
)
if [[ "$RUN_MATCHES" == "parse_error" || "$RUN_MATCHES" == "bad_entries" ]]; then
  fail "execution-runs API returned invalid payload for runId query"
fi
if [[ "$RUN_MATCHES" == "empty" ]]; then
  fail "execution-runs API returned empty entries for selftest run ${RUN_ID:0:12}"
fi
if [[ "$RUN_MATCHES" -lt 1 ]]; then
  fail "execution-runs API did not include selftest runId ${RUN_ID:0:12}"
fi
ok "execution-runs API returned selftest run records"

QUEUE_RUNS_API=$(curl -s "${BASE_URL}/api/execution-runs?runId=${QUEUE_RUN_ID}&limit=20" || true)
QUEUE_MATCHES=$(python3 - <<'PY' "$QUEUE_RUNS_API" "$QUEUE_RUN_ID"
import json,sys
payload=sys.argv[1]
run_id=sys.argv[2]
try:
  data=json.loads(payload)
except Exception:
  print('parse_error')
  raise SystemExit(0)
entries=data.get('entries')
if not isinstance(entries,list):
  print('bad_entries')
  raise SystemExit(0)
if len(entries)==0:
  print('empty')
  raise SystemExit(0)
count=sum(1 for e in entries if isinstance(e,dict) and e.get('runId')==run_id)
print(count)
PY
)
if [[ "$QUEUE_MATCHES" == "parse_error" || "$QUEUE_MATCHES" == "bad_entries" ]]; then
  fail "execution-runs API returned invalid payload for queue selftest runId query"
fi
if [[ "$QUEUE_MATCHES" == "empty" ]]; then
  fail "execution-runs API returned empty entries for queue selftest run ${QUEUE_RUN_ID:0:12}"
fi
if [[ "$QUEUE_MATCHES" -lt 1 ]]; then
  fail "execution-runs API did not include queue selftest runId ${QUEUE_RUN_ID:0:12}"
fi
ok "execution-runs API returned queue selftest run records"
