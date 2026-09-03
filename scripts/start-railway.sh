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
[[ "${CAREER_SITE_AGENTS_ENABLED:-}" == "1" ]] \
  || fail "CAREER_SITE_AGENTS_ENABLED must be 1"

require_value DATABASE_URL 16
require_value APP_LOGIN_PASSWORD 16
require_value APP_LOGIN_EMAIL 5
require_value APP_SESSION_SECRET 32
require_value AGENT_CREDENTIAL_ENCRYPTION_KEY 32
require_value INTEGRATION_EVIDENCE_FINGERPRINT_KEY 32
require_value INTEGRATION_EVIDENCE_ACTIVE_KEY_ID 1
require_value INTEGRATION_EVIDENCE_ENCRYPTION_KEYS 2
require_value AGENT_CREDENTIAL_DATABASE_URL 16
require_value CLAWPILOT_PUBLIC_URL 16
require_value PIPELINE_OUTBOX_WORKER_SECRET 32
require_value SHORTLINK_PUBLIC_ORIGIN 16
require_value MATON_API_KEY 16
require_value MATON_GMAIL_CONNECTION_ID 8
require_value CLAWPILOT_MAIL_FROM 5
require_value PIPELINE_SHEET_ID 20
AUTH_GMAIL_CONNECTION_VALUE="${MATON_AUTH_GMAIL_CONNECTION_ID:-}"
AUTH_MAIL_FROM_VALUE="${CLAWPILOT_AUTH_MAIL_FROM:-}"
if [[ -n "$AUTH_GMAIL_CONNECTION_VALUE" || -n "$AUTH_MAIL_FROM_VALUE" ]]; then
  [[ -n "$AUTH_GMAIL_CONNECTION_VALUE" && -n "$AUTH_MAIL_FROM_VALUE" ]] \
    || fail "MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together"
  require_value MATON_AUTH_GMAIL_CONNECTION_ID 8
  require_value CLAWPILOT_AUTH_MAIL_FROM 5
  [[ "$AUTH_GMAIL_CONNECTION_VALUE" != "$MATON_GMAIL_CONNECTION_ID" ]] \
    || fail "MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID"
  [[ "$CLAWPILOT_AUTH_MAIL_FROM" == *@* ]] \
    || fail "CLAWPILOT_AUTH_MAIL_FROM must be an email address"
  AUTH_MAIL_FROM_NORMALIZED="$(printf '%s' "$CLAWPILOT_AUTH_MAIL_FROM" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
  PLATFORM_MAIL_FROM_NORMALIZED="$(printf '%s' "$CLAWPILOT_MAIL_FROM" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
  [[ "$AUTH_MAIL_FROM_NORMALIZED" != "$PLATFORM_MAIL_FROM_NORMALIZED" ]] \
    || fail "CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM"
fi
if [[ "${CLAWPILOT_REPOSITORY_RUNNER_ENABLED:-0}" == "1" ]]; then
  require_value CLAWPILOT_GITHUB_APP_ID 1
  require_value CLAWPILOT_GITHUB_APP_BOT_USER 1
  require_value CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 64
  require_value CLAWPILOT_GITHUB_INSTALLATION_ID 1
  require_value CLAWPILOT_GITHUB_REPOSITORY_ID 1
  require_value CLAWPILOT_GITHUB_REPOSITORY 3
  require_value CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET 32
fi
if [[ "${CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED:-0}" == "1" ]]; then
  require_value CLAWPILOT_GITHUB_APP_ID 1
  require_value CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 64
  require_value CLAWPILOT_GITHUB_INSTALLATION_ID 1
  require_value CLAWPILOT_GITHUB_REPOSITORY_ID 1
  require_value CLAWPILOT_GITHUB_REPOSITORY 3
  require_value CLAWPILOT_PRINT_AGENT_RELEASE_VERSION 5
  require_value CLAWPILOT_PRINT_AGENT_RELEASE_TAG 10
  require_value CLAWPILOT_PRINT_AGENT_RELEASE_SOURCE_COMMIT 40
  require_value CLAWPILOT_PRINT_AGENT_RELEASE_INDEX_SHA256 64
  require_value CLAWPILOT_PRINT_AGENT_RELEASE_PRERELEASE 1
fi
if [[ "${CRM_ENABLED:-0}" == "1" ]]; then
  require_value SUITECRM_BASE_URL 16
  require_value SUITECRM_PUBLIC_URL 16
  require_value SUITECRM_CLIENT_ID 16
  require_value SUITECRM_CLIENT_SECRET 32
fi
if [[ "${CAREER_SITE_SUBMISSIONS_ENABLED:-0}" == "1" ]]; then
  require_value CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID 36
  require_value CAREER_SITE_MAIL_FROM 5
  require_value CAREER_SITE_MAIL_FROM_NAME 3
  require_value CAREER_SITE_MAIL_REPLY_TO 5
  require_value CAREER_SITE_MAIL_APPROVAL_TO 5
  require_value CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON 2
fi

SHORTLINK_CLIENTS_VALUE="${SHORTLINK_SERVICE_CLIENTS_JSON:-}"
SHORTLINK_SECRET_VALUE="${SHORTLINK_SERVICE_SECRET:-}"
if (( ${#SHORTLINK_CLIENTS_VALUE} < 32 )) && (( ${#SHORTLINK_SECRET_VALUE} < 32 )); then
  fail "SHORTLINK_SERVICE_CLIENTS_JSON or SHORTLINK_SERVICE_SECRET must be configured"
fi

[[ "$CLAWPILOT_MAIL_FROM" == *@* ]] || fail "CLAWPILOT_MAIL_FROM must be an email address"
[[ "$CLAWPILOT_PUBLIC_URL" == https://* ]] || fail "CLAWPILOT_PUBLIC_URL must use HTTPS"
node scripts/validate-runtime-config.mjs

cleanup() {
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

npm run start &
APP_PID=$!

HEALTH_URL="http://127.0.0.1:${PORT:-4002}/api/health"
READY=0
for _attempt in $(seq 1 120); do
  kill -0 "$APP_PID" 2>/dev/null || fail "application exited before readiness validation"
  if node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then(() => process.exit(0)).catch(() => process.exit(1))' "$HEALTH_URL"; then
    READY=1
    break
  fi
  sleep 1
done
[[ "$READY" == "1" ]] || fail "application did not become reachable within 120 seconds"

node scripts/pipeline-outbox-poller.mjs &
WORKER_PID=$!

HEALTHY=0
for _attempt in $(seq 1 120); do
  kill -0 "$APP_PID" 2>/dev/null || fail "application exited before health validation"
  kill -0 "$WORKER_PID" 2>/dev/null || fail "runtime worker exited before health validation"
  if node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' "$HEALTH_URL"; then
    HEALTHY=1
    break
  fi
  sleep 1
done
[[ "$HEALTHY" == "1" ]] || fail "application did not pass health validation within 120 seconds"

npm run toast:activate-payment-date-backfill
npm run release:record

while kill -0 "$APP_PID" 2>/dev/null; do
  if [[ -n "$WORKER_PID" ]] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "[railway-start] pipeline outbox poller exited unexpectedly"
    exit 1
  fi
  sleep 1
done

wait "$APP_PID"
