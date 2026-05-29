#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
FREEZE_PATH="${FREEZE_PATH:-$DEV_REPO/data-dev/freeze.json}"

REQUIRE_FREEZE=0

usage() {
  cat <<'USAGE'
Usage: rollout-guard.sh [--require-freeze]

Verifies mandatory preflight evidence:
- latest promotion-check report is READY
- latest promotion-dry-run report is READY (verifyStatus ok)
- latest alignment dry-run is OK
- optional: freeze is enabled
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-freeze)
      REQUIRE_FREEZE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
 done

BACKUPS_DIR="$DEV_REPO/data-dev/backups"

latest_file() {
  local prefix="$1"
  ls -t "$BACKUPS_DIR"/${prefix}*.json 2>/dev/null | head -n 1 || true
}

PROMO_CHECK=$(latest_file "promotion-check-")
PROMO_DRY=$(latest_file "promotion-dry-run-")
ALIGN_DRY=$(latest_file "dry-run-")

if [[ -z "$PROMO_CHECK" || -z "$PROMO_DRY" || -z "$ALIGN_DRY" ]]; then
  echo "ERROR: missing required reports (promotion-check, promotion-dry-run, dry-run)"
  exit 1
fi

python3 - <<'PY' "$PROMO_CHECK" "$PROMO_DRY" "$ALIGN_DRY"
import json, sys

promo_check, promo_dry, align = sys.argv[1:]

def load(path):
    with open(path, 'r') as f:
        return json.load(f)

pc = load(promo_check)
pd = load(promo_dry)
ad = load(align)

if pc.get('status') != 'ready':
    raise SystemExit('ERROR: promotion-check not READY')
if pd.get('status') != 'ready':
    raise SystemExit('ERROR: promotion-dry-run not READY')
if pd.get('verifyStatus') not in (None, 'ok'):
    raise SystemExit('ERROR: promotion-dry-run verifyStatus not ok')

# alignment dry-run passes when canonical mismatches are empty.
# NOTE: `purge` entries in dry-run are expected informational dev-only paths and are not failures.
if ad.get('diffs') or ad.get('missing'):
    raise SystemExit('ERROR: alignment dry-run not OK')

print('OK: rollout guard reports satisfied')
PY

if [[ "$REQUIRE_FREEZE" -eq 1 ]]; then
  if [[ ! -f "$FREEZE_PATH" ]]; then
    echo "ERROR: rollout freeze not enabled"
    exit 1
  fi
  if ! python3 - <<'PY' "$FREEZE_PATH"
import json, sys
with open(sys.argv[1], 'r') as f:
    data = json.load(f)
if not data.get('frozen'):
    raise SystemExit(1)
PY
  then
    echo "ERROR: rollout freeze not enabled"
    exit 1
  fi
  echo "OK: rollout freeze enabled"
fi
