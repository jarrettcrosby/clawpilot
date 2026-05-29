# ClawPilot System Overview

## Purpose

ClawPilot is the operator web surface for coordinating work across projects, agents, docs, pipeline, runtime checks, and promotion readiness.

## Application Layout

- `app_src/app/` - Next.js App Router pages and API routes.
- `app_src/components/` - Dashboard, Projects, Agents, Pipeline, Docs, Governance, and Versions UI.
- `app_src/lib/` - task models, work-item derivation, routing, file locking, auth, pipeline helpers, and execution writeback.
- `scripts/` - dev/stable runtime control, verification, regression, promotion, watchdog, and recovery scripts.
- `docs/` - architecture, operation, governance, review, and incident documentation.
- `data/` - stable/prod local runtime data.
- `data-dev/` - dev lane local runtime data.

## Runtime Surfaces

- Dashboard: operator priorities, readiness, runtime status, and task creation telemetry.
- Projects: kanban board, task drawer, stale-work handling, archive/deleted views.
- Agents: task-linked chat and product-agent handoff.
- Pipeline: normalized opportunity board/list with manual sync controls.
- Docs: local document viewer.
- Versions: release/version visibility.

## Data Model

The local app is file-backed by default, with Railway Postgres now established as the durable target for app-owned state. Google Sheets remains the operator-editable source for the pipeline table.

Important local files include:

- `tasks.json` - canonical task/work-item state.
- `agents/assignments.json` - projection of task assignment state.
- `agents/threads.json` - task-linked agent conversation state.
- `pipeline/normalized/current.json` - normalized pipeline snapshot.
- `logs/*.jsonl` - runtime and pipeline event logs.

These files are runtime state, not portable application source. New cloud deployment work should move app-owned state to Railway Postgres behind repository boundaries, while preserving the Sheets sync contract for pipeline data. See `docs/architecture/data-ownership-and-postgres-plan.md`.

## Agent Routing

User-visible product agents:

- `projects`
- `pipeline`
- `docs`
- `calendar`
- `clawpilot`

Execution/internal identities should not leak into user-facing selectors. See `docs/architecture/AGENT_ROUTING_MODEL.md`.

## Verification Model

Local confidence comes from:

- lint and production build
- thread-store tests
- dev runtime verification on `4002`
- full regression gate
- browser smoke for meaningful UI changes

CI confidence is intentionally narrower until runtime data is externalized:

- install
- lint
- build
- thread-store tests
- predeploy config/build artifact verification
