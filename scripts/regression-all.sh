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
UI_REUSE_RUNNING_SERVER=1 bash scripts/ui-acceptance.sh

echo "REGRESSION_ALL_OK"
