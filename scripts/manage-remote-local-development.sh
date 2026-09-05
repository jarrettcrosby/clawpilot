#!/usr/bin/env bash
set -euo pipefail

DOMAIN="dev.aiapp.eigenracing.com"
INGRESS_PORT="4102"
INGRESS_HEADER="X-ClawPilot-Remote-Local-Ingress"
STATE_ROOT="${CLAWPILOT_REMOTE_LOCAL_STATE_ROOT:-$HOME/Library/Application Support/ClawPilot/remote-local-development}"
CADDYFILE="$STATE_ROOT/Caddyfile"
LOG_FILE="$STATE_ROOT/caddy.log"
PID_FILE="$STATE_ROOT/caddy.pid"

usage() {
  cat <<'USAGE'
Usage: scripts/manage-remote-local-development.sh <prepare|start-ingress|stop-ingress|status|funnel-command>

prepare         Validate secrets and write a mode-600 loopback Caddy config.
start-ingress   Start Caddy only after the app proves Postgres and application auth.
stop-ingress    Stop only the authenticated Caddy ingress; the app is unchanged.
status          Verify local bindings and the two fail-closed authentication layers.
funnel-command  Print, but do not run, the Tailscale Funnel command.

Required for prepare/start-ingress:
  CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET  random base64url, at least 43 characters
  CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH   hash from interactive `caddy hash-password`

Required for start-ingress/status:
  CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT
                                           exact UUID of the isolated local database

Optional:
  CLAWPILOT_REMOTE_LOCAL_USERNAME        defaults to operator

This script never starts ClawPilot or changes public DNS, Vercel, Railway,
Tailscale, or /etc/hosts. The app on 127.0.0.1:4002 must be an independently
started, isolated Postgres runtime with APP_AUTH_REQUIRED=1. The ordinary
authentication-disabled scripts/dev-start.sh fixture is rejected.
USAGE
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required." >&2
    exit 1
  fi
}

require_secret_inputs() {
  local secret="${CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET:-}"
  local username="${CLAWPILOT_REMOTE_LOCAL_USERNAME:-operator}"
  local password_hash="${CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH:-}"

  if [[ ! "$secret" =~ ^[A-Za-z0-9_-]{43,}$ ]]; then
    echo "CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET must be base64url and at least 43 characters." >&2
    exit 1
  fi
  if [[ ! "$username" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
    echo "CLAWPILOT_REMOTE_LOCAL_USERNAME contains unsupported characters." >&2
    exit 1
  fi
  local bcrypt_pattern='^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
  if [[ ! "$password_hash" =~ $bcrypt_pattern ]]; then
    echo "CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH must be one exact Caddy bcrypt hash." >&2
    exit 1
  fi
}

require_expected_database_fingerprint() {
  local fingerprint="${CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT:-}"
  local uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  if [[ ! "$fingerprint" =~ $uuid_pattern ]]; then
    echo "CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT must be the exact UUID of the isolated local database." >&2
    return 1
  fi
}

write_caddyfile() {
  require_tool caddy
  require_secret_inputs
  umask 077
  mkdir -p "$STATE_ROOT"
  chmod 700 "$STATE_ROOT"

  local secret="${CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET}"
  local username="${CLAWPILOT_REMOTE_LOCAL_USERNAME:-operator}"
  local password_hash="${CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH}"

  {
    printf '{\n  admin off\n}\n\n'
    printf 'http://127.0.0.1:%s {\n' "$INGRESS_PORT"
    printf '  @vercel header %s %s\n' "$INGRESS_HEADER" "$secret"
    printf '  handle @vercel {\n'
    printf '    basic_auth {\n'
    printf '      %s %s\n' "$username" "$password_hash"
    printf '    }\n'
    printf '    reverse_proxy 127.0.0.1:4002 {\n'
    printf '      header_up Host %s\n' "$DOMAIN"
    printf '      header_up X-Forwarded-Host %s\n' "$DOMAIN"
    printf '      header_up X-Forwarded-Proto https\n'
    printf '      header_up -Authorization\n'
    printf '      header_up -%s\n' "$INGRESS_HEADER"
    printf '    }\n'
    printf '  }\n'
    printf '  handle {\n'
    printf '    respond "Not found" 404\n'
    printf '  }\n'
    printf '}\n'
  } > "$CADDYFILE"

  chmod 600 "$CADDYFILE"
  caddy fmt --overwrite "$CADDYFILE" >/dev/null
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  echo "Prepared authenticated loopback ingress: $CADDYFILE"
}

running_pid() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    local process_command
    process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$process_command" == *"caddy run --config $CADDYFILE --adapter caddyfile"* ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    echo "Ignoring stale ingress PID file; PID $pid is not the managed Caddy process." >&2
  fi
  rm -f "$PID_FILE"
  return 1
}

verify_authenticated_upstream() {
  require_tool curl
  require_tool python3
  require_expected_database_fingerprint
  local forwarded_headers=(
    -H "Host: $DOMAIN"
    -H "X-Forwarded-Host: $DOMAIN"
    -H "X-Forwarded-Proto: https"
  )
  local base_url="http://127.0.0.1:4002"
  local root_headers root_status root_location login_status protected_status persistence

  root_headers="$(curl -sS --max-time 5 -o /dev/null -D - "${forwarded_headers[@]}" "$base_url/" || true)"
  root_status="$(printf '%s\n' "$root_headers" | awk 'toupper($1) ~ /^HTTP\// { status=$2 } END { print status }' | tr -d '\r')"
  root_location="$(printf '%s\n' "$root_headers" | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1 | tr -d '\r')"
  if [[ ! "$root_status" =~ ^30[2378]$ ]] \
    || [[ "$root_location" != "https://$DOMAIN/login"* ]]; then
    echo "Refusing ingress: the app root did not redirect to the exact HTTPS login origin." >&2
    return 1
  fi

  login_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    "${forwarded_headers[@]}" "$base_url/login" || true)"
  if [[ "$login_status" != "200" ]]; then
    echo "Refusing ingress: /login is unavailable (HTTP ${login_status:-none})." >&2
    return 1
  fi

  protected_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    "${forwarded_headers[@]}" "$base_url/api/tasks" || true)"
  if [[ "$protected_status" != "401" ]]; then
    echo "Refusing ingress: an unauthenticated protected API did not return 401 (HTTP ${protected_status:-none})." >&2
    return 1
  fi

  persistence="$(curl -sS --max-time 5 "${forwarded_headers[@]}" "$base_url/api/persistence/status" || true)"
  if ! python3 - "$persistence" "$CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT" <<'PY'
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except Exception:
    raise SystemExit(1)

