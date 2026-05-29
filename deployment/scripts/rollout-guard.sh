#!/usr/bin/env bash
set -euo pipefail
# Template: enforce preflight + freeze
# Replace /Users/agentsuburbiasandwich/Desktop/clawd-app-dev and data paths.
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
BACKUPS_DIR="$DEV_REPO/data-dev/backups"
FREEZE_PATH="${FREEZE_PATH:-$DEV_REPO/data-dev/freeze.json}"

# Implement the same guard used in ClawApp: require latest promotion-check,
# promotion-dry-run, alignment dry-run, and optional freeze enabled.
