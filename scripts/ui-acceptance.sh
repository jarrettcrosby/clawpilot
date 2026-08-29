#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
BASE_URL="${UI_BASE_URL:-http://localhost:4002}"

if [[ "$BASE_URL" == "http://localhost:4002" ]]; then
  if [[ "${UI_REUSE_RUNNING_SERVER:-0}" == "1" ]]; then
    curl --fail --silent --show-error "$BASE_URL/api/health" >/dev/null
  else
    "$REPO_ROOT/scripts/dev-start.sh"
  fi
fi

cd "$REPO_ROOT/app_src"
npx playwright test \
  --config=playwright.ui.config.ts \
  tests/responsive-shell/ui-acceptance.spec.ts \
  tests/mobile-workflows/ui-acceptance.spec.ts \
  tests/pos/ui-acceptance.spec.ts \
  tests/operations/ui-acceptance.spec.ts \
  tests/carrier-connections/ui-acceptance.spec.ts \
  tests/pipeline-reporting/ui-acceptance.spec.ts \
  "$@"
