#!/usr/bin/env bash
set -euo pipefail

EXPECTED_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app"
STABLE_STOP="$EXPECTED_REPO/scripts/stable-stop.sh"
STABLE_START="$EXPECTED_REPO/scripts/stable-start.sh"
STABLE_PORT="4001"
LOG_PATH="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/data-dev/logs/stable-runtime-watchdog.jsonl"
ALERT_LOG="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/data-dev/logs/stable-runtime-watchdog-alerts.log"
ALERT_STATE_FILE="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/data-dev/logs/stable-runtime-watchdog-alert-state.json"
RECOVERY_ALERT_COOLDOWN_SECONDS="${RECOVERY_ALERT_COOLDOWN_SECONDS:-600}"
TMP_BODY="$(mktemp -t stable-watchdog-body.XXXXXX)"

mkdir -p "$(dirname "$LOG_PATH")"

json_log() {
  local payload="$1"
  python3 - <<'PY' "$LOG_PATH" "$payload"
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
payload = json.loads(sys.argv[2])
with path.open('a', encoding='utf-8') as f:
    f.write(json.dumps(payload) + '\n')
PY
}

alert_log() {
  local level="$1"
  local message="$2"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '%s [%s] %s\n' "$ts" "$level" "$message" >> "$ALERT_LOG"
}

should_emit_recovery_alert() {
  local signature="$1"
  python3 - <<'PY' "$ALERT_STATE_FILE" "$RECOVERY_ALERT_COOLDOWN_SECONDS" "$signature"
import json, pathlib, sys, time
state_path = pathlib.Path(sys.argv[1])
cooldown = int(sys.argv[2])
signature = sys.argv[3]
now = int(time.time())
state = {}
if state_path.exists():
    try:
        state = json.loads(state_path.read_text())
    except Exception:
        state = {}
last_at = int(state.get('lastRecoveryAlertAt', 0) or 0)
last_sig = str(state.get('lastRecoverySignature', ''))
emit = (signature != last_sig) or ((now - last_at) >= cooldown)
if emit:
    state_path.write_text(json.dumps({
        'lastRecoveryAlertAt': now,
        'lastRecoverySignature': signature,
    }))
print('1' if emit else '0')
PY
}

get_http_code() {
  local url="$1"
  curl -sS -m 8 -o "$TMP_BODY" -w "%{http_code}" "$url" || true
}

runtime_field() {
  local json="$1"
  local key="$2"
  python3 - <<'PY' "$json" "$key"
import json, sys
raw, key = sys.argv[1], sys.argv[2]
try:
    obj = json.loads(raw)
    val = obj.get(key)
    print('' if val is None else str(val))
except Exception:
    print('')
PY
}

find_4001_pids() {
  {
    /usr/sbin/lsof -tiTCP:"$STABLE_PORT" -sTCP:LISTEN 2>/dev/null || true
    pgrep -f "port 4001" || true
    pgrep -f "next start --port 4001" || true
    pgrep -f "npm start --port 4001" || true
  } | tr ' ' '\n' | awk 'NF && $1 ~ /^[0-9]+$/ { print $1 }' | sort -u
}

pid_cmd() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

kill_pid_force() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  sleep 0.2
  kill -9 "$pid" 2>/dev/null || true
}

validate_invariants() {
  local health_code runtime_code root_code runtime_json lane repo port root_html page_chunk chunk_code
  health_code="$(get_http_code "http://127.0.0.1:${STABLE_PORT}/api/health")"
  runtime_code="$(get_http_code "http://127.0.0.1:${STABLE_PORT}/api/runtime")"
  runtime_json="$(curl -sS -m 8 "http://127.0.0.1:${STABLE_PORT}/api/runtime" || true)"
  root_code="$(get_http_code "http://127.0.0.1:${STABLE_PORT}/")"

  lane="$(runtime_field "$runtime_json" "lane")"
  repo="$(runtime_field "$runtime_json" "repoPath")"
  port="$(runtime_field "$runtime_json" "port")"

  root_html="$(curl -sS -m 8 "http://127.0.0.1:${STABLE_PORT}/" || true)"
  page_chunk="$(printf '%s' "$root_html" | grep -oE '/_next/static/chunks/app/[^" ]+\.js' | head -n 1 || true)"
  if [[ -n "$page_chunk" ]]; then
    chunk_code="$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${STABLE_PORT}${page_chunk}" || true)"
  else
    chunk_code="na"
  fi

  FAIL_REASONS=()
  [[ "$health_code" == "200" ]] || FAIL_REASONS+=("health_http_${health_code}")
  [[ "$runtime_code" == "200" ]] || FAIL_REASONS+=("runtime_http_${runtime_code}")
  [[ "$lane" == "stable" ]] || FAIL_REASONS+=("runtime_lane_${lane:-missing}")
  [[ "$repo" == "$EXPECTED_REPO" ]] || FAIL_REASONS+=("runtime_repo_${repo:-missing}")
  [[ "$port" == "$STABLE_PORT" ]] || FAIL_REASONS+=("runtime_port_${port:-missing}")
  if [[ "$root_code" =~ ^5 ]]; then
    FAIL_REASONS+=("root_http_${root_code}")
  fi
  if [[ "$chunk_code" != "na" && "$chunk_code" != "200" ]]; then
    FAIL_REASONS+=("root_chunk_http_${chunk_code}")
  fi

  INVARIANT_SNAPSHOT=$(python3 - <<'PY' "$health_code" "$runtime_code" "$lane" "$repo" "$port" "$root_code" "$page_chunk" "$chunk_code"
import json, sys
health, runtime, lane, repo, port, root, page_chunk, chunk_code = sys.argv[1:]
print(json.dumps({
  "healthCode": health,
  "runtimeCode": runtime,
  "runtimeLane": lane,
  "runtimeRepoPath": repo,
  "runtimePort": port,
  "rootCode": root,
  "rootPageChunk": page_chunk,
  "rootPageChunkCode": chunk_code,
}))
PY
)
}

