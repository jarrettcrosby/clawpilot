#!/bin/bash
# Native Linux-only Docker fixture. No Railway access, credentials or upgrades.
set -euo pipefail
export LC_ALL=C

readonly fixture='/opt/clawpilot/native-ci-launch-rehearsal.sh'
readonly responder='/opt/clawpilot/native-email-maintenance.py'
readonly mounted='/var/lib/suitecrm'
readonly port=18081
readonly nonce_pattern='^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
readonly label='clawpilot.local.no-ssh-native-ci-launch'

hold() { printf 'no-ssh-native-ci-launch: %s\n' "$1" >&2; exit 1; }

stock_pid1() {
  local -a argv=()
  local actual expected
  mapfile -d '' -t argv < /proc/1/cmdline || return 1
  [[ "${#argv[@]}" == 3 && "${argv[0]}" == python3 && "${argv[1]}" == -B && "${argv[2]}" == "$responder" &&
     "$(< /proc/1/comm)" == python3 ]] || return 1
  actual=$(readlink -f /proc/1/exe) && expected=$(readlink -f /usr/bin/python3) &&
    [[ -n "$actual" && -n "$expected" && "$actual" == "$expected" && -f "$expected" ]]
}

fixture_scope() {
  [[ "$(uname -s):$(uname -m)" == Linux:x86_64 && "${CLAWPILOT_LOCAL_LAUNCH_FIXTURE:-}" =~ $nonce_pattern &&
     "${CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:-}" == 1 && "${PORT:-}" == "$port" &&
     "${SUITECRM_VERSION:-}" == '8.10.2' &&
     -z "${RAILWAY_PROJECT_ID:-}${RAILWAY_ENVIRONMENT_ID:-}${RAILWAY_SERVICE_ID:-}${RAILWAY_DEPLOYMENT_ID:-}${RAILWAY_REPLICA_ID:-}${RAILWAY_GIT_COMMIT_SHA:-}${RAILWAY_VOLUME_MOUNT_PATH:-}" &&
     -z "${SUITECRM_DB_HOST:-}${SUITECRM_DB_USER:-}${SUITECRM_DB_PASSWORD:-}" && "$EUID" == 0 ]] ||
    hold 'fixture scope not verified'
  [[ -f /opt/suitecrm/VERSION && ! -L /opt/suitecrm/VERSION ]] &&
    cmp -s /opt/suitecrm/VERSION <(printf '8.10.2\n') || hold 'packaged SuiteCRM is not exactly 8.10.2'
  local count=0 left right destination options kind
  while IFS= read -r left; do
    right=${left#* - }
    read -r _id _parent _device _root destination options _rest <<< "$left"
    [[ "$destination" != "$mounted"/* ]] || hold 'unexpected nested fixture mount'
    if [[ "$destination" == "$mounted" ]]; then
      read -r kind _rest <<< "$right"
      [[ "$kind" == tmpfs && ",$options," == *,ro,* && ",$options," == *,nosuid,* &&
         ",$options," == *,nodev,* && ",$options," == *,noexec,* ]] || hold 'fixture mount is not restricted read-only tmpfs'
      count=$((count + 1))
    fi
  done < /proc/1/mountinfo
  [[ "$count" == 1 && ! -L "$mounted" && -d "$mounted" && ! -e "$mounted/app" ]] ||
    hold 'unexpected data or mount at fixture location'
}

maintenance_http() {
  local health code
  local -a curl_args=(--noproxy '*' --proto '=http' --max-time 1 --silent --write-out '%{http_code}')
  health=$(curl "${curl_args[@]}" "http://127.0.0.1:$port/_clawpilot/liveness") &&
    [[ "$health" == $'{"service":"suitecrm","mode":"maintenance","live":true,"ready":false}\n200' ]] &&
    code=$(curl "${curl_args[@]}" --output /dev/null "http://127.0.0.1:$port/") && [[ "$code" == 503 ]] &&
    code=$(curl "${curl_args[@]}" --output /dev/null -X POST "http://127.0.0.1:$port/_clawpilot/liveness") && [[ "$code" == 405 ]]
}

only_pid1_and_self() {
  local proc count=0
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    case "${proc##*/}" in
      1|"$BASHPID") count=$((count + 1)) ;;
      *) hold 'unexpected process in the fixture namespace' ;;
    esac
  done
  [[ "$count" == 2 ]] || hold 'exact responder and observer census incomplete'
}

