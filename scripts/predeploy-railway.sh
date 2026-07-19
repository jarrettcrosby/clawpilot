#!/usr/bin/env bash
set -euo pipefail

if [[ "${CLAWPILOT_DEMO_MODE:-0}" == "1" ]]; then
  [[ "${RAILWAY_ENVIRONMENT_NAME:-}" == "demo" ]] || {
    echo "[railway-predeploy] demo mode is only valid in the demo environment" >&2
    exit 1
  }
else
  npm run mail:verify
fi

npm run db:migrate

if [[ "${CLAWPILOT_DEMO_MODE:-0}" == "1" ]]; then
  npm run demo:seed
  npm run demo:verify
fi
