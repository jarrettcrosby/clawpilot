#!/usr/bin/env bash
set -euo pipefail

PORT="4002"
LOG_FILE="/tmp/clawd-app-dev.log"
LOG_ROTATE_BYTES=$((5 * 1024 * 1024))
PID_FILE="/tmp/clawd-app-dev.pid"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
DEV_REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
APP_DIR="$DEV_REPO/app_src"
LEGACY_DEV_REPO="${CLAWPILOT_LEGACY_DEV_ROOT:-/Users/agentsuburbiasandwich/Desktop/clawd-app-dev}"
LEGACY_STABLE_REPO="${CLAWPILOT_LEGACY_STABLE_ROOT:-/Users/agentsuburbiasandwich/Desktop/clawd-app}"

if ! git -C "$DEV_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ClawPilot repository missing at $DEV_REPO"
  exit 1
fi

DEV_DATA_ROOT="$DEV_REPO/data-dev"
mkdir -p "$DEV_DATA_ROOT/pipeline/normalized" "$DEV_DATA_ROOT/pipeline/dropdowns" "$DEV_DATA_ROOT/logs" "$DEV_DATA_ROOT/agents"

seed_from_candidates() {
  local dest="$1"
  shift
  if [[ -f "$dest" ]]; then
    return 0
  fi

  local src
  for src in "$@"; do
    if [[ -f "$src" ]]; then
      cp "$src" "$dest"
      echo "Seeded ${dest#$DEV_REPO/} from historical runtime source"
      return 0
    fi
  done
  return 1
}

seed_from_candidates "$DEV_DATA_ROOT/tasks.json" \
  "$DEV_REPO/data/tasks.json" \
  "$LEGACY_DEV_REPO/data-dev/tasks.json" \
  "$LEGACY_DEV_REPO/data/tasks.json" \
  "$LEGACY_STABLE_REPO/data/tasks.json" \
  || { echo "No task seed is available"; exit 1; }
seed_from_candidates "$DEV_DATA_ROOT/pipeline/normalized/current.json" \
  "$DEV_REPO/data/pipeline/normalized/current.json" \
  "$LEGACY_DEV_REPO/data-dev/pipeline/normalized/current.json" \
  "$LEGACY_DEV_REPO/data/pipeline/normalized/current.json" \
  "$LEGACY_STABLE_REPO/data/pipeline/normalized/current.json" \
  || { echo "No pipeline seed is available"; exit 1; }
seed_from_candidates "$DEV_DATA_ROOT/pipeline/dropdowns/catalog.json" \
  "$DEV_REPO/data/pipeline/dropdowns/catalog.json" \
  "$LEGACY_DEV_REPO/data-dev/pipeline/dropdowns/catalog.json" \
  "$LEGACY_DEV_REPO/data/pipeline/dropdowns/catalog.json" \
  "$LEGACY_STABLE_REPO/data/pipeline/dropdowns/catalog.json" \
  || { echo "No pipeline dropdown seed is available"; exit 1; }
seed_from_candidates "$DEV_DATA_ROOT/agents/threads.json" \
  "$DEV_REPO/data/agents/threads.json" \
  "$LEGACY_DEV_REPO/data-dev/agents/threads.json" \
  "$LEGACY_DEV_REPO/data/agents/threads.json" \
  "$LEGACY_STABLE_REPO/data/agents/threads.json" \
  || { echo "No agent thread seed is available"; exit 1; }

if ! seed_from_candidates "$DEV_DATA_ROOT/agents/assignments.json" \
  "$DEV_REPO/data/agents/assignments.json" \
  "$LEGACY_DEV_REPO/data-dev/agents/assignments.json" \
  "$LEGACY_DEV_REPO/data/agents/assignments.json" \
  "$LEGACY_STABLE_REPO/data/agents/assignments.json"; then
  printf '[]\n' > "$DEV_DATA_ROOT/agents/assignments.json"
fi

if ! seed_from_candidates "$DEV_DATA_ROOT/logs/pipeline-events.jsonl" \
  "$DEV_REPO/data/logs/pipeline-events.jsonl" \
  "$LEGACY_DEV_REPO/data-dev/logs/pipeline-events.jsonl" \
  "$LEGACY_DEV_REPO/data/logs/pipeline-events.jsonl" \
  "$LEGACY_STABLE_REPO/data/logs/pipeline-events.jsonl"; then
  : > "$DEV_DATA_ROOT/logs/pipeline-events.jsonl"
fi

echo "Stopping dev runtime if running..."
"$DEV_REPO/scripts/dev-stop.sh" || true

assert_port_free() {
  if python3 - <<'PY' "$PORT"
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("0.0.0.0", port))
except OSError as e:
    if getattr(e, "errno", None) == 48:  # macOS EADDRINUSE
        print(f"PORT_IN_USE:{port}")
        sys.exit(2)
    raise
finally:
    try:
        s.close()
    except Exception:
        pass
