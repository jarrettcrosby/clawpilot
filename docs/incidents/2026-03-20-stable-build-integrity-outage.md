# Incident Postmortem — 2026-03-20 Stable Build Integrity Outage

## Summary
Stable runtime (4001) experienced outage during rollback/redeploy attempts after stable code deploy encountered missing module errors. Deploy attempts revealed target commits were not clean-buildable from committed files only.

## Root Cause
Deployability assumptions were invalid:
- Modules used by runtime/UI imports existed locally in dev worktree but were not committed/tracked.
- `stable-code-deploy.sh` did not enforce a clean committed-files-only preflight build before attempting checkout/build/restart on stable.
- Result: stable lane could be moved to commits that fail build in a clean context, causing runtime outage risk.

Primary missing local-only modules identified and committed:
- `app_src/lib/errorUtils.ts`
- `app_src/lib/consolidation.ts`

## Recovery Steps Taken
1. Identified missing module failures from build logs.
2. Committed missing files to dev repository.
3. Verified `npm run build` passes in dev.
4. Verified build passes in isolated clean worktree (committed-files-only proof).
5. Deployed stable to fixed commit and re-verified runtime routes.

## Permanent Prevention
Implemented hard deploy-integrity guard in `scripts/stable-code-deploy.sh`:
- Before checkout/restart, target commit is built in isolated temporary worktree with `npm install && npm run build`.
- Deploy is blocked if this clean committed-files-only build fails.
- This enforces: **no deploy unless clean committed-files-only build is green**.

## Follow-up
- Keep promotion/deploy docs aligned with this rule.
- Treat any local-only module usage as release-blocking until committed and validated in clean worktree build.
