# Dev → Prod Promotion Workflow (Readiness)

This project uses a **non‑destructive promotion readiness workflow** before any rollout.

## Canonical process (approved)
0. **Mandatory full regression gate (hard)**
   - `scripts/regression-all.sh`
   - Runs, in order (fail-fast):
     - `scripts/dev-verify.sh`
     - `scripts/runtime-verify-all.sh`
     - `scripts/smoke-tests.sh`
     - `scripts/critical-path-acceptance.sh`
     - `scripts/ui-acceptance.sh`
   - **No push/promotion may proceed unless this is green.**
1. **Alignment dry‑run** (promotion contract check)
   - `scripts/dev-align-from-prod.sh --dry-run --report`
   - Notes:
     - `pipeline/dropdowns/catalog.json` ignores `syncedAt` drift (timestamp-only differences are not blockers)
     - promotion-mutable state files are allowed to differ from prod baseline before promotion:
       - `tasks.json`
       - `agents/assignments.json`
       - `agents/threads.json`
2. **Runtime identity check**
   - `/api/runtime` must report **lane=dev**, **port=4002**, **repo=clawd-app-dev**
   - If `/api/runtime` is unavailable, fallback to git commit in dev repo
3. **Health check**
   - `/api/health` must be **ok** on port **4002**
4. **Version/build check**
   - `/api/version` must return a commit hash
5. **Freshness rule (pre‑verification)**
   - If the slice changes app code or routes, rebuild/restart dev runtime on **4002** before verification
   - Confirm `/api/runtime` commit matches git HEAD after restart
6. **Route‑aware verification**
   - If a slice adds/changes a route, explicitly hit that route on **4002** after restart
7. **Promotion readiness**
   - `scripts/dev-promotion-check.sh` prints **PROMOTION_READY** or **PROMOTION_NOT_READY**
   - No stable changes are made in this step
8. **Board hygiene gate (hard)**
   - `scripts/verify-board-hygiene.sh promotion`
   - Promotion is blocked with `PROMOTION_BLOCKED_BOARD_HYGIENE` only when active backlog/todo contains hard-block junk tasks (placeholder/empty title, or no meaningful description + no acceptance criteria).
   - Governance-labeled salvageable cards remain visible and do not block by label alone.
9. **Promotion task eligibility gate (hard)**
   - `scripts/verify-promotion-task-eligibility.sh`
   - Promotion is blocked with `PROMOTION_BLOCKED_DEV_ONLY_TASKS` if promotable task state includes dev-only/test/validation cards.
   - Primary source of truth is explicit metadata/tags/classification (`dev-only`, `test-card`, `validation-only`, `promotable=false`).
   - Legacy heuristic fallback also blocks obvious test/validation markers (e.g., smoke/validation/test/STBISO/ST2/directive mapping verification).
10. **Promotion dry‑run**
   - `scripts/promotion-dry-run.sh` prints **PROMOTION_DRY_RUN_READY** or **PROMOTION_DRY_RUN_BLOCKED**
   - Includes unified lane verification and writes a dry-run report
11. **Final preflight verification**
   - `ROUTE_CHECKS_STABLE="/api/health /api/runtime /" ROUTE_CHECKS_DEV="/api/health /api/runtime /api/promotion-report /" scripts/runtime-verify-all.sh`
12. **Rollout freeze window (operator‑gated)**
   - Enable: `scripts/freeze-enable.sh "production rollout"`
   - Disable: `scripts/freeze-disable.sh`
13. **Promotion execution (operator‑gated)**
   - `scripts/promotion-execute.sh` (type `PROMOTE` to confirm)
   - **Promotion updates data/state only**. Stable code remains whatever is deployed in the stable repo; code rollout requires a separate stable deploy.
14. **Stable code deployment (operator‑gated, separate)**
   - `scripts/stable-code-deploy.sh --commit <sha>`
   - **Hard pre-deploy integrity guard (automatic):** deploy is blocked unless the target commit passes a **clean committed-files-only build** in an isolated temporary worktree.
   - Rule: **no deploy unless clean committed-files-only build is green**.
   - Verifies stable runtime commit after deploy
   - Use when UI/API changes exist only in dev
15. **Post‑rollout verification**
   - `scripts/stable-verify.sh` and `scripts/runtime-verify-all.sh`

## Dev/Prod Alignment Workflow
- Dry-run: `scripts/dev-align-from-prod.sh --dry-run --report`
- Apply (dev only, confirmation required): `scripts/dev-align-from-prod.sh --apply --report`
- Use `--yes` for automation after human approval

## Reports & evidence
- Alignment dry-run: `data-dev/backups/dry-run-<timestamp>.json`
- Promotion readiness: `data-dev/backups/promotion-check-<timestamp>.json`
- Promotion dry-run: `data-dev/backups/promotion-dry-run-<timestamp>.json`
- Promotion execution: `data-dev/backups/promotion-execute-<timestamp>.json`

## Notes
- Dev runtime: **4002**
- Stable runtime: **4001**
- Dev data: **data-dev/**
- Stable data: **data/**

## Promotion dependency: control-path script shim
To keep promotion scripts deterministic when run from the dev worktree, scripts use a **control-path shim**:
- `CONTROL_REPO=/Users/agentsuburbiasandwich/Desktop/clawd-app` (control/stable script root)
- `DEV_REPO=/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` (dev worktree root)

Why this matters:
- Promotion orchestration is launched from dev context, but some guard/verify/restart steps must execute via the control repo script path.
- Without this split, relative-path execution can target the wrong repo root and silently skip/incorrectly resolve critical promotion checks.

Required behavior:
- Keep explicit `CONTROL_REPO` + `DEV_REPO` variables in promotion scripts.
- Resolve cross-repo script invocations via absolute paths rooted at those variables.
- Treat this shim as a hard dependency for reliable promotion execution.

## Final gate + post-GO live operations
Before final release decision, pass:
- `docs/operations/FINAL_PRODUCTION_GATE.md`

After go-live approval, follow:
- `docs/operations/PRODUCTION_ROLLOUT_FIRST24H.md`

This doc is a pointer for the approved workflow; do not automate promotion without explicit instruction.
