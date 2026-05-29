#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
BACKUPS_DIR="$DEV_REPO/data-dev/backups"
FREEZE_PATH="${FREEZE_PATH:-$DEV_REPO/data-dev/freeze.json}"

PHASE=""
STATUS=""
COMMIT=""
PROMOTION_REPORT=""

usage() {
  cat <<'USAGE'
Usage: rollout-manifest.sh --phase <promotion|code|combined> --status <ok|failed> --commit <sha> [--promotion-report <path>]

Writes a rollout manifest JSON linking guard reports and verification status.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE="$2"; shift 2;;
    --status)
      STATUS="$2"; shift 2;;
    --commit)
      COMMIT="$2"; shift 2;;
    --promotion-report)
      PROMOTION_REPORT="$2"; shift 2;;
    -h|--help)
      usage; exit 0;;
    *)
      usage; exit 1;;
  esac
 done

if [[ -z "$PHASE" || -z "$STATUS" || -z "$COMMIT" ]]; then
  usage
  exit 1
fi

latest_file() {
  local prefix="$1"
  ls -t "$BACKUPS_DIR"/${prefix}*.json 2>/dev/null | head -n 1 || true
}

PROMO_CHECK=$(latest_file "promotion-check-")
PROMO_DRY=$(latest_file "promotion-dry-run-")
ALIGN_DRY=$(latest_file "dry-run-")

FREEZE_ENABLED_AT=""
FREEZE_ENABLED_BY=""
FREEZE_REASON=""
if [[ -f "$FREEZE_PATH" ]]; then
  FREEZE_ENABLED_AT=$(python3 - <<'PY' "$FREEZE_PATH"
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('enabledAt',''))
except Exception:
    print('')
PY
  )
  FREEZE_ENABLED_BY=$(python3 - <<'PY' "$FREEZE_PATH"
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('enabledBy',''))
except Exception:
    print('')
PY
  )
  FREEZE_REASON=$(python3 - <<'PY' "$FREEZE_PATH"
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('reason',''))
except Exception:
    print('')
PY
  )
fi

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
OUT_PATH="$BACKUPS_DIR/rollout-manifest-$(date +"%Y%m%d-%H%M%S").json"

python3 - <<'PY' "$OUT_PATH" "$TS" "$PHASE" "$STATUS" "$COMMIT" "$PROMO_CHECK" "$PROMO_DRY" "$ALIGN_DRY" "$PROMOTION_REPORT" "$FREEZE_ENABLED_AT" "$FREEZE_ENABLED_BY" "$FREEZE_REASON"
import json,sys
out,ts,phase,status,commit,promo_check,promo_dry,align_dry,promo_report,freeze_at,freeze_by,freeze_reason = sys.argv[1:]

payload = {
  "timestamp": ts,
  "phase": phase,
  "status": status,
  "deployedCommit": commit,
  "reports": {
    "promotionCheck": promo_check or None,
    "promotionDryRun": promo_dry or None,
    "alignmentDryRun": align_dry or None,
    "promotionExecute": promo_report or None,
  },
  "freeze": {
    "enabledAt": freeze_at or None,
    "enabledBy": freeze_by or None,
    "reason": freeze_reason or None,
  },
}
with open(out, 'w') as f:
  json.dump(payload, f, indent=2)
print(f"MANIFEST: {out}")
PY
