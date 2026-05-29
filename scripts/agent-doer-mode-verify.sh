#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:4002}"
ACTOR="${ACTOR:-DoerModeVerifier}"
AGENT_ID="${AGENT_ID:-projects-agent}"
SOURCE="manual-api"

TMP_DIR="/tmp/agent-doer-mode-verify"
mkdir -p "$TMP_DIR"

create_task() {
  local title="$1"
  local desc="$2"
  local status="$3"
  local out="$4"

  local payload
  payload=$(python3 - <<'PY' "$title" "$desc" "$status" "$ACTOR" "$SOURCE"
import json,sys
print(json.dumps({
  "title": sys.argv[1],
  "desc": sys.argv[2],
  "status": sys.argv[3],
  "acceptanceCriteria": ["agent executes next concrete step"],
  "_actor": sys.argv[4],
  "_createSource": sys.argv[5],
}))
PY
)

  local code
  code=$(curl -sS -o "$out" -w "%{http_code}" -X POST "$BASE/api/tasks" -H 'Content-Type: application/json' -d "$payload")
  [[ "$code" == "201" ]] || { cat "$out"; echo "FAIL create task"; exit 1; }
  jq -r '.id' "$out"
}

assign_task() {
  local task_id="$1"
  curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"id\":\"$task_id\",\"assignedAgent\":\"$AGENT_ID\",\"_actor\":\"$ACTOR\"}" >/dev/null
}

post_prompt() {
  local task_id="$1"
  local prompt="$2"
  local out="$3"
  local payload
  payload=$(python3 - <<'PY' "$AGENT_ID" "$task_id" "$prompt"
import json,sys
print(json.dumps({"agentId": sys.argv[1], "taskId": sys.argv[2], "text": sys.argv[3]}))
PY
)
  local code
  code=$(curl -sS -o "$out" -w "%{http_code}" -X POST "$BASE/api/agents/threads" -H 'Content-Type: application/json' -d "$payload")
  [[ "$code" == "200" ]] || { cat "$out"; echo "FAIL post prompt"; exit 1; }
}

check_sections() {
  local text="$1"
  python3 - <<'PY' "$text"
import sys,re
t=sys.argv[1]
required=[r'(?im)^Changed\s*:',r'(?im)^Remaining\s*:',r'(?im)^Waiting on\s*:']
for p in required:
  if not re.search(p,t):
    print('MISSING_SECTION',p)
    raise SystemExit(1)
banned=['summarized context','extracted assumptions','made progress','prepared next step','looked into','reviewed','investigated']
l=t.lower()
for b in banned:
  if b in l:
    print('BANNED_PHRASE',b)
    raise SystemExit(1)
print('SECTIONS_OK')
PY
}

extract_reply() {
  jq -r '.agentMessage.text // ""' "$1"
}

archive_task() {
  local task_id="$1"
  curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' \
    -d "{\"id\":\"$task_id\",\"_archive\":true,\"_actor\":\"$ACTOR\"}" >/dev/null || true
}

run_case() {
  local name="$1"
  local prompt="$2"
  local title="$3"
  local desc="$4"
  local status="$5"

  local create_out="$TMP_DIR/${name}.create.json"
  local thread_out="$TMP_DIR/${name}.thread.json"
  local task_id
  task_id=$(create_task "$title" "$desc" "$status" "$create_out")
  assign_task "$task_id"
  post_prompt "$task_id" "$prompt" "$thread_out"
  local reply
  reply=$(extract_reply "$thread_out")
  check_sections "$reply" >/dev/null

  # Case-specific assertions
  case "$name" in
    direct_execution)
      echo "$reply" | grep -qi "^Changed:" || { echo "FAIL direct_execution missing Changed"; exit 1; }
      ;;
    ambiguous)
      echo "$reply" | grep -Eqi "^Changed:" || { echo "FAIL ambiguous missing Changed"; exit 1; }
      echo "$reply" | grep -Eqi "^Remaining:" || { echo "FAIL ambiguous missing Remaining"; exit 1; }
      ;;
    blocked)
      # strict blocker logic: one specific ask in-context
      echo "$reply" | grep -Eqi "Waiting on: (Missing|Escalation:)" || { echo "FAIL blocked missing specific contextual ask"; exit 1; }
      echo "$reply" | grep -Eqi "provide more details|more input" && { echo "FAIL blocked generic ask"; exit 1; }
      ;;
    stale_task)
      echo "$reply" | grep -Eqi "^Remaining:" || { echo "FAIL stale_task missing Remaining"; exit 1; }
      ;;
  esac

  echo "CASE_OK $name"
  archive_task "$task_id"
}

run_case "direct_execution" "Using only this task context, execute the next concrete step now by drafting the immediate execution plan and report outcome." "Doer mode direct execution" "Task has enough details: create a 2-step execution plan and identify first action." "in-progress"
run_case "ambiguous" "Make progress on this card and ask only what is truly missing." "Doer mode ambiguous" "Goal exists but details are slightly open-ended; choose safest first move." "todo"
run_case "blocked" "Complete database migration and deploy it now." "Doer mode blocked" "No database credentials or migration target environment provided." "todo"
run_case "stale_task" "This card seems stale. Take ownership and move it forward." "Doer mode stale" "No activity in several days; requires operator reactivation." "todo"

# repeated blocker scenario: second ask should escalate instead of repeating generic request
repeat_create="$TMP_DIR/repeat_blocker.create.json"
repeat_thread1="$TMP_DIR/repeat_blocker.first.json"
repeat_thread2="$TMP_DIR/repeat_blocker.second.json"
repeat_task_id=$(create_task "Doer mode repeated blocker" "Needs repository URL before concrete code execution." "todo" "$repeat_create")
assign_task "$repeat_task_id"
post_prompt "$repeat_task_id" "Execute the code fix now." "$repeat_thread1"
post_prompt "$repeat_task_id" "Proceed now if still waiting." "$repeat_thread2"
repeat_reply=$(extract_reply "$repeat_thread2")
check_sections "$repeat_reply" >/dev/null

echo "$repeat_reply" | grep -Eqi "Waiting on: Escalation:" || { echo "FAIL repeated_blocker missing escalation"; exit 1; }
echo "$repeat_reply" | grep -Eqi "provide more details|more input" && { echo "FAIL repeated_blocker generic repetition"; exit 1; }
archive_task "$repeat_task_id"

echo "AGENT_DOER_MODE_VERIFY_OK"