PY
  then
    return 0
  fi

  echo "Port ${PORT} is already in use before startup."
  echo "Refusing to continue to avoid non-deterministic startup behavior."
  echo "Resolve the occupying process, then rerun scripts/dev-start.sh."
  exit 1
}

assert_port_free

rotate_dev_log_if_needed() {
  if [[ ! -f "$LOG_FILE" ]]; then
    return 0
  fi

  local size
  size=$(wc -c < "$LOG_FILE" | tr -d '[:space:]')
  if [[ -z "$size" || "$size" -lt "$LOG_ROTATE_BYTES" ]]; then
    return 0
  fi

  local timestamp backup
  timestamp="$(date +"%Y%m%d-%H%M%S")"
  backup="${LOG_FILE}.${timestamp}"
  mv "$LOG_FILE" "$backup"
  echo "Rotated oversized dev log ($size bytes) -> $backup"
}

rotate_dev_log_if_needed

echo "====================================="
echo "CLAWPILOT DEV RUNTIME"
echo "Port: 4002"
echo "Root: $DEV_REPO"
echo "Data root: data-dev/"
echo "Logs: /tmp/clawd-app-dev.log"
echo "====================================="

echo "Cleaning stale Next.js build artifacts..."
cd "$APP_DIR"
rm -rf .next

echo "Installing dependencies (safe if already installed)..."
npm install

echo "Building dev runtime..."
npm run build

echo "Starting dev runtime on port 4002..."
BUILD_COMMIT="$(git -C "$DEV_REPO" rev-parse HEAD)"
BUILD_STAMP="/tmp/clawd-app-dev.build"
echo "commit=$BUILD_COMMIT" > "$BUILD_STAMP"
echo "built_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$BUILD_STAMP"

PORT="$PORT" \
RUNTIME_LANE="dev" \
RUNTIME_PORT="$PORT" \
CLAWPILOT_REPO_ROOT="$DEV_REPO" \
CLAWPILOT_STORAGE="file" \
APP_AUTH_REQUIRED="0" \
TASKS_PATH="$DEV_DATA_ROOT/tasks.json" \
PIPELINE_NORMALIZED_PATH="$DEV_DATA_ROOT/pipeline/normalized/current.json" \
PIPELINE_LOG_PATH="$DEV_DATA_ROOT/logs/pipeline-events.jsonl" \
PIPELINE_DROPDOWN_CACHE_PATH="$DEV_DATA_ROOT/pipeline/dropdowns/catalog.json" \
AGENT_THREADS_PATH="$DEV_DATA_ROOT/agents/threads.json" \
AGENT_ASSIGNMENTS_PATH="$DEV_DATA_ROOT/agents/assignments.json" \
nohup npm run start -- --port "$PORT" --hostname 0.0.0.0 > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

cleanup_failed_start() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$PID_FILE"
}

sleep 1
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Dev runtime process exited immediately after launch. Cleaning failed start."
  echo "Recent log output:"
  tail -n 40 "$LOG_FILE" || true
  cleanup_failed_start
  exit 1
fi

echo "Running dev health verification..."
HEALTH_OUTPUT=""
for attempt in {1..15}; do
  HEALTH_OUTPUT="$(curl -s --max-time 2 http://127.0.0.1:4002/api/health || true)"
  if [[ "$HEALTH_OUTPUT" == *'"status":"ok"'* ]]; then
    break
  fi
  sleep 1
done

echo "$HEALTH_OUTPUT"
if [[ "$HEALTH_OUTPUT" != *'"status":"ok"'* ]]; then
  echo "Dev runtime failed health check after retries. Cleaning failed start. See /tmp/clawd-app-dev.log"
  cleanup_failed_start
  exit 1
fi

RUNTIME_COMMIT=""
for attempt in {1..10}; do
  RUNTIME_JSON="$(curl -s --max-time 2 http://127.0.0.1:4002/api/runtime || true)"
  RUNTIME_COMMIT="$(python3 - <<'PY' "$RUNTIME_JSON"
import json,sys
try:
  j=json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
  print(j.get('commit',''))
except Exception:
  print('')
PY
)"
  if [[ -n "$RUNTIME_COMMIT" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$RUNTIME_COMMIT" || "$RUNTIME_COMMIT" != "$BUILD_COMMIT" ]]; then
  echo "Dev runtime commit mismatch: runtime=$RUNTIME_COMMIT build=$BUILD_COMMIT. Cleaning failed start."
  cleanup_failed_start
  exit 1
fi

if [[ -n "${ROUTE_CHECKS:-}" ]]; then
  for route in $ROUTE_CHECKS; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}${route}" || true)
    if [[ "$code" != "200" ]]; then
      echo "Route check failed: ${route} -> ${code}. Cleaning failed start."
      cleanup_failed_start
      exit 1
    fi
  done
fi

echo "Dev started on :$PORT (pid $(cat "$PID_FILE"))"
echo "Log: $LOG_FILE"
