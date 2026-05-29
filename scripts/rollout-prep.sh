#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

ok() { echo "OK: $*"; }
warn() { echo "WARN: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

banner() {
  echo "====================================="
  echo "$*"
  echo "====================================="
}

STEP_STATUS=()
BLOCKERS=()

note_pass() { STEP_STATUS+=("PASS:$1"); }
note_fail() { STEP_STATUS+=("FAIL:$1"); BLOCKERS+=("$1"); }

run_step() {
  local name="$1"
  shift
  banner "$name"
  set +e
  local out
  out=$("$@" 2>&1)
  local code=$?
  set -e
  printf "%s\n" "$out"
  if [[ $code -eq 0 ]]; then
    note_pass "$name"
    return 0
  fi
  note_fail "$name"
  return 1
}

banner "PRODUCTION ROLLOUT PREP (READ-ONLY)"

# Step 1: Dev verification
run_step "Dev verification" "$DEV_REPO/scripts/dev-verify.sh"

# Step 2: Alignment dry-run
run_step "Alignment dry-run" "$DEV_REPO/scripts/dev-align-from-prod.sh" --dry-run --report

# Step 3: Promotion readiness
run_step "Promotion readiness" "$DEV_REPO/scripts/dev-promotion-check.sh"

# Step 4: Promotion dry-run
run_step "Promotion dry-run" "$DEV_REPO/scripts/promotion-dry-run.sh"

# Step 5: Stable verification (read-only)
run_step "Stable verification" "$CONTROL_REPO/scripts/stable-verify.sh"

banner "ROLLOUT PREP SUMMARY"

echo "What passed:"
for s in "${STEP_STATUS[@]-}"; do
  if [[ "$s" == PASS:* ]]; then
    echo "- ${s#PASS:}"
  fi
 done

echo ""
if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
  warn "Blockers found"
  echo "What remains:"
  for b in "${BLOCKERS[@]}"; do
    echo "- $b"
  done
  echo ""
  echo "Real rollout command (not run):"
  echo "  $DEV_REPO/scripts/promotion-execute.sh"
  echo ""
  echo "RESULT: NOT_READY"
  exit 1
fi

ok "All pre-rollout checks passed"

echo "What remains:"
 echo "- Operator confirmation to execute rollout"

echo ""
echo "Real rollout command (not run):"
 echo "  $DEV_REPO/scripts/promotion-execute.sh"

echo ""
echo "RESULT: READY"
