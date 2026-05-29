#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/clawd-app-dev.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Dev not running (no pid file)"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" || true
  sleep 1
fi

rm -f "$PID_FILE"
echo "Dev stopped"