# Task Creation Policy (Canonical) — Dev Lane 4002

## Purpose
Make task creation intentional, explicit, and safe during containment.

## Policy status
- **Default posture:** deny-by-default for automation paths.
- **Current phase:** containment (no newly enabled automatic creation in this slice).

## Allowed task creation paths

### 1) Manual user-created task (allowed)
Task creation is allowed when:
- `POST /api/tasks` includes explicit actor + source metadata:
  - body field: `_actor` (required)
  - body field: `_createSource` (required; header fallback supported)
  - header fallback: `x-claw-task-create-source`
- source is one of:
  - `manual-ui`
  - `manual-api`
  - `manual-operator`
  - `manual-user`

### 2) Explicitly approved automation path (defined but disabled by default)
Automation path is defined as:
- source: `automation-clawpilot-approved`
- plus env gate: `ENABLE_AUTOMATION_TASK_CREATE=true`

If env gate is not enabled, the path remains blocked.

## Blocked/default-denied paths
- Missing actor metadata (`_actor` absent)
- Missing source metadata (`_createSource`/header absent)
- Unknown/unapproved source values
- Any agent-originated task create attempt (agents propose; operators create)
- Automation attempts while automation gate is disabled
- Suggestion-to-task conversion (`PATCH /api/tasks` with `_suggestionAction.action="task"`) unless explicitly enabled with `ENABLE_SUGGESTION_TASK_CREATE=true`

## Required creation metadata
Every `POST /api/tasks` request must include:
- `_actor` (body, required)
- `_createSource` (body, required; `x-claw-task-create-source` header fallback accepted)

This metadata is required for policy enforcement and operator auditability.

## Creation audit + anomaly guard
- Every successful create appends an entry to `data-dev/task-creation-audit.jsonl` with:
  - timestamp
  - source
  - actor
  - task id/title
- If more than 3 tasks are created within 1 minute, system logs:
  - `anomaly: true` on the creation event
  - an additional anomaly warning entry

## Operator-facing blocked behavior
When blocked, API returns:
- `blocked: true`
- `policyCode` (machine-readable reason)
- `operatorMessage` (human-readable guidance)
- source allow-list context where applicable

## Non-goals for this slice
- Do not enable new automatic task creation.
- Do not change assignment/chat/execution behavior.
