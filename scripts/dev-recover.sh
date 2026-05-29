#!/usr/bin/env bash
set -euo pipefail

# Dev recovery helper for dev runtime on port 4002
# - archives app_src/.next from the dev worktree
# - stops dev process
# - removes .next
# - runs dev-start.sh to rebuild & start
# - polls /api/health and logs outcome to /tmp

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
APP_DIR="$DEV_REPO/app_src"
DEV_DATA_ROOT="$DEV_REPO/data-dev"
PORT=4002
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
BACKUP_DIR="$CONTROL_REPO/data/backups/daily"
TMP_LOG_PREFIX="/tmp/clawd-app-dev-recover-"
LOGFILE="${TMP_LOG_PREFIX}$(date +%F_%H%M%S).log"
START_SCRIPT="$CONTROL_REPO/scripts/dev-start.sh"
STOP_SCRIPT="$CONTROL_REPO/scripts/dev-stop.sh"
STATUS_SCRIPT="$CONTROL_REPO/scripts/dev-status.sh"

mkdir -p "$BACKUP_DIR"

echo "[dev-recover] log: $LOGFILE" | tee -a "$LOGFILE"

echo "[dev-recover] checking current dev health..." | tee -a "$LOGFILE"
if curl -s --max-time 3 "$HEALTH_URL" | grep -q '"status":"ok"'; then
  echo "[dev-recover] dev appears healthy. No action needed." | tee -a "$LOGFILE"
  exit 0
fi

echo "[dev-recover] dev unhealthy or unreachable. Beginning recovery." | tee -a "$LOGFILE"

# Stop dev runtime (safe to call even if not running)
echo "[dev-recover] stopping dev runtime..." | tee -a "$LOGFILE"
if [[ -x "$STOP_SCRIPT" ]]; then
  "$STOP_SCRIPT" 2>&1 | tee -a "$LOGFILE" || true
else
  echo "[dev-recover] warning: stop script missing or not executable: $STOP_SCRIPT" | tee -a "$LOGFILE"
fi

# Archive existing .next from dev app (if present)
if [[ -d "$APP_DIR/.next" ]]; then
  TS=$(date +%F_%H%M%S)
  ARCHIVE="$BACKUP_DIR/dev-next-${TS}.tar.gz"
  echo "[dev-recover] archiving $APP_DIR/.next -> $ARCHIVE" | tee -a "$LOGFILE"
  tar -czf "$ARCHIVE" -C "$APP_DIR" .next 2>&1 | tee -a "$LOGFILE"
  echo "[dev-recover] removing $APP_DIR/.next" | tee -a "$LOGFILE"
  rm -rf "$APP_DIR/.next"
else
  echo "[dev-recover] no .next found at $APP_DIR/.next; skipping archive" | tee -a "$LOGFILE"
fi

# Start dev runtime using existing start script
if [[ -x "$START_SCRIPT" ]]; then
  echo "[dev-recover] starting dev runtime via $START_SCRIPT" | tee -a "$LOGFILE"
  (cd "$(dirname "$START_SCRIPT")/.." && "$START_SCRIPT") 2>&1 | tee -a "$LOGFILE" || {
    echo "[dev-recover] dev start script failed. See log." | tee -a "$LOGFILE"
    exit 2
  }
else
  echo "[dev-recover] error: start script missing or not executable: $START_SCRIPT" | tee -a "$LOGFILE"
  exit 3
fi

# Poll health
echo "[dev-recover] polling health at $HEALTH_URL" | tee -a "$LOGFILE"
MAX_SECS=90
INTERVAL=3
elapsed=0
while [[ $elapsed -lt $MAX_SECS ]]; do
  if curl -s --max-time 3 "$HEALTH_URL" | grep -q '"status":"ok"'; then
    echo "[dev-recover] health check passed after ${elapsed}s" | tee -a "$LOGFILE"
    echo "[dev-recover] recovery successful" | tee -a "$LOGFILE"
    exit 0
  fi
  sleep $INTERVAL
  elapsed=$((elapsed + INTERVAL))
done

echo "[dev-recover] timed out after ${MAX_SECS}s waiting for health. Check $LOGFILE" | tee -a "$LOGFILE"
exit 4
