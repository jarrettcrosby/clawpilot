#!/usr/bin/env bash
set -euo pipefail

DOMAIN="dev.aiapp.eigenracing.com"
LABEL="com.clawpilot.local-development-proxy"
HOSTS_BEGIN="# BEGIN CLAWPILOT LOCAL DEVELOPMENT"
HOSTS_END="# END CLAWPILOT LOCAL DEVELOPMENT"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
HOSTS_HELPER="$SCRIPT_DIR/manage-local-development-hosts.py"
STATE_ROOT="${CLAWPILOT_LOCAL_DOMAIN_ROOT:-$HOME/Library/Application Support/ClawPilot/local-development-domain}"
TLS_DIR="$STATE_ROOT/tls"
CADDY_DATA_DIR="$STATE_ROOT/caddy-data"
CADDY_CONFIG_DIR="$STATE_ROOT/caddy-config"
CADDYFILE="$STATE_ROOT/Caddyfile"
CERT_FILE="$TLS_DIR/$DOMAIN.pem"
KEY_FILE="$TLS_DIR/$DOMAIN-key.pem"
PLIST_FILE="$STATE_ROOT/$LABEL.plist"
SYSTEM_PLIST="/Library/LaunchDaemons/$LABEL.plist"

usage() {
  cat <<'USAGE'
Usage: scripts/manage-local-development-domain.sh <prepare|enable|disable|status>

prepare  Generate an untrusted local certificate and proxy configuration.
enable   Trust the local CA, map dev.aiapp.eigenracing.com to loopback, install
         the local HTTPS proxy, and start ClawPilot on port 4002.
disable  Remove only the local hostname override and proxy service. It leaves
         the local app process and the shared mkcert CA trust intact. This is
         required before restoring a hosted Railway development environment.
status   Verify hostname resolution, proxy service state, and HTTPS health.

The enable/disable commands request one macOS administrator authorization.
They never change public DNS or any Railway resource.
USAGE
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Local development domain management currently supports macOS only." >&2
    exit 1
  fi
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required. Install it with: brew install $tool" >&2
    exit 1
  fi
}

write_runtime_files() {
  require_tool caddy
  require_tool mkcert
  umask 077
  mkdir -p "$TLS_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR" "$STATE_ROOT/logs"

  if [[ ! -s "$CERT_FILE" || ! -s "$KEY_FILE" ]]; then
    mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" \
      "$DOMAIN" localhost 127.0.0.1 ::1
  fi

  local caddy_bin
  caddy_bin="$(command -v caddy)"
  {
    printf '{\n  admin off\n}\n\n'
    printf 'https://%s {\n' "$DOMAIN"
    printf '  bind 127.0.0.1 ::1\n'
    printf '  tls "%s" "%s"\n' "$CERT_FILE" "$KEY_FILE"
    printf '  reverse_proxy 127.0.0.1:4002\n'
    printf '}\n'
  } > "$CADDYFILE"

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '  <key>Label</key><string>%s</string>\n' "$LABEL"
    printf '%s\n' '  <key>ProgramArguments</key><array>'
    printf '    <string>%s</string><string>run</string>\n' "$caddy_bin"
    printf '    <string>--config</string><string>%s</string>\n' "$CADDYFILE"
    printf '    <string>--adapter</string><string>caddyfile</string>\n'
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>EnvironmentVariables</key><dict>'
    printf '    <key>XDG_DATA_HOME</key><string>%s</string>\n' "$CADDY_DATA_DIR"
    printf '    <key>XDG_CONFIG_HOME</key><string>%s</string>\n' "$CADDY_CONFIG_DIR"
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$STATE_ROOT/logs/proxy.log"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$STATE_ROOT/logs/proxy-error.log"
    printf '%s\n' '</dict></plist>'
  } > "$PLIST_FILE"
  chmod 600 "$CERT_FILE" "$KEY_FILE" "$CADDYFILE" "$PLIST_FILE"
  plutil -lint "$PLIST_FILE" >/dev/null
  caddy fmt --overwrite "$CADDYFILE" >/dev/null
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
}

