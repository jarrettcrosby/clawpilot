#!/usr/bin/env bash
# Only for disposable CI databases. Refresh the digest pins after reviewing the
# complete catalog comparison; never substitute a mutable upstream image.
set -euo pipefail

if (( $# == 0 )); then
  echo 'At least one audited PostgreSQL fixture major is required' >&2
  exit 2
fi

for major in "$@"; do
  case "$major" in
    16) ;;
    18) ;;
    *) echo 'Only PostgreSQL 16 and 18 fixtures are audited' >&2; exit 2 ;;
  esac
done

for major in "$@"; do
  case "$major" in
    16) digest=sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f ;;
    18) digest=sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47 ;;
  esac
  pinned="pgvector/pgvector@$digest"
  fixture="pgvector/pgvector:pg$major"
  docker pull "$pinned"
  docker image inspect "$pinned" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -Fx "$pinned"
  # Existing tests select a major-bearing tag and consume the local image.
  docker tag "$pinned" "$fixture"
  test "$(docker image inspect "$pinned" --format '{{.Id}}')" = "$(docker image inspect "$fixture" --format '{{.Id}}')"
done
