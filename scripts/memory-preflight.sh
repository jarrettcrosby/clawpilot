#!/usr/bin/env bash
set -euo pipefail

# Ensure OpenClaw memory path is consistently present for startup reads.
# Dev-only reliability guard; no prompt/behavior changes.

WORKSPACE_ROOT="/Users/agentsuburbiasandwich/.openclaw/workspace"
MEM_DIR="$WORKSPACE_ROOT/memory"
LOG_FILE="${MEMORY_READ_LOG:-/tmp/clawd-memory-read.log}"

mkdir -p "$MEM_DIR"
chmod 755 "$MEM_DIR" || true

TODAY="$(TZ=America/New_York date +%F)"
YESTERDAY="$(TZ=America/New_York date -v-1d +%F 2>/dev/null || TZ=America/New_York python3 - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
print((datetime.now(ZoneInfo('America/New_York')) - timedelta(days=1)).date().isoformat())
PY
)"

ensure_file() {
  local d="$1"
  local f="$MEM_DIR/$d.md"
  if [[ ! -e "$f" ]]; then
    {
      echo "# Memory - $d"
      echo
      echo "_Auto-created by memory-preflight for safe startup reads._"
    } > "$f"
    chmod 600 "$f" || true
    printf '%s [memory-preflight] created_missing_memory_file path=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$f" >> "$LOG_FILE"
  fi
}

ensure_file "$TODAY"
ensure_file "$YESTERDAY"

echo "MEMORY_PREFLIGHT_OK dir=$MEM_DIR today=$TODAY yesterday=$YESTERDAY"
