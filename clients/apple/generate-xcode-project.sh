#!/bin/sh
set -eu

required_version="2.45.4"
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "XcodeGen ${required_version} is required." >&2
  exit 1
fi
installed_version="$(xcodegen --version | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+)$/\1/')"
if [ "${installed_version}" != "${required_version}" ]; then
  echo "Expected XcodeGen ${required_version}; found ${installed_version}." >&2
  exit 1
fi
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec xcodegen generate --spec "${script_directory}/project.yml" --project "${script_directory}"

