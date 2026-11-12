#!/bin/bash
# Native Linux-only, read-only Docker fixture. No Railway access or upgrade phases.
set -euo pipefail
export LC_ALL=C

readonly bound_script='/opt/clawpilot/native-ci-launch-rehearsal.sh'
readonly responder='/opt/clawpilot/native-email-maintenance.py'
readonly fixture_mount='/var/lib/suitecrm'
readonly port=18081
readonly nonce_pattern='^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'

hold() { printf 'no-ssh-native-ci-launch: %s\n' "$1" >&2; exit 1; }

stock_pid1() {
  local -a argv=()
  local actual_exe expected_exe
  mapfile -d '' -t argv < /proc/1/cmdline || return 1
  [[ "${#argv[@]}" == 3 && "${argv[0]}" == python3 && "${argv[1]}" == -B && "${argv[2]}" == "$responder" &&
     "$(< /proc/1/comm)" == python3 ]] || return 1
  actual_exe=$(readlink -f /proc/1/exe) && expected_exe=$(readlink -f /usr/bin/python3) &&
    [[ -n "$actual_exe" && -n "$expected_exe" && "$actual_exe" == "$expected_exe" && -f "$expected_exe" ]]
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
    [[ "$destination" != "$fixture_mount"/* ]] || hold 'unexpected nested fixture mount'
    if [[ "$destination" == "$fixture_mount" ]]; then
      read -r kind _rest <<< "$right"
      [[ "$kind" == tmpfs && ",$options," == *,ro,* && ",$options," == *,nosuid,* &&
         ",$options," == *,nodev,* && ",$options," == *,noexec,* ]] ||
        hold 'fixture mount is not restricted read-only tmpfs'
      count=$((count + 1))
    fi
  done < /proc/1/mountinfo
  [[ "$count" == 1 && ! -L "$fixture_mount" && -d "$fixture_mount" && ! -e "$fixture_mount/app" ]] ||
    hold 'unexpected data or mount at fixture location'
}

maintenance_http() {
  local health code
  health=$(curl --noproxy '*' --proto '=http' --max-time 1 --silent --fail --write-out '%{http_code}' \
    "http://127.0.0.1:$port/_clawpilot/liveness") &&
    [[ "$health" == $'{"service":"suitecrm","mode":"maintenance","live":true,"ready":false}\n200' ]] &&
    code=$(curl --noproxy '*' --proto '=http' --max-time 1 --silent --output /dev/null --write-out '%{http_code}' \
      "http://127.0.0.1:$port/") && [[ "$code" == 503 ]]
}

observe() {
  fixture_scope
  local deadline=$((SECONDS + 8)) proc peer=0 parent='' key value _rest
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
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    case "${proc##*/}" in
      1|"$BASHPID") peer=$((peer + 1)) ;;
      *) hold 'unexpected process in the fixture namespace' ;;
    esac
  done
  [[ "$peer" == 2 ]] || hold 'stock responder and observer census incomplete'
  printf 'stock-maintenance-topology-verified child=%s\n' "$BASHPID"
}

observe_after_exit() {
  fixture_scope
  local observed_pid="$1" state='' key value _rest attempt
  [[ "$observed_pid" =~ ^([2-9][0-9]*|1[0-9]+)$ ]] || hold 'invalid child PID'
  for ((attempt=0; attempt<30; attempt++)); do
    stock_pid1 || hold 'fixed Python PID 1 changed after observer exit'
    if [[ ! -d "/proc/$observed_pid" ]]; then
      maintenance_http || hold 'maintenance HTTP failed after child exit'
      printf '%s\n' 'fixture-child-reaped'
      return 0
    fi
    state=''
    if [[ -r "/proc/$observed_pid/status" ]]; then
      while read -r key value _rest; do
        if [[ "$key" == State: ]]; then state="$value"; break; fi
      done < "/proc/$observed_pid/status" 2>/dev/null || true
    fi
    sleep 0.1
  done
  if [[ "$state" == Z && -d "/proc/$observed_pid" ]]; then
    printf '%s\n' 'fixture-child-unreaped-zombie' >&2
    return 2
  fi
  hold 'observer exit or process state could not be proved'
}

