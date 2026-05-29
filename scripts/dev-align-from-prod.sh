#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
DEV_DIR="$ROOT_DIR/data-dev"
BACKUP_ROOT="$DEV_DIR/backups"
TS="$(date +"%Y%m%d-%H%M%S")"
BACKUP_DIR="$BACKUP_ROOT/$TS"
MODE=""
REPORT_FLAG=""
AUTO_YES="false"

for arg in "$@"; do
  case "$arg" in
    --dry-run|--apply) MODE="$arg" ;;
    --report) REPORT_FLAG="$arg" ;;
    --yes) AUTO_YES="true" ;;
    *) ;;
  esac
done

CANONICAL_FILES=(
  "tasks.json"
  "deleted-tasks.json"
  "agents/assignments.json"
  "agents/threads.json"
  "pipeline/dropdowns/catalog.json"
  "pipeline/normalized/opportunities.json"
  "pipeline/raw/opportunities.json"
)

# Canonical promotable-but-mutable runtime state in dev should not block promotion readiness.
# These files are expected to differ from prod baseline prior to promotion execution.
PROMOTION_MUTABLE_FILES=(
  "tasks.json"
  "agents/assignments.json"
  "agents/threads.json"
)

DEV_ONLY_PATHS=(
  "logs"
  "agents"
  "pipeline"
  "consolidation-review.json"
)

VOCAB_GUARD_FILES=(
  "app_src/lib/governance/vocab.ts"
  "docs/operations/development-contract.md"
  "docs/architecture/system-operating-model.md"
)

if [[ "$MODE" != "--dry-run" && "$MODE" != "--apply" ]]; then
  echo "Usage: $0 --dry-run [--report] | --apply [--report] [--yes]"
  exit 2
fi

REPORT_PATH=""
if [[ "$REPORT_FLAG" == "--report" ]]; then
  if [[ "$MODE" == "--apply" ]]; then
    REPORT_PATH="$BACKUP_DIR/alignment-report.json"
  else
    REPORT_PATH="$BACKUP_ROOT/dry-run-$TS.json"
  fi
fi

DIFFS=()
MISSING=()
OKS=()
SKIPS=()
PURGE=()
VOCAB_STATUS=()

is_promotion_mutable_file() {
  local rel="$1"
  for f in "${PROMOTION_MUTABLE_FILES[@]}"; do
    if [[ "$f" == "$rel" ]]; then
      return 0
    fi
  done
  return 1
}

report_diff() {
  local rel="$1"
  local src="$DATA_DIR/$rel"
  local dest="$DEV_DIR/$rel"
  if [ -f "$src" ]; then
    if [ ! -f "$dest" ]; then
      echo "MISSING: $rel"
      MISSING+=("$rel")
      return 1
    fi

    # Known mutable canonical state is allowed to drift in dev before promotion.
    if is_promotion_mutable_file "$rel"; then
      echo "OK: $rel (promotion-mutable drift allowed)"
      OKS+=("$rel")
      return 0
    fi

    if ! cmp -s "$src" "$dest"; then
      if [[ "$rel" == "pipeline/dropdowns/catalog.json" ]]; then
        if python3 - <<'PY' "$src" "$dest"
import json, sys

def load(path):
    with open(path, 'r') as f:
        data = json.load(f)
    if isinstance(data, dict):
        data.pop('syncedAt', None)
    return data

try:
    a = load(sys.argv[1])
    b = load(sys.argv[2])
    sys.exit(0 if a == b else 1)
except Exception:
    sys.exit(1)
PY
        then
          echo "OK: $rel (syncedAt ignored)"
          OKS+=("$rel")
          return 0
        fi
      fi
      echo "DIFF: $rel"
      diff -u "$src" "$dest" | sed 's/^/  /' || true
      DIFFS+=("$rel")
      return 1
    fi
    echo "OK: $rel"
    OKS+=("$rel")
    return 0
  else
    echo "SKIP (no prod source): $rel"
    SKIPS+=("$rel")
    return 0
  fi
}

show_dev_only() {
  echo "DEV-ONLY PATHS TO PURGE:"
  for rel in "${DEV_ONLY_PATHS[@]}"; do
    local target="$DEV_DIR/$rel"
    if [ -e "$target" ]; then
      echo "  PURGE: $rel"
      PURGE+=("$rel")
    else
      echo "  (missing) $rel"
    fi
  done
}

