#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

COMMIT=""

usage() {
  cat <<'USAGE'
Usage: combined-rollout.sh --commit <sha>

Combined operator-guided rollout:
- Preflight checks
- Freeze enable
- Data/state promotion
- Stable code deploy to commit
- Stable + dual-lane verification
- Freeze disable
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      COMMIT="$2"
      shift 2
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

if [[ -z "$COMMIT" ]]; then
  usage
  exit 1
fi

if ! git -C "$DEV_REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  echo "ERROR: commit not found in dev repo: $COMMIT"
  exit 1
fi

banner() {
  echo "====================================="
  echo "$*"
  echo "====================================="
}

banner "COMBINED ROLLOUT (OPERATOR-GUIDED)"

echo "Target code commit: ${COMMIT:0:7}"

banner "PRE-FLIGHT"
"$DEV_REPO/scripts/regression-all.sh"
"$DEV_REPO/scripts/dev-align-from-prod.sh" --dry-run --report
"$DEV_REPO/scripts/dev-promotion-check.sh"
"$DEV_REPO/scripts/promotion-dry-run.sh"
ROUTE_CHECKS_STABLE="/api/health /api/runtime /" ROUTE_CHECKS_DEV="/api/health /api/runtime /api/promotion-report /" "$CONTROL_REPO/scripts/runtime-verify-all.sh"

echo ""
 banner "FREEZE ENABLE"
"$DEV_REPO/scripts/freeze-enable.sh" "production rollout"

banner "DATA/STATE PROMOTION"
"$DEV_REPO/scripts/promotion-execute.sh"

banner "STABLE CODE DEPLOY"
"$DEV_REPO/scripts/stable-code-deploy.sh" --commit "$COMMIT"

banner "POST-ROLLOUT VERIFICATION"
ROUTE_CHECKS="/api/health /api/runtime /" "$CONTROL_REPO/scripts/stable-verify.sh"
ROUTE_CHECKS_STABLE="/api/health /api/runtime /" ROUTE_CHECKS_DEV="/api/health /api/runtime /api/promotion-report /" "$CONTROL_REPO/scripts/runtime-verify-all.sh"

banner "FREEZE DISABLE"
"$DEV_REPO/scripts/freeze-disable.sh"

echo "OK: combined rollout complete"
