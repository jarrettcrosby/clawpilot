#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/var/lib/suitecrm/app
VERSION_MARKER="/var/lib/suitecrm/.installed-${SUITECRM_VERSION}"

# The image workdir lives on a persistent volume and may be replaced during the
# first install. Move out of it before bootstrapping so child processes inherit
# a valid working directory.
cd /

require_value() {
  local name="$1"
  local minimum="${2:-1}"
  local value="${!name:-}"
  if (( ${#value} < minimum )); then
    echo "[suitecrm] $name must contain at least $minimum characters" >&2
    exit 1
  fi
}

for name in SUITECRM_DB_HOST SUITECRM_DB_PORT SUITECRM_DB_NAME SUITECRM_DB_USER SUITECRM_DB_PASSWORD SUITECRM_PUBLIC_URL SUITECRM_ADMIN_USER; do
  require_value "$name"
done
require_value SUITECRM_ADMIN_PASSWORD 16
require_value SUITECRM_CLIENT_ID 36
require_value SUITECRM_CLIENT_SECRET 32

SUITECRM_PUBLIC_HOST="$(php <<'PHP'
<?php
$value = getenv('SUITECRM_PUBLIC_URL') ?: '';
$parts = parse_url($value);
$host = is_array($parts) ? ($parts['host'] ?? '') : '';
$port = is_array($parts) ? ($parts['port'] ?? null) : null;
$origin = 'https://' . $host . ($port !== null ? ':' . $port : '');
$valid = filter_var($value, FILTER_VALIDATE_URL) !== false
    && is_array($parts)
    && ($parts['scheme'] ?? '') === 'https'
    && $host !== ''
    && $host === strtolower($host)
    && !array_key_exists('user', $parts)
    && !array_key_exists('pass', $parts)
    && !array_key_exists('path', $parts)
    && !array_key_exists('query', $parts)
    && !array_key_exists('fragment', $parts)
    && $port !== 443
    && hash_equals($origin, $value);

if (!$valid) {
    fwrite(STDERR, "[suitecrm] SUITECRM_PUBLIC_URL must be an exact pathless HTTPS origin\n");
    exit(1);
}

fwrite(STDOUT, $host);
PHP
)"
export SUITECRM_PUBLIC_HOST

if [[ ! -f "$VERSION_MARKER" ]]; then
  if [[ -e "$APP_ROOT/public/legacy/config.php" ]]; then
    echo "[suitecrm] persisted application version does not match ${SUITECRM_VERSION}; explicit upgrade is required" >&2
    exit 1
  fi
  rm -rf "$APP_ROOT"
  mkdir -p "$APP_ROOT"
  cp -a /opt/suitecrm/. "$APP_ROOT/"
  chown -R www-data:www-data /var/lib/suitecrm
fi

for attempt in $(seq 1 120); do
  if php -r '
    try {
      new PDO(
        sprintf("mysql:host=%s;port=%s;dbname=%s", getenv("SUITECRM_DB_HOST"), getenv("SUITECRM_DB_PORT"), getenv("SUITECRM_DB_NAME")),
        getenv("SUITECRM_DB_USER"), getenv("SUITECRM_DB_PASSWORD")
      );
    } catch (Throwable $error) { exit(1); }
  '; then
    break
  fi
  [[ "$attempt" == "120" ]] && { echo "[suitecrm] database did not become reachable" >&2; exit 1; }
  sleep 2
done

if [[ ! -e "$APP_ROOT/public/legacy/config.php" ]]; then
  su -s /bin/bash www-data -c "cd '$APP_ROOT' && php bin/console suitecrm:app:install --no-interaction \
    -u \"$SUITECRM_ADMIN_USER\" -p \"$SUITECRM_ADMIN_PASSWORD\" \
    -U \"$SUITECRM_DB_USER\" -P \"$SUITECRM_DB_PASSWORD\" \
    -H \"$SUITECRM_DB_HOST\" -Z \"$SUITECRM_DB_PORT\" -N \"$SUITECRM_DB_NAME\" \
    -S \"$SUITECRM_PUBLIC_URL\" -d no -W true"
fi

SUITECRM_CONFIG_PATH="$APP_ROOT/public/legacy/config_override.php" php <<'PHP'
<?php
declare(strict_types=1);

function runtimeConfigFailure(string $message): never
{
    fwrite(STDERR, "[suitecrm] {$message}\n");
    exit(1);
}

$configPath = getenv('SUITECRM_CONFIG_PATH') ?: '';
$publicUrl = getenv('SUITECRM_PUBLIC_URL') ?: '';
$publicHost = getenv('SUITECRM_PUBLIC_HOST') ?: '';
if ($configPath === '' || $publicUrl === '' || $publicHost === '') {
    runtimeConfigFailure('runtime URL configuration is incomplete');
}

$existing = is_file($configPath) ? file_get_contents($configPath) : "<?php\n\n?>\n";
if ($existing === false || !preg_match('/^\s*<\?php\b/', $existing)) {
    runtimeConfigFailure('persisted config_override.php is not a readable PHP configuration file');
}

$startMarker = '/***CLAWPILOT_RUNTIME_BEGIN***/';
$endMarker = '/***CLAWPILOT_RUNTIME_END***/';
$managedBlockCount = substr_count($existing, $startMarker);
if ($managedBlockCount !== substr_count($existing, $endMarker)) {
    runtimeConfigFailure('persisted config_override.php contains an incomplete ClawPilot runtime block');
}

$pattern = '/\R?\/\*\*\*CLAWPILOT_RUNTIME_BEGIN\*\*\*\/.*?\/\*\*\*CLAWPILOT_RUNTIME_END\*\*\*\/\R?/s';
$base = preg_replace($pattern, "\n", $existing, -1, $removedBlockCount);
if ($base === null || $removedBlockCount !== $managedBlockCount) {
    runtimeConfigFailure('persisted config_override.php contains a malformed ClawPilot runtime block');
}

$closeTag = strrpos($base, '?>');
if ($closeTag === false) {
    $prefix = rtrim($base);
} else {
    if (trim(substr($base, $closeTag + 2)) !== '') {
        runtimeConfigFailure('persisted config_override.php has content after its closing PHP tag');
    }
    $prefix = rtrim(substr($base, 0, $closeTag));
}

$trustedHosts = [
    '^' . preg_quote($publicHost, '/') . '$',
    '^suitecrm\\.railway\\.internal$',
    '^healthcheck\\.railway\\.app$',
];
$managed = $startMarker . "\n"
    . '$sugar_config[\'site_url\'] = ' . var_export($publicUrl, true) . ";\n"
    . '$sugar_config[\'trusted_hosts\'] = ' . var_export($trustedHosts, true) . ";\n"
    . $endMarker;
$updated = $prefix . "\n\n" . $managed . "\n?>\n";

$directory = dirname($configPath);
$temporary = tempnam($directory, '.clawpilot-config-');
if ($temporary === false) runtimeConfigFailure('could not create a temporary SuiteCRM configuration file');

if (
    file_put_contents($temporary, $updated, LOCK_EX) === false
    || !chmod($temporary, 0640)
    || !chown($temporary, 'www-data')
    || !chgrp($temporary, 'www-data')
    || !rename($temporary, $configPath)
) {
    @unlink($temporary);
    runtimeConfigFailure('could not atomically replace SuiteCRM runtime configuration');
}
PHP

KEY_DIR="$APP_ROOT/public/legacy/Api/V8/OAuth2"
mkdir -p "$KEY_DIR"
if [[ ! -s "$KEY_DIR/private.key" || ! -s "$KEY_DIR/public.key" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_DIR/private.key"
  openssl pkey -in "$KEY_DIR/private.key" -pubout -out "$KEY_DIR/public.key"
fi
chown -R www-data:www-data "$KEY_DIR"
chmod 0600 "$KEY_DIR/private.key" "$KEY_DIR/public.key"

php /opt/clawpilot/bootstrap-client.php
su -s /bin/bash www-data -c "cd '$APP_ROOT' && php bin/console messenger:setup-transports --no-interaction" || true

touch "$VERSION_MARKER"
chown www-data:www-data "$VERSION_MARKER"

PORT="${PORT:-8080}"
sed -ri "s/^Listen .*/Listen ${PORT}/" /etc/apache2/ports.conf
sed -ri "s/<VirtualHost \*:[0-9]+>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

# Keep exactly one Apache MPM enabled. Some Debian dependency paths can leave
# mpm_event enabled alongside the prefork module required by mod_php.
a2dismod mpm_event mpm_worker >/dev/null 2>&1 || true
a2enmod mpm_prefork >/dev/null

cd "$APP_ROOT"

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