if not (
    payload.get("ok") is True
    and payload.get("driver") == "postgres"
    and payload.get("database") == "reachable"
    and payload.get("databaseFingerprint") == sys.argv[2]
):
    raise SystemExit(1)
PY
  then
    echo "Refusing ingress: persistence is not the approved healthy Postgres authority." >&2
    return 1
  fi

  echo "upstream: exact login redirect, protected API 401, and approved Postgres identity verified"
}

start_ingress() {
  require_expected_database_fingerprint
  write_caddyfile
  if running_pid >/dev/null; then
    echo "Authenticated remote-local ingress is already running." >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$INGRESS_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Refusing ingress: port $INGRESS_PORT is already in use." >&2
    exit 1
  fi
  verify_authenticated_upstream

  nohup caddy run --config "$CADDYFILE" --adapter caddyfile > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if ! running_pid >/dev/null; then
    echo "Authenticated ingress failed to start. See $LOG_FILE" >&2
    exit 1
  fi
  "$0" status
}

stop_ingress() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Authenticated remote-local ingress is not running."
    return 0
  fi
  kill "$pid"
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Stopped authenticated remote-local ingress."
      return 0
    fi
    sleep 0.1
  done
  echo "Ingress did not stop cleanly; PID $pid remains active." >&2
  exit 1
}

status_local() {
  local failed=0
  local pid=""
  if ! verify_authenticated_upstream; then
    failed=1
  fi
  if pid="$(running_pid)"; then
    echo "ingress: running on loopback (PID $pid)"
  else
    echo "ingress: not running"
    failed=1
  fi

  if ! lsof -nP -iTCP:"$INGRESS_PORT" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR > 1 { print $9 }' \
    | grep -Eq '^(127\.0\.0\.1|\[::1\]):'; then
    echo "binding: no loopback listener on $INGRESS_PORT"
    failed=1
  elif lsof -nP -iTCP:"$INGRESS_PORT" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR > 1 { print $9 }' \
    | grep -Evq '^(127\.0\.0\.1|\[::1\]):'; then
    echo "binding: unexpected non-loopback listener on $INGRESS_PORT"
    failed=1
  else
    echo "binding: loopback-only on $INGRESS_PORT"
  fi

  local direct_status secret_only_status
  direct_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$INGRESS_PORT/api/health" || true)"
  if [[ "$direct_status" == "404" ]]; then
    echo "direct bypass: rejected"
  else
    echo "direct bypass: expected 404, received ${direct_status:-no response}"
    failed=1
  fi

  if [[ -n "${CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET:-}" ]]; then
    secret_only_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
      -H "$INGRESS_HEADER: $CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET" \
      "http://127.0.0.1:$INGRESS_PORT/api/health" || true)"
    if [[ "$secret_only_status" == "401" ]]; then
      echo "operator authentication: required after trusted ingress"
    else
      echo "operator authentication: expected 401, received ${secret_only_status:-no response}"
      failed=1
    fi
  else
    echo "operator authentication: set CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET to verify"
    failed=1
  fi
  return "$failed"
}

case "${1:-}" in
  prepare)
    write_caddyfile
    echo "No service, Funnel, DNS, Vercel, Railway, or hosts-file change was made."
    ;;
  start-ingress)
    start_ingress
    ;;
  stop-ingress)
    stop_ingress
    ;;
  status)
    status_local
    ;;
  funnel-command)
    printf 'tailscale funnel --bg --https=443 http://127.0.0.1:%s\n' "$INGRESS_PORT"
    ;;
  *)
    usage
    exit 1
    ;;
esac
