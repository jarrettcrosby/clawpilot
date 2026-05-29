#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
APP_DIR="$DEV_REPO/app_src"
PORT="4002"
LOG_FILE="/tmp/clawd-app-dev.log"
LOG_ROTATE_BYTES=$((5 * 1024 * 1024))
PID_FILE="/tmp/clawd-app-dev.pid"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$CONTROL_REPO" ]]; then
  echo "Refusing to start dev app from wrong control root: $REPO_ROOT"
  exit 1
fi

if [[ ! -e "$DEV_REPO/.git" ]]; then
  echo "Dev worktree missing at $DEV_REPO"
  echo "Create with: git -C $CONTROL_REPO worktree add -b dev/worktree $DEV_REPO main"
  exit 1
fi

DEV_DATA_ROOT="$DEV_REPO/data-dev"
mkdir -p "$DEV_DATA_ROOT/pipeline/normalized" "$DEV_DATA_ROOT/pipeline/dropdowns" "$DEV_DATA_ROOT/logs" "$DEV_DATA_ROOT/agents"

seed_once() {
  local src="$1"
  local dest="$2"
  local fallback_content="${3:-}"

  if [[ -f "$dest" ]]; then
    return 0
  fi

  if [[ -n "$fallback_content" ]]; then
    printf "%s\n" "$fallback_content" > "$dest"
    return 0
  fi

  if [[ ! -f "$src" ]]; then
    echo "Required seed source missing: $src"
    echo "Cannot initialize dev runtime data safely."
    exit 1
  fi

  cp "$src" "$dest"
}

# seed high-risk writable files once (non-destructive)
seed_once "$DEV_REPO/data/tasks.json" "$DEV_DATA_ROOT/tasks.json"
seed_once "$DEV_REPO/data/pipeline/normalized/current.json" "$DEV_DATA_ROOT/pipeline/normalized/current.json"
seed_once "$DEV_REPO/data/pipeline/dropdowns/catalog.json" "$DEV_DATA_ROOT/pipeline/dropdowns/catalog.json"
seed_once "$DEV_REPO/data/logs/pipeline-events.jsonl" "$DEV_DATA_ROOT/logs/pipeline-events.jsonl"
seed_once "$DEV_REPO/data/agents/threads.json" "$DEV_DATA_ROOT/agents/threads.json"

if [[ -f "$DEV_REPO/data/agents/assignments.json" ]]; then
  seed_once "$DEV_REPO/data/agents/assignments.json" "$DEV_DATA_ROOT/agents/assignments.json"
else
  seed_once "" "$DEV_DATA_ROOT/agents/assignments.json" "[]"
fi

echo "Stopping dev runtime if running..."
"$CONTROL_REPO/scripts/dev-stop.sh" || true

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
echo "CLAWD DEV RUNTIME"
echo "Port: 4002"
echo "Root: clawd-app-dev"
echo "Data root: data-dev/"
echo "Logs: /tmp/clawd-app-dev.log"
echo "====================================="

echo "Running memory preflight (workspace memory path + date files)..."
"$DEV_REPO/scripts/memory-preflight.sh"

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

TASKS_PATH="$DEV_DATA_ROOT/tasks.json" \
PIPELINE_NORMALIZED_PATH="$DEV_DATA_ROOT/pipeline/normalized/current.json" \
PIPELINE_LOG_PATH="$DEV_DATA_ROOT/logs/pipeline-events.jsonl" \
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