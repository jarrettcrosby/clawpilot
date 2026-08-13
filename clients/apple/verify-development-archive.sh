#!/bin/bash

set -euo pipefail

# Do not allow a caller's shell tracing setting to disclose values read from the
# ignored credential overlay.
set +x

fail() {
  printf 'Development archive verification failed: %s\n' "$1" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
archive_path="${1:-}"
local_config_path="${script_dir}/Config/Local.xcconfig"
project_path="${script_dir}/project.yml"

[[ "$#" -eq 1 ]] || fail "provide exactly one .xcarchive path"
[[ -n "${archive_path}" ]] || fail "provide the .xcarchive path"
[[ -d "${archive_path}" ]] || fail "archive does not exist"
[[ -f "${archive_path}/Info.plist" ]] || fail "archive metadata is missing"
[[ -f "${local_config_path}" ]] || fail "the ignored Local.xcconfig credential overlay is missing"
[[ -f "${project_path}" ]] || fail "the Apple project contract is missing"

phone_app="${archive_path}/Products/Applications/ClawPilotPicking.app"
watch_app="${phone_app}/Watch/ClawPilotPickingWatch.app"
phone_plist="${phone_app}/Info.plist"
watch_plist="${watch_app}/Info.plist"
archive_plist="${archive_path}/Info.plist"

expected_build="$(/usr/bin/awk '
  /^[[:space:]]*CURRENT_PROJECT_VERSION:[[:space:]]*/ {
    value = $0
    sub(/^[^:]*:[[:space:]]*/, "", value)
    gsub(/[[:space:]\"]/, "", value)
    print value
    exit
  }
' "${project_path}")"
[[ "${expected_build}" =~ ^[1-9][0-9]*$ ]] || fail "the expected project build number is invalid"

[[ -d "${phone_app}" && -f "${phone_plist}" ]] || fail "signed iPhone application is missing"
[[ -d "${watch_app}" && -f "${watch_plist}" ]] || fail "signed Watch application is missing"

config_value() {
  local key="$1"
  /usr/bin/awk -v wanted="${key}" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    {
      separator = index($0, "=")
      if (separator == 0) next
      name = trim(substr($0, 1, separator - 1))
      if (name == wanted) result = trim(substr($0, separator + 1))
    }
    END {
      if (result == "") exit 1
      printf "%s", result
    }
  ' "${local_config_path}"
}

required_config_value() {
  local key="$1"
  local label="$2"
  local value
  value="$(config_value "${key}")" || fail "Local.xcconfig is missing ${label}"

  case "${value}" in
    *'$('*) fail "${label} is unresolved" ;;
    *not-configured*|*NOT_CONFIGURED*|*placeholder*|*PLACEHOLDER*)
      fail "${label} is still a placeholder"
      ;;
  esac

  printf '%s' "${value}"
}

google_client_id="$(required_config_value CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID "the development Google iOS client ID")"
google_server_client_id="$(required_config_value CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED "the shared Google server client ID")"
google_callback="$(required_config_value CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID "the development Google callback")"
meta_app_id="$(required_config_value CLAWPILOT_META_DEV_APP_ID "the development Meta app ID")"
meta_client_token="$(required_config_value CLAWPILOT_META_DEV_CLIENT_TOKEN "the development Meta client token")"

[[ "${google_client_id}" == *.apps.googleusercontent.com ]] || fail "the development Google iOS client ID has an invalid format"
[[ "${google_server_client_id}" == *.apps.googleusercontent.com ]] || fail "the shared Google server client ID has an invalid format"
[[ "${google_callback}" == com.googleusercontent.apps.* ]] || fail "the development Google callback has an invalid format"
[[ "${meta_app_id}" =~ ^[0-9]+$ && "${meta_app_id}" != "0" ]] || fail "the development Meta app ID has an invalid format"
[[ -n "${meta_client_token}" ]] || fail "the development Meta client token is empty"

plist_value() {
  local plist="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :${key}" "${plist}" 2>/dev/null
}

required_plist_value() {
  local plist="$1"
  local key="$2"
  local label="$3"
  local value
  value="$(plist_value "${plist}" "${key}")" || fail "${label} is missing"
  [[ -n "${value}" ]] || fail "${label} is empty"
  printf '%s' "${value}"
}

require_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "${actual}" == "${expected}" ]] || fail "${label} does not match the required development value"
}