observe() {
  fixture_scope
  local scenario="$1" deadline=$((SECONDS + 8)) parent='' key value _rest
  until stock_pid1 && maintenance_http; do
    ((SECONDS < deadline)) || hold 'fixed Python PID 1 or expected maintenance HTTP responses missing'
    sleep 0.1
  done
  while read -r key value _rest; do
    if [[ "$key" == PPid: ]]; then parent="$value"; break; fi
  done < "/proc/$BASHPID/status"
  [[ "$parent" == 1 && "$(< /proc/$BASHPID/comm)" == bash && "$BASHPID" != 1 ]] ||
    hold 'observer is not a direct Bash child of PID 1'
  stock_pid1 || hold 'fixed Python PID 1 changed during observation'
  only_pid1_and_self
  printf 'stock-maintenance-topology-verified child=%s scenario=%s\n' "$BASHPID" "$scenario"
  case "$scenario" in
    success) exit 0 ;;
    failure) exit 17 ;;
    sigterm) kill -TERM "$BASHPID"; exit 73 ;;
    *) hold 'unexpected synthetic exit scenario' ;;
  esac
}

observe_after_exit() {
  fixture_scope
  local pid="$1" state='' key value _rest attempt
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$pid" != 1 ]] || hold 'invalid child PID'
  for ((attempt=0; attempt<30; attempt++)); do
    stock_pid1 || hold 'fixed Python PID 1 changed after observer exit'
    if [[ ! -d "/proc/$pid" ]]; then
      maintenance_http || hold 'maintenance HTTP failed after child exit'
      only_pid1_and_self
      return 0
    fi
    state=''
    if [[ -r "/proc/$pid/status" ]]; then
      while read -r key value _rest; do
        if [[ "$key" == State: ]]; then state="$value"; break; fi
      done < "/proc/$pid/status" 2>/dev/null || true
    fi
    sleep 0.1
  done
  if [[ "$state" == Z && -d "/proc/$pid" ]]; then
    printf '%s\n' 'fixture-child-unreaped-zombie' >&2
    return 2
  fi
  hold 'observer exit or process state could not be proved'
}

case "${1:-}" in
  --container)
    [[ "$#" == 2 && "$$" == 1 && "$0" == "$fixture" && "$2" =~ ^(success|failure|sigterm)$ ]] ||
      hold 'fixture wrapper or scenario not verified'
    fixture_scope
    /bin/bash --noprofile --norc "$fixture" --observe "$2" &
    exec /usr/local/bin/entrypoint.sh
    ;;
  --observe)
    [[ "$#" == 2 && "$0" == "$fixture" ]] || hold 'observer entrypoint mismatch'
    observe "$2"
    ;;
  --lifecycle)
    [[ "$#" == 2 && "$0" == "$fixture" ]] || hold 'lifecycle entrypoint mismatch'
    observe_after_exit "$2"
    exit
    ;;
  --iidfile) ;;
  *) hold 'usage: bash suitecrm-no-ssh-native-launch.sh --iidfile <docker-build-iidfile>' ;;
esac

