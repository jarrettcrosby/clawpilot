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
php -d memory_limit=384M /fixture/acceptance.php
if [ "${CLAWPILOT_NATIVE_FIXTURE_REMEDIATION:-0}" = "1" ]; then
  # Exercise the actual offline installer against private copies before any PHP
  # server starts; process quiescence must not be bypassed by the fixture.
  php -l /source/install-native-email-scope.php
  php -l /fixture-scope-installer.php
  CLAWPILOT_NATIVE_SCOPE_INSTALLER_TEST=1 php -d memory_limit=384M /fixture-scope-installer.php /source/suitecrm
  php -d memory_limit=384M /fixture/prepare-remediation.php
  php -d memory_limit=384M /fixture/remediation-acceptance.php
  php -l /fixture/http-router.php
  php -l /fixture/http-acceptance.php
  # Loopback stays inside this isolated container. No Docker/host port is published.
  php -d memory_limit=384M -d display_errors=0 -S 127.0.0.1:8099 \
    -t /app/public/legacy /fixture/http-router.php >/tmp/native-http.log 2>&1 &
  http_pid=$!
  trap 'kill "$http_pid" 2>/dev/null || true' EXIT INT TERM
  php -d memory_limit=384M /fixture/http-acceptance.php
  php -l /fixture/managed-email-lifecycle-helper.php
  php -l /fixture/managed-email-lifecycle.php
  php -d memory_limit=384M /fixture/managed-email-lifecycle.php
  php -l /fixture/future-email-defaults.php
  php -d memory_limit=384M /fixture/future-email-defaults.php
  php -l /source/email-audience/NativeEmailTransaction.php
  php -l /fixture/native-policy-fence.php
  php -d memory_limit=384M /fixture/native-policy-fence.php
fi
