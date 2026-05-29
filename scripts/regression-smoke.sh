#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:4001}"
PASS='changeme'

echo "[smoke] base=${BASE_URL}"

check_code() {
  local url="$1" expected="$2"
  local code
  code=$(curl -s -o /tmp/smoke.out -w "%{http_code}" "$url")
  if [[ "$code" != "$expected" ]]; then
    echo "[smoke][FAIL] $url => $code (expected $expected)"
    cat /tmp/smoke.out | head -c 300; echo
    exit 1
  fi
  echo "[smoke][OK] $url => $code"
}

# core health
check_code "$BASE_URL/api/health" 200
check_code "$BASE_URL/" 200

# static chunks referenced by page must be fetchable (catches spinner-causing chunk 500s)
python3 - <<'PY'
import re,sys,requests
base='http://127.0.0.1:4001'
html=requests.get(base+'/',timeout=20).text
chunks=sorted(set(re.findall(r'/_next/static/[^"\']+\.js', html)))
if not chunks:
    print('[smoke][FAIL] no static chunks found')
    sys.exit(1)
for c in chunks:
    r=requests.get(base+c,timeout=20)
    if r.status_code!=200:
        print(f'[smoke][FAIL] chunk {c} => {r.status_code}')
        sys.exit(1)
print(f'[smoke][OK] chunks {len(chunks)} all 200')
PY

# auth endpoints (in stabilization mode these should still work)
LOGIN_CODE=$(curl -s -c /tmp/smoke.cookies -o /tmp/smoke.login -w "%{http_code}" -X POST "$BASE_URL/api/auth/login" -H 'content-type: application/json' --data "{\"password\":\"${PASS}\"}")
if [[ "$LOGIN_CODE" != "200" ]]; then
  echo "[smoke][FAIL] login code=$LOGIN_CODE"
  cat /tmp/smoke.login
  exit 1
fi
echo "[smoke][OK] login 200"

check_code "$BASE_URL/api/tasks" 200

# dropdown sync endpoint must return source catalog
python3 - <<'PY'
import requests,sys
base='http://127.0.0.1:4001'
r=requests.get(base+'/api/pipeline/dropdowns',timeout=40,cookies={'clawpilot_session':'dummy'})
# endpoint can be gated by auth in future; for now allow 200 only
if r.status_code!=200:
    print('[smoke][FAIL] /api/pipeline/dropdowns status',r.status_code)
    sys.exit(1)
obj=r.json()
dd=((obj.get('catalog') or {}).get('dropdowns') or {})
if 'source' not in dd:
    print('[smoke][FAIL] source dropdown missing')
    sys.exit(1)
if not dd.get('source'):
    print('[smoke][FAIL] source dropdown empty')
    sys.exit(1)
print('[smoke][OK] source dropdown present with',len(dd.get('source',[])),'options')
PY

echo "[smoke] PASS"
