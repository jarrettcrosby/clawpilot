#!/usr/bin/env bash
set -euo pipefail

ROOT_URL="http://127.0.0.1:4001"
APP_ROOT="/Users/agentsuburbiasandwich/Desktop/clawd-app/app_src"
TMP_ROOT="/tmp/clawd-promotion-verify"
ROOT_HTML="$TMP_ROOT/root.html"
CHUNK_LIST="$TMP_ROOT/chunks.txt"

mkdir -p "$TMP_ROOT"

echo "====================================="
echo "STABLE PROMOTION VERIFICATION"
echo "Root URL: $ROOT_URL"
echo "App root: $APP_ROOT"
echo "====================================="

echo
echo "1) Checking for listeners on :4001"
lsof -nP -iTCP:4001 -sTCP:LISTEN || true

echo
echo "2) Checking health endpoint"
HEALTH="$(curl -fsS "$ROOT_URL/api/health")"
echo "$HEALTH"

if [[ "$HEALTH" != *'"status":"ok"'* ]]; then
  echo
  echo "FAIL: /api/health did not return status ok"
  exit 1
fi

echo
echo "3) Fetching root HTML"
ROOT_CODE="$(curl -s -o "$ROOT_HTML" -w "%{http_code}" "$ROOT_URL")"
echo "Root HTTP status: $ROOT_CODE"

if [[ "$ROOT_CODE" != "200" ]]; then
  echo
  echo "FAIL: Root page did not return HTTP 200"
  exit 1
fi

echo
echo "4) Extracting referenced Next.js chunks"
grep -oE '/_next/static/chunks/[^"<> ]+' "$ROOT_HTML" \
  | sed 's#^/_next/static/chunks/##' \
  | sort -u > "$CHUNK_LIST" || true

CHUNK_COUNT="$(wc -l < "$CHUNK_LIST" | tr -d ' ')"
echo "Referenced chunk count: $CHUNK_COUNT"

if [[ "$CHUNK_COUNT" == "0" ]]; then
  echo
  echo "FAIL: No chunks found in root HTML"
  exit 1
fi

echo
echo "5) Auditing referenced chunks"
BAD_COUNT=0
while IFS= read -r chunk; do
  [[ -z "$chunk" ]] && continue
  DISK_PATH="$APP_ROOT/.next/static/chunks/$chunk"
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "$ROOT_URL/_next/static/chunks/$chunk")"

  if [[ ! -f "$DISK_PATH" ]]; then
    echo "MISSING ON DISK: $chunk"
    BAD_COUNT=$((BAD_COUNT+1))
    continue
  fi

  if [[ "$HTTP_CODE" != "200" ]]; then
    echo "BAD HTTP ($HTTP_CODE): $chunk"
    BAD_COUNT=$((BAD_COUNT+1))
    continue
  fi

  echo "OK: $chunk"
done < "$CHUNK_LIST"

echo
echo "6) Summary"
if [[ "$BAD_COUNT" -ne 0 ]]; then
  echo "FAIL: Chunk audit found $BAD_COUNT bad chunks"
  exit 1
fi

echo "PASS: All referenced chunks exist on disk and return HTTP 200"
echo
echo "7) Final reminder"
echo "Operator must still open the site in a browser and confirm no client-side exception."
echo
echo "Verification complete."
