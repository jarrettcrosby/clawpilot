# Dev Lane 4002 Refactor Roadmap

## Priority Order

### Slice 1: Runtime Signoff On Live 4002

- Goal:
  - Convert current code-level `NO-GO` into runtime-verified `GO` or capture the next concrete runtime defect.
- Work:
  - Start dev lane through `scripts/dev-start.sh` with the isolated dev env.
  - Rerun `./scripts/dev-verify.sh`.
  - If it fails, capture `/api/health`, `/api/runtime`, and the latest `/tmp/clawd-app-dev.log` segment.
- Test:
  - `./scripts/dev-verify.sh`
  - Explicit route checks for `/api/health`, `/api/runtime`, `/api/execution-selftest`, `/api/execution-log-integrity`
- Rollback:
  - No code rollback expected; operational only.

### Slice 2: Task Persistence Boundary

- Goal:
  - Remove remaining read-modify-write race risk from file-backed task persistence.
- Work:
  - Introduce a shared task repository helper for read/normalize/mutate/write.
  - Ensure mutation happens under one serialized boundary rather than locking only the final write.
  - Include deleted-task writes in the same persistence strategy.
- Test:
  - `cd app_src && npm run lint`
  - `cd app_src && npm run build`
  - concurrent mutation smoke using parallel POST/PATCH/claim requests against dev runtime
- Rollback:
  - Revert repository helper adoption by route group only (`tasks`, `claim`, `assignments`, `backfill`).

### Slice 3: Execution Verification Contract Repair

- Goal:
  - Make execution verification prove real retrieval semantics, not just JSON shape.
- Work:
  - Decide whether `/api/execution-runs` should support `runId` lookup or whether verification should query a summary endpoint.
  - Update `scripts/verify-execution-flows.sh` to assert that the returned record set includes the selftest run.
  - Add explicit failure text when the endpoint returns an empty list.
- Test:
  - `scripts/verify-execution-flows.sh`
  - manual selftest against `/api/execution-selftest`
- Rollback:
  - Revert script/API together as one slice if contract consumers regress.

### Slice 4: Health Endpoint Hardening

- Goal:
  - Reduce false-green health responses.
- Work:
  - Define degraded behavior when the expected dev log is missing or unreadable.
  - Optionally combine health with build/runtime stamp checks.
  - Keep existing stale-log tolerance to avoid startup noise.
- Test:
  - route checks for `/api/health` under:
    - healthy runtime
    - missing log
    - injected error log
- Rollback:
  - Revert health-route logic only.

### Slice 5: Warning Debt Cleanup

- Goal:
  - Clear warning-only noise that still obscures meaningful regressions.
- Work:
  - Remove unused vars/imports in docs UI and helpers.
  - Fix `KanbanBoard` and `ReadOnlyChecklist` effect dependency warnings.
  - Remove dead helper code such as `taskAgeMs` if still unused.
- Test:
  - `cd app_src && npm run lint`
  - focused UI smoke on board, drawer, checklist, docs panels
- Rollback:
  - Revert per-component or per-helper; no persistence rollback needed.

## Guardrails

- Dev lane only: keep all persistence rooted in `data-dev/`.
- Preserve task/agent ownership behavior unless a defect is proven.
- Keep slices reviewable and isolate rollbacks by route/helper group.
- Do not expand into stable deployment or promotion mechanics.

## Current Baseline

- `npm run lint`: pass with warnings
- `npm run build`: pass
- `npm run test:threads`: pass
- `./scripts/dev-verify.sh`: fail because no reachable runtime on `4002`

## GO / NO-GO Gate

- `GO` only if:
  - `dev-verify` passes on live port `4002`
  - no new persistence regressions appear in task/agent flows
- Current state:
  - `NO-GO`
