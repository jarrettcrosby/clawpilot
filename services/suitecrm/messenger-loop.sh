#!/usr/bin/env bash
set -euo pipefail

cd /var/lib/suitecrm/app
while true; do
  php bin/console messenger:consume internal-async --time-limit=3600 --memory-limit=256M --no-interaction || true
  sleep 5
done
