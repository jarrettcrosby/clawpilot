#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="$REPO_ROOT/data"
if [[ "$REPO_ROOT" == *"clawd-app-dev"* ]]; then
  DATA_DIR="$REPO_ROOT/data-dev"
fi

FREEZE_PATH="${FREEZE_PATH:-$DATA_DIR/freeze.json}"
REASON="${1:-production rollout}"
ACTOR="${ACTOR:-operator}"
TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mkdir -p "$(dirname "$FREEZE_PATH")"
cat > "$FREEZE_PATH" <<JSON
{
  "frozen": true,
  "reason": "$REASON",
  "enabledAt": "$TS",
  "enabledBy": "$ACTOR"
}
JSON

echo "FREEZE_ENABLED: $FREEZE_PATH"
