# Overnight Evidence Index — 2026-03-22

## Created artifacts
- docs/reviews/overnight-clawpilot-app-review-2026-03-22.md
- docs/reviews/overnight-clawpilot-app-review-2026-03-22.json
- docs/reviews/overnight-evidence-index-2026-03-22.md

## Commands executed so far
1. `cd /Users/agentsuburbiasandwich/Desktop/clawd-app-dev && pwd && test -d app_src && echo DEV_REPO_OK && ls -1 docs | head -n 20`
2. `cd /Users/agentsuburbiasandwich/Desktop/clawd-app-dev && mkdir -p docs/reviews && ls -ld docs/reviews`

## Test runs so far
1. `./scripts/ui-acceptance.sh`
   - Result: pass (Playwright 1/1)
2. `./scripts/regression-all.sh`
   - Result: pass (`REGRESSION_ALL_OK`)
3. `./scripts/dev-verify.sh`
   - Result: pass (`VERIFY_OK`)

## Additional review commands executed
3. `ls -1 scripts`
4. `find docs -maxdepth 3 -type f`
5. `ls -1 app_src/app/api`
6. `ls -1 app_src/components`
7. `read docs/architecture/system-operating-model.md`
8. `read docs/architecture/AGENT_ROUTING_MODEL.md`
9. `read docs/governance/TASK_CREATION_POLICY.md`
10. `read docs/operations/development-contract.md`
11. `read app_src/lib/agents/routing.ts`
12. `read app_src/app/api/tasks/route.ts`
13. `read app_src/app/api/agents/threads/route.ts`
14. `read app_src/components/projects/KanbanBoard.tsx`

## Prior cleanup evidence (dev-only test artifacts)
- Previously removed `SC Smoke Valid Task` cards from `data-dev/tasks.json`.
- Cleanup snapshot:
  - before: 64
  - removed: 10
  - after: 54
  - backup: `data-dev/backups/tasks-before-smoke-cleanup-20260322-020106.json`
  - remaining smoke cards by title check: 0

## Additional tests executed (latest checkpoint)
4. `bash ./scripts/runtime-verify-all.sh`
   - Result: pass (`RUNTIME_VERIFY_ALL_OK`)
5. `bash ./scripts/critical-path-acceptance.sh`
   - Result: pass (`CRITICAL_PATH_ACCEPTANCE_OK`)
6. `bash ./scripts/smoke-tests.sh`
   - Result: pass (`SMOKE TESTS COMPLETED`)

## Notes
- All work constrained to dev lane path.
- Initial direct execution attempts for `./scripts/critical-path-acceptance.sh` and `./scripts/smoke-tests.sh` returned permission denied; rerun via `bash` succeeded.
