#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${DEV_BASE_URL:-http://127.0.0.1:4002}"
ROUTES="${ROUTE_CHECKS:-/ /api/health /api/runtime /api/tasks}"
TIMEOUT="${DEV_SMOKE_TIMEOUT_SECONDS:-5}"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

http_code() {
  local url="$1"
  curl -sS --max-time "$TIMEOUT" --retry 1 --retry-delay 1 --retry-connrefused -o /dev/null -w "%{http_code}" "$url" || true
}

for route in $ROUTES; do
  code="$(http_code "${BASE_URL}${route}")"
  if [[ "$code" != "200" && "$code" != "204" && "$code" != "301" && "$code" != "302" ]]; then
    fail "Route check failed: ${route} -> ${code}"
  fi
  ok "route ${route} -> ${code}"
done

echo "DEV_FOCUSED_SMOKE_OK"