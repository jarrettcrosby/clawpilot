#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/app_src"
TS="$(date +"%Y-%m-%d_%H-%M-%S")"
LOG_DIR="$ROOT_DIR/data/logs/health"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/health_version_${TS}.log"

PORT="${PORT:-4001}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"

{
  echo "[health] ts=$TS"
  echo "[health] root=$ROOT_DIR"
  echo "[health] health_url=$HEALTH_URL"
  echo

  echo "== System =="
  echo "uname: $(uname -a)"
  echo "date:  $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo

  echo "== Runtime Versions =="
  echo "node: $(node -v 2>/dev/null || echo 'missing')"
  echo "npm:  $(npm -v 2>/dev/null || echo 'missing')"
  echo "python3: $(python3 --version 2>/dev/null || echo 'missing')"
  echo

  echo "== App Version =="
  if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "git_branch: $(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
    echo "git_commit: $(git -C "$ROOT_DIR" rev-parse --short HEAD)"
    echo "git_status:"
    git -C "$ROOT_DIR" status --short
  else
    echo "git: unavailable"
  fi
  if [[ -f "$APP_DIR/package.json" ]]; then
    echo "package_version: $(python3 - <<'PY'
import json
from pathlib import Path
p=Path('app_src/package.json')
print(json.loads(p.read_text()).get('version','unknown'))
PY
)"
  fi
  echo

  echo "== Health Endpoint =="
  HTTP_CODE=$(curl -sS -o /tmp/clawd_health_resp.json -w "%{http_code}" "$HEALTH_URL" || true)
  echo "http_code: $HTTP_CODE"
  if [[ -f /tmp/clawd_health_resp.json ]]; then
    echo "body:"
    head -c 1200 /tmp/clawd_health_resp.json
    echo
  fi

  echo
  echo "== Port Check =="
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P || echo "no listener on $PORT"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -an | grep "[\.:]$PORT .*LISTEN" || echo "no listener on $PORT"
  else
    echo "port-check-tool: unavailable (lsof/netstat missing)"
  fi
} | tee "$LOG_FILE"

echo "LOG_FILE=$LOG_FILE"
