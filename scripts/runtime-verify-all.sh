#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$CONTROL_REPO" && "$REPO_ROOT" != "$DEV_REPO" ]]; then
  echo "ERROR: run from control or dev repo"
  exit 2
fi

VERIFY_SCOPE="${RUNTIME_VERIFY_SCOPE:-dev}"
case "$VERIFY_SCOPE" in
  dev|stable|all) ;;
  *)
    echo "ERROR: RUNTIME_VERIFY_SCOPE must be one of: dev | stable | all"
    exit 2
    ;;
esac

if [[ "$VERIFY_SCOPE" != "dev" && "${RUNTIME_VERIFY_ALLOW_STABLE:-0}" != "1" ]]; then
  echo "ERROR: stable lane checks are blocked by default (set RUNTIME_VERIFY_ALLOW_STABLE=1 to override)"
  exit 2
fi

STABLE_ROUTES="${ROUTE_CHECKS_STABLE:-/api/health /api/runtime /}"
DEV_ROUTES="${ROUTE_CHECKS_DEV:-/api/health /api/runtime /api/promotion-report /}"
CURL_TIMEOUT_SECONDS="${RUNTIME_VERIFY_TIMEOUT_SECONDS:-5}"
CURL_RETRIES="${RUNTIME_VERIFY_RETRIES:-2}"
SUCCESS_CODES_API="${RUNTIME_VERIFY_SUCCESS_CODES_API:-200 204}"
SUCCESS_CODES_PAGE="${RUNTIME_VERIFY_SUCCESS_CODES_PAGE:-200 204 301 302 307 308}"

check_route() {
  local base="$1"
  local route="$2"
  local code
  local success_codes="$SUCCESS_CODES_PAGE"

  if [[ "$route" == /api/* ]]; then
    success_codes="$SUCCESS_CODES_API"
  fi

  code=$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" --retry "$CURL_RETRIES" --retry-delay 1 --retry-connrefused -o /dev/null -w "%{http_code}" "${base}${route}" || true)
  for ok_code in $success_codes; do
    if [[ "$code" == "$ok_code" ]]; then
      echo "OK: ${base}${route} -> $code"
      return 0
    fi
  done
  echo "FAIL: ${base}${route} -> $code (allowed: $success_codes)"
  return 1
}

check_runtime_contract() {
  local base="$1"
  local expected_lane="$2"
  local expected_port="$3"
  local payload

  payload=$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" --retry "$CURL_RETRIES" --retry-delay 1 --retry-connrefused "${base}/api/runtime" || true)
  if [[ -z "$payload" ]]; then
    echo "FAIL: ${base}/api/runtime returned empty payload"
    return 1
  fi

  if python3 - "$payload" "$expected_lane" "$expected_port" <<'PY'
import json
import sys

payload = sys.argv[1]
expected_lane = sys.argv[2]
expected_port = sys.argv[3]

try:
    data = json.loads(payload)
except json.JSONDecodeError:
    print("invalid_json")
    raise SystemExit(1)

lane = str(data.get("lane", ""))
port = str(data.get("port", ""))

if lane != expected_lane or port != expected_port:
    print(f"lane={lane} port={port}")
    raise SystemExit(1)
PY
  then
    echo "OK: runtime contract ${base}/api/runtime lane=${expected_lane} port=${expected_port}"
    return 0
  fi

  echo "FAIL: runtime contract mismatch at ${base}/api/runtime (expected lane=${expected_lane} port=${expected_port})"
  return 1
}

STATUS=0

if [[ "$VERIFY_SCOPE" == "stable" || "$VERIFY_SCOPE" == "all" ]]; then
  echo "==> Stable lane route checks (4001)"
  for r in $STABLE_ROUTES; do
    if ! check_route "http://127.0.0.1:4001" "$r"; then
      STATUS=1
    fi
  done
  if ! check_runtime_contract "http://127.0.0.1:4001" "stable" "4001"; then
    STATUS=1
  fi
fi

if [[ "$VERIFY_SCOPE" == "dev" || "$VERIFY_SCOPE" == "all" ]]; then
  echo "==> Dev lane route checks (4002)"
  for r in $DEV_ROUTES; do
    if ! check_route "http://127.0.0.1:4002" "$r"; then
      STATUS=1
    fi
  done
  if ! check_runtime_contract "http://127.0.0.1:4002" "dev" "4002"; then
    STATUS=1
  fi
fi

if [[ $STATUS -eq 0 ]]; then
  echo "RUNTIME_VERIFY_ALL_OK scope=${VERIFY_SCOPE}"
  exit 0
fi

echo "RUNTIME_VERIFY_ALL_FAIL scope=${VERIFY_SCOPE}"
exit 1
