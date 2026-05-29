#!/usr/bin/env bash
set -euo pipefail
BASE=${BASE:-http://localhost:4002}

echo "1) POST invalid milestone-like task -> expect TASK_INVALID_QUALITY block"
HTTP_CODE=$(curl -sS -o /tmp/_smoke_post_invalid.json -w "%{http_code}" -X POST "$BASE/api/tasks" -H 'Content-Type: application/json' -d '{"title":"SC Smoke Milestone","directive":"","tags":["milestone"],"_actor":"SmokeTester","_createSource":"manual-api"}')
RESP=$(cat /tmp/_smoke_post_invalid.json)
if [ "$HTTP_CODE" != "400" ]; then
  echo "FAIL: expected HTTP 400 for invalid quality, got $HTTP_CODE"
  echo "$RESP" | jq '.'
  exit 2
fi
echo "$RESP" | jq '{policyCode: .policyCode, error: .error}'
echo "$RESP" | jq -e '.policyCode == "TASK_INVALID_QUALITY"' >/dev/null || (echo "FAIL: expected TASK_INVALID_QUALITY"; exit 2)

echo "2) POST valid task -> expect 201"
HTTP_CODE=$(curl -sS -o /tmp/_smoke_post_valid.json -w "%{http_code}" -X POST "$BASE/api/tasks" -H 'Content-Type: application/json' -d '{"title":"SC Smoke Valid Task","desc":"Meaningful description for smoke regression.","acceptanceCriteria":["AC1","AC2"],"_actor":"SmokeTester","_createSource":"manual-api"}')
RESP=$(cat /tmp/_smoke_post_valid.json)
if [ "$HTTP_CODE" != "201" ]; then
  echo "FAIL: POST valid task returned HTTP $HTTP_CODE"
  echo "$RESP" | jq '.'
  exit 3
fi
echo "$RESP" | jq '{id: .id, title: .title, tags: .tags}'
TASK_ID=$(echo "$RESP" | jq -r '.id')

echo "3) GET /api/tasks?includeArchived=true -> should include task id $TASK_ID"
FILTERED=$(curl -sS "$BASE/api/tasks?includeArchived=true")
echo "$FILTERED" | jq -e --arg id "$TASK_ID" 'map(select((.id|tostring)==$id)) | length > 0' >/dev/null || (echo "FAIL: created task missing"; exit 4)

echo "4) GET /api/checklist/$TASK_ID -> returns checklist array (may be empty)"
C1=$(curl -sS "$BASE/api/checklist/$TASK_ID")
echo "$C1" | jq '.'

# For checklist toggle test, use an existing task with known checklist (task id 1)
EXISTING=1
echo "5) Toggle first checklist item on task $EXISTING via PATCH /api/tasks _checklistToggle"
CL=$(curl -sS "$BASE/api/checklist/$EXISTING" | jq -r '.checklist[0].id')
if [ "$CL" = "null" -o -z "$CL" ]; then echo "SKIP: no checklist items on task $EXISTING"; else
  echo " - toggling $CL"
  curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' -d "{\"id\": \"$EXISTING\", \"_checklistToggle\": \"$CL\", \"_actor\": \"SmokeTester\"}" > /tmp/_toggle.json
  cat /tmp/_toggle.json | jq '{id: .id, checklist: .checklist}'
  # confirm persisted
  curl -sS "$BASE/api/checklist/$EXISTING" | jq '.checklist[0]'
fi

echo "6) PATCH remediation: update owner/workstream/outcome/acceptanceCriteria for $TASK_ID"
curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' -d "{\"id\": \"$TASK_ID\", \"assignedAgent\": \"projects-agent\", \"workstream\": \"platform\", \"outcomeStatement\": \"Smoke test outcome\", \"acceptanceCriteria\": [\"AC1\",\"AC2\"] , \"_actor\": \"SmokeTester\" }" > /tmp/_rem.json
cat /tmp/_rem.json | jq '{id: .id, assignedAgent: .assignedAgent, workstream: .workstream, outcomeStatement: .outcomeStatement, governance: .governance}'

echo "7) Archive smoke-created task $TASK_ID to keep promotion state clean"
curl -sS -X PATCH "$BASE/api/tasks" -H 'Content-Type: application/json' -d "{\"id\": \"$TASK_ID\", \"_archive\": true, \"_actor\": \"SmokeTester\" }" > /tmp/_smoke_archive.json
cat /tmp/_smoke_archive.json | jq '{id: .id, archived: .archived, archivedAt: .archivedAt}'

echo "SMOKE TESTS COMPLETED"