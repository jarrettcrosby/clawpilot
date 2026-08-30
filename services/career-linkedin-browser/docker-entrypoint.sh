#!/usr/bin/env bash
set -euo pipefail

display_number="${DISPLAY:-:99}"
screen_width="${SCREEN_WIDTH:-1280}"
screen_height="${SCREEN_HEIGHT:-800}"
vnc_port="${VNC_PORT:-5900}"

Xvfb "${display_number}" -screen 0 "${screen_width}x${screen_height}x24" -nolisten tcp -ac &
xvfb_pid=$!

for _ in $(seq 1 50); do
  if [ -S "/tmp/.X11-unix/X${display_number#:}" ]; then
    break
  fi
  sleep 0.1
done

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

cleanup() {
  kill "${vnc_pid}" "${xvfb_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node src/server.mjs
