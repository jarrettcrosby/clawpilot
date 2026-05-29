#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTROL_REPO="${CONTROL_REPO:-$REPO_ROOT}"
DEV_CHECK="${DEV_CHECK:-/Users/agentsuburbiasandwich/.openclaw/workspace/scripts/check-dev-4002.sh}"
DEV_START="${DEV_START:-$CONTROL_REPO/scripts/dev-start.sh}"
LOG_PATH="${LOG_PATH:-$CONTROL_REPO/data-dev/logs/dev-runtime-watchdog.jsonl}"
CHECK_OUT="${CHECK_OUT:-/tmp/dev-watchdog-check.out}"
CHECK2_OUT="${CHECK2_OUT:-/tmp/dev-watchdog-check2.out}"
RESTART_OUT="${RESTART_OUT:-/tmp/dev-watchdog-restart.out}"

mkdir -p "$(dirname "$LOG_PATH")"
now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

append_json() {
  python3 - <<'PY' "$LOG_PATH" "$1"
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); obj=json.loads(sys.argv[2])
with p.open('a', encoding='utf-8') as f:
  f.write(json.dumps(obj)+"\n")
PY
}

if "$DEV_CHECK" >"$CHECK_OUT" 2>&1; then
  append_json "$(python3 - <<'PY' "$now"
import json,sys
print(json.dumps({"timestamp":sys.argv[1],"event":"dev_watchdog_check","status":"healthy"}))
PY
)"
  echo "DEV_OK"
  exit 0
fi

before="$(tail -n 1 "$CHECK_OUT" 2>/dev/null || true)"
"$DEV_START" >"$RESTART_OUT" 2>&1 || true

if "$DEV_CHECK" >"$CHECK2_OUT" 2>&1; then
  append_json "$(python3 - <<'PY' "$now" "$before"
import json,sys
print(json.dumps({"timestamp":sys.argv[1],"event":"dev_watchdog_incident","status":"recovered","reason":sys.argv[2]}))
PY
)"
  echo "DEV_RECOVERED"
  exit 0
fi

after="$(tail -n 1 "$CHECK2_OUT" 2>/dev/null || true)"
append_json "$(python3 - <<'PY' "$now" "$before" "$after"
import json,sys
print(json.dumps({"timestamp":sys.argv[1],"event":"dev_watchdog_incident","status":"hard_failure","before":sys.argv[2],"after":sys.argv[3]}))
PY
)"
echo "DEV_HARD_FAILURE"
exit 2