require_plist_equal() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(required_plist_value "${plist}" "${key}" "${label}")"
  require_equal "${actual}" "${expected}" "${label}"
}

plist_has_url_scheme() {
  local plist="$1"
  local expected_scheme="$2"
  local type_index=0
  local scheme_index
  local scheme

  while /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:${type_index}" "${plist}" >/dev/null 2>&1; do
    scheme_index=0
    while scheme="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:${type_index}:CFBundleURLSchemes:${scheme_index}" "${plist}" 2>/dev/null)"; do
      if [[ "${scheme}" == "${expected_scheme}" ]]; then
        return 0
      fi
      scheme_index=$((scheme_index + 1))
    done
    type_index=$((type_index + 1))
  done

  return 1
}

require_plist_equal "${phone_plist}" CFBundleIdentifier "com.eigenracing.ios.picking.dev" "the iPhone bundle identifier"
require_plist_equal "${watch_plist}" CFBundleIdentifier "com.eigenracing.ios.picking.dev.watch" "the Watch bundle identifier"
require_plist_equal "${watch_plist}" WKCompanionAppBundleIdentifier "com.eigenracing.ios.picking.dev" "the Watch companion bundle identifier"
require_plist_equal "${phone_plist}" ClawPilotEnvironment "development" "the signed environment"
require_plist_equal "${phone_plist}" ClawPilotServerOrigin "https://dev.aiapp.eigenracing.com" "the signed server origin"

require_plist_equal "${phone_plist}" GIDClientID "${google_client_id}" "the signed Google iOS client ID"
require_plist_equal "${phone_plist}" GIDServerClientID "${google_server_client_id}" "the signed Google server client ID"
plist_has_url_scheme "${phone_plist}" "${google_callback}" || fail "the signed Google callback is missing"

require_plist_equal "${phone_plist}" MWDAT:MetaAppID "${meta_app_id}" "the signed Meta app ID"
require_plist_equal "${phone_plist}" MWDAT:ClientToken "${meta_client_token}" "the signed Meta client token"
require_plist_equal "${phone_plist}" MWDAT:AppLinkURLScheme "clawpilot-meta-dev://" "the signed Meta callback"
plist_has_url_scheme "${phone_plist}" "clawpilot-meta-dev" || fail "the signed Meta callback URL type is missing"

phone_build="$(required_plist_value "${phone_plist}" CFBundleVersion "the iPhone build number")"
watch_build="$(required_plist_value "${watch_plist}" CFBundleVersion "the Watch build number")"
archive_build="$(required_plist_value "${archive_plist}" ApplicationProperties:CFBundleVersion "the archive build number")"
[[ "${phone_build}" =~ ^[1-9][0-9]*$ ]] || fail "the iPhone build number is invalid"
require_equal "${phone_build}" "${expected_build}" "the current project build number"
require_equal "${watch_build}" "${phone_build}" "the Watch build number"
require_equal "${archive_build}" "${phone_build}" "the archive build number"

phone_version="$(required_plist_value "${phone_plist}" CFBundleShortVersionString "the iPhone marketing version")"
watch_version="$(required_plist_value "${watch_plist}" CFBundleShortVersionString "the Watch marketing version")"
archive_version="$(required_plist_value "${archive_plist}" ApplicationProperties:CFBundleShortVersionString "the archive marketing version")"
require_equal "${watch_version}" "${phone_version}" "the Watch marketing version"
require_equal "${archive_version}" "${phone_version}" "the archive marketing version"

require_plist_equal "${archive_plist}" ArchiveVersion "2" "the archive format version"
require_plist_equal "${archive_plist}" Name "ClawPilotPickingPhoneDev" "the archive name"
require_plist_equal "${archive_plist}" SchemeName "ClawPilotPickingPhoneDev" "the archive scheme"
require_plist_equal "${archive_plist}" ApplicationProperties:ApplicationPath "Applications/ClawPilotPicking.app" "the archive application path"
require_plist_equal "${archive_plist}" ApplicationProperties:CFBundleIdentifier "com.eigenracing.ios.picking.dev" "the archive bundle identifier"

/usr/bin/codesign --verify --deep --strict "${phone_app}" >/dev/null 2>&1 || fail "the signed applications do not pass strict code-signature verification"

printf 'Verified Apple development archive build %s.\n' "${phone_build}"
