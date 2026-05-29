#!/usr/bin/env bash
set -euo pipefail

BACKUP_GLOB="$HOME/clawd-app-backups/clawd-app-?????????????-???????.tgz"
MIN_BYTES=52428800

choose_archive() {
  # If an archive path is passed, use it as-is
  if [ $# -ge 1 ] && [ -n "${1:-}" ]; then
    echo "$1"
    return
  fi

  # Otherwise choose newest backup >= MIN_BYTES
  local chosen=""
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    size=$(stat -f%z "$file" 2>/dev/null || echo 0)
    if [ "$size" -ge "$MIN_BYTES" ]; then
      chosen="$file"
      break
    fi
  done < <(ls -t $BACKUP_GLOB 2>/dev/null || true)

  if [ -n "$chosen" ]; then
    echo "$chosen"
    return
  fi

  echo "No valid backup archive >= 50MB found. Looked for: $BACKUP_GLOB" >&2
  return 1
}

ARCHIVE="$(choose_archive "$@")"
if [ -z "${ARCHIVE:-}" ] || [ ! -f "$ARCHIVE" ]; then
  echo "No valid backup archive found. Looked for: $BACKUP_GLOB" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
RESTORE_ROOT="$HOME/clawd-app-restores/$TS"
mkdir -p "$RESTORE_ROOT"

echo "ARCHIVE=$ARCHIVE"
echo "RESTORE_ROOT=$RESTORE_ROOT"

tar -xzf "$ARCHIVE" -C "$RESTORE_ROOT"
RESTORED="$RESTORE_ROOT/clawd-app"

if [ ! -d "$RESTORED/.git" ]; then
  echo "Restore did not produce expected repo at $RESTORED" >&2
  exit 1
fi

echo "$RESTORED" > /tmp/last_restore_path

HEAD_FULL="$(git -C "$RESTORED" rev-parse HEAD)"
HEAD_SHORT="$(git -C "$RESTORED" rev-parse --short HEAD)"

echo "RESTORED=$RESTORED"
echo "RESTORED_HEAD_SHORT=$HEAD_SHORT"
echo "RESTORED_HEAD_FULL=$HEAD_FULL"
echo "GIT_STATUS:"
git -C "$RESTORED" status
