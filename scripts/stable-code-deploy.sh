#!/usr/bin/env bash
set -euo pipefail

CONTROL_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"

ROUTE_CHECKS="${ROUTE_CHECKS:-/api/health /api/runtime /}"
COMMIT=""
STATUS="failed"

usage() {
  cat <<'USAGE'
Usage: stable-code-deploy.sh --commit <sha>

Operator-gated stable code deployment.
- Updates stable repo to the specified commit
- Rebuilds + restarts stable
- Verifies runtime
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)
      COMMIT="$2"
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

if [[ -z "$COMMIT" ]]; then
  usage
  exit 1
fi

finish() {
  local status="$1"
  "$DEV_REPO/scripts/rollout-manifest.sh" --phase code --status "$status" --commit "$COMMIT" || true
}
trap 'finish "$STATUS"' EXIT

if [[ ! -e "$CONTROL_REPO/.git" ]]; then
  echo "ERROR: stable repo not found at $CONTROL_REPO"
  exit 1
fi

if [[ ! -e "$DEV_REPO/.git" ]]; then
  echo "ERROR: dev repo not found at $DEV_REPO"
  exit 1
fi

if ! git -C "$DEV_REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  echo "ERROR: commit not found in dev repo: $COMMIT"
  exit 1
fi

if ! git -C "$CONTROL_REPO" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  echo "ERROR: commit not found in stable repo: $COMMIT"
  echo "Hint: ensure stable repo has the commit (fetch/merge) before deploy."
  exit 1
fi

preflight_clean_committed_build() {
  local tmp_worktree
  tmp_worktree="$(mktemp -d /tmp/clawd-stable-preflight-XXXXXX)"
  echo "==> Pre-deploy guard: clean committed-files-only build"
  echo "    commit: ${COMMIT:0:7}"
  git -C "$CONTROL_REPO" worktree add --detach "$tmp_worktree" "$COMMIT" >/dev/null
  set +e
  (
    cd "$tmp_worktree/app_src" &&
    npm install >/dev/null &&
    npm run build
  )
  local build_code=$?
  set -e
  git -C "$CONTROL_REPO" worktree remove --force "$tmp_worktree" >/dev/null || true
  if [[ $build_code -ne 0 ]]; then
    echo "ERROR: pre-deploy guard failed: clean committed-files-only build is not green"
    echo "Refusing stable deploy. Commit local-only dependencies and retry."
    exit 1
  fi
  echo "OK: pre-deploy guard passed (clean committed-files-only build green)"
}

CURRENT_COMMIT=$(git -C "$CONTROL_REPO" rev-parse HEAD)

echo "====================================="
echo "STABLE CODE DEPLOY (OPERATOR-GATED)"
echo "====================================="
echo "Stable repo: $CONTROL_REPO"
echo "Current commit: ${CURRENT_COMMIT:0:7}"
echo "Target commit:  ${COMMIT:0:7}"
echo ""
echo "This will update stable code to the target commit, rebuild, restart, and verify."
echo "Type 'DEPLOY' to continue:"
read -r CONFIRM
if [[ "$CONFIRM" != "DEPLOY" ]]; then
  echo "Aborted. No changes applied."
  exit 1
fi

# Guard: required rollout evidence + freeze
"$DEV_REPO/scripts/rollout-guard.sh" --require-freeze

# Guard: target commit must pass a clean committed-files-only build
preflight_clean_committed_build

# Checkout commit
( cd "$CONTROL_REPO" && git checkout "$COMMIT" )

# Build stable app
APP_DIR="$CONTROL_REPO/app_src"
( cd "$APP_DIR" && npm install >/dev/null )
( cd "$APP_DIR" && ./node_modules/.bin/next build --webpack )

# Restart stable (build + verify)
"$CONTROL_REPO/scripts/stable-stop.sh" || true
ROUTE_CHECKS="$ROUTE_CHECKS" "$CONTROL_REPO/scripts/stable-start.sh"

if [[ -x "$CONTROL_REPO/scripts/stable-verify.sh" ]]; then
  ROUTE_CHECKS="$ROUTE_CHECKS" "$CONTROL_REPO/scripts/stable-verify.sh"
else
  echo "WARN: stable-verify.sh missing; using direct route checks"
  for route in $ROUTE_CHECKS; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:4001${route}")
    if [[ "$code" != "200" ]]; then
      echo "ERROR: route ${route} -> ${code}"
      exit 1
    fi
    echo "OK: route ${route} -> 200"
  done
fi

STATUS="ok"
echo "OK: stable code deploy complete"
