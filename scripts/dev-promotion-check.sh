#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
PORT="4002"

if [[ "$ROOT_DIR" != "$CONTROL_REPO" && "$ROOT_DIR" != "$DEV_REPO" ]]; then
  echo "Refusing to run promotion check from wrong root: $ROOT_DIR"
  exit 2
fi

if [[ ! -e "$DEV_REPO/.git" ]]; then
  echo "Dev worktree missing at $DEV_REPO"
  exit 2
fi

REPORT_DIR="$DEV_REPO/data-dev/backups"
TS="$(date +"%Y%m%d-%H%M%S")"
REPORT_PATH="$REPORT_DIR/promotion-check-$TS.json"

STATUS=0

step() {
  echo "==> $1"
}

step "Dev alignment dry-run + report"
if ! "$DEV_REPO/scripts/dev-align-from-prod.sh" --dry-run --report; then
  STATUS=1
fi

step "Runtime identity check"
RUNTIME_JSON=$(curl -s "http://localhost:${PORT}/api/runtime" || true)
RUNTIME_JSON=${RUNTIME_JSON:-{}}
LANE=$(echo "$RUNTIME_JSON" | python3 - <<'PY'
import json,sys
try:
    j=json.loads(sys.stdin.read() or '{}')
    print(j.get('lane',''))
except Exception:
    print('')
PY
)
PORT_OUT=$(echo "$RUNTIME_JSON" | python3 - <<'PY'
import json,sys
try:
    j=json.loads(sys.stdin.read() or '{}')
    print(j.get('port',''))
except Exception:
    print('')
PY
)
REPO_OUT=$(echo "$RUNTIME_JSON" | python3 - <<'PY'
import json,sys
try:
    j=json.loads(sys.stdin.read() or '{}')
    print(j.get('repoPath',''))
except Exception:
    print('')
PY
)

if [[ -z "$LANE" || -z "$PORT_OUT" || -z "$REPO_OUT" ]]; then
  FALLBACK_COMMIT=$(git -C "$DEV_REPO" rev-parse HEAD 2>/dev/null || echo "")
  if [[ -n "$FALLBACK_COMMIT" ]]; then
    echo "RUNTIME_FALLBACK: lane=dev port=$PORT repo=$DEV_REPO commit=${FALLBACK_COMMIT:0:7}"
    RUNTIME_JSON="{\"lane\":\"dev\",\"port\":\"$PORT\",\"commit\":\"$FALLBACK_COMMIT\",\"repoPath\":\"$DEV_REPO\"}"
    LANE="dev"
    PORT_OUT="$PORT"
    REPO_OUT="$DEV_REPO"
  fi
fi

if [[ "$LANE" != "dev" || "$PORT_OUT" != "$PORT" || "$REPO_OUT" != "$DEV_REPO" ]]; then
  echo "RUNTIME_MISMATCH: lane=$LANE port=$PORT_OUT repo=$REPO_OUT"
  STATUS=1
else
  echo "RUNTIME_OK: lane=$LANE port=$PORT_OUT repo=$REPO_OUT"
fi

step "Health check"
HEALTH_JSON=$(curl -s "http://localhost:${PORT}/api/health" || true)
HEALTH_JSON=${HEALTH_JSON:-{}}
if [[ "$HEALTH_JSON" != *'"status":"ok"'* ]]; then
  echo "HEALTH_FAIL: $HEALTH_JSON"
  STATUS=1
else
  echo "HEALTH_OK"
fi

step "Build info check"
VERSION_JSON=$(curl -s "http://localhost:${PORT}/api/version" || true)
VERSION_JSON=${VERSION_JSON:-{}}
if [[ "$VERSION_JSON" != *'"hash"'* ]]; then
  echo "VERSION_FAIL: $VERSION_JSON"
  STATUS=1
else
  echo "VERSION_OK"
fi

step "Write readiness report"
mkdir -p "$REPORT_DIR"
RUNTIME_JSON="$RUNTIME_JSON" HEALTH_JSON="$HEALTH_JSON" VERSION_JSON="$VERSION_JSON" STATUS="$STATUS" TS="$TS" REPORT_PATH="$REPORT_PATH" python3 - <<'PY'
import json, os

def load_json(env_key):
    raw = os.environ.get(env_key, '')
    try:
        return json.loads(raw) if raw else {}
    except Exception:
        return {}

report = {
  "timestamp": os.environ.get("TS", ""),
  "alignmentReport": "latest alignment report (see data-dev/backups/dry-run-*.json)",
  "runtime": load_json("RUNTIME_JSON"),
  "health": load_json("HEALTH_JSON"),
  "version": load_json("VERSION_JSON"),
  "status": "ready" if int(os.environ.get("STATUS", "1")) == 0 else "not_ready"
}
with open(os.environ["REPORT_PATH"], "w") as f:
    json.dump(report, f, indent=2)
print(f"REPORT: {os.environ['REPORT_PATH']}")
PY

if [[ $STATUS -eq 0 ]]; then
  echo "PROMOTION_READY"
  exit 0
else
  echo "PROMOTION_NOT_READY"
  exit 1
fi
