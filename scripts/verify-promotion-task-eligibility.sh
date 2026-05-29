#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
TASKS_FILE="$DEV_REPO/data-dev/tasks.json"

python3 - <<'PY' "$TASKS_FILE"
import json, sys, re

path = sys.argv[1]
with open(path, 'r') as f:
    tasks = json.load(f)

if not isinstance(tasks, list):
    print('PROMOTION_BLOCKED_DEV_ONLY_TASKS')
    print(' - tasks.json format invalid')
    raise SystemExit(1)

BLOCK_TAGS = {'dev-only', 'test-card', 'validation-only'}
BLOCK_CLASSES = {'dev-only', 'test-card', 'validation-only'}
HEURISTIC_RE = re.compile(r'\b(smoke|validation|test|stbiso|st2)\b|directive mapping verification', re.I)

def is_promotable_state(t):
    if t.get('archived'):
        return False
    if t.get('deletedAt'):
        return False
    return True

def normset(v):
    if isinstance(v, list):
        return {str(x).strip().lower() for x in v if str(x).strip()}
    if isinstance(v, str) and v.strip():
        return {v.strip().lower()}
    return set()

def is_promotable_false(v):
    if v is False:
        return True
    if isinstance(v, str) and v.strip().lower() in {'false', '0', 'no'}:
        return True
    return False

offenders = []
for t in tasks:
    if not is_promotable_state(t):
        continue

    tid = str(t.get('id', ''))
    title = str(t.get('title', ''))
    desc = str(t.get('desc', ''))
    status = str(t.get('status', ''))
    tags = normset(t.get('tags'))

    reasons = []

    # Explicit metadata/tags/classification (primary)
    blocked_tags = sorted(tags.intersection(BLOCK_TAGS))
    if blocked_tags:
        reasons.append(f"tags={','.join(blocked_tags)}")

    cls = str(t.get('classification', '')).strip().lower()
    if cls in BLOCK_CLASSES:
        reasons.append(f"classification={cls}")

    entity = str(t.get('entityType', '')).strip().lower()
    if entity in BLOCK_CLASSES:
        reasons.append(f"entityType={entity}")

    if is_promotable_false(t.get('promotable')):
        reasons.append('promotable=false')

    # Heuristic fallback (legacy)
    text_blob = ' '.join([title, desc, ' '.join(sorted(tags))]).strip()
    if text_blob and HEURISTIC_RE.search(text_blob):
        reasons.append('heuristic=dev-test-validation-pattern')

    if reasons:
        offenders.append((tid, status, title[:140], reasons))

if offenders:
    print('PROMOTION_BLOCKED_DEV_ONLY_TASKS')
    for tid, status, title, reasons in offenders[:500]:
        print(f" - {tid} [{status}] {title} :: {', '.join(reasons)}")
    raise SystemExit(1)

print('PROMOTION_TASK_ELIGIBILITY_OK')
PY
