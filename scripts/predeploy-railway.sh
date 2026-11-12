#!/usr/bin/env bash
set -euo pipefail

case "${CLAWPILOT_POSTGRES_CUSTODY:-}" in
  '')
    if [[ -n "${CLAWPILOT_POSTGRES_RUNTIME_ROLE:-}${CLAWPILOT_POSTGRES_OPERATOR_ROLE:-}" ]]; then
      echo 'PostgreSQL custody roles require split-v1' >&2; exit 1
    fi
    ;;
  split-v1) node scripts/verify-postgres-custody.mjs ;;
  *) echo 'Unknown PostgreSQL custody mode' >&2; exit 1 ;;
esac

npm run mail:verify
npm run db:preflight:commerce-storage
if [[ "${CLAWPILOT_POSTGRES_CUSTODY:-}" != 'split-v1' ]]; then
  npm run db:migrate
fi
npm run verify:commerce-order-revision-evidence-keys
if [[ "${CLAWPILOT_POSTGRES_CUSTODY:-}" != 'split-v1' ]]; then
  npm run demo:seed
fi
npm run demo:verify
