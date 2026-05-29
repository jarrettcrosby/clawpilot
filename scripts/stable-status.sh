#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/clawd-app-stable.pid"
PORT="4001"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "stable: RUNNING pid=$(cat "$PID_FILE") port=$PORT"
else
  echo "stable: STOPPED port=$PORT"
fi