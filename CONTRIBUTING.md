# Contributing

## Branch Policy

- `dev` is the active development branch for `4002`.
- `main` should represent production-ready code once GitHub is initialized.
- `stable/4001` captures the current local stable/prod baseline.
- Use short-lived feature branches from `dev` for larger changes.
- Do not mutate `4001` or stable/prod state without explicit operator approval.

## Development Rules

- Keep slices small and reviewable.
- Read relevant docs before broad refactors.
- Preserve user/runtime data unless the task explicitly says to migrate or clean it.
- Do not commit secrets, live customer data, runtime logs, backups, or generated agent state.
- Behavior changes require docs updates when the behavior is user-facing, operational, or architectural.

## Required Checks

Before a normal development handoff:

```bash
npm run lint
npm run build
npm run test
npm run verify:dev
```

Before a promotion candidate or GitHub push:

```bash
npm run verify:regression
npm run verify:predeploy
```

## Pull Request Expectations

A good PR should include:

- Goal and scope.
- Files or areas changed.
- User-facing behavior changes.
- Data/runtime impact.
- Verification commands and results.
- Screenshots for meaningful UI changes.
- Known risks and rollback notes.

## Commit Style

Prefer concise, scoped messages:

```text
docs: add project onboarding guide
ops: add vercel and railway config
fix: serialize task mutation writes
test: cover task-scoped thread isolation
```

## Data Handling

`data/` and `data-dev/` are local runtime state. They may contain sensitive business data, pipeline records, generated agent state, and backups. Keep source-code changes separate from runtime data changes unless the slice is specifically about data migration or promotion.
