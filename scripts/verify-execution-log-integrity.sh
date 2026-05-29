#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAWD_APP_DEV_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
RUNS_FILE="${EXECUTION_RUNS_FILE:-$REPO_ROOT/data-dev/agents/execution-runs.jsonl}"
RESULTS_FILE="${EXECUTION_RESULTS_FILE:-$REPO_ROOT/data-dev/agents/execution-results.jsonl}"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

check_file() {
  local file="$1"
  local label="$2"

  if [[ ! -f "$file" ]]; then
    ok "${label} missing (no logs yet)"
    return 0
  fi

  python3 - <<'PY' "$file" "$label"
import json,sys
path=sys.argv[1]
label=sys.argv[2]
malformed=0
lines=0
with open(path,'r',encoding='utf-8') as f:
  for line in f:
    line=line.strip()
    if not line:
      continue
    lines+=1
    try:
      json.loads(line)
    except Exception:
      malformed+=1
if malformed:
  raise SystemExit(f"{label} malformed lines: {malformed} of {lines}")
print(f"{label} integrity OK ({lines} lines)")
PY
}

check_file "$RUNS_FILE" "execution-runs"
check_file "$RESULTS_FILE" "execution-results"

ok "execution log integrity verified"
