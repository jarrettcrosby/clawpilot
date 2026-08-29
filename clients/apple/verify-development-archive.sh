#!/bin/bash

set -euo pipefail

# Do not allow a caller's shell tracing setting to disclose values read from the
# ignored credential overlay.
set +x

fail() {
  printf 'Apple archive verification failed: %s\n' "$1" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "${script_dir}" rev-parse --show-toplevel)"
if [[ "$#" -eq 1 ]]; then
  environment="development"
  archive_path="$1"
elif [[ "$#" -eq 2 ]]; then
  environment="$1"
  archive_path="$2"
else
  fail "provide one .xcarchive path, or an environment and one .xcarchive path"
fi
local_config_path="${script_dir}/Config/Local.xcconfig"
project_path="${script_dir}/project.yml"

[[ -n "${archive_path}" ]] || fail "provide the .xcarchive path"
[[ "${archive_path}" == /* ]] || fail "the archive path must be absolute"
[[ -d "${archive_path}" ]] || fail "archive does not exist"
[[ -f "${archive_path}/Info.plist" ]] || fail "archive metadata is missing"
[[ -f "${local_config_path}" ]] || fail "the ignored Local.xcconfig credential overlay is missing"
[[ -f "${project_path}" ]] || fail "the Apple project contract is missing"

if ! git -C "${repository_root}" diff --quiet --ignore-submodules -- \
  || ! git -C "${repository_root}" diff --cached --quiet --ignore-submodules -- \
  || [[ -n "$(git -C "${repository_root}" ls-files --others --exclude-standard)" ]]; then
  fail "the source checkout is not clean"
fi

source_commit="$(git -C "${repository_root}" rev-parse --verify HEAD)"
[[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] || fail "the source commit is not a full lowercase Git SHA"

case "${environment}" in
  development)
    environment_label="development"
    expected_display_name="ClawPilot Dev"
    expected_phone_bundle="com.eigenracing.ios.picking.dev"
    expected_watch_bundle="com.eigenracing.ios.picking.dev.watch"
    expected_origin="https://dev.aiapp.eigenracing.com"
    expected_archive_name="ClawPilotPickingPhoneDev"
    expected_meta_callback="clawpilot-meta-dev://"
    expected_meta_url_scheme="clawpilot-meta-dev"
    google_client_key="CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID"
    google_callback_key="CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID"
    meta_app_key="CLAWPILOT_META_DEV_APP_ID"
    meta_token_key="CLAWPILOT_META_DEV_CLIENT_TOKEN"
    ;;
  production)
    environment_label="production"
    expected_display_name="ClawPilot"
    expected_phone_bundle="com.eigenracing.ios.picking"
    expected_watch_bundle="com.eigenracing.ios.picking.watch"
    expected_origin="https://aiapp.eigenracing.com"
    expected_archive_name="ClawPilotPickingPhone"
    expected_meta_callback="clawpilot-meta://"
    expected_meta_url_scheme="clawpilot-meta"
    google_client_key="CLAWPILOT_GOOGLE_PRODUCTION_IOS_CLIENT_ID"
    google_callback_key="CLAWPILOT_GOOGLE_PRODUCTION_REVERSED_CLIENT_ID"
    meta_app_key="CLAWPILOT_META_PRODUCTION_APP_ID"
    meta_token_key="CLAWPILOT_META_PRODUCTION_CLIENT_TOKEN"
    ;;
  *) fail "environment must be development or production" ;;
esac

phone_app="${archive_path}/Products/Applications/ClawPilotPicking.app"
watch_app="${phone_app}/Watch/ClawPilotPickingWatch.app"
phone_plist="${phone_app}/Info.plist"
watch_plist="${watch_app}/Info.plist"
archive_plist="${archive_path}/Info.plist"

project_value() {
  local key="$1"
  /usr/bin/awk -v wanted="${key}" '
    $0 ~ "^[[:space:]]*" wanted ":[[:space:]]*" {
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "", value)
      print value
      exit
    }
  ' "${project_path}"
}

expected_build="$(project_value CURRENT_PROJECT_VERSION)"
expected_version="$(project_value MARKETING_VERSION)"
expected_team="$(project_value CLAWPILOT_APPLE_DEVELOPMENT_TEAM)"
[[ "${expected_build}" =~ ^[1-9][0-9]*$ ]] || fail "the expected project build number is invalid"
[[ -n "${expected_version}" ]] || fail "the expected marketing version is missing"
[[ "${expected_team}" =~ ^[A-Z0-9]{10}$ ]] || fail "the expected Apple team is invalid"

[[ -d "${phone_app}" && -f "${phone_plist}" ]] || fail "signed iPhone application is missing"
[[ -d "${watch_app}" && -f "${watch_plist}" ]] || fail "signed Watch application is missing"

config_value_from_file() {
  local key="$1"
  local config_path="$2"
  local depth="$3"
  local config_dir
  local line
  local include_optional
  local include_reference
  local include_path
  local include_value
  local assignment_value
  local resolved_value=""
  local found_value=false

  (( depth <= 16 )) || return 1
  [[ -f "${config_path}" ]] || return 1
  config_dir="$(cd "$(dirname "${config_path}")" && pwd)" || return 1

  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" =~ ^[[:space:]]*#include(\?)?[[:space:]]+\"([^\"]+)\" ]]; then
      include_optional="${BASH_REMATCH[1]}"
      include_reference="${BASH_REMATCH[2]}"
      if [[ "${include_reference}" == /* ]]; then
        include_path="${include_reference}"
      else
        include_path="${config_dir}/${include_reference}"
      fi

      if [[ -f "${include_path}" ]]; then
        if include_value="$(config_value_from_file "${key}" "${include_path}" "$((depth + 1))")"; then
          resolved_value="${include_value}"
          found_value=true
        fi
      elif [[ "${include_optional}" != "?" ]]; then
        return 1
      fi
      continue
    fi

    assignment_value="$(printf '%s\n' "${line}" | /usr/bin/awk -v wanted="${key}" '
      function trim(value) {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        return value
      }
      {
        separator = index($0, "=")
        if (separator == 0) exit 1
        name = trim(substr($0, 1, separator - 1))
        if (name != wanted) exit 1
        value = trim(substr($0, separator + 1))
        if (value == "") exit 1
        printf "%s", value
      }
    ')" || continue
    resolved_value="${assignment_value}"
    found_value=true
  done < "${config_path}"

  [[ "${found_value}" == true ]] || return 1
  printf '%s' "${resolved_value}"
}

config_value() {
  local key="$1"
  config_value_from_file "${key}" "${local_config_path}" 0
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

google_client_id="$(required_config_value "${google_client_key}" "the ${environment_label} Google iOS client ID")"
google_server_client_id="$(required_config_value CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED "the shared Google server client ID")"
google_callback="$(required_config_value "${google_callback_key}" "the ${environment_label} Google callback")"
meta_app_id="$(required_config_value "${meta_app_key}" "the ${environment_label} Meta app ID")"
meta_client_token="$(required_config_value "${meta_token_key}" "the ${environment_label} Meta client token")"

[[ "${google_client_id}" == *.apps.googleusercontent.com ]] || fail "the ${environment_label} Google iOS client ID has an invalid format"
[[ "${google_server_client_id}" == *.apps.googleusercontent.com ]] || fail "the shared Google server client ID has an invalid format"
[[ "${google_callback}" == com.googleusercontent.apps.* ]] || fail "the ${environment_label} Google callback has an invalid format"
[[ "${meta_app_id}" =~ ^[0-9]+$ && "${meta_app_id}" != "0" ]] || fail "the ${environment_label} Meta app ID has an invalid format"
[[ -n "${meta_client_token}" ]] || fail "the ${environment_label} Meta client token is empty"

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
  [[ "${actual}" == "${expected}" ]] || fail "${label} does not match the required ${environment_label} value"
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

plist_url_schemes() {
  local plist="$1"
  local type_index=0
  local scheme_index
  local scheme
  while /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:${type_index}" "${plist}" >/dev/null 2>&1; do
    scheme_index=0
    while scheme="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:${type_index}:CFBundleURLSchemes:${scheme_index}" "${plist}" 2>/dev/null)"; do
      printf '%s\n' "${scheme}"
      scheme_index=$((scheme_index + 1))
    done
    type_index=$((type_index + 1))
  done
}

require_url_schemes_exact() {
  local plist="$1"
  local expected_meta="$2"
  local expected_google="$3"
  local actual
  local expected
  actual="$(plist_url_schemes "${plist}" | LC_ALL=C sort)"
  expected="$(printf '%s\n' "${expected_meta}" "${expected_google}" | LC_ALL=C sort)"
  [[ "${actual}" == "${expected}" ]] \
    || fail "the signed URL schemes do not exactly match the required ${environment_label} values"
}

require_plist_equal "${phone_plist}" CFBundleDisplayName "${expected_display_name}" "the iPhone display name"
require_plist_equal "${phone_plist}" CFBundleIdentifier "${expected_phone_bundle}" "the iPhone bundle identifier"
require_plist_equal "${watch_plist}" CFBundleDisplayName "${expected_display_name}" "the Watch display name"
require_plist_equal "${watch_plist}" CFBundleIdentifier "${expected_watch_bundle}" "the Watch bundle identifier"
require_plist_equal "${watch_plist}" WKCompanionAppBundleIdentifier "${expected_phone_bundle}" "the Watch companion bundle identifier"
for plist in "${phone_plist}" "${watch_plist}"; do
  require_plist_equal "${plist}" ClawPilotEnvironment "${environment_label}" "the signed environment"
  require_plist_equal "${plist}" ClawPilotServerOrigin "${expected_origin}" "the signed server origin"
  require_plist_equal "${plist}" ClawPilotSourceCommit "${source_commit}" "the signed source commit"
done

require_plist_equal "${phone_plist}" GIDClientID "${google_client_id}" "the signed Google iOS client ID"
require_plist_equal "${phone_plist}" GIDServerClientID "${google_server_client_id}" "the signed Google server client ID"

require_plist_equal "${phone_plist}" MWDAT:MetaAppID "${meta_app_id}" "the signed Meta app ID"
require_plist_equal "${phone_plist}" MWDAT:ClientToken "${meta_client_token}" "the signed Meta client token"
require_plist_equal "${phone_plist}" MWDAT:AppLinkURLScheme "${expected_meta_callback}" "the signed Meta callback"
require_url_schemes_exact "${phone_plist}" "${expected_meta_url_scheme}" "${google_callback}"

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
require_equal "${phone_version}" "${expected_version}" "the current project marketing version"

require_plist_equal "${archive_plist}" ArchiveVersion "2" "the archive format version"
require_plist_equal "${archive_plist}" Name "${expected_archive_name}" "the archive name"
require_plist_equal "${archive_plist}" SchemeName "${expected_archive_name}" "the archive scheme"
require_plist_equal "${archive_plist}" ApplicationProperties:ApplicationPath "Applications/ClawPilotPicking.app" "the archive application path"
require_plist_equal "${archive_plist}" ApplicationProperties:CFBundleIdentifier "${expected_phone_bundle}" "the archive bundle identifier"

verify_signature() {
  local app_path="$1"
  local label="$2"
  local details
  local team
  local signer

  /usr/bin/codesign --verify --deep --strict "${app_path}" >/dev/null 2>&1 \
    || fail "the ${label} does not pass strict code-signature verification"
  details="$(/usr/bin/codesign -dv --verbose=4 "${app_path}" 2>&1)" \
    || fail "the ${label} signature metadata is unavailable"
  team="$(printf '%s\n' "${details}" | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  signer="$(printf '%s\n' "${details}" | /usr/bin/awk -F= '/^Authority=/{print $2; exit}')"
  [[ "${team}" == "${expected_team}" ]] || fail "the ${label} was not signed by the configured Apple team"
  case "${signer}" in
    'Apple Development: '*|'Apple Distribution: '*) ;;
    *) fail "the ${label} has an unsupported signing identity" ;;
  esac
  printf '%s' "${signer}"
}

phone_signer="$(verify_signature "${phone_app}" "iPhone application")"
watch_signer="$(verify_signature "${watch_app}" "Watch application")"
[[ "${phone_signer}" == "${watch_signer}" ]] \
  || fail "the iPhone and Watch applications use different signing identities"

printf 'Verified Apple %s archive build %s from source %s, signed by %s.\n' \
  "${environment_label}" "${phone_build}" "${source_commit}" "${phone_signer}"
printf 'Signature integrity and environment configuration passed; Distribution, App Store Connect, and TestFlight readiness were not verified.\n'
