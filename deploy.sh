#!/bin/zsh
# ClawPilot App — Deploy Script
# Usage: ./deploy.sh "commit message"

set -euo pipefail

MSG="${1:-deploy: update}"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$APP_DIR/app_src"
DATA_DIR="$APP_DIR/data"
BACKUP_DIR="$APP_DIR/data/backups"
PORT=4001
PID_FILE="/tmp/clawd-app.pid"
LOG_FILE="/tmp/clawd-app.log"

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
  # A) PID-file based shutdown first
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
      echo "   • stopping PID $PID (SIGTERM)"
      kill -TERM "$PID" 2>/dev/null || true

      if command -v pgrep >/dev/null 2>&1; then
        CHILDREN=$(pgrep -P "$PID" || true)
        if [ -n "${CHILDREN:-}" ]; then
          echo "$CHILDREN" | xargs kill -TERM 2>/dev/null || true
        fi
      fi

      for _ in {1..20}; do
        if ! kill -0 "$PID" 2>/dev/null; then
          break
        fi
        sleep 1
      done

      if kill -0 "$PID" 2>/dev/null; then
        echo "   • forcing PID $PID (SIGKILL)"
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

  # B) Fallback for stale pidfile or legacy processes
  pkill -TERM -f "next-server.*--port $PORT" 2>/dev/null || true
  pkill -TERM -f "npm start.*--port $PORT" 2>/dev/null || true
  sleep 1
  pkill -KILL -f "next-server.*--port $PORT" 2>/dev/null || true
  pkill -KILL -f "npm start.*--port $PORT" 2>/dev/null || true

  # C) Prove cleanup
  ps aux | grep -E "next-server|npm start|4001" | grep -v grep || true
}

wait_port_clear() {
  i=0
  while [ "$i" -lt 50 ]; do
    if port_is_free; then
      return 0
    fi
    if [ $((i % 2)) -eq 0 ]; then
      echo "   • waiting for port ${PORT} to clear..."
    fi
    sleep 0.5
    i=$((i+1))
  done

  echo "   • port ${PORT} still in use after timeout"
  ps aux | grep -E "next-server|npm start|4001" | grep -v grep || true
  return 1
}

start_server() {
  cd "$SRC_DIR"
  nohup npm start -- --port "$PORT" --hostname 0.0.0.0 > "$LOG_FILE" 2>&1 &
  PID=$!
  echo "$PID" > "$PID_FILE"

  if command -v pgrep >/dev/null 2>&1; then
    for _ in {1..10}; do
      CHILD=$(pgrep -P "$PID" | head -n 1 || true)
      if [ -n "${CHILD:-}" ]; then
        echo "$CHILD" > "$PID_FILE"
        break
      fi
      sleep 1
    done
  fi

  for _ in {1..25}; do
    if tail -n 120 "$LOG_FILE" | grep -q "Ready"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "🔒 Backing up data..."
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
cp "$DATA_DIR/tasks.json" "$BACKUP_DIR/tasks_$TIMESTAMP.json"
echo "   ✓ tasks.json → backups/tasks_$TIMESTAMP.json"

echo "🔨 Building..."
cd "$SRC_DIR"
npm run build

echo "🔄 Restarting server atomically..."
stop_existing
if ! wait_port_clear; then
  echo "❌ Port $PORT did not clear within timeout"
  exit 1
fi
if ! start_server; then
  echo "❌ Server failed to reach Ready"
  tail -n 120 "$LOG_FILE" || true
  exit 1
fi
echo "   ✓ Server running at http://localhost:$PORT"

echo "📝 Committing..."
cd "$APP_DIR"
git add -A
git commit -m "$MSG" || echo "   (nothing to commit)"

echo "✅ Deploy complete!"
