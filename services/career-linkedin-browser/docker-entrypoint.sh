#!/usr/bin/env bash
set -euo pipefail

display_number="${DISPLAY:-:99}"
screen_width="${SCREEN_WIDTH:-1280}"
screen_height="${SCREEN_HEIGHT:-800}"
vnc_port="${VNC_PORT:-5900}"
x11_socket_dir="${X11_SOCKET_DIR:-/tmp/.X11-unix}"
x11_lock_dir="${X11_LOCK_DIR:-/tmp}"
x11_socket_registry="${X11_SOCKET_REGISTRY:-/proc/net/unix}"

if [[ ! "${display_number}" =~ ^:([0-9]+)(\.[0-9]+)?$ ]]; then
  echo "Invalid DISPLAY value: ${display_number}" >&2
  exit 1
fi

display_index="${BASH_REMATCH[1]}"
x11_socket="${x11_socket_dir}/X${display_index}"
x11_lock="${x11_lock_dir}/.X${display_index}-lock"

xvfb_pid=""
vnc_pid=""
server_pid=""

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  set +e

  # Let the Node server close Chromium while its display is still available.
  # Then stop and reap the display children so tini never inherits zombies.
  if [ -n "${server_pid}" ]; then
    kill -TERM "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  for child_pid in "${vnc_pid}" "${xvfb_pid}"; do
    if [ -n "${child_pid}" ]; then
      kill -TERM "${child_pid}" 2>/dev/null || true
    fi
  done
  for child_pid in "${vnc_pid}" "${xvfb_pid}"; do
    if [ -n "${child_pid}" ]; then
      wait "${child_pid}" 2>/dev/null || true
    fi
  done

  exit "${exit_status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

socket_is_registered() {
  [ -r "${x11_socket_registry}" ] || return 2
  awk -v socket_path="${x11_socket}" '
    NR > 1 && $NF == socket_path { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "${x11_socket_registry}"
}

prepare_display() {
  local lock_pid=""
  local registry_status=0
  local stale_lock=0
  local stale_socket=0

  if [ -e "${x11_lock}" ] || [ -L "${x11_lock}" ]; then
    if [ -L "${x11_lock}" ] || [ ! -f "${x11_lock}" ]; then
      echo "Refusing unsafe X11 lock path: ${x11_lock}" >&2
      return 1
    fi
    IFS= read -r lock_pid < "${x11_lock}" || true
    lock_pid="${lock_pid//[[:space:]]/}"
    if [[ ! "${lock_pid}" =~ ^[1-9][0-9]*$ ]]; then
      echo "Refusing malformed X11 lock: ${x11_lock}" >&2
      return 1
    fi
    if kill -0 "${lock_pid}" 2>/dev/null || [ -d "/proc/${lock_pid}" ]; then
      echo "Refusing active X11 display ${display_number} (pid ${lock_pid})" >&2
      return 1
    fi
    stale_lock=1
  fi

  if [ -e "${x11_socket}" ] || [ -L "${x11_socket}" ]; then
    if [ -L "${x11_socket}" ] || [ ! -S "${x11_socket}" ]; then
      echo "Refusing unsafe X11 socket path: ${x11_socket}" >&2
      return 1
    fi
    if socket_is_registered; then
      echo "Refusing active X11 socket: ${x11_socket}" >&2
      return 1
    else
      registry_status=$?
      if [ "${registry_status}" -eq 2 ]; then
        echo "Cannot prove X11 socket is stale: ${x11_socket}" >&2
        return 1
      fi
    fi
    stale_socket=1
  fi

  if [ "${stale_socket}" -eq 1 ]; then
    rm -f -- "${x11_socket}"
  fi
  if [ "${stale_lock}" -eq 1 ]; then
    rm -f -- "${x11_lock}"
  fi
}

child_is_running() {
  local child_pid="$1"
  kill -0 "${child_pid}" 2>/dev/null || return 1
  if [ -r "/proc/${child_pid}/stat" ]; then
    # A zombie still answers kill -0 but is not a usable child process.
    [ "$(awk '{ print $3 }' "/proc/${child_pid}/stat")" != "Z" ] || return 1
  fi
}

prepare_display

Xvfb "${display_number}" -screen 0 "${screen_width}x${screen_height}x24" -nolisten tcp -ac &
xvfb_pid=$!

display_ready=0
for _ in $(seq 1 50); do
  if ! child_is_running "${xvfb_pid}"; then
    echo "Xvfb exited before display ${display_number} became ready" >&2
    exit 1
  fi
  if [ -S "${x11_socket}" ]; then
    display_ready=1
    break
  fi
  sleep 0.1
done

if [ "${display_ready}" -ne 1 ]; then
  echo "Timed out waiting for Xvfb display ${display_number}" >&2
  exit 1
fi

x11vnc \
  -display "${display_number}" \
  -rfbport "${vnc_port}" \
  -localhost \
  -forever \
  -shared \
  -nopw \
  -noxdamage \
  -quiet &
vnc_pid=$!

sleep 0.1
if ! child_is_running "${xvfb_pid}"; then
  echo "Xvfb exited during x11vnc startup" >&2
  exit 1
fi
if ! child_is_running "${vnc_pid}"; then
  echo "x11vnc exited during startup" >&2
  exit 1
fi

node src/server.mjs &
server_pid=$!

while true; do
  if ! child_is_running "${server_pid}"; then
    set +e
    wait "${server_pid}"
    server_status=$?
    set -e
    server_pid=""
    exit "${server_status}"
  fi
  if ! child_is_running "${xvfb_pid}"; then
    echo "Xvfb exited unexpectedly" >&2
    exit 1
  fi
  if ! child_is_running "${vnc_pid}"; then
    echo "x11vnc exited unexpectedly" >&2
    exit 1
  fi
  sleep 0.1
done
