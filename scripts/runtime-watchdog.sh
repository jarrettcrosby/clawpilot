#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

DEV_VERIFY="$DEV_REPO/scripts/dev-verify.sh"
STABLE_VERIFY="$CONTROL_REPO/scripts/stable-verify.sh"
DEV_START="$CONTROL_REPO/scripts/dev-start.sh"
STABLE_START="$CONTROL_REPO/scripts/stable-start.sh"

ROUTE_CHECKS_DEV="${ROUTE_CHECKS_DEV:-/api/health /api/runtime /}"
ROUTE_CHECKS_STABLE="${ROUTE_CHECKS_STABLE:-/api/health /api/runtime /}"

DRY_RUN=0
REPORT_PATH=""
REPORT_TMP=""

banner() { echo "====================================="; echo "$*"; echo "====================================="; }
ok() { echo "OK: $*"; }
warn() { echo "WARN: $*"; }
fail() { echo "ERROR: $*"; }

verify_lane() {
  local lane="$1"
  local verify="$2"
  local route_checks="$3"
  local out
  set +e
  out=$(ROUTE_CHECKS="$route_checks" "$verify" 2>&1)
  local code=$?
  set -e
  echo "$out"
  return $code
}

recover_lane() {
  local lane="$1"
  local start_script="$2"
  local verify_script="$3"
  local route_checks="$4"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  banner "$lane lane: verification"
  if verify_lane "$lane" "$verify_script" "$route_checks"; then
    ok "$lane lane healthy"
    if [[ -n "$REPORT_TMP" ]]; then
      python3 - <<'PY' "$REPORT_TMP" "$lane" "$ts" "ok" "skipped" "skipped" "healthy"
import json, sys
path, lane, ts, verify, restart, reverify, status = sys.argv[1:]
with open(path, 'a') as f:
  f.write(json.dumps({
    "lane": lane,
    "timestamp": ts,
    "verification": verify,
    "restart": restart,
    "reverification": reverify,
    "final_status": status,
  }) + "\n")
PY
    fi
    return 0
  fi

  warn "$lane lane unhealthy — ${DRY_RUN:+dry-run }restart${DRY_RUN:+ skipped}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    warn "$lane lane restart skipped (dry-run)"
    if [[ -n "$REPORT_TMP" ]]; then
      python3 - <<'PY' "$REPORT_TMP" "$lane" "$ts" "fail" "skipped" "skipped" "dry-run"
import json, sys
path, lane, ts, verify, restart, reverify, status = sys.argv[1:]
with open(path, 'a') as f:
  f.write(json.dumps({
    "lane": lane,
    "timestamp": ts,
    "verification": verify,
    "restart": restart,
    "reverification": reverify,
    "final_status": status,
  }) + "\n")
PY
    fi
    return 1
  fi

  banner "$lane lane: restart"
  ROUTE_CHECKS="$route_checks" "$start_script"

  banner "$lane lane: re-verify"
  if verify_lane "$lane" "$verify_script" "$route_checks"; then
    ok "$lane lane recovered"
    if [[ -n "$REPORT_TMP" ]]; then
      python3 - <<'PY' "$REPORT_TMP" "$lane" "$ts" "fail" "attempted" "ok" "recovered"
import json, sys
path, lane, ts, verify, restart, reverify, status = sys.argv[1:]
with open(path, 'a') as f:
  f.write(json.dumps({
    "lane": lane,
    "timestamp": ts,
    "verification": verify,
    "restart": restart,
    "reverification": reverify,
    "final_status": status,
  }) + "\n")
PY
    fi
    return 0
  fi

  fail "$lane lane failed recovery"
  if [[ -n "$REPORT_TMP" ]]; then
    python3 - <<'PY' "$REPORT_TMP" "$lane" "$ts" "fail" "attempted" "fail" "failed"
import json, sys
path, lane, ts, verify, restart, reverify, status = sys.argv[1:]
with open(path, 'a') as f:
  f.write(json.dumps({
    "lane": lane,
    "timestamp": ts,
    "verification": verify,
    "restart": restart,
    "reverification": reverify,
    "final_status": status,
  }) + "\n")
PY
  fi
  return 1
}

usage() {
  cat <<'USAGE'
Usage: runtime-watchdog.sh [dev|stable|both] [--dry-run] [--report <path>]

Checks lane health, restarts unhealthy lane, then re-verifies.
Defaults: dev

Flags:
  --dry-run       Do not restart lanes; report what would happen
  --report PATH   Write JSON report to PATH
USAGE
}

lane="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    dev|stable|both)
      lane="$1"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --report)
      REPORT_PATH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
  done

if [[ -n "$REPORT_PATH" ]]; then
  REPORT_TMP="$(mktemp -t watchdog-report.XXXXXX)"
  : > "$REPORT_TMP"
fi

case "$lane" in
  dev)
    recover_lane "DEV" "$DEV_START" "$DEV_VERIFY" "$ROUTE_CHECKS_DEV"
    ;;
  stable)
    "$DEV_REPO/scripts/stable-runtime-watchdog.sh"
    ;;
  both)
    "$DEV_REPO/scripts/stable-runtime-watchdog.sh"
    recover_lane "DEV" "$DEV_START" "$DEV_VERIFY" "$ROUTE_CHECKS_DEV"
    ;;
  *)
    usage
    exit 1
    ;;
esac

if [[ -n "$REPORT_PATH" ]]; then
  python3 - <<'PY' "$REPORT_TMP" "$REPORT_PATH"
import json, sys
entries_path, out_path = sys.argv[1], sys.argv[2]
entries = []
with open(entries_path, 'r') as f:
  for line in f:
    line = line.strip()
    if not line:
      continue
    try:
      entries.append(json.loads(line))
    except Exception:
      entries.append({"parse_error": line})
with open(out_path, 'w') as f:
  json.dump(entries, f, indent=2)
print(f"REPORT: {out_path}")
PY
fi
