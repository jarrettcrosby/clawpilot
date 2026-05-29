#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/clawd-app-stable.pid"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Fallback: ensure no listener on 4001 remains
if command -v /usr/sbin/lsof >/dev/null 2>&1; then
  PIDS=$(/usr/sbin/lsof -ti tcp:4001 || true)
  if [[ -n "$PIDS" ]]; then
    echo "Killing stale listeners on 4001: $PIDS"
    kill $PIDS || true
    sleep 1
  fi
fi

echo "Stable stopped"