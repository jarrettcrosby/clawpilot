#!/usr/bin/env bash
set -euo pipefail

cd /var/lib/suitecrm/app
while true; do
  php public/legacy/cron.php || true
  sleep 60
done
