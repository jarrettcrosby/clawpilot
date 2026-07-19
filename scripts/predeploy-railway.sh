#!/usr/bin/env bash
set -euo pipefail

npm run mail:verify
npm run db:migrate
npm run demo:seed
npm run demo:verify