case "${1:-}" in
  --container)
    [[ "$#" == 1 && "$$" == 1 && "$0" == "$bound_script" ]] || hold 'fixture wrapper is not the initial PID'
    fixture_scope
    /bin/bash --noprofile --norc "$bound_script" --observe &
    exec /usr/local/bin/entrypoint.sh
    ;;
  --observe)
    [[ "$#" == 1 && "$0" == "$bound_script" ]] || hold 'observer entrypoint mismatch'
    observe
    exit
    ;;
  --lifecycle)
    [[ "$#" == 2 && "$0" == "$bound_script" ]] || hold 'lifecycle entrypoint mismatch'
    observe_after_exit "$2"
    exit
    ;;
  --iidfile) ;;
  *) hold 'usage: bash no-ssh-native-ci-launch-rehearsal.sh --iidfile <docker-build-iidfile>' ;;
esac

[[ "$#" == 2 && "$(uname -s):$(uname -m)" == Linux:x86_64 ]] || hold 'host must be native Linux amd64'
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}" ]] || hold 'Docker endpoint override refused'
docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') || hold 'Docker endpoint missing'
[[ "$docker_endpoint" == unix:///* && -S "${docker_endpoint#unix://}" ]] || hold 'requires local Docker socket'
[[ "$(docker info --format '{{.OSType}} {{.Architecture}}')" == 'linux x86_64' ]] ||
  hold 'Docker server is not Linux amd64'

[[ -f "$2" && ! -L "$2" ]] || hold 'build iidfile missing or not a regular file'
declare -a ids=()
mapfile -t ids < "$2"
[[ "${#ids[@]}" == 1 && "${ids[0]}" =~ ^sha256:[0-9a-f]{64}$ ]] || hold 'build iidfile is invalid'
readonly image="${ids[0]}"
[[ "$(docker image inspect --format '{{.Id}} {{.Os}} {{.Architecture}} {{json .Config.Entrypoint}}' "$image")" == \
   "$image linux amd64 [\"/usr/local/bin/entrypoint.sh\"]" ]] || hold 'exact local build image does not match'

source_file=$(realpath -- "${BASH_SOURCE[0]}")
[[ -f "$source_file" && ! -L "${BASH_SOURCE[0]}" ]] || hold 'fixture script path not verified'
read -r nonce < /proc/sys/kernel/random/uuid
[[ "$nonce" =~ $nonce_pattern ]] || hold 'fixture nonce invalid'
readonly name="clawpilot-no-ssh-native-ci-$nonce" label='clawpilot.local.no-ssh-native-ci-launch'
container=''

cleanup() {
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
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container=$(docker run --detach --rm --pull never --name "$name" --label "$label=$nonce" \
  --platform linux/amd64 --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 192m --pids-limit 32 --workdir / --entrypoint /bin/bash \
  --env "CLAWPILOT_LOCAL_LAUNCH_FIXTURE=$nonce" --env CLAWPILOT_NATIVE_INITIAL_MAINTENANCE=1 --env "PORT=$port" \
  --tmpfs "$fixture_mount:ro,nosuid,nodev,noexec,size=16m" \
  --tmpfs '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777' \
  --mount "type=bind,source=$source_file,target=$bound_script,readonly" \
  "$image" --noprofile --norc "$bound_script" --container)
[[ "$container" =~ ^[0-9a-f]{64}$ ]] || hold 'fixture container ID not verified'
host_config=$(docker inspect --type container \
  --format '{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.PublishAllPorts}} {{json .HostConfig.PortBindings}} {{json .HostConfig.PidMode}}' "$container")
[[ "$host_config" == 'none true false {} ""' || "$host_config" == 'none true false null ""' ]] ||
  hold 'fixture network, PID, or read-only isolation not verified'

deadline=$((SECONDS + 12))
marker=''
while (( SECONDS < deadline )); do
  logs=$(docker logs "$container" 2>&1) || hold 'fixture stopped before an observation'
  marker=$(printf '%s\n' "$logs" | awk '/^stock-maintenance-topology-verified child=[0-9]+$/ { print; }')
  [[ -z "$marker" ]] || break
  error=$(printf '%s\n' "$logs" | awk '/^no-ssh-native-ci-launch: / { print; }')
  [[ -z "$error" ]] || { printf '%s\n' "$error" >&2; exit 1; }
  sleep 0.1
done
[[ "$marker" =~ ^stock-maintenance-topology-verified\ child=([0-9]+)$ ]] ||
  hold 'fixture did not report exactly one topology observation'
observed_pid="${BASH_REMATCH[1]}"
printf '%s\n' "$marker"
docker exec "$container" /bin/bash --noprofile --norc "$bound_script" --lifecycle "$observed_pid"
