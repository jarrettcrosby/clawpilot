#!/bin/bash
set -euo pipefail

apple_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project="${apple_dir}/ClawPilotPicking.xcodeproj"
expected_meta_version="0.9.0"
expected_meta_revision="9b1b83d791dfebff7afd452e924a256819094b64"

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
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${build_root}/phone-dev" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

embedded_watch="${build_root}/phone-dev/Build/Products/Development-iphonesimulator/ClawPilotPicking.app/Watch/ClawPilotPickingWatch.app"
if [[ ! -d "${embedded_watch}" ]]; then
  echo "The development iPhone app did not embed its development Watch companion." >&2
  exit 1
fi

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingWatchDev \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "${build_root}/watch-dev" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingPhone \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "${build_root}/phone-production" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

embedded_watch="${build_root}/phone-production/Build/Products/Production-iphonesimulator/ClawPilotPicking.app/Watch/ClawPilotPickingWatch.app"
if [[ ! -d "${embedded_watch}" ]]; then
  echo "The production iPhone app did not embed its production Watch companion." >&2
  exit 1
fi

xcodebuild -quiet -project "${project}" -scheme ClawPilotPickingWatch \
  -destination 'generic/platform=watchOS Simulator' \
  -derivedDataPath "${build_root}/watch-production" \
  -packageAuthorizationProvider netrc \
  -clonedSourcePackagesDirPath "${packages}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build

echo "ClawPilot development and production iPhone/Watch simulator builds passed with Meta DAT ${version}."
