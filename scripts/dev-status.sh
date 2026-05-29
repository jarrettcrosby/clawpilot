#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
PID_FILE="/tmp/clawd-app-dev.pid"
BUILD_STAMP="/tmp/clawd-app-dev.build"
PORT="4002"
DEV_APP_DIR="$DEV_REPO/app_src"

find_port_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

is_dev_runtime_pid() {
  local pid="$1"
  local cwd cmd

  cwd="$(pid_cwd "$pid")"
  cmd="$(pid_command "$pid")"

  if [[ "$cwd" == "$DEV_APP_DIR" || "$cwd" == "$DEV_REPO" || "$cwd" == "$DEV_REPO"/* ]]; then
    return 0
  fi

  if [[ "$cmd" == *"$DEV_APP_DIR"* || "$cmd" == *"$DEV_REPO"* ]]; then
    return 0
  fi

  return 1
}

PID_FROM_FILE=""
if [[ -f "$PID_FILE" ]]; then
  PID_FROM_FILE="$(cat "$PID_FILE" 2>/dev/null || true)"
fi
PID_FROM_PORT="$(find_port_pid)"

if [[ -n "$PID_FROM_FILE" ]] && kill -0 "$PID_FROM_FILE" 2>/dev/null && ! is_dev_runtime_pid "$PID_FROM_FILE"; then
  echo "dev: STOPPED port=$PORT (pid file points to non-dev process pid=$PID_FROM_FILE)"
  exit 0
fi

if [[ -n "$PID_FROM_PORT" ]] && ! is_dev_runtime_pid "$PID_FROM_PORT"; then
  echo "dev: STOPPED port=$PORT (listener on :$PORT is not dev runtime pid=$PID_FROM_PORT)"
  exit 0
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  RUNTIME_JSON="$(curl -s --max-time 2 "http://127.0.0.1:${PORT}/api/runtime" || true)"
  RUNTIME_FIELDS_RAW="$(python3 - <<'PY' "$RUNTIME_JSON"
import json,sys
try:
  j=json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
except Exception:
  j={}
print(j.get('commit',''))
print(str(j.get('lane','')))
print(str(j.get('port','')))
PY
)"
  RUNTIME_COMMIT="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '1p')"
  RUNTIME_LANE="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '2p')"
  RUNTIME_PORT="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '3p')"

  EXPECTED_COMMIT=""
  EXPECTED_SOURCE=""

  if [[ -f "$BUILD_STAMP" ]]; then
    EXPECTED_COMMIT="$(sed -n 's/^commit=//p' "$BUILD_STAMP" | head -n1)"
    EXPECTED_SOURCE="build-stamp"
  fi

  if [[ -z "$EXPECTED_COMMIT" ]] && [[ -d "$DEV_REPO/.git" ]]; then
    EXPECTED_COMMIT="$(git -C "$DEV_REPO" rev-parse HEAD 2>/dev/null || true)"
    EXPECTED_SOURCE="dev-worktree"
  fi

  if [[ -z "$EXPECTED_COMMIT" ]]; then
    EXPECTED_COMMIT="$(git -C "$CONTROL_REPO" rev-parse HEAD 2>/dev/null || true)"
    EXPECTED_SOURCE="control-repo"
  fi

  HEALTH_JSON="$(curl -s --max-time 2 "http://127.0.0.1:${PORT}/api/health" || true)"
  if [[ "$HEALTH_JSON" == *'"status":"ok"'* ]]; then
    HEALTH_STATUS="ok"
  else
    HEALTH_STATUS="degraded"
  fi

  lane_status="ok"
  if [[ "$RUNTIME_LANE" != "" && "$RUNTIME_LANE" != "dev" ]]; then
    lane_status="mismatch:${RUNTIME_LANE}"
  fi

  port_status="ok"
  if [[ "$RUNTIME_PORT" != "" && "$RUNTIME_PORT" != "$PORT" ]]; then
    port_status="mismatch:${RUNTIME_PORT}"
  fi

  if [[ -n "$RUNTIME_COMMIT" && -n "$EXPECTED_COMMIT" && "$RUNTIME_COMMIT" != "$EXPECTED_COMMIT" ]]; then
    echo "dev: RUNNING pid=$(cat "$PID_FILE") port=$PORT health=$HEALTH_STATUS commit_mismatch runtime=${RUNTIME_COMMIT:0:7} expected=${EXPECTED_COMMIT:0:7} lane=$lane_status runtime_port=$port_status source=$EXPECTED_SOURCE"
  elif [[ -n "$RUNTIME_COMMIT" ]]; then
    echo "dev: RUNNING pid=$(cat "$PID_FILE") port=$PORT health=$HEALTH_STATUS commit=${RUNTIME_COMMIT:0:7} lane=$lane_status runtime_port=$port_status"
  else
    echo "dev: RUNNING pid=$(cat "$PID_FILE") port=$PORT health=$HEALTH_STATUS commit=unknown lane=$lane_status runtime_port=$port_status"
  fi
elif [[ -f "$PID_FILE" ]]; then
  echo "dev: STOPPED port=$PORT (stale pid file: $PID_FILE)"
else
  echo "dev: STOPPED port=$PORT"
fi
