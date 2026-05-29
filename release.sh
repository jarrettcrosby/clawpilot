#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
SHORT=$(git -C "$REPO" rev-parse --short HEAD)
TS=$(date +%Y%m%d-%H%M)
STASH_NAME="release-checkpoint-runtime-data"
TAG="local-stable-${TS}-${SHORT}"
ARCHIVE="$HOME/clawd-app-backups/clawd-app-${TS}-${SHORT}.tgz"
STASH_CREATED=0

restore_stash() {
  if [ "$STASH_CREATED" -eq 1 ]; then
    echo "Restoring stashed runtime changes..."
    git -C "$REPO" stash pop || true
  fi
}
trap restore_stash EXIT

echo "REPO=$REPO"
echo "TAG=$TAG"

mkdir -p "$HOME/clawd-app-backups"

if git -C "$REPO" stash push -u -m "$STASH_NAME" >/tmp/release_stash.out 2>&1; then
  cat /tmp/release_stash.out
  if grep -q "No local changes to save" /tmp/release_stash.out; then
    STASH_CREATED=0
  else
    STASH_CREATED=1
  fi
else
  cat /tmp/release_stash.out
  echo "stash command failed" >&2
  exit 1
fi

git -C "$REPO" tag -a "$TAG" -m "Stable checkpoint: restart reliability + soak PASS"

tar -czf "$ARCHIVE" -C "$(dirname "$REPO")" "$(basename "$REPO")"

FULL_HASH=$(git -C "$REPO" rev-parse HEAD)
SIZE=$(ls -lh "$ARCHIVE" | awk '{print $5}')

echo "TAG=$TAG"
echo "FULL_HASH=$FULL_HASH"
echo "ARCHIVE=$ARCHIVE"
echo "ARCHIVE_SIZE=$SIZE"
git -C "$REPO" status
