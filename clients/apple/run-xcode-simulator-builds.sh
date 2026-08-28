#!/bin/bash
set -euo pipefail

apple_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "${apple_dir}" rev-parse --show-toplevel)"
project="${apple_dir}/ClawPilotPicking.xcodeproj"
expected_meta_version="0.9.0"
expected_meta_revision="9b1b83d791dfebff7afd452e924a256819094b64"
expected_build="16"
source_commit="$(git -C "${repository_root}" rev-parse --verify HEAD)"

if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A full lowercase source commit could not be resolved." >&2
  exit 1
fi
if ! git -C "${repository_root}" diff --quiet --ignore-submodules -- \
  || ! git -C "${repository_root}" diff --cached --quiet --ignore-submodules -- \
  || [[ -n "$(git -C "${repository_root}" ls-files --others --exclude-standard)" ]]; then
  echo "The source checkout must be clean before source-bound simulator builds." >&2
  exit 1
fi

xcode_version="$(xcodebuild -version | sed -n '1p')"
if [[ ! "${xcode_version}" =~ ^Xcode\ 26\.6([.]|$) ]]; then
  echo "Xcode 26.6.x is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

"${apple_dir}/generate-xcode-project.sh"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/clawpilot-apple-phase1.XXXXXX")"
trap 'rm -rf -- "${build_root}"' EXIT
packages="${build_root}/packages"

# Deliberately non-production fixture values prove that every built target selects
# the intended environment without reading or printing ignored local credentials.
dev_google_client="000000000001-dev-build-contract.apps.googleusercontent.com"
dev_google_callback="com.googleusercontent.apps.000000000001-dev-build-contract"
production_google_client="000000000002-production-build-contract.apps.googleusercontent.com"
production_google_callback="com.googleusercontent.apps.000000000002-production-build-contract"
shared_google_server="000000000003-server-build-contract.apps.googleusercontent.com"
dev_meta_app_id="100000000000001"
production_meta_app_id="100000000000002"
dev_meta_token="dev-build-contract-token"
production_meta_token="production-build-contract-token"
build_contract_settings=(
  "CLAWPILOT_SOURCE_COMMIT=${source_commit}"
  "CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID=${dev_google_client}"
  "CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID=${dev_google_callback}"
  "CLAWPILOT_GOOGLE_PRODUCTION_IOS_CLIENT_ID=${production_google_client}"
  "CLAWPILOT_GOOGLE_PRODUCTION_REVERSED_CLIENT_ID=${production_google_callback}"
  "CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED=${shared_google_server}"
  "CLAWPILOT_META_DEV_APP_ID=${dev_meta_app_id}"
  "CLAWPILOT_META_DEV_CLIENT_TOKEN=${dev_meta_token}"
  "CLAWPILOT_META_PRODUCTION_APP_ID=${production_meta_app_id}"
  "CLAWPILOT_META_PRODUCTION_CLIENT_TOKEN=${production_meta_token}"
)

fail() {
  echo "Apple simulator build verification failed: $1" >&2
  exit 1
}

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

require_plist_equal() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(plist_value "${plist}" "${key}")" || fail "${label} is missing"
  [[ "${actual}" == "${expected}" ]] || fail "${label} does not match its build contract"
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
  [[ "${actual}" == "${expected}" ]] || fail "the signed URL schemes do not match the selected environment"
}

verify_app_contract() {
  local phone_app="$1"
  local standalone_watch="$2"
  local display_name="$3"
  local environment="$4"
  local origin="$5"
  local phone_bundle="$6"
  local watch_bundle="$7"
  local google_client="$8"
  local google_callback="$9"
  local meta_app_id="${10}"
  local meta_token="${11}"
  local meta_scheme="${12}"
  local embedded_watch="${phone_app}/Watch/ClawPilotPickingWatch.app"
  local phone_plist="${phone_app}/Info.plist"
  local embedded_watch_plist="${embedded_watch}/Info.plist"
  local standalone_watch_plist="${standalone_watch}/Info.plist"

  [[ -d "${embedded_watch}" ]] || fail "the ${environment} phone app did not embed its Watch companion"
  [[ -f "${standalone_watch_plist}" ]] || fail "the ${environment} standalone Watch app is missing"

  require_plist_equal "${phone_plist}" CFBundleDisplayName "${display_name}" "the ${environment} iPhone display name"
  require_plist_equal "${phone_plist}" CFBundleIdentifier "${phone_bundle}" "the ${environment} iPhone bundle identifier"
  require_plist_equal "${phone_plist}" CFBundleVersion "${expected_build}" "the ${environment} iPhone build number"
  require_plist_equal "${phone_plist}" ClawPilotEnvironment "${environment}" "the ${environment} iPhone environment"
  require_plist_equal "${phone_plist}" ClawPilotServerOrigin "${origin}" "the ${environment} iPhone origin"
  require_plist_equal "${phone_plist}" ClawPilotSourceCommit "${source_commit}" "the ${environment} iPhone source commit"
  require_plist_equal "${phone_plist}" GIDClientID "${google_client}" "the ${environment} Google client ID"
  require_plist_equal "${phone_plist}" GIDServerClientID "${shared_google_server}" "the ${environment} Google server audience"
  require_plist_equal "${phone_plist}" MWDAT:MetaAppID "${meta_app_id}" "the ${environment} Meta app ID"
  require_plist_equal "${phone_plist}" MWDAT:ClientToken "${meta_token}" "the ${environment} Meta token"
  require_plist_equal "${phone_plist}" MWDAT:AppLinkURLScheme "${meta_scheme}://" "the ${environment} Meta callback"
  require_url_schemes_exact "${phone_plist}" "${meta_scheme}" "${google_callback}"

  for watch_plist in "${embedded_watch_plist}" "${standalone_watch_plist}"; do
    require_plist_equal "${watch_plist}" CFBundleDisplayName "${display_name}" "the ${environment} Watch display name"
    require_plist_equal "${watch_plist}" CFBundleIdentifier "${watch_bundle}" "the ${environment} Watch bundle identifier"
    require_plist_equal "${watch_plist}" WKCompanionAppBundleIdentifier "${phone_bundle}" "the ${environment} Watch companion identifier"
    require_plist_equal "${watch_plist}" CFBundleVersion "${expected_build}" "the ${environment} Watch build number"
    require_plist_equal "${watch_plist}" ClawPilotEnvironment "${environment}" "the ${environment} Watch environment"
    require_plist_equal "${watch_plist}" ClawPilotServerOrigin "${origin}" "the ${environment} Watch origin"
    require_plist_equal "${watch_plist}" ClawPilotSourceCommit "${source_commit}" "the ${environment} Watch source commit"
  done
}

