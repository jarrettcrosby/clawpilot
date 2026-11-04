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
  # Fixture route packages are installed separately. Stop/reap this exact child
  # before replacing packages: production also requires quiescent PHP workers,
  # and hot replacement can retain path/runtime caches from an earlier stage.
  http_pid=''
  verify_native_http_owner() {
    php -r '
      $pid=$argv[1];$parent=$argv[2];
      if(!ctype_digit($pid)||!ctype_digit($parent))exit(1);
      $status=@file_get_contents("/proc/$pid/status");$raw=@file_get_contents("/proc/$pid/cmdline");
      $expected=["php","-d","memory_limit=384M","-d","display_errors=0","-S","127.0.0.1:8099","-t","/app/public/legacy","/fixture/http-router.php"];
      if(!is_string($status)||!preg_match("/^PPid:\\s+([0-9]+)$/m",$status,$match)||$match[1]!==$parent
        ||!is_string($raw)||explode("\0",rtrim($raw,"\0"))!==$expected)exit(1);
    ' "$http_pid" "$$"
  }
  stop_native_http() {
    if [ -n "$http_pid" ]; then
      if kill -0 "$http_pid" 2>/dev/null; then
        verify_native_http_owner || return 1
        kill "$http_pid"
      fi
      wait "$http_pid" 2>/dev/null || true
      http_pid=''
    fi
  }
  start_native_http() {
    php -d memory_limit=384M -d display_errors=0 -S 127.0.0.1:8099 \
      -t /app/public/legacy /fixture/http-router.php >>/tmp/native-http.log 2>&1 &
    http_pid=$!
    # TCP readiness only. Do not initialize native route discovery before the
    # next fixture has staged its exact package and made its first OAuth call.
    php -r 'for($n=0;$n<40;$n++){ $s=@fsockopen("127.0.0.1",8099,$errno,$error,0.1); if($s){fclose($s);exit(0);} usleep(50000); } exit(1);'
    verify_native_http_owner
  }
  trap 'stop_native_http' EXIT
  trap 'stop_native_http; exit 1' INT TERM
  start_native_http
  php -d memory_limit=384M /fixture/http-acceptance.php
  php -l /fixture/managed-email-lifecycle-helper.php
  php -l /fixture/managed-email-lifecycle.php
  php -d memory_limit=384M /fixture/managed-email-lifecycle.php
  php -l /fixture/future-email-defaults.php
  php -d memory_limit=384M /fixture/future-email-defaults.php
  php -l /source/email-audience/NativeEmailTransaction.php
  php -l /source/email-audience/NativeEmailAuthorityDelta.php
  php -l /source/email-audience/NativeEmailAuthorityContract.php
  php -l /source/email-audience/NativeEmailAuthorityProof.php
  php -l /source/email-audience/NativeEmailAuthorityTransition.php
  php -l /source/email-audience/authority-routes.php
  php -l /source/email-audience/NativeEmailCapabilityContract.php
  php -l /fixture/native-email-capability-contract.php
  php /fixture/native-email-capability-contract.php /source/email-audience/NativeEmailCapabilityContract.php --fixture=/fixture-capability-contract.json
  php -l /fixture/native-authority-contract.php
  php /fixture/native-authority-contract.php
  php -l /fixture/native-authority-issuer.php
  php /fixture/native-authority-issuer.php
  php -l /fixture/native-policy-fence.php
  php -d memory_limit=384M /fixture/native-policy-fence.php
  php -l /fixture/native-email-group-delta.php
  php -d memory_limit=384M /fixture/native-email-group-delta.php
  php -l /source/email-audience/NativeEmailProjection.php
  php -l /fixture/native-email-projection.php
  php -d memory_limit=384M /fixture/native-email-projection.php
  php -l /source/email-audience/NativeEmailRuntime.php
  php -l /source/email-audience/NativeEmailPublisher.php
  php -l /fixture/native-publisher.php
  php -d memory_limit=384M /fixture/native-publisher.php
  php -l /fixture/native-publisher-race.php
  php -d memory_limit=384M /fixture/native-publisher-race.php
  php -l /fixture/native-publisher-authorization.php
  php -d memory_limit=384M /fixture/native-publisher-authorization.php
  php -l /fixture/native-publisher-storage.php
  php -d memory_limit=384M /fixture/native-publisher-storage.php
  php -l /fixture/native-publisher-http.php
  php -d memory_limit=384M /fixture/native-publisher-http.php
  php -l /fixture/native-authority-transition.php
  php -d memory_limit=384M /fixture/native-authority-transition.php
  stop_native_http
  start_native_http
  php -l /fixture/native-authority-http.php
  php -d memory_limit=384M /fixture/native-authority-http.php
  php -l /fixture/native-publisher-v2.php
  php -d memory_limit=384M /fixture/native-publisher-v2.php
  php -l /fixture/native-authority-v2.php
  php -d memory_limit=384M /fixture/native-authority-v2.php
  if [ "${CLAWPILOT_NATIVE_FIXTURE_APP_PG:-0}" = "1" ]; then
    stop_native_http
    php -d memory_limit=384M /fixture/native-app-pg.php prepare </fixture-combined-public.pem
    php -d memory_limit=384M /fixture/native-app-pg.php profile
    start_native_http
    touch /tmp/native-app-pg-ready
    # One bounded handoff to the host's actual app/PG coordinator. The native
    # server stays on container loopback; no credential is printed or persisted
    # outside disposable tmpfs. Parent runner has its independent hard deadline.
    attempts=0
    while [ ! -f /tmp/native-app-pg-done ]; do
      attempts=$((attempts + 1))
      # The host now verifies root inheritance plus two real user-lifecycle
      # transitions in addition to sharing and lost-response recovery. This is
      # the total fixture handoff budget, never the five-second DB commit cap.
      if [ "$attempts" -gt 300 ]; then
        printf 'NATIVE_APP_PG_HANDOFF_EXPIRED=300\n' >&2
        exit 1
      fi
      sleep 1
    done
    printf 'NATIVE_APP_PG_FINISHED=1\n'
  fi
fi
