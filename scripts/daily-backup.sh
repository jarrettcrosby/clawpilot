#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +"%Y-%m-%d_%H-%M-%S")"
OUT_DIR="$ROOT_DIR/data/backups/daily"
LOG_DIR="$ROOT_DIR/data/logs/backups"
mkdir -p "$OUT_DIR" "$LOG_DIR"

DATA_ARCHIVE="$OUT_DIR/data_${TS}.tar.gz"
DOCS_ARCHIVE="$OUT_DIR/docs_${TS}.tar.gz"
LOG_FILE="$LOG_DIR/backup_${TS}.log"

archive_dir() {
  local src_dir="$1"
  local archive_path="$2"
  local name
  name="$(basename "$src_dir")"

  if [[ ! -d "$src_dir" ]]; then
    echo "[backup][WARN] missing directory: $src_dir" | tee -a "$LOG_FILE"
    return 0
  fi

  if [[ "$name" == "data" ]]; then
    tar -czf "$archive_path" \
      --exclude='data/backups/daily' \
      --exclude='data/logs/backups' \
      -C "$ROOT_DIR" "$name"
  else
    tar -czf "$archive_path" -C "$ROOT_DIR" "$name"
  fi
  local bytes
  bytes=$(wc -c < "$archive_path" | tr -d ' ')
  echo "[backup][OK] ${name} -> ${archive_path} (${bytes} bytes)" | tee -a "$LOG_FILE"
}

echo "[backup] start ts=${TS}" | tee "$LOG_FILE"
archive_dir "$ROOT_DIR/data" "$DATA_ARCHIVE"
archive_dir "$ROOT_DIR/docs" "$DOCS_ARCHIVE"
echo "[backup] done" | tee -a "$LOG_FILE"

echo "DATA_ARCHIVE=$DATA_ARCHIVE"
echo "DOCS_ARCHIVE=$DOCS_ARCHIVE"
echo "LOG_FILE=$LOG_FILE"
