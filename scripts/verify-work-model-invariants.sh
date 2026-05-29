#!/usr/bin/env bash
set -euo pipefail

DEV_REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
TASKS_FILE="$DEV_REPO/data-dev/tasks.json"
ASSIGNMENTS_FILE="$DEV_REPO/data-dev/agents/assignments.json"

python3 - <<'PY' "$TASKS_FILE" "$ASSIGNMENTS_FILE"
import json, sys, os

tasks_path = sys.argv[1]
assignments_path = sys.argv[2]

with open(tasks_path, 'r') as f:
    tasks = json.load(f)
if not isinstance(tasks, list):
    print('ERROR: tasks.json is not an array')
    raise SystemExit(1)

def next_action_from_task(task):
    ex = task.get('execution') or {}
    lr = ex.get('lastResult') or {}
    val = lr.get('nextAction')
    if isinstance(val, str) and val.strip():
        return val.strip()
    note = str(ex.get('latestExecutionNote') or '')
    for line in [x.strip() for x in note.splitlines() if x.strip()]:
        low = line.lower()
        if low.startswith('next action:'):
            return line.split(':',1)[1].strip() or None
        if low.startswith('next:'):
            return line.split(':',1)[1].strip() or None
    return None

mismatches = []
for t in tasks:
    tid = str(t.get('id',''))
    wi = t.get('workItem') or {}
    status = t.get('status')
    assigned = t.get('assignedAgent')
    next_action = next_action_from_task(t)

    if wi.get('status') != status:
        mismatches.append(f"task:{tid}:workItem.status!=status ({wi.get('status')} vs {status})")
    if (wi.get('assignedAgent') or None) != (assigned or None):
        mismatches.append(f"task:{tid}:workItem.assignedAgent!=assignedAgent ({wi.get('assignedAgent')} vs {assigned})")
    if (wi.get('nextAction') or None) != (next_action or None):
        mismatches.append(f"task:{tid}:workItem.nextAction!=derivedNextAction ({wi.get('nextAction')} vs {next_action})")

if os.path.exists(assignments_path):
    with open(assignments_path, 'r') as f:
        assignments = json.load(f)
    if isinstance(assignments, list):
        by_task = {str(a.get('taskId')): a.get('agentId') for a in assignments if isinstance(a, dict)}
        for t in tasks:
            tid = str(t.get('id',''))
            assigned = t.get('assignedAgent')
            a = by_task.get(tid)
            if assigned and a != assigned:
                mismatches.append(f"task:{tid}:assignments.json!=tasks.assignedAgent ({a} vs {assigned})")

if mismatches:
    print('WORK_MODEL_INVARIANT_FAIL')
    for m in mismatches[:200]:
        print(' -', m)
    raise SystemExit(1)

print('WORK_MODEL_INVARIANT_OK')
PY
