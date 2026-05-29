#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="$REPO_ROOT/data"
if [[ "$REPO_ROOT" == *"clawd-app-dev"* ]]; then
  DATA_DIR="$REPO_ROOT/data-dev"
fi

FREEZE_PATH="${FREEZE_PATH:-$DATA_DIR/freeze.json}"

if [[ -f "$FREEZE_PATH" ]]; then
  rm "$FREEZE_PATH"
  echo "FREEZE_DISABLED: $FREEZE_PATH"
else
  echo "FREEZE_NOT_SET: $FREEZE_PATH"
fi