[[ "$#" == 2 && "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || hold 'host must be native Linux amd64'
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]] || hold 'Docker endpoint override refused'
docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') || hold 'Docker endpoint missing'
[[ "$docker_endpoint" == unix:///* && -S "${docker_endpoint#unix://}" ]] || hold 'requires local Docker socket'
[[ "$(docker info --format '{{.OSType}} {{.Architecture}}')" == 'linux x86_64' ]] || hold 'Docker server is not Linux amd64'
[[ -f "$2" && ! -L "$2" ]] || hold 'build iidfile missing or not a regular file'
declare -a ids=()
mapfile -t ids < "$2"
[[ "${#ids[@]}" == 1 && "${ids[0]}" =~ ^sha256:[0-9a-f]{64}$ ]] || hold 'build iidfile is invalid'
readonly image="${ids[0]}"
[[ "$(docker image inspect --format '{{.Id}} {{.Os}} {{.Architecture}} {{json .Config.Entrypoint}}' "$image")" == \
   "$image linux amd64 [\"/usr/local/bin/entrypoint.sh\"]" ]] || hold 'exact local build image does not match'

source_file=$(realpath -- "${BASH_SOURCE[0]}")
[[ -f "$source_file" && ! -L "${BASH_SOURCE[0]}" ]] || hold 'fixture script path not verified'
container='' nonce='' name=''

cleanup() {
  [[ -n "$nonce" && -n "$name" ]] || return 0
  local candidate="$container" custody
  if [[ ! "$candidate" =~ ^[0-9a-f]{64}$ ]]; then
    candidate=$(docker inspect --type container --format '{{.Id}}' "$name" 2>/dev/null) || return 0
  fi
  [[ "$candidate" =~ ^[0-9a-f]{64}$ ]] || return 0
  custody=$(docker inspect --type container --format '{{.Name}} {{.Image}} {{index .Config.Labels "clawpilot.local.no-ssh-native-ci-launch"}}' \
    "$candidate" 2>/dev/null) || return 0
  [[ "$custody" == "/$name $image $nonce" ]] || return 1
  docker rm -f "$candidate" >/dev/null || return 1
  printf '%s\n' 'fixture-container-removed'
  container='' nonce='' name=''
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_fixture() {
  local scenario="$1" expected_exit="$2" host_config deadline logs marker='' error observed_pid reaped
  read -r nonce < /proc/sys/kernel/random/uuid
  [[ "$nonce" =~ $nonce_pattern ]] || hold 'fixture nonce invalid'
  name="clawpilot-no-ssh-native-ci-$nonce"
  container=$(docker run --detach --rm --pull never --name "$name" --label "$label=$nonce" \
    --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 192m --pids-limit 32 --workdir / --entrypoint /bin/bash \
    --env "CLAWPILOT_LOCAL_LAUNCH_FIXTURE=$nonce" --env CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=1 --env "PORT=$port" \
    --tmpfs "$mounted:ro,nosuid,nodev,noexec,size=16m" --tmpfs '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777' \
    --mount "type=bind,source=$source_file,target=$fixture,readonly" \
    "$image" --noprofile --norc "$fixture" --container "$scenario")
  [[ "$container" =~ ^[0-9a-f]{64}$ ]] || hold 'fixture container ID not verified'
  host_config=$(docker inspect --type container \
    --format '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PublishAllPorts}} {{json .HostConfig.PortBindings}} {{json .HostConfig.PidMode}}' "$container")
  [[ "$host_config" == 'none true false {} ""' || "$host_config" == 'none true false null ""' ]] ||
    hold 'fixture network, PID, or read-only isolation not verified'
  deadline=$((SECONDS + 12))
  while ((SECONDS < deadline)); do
    logs=$(docker logs "$container" 2>&1) || hold 'fixture stopped before an observation'
    marker=$(printf '%s\n' "$logs" | awk '/^stock-maintenance-topology-verified child=[0-9]+ scenario=(success|failure|sigterm)$/ {print}')
    [[ -z "$marker" ]] || break
    error=$(printf '%s\n' "$logs" | awk '/^no-ssh-native-ci-launch: / {print}')
    [[ -z "$error" ]] || { printf '%s\n' "$error" >&2; exit 1; }
    sleep 0.1
  done
  [[ "$marker" =~ ^stock-maintenance-topology-verified\ child=([0-9]+)\ scenario=$scenario$ ]] ||
    hold 'fixture did not report exactly one matching topology observation'
  observed_pid="${BASH_REMATCH[1]}"
  printf '%s\n' "$marker"
  docker exec "$container" /bin/bash --noprofile --norc "$fixture" --lifecycle "$observed_pid"
  logs=$(docker logs "$container" 2>&1) || hold 'fixture stopped before exit receipt observation'
  reaped=$(printf '%s\n' "$logs" | grep -Fx "{\"service\":\"suitecrm\",\"mode\":\"maintenance\",\"event\":\"child_reaped\",\"pid\":$observed_pid,\"exitCode\":$expected_exit}" || true)
  [[ -n "$reaped" && "$reaped" != *$'\n'* ]] || hold 'missing or duplicate diagnostic exit observation'
  printf 'fixture-child-reaped scenario=%s exit=%s\n' "$scenario" "$expected_exit"
  cleanup
}

run_fixture success 0
run_fixture failure 17
run_fixture sigterm -15
