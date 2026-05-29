#!/usr/bin/env bash
set -euo pipefail
# Template: writes JSON manifest for each rollout.
# Replace /Users/agentsuburbiasandwich/Desktop/clawd-app-dev, data-dev.
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
BACKUPS_DIR="$DEV_REPO/data-dev/backups"