rewrite_hosts() {
  local action="$1"
  sudo /usr/bin/python3 "$HOSTS_HELPER" "$action" /etc/hosts \
    "$DOMAIN" "$HOSTS_BEGIN" "$HOSTS_END"
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder 2>/dev/null || true
}

verify_hosts_block() {
  /usr/bin/python3 "$HOSTS_HELPER" verify /etc/hosts \
    "$DOMAIN" "$HOSTS_BEGIN" "$HOSTS_END"
}

verify_effective_loopback_resolution() {
  /usr/bin/python3 - "$DOMAIN" <<'PY'
import ipaddress
import socket
import sys

domain = sys.argv[1]
addresses = {
    entry[4][0].split("%", 1)[0]
    for entry in socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
}
if not addresses:
    raise SystemExit(f"{domain} did not resolve")
not_loopback = sorted(
    address
    for address in addresses
    if not ipaddress.ip_address(address).is_loopback
)
if not_loopback:
    raise SystemExit(
        f"{domain} has non-loopback effective resolution: "
        + ", ".join(not_loopback)
    )
PY
}

enable_domain() {
  write_runtime_files
  echo "Trusting the ClawPilot local certificate authority..."
  mkcert -install
  echo "Installing the loopback hostname and HTTPS proxy..."
  sudo -v
  rewrite_hosts enable
  verify_hosts_block
  verify_effective_loopback_resolution
  sudo launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  sudo install -o root -g wheel -m 600 "$PLIST_FILE" "$SYSTEM_PLIST"
  sudo launchctl bootstrap system "$SYSTEM_PLIST"
  sudo launchctl enable "system/$LABEL"
  CLAWPILOT_LOCAL_PUBLIC_URL="https://$DOMAIN" \
    CLAWPILOT_LOCAL_BIND_HOST="127.0.0.1" \
    "$REPO_ROOT/scripts/dev-start.sh"
  "$0" status
}

disable_domain() {
  echo "Removing only the local ClawPilot hostname and proxy..."
  sudo -v
  sudo launchctl bootout "system/$LABEL" >/dev/null 2>&1 || true
  if [[ -e "$SYSTEM_PLIST" ]]; then
    sudo rm "$SYSTEM_PLIST"
  fi
  rewrite_hosts disable
  echo "Local override disabled. Public DNS and Railway were not changed."
  echo "Any local app process is unchanged; use scripts/dev-stop.sh to stop it."
  echo "The shared mkcert CA remains trusted; removing it is a separate host-wide decision."
}

status_domain() {
  local failed=0
  if verify_hosts_block >/dev/null 2>&1 \
     && verify_effective_loopback_resolution >/dev/null 2>&1; then
    echo "hosts: enabled (exact managed block; effective resolution is loopback-only)"
  else
    echo "hosts: disabled, malformed, duplicated, or not loopback-only"
    failed=1
  fi
  if launchctl print "system/$LABEL" >/dev/null 2>&1; then
    echo "proxy: loaded"
  else
    echo "proxy: not loaded"
    failed=1
  fi
  if curl -fsS --noproxy '*' --max-time 5 \
      --resolve "$DOMAIN:443:127.0.0.1" \
      "https://$DOMAIN/api/health" \
      | grep -q '"status":"ok"'; then
    echo "https: healthy on local loopback (https://$DOMAIN)"
  else
    echo "https: unavailable on local loopback"
    failed=1
  fi
  return "$failed"
}

require_macos
case "${1:-}" in
  prepare)
    write_runtime_files
    echo "Prepared local development proxy files in: $STATE_ROOT"
    echo "No hostname, trust store, service, public DNS, or Railway change was made."
    ;;
  enable)
    enable_domain
    ;;
  disable)
    disable_domain
    ;;
  status)
    status_domain
    ;;
  *)
    usage
    exit 1
    ;;
esac
