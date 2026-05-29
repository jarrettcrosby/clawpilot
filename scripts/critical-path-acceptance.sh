#!/usr/bin/env bash
set -euo pipefail

BASE=${BASE:-http://127.0.0.1:4002}
ACTOR=${ACTOR:-SmokeTester}
SOURCE=${SOURCE:-manual-api}
AGENT_ID=${AGENT_ID:-projects-agent}

fail() {
  echo "FAIL: $1"
  exit 2
}

echo "1) Load baseline tasks and select fallback task"
curl -sS "$BASE/api/tasks?includeArchived=true" > /tmp/_cp_baseline_tasks.json
SEED_TASK_ID=$(jq -r 'map(select((.archived // false) == false)) | sort_by(.updatedAt) | reverse | .[0].id // empty' /tmp/_cp_baseline_tasks.json)
[ -n "$SEED_TASK_ID" ] || fail "no seed task available"
echo "seedTask=$SEED_TASK_ID"

echo "2) Create valid task (create or select contract)"
HTTP=$(curl -sS -o /tmp/_cp_create.json -w "%{http_code}" -X POST "$BASE/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"Critical Path Acceptance Task\",\"desc\":\"Canonical regression task for task-linked execution/writeback.\",\"acceptanceCriteria\":[\"agent reply captured\",\"writeback recorded\"],\"_actor\":\"$ACTOR\",\"_createSource\":\"$SOURCE\"}")
if [ "$HTTP" != "201" ]; then
  cat /tmp/_cp_create.json | jq '.'
  fail "valid task create failed http=$HTTP"
fi
CREATED_TASK_ID=$(jq -r '.id // empty' /tmp/_cp_create.json)
[ -n "$CREATED_TASK_ID" ] || fail "create response missing id"

echo "3) Determine target task (created if persisted, else seed)"
curl -sS "$BASE/api/tasks?includeArchived=true" > /tmp/_cp_after_create_tasks.json
if jq -e --arg id "$CREATED_TASK_ID" 'map(select((.id|tostring)==$id)) | length == 1' /tmp/_cp_after_create_tasks.json >/dev/null; then
  TARGET_TASK_ID="$CREATED_TASK_ID"
  TARGET_MODE="created"
else
  TARGET_TASK_ID="$SEED_TASK_ID"
  TARGET_MODE="seed-fallback"
fi
echo "targetTask=$TARGET_TASK_ID mode=$TARGET_MODE"

echo "4) Assign agent + set actionable status on target task"
HTTP=$(curl -sS -o /tmp/_cp_assign.json -w "%{http_code}" -X PATCH "$BASE/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$TARGET_TASK_ID\",\"assignedAgent\":\"$AGENT_ID\",\"status\":\"todo\",\"_actor\":\"$ACTOR\"}")
[ "$HTTP" = "200" ] || { cat /tmp/_cp_assign.json | jq '.'; fail "assign http=$HTTP"; }
ASSIGNED=$(jq -r '.assignedAgent // .assignee // empty' /tmp/_cp_assign.json)
[ -n "$ASSIGNED" ] || fail "assigned agent did not persist"

echo "5) Open/send task-linked chat and verify reply"
HTTP=$(curl -sS -o /tmp/_cp_chat.json -w "%{http_code}" -X POST "$BASE/api/agents/threads" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"taskId\":\"$TARGET_TASK_ID\",\"text\":\"Provide a short execution summary using Changed/Remaining/Waiting on and ensure Remaining includes the next actionable step.\"}")
[ "$HTTP" = "200" ] || { cat /tmp/_cp_chat.json | jq '.'; fail "chat post http=$HTTP"; }
AGENT_REPLY=$(jq -r '.agentMessage.text // ""' /tmp/_cp_chat.json)
[ -n "$AGENT_REPLY" ] || fail "empty agent reply"
echo "$AGENT_REPLY" | grep -Eqi '^Changed:\s*.+' || fail "agent reply missing Changed section"
echo "$AGENT_REPLY" | grep -Eqi '^Remaining:\s*.+' || fail "agent reply missing Remaining section"
echo "$AGENT_REPLY" | grep -Eqi '^Waiting on:\s*.+' || fail "agent reply missing Waiting on section"

echo "6) Verify writeback lands on task + executionStatus updated"
WRITEBACK_OK=0
for _ in {1..20}; do
  curl -sS "$BASE/api/tasks?includeArchived=true" > /tmp/_cp_tasks_now.json
  if jq -e --arg id "$TARGET_TASK_ID" 'map(select((.id|tostring)==$id)) | length == 1' /tmp/_cp_tasks_now.json >/dev/null; then
    jq -e --arg id "$TARGET_TASK_ID" 'map(select((.id|tostring)==$id))[0].execution.executionStatus == "completed"' /tmp/_cp_tasks_now.json >/dev/null && \
    jq -e --arg id "$TARGET_TASK_ID" 'map(select((.id|tostring)==$id))[0].comments | map(select((type=="object") and (((.text // "") | test("Agent:")) and ((.text // "") | test("Status: completed"))))) | length > 0' /tmp/_cp_tasks_now.json >/dev/null && WRITEBACK_OK=1 && break
  fi
  sleep 1
done
[ "$WRITEBACK_OK" = "1" ] || fail "writeback or executionStatus verification failed"

echo "7) Dashboard acceptance check"
ROOT_HTTP=$(curl -sS -o /tmp/_cp_root.html -w "%{http_code}" "$BASE/")
[ "$ROOT_HTTP" = "200" ] || fail "dashboard route http=$ROOT_HTTP"
# action panel sanity: at least one active task exists and payload parses
jq -e 'map(select(.status == "backlog" or .status == "todo" or .status == "in-progress" or .status == "review")) | length >= 1' /tmp/_cp_tasks_now.json >/dev/null || fail "no active tasks in dashboard data"
# dashboard integrity sanity: no null/non-object task records in list payload
jq -e 'all(.[]; type=="object" and (.id != null) and (.status != null))' /tmp/_cp_tasks_now.json >/dev/null || fail "dashboard task payload contains broken records"

if [[ "$TARGET_MODE" == "created" ]]; then
  echo "8) Archive created acceptance task to keep board clean"
  curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"id\":\"$TARGET_TASK_ID\",\"_archive\":true,\"_actor\":\"$ACTOR\"}" > /tmp/_cp_archive.json
  jq '{id: .id, archived: .archived}' /tmp/_cp_archive.json
fi

echo "CRITICAL_PATH_ACCEPTANCE_OK"