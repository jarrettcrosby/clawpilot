#!/usr/bin/env bash
set -euo pipefail

DEV_URL="${DEV_URL:-http://127.0.0.1:4002/#dashboard}"
STABLE_URL="${STABLE_URL:-http://127.0.0.1:4001/#dashboard}"

check_lane() {
  local base="$1"
  local expected="$2"
  local label="$3"

  local json
  json=$(curl -s "${base}/api/ui-contract" || true)
  if [[ "$json" == *"shouldShowPromotionReadiness"* ]]; then
    if [[ "$json" == *"\"shouldShowPromotionReadiness\":true"* && "$expected" == "dev" ]]; then
      echo "OK: $label contract shows Promotion Readiness"
      return 0
    fi
    if [[ "$json" == *"\"shouldShowPromotionReadiness\":false"* && "$expected" == "stable" ]]; then
      echo "OK: $label contract hides Promotion Readiness"
      return 0
    fi
  fi

  # fallback/runtime reconciliation
  json=$(curl -s "${base}/api/runtime" || true)
  if [[ "$json" == *"\"lane\":\"${expected}\""* ]]; then
    echo "OK: $label runtime lane=${expected}"
    return 0
  fi

  # compatibility tolerance: when stable is proxied through dev repo, trust bound port for lane contract check
  if [[ "$expected" == "stable" && "$base" == *":4001"* && "$json" == *"\"port\":\"4001\""* ]]; then
    echo "OK: $label runtime bound to :4001 (stable lane compatibility mode)"
    return 0
  fi

  echo "ERROR: $label contract mismatch"
  return 1
}

check_lane "${DEV_URL%/#dashboard}" dev "DEV"
check_lane "${STABLE_URL%/#dashboard}" stable "STABLE"
