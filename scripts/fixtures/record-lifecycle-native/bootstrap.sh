#!/bin/sh
set -eu
cp -a /source/suitecrm/. /app/
cd /app
php -d memory_limit=384M bin/console suitecrm:app:install --no-interaction \
  -u fixture-admin -p Synthetic-native-admin-password-only \
  -U fixture -P Synthetic-native-db-password-only -H db -Z 3306 -N suitecrm_native_test \
  -S http://127.0.0.1:8099 -d no -W true >/tmp/install.log 2>&1 || {
    tail -n 30 /tmp/install.log
    exit 1
  }
php -d memory_limit=384M /fixture/acceptance.php prepare
php /package/install-record-lifecycle.php --apply /app/public/legacy
php -d memory_limit=384M -d display_errors=0 -S 127.0.0.1:8099 \
  -t /app/public/legacy /fixture/http-router.php >/tmp/http.log 2>&1 &
http_pid=$!
trap 'kill "$http_pid" 2>/dev/null || true; wait "$http_pid" 2>/dev/null || true' EXIT
trap 'exit 1' INT TERM
php -r 'for($n=0;$n<60;$n++){ $s=@fsockopen("127.0.0.1",8099,$e,$m,0.1); if($s){fclose($s);exit(0);} usleep(50000); } exit(1);'
php -d memory_limit=384M /fixture/acceptance.php verify
