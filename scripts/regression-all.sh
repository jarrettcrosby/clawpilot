#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

cd "$REPO_ROOT"

npm run lint
npm run test
npm run verify:predeploy
./scripts/dev-start.sh
bash scripts/dev-verify.sh
(
  cd app_src
  npx playwright test --config=playwright.ui.config.ts tests/responsive-shell/ui-acceptance.spec.ts
)

echo "REGRESSION_ALL_OK"
