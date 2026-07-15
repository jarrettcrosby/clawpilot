# ClawPilot

ClawPilot is a private command center for project boards, CRM and pipeline activity, working documents, releases, short links, integrations, and task-linked AI agents.

- Canonical repository: `jarrettcrosby/clawpilot`
- Active development branch: `dev`
- Production branch: `main`
- Development: `https://dev.aiapp.eigenracing.com`
- Production: `https://aiapp.eigenracing.com`

The Next.js application lives in `app_src/`. Railway runs the application worker and environment-specific Postgres services; Vercel provides the matching web deployment and protected previews. Google Sheets remains the writable operator table for pipeline data.

## Quick Start

Install dependencies:

```bash
npm --prefix app_src install
```

Start the isolated local runtime:

```bash
./scripts/dev-start.sh
```

Open:

```text
http://127.0.0.1:4002
```

## Validation

Use the smallest relevant checks during implementation:

```bash
npm run lint
npm run build
npm run test
```

Use the full local gate before a promotion candidate:

```bash
npm run verify:regression
```

CI-safe predeploy verification:

```bash
npm run verify:predeploy
```

Documentation catalog verification:

```bash
npm run verify:docs
```

Run Railway Postgres migrations after `DATABASE_URL` is configured:

```bash
npm run db:migrate
```

## Repository Map

- `app_src/` - Next.js application, API routes, components, and shared libraries.
- `scripts/` - runtime, migration, verification, release, and deployment scripts.
- `db/migrations/` - append-only Postgres schema history.
- `docs/index.md` - canonical product, module, deployment, release, and brand contracts.
- `docs/README.md` - Obsidian vault map and operator-only runbooks.

The old `clawd-app` folders and deleted dated notes remain available through Git history only. They are not active runtime or deployment contracts.

## Documentation Contract

Every implementation that changes user-facing, operational, data, integration, or architectural behavior must update its owning active contract during the same slice without waiting for an operator prompt. Every promoted deployment must also add user-facing release copy. A change is not complete while its current contract or release record is stale.

## Data Safety

Keep live data, backups, logs, environment files, provider credentials, pipeline exports, and generated agent state out of Git. Local `data/` and `data-dev/` paths are runtime state, not portable source code.

## Related Docs

- [Canonical knowledge index](docs/index.md)
- [Contributing](CONTRIBUTING.md)
- [Environment and deployment contract](docs/operations/clawpilot-environments.md)
- [Release documentation contract](docs/releases/README.md)
