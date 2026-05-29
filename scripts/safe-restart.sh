#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$APP_DIR/app_src"
PORT=4001
LOG_FILE="/tmp/clawd-app.log"

port_is_free() {
python3 - <<'PY'
import socket,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
  s.bind(('0.0.0.0',4001)); s.close(); sys.exit(0)
except OSError:
  sys.exit(1)
PY
}

stop_all() {
  pkill -9 -f "next start --port ${PORT}" 2>/dev/null || true
  pkill -9 -f "npm start -- --port ${PORT}" 2>/dev/null || true
  pkill -9 -f "next-server" 2>/dev/null || true
  sleep 1
}

wait_port_free() {
  for _ in $(seq 1 30); do
    if port_is_free; then return 0; fi
    sleep 1
  done
  return 1
}

echo "[safe-restart] hard-stop old process..."
stop_all
if ! wait_port_free; then
  echo "[safe-restart] port ${PORT} still busy after hard-stop"
  exit 1
fi

echo "[safe-restart] clean build..."
cd "$SRC_DIR"
rm -rf .next
npm run build

echo "[safe-restart] start new process..."
nohup npm start -- --port "$PORT" --hostname 0.0.0.0 > "$LOG_FILE" 2>&1 &

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "[safe-restart] health check failed"
  tail -n 120 "$LOG_FILE" || true
  exit 1
fi

# Critical regression guard: all home page chunks must load 200
python3 - <<'PY'
import re,sys,requests
base='http://127.0.0.1:4001'
html=requests.get(base+'/',timeout=20).text
chunks=sorted(set(re.findall(r'/_next/static/[^"\']+\.js', html)))
if not chunks:
  print('[safe-restart] no chunks found'); sys.exit(1)
for c in chunks:
  r=requests.get(base+c,timeout=20)
  if r.status_code!=200:
    print('[safe-restart] bad chunk',c,r.status_code); sys.exit(1)
print('[safe-restart] chunks ok',len(chunks))
PY

echo "[safe-restart] healthy + chunks verified"
