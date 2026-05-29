#!/usr/bin/env bash
set -euo pipefail

EXPECTED_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
APP_DIR="$EXPECTED_REPO/app_src"
PORT="4001"
LOG_FILE="/tmp/clawd-app-stable.log"
PID_FILE="/tmp/clawd-app-stable.pid"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$EXPECTED_REPO" ]]; then
  echo "Refusing to start stable app from wrong root: $REPO_ROOT"
  exit 1
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Stable already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

cd "$APP_DIR"
nohup ./node_modules/.bin/next start --port "$PORT" --hostname 0.0.0.0 > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

echo "Stable started on :$PORT (pid $(cat "$PID_FILE"))"
echo "Log: $LOG_FILE"