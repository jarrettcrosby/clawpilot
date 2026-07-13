#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PORT="${PORT:-4002}"
BASE_URL="${CLAWPILOT_DEV_URL:-http://127.0.0.1:${PORT}}"
CURL_TIMEOUT_SECONDS="${DEV_VERIFY_TIMEOUT_SECONDS:-5}"
CURL_RETRIES="${DEV_VERIFY_RETRIES:-2}"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

http_get() {
  curl -fsS --max-time "$CURL_TIMEOUT_SECONDS" \
    --retry "$CURL_RETRIES" --retry-delay 1 --retry-connrefused "$1"
}

cd "$REPO_ROOT"

HEALTH_JSON="$(http_get "$BASE_URL/api/health")" || fail "Health check failed at $BASE_URL/api/health"
node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.status !== "ok") process.exit(1);
' "$HEALTH_JSON" || fail "Dev health status is not ok"
ok "health ${BASE_URL}"

RUNTIME_JSON="$(http_get "$BASE_URL/api/runtime")" || fail "Runtime identity is unavailable"
RUNTIME_COMMIT="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.commit || ""))' "$RUNTIME_JSON")"
RUNTIME_LANE="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.lane || value.environment || ""))' "$RUNTIME_JSON")"
RUNTIME_PORT="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.port || ""))' "$RUNTIME_JSON")"
HEAD_COMMIT="$(git rev-parse HEAD)"

[[ "$RUNTIME_COMMIT" == "$HEAD_COMMIT" ]] \
  || fail "Commit mismatch runtime=${RUNTIME_COMMIT:0:7} head=${HEAD_COMMIT:0:7}"
[[ "$RUNTIME_LANE" == "dev" || "$RUNTIME_LANE" == "development" ]] \
  || fail "Runtime lane mismatch expected=dev actual=${RUNTIME_LANE:-missing}"
[[ "$RUNTIME_PORT" == "$PORT" ]] \
  || fail "Runtime port mismatch expected=$PORT actual=${RUNTIME_PORT:-missing}"
ok "runtime ${HEAD_COMMIT:0:7} lane=${RUNTIME_LANE} port=${RUNTIME_PORT}"

for route in / /api/health /api/runtime /api/persistence/status /api/tasks; do
  http_get "$BASE_URL$route" >/dev/null || fail "Route check failed: $route"
  ok "route $route"
done

npm run verify:docs
echo "VERIFY_DEV_OK"
