#!/usr/bin/env bash
set -euo pipefail

BACKUP_GLOB="$HOME/clawd-app-backups/clawd-app-?????????????-???????.tgz"
MIN_BYTES=52428800
PROD_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
RECOVERY_ROOT_BASE="$HOME/clawd-app-recovery"

ARCHIVE_ARG=""
PROMOTE=0
RUN_PORT=""
CONFIRM_4001=""

while [ $# -gt 0 ]; do
  case "$1" in
    --promote)
      PROMOTE=1
      shift
      ;;
    --run)
      RUN_PORT="${2:-}"
      shift 2
      ;;
    --confirm-4001)
      CONFIRM_4001="${2:-}"
      shift 2
      ;;
    *)
      if [ -z "$ARCHIVE_ARG" ]; then
        ARCHIVE_ARG="$1"
        shift
      else
        echo "Unknown extra argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

choose_archive() {
  if [ -n "$ARCHIVE_ARG" ]; then
    echo "$ARCHIVE_ARG"
    return
  fi

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

  echo "No valid archive >= 50MB found. Looked for: $BACKUP_GLOB" >&2
  return 1
}

ARCHIVE="$(choose_archive)"
if [ -z "${ARCHIVE:-}" ] || [ ! -f "$ARCHIVE" ]; then
  echo "No valid archive found. Looked for: $BACKUP_GLOB" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
RECOVERY_ROOT="$RECOVERY_ROOT_BASE/$TS"
mkdir -p "$RECOVERY_ROOT"

echo "ARCHIVE=$ARCHIVE"
echo "RECOVERY_ROOT=$RECOVERY_ROOT"

tar -xzf "$ARCHIVE" -C "$RECOVERY_ROOT"
RECOVERED="$RECOVERY_ROOT/clawd-app"
if [ ! -d "$RECOVERED" ]; then
  echo "Recovered repo missing: $RECOVERED" >&2
  exit 1
fi

echo "$RECOVERED" > /tmp/last_recovery_path

echo "RECOVERED=$RECOVERED"
if [ -d "$RECOVERED/.git" ]; then
  HEAD_SHORT="$(git -C "$RECOVERED" rev-parse --short HEAD || true)"
  HEAD_FULL="$(git -C "$RECOVERED" rev-parse HEAD || true)"
  echo "RESTORED_HEAD_SHORT=$HEAD_SHORT"
  echo "RESTORED_HEAD_FULL=$HEAD_FULL"
fi

echo "KEY_DIRS:"
ls -la "$RECOVERED" | sed -n '1,80p'

if [ "$PROMOTE" -eq 1 ]; then
  BACKUP_PROD="/Users/agentsuburbiasandwich/Desktop/clawd-app-corrupt-$TS"
  if [ -e "$PROD_REPO" ]; then
    echo "SAFETY_MOVE=$PROD_REPO -> $BACKUP_PROD"
    mv "$PROD_REPO" "$BACKUP_PROD"
  fi
  echo "PROMOTE_COPY=$RECOVERED -> $PROD_REPO"
  cp -a "$RECOVERED" "$PROD_REPO"
fi

if [ -n "$RUN_PORT" ]; then
  if [ "$RUN_PORT" = "4001" ] && [ "$CONFIRM_4001" != "YES_REPLACE_4001" ]; then
    echo "Refusing to run on 4001 without explicit --confirm-4001 YES_REPLACE_4001" >&2
    exit 1
  fi

  if [ "$RUN_PORT" = "4001" ]; then
    echo "RUN_MODE=4001 (explicitly approved)"
  else
    echo "RUN_MODE=$RUN_PORT (side-by-side)"
  fi

  cd "$RECOVERED/app_src"
  nohup npm start -- --port "$RUN_PORT" --hostname 0.0.0.0 > /tmp/clawd-app-recovery.log 2>&1 &
  echo "RUN_PID=$!"
  echo "RUN_LOG=/tmp/clawd-app-recovery.log"
fi
