#!/usr/bin/env bash
set -euo pipefail

APP_PID=""
WORKER_PID=""

fail() {
  echo "[railway-start] $1" >&2
  exit 1
}

require_value() {
  local name="$1"
  local minimum_length="${2:-1}"
  local value="${!name:-}"
  if (( ${#value} < minimum_length )); then
    fail "$name must be configured with at least $minimum_length characters"
  fi
}

[[ "${CLAWPILOT_STORAGE:-}" == "postgres" ]] || fail "CLAWPILOT_STORAGE must be postgres"
[[ "${CLAWPILOT_DB_FALLBACK_TO_FILE:-}" == "false" ]] || fail "CLAWPILOT_DB_FALLBACK_TO_FILE must be false"
[[ "${APP_AUTH_REQUIRED:-}" == "1" ]] || fail "APP_AUTH_REQUIRED must be 1"
[[ "${CLAWPILOT_EXECUTION_ENABLED:-}" == "0" || "${CLAWPILOT_EXECUTION_ENABLED:-}" == "1" ]] \
  || fail "CLAWPILOT_EXECUTION_ENABLED must be explicitly set to 0 or 1"

require_value DATABASE_URL 16
require_value APP_LOGIN_PASSWORD 16
require_value APP_LOGIN_EMAIL 5
require_value APP_SESSION_SECRET 32
require_value AGENT_CREDENTIAL_ENCRYPTION_KEY 32
require_value AGENT_CREDENTIAL_DATABASE_URL 16
require_value MATON_API_KEY 16
require_value MATON_GMAIL_CONNECTION_ID 8
require_value PIPELINE_SHEET_ID 20
require_value PIPELINE_OUTBOX_WORKER_SECRET 32

cleanup() {
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npm run start &
APP_PID=$!

node scripts/pipeline-outbox-poller.mjs &
WORKER_PID=$!

while kill -0 "$APP_PID" 2>/dev/null; do
  if [[ -n "$WORKER_PID" ]] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[railway-start] pipeline outbox poller exited unexpectedly"
    exit 1
  fi
  sleep 1
done

wait "$APP_PID"