verify_privacy_manifests() {
  local phone_app="$1"
  local watch_app="${phone_app}/Watch/ClawPilotPickingWatch.app"
  for manifest in \
    "${phone_app}/PrivacyInfo.xcprivacy" \
    "${watch_app}/PrivacyInfo.xcprivacy"
  do
    if [[ ! -f "${manifest}" ]]; then
      echo "Expected app-owned privacy manifest at ${manifest}." >&2
      exit 1
    fi
    plutil -lint "${manifest}" >/dev/null
  done
}

xcodebuild -quiet -resolvePackageDependencies \
  -project "${project}" -scheme ClawPilotPickingPhoneDev \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}"

resolved="${project}/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
version="$(jq -r '.pins[] | select(.identity == "meta-wearables-dat-ios") | .state.version' "${resolved}")"
revision="$(jq -r '.pins[] | select(.identity == "meta-wearables-dat-ios") | .state.revision' "${resolved}")"
if [[ "${version}" != "${expected_meta_version}" || "${revision}" != "${expected_meta_revision}" ]]; then
  echo "Meta Wearables DAT package pin drifted." >&2
  exit 1
fi

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingPhoneDev \
  -configuration DevelopmentRelease \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${build_root}/phone-dev" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  "${build_contract_settings[@]}" build

phone_app="${build_root}/phone-dev/Build/Products/DevelopmentRelease-iphonesimulator/ClawPilotPicking.app"
embedded_watch="${phone_app}/Watch/ClawPilotPickingWatch.app"
if [[ ! -d "${embedded_watch}" ]]; then
  echo "The development iPhone app did not embed its development Watch companion." >&2
  exit 1
fi
verify_privacy_manifests "${phone_app}"

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingWatchDev \
  -configuration DevelopmentRelease \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "${build_root}/watch-dev" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  "${build_contract_settings[@]}" build

standalone_watch="${build_root}/watch-dev/Build/Products/DevelopmentRelease-watchsimulator/ClawPilotPickingWatch.app"
verify_app_contract \
  "${phone_app}" "${standalone_watch}" "ClawPilot Dev" "development" \
  "https://dev.aiapp.eigenracing.com" \
  "com.eigenracing.ios.picking.dev" "com.eigenracing.ios.picking.dev.watch" \
  "${dev_google_client}" "${dev_google_callback}" \
  "${dev_meta_app_id}" "${dev_meta_token}" "clawpilot-meta-dev"

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingPhone \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${build_root}/phone-production" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  "${build_contract_settings[@]}" build

phone_app="${build_root}/phone-production/Build/Products/Production-iphonesimulator/ClawPilotPicking.app"
embedded_watch="${phone_app}/Watch/ClawPilotPickingWatch.app"
if [[ ! -d "${embedded_watch}" ]]; then
  echo "The production iPhone app did not embed its production Watch companion." >&2
  exit 1
fi
verify_privacy_manifests "${phone_app}"

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingWatch \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "${build_root}/watch-production" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  "${build_contract_settings[@]}" build

standalone_watch="${build_root}/watch-production/Build/Products/Production-watchsimulator/ClawPilotPickingWatch.app"
verify_app_contract \
  "${phone_app}" "${standalone_watch}" "ClawPilot" "production" \
  "https://aiapp.eigenracing.com" \
  "com.eigenracing.ios.picking" "com.eigenracing.ios.picking.watch" \
  "${production_google_client}" "${production_google_callback}" \
  "${production_meta_app_id}" "${production_meta_token}" "clawpilot-meta"

echo "ClawPilot development and production iPhone/Watch simulator contracts passed at clean source ${source_commit} with Meta DAT ${version}."
