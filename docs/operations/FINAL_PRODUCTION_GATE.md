# Final Production Gate (Consolidated)

Status: Canonical go/no-go checklist
Scope: Governance / runbook only

## A) Pre-promotion gate (dev lane must be canonical)

1. **Dev lane canonical truth (4002)**
- `/api/runtime` must report:
  - lane = `dev`
  - port = `4002`
  - repoPath = `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- `/api/health` on 4002 must be `ok`.

2. **Exact build/commit to promote is explicit**
- The exact commit validated on 4002 is recorded as promotion target.
- Runtime commit on 4002 must match git HEAD for that target before promotion.

3. **Product/system readiness checks**
- Projects / Agents / Docs / Pipeline / Dashboard sanity passes.
- Assignment/claim/chat/writeback path sanity passes.
- Task creation governance controls verified.
- UI-visible acceptance passes for critical UI actions (no-refresh visible updates): `scripts/ui-acceptance.sh`.
- Doc coherence + traceability docs updated.

## B) Canonical dev → prod promotion workflow (must be followed)

Use `docs/operations/promotion.md` exactly:
1. `scripts/regression-all.sh` (mandatory hard gate)
2. `scripts/dev-align-from-prod.sh --dry-run --report`
3. 4002 runtime identity + health check
4. version/build check (`/api/version`)
5. route-aware verification on 4002
6. `scripts/dev-promotion-check.sh`
7. `scripts/verify-board-hygiene.sh promotion`
8. `scripts/verify-promotion-task-eligibility.sh` (must not return `PROMOTION_BLOCKED_DEV_ONLY_TASKS`)
9. `scripts/promotion-dry-run.sh`
10. freeze window enable (operator-gated)
11. promotion execute (operator-gated)
12. stable code deploy if needed (operator-gated)
13. post-rollout verification

## C) Post-promotion stable validation gate (4001)

After promotion/deploy, stable must pass all:
- `GET /api/health` => 200/ok
- `GET /api/runtime` =>
  - lane = `stable`
  - repoPath = `/Users/agentsuburbiasandwich/Desktop/clawd-app`
  - port = `4001`
- `GET /` => non-5xx

Also verify watchdog/ops:
- latest watchdog checks/recovery logs visible
- no unresolved hard failure condition

## D) Rollback criteria (explicit)

Trigger rollback if any hold after one canonical recovery attempt:
1. 4001 invariant breach persists >5 minutes:
   - health not 200/ok, or
   - runtime lane/repo/port mismatch, or
   - root is 5xx.
2. `STABLE_HARD_FAILURE` repeats 2+ times in 30 minutes.
3. Critical operator workflows unavailable (Projects load, task-linked chat, dashboard sanity).

Rollback path:
- Follow rollback section in `docs/operations/PRODUCTION_ROLLOUT_FIRST24H.md` and `docs/operations/promotion.md`.

## E) Decision outputs

- **GO**: all A/B/C checks pass, no active rollback trigger.
- **GO WITH CONDITIONS**: core checks pass but bounded operational condition remains with owner/timebox.
- **NO-GO**: any blocker in A/B/C or rollback trigger active.
