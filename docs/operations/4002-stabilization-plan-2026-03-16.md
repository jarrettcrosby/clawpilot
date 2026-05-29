# Dev Lane 4002 Stabilization Plan

## Scope

This plan applies only to dev lane 4002 and only to the active execution, task, agents, and project UI surfaces under `app_src/`. Stable deployment flows, promotion mechanics, and production-only operational paths are out of scope.

Primary stabilization targets:

- Task ownership and execution-agent contract consistency across API routes and UI consumers.
- Agent thread routing and execution-result writeback safety.
- React hook and immutability compliance in key UI components that currently block lint or risk unstable render behavior.
- Targeted reduction of `no-explicit-any` and `require()` usage in touched TypeScript files, with behavior preserved.

## Architecture Slices

### Slice A: Task Contract Hardening

Goal: make `assignedAgent` the stable ownership field across task creation, normalization, updates, and UI reads.

Changes:

- Normalize legacy ownership values at the API boundary.
- Replace opportunistic `any`-driven payload shaping with explicit request and record types.
- Remove `require()`-style imports from task and file-lock modules.

Why first:

- This is the contract shared by execution, agents, dashboard, and project board flows.
- It has the highest blast radius if left ambiguous.

Rollback:

- Revert only the task/task-state/type/file-lock slice if ownership mapping or task persistence regresses.

### Slice B: Agent Routing and Execution Writeback

Goal: keep thread routing deterministic and make execution-result persistence append-only and low-risk.

Changes:

- Preserve product-agent to execution-agent boundaries in `agents/*` routes.
- Ensure writeback appends comments/activity without mutating unrelated task state.
- Keep fallback responder behavior intact when real execution routing is unavailable.

Why second:

- Depends on Slice A contract clarity.
- High impact on active dev-lane work, but contained to agents/execution paths.

Rollback:

- Revert only thread/assignment/routing changes if agent chat or execution completion notes regress.

### Slice C: UI State Compliance

Goal: remove lint-blocking React anti-patterns in key UI components without changing product scope.

Changes:

- Replace synchronous `setState` in effects with derived state or safe initialization patterns.
- Replace direct mutable global object writes with navigation helpers or browser API methods that satisfy immutability rules.
- Add explicit types for shared consolidation-review payloads in agents/projects/dashboard surfaces.

Why third:

- Fixes dev-lane instability signals while staying mostly presentation-layer only.

Rollback:

- Revert per-component if a navigation or rendering regression appears; no API rollback required.

## Risk Tiers

### Tier 1: High Risk

- `app_src/app/api/tasks/route.ts`
- `app_src/app/api/agents/threads/route.ts`
- `app_src/app/api/agents/assignments/route.ts`

Reason:

- These files persist state and can corrupt ownership, activity history, or execution metadata if incorrect.

Guardrail:

- Keep updates append-only where possible and preserve legacy field compatibility on read.

### Tier 2: Medium Risk

- `app_src/lib/types.ts`
- `app_src/lib/taskState.ts`
- `app_src/lib/agents/routing.ts`
- `app_src/lib/fileLock.ts`

Reason:

- Shared contracts/utilities can fan out to multiple callers, but changes are structurally small.

Guardrail:

- Prefer additive typing and compatibility mapping over semantic rewrites.

### Tier 3: Lower Risk

- `app_src/components/agents/AgentsSection.tsx`
- `app_src/components/projects/KanbanBoard.tsx`
- `app_src/components/projects/KanbanCard.tsx`
- `app_src/components/projects/CardDetailDrawer.tsx`
- `app_src/components/projects/BoardActivityDrawer.tsx`
- `app_src/app/HomeClient.tsx`
- `app_src/components/activity/ActivityLogPage.tsx`
- `app_src/components/dashboard/DashboardSection.tsx`

Reason:

- Mostly render/state-management stabilization with limited persistence impact.

Guardrail:

- Keep prop contracts stable and avoid changing user-visible workflows beyond bug fixes.

## Ownership Boundaries

- Task API owns persisted task shape, normalization, and activity/comment/checklist history.
- Agent routes own product-agent to execution-agent routing, thread lifecycle, and execution-result writeback.
- Shared libs own type definitions, routing maps, task-state evaluation, and file-lock behavior.
- UI components consume normalized task/agent contracts and must not invent alternate ownership fields or mutate browser globals unsafely.
- Dev lane documentation in `docs/operations/` owns stabilization intent, debt tracking, and validation evidence.

## Test Strategy

Validation order:

1. Targeted lint on touched files during implementation.
2. Full `npm run lint` in `app_src` to establish remaining debt versus resolved issues.
3. `npm run build` in `app_src`.
4. `npm run test:threads` in `app_src`.
5. `./scripts/dev-verify.sh` from repo root.

Evidence to capture:

- Whether full lint is clean.
- If not clean, exact remaining error classes and why they were left out of this slice.
- Build/test/dev-verify pass or fail summaries with command-level notes.

## Rollback Strategy

- Use small reviewable commits aligned to slices A-C.
- If a regression appears, revert the latest slice commit only; avoid reverting unrelated in-flight dev-lane work.
- Prefer rollback by file group:
  - Slice A: task/type/state/file-lock files.
  - Slice B: agents/routing/execution writeback files.
  - Slice C: affected UI components only.
- If validation shows broad unresolved lint debt outside touched files, document it explicitly rather than expanding scope into stable deployment or unrelated product areas.
