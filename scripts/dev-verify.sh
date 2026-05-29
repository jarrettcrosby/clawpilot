#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
PORT="4002"
CURL_TIMEOUT_SECONDS="${DEV_VERIFY_TIMEOUT_SECONDS:-5}"
CURL_RETRIES="${DEV_VERIFY_RETRIES:-2}"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

LOCK_DIR="/tmp/clawpilot-dev-verify.lockdir"
LOCK_PID_FILE="$LOCK_DIR/pid"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_PID_FILE"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    return 0
  fi

  local existing_pid=""
  if [[ -f "$LOCK_PID_FILE" ]]; then
    existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    fail "Another dev-verify run is active (pid=$existing_pid)"
  fi

  echo "WARN: removing stale dev-verify lock${existing_pid:+ (pid=$existing_pid)}"
  rm -rf "$LOCK_DIR"

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$LOCK_PID_FILE"
    trap 'rm -rf "$LOCK_DIR"' EXIT
    return 0
  fi

  fail "Unable to acquire dev-verify lock"
}

http_get() {
  local url="$1"
  curl -sS --max-time "$CURL_TIMEOUT_SECONDS" --retry "$CURL_RETRIES" --retry-delay 1 --retry-connrefused "$url" || true
}

http_code() {
  local url="$1"
  curl -sS --max-time "$CURL_TIMEOUT_SECONDS" --retry "$CURL_RETRIES" --retry-delay 1 --retry-connrefused -o /dev/null -w "%{http_code}" "$url" || true
}

truncate_one_line() {
  local text="$1"
  text="${text//$'\n'/ }"
  if (( ${#text} > 220 )); then
    printf "%s…" "${text:0:220}"
  else
    printf "%s" "$text"
  fi
}

fail_http_check() {
  local label="$1"
  local url="$2"
  local body="$(http_get "$url")"
  local code="$(http_code "$url")"
  local brief
  brief="$(truncate_one_line "$body")"

  if [[ "$label" == "Health check" && "$body" == *"EADDRINUSE"* ]]; then
    fail "$label failed (${code:-n/a}) url=${url} body=${brief:-<empty>} hint=port ${PORT} is already in use; stop the duplicate listener and rerun (example: lsof -nP -iTCP:${PORT} -sTCP:LISTEN)"
  fi

  fail "$label failed (${code:-n/a}) url=${url} body=${brief:-<empty>}"
}

if [[ ! -e "$DEV_REPO/.git" ]]; then
  fail "Dev repo missing at $DEV_REPO"
fi

acquire_lock

HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
HEALTH_JSON="$(http_get "$HEALTH_URL")"
if [[ "$HEALTH_JSON" != *'"status":"ok"'* ]]; then
  fail_http_check "Health check" "$HEALTH_URL"
fi
ok "health :${PORT}"

RUNTIME_URL="http://127.0.0.1:${PORT}/api/runtime"
RUNTIME_JSON="$(http_get "$RUNTIME_URL")"
RUNTIME_FIELDS_RAW="$(python3 - <<'PY' "$RUNTIME_JSON"
import json,sys
try:
  j=json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
except Exception:
  j={}
print(j.get('commit',''))
print(str(j.get('lane','')))
print(str(j.get('port','')))
PY
)"
RUNTIME_COMMIT="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '1p')"
RUNTIME_LANE="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '2p')"
RUNTIME_PORT="$(printf '%s\n' "$RUNTIME_FIELDS_RAW" | sed -n '3p')"
HEAD_COMMIT="$(git -C "$DEV_REPO" rev-parse HEAD 2>/dev/null || true)"

if [[ -z "$RUNTIME_COMMIT" ]]; then
  fail_http_check "Runtime commit parse" "$RUNTIME_URL"
fi
if [[ -z "$HEAD_COMMIT" ]]; then
  fail "Git HEAD missing from $DEV_REPO"
fi
if [[ "$RUNTIME_COMMIT" != "$HEAD_COMMIT" ]]; then
  fail "Commit mismatch runtime=${RUNTIME_COMMIT:0:7} head=${HEAD_COMMIT:0:7}"
fi
ok "commit match ${HEAD_COMMIT:0:7}"

if [[ "$RUNTIME_LANE" != "dev" ]]; then
  fail "Runtime lane mismatch expected=dev actual=${RUNTIME_LANE:-<missing>}"
fi
ok "runtime lane dev"

if [[ "$RUNTIME_PORT" != "$PORT" ]]; then
  fail "Runtime port mismatch expected=${PORT} actual=${RUNTIME_PORT:-<missing>}"
fi
ok "runtime port ${PORT}"

DEFAULT_ROUTE_CHECKS="/ /api/health /api/runtime /api/tasks"
ROUTE_CHECKS_EFFECTIVE="${ROUTE_CHECKS:-$DEFAULT_ROUTE_CHECKS}"

for route in $ROUTE_CHECKS_EFFECTIVE; do
  code="$(http_code "http://127.0.0.1:${PORT}${route}")"
  if [[ "$code" != "200" && "$code" != "204" && "$code" != "301" && "$code" != "302" ]]; then
    fail "Route check failed: ${route} -> ${code}"
  fi
  ok "route ${route} -> ${code}"
done

# UI lane contract check (dev must show Promotion Readiness; stable must not)
"$DEV_REPO/scripts/ui-lane-contract-check.sh"

# Canonical work-model invariant checks (tasks as source of truth)
"$DEV_REPO/scripts/verify-work-model-invariants.sh"

# Board hygiene gate (no low-quality tasks in active workflow)
"$DEV_REPO/scripts/verify-board-hygiene.sh" dev-verify

# Core execution flow checks (queue + retry + execution runs)
"$DEV_REPO/scripts/verify-execution-flows.sh"

# Execution log integrity checks
"$DEV_REPO/scripts/verify-execution-log-integrity.sh"

# Documentation coherence gate (behavior changes must update CTO docs)
"$DEV_REPO/scripts/verify-doc-coherence.sh"

echo "VERIFY_OK"
