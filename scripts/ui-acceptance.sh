#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

cd "$DEV_REPO/app_src"
npx playwright test --config=playwright.ui.config.ts
