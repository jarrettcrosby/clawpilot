#!/bin/bash
# ClawPilot App Keepalive with atomic restart and PID file
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$APP_DIR/app_src"
PORT=4001
LOG_FILE="/tmp/clawd-app.log"
KEEPALIVE_LOG="/tmp/clawd-app-keepalive.log"
PID_FILE="/tmp/clawd-app.pid"

port_is_free() {
  python3 - <<'PY'
import socket, sys
host="0.0.0.0"
port=4001
s=socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind((host, port))
    s.close()
    sys.exit(0)
except OSError:
    sys.exit(1)
PY
}

stop_existing() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
      echo "$(date): stopping PID $PID (SIGTERM)" >> "$KEEPALIVE_LOG"
      kill -TERM "$PID" 2>/dev/null || true

      if command -v pgrep >/dev/null 2>&1; then
        CHILDREN=$(pgrep -P "$PID" || true)
        if [ -n "${CHILDREN:-}" ]; then
          echo "$CHILDREN" | xargs kill -TERM 2>/dev/null || true
        fi
      fi

      for _ in $(seq 1 20); do
        if ! kill -0 "$PID" 2>/dev/null; then
          break
        fi
        sleep 1
      done

      if kill -0 "$PID" 2>/dev/null; then
        echo "$(date): forcing PID $PID (SIGKILL)" >> "$KEEPALIVE_LOG"
        kill -KILL "$PID" 2>/dev/null || true
        if command -v pgrep >/dev/null 2>&1; then
          CHILDREN=$(pgrep -P "$PID" || true)
          if [ -n "${CHILDREN:-}" ]; then
            echo "$CHILDREN" | xargs kill -KILL 2>/dev/null || true
          fi
        fi
      fi
    fi

    if [ -n "${PID:-}" ] && ! kill -0 "$PID" 2>/dev/null; then
      rm -f "$PID_FILE"
    fi
  fi

  pkill -TERM -f "next-server.*--port $PORT" 2>/dev/null || true
  pkill -TERM -f "npm start.*--port $PORT" 2>/dev/null || true
  sleep 1
  pkill -KILL -f "next-server.*--port $PORT" 2>/dev/null || true
  pkill -KILL -f "npm start.*--port $PORT" 2>/dev/null || true

  ps aux | grep -E "next-server|npm start|4001" | grep -v grep >> "$KEEPALIVE_LOG" || true
}

wait_port_clear() {
  i=0
  while [ "$i" -lt 50 ]; do
    if port_is_free; then
      return 0
    fi
    if [ $((i % 2)) -eq 0 ]; then
      echo "$(date): waiting for port ${PORT} to clear..." >> "$KEEPALIVE_LOG"
    fi
    sleep 0.5
    i=$((i+1))
  done

  echo "$(date): port ${PORT} still in use after timeout" >> "$KEEPALIVE_LOG"
  ps aux | grep -E "next-server|npm start|4001" | grep -v grep >> "$KEEPALIVE_LOG" || true
  return 1
}

if ! port_is_free; then
  echo "$(date): clawd-app already listening on ${PORT}" >> "$KEEPALIVE_LOG"
  exit 0
fi

echo "$(date): clawd-app down on ${PORT}, restarting from ${SRC_DIR}" >> "$KEEPALIVE_LOG"
stop_existing
if ! wait_port_clear; then
  echo "$(date): restart aborted due to busy port ${PORT}" >> "$KEEPALIVE_LOG"
  exit 1
fi

cd "$SRC_DIR"
nohup npm start -- --port "$PORT" --hostname 0.0.0.0 >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

if command -v pgrep >/dev/null 2>&1; then
  for _ in $(seq 1 10); do
    CHILD=$(pgrep -P "$PID" | head -n 1 || true)
    if [ -n "${CHILD:-}" ]; then
      echo "$CHILD" > "$PID_FILE"
      break
    fi
    sleep 1
  done
fi
