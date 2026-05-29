# Overnight ClawPilot App Review — 2026-03-22 (Dev Lane 4002)

Status: in progress
Scope: 4002/dev lane only (`/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`)

## Executive Summary
This review is active and evidence-backed in the 4002 lane. Current verification shows:
- UI acceptance passes in dev (`./scripts/ui-acceptance.sh`).
- Full regression passes (`./scripts/regression-all.sh`, `./scripts/dev-verify.sh`).
- The app has strong verification coverage and governance gates, but there is architecture-doc drift and test-path residue risk that should be tightened.

Evidence references:
- `scripts/ui-acceptance.sh`
- `scripts/regression-all.sh`
- `scripts/dev-verify.sh`
- `docs/reviews/overnight-evidence-index-2026-03-22.md`

## Intended Vision (reconstructed from docs + code)
### Product/operating model intent
The intended model is a CTO-style orchestration app where work is planned and executed in dev first, then promoted safely.

Sources reviewed:
- `docs/architecture/system-operating-model.md`
- `docs/operations/development-contract.md`
- `docs/operations/promotion.md`

Key intent extracted:
- Dev lane on 4002; stable on 4001.
- Checklist-first execution as core unit.
- Governance and promotion contracts are first-class.
- Safe rollout controls and freeze capability are built into scripts and workflow.

### Agent model intent
The intended product-to-execution routing is product-agent centric (`projects/pipeline/docs/calendar`) with ClawPilot orchestration.

Sources reviewed:
- `docs/architecture/AGENT_ROUTING_MODEL.md`
- `app_src/lib/agents/routing.ts`
- `app_src/app/api/agents/threads/route.ts`

Observed intent in code:
- ClawPilot orchestrates thread flow and can delegate.
- Product agents map to execution agents for real runs.
- Thread writeback stores execution summary into task records.

## Current Build Deep Review
### API and governance surface
Major module coverage exists and is broad:
- Tasks/governance/runtime/promotion/threads/execution routes present.

Sources reviewed:
- `app_src/app/api/tasks/route.ts`
- `app_src/app/api/agents/threads/route.ts`
- `app_src/app/api/execution-*`
- `app_src/app/api/promotion-*`
- `app_src/app/api/runtime/route.ts`

Findings:
1. **Strong containment posture in task creation**
   - Task creation enforces actor/source metadata.
   - Manual source allowlist and automation gate are explicitly coded.
   - Audit and anomaly logging are implemented.
   - Source: `app_src/app/api/tasks/route.ts`, `docs/governance/TASK_CREATION_POLICY.md`.

2. **Routing doc/code drift exists**
   - Architecture doc says `clawpilot -> clawpilot-exec`.
   - Current code maps `clawpilot -> main`.
   - Source mismatch: `docs/architecture/AGENT_ROUTING_MODEL.md` vs `app_src/lib/agents/routing.ts`.

3. **Thread orchestration path has legacy fallback messaging in file**
   - `buildClawPilotResponse` still includes generic fallback language.
   - Source: `app_src/app/api/agents/threads/route.ts`.

4. **Projects UI contains stale-task and auto-pickup surfaces**
   - Board includes stale task indicators and auto-pickup controls.
   - Source: `app_src/components/projects/KanbanBoard.tsx`, `app_src/lib/staleTasks.ts`, `app_src/lib/taskState.ts`.

## UI Acceptance Testing Results
### Passed
1. `./scripts/ui-acceptance.sh`
   - Playwright suite: 1 passed.
2. `./scripts/regression-all.sh`
   - Includes UI acceptance call; reports pass.

### Failed
- None observed in runs executed this checkpoint.

### Needs follow-up
1. Validate expanded UI journey breadth beyond the current test count (1 spec in `ui-acceptance`).
2. Confirm docs/pipeline/projects/calendaring deeper interaction coverage in UI tests.

Evidence:
- Command outputs logged in `docs/reviews/overnight-evidence-index-2026-03-22.md`.

## Regression Results
Commands run and outcomes:
1. `./scripts/regression-all.sh`
   - Output includes: `REGRESSION_ALL_OK`
   - Includes health, contract, work-model, queue selftests, runtime route checks.
2. `./scripts/dev-verify.sh`
   - Output includes: `VERIFY_OK`
3. `./scripts/ui-acceptance.sh`
   - Output includes Playwright pass (1/1).

Key route checks observed in regression output:
- `GET /api/health` (4001/4002) -> 200
- `GET /api/runtime` (4001/4002) -> 200
- `GET /api/promotion-report` (4002) -> 200

Evidence:
- `docs/reviews/overnight-evidence-index-2026-03-22.md`

## Dev-only Test Artifact Cleanup Performed
Previously completed in this session (dev-only):
- Target removed: cards titled `SC Smoke Valid Task` from `data-dev/tasks.json`.

Exact cleanup record:
- before: 64
- removed: 10
- after: 54
- removed IDs:
  - 1773977856401
  - 1773977929601
  - 1773978327376
  - 1774053621713
  - 1774059976868
  - 1774060098035
  - 1774063428956
  - 1774063757452
  - 1774064148087
  - 1774064647306
- backup created:
  - `data-dev/backups/tasks-before-smoke-cleanup-20260322-020106.json`
- kept:
  - non-smoke cards and existing business/real cards.

## Gap Analysis (Vision vs Build)
1. **Doc/code drift**: routing doc outdated vs live routing code.
2. **Test depth gap**: UI acceptance currently passes, but breadth appears narrow from command output.
3. **Smoke artifact recurrence risk**: test card leakage happened; cleanup performed, but prevention should be automated.

## Recommendations
### Fix now
1. Update `docs/architecture/AGENT_ROUTING_MODEL.md` to match `app_src/lib/agents/routing.ts`.
2. Add explicit smoke-tag/namespace and auto-archive cleanup in smoke scripts.
3. Expand UI acceptance to include projects/docs/pipeline major journeys, not only governance-flow scenario.

### Next 7 days
1. Add a post-regression artifact scrubber for known test titles/tags in `data-dev`.
2. Add route-level contract tests for agent thread behavior and writeback payload integrity.
3. Produce a coverage matrix mapping modules -> automated tests -> owner.

### Longer-term dev ideas
1. Dedicated dev seed/fixture namespace to isolate synthetic cards from operator-visible boards.
2. Scenario pack runner for end-to-end workflows (projects->agent thread->execution->promotion readiness).
3. Structured observability page for test and runtime health trends over time.

## 7-day Prioritized Action Plan (draft)
Day 1:
- Align routing architecture doc to code.
- Add smoke-tag convention and cleanup guard.

Day 2-3:
- Expand UI acceptance tests across major modules.
- Add explicit pass/fail matrix outputs per scenario.

Day 4-5:
- Add regression post-check for synthetic artifact leakage.
- Add thread writeback integrity tests.

Day 6:
- Produce module test coverage dashboard doc.

Day 7:
- Run full regression + acceptance + cleanup drill and publish signoff report.

## Open Questions
1. Should smoke-created cards be auto-archived immediately or routed to a hidden/testing board?
2. Should `SC Smoke Valid Task` title remain canonical for smoke tests, or move to UUID-tagged synthetic naming?
3. Should regression hard-fail on any synthetic artifact that remains unarchived in dev tasks?
