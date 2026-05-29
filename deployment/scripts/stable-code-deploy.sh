#!/usr/bin/env bash
set -euo pipefail
# Template: operator‑gated stable code deploy.
# Replace /Users/agentsuburbiasandwich/Desktop/clawd-app-dev, /Users/agentsuburbiasandwich/Desktop/clawd-app-dev, 4001.
CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
ROUTE_CHECKS="${ROUTE_CHECKS:-/api/health /api/runtime /}"
# Include: guard, checkout, build, restart, verify.