wait_for_stable_readiness() {
  local attempts="${1:-15}"
  local sleep_s="${2:-1}"
  local i
  for i in $(seq 1 "$attempts"); do
    validate_invariants
    if (( ${#FAIL_REASONS[@]} == 0 )); then
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

main() {
  local now pids killed_json kill_entries down_before recovery_status
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  validate_invariants

  pids="$(find_4001_pids)"
  kill_entries='[]'

  # Ownership enforcement (safe):
  # - If invariants are healthy, do NOT kill ambiguous listener processes.
  # - If invariants are unhealthy, only pre-kill explicit wrong-owner signatures.
  if (( ${#FAIL_REASONS[@]} > 0 )) && [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      cmd="$(pid_cmd "$pid")"
      if [[ "$cmd" == *"clawd-app-dev"* ]] || [[ "$cmd" == *"/tmp/"* ]] || [[ "$cmd" == *"fake4001"* ]]; then
        kill_pid_force "$pid"
        kill_entries=$(python3 - <<'PY' "$kill_entries" "$pid" "$cmd"
import json, sys
arr = json.loads(sys.argv[1])
arr.append({"pid": int(sys.argv[2]), "command": sys.argv[3], "reason": "wrong_owner_on_4001"})
print(json.dumps(arr))
PY
)
      fi
    done <<< "$pids"
  fi

  # Re-evaluate after explicit ownership enforcement
  validate_invariants
  if (( ${#FAIL_REASONS[@]} == 0 )); then
    json_log "$(python3 - <<'PY' "$now" "$INVARIANT_SNAPSHOT" "$kill_entries"
import json, sys
now, snap, killed = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
print(json.dumps({
  "timestamp": now,
  "event": "stable_watchdog_check",
  "status": "healthy",
  "failedReasons": [],
  "killedProcesses": killed,
  "recovery": "not_needed",
  "invariants": snap,
}))
PY
)"
    echo "STABLE_OK"
    return 0
  fi

  down_before="$(python3 - <<'PY' "$INVARIANT_SNAPSHOT" "${FAIL_REASONS[*]}"
import json, sys
snap = json.loads(sys.argv[1])
reasons = [r for r in sys.argv[2].split(' ') if r]
print(json.dumps({"invariants": snap, "failedReasons": reasons}))
PY
)"

  # Deterministic recovery flow
  "$STABLE_STOP" || true

  pids="$(find_4001_pids)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      cmd="$(pid_cmd "$pid")"
      kill_pid_force "$pid"
      kill_entries=$(python3 - <<'PY' "$kill_entries" "$pid" "$cmd"
import json, sys
arr = json.loads(sys.argv[1])
arr.append({"pid": int(sys.argv[2]), "command": sys.argv[3], "reason": "deterministic_recovery_kill_4001"})
print(json.dumps(arr))
PY
)
    done <<< "$pids"
  fi

  "$STABLE_START"

  if wait_for_stable_readiness 20 1; then
    recovery_status="success"
    json_log "$(python3 - <<'PY' "$now" "$down_before" "$INVARIANT_SNAPSHOT" "$kill_entries" "$recovery_status"
import json, sys
now = sys.argv[1]
before = json.loads(sys.argv[2])
after = json.loads(sys.argv[3])
killed = json.loads(sys.argv[4])
status = sys.argv[5]
print(json.dumps({
  "timestamp": now,
  "event": "stable_watchdog_incident",
  "status": "recovered",
  "failedReasons": before.get("failedReasons", []),
  "killedProcesses": killed,
  "recovery": status,
  "before": before.get("invariants"),
  "after": after,
}))
PY
)"
    local recovery_signature
    recovery_signature="$(python3 - <<'PY' "${FAIL_REASONS[*]-}" "$kill_entries"
import json, sys
reasons = [r for r in sys.argv[1].split(' ') if r]
killed = json.loads(sys.argv[2])
k_reason = killed[0]['reason'] if killed else 'none'
print('|'.join(sorted(reasons)) + '::' + k_reason)
PY
)"

    if [[ "$(should_emit_recovery_alert "$recovery_signature")" == "1" ]]; then
      alert_log "WARN" "STABLE_RECOVERED: watchdog recovered 4001 automatically"
      echo "STABLE_RECOVERED"
    else
      alert_log "INFO" "STABLE_RECOVERED_SUPPRESSED: duplicate recovery signal within cooldown"
      echo "STABLE_RECOVERED_SUPPRESSED"
    fi
    return 0
  fi

  recovery_status="hard_failure"
  json_log "$(python3 - <<'PY' "$now" "$down_before" "$INVARIANT_SNAPSHOT" "$kill_entries" "$recovery_status" "${FAIL_REASONS[*]}"
import json, sys
now = sys.argv[1]
before = json.loads(sys.argv[2])
after = json.loads(sys.argv[3])
killed = json.loads(sys.argv[4])
status = sys.argv[5]
post_fail = [r for r in sys.argv[6].split(' ') if r]
print(json.dumps({
  "timestamp": now,
  "event": "stable_watchdog_incident",
  "status": "hard_failure",
  "failedReasons": before.get("failedReasons", []),
  "postRecoveryFailedReasons": post_fail,
  "killedProcesses": killed,
  "recovery": status,
  "before": before.get("invariants"),
  "after": after,
  "operatorActionRequired": True,
}))
PY
)"
  alert_log "ERROR" "STABLE_HARD_FAILURE: watchdog could not restore 4001; operator intervention required"
  echo "STABLE_HARD_FAILURE"
  return 2
}

main "$@"
