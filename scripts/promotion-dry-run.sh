#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

ok() { echo "OK: $*"; }
warn() { echo "WARN: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$DEV_REPO" ]]; then
  fail "Run from dev repo ($DEV_REPO)"
fi

SUMMARY_BLOCKERS=()

note_blocker() {
  SUMMARY_BLOCKERS+=("$1")
}

banner() {
  echo "====================================="
  echo "PROMOTION DRY-RUN (NO STABLE CHANGES)"
  echo "====================================="
}

banner
TS="$(date +"%Y%m%d-%H%M%S")"
REPORT_PATH="$DEV_REPO/data-dev/backups/promotion-dry-run-$TS.json"
ALIGN_REPORT=""
PROMO_REPORT=""

# Step 1: Canonical full regression gate
set +e
REG_OUT=$("$DEV_REPO/scripts/regression-all.sh" 2>&1)
REG_CODE=$?
set -e
printf "%s\n" "$REG_OUT"
if [[ "$REG_CODE" -ne 0 ]]; then
  note_blocker "Full regression suite failed"
else
  ok "full regression"
fi

# Step 2: Dev alignment check
set +e
ALIGN_OUT=$("$DEV_REPO/scripts/dev-align-from-prod.sh" --dry-run --report 2>&1)
ALIGN_CODE=$?
set -e
printf "%s\n" "$ALIGN_OUT"
ALIGN_REPORT=$(printf "%s\n" "$ALIGN_OUT" | awk -F"REPORT: " '/REPORT: /{print $2}' | tail -n 1)
if [[ "$ALIGN_CODE" -ne 0 ]]; then
  note_blocker "Alignment mismatch in dev data"
else
  ok "alignment dry-run"
fi

# Step 3: Promotion readiness check (dev)
set +e
PROMO_OUT=$("$DEV_REPO/scripts/dev-promotion-check.sh" 2>&1)
PROMO_CODE=$?
set -e
printf "%s\n" "$PROMO_OUT"
PROMO_REPORT=$(printf "%s\n" "$PROMO_OUT" | awk -F"REPORT: " '/REPORT: /{print $2}' | tail -n 1)
if [[ "$PROMO_CODE" -ne 0 ]]; then
  note_blocker "Promotion readiness check failed"
else
  ok "promotion readiness"
fi

# Step 3: Runtime identity check (dev)
RUNTIME_JSON=$(curl -s http://127.0.0.1:4002/api/runtime || true)
DEV_COMMIT=$(python3 - <<'PY' "$RUNTIME_JSON"
import json,sys
try:
  j=json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
  print(j.get('commit',''))
except Exception:
  print('')
PY
)
if [[ -z "$DEV_COMMIT" ]]; then
  note_blocker "Dev runtime commit missing"
else
  ok "dev runtime commit ${DEV_COMMIT:0:7}"
fi

# Step 4: Board hygiene gate
set +e
HYGIENE_OUT=$("$DEV_REPO/scripts/verify-board-hygiene.sh" promotion 2>&1)
HYGIENE_CODE=$?
set -e
printf "%s\n" "$HYGIENE_OUT"
if [[ "$HYGIENE_CODE" -ne 0 ]]; then
  note_blocker "PROMOTION_BLOCKED_BOARD_HYGIENE"
else
  ok "board hygiene"
fi

# Step 5: Promotion task eligibility gate (dev-only/test/validation block)
set +e
ELIG_OUT=$("$DEV_REPO/scripts/verify-promotion-task-eligibility.sh" 2>&1)
ELIG_CODE=$?
set -e
printf "%s\n" "$ELIG_OUT"
if [[ "$ELIG_CODE" -ne 0 ]]; then
  note_blocker "PROMOTION_BLOCKED_DEV_ONLY_TASKS"
else
  ok "promotion task eligibility"
fi

# Step 6: Unified lane verification
set +e
VERIFY_OUT=$(ROUTE_CHECKS_STABLE="/api/health /api/runtime /" ROUTE_CHECKS_DEV="/api/health /api/runtime /api/promotion-report /" "$CONTROL_REPO/scripts/runtime-verify-all.sh" 2>&1)
VERIFY_CODE=$?
set -e
printf "%s\n" "$VERIFY_OUT"
if [[ "$VERIFY_CODE" -ne 0 ]]; then
  note_blocker "Unified lane verification failed"
else
  ok "lane verification"
fi

# Write dry-run report JSON
mkdir -p "$(dirname "$REPORT_PATH")"
REPORT_BLOCKERS=$(printf '%s\n' "${SUMMARY_BLOCKERS[@]-}") \
ALIGN_REPORT="$ALIGN_REPORT" PROMO_REPORT="$PROMO_REPORT" RUNTIME_JSON="$RUNTIME_JSON" \
REG_CODE="${REG_CODE:-1}" ELIG_CODE="${ELIG_CODE:-1}" VERIFY_CODE="$VERIFY_CODE" HYGIENE_CODE="${HYGIENE_CODE:-1}" ALIGN_CODE="$ALIGN_CODE" PROMO_CODE="$PROMO_CODE" TS="$TS" \
REPORT_PATH="$REPORT_PATH" python3 - <<'PY'
import json, os

def split_env(key):
    raw = os.environ.get(key, '')
    if not raw.strip():
        return []
    return [line for line in raw.split('\n') if line.strip()]

def load_runtime():
    raw = os.environ.get('RUNTIME_JSON', '')
    try:
        return json.loads(raw) if raw else None
    except Exception:
        return None

status = 'ready'
if int(os.environ.get('REG_CODE', '1')) != 0 or int(os.environ.get('ALIGN_CODE', '1')) != 0 or int(os.environ.get('PROMO_CODE', '1')) != 0 or int(os.environ.get('HYGIENE_CODE', '1')) != 0 or int(os.environ.get('ELIG_CODE', '1')) != 0 or int(os.environ.get('VERIFY_CODE', '1')) != 0:
    status = 'blocked'

payload = {
  "timestamp": os.environ.get("TS", ""),
  "status": status,
  "blockers": split_env("REPORT_BLOCKERS"),
  "runtime": load_runtime(),
  "alignmentReport": os.environ.get("ALIGN_REPORT") or None,
  "promotionCheckReport": os.environ.get("PROMO_REPORT") or None,
  "verifyStatus": "ok" if int(os.environ.get('VERIFY_CODE', '1')) == 0 else "failed",
}
with open(os.environ["REPORT_PATH"], "w") as f:
    json.dump(payload, f, indent=2)
print(f"REPORT: {os.environ['REPORT_PATH']}")
PY

# Final summary
echo ""
echo "====================================="
echo "DRY-RUN SUMMARY"
echo "====================================="
echo "This dry-run does NOT modify stable."
echo "A real promotion would:"
echo "- Apply dev alignment to prod data (if needed)"
echo "- Rebuild/restart stable runtime"
echo "- Verify stable routes"

if [[ ${#SUMMARY_BLOCKERS[@]} -gt 0 ]]; then
  echo "\nBLOCKERS:" 
  for b in "${SUMMARY_BLOCKERS[@]}"; do
    echo "- $b"
  done
  echo "PROMOTION_DRY_RUN_BLOCKED"
  exit 1
fi

echo "\nNo blockers detected."
echo "PROMOTION_DRY_RUN_READY"
