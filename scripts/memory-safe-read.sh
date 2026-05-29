#!/usr/bin/env bash
set -euo pipefail

# Safe memory reader for OpenClaw workspace files.
# Behavior:
# - If file exists and is readable: print content to stdout.
# - If file is missing/unreadable: print empty output, log clear reason, exit 0.
# - Never fails hard for missing files.

INPUT_PATH="${1:-}"
LOG_FILE="${MEMORY_READ_LOG:-/tmp/clawd-memory-read.log}"

log_reason() {
  local reason="$1"
  local path="$2"
  printf '%s [memory-safe-read] reason=%s path=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$reason" "$path" >> "$LOG_FILE"
}

if [[ -z "$INPUT_PATH" ]]; then
  log_reason "missing_path_arg" ""
  # empty memory fallback
  exit 0
fi

# expand leading ~ explicitly
if [[ "$INPUT_PATH" == ~* ]]; then
  INPUT_PATH="${INPUT_PATH/#\~/$HOME}"
fi

# resolve relative paths against workspace root
if [[ "$INPUT_PATH" != /* ]]; then
  INPUT_PATH="/Users/agentsuburbiasandwich/.openclaw/workspace/$INPUT_PATH"
fi

# directory path passed where file expected
if [[ -d "$INPUT_PATH" ]]; then
  log_reason "is_directory_not_file" "$INPUT_PATH"
  # empty memory fallback
  exit 0
fi

# missing file fallback
if [[ ! -e "$INPUT_PATH" ]]; then
  log_reason "file_missing" "$INPUT_PATH"
  # empty memory fallback
  exit 0
fi

# permission fallback
if [[ ! -r "$INPUT_PATH" ]]; then
  log_reason "file_not_readable" "$INPUT_PATH"
  # empty memory fallback
  exit 0
fi

cat "$INPUT_PATH"
