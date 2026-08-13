#!/usr/bin/env bash
set -euo pipefail

npm run mail:verify
npm run db:migrate
npm run verify:commerce-order-revision-evidence-keys
npm run demo:seed
npm run demo:verify
