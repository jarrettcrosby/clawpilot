# Contributing

## Branch Policy

- `dev` is the active development branch and local `4002` lane.
- `main` is the production branch.
- `stable/4001` is a historical stable reference, not the hosted promotion target.
- Use short-lived feature branches from `dev` for larger changes.
- Do not mutate `4001` or stable/prod state without explicit operator approval.

## Development Rules

- Keep slices small and reviewable.
- Read relevant docs before broad refactors.
- Use the [Codex task continuity procedure](docs/operations/codex-task-continuity.md) when work moves between desktop, phone, compaction, or fresh tasks.
- Preserve user/runtime data unless the task explicitly says to migrate or clean it.
- Do not commit secrets, live customer data, runtime logs, backups, or generated agent state.
- Behavior changes require proactive documentation updates in the same slice when the behavior is user-facing, operational, data-related, integration-related, or architectural. Do not wait for the operator to request documentation.

## Documentation Definition Of Done

1. Update the owning active module or operations contract; do not create a new progress log.
2. Remove or correct superseded statements in that contract.
3. Add release copy when the change is promoted or changes observable behavior in a deployed environment.
4. Create a dated incident or audit only when its evidence will still be useful after the immediate work is complete.
5. Run `npm run verify:docs` before handoff.

## Required Checks

Before a normal development handoff:

```bash
npm run verify:repo
npm run lint
npm run build
npm run test
npm run verify:dev
npm run verify:docs
```

Before a promotion candidate or GitHub push:

```bash
npm run verify:regression
npm run verify:predeploy
```

`verify:repo` rejects tracked secrets, runtime data, generated builds, test reports, logs, backups, platform-local state, and oversized artifacts. Fix the source boundary; do not weaken the check to accommodate generated files.

## Pull Request Expectations

A good PR should include:

- Goal and scope.
- Files or areas changed.
- User-facing behavior changes.
- Data/runtime impact.
- Active contract and release-copy impact.
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
