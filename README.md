# ClawPilot

ClawPilot is a private command center for project boards, pipeline activity, working documents, releases, and task-linked AI agents.

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

Use the full local gate before promotion or any GitHub push candidate:

```bash
npm run verify:regression
```

CI-safe predeploy verification:

```bash
npm run verify:predeploy
```

Run Railway Postgres migrations after `DATABASE_URL` is configured:

```bash
npm run db:migrate
```

## Repository Map

- `app_src/` - Next.js application, API routes, components, and shared libraries.
- `scripts/` - runtime, migration, verification, release, and deployment scripts.
- `db/migrations/` - append-only Postgres schema history.
- `docs/index.md` - current module, deployment, release, and brand contracts.

Older `clawd-app` folders and dated operations notes are historical import evidence only. They are not active runtime or deployment contracts.

## Data Safety

Keep live data, backups, logs, environment files, provider credentials, pipeline exports, and generated agent state out of Git. Local `data/` and `data-dev/` paths are runtime state, not portable source code.

## Related Docs

- [Canonical knowledge index](docs/index.md)
- [Contributing](CONTRIBUTING.md)
- [Environment and deployment contract](docs/operations/clawpilot-environments.md)
- [Release documentation contract](docs/releases/README.md)
