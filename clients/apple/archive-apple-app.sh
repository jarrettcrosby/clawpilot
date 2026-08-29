#!/bin/bash

set -euo pipefail
set +x

fail() {
  printf 'Apple archive creation failed: %s\n' "$1" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(git -C "${script_dir}" rev-parse --show-toplevel)"
environment="${1:-}"
archive_path="${2:-}"

[[ "$#" -eq 2 ]] || fail "provide an environment and one absolute .xcarchive path"
[[ "${archive_path}" == /* && "${archive_path}" == *.xcarchive ]] \
  || fail "the archive path must be absolute and end in .xcarchive"
[[ ! -e "${archive_path}" ]] || fail "the archive path already exists"

if ! git -C "${repository_root}" diff --quiet --ignore-submodules -- \
  || ! git -C "${repository_root}" diff --cached --quiet --ignore-submodules -- \
  || [[ -n "$(git -C "${repository_root}" ls-files --others --exclude-standard)" ]]; then
  fail "the source checkout must be clean before creating an archive"
fi

source_commit="$(git -C "${repository_root}" rev-parse --verify HEAD)"
[[ "${source_commit}" =~ ^[0-9a-f]{40}$ ]] || fail "the source commit is not a full lowercase Git SHA"

case "${environment}" in
  development)
    scheme="ClawPilotPickingPhoneDev"
    configuration="DevelopmentRelease"
    ;;
  production)
    scheme="ClawPilotPickingPhone"
    configuration="Production"
    ;;
  *) fail "environment must be development or production" ;;
esac

"${script_dir}/generate-xcode-project.sh"
xcodebuild \
  -project "${script_dir}/ClawPilotPicking.xcodeproj" \
  -scheme "${scheme}" \
  -configuration "${configuration}" \
  -destination 'generic/platform=iOS' \
  -archivePath "${archive_path}" \
  "CLAWPILOT_SOURCE_COMMIT=${source_commit}" \
  archive

exec "${script_dir}/verify-development-archive.sh" "${environment}" "${archive_path}"
