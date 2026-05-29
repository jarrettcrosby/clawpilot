#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-dev-verify}"
DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
TASKS_FILE="$DEV_REPO/data-dev/tasks.json"

python3 - <<'PY' "$TASKS_FILE" "$MODE"
import json, sys

path = sys.argv[1]
mode = sys.argv[2]

with open(path, 'r') as f:
    tasks = json.load(f)
if not isinstance(tasks, list):
    print('BOARD_HYGIENE_FAIL: tasks.json format invalid')
    raise SystemExit(1)

PLACEHOLDERS = {'x','xx','xxx','test','tmp','tbd','todo','na','n/a','asdf'}

def is_placeholder(v):
    s = str(v or '').strip().lower()
    if not s:
        return False
    if s in PLACEHOLDERS:
        return True
    return all(c == 'x' for c in s)

def meaningful_title(v):
    s = str(v or '').strip()
    if not s or is_placeholder(s):
        return False
    import re
    return len(re.sub(r'[^a-zA-Z0-9]', '', s)) >= 3

def acceptance_count(t):
    ac = t.get('acceptanceCriteria')
    if isinstance(ac, list):
        return len([x for x in ac if str(x).strip()])
    if isinstance(ac, str) and ac.strip():
        return len([x.strip() for x in ac.replace(';','\n').splitlines() if x.strip()])
    ck = t.get('checklist') if isinstance(t.get('checklist'), list) else []
    return len([x for x in ck if str((x or {}).get('text','')).strip()])

def hard_block(t):
    title = str(t.get('title','')).strip()
    desc = str(t.get('desc','')).strip()
    bad_title = (not title) or is_placeholder(title) or (not meaningful_title(title))
    bad_desc = (not desc) or is_placeholder(desc)
    has_acceptance = acceptance_count(t) > 0
    return bad_title or (bad_desc and not has_acceptance)

def is_active(t):
    if t.get('archived') or t.get('deletedAt'):
        return False
    # Primary board hygiene gate applies to active intake lists.
    return str(t.get('status')) in {'backlog','todo'}

violations=[]
for t in tasks:
    if not is_active(t):
        continue
    if hard_block(t):
        violations.append((str(t.get('id')), str(t.get('status')), str(t.get('title'))[:120]))

if violations:
    if mode == 'promotion':
        print('PROMOTION_BLOCKED_BOARD_HYGIENE')
    else:
        print('BOARD_HYGIENE_FAIL')
    for vid, st, title in violations[:200]:
        print(f' - {vid} [{st}] {title}')
    raise SystemExit(1)

print('BOARD_HYGIENE_OK')
PY
