#!/bin/sh
set -eu
# All writable application state and generated configuration live on /app tmpfs.
cp -a /source/suitecrm/. /app/
cd /app
php -d memory_limit=384M bin/console suitecrm:app:install --no-interaction \
  -u fixture-admin -p Synthetic-native-admin-password-only \
  -U fixture -P Synthetic-native-db-password-only -H db -Z 3306 -N suitecrm_native_test \
  -S https://suitecrm-native.invalid -d no -W true >/tmp/native-install.log 2>&1 || {
    tail -n 70 /tmp/native-install.log
    exit 1
  }
exec php -d memory_limit=384M /fixture/acceptance.php