check_vocab_guard() {
  echo "VOCABULARY GUARD FILES:"
  for rel in "${VOCAB_GUARD_FILES[@]}"; do
    local file="$ROOT_DIR/$rel"
    if [ -f "$file" ]; then
      local hash
      hash=$(shasum -a 256 "$file" | awk '{print $1}')
      echo "  OK: $rel ($hash)"
      VOCAB_STATUS+=("OK:$rel:$hash")
    else
      echo "  MISSING: $rel"
      VOCAB_STATUS+=("MISSING:$rel")
    fi
  done
}

write_report() {
  [ -z "$REPORT_PATH" ] && return 0
  mkdir -p "$(dirname "$REPORT_PATH")"
  MODE="$MODE" TS="$TS" DEV_DIR="$DEV_DIR" DATA_DIR="$DATA_DIR" REPORT_PATH="$REPORT_PATH" \
  REPORT_PURGE=$(printf '%s\n' "${PURGE[@]-}") \
  REPORT_DIFFS=$(printf '%s\n' "${DIFFS[@]-}") \
  REPORT_MISSING=$(printf '%s\n' "${MISSING[@]-}") \
  REPORT_OK=$(printf '%s\n' "${OKS[@]-}") \
  REPORT_SKIPS=$(printf '%s\n' "${SKIPS[@]-}") \
  REPORT_VOCAB=$(printf '%s\n' "${VOCAB_STATUS[@]-}") \
  python3 - <<'PY'
import json, os

def split_env(key):
    raw = os.environ.get(key, '')
    if not raw.strip():
        return []
    return [line for line in raw.split('\n') if line.strip()]

payload = {
  "mode": os.environ.get("MODE", "").replace("--", ""),
  "timestamp": os.environ.get("TS", ""),
  "devRoot": os.environ.get("DEV_DIR", ""),
  "prodRoot": os.environ.get("DATA_DIR", ""),
  "purge": split_env("REPORT_PURGE"),
  "diffs": split_env("REPORT_DIFFS"),
  "missing": split_env("REPORT_MISSING"),
  "ok": split_env("REPORT_OK"),
  "skips": split_env("REPORT_SKIPS"),
  "vocabGuard": split_env("REPORT_VOCAB"),
}

with open(os.environ["REPORT_PATH"], "w") as f:
    json.dump(payload, f, indent=2)
PY
  echo "REPORT: $REPORT_PATH"
}

align_ok=1

if [ "$MODE" = "--dry-run" ]; then
  echo "DRY RUN — no files will be modified"
  show_dev_only
  check_vocab_guard
  for rel in "${CANONICAL_FILES[@]}"; do
    if ! report_diff "$rel"; then
      align_ok=0
    fi
  done
  write_report

  if [ "$align_ok" -eq 1 ]; then
    echo "ALIGNMENT_OK"
    exit 0
  else
    echo "ALIGNMENT_MISMATCH"
    exit 1
  fi
fi

# --apply mode
mkdir -p "$BACKUP_DIR"

# Backup current dev data
rsync -a "$DEV_DIR/" "$BACKUP_DIR/" >/dev/null

# Confirmation before purge/reset
if [[ "$AUTO_YES" != "true" ]]; then
  echo "====================================="
  echo "DEV ALIGNMENT APPLY (DESTRUCTIVE TO DEV DATA)"
  echo "This will purge/reset the following dev-only paths:"
  for rel in "${DEV_ONLY_PATHS[@]}"; do
    echo "  - $rel"
  done
  echo "And restore canonical data files from prod baseline."
  echo "Type 'APPLY' to continue:"
  read -r CONFIRM
  if [[ "$CONFIRM" != "APPLY" ]]; then
    echo "Aborted. No changes applied."
    exit 1
  fi
fi

# Clear dev-only data
rm -rf "$DEV_DIR/logs" "$DEV_DIR/agents" "$DEV_DIR/pipeline" || true
rm -f "$DEV_DIR/consolidation-review.json" || true

# Restore from prod baseline (only canonical data paths)
for rel in "${CANONICAL_FILES[@]}"; do
  src="$DATA_DIR/$rel"
  dest="$DEV_DIR/$rel"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  fi
done

show_dev_only
check_vocab_guard

# Verify alignment
for rel in "${CANONICAL_FILES[@]}"; do
  if ! report_diff "$rel"; then
    align_ok=0
  fi
done

write_report

if [ "$align_ok" -eq 1 ]; then
  echo "ALIGNMENT_OK"
  exit 0
else
  echo "ALIGNMENT_MISMATCH"
  exit 1
fi
