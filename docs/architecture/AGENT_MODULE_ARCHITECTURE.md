# ClawApp Agent Module Architecture (v1)

Status: Draft for implementation
Owner: ClawApp docs
Last Updated: 2026-03-05

## 1) Purpose
Define how ClawApp runs, tracks, and audits agent work so operators can assign tasks, monitor execution, and safely recover from failures.

## 2) Scope
In scope:
- Agent definitions and capabilities
- Task assignment and execution lifecycle
- Assignment API + status tracking
- Activity/audit logging
- Safety boundaries and escalation behavior

Out of scope (v1):
- Multi-tenant isolation across organizations
- Autonomous long-horizon planning
- Billing/cost optimization automation

## 3) Domain Model
Primary entities:
- **Agent**: identity + capability profile (`id`, `name`, `runtime`, `status`, `skills[]`)
- **Assignment**: unit of work from user/operator (`assignment_id`, `agent_id`, `title`, `inputs`, `priority`, `deadline`, `state`)
- **Run**: execution instance for an assignment (`run_id`, `started_at`, `ended_at`, `result`, `errors[]`)
- **Handoff**: ownership transition event (`from_agent`, `to_agent`, `reason`, `timestamp`)
- **Activity Event**: immutable write log for assignment/run changes

Suggested state machine (`Assignment.state`):
- `queued` -> `accepted` -> `in_progress` -> (`blocked` | `completed` | `failed` | `cancelled`)

## 4) Architecture
### 4.1 API surface
Existing scaffolds:
- `app_src/app/api/agents/route.ts`
- `app_src/app/api/agents/assignments/route.ts`

Recommended endpoints (v1):
- `GET /api/agents` -> list agents + status
- `POST /api/agents/assignments` -> create assignment
- `GET /api/agents/assignments?state=` -> filter assignments
- `PATCH /api/agents/assignments/:id` -> transition state
- `POST /api/agents/assignments/:id/cancel` -> cancel assignment

### 4.2 Data storage
File-backed v1 (consistent with current app approach):
- `data/agents/sessions.json`
- `data/agents/activity.json`
- `data/agents/assignments.json` (new)

Design notes:
- Append-only activity log for all state changes
- Snapshot records for current assignment state
- Deterministic IDs for idempotent retries where possible

### 4.3 UI module
Existing scaffold:
- `app_src/components/agents/AgentsSection.tsx`

Recommended views:
- Agent roster (online/offline/busy)
- Assignment board (queued/in-progress/blocked/completed)
- Run detail panel (inputs, outputs, errors, timestamps)
- Audit panel (event timeline)

## 5) Safety + Control Model
- Human/operator always retains cancel authority
- No destructive downstream action without explicit assignment intent
- Every external integration call logs actor, target, and result
- Blocked state required when missing permissions/dependencies

## 6) Observability
Minimum telemetry fields:
- `assignment_id`, `run_id`, `agent_id`, `state`, `latency_ms`, `error_code`, `updated_at`

Operational dashboards (v1):
- Active runs count
- Mean time to completion
- Blocked assignment age
- Failure rate by agent/runtime

## 7) Acceptance Criteria
1. Operator can create, view, and cancel assignments via API and UI.
2. Assignment state transitions are validated (no illegal jumps).
3. Every state change generates an audit event in `activity.json`.
4. Failed runs preserve error details and remain queryable.
5. AgentsSection renders meaningful non-empty, loading, and error states.
6. Regression tests cover state machine + assignment CRUD + cancellation.

## 8) Rollback Notes
If v1 deployment regresses execution tracking:
1. Disable assignment creation route (`POST /api/agents/assignments`) behind feature flag.
2. Revert UI to read-only AgentsSection view.
3. Restore previous `data/agents/*.json` snapshots from backup.
4. Replay append-only activity events to reconstruct latest stable state.
5. Announce temporary degraded mode: "agent assignment read-only".

## 9) Future Enhancements
- Policy engine for assignment routing
- Retry policies by failure class
- SLA breach alerts
- Cost-per-run reporting
