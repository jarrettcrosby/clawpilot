#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

ok() { echo "OK: $*"; }
fail() { echo "ERROR: $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
if [[ "$REPO_ROOT" != "$DEV_REPO" ]]; then
  fail "Run from dev repo ($DEV_REPO)"
fi

echo "====================================="
echo "FULL REGRESSION SUITE (CANONICAL)"
echo "====================================="

"$DEV_REPO/scripts/dev-verify.sh"
ok "dev-verify"

"$DEV_REPO/scripts/runtime-verify-all.sh"
ok "runtime-verify-all"

bash "$DEV_REPO/scripts/smoke-tests.sh"
ok "smoke-tests"

bash "$DEV_REPO/scripts/critical-path-acceptance.sh"
ok "critical-path-acceptance"

bash "$DEV_REPO/scripts/ui-acceptance.sh"
ok "ui-acceptance"

echo "REGRESSION_ALL_OK"
