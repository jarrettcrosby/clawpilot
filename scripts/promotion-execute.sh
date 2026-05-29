#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

ok() { echo "OK: $*"; }
warn() { echo "WARN: $*"; }
fail() { echo "ERROR: $*"; echo "PROMOTION_EXECUTE_STOPPED_NO_FALLBACK"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$DEV_REPO" ]]; then
  fail "Run from dev repo ($DEV_REPO)"
fi

TS="$(date +"%Y%m%d-%H%M%S")"
REPORT_PATH="$DEV_REPO/data-dev/backups/promotion-execute-$TS.json"
STATUS="failed"

finish() {
  local status="$1"
  "$DEV_REPO/scripts/rollout-manifest.sh" --phase promotion --status "$status" --commit "$(git -C "$CONTROL_REPO" rev-parse HEAD 2>/dev/null || echo unknown)" --promotion-report "$REPORT_PATH" || true
}
trap 'finish "$STATUS"' EXIT

CANONICAL_FILES=(
  "tasks.json"
  "deleted-tasks.json"
  "agents/assignments.json"
  "agents/threads.json"
  "pipeline/dropdowns/catalog.json"
  "pipeline/normalized/opportunities.json"
  "pipeline/raw/opportunities.json"
)

SUMMARY=()
record() { SUMMARY+=("$1"); }

banner() {
  echo "====================================="
  echo "PROMOTION EXECUTION (OPERATOR-GUIDED)"
  echo "====================================="
}

banner

# Pre-step: allow regression writes (smoke/acceptance create+archive)
FREEZE_FILE="$DEV_REPO/data-dev/freeze.json"
if [[ -f "$FREEZE_FILE" ]] && jq -e '.frozen == true' "$FREEZE_FILE" >/dev/null 2>&1; then
  warn "dev freeze active before regression; temporarily disabling for preflight checks"
  "$DEV_REPO/scripts/freeze-disable.sh" >/dev/null
fi

# 1) Canonical full regression gate (hard requirement)
record "full-regression"
"$DEV_REPO/scripts/regression-all.sh"

# 2) Verify alignment dry-run
record "alignment-dry-run"
"$DEV_REPO/scripts/dev-align-from-prod.sh" --dry-run --report

# 3) Promotion readiness check
record "promotion-readiness"
"$DEV_REPO/scripts/dev-promotion-check.sh"

# 4) Board hygiene verification (pre-promotion)
record "board-hygiene"
"$DEV_REPO/scripts/verify-board-hygiene.sh" promotion

# 5) Promotion task eligibility gate (dev-only/test/validation block)
record "task-eligibility"
"$DEV_REPO/scripts/verify-promotion-task-eligibility.sh"

# 6) Unified lane verification (pre-promotion)
record "lane-verify-pre"
ROUTE_CHECKS_STABLE="/api/health /api/runtime /" ROUTE_CHECKS_DEV="/api/health /api/runtime /api/promotion-report /" "$CONTROL_REPO/scripts/runtime-verify-all.sh"

# Ensure freeze window before guarded rollout
record "freeze-enable"
"$DEV_REPO/scripts/freeze-enable.sh" "production rollout" >/dev/null

# Guard: required rollout evidence + freeze
"$DEV_REPO/scripts/rollout-guard.sh" --require-freeze

# Final confirmation

echo ""
echo "====================================="
echo "FINAL CONFIRMATION"
echo "====================================="
echo "This will copy dev data into stable, then restart stable runtime."
echo "Type 'PROMOTE' to continue:"
read -r CONFIRM
if [[ "$CONFIRM" != "PROMOTE" ]]; then
  echo "Aborted. No changes applied."
  exit 1
fi

# Apply promotion (code + data)
record "apply-promotion"
BACKUP_DIR="$CONTROL_REPO/data/backups/promotion-$TS"
mkdir -p "$BACKUP_DIR"
rsync -a "$CONTROL_REPO/data/" "$BACKUP_DIR/" >/dev/null

DEV_COMMIT="$(git -C "$DEV_REPO" rev-parse HEAD)"
record "stable-code-sync"
# Ensure stable repo has the target dev commit
if ! git -C "$CONTROL_REPO" cat-file -e "$DEV_COMMIT^{commit}" 2>/dev/null; then
  git -C "$CONTROL_REPO" fetch "$DEV_REPO" "$DEV_COMMIT"
fi
# Move stable code to promoted dev commit (force to avoid tracked-file drift in stable workspace)
( cd "$CONTROL_REPO" && git checkout -f "$DEV_COMMIT" )

record "stable-build"
( cd "$CONTROL_REPO/app_src" && npm install >/dev/null )
( cd "$CONTROL_REPO/app_src" && ./node_modules/.bin/next build --webpack )

for rel in "${CANONICAL_FILES[@]}"; do
  src="$DEV_REPO/data-dev/$rel"
  dest="$CONTROL_REPO/data/$rel"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  fi
done

# Restart stable runtime
record "stable-restart"
"$CONTROL_REPO/scripts/stable-stop.sh"
ROUTE_CHECKS="/api/health /api/runtime /" "$CONTROL_REPO/scripts/stable-start.sh"

# Verify stable runtime
record "stable-verify"
ROUTE_CHECKS="/api/health /api/runtime /" "$CONTROL_REPO/scripts/stable-promotion-verify.sh"

# Final report
SUMMARY_LINES=$(printf '%s\n' "${SUMMARY[@]-}")
TS="$TS" REPORT_PATH="$REPORT_PATH" SUMMARY="$SUMMARY_LINES" python3 - <<'PY'
import json, os
payload = {
  "timestamp": os.environ.get("TS"),
  "report": os.environ.get("REPORT_PATH"),
  "steps": [s for s in os.environ.get("SUMMARY", "").split("\n") if s],
  "result": "PROMOTION_EXECUTED",
}
with open(os.environ["REPORT_PATH"], "w") as f:
  json.dump(payload, f, indent=2)
print(f"REPORT: {os.environ['REPORT_PATH']}")
PY

STATUS="ok"
ok "promotion execution complete"
