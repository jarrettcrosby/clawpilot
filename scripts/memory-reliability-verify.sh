#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_ROOT="/Users/agentsuburbiasandwich/.openclaw/workspace"
MEM_DIR="$WORKSPACE_ROOT/memory"
SAFE_READER="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/memory-safe-read.sh"
PREFLIGHT="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/memory-preflight.sh"

TMP_EXISTING="$MEM_DIR/__verify-existing.md"
TMP_MISSING="$MEM_DIR/__verify-missing.md"
LOG_FILE="/tmp/clawd-memory-read.log"

rm -f "$LOG_FILE"
"$PREFLIGHT" >/tmp/_memory_preflight.out

# existing file test
printf 'hello-memory\n' > "$TMP_EXISTING"
OUT1="$($SAFE_READER "$TMP_EXISTING")"
if [[ "$OUT1" != *"hello-memory"* ]]; then
  echo "VERIFY_FAIL existing_file_read"
  exit 1
fi

# missing file fallback test
rm -f "$TMP_MISSING"
OUT2="$($SAFE_READER "$TMP_MISSING")"
if [[ -n "$OUT2" ]]; then
  echo "VERIFY_FAIL missing_file_should_return_empty"
  exit 1
fi

# directory path fallback test
OUT3="$($SAFE_READER "$MEM_DIR")"
if [[ -n "$OUT3" ]]; then
  echo "VERIFY_FAIL directory_path_should_return_empty"
  exit 1
fi

if ! grep -q "reason=file_missing" "$LOG_FILE"; then
  echo "VERIFY_FAIL missing_file_reason_not_logged"
  exit 1
fi
if ! grep -q "reason=is_directory_not_file" "$LOG_FILE"; then
  echo "VERIFY_FAIL directory_reason_not_logged"
  exit 1
fi

rm -f "$TMP_EXISTING"

echo "MEMORY_RELIABILITY_VERIFY_OK"
