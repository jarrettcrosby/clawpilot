# ClawPilot

ClawPilot is a private command center for project boards, CRM and pipeline activity, working documents, releases, short links, integrations, and task-linked AI agents.

- Canonical repository: `jarrettcrosby/clawpilot`
- Active development branch: `dev` (local and CI validation; protected previews resume only after the gated Vercel retirement)
- Production branch: `main`
- Local development: `http://127.0.0.1:4002`
- Authenticated remote-local development gateway: `https://dev.aiapp.eigenracing.com`
- Production: `https://aiapp.eigenracing.com`

The Next.js application lives in `app_src/`. The accepted cutover target makes
Railway the sole hosted production runtime and owner of the production
application, workers, and Postgres. The application Vercel project then provides
protected compile/UI previews only; a separate Vercel gateway may proxy
authenticated remote-local development to the Mac without receiving production
data or secrets. Google Sheets remains the writable operator table for pipeline
data.

Cutover is not complete yet. A read-only Vercel audit on September 5, 2026
found legacy production-scoped database, agent-credential-database,
authentication-mail, integration-evidence, and Google SSO configuration still
assigned to the application project. Do not describe or use that project as
preview-only until Railway is verified at the exact release commit—including
health, persistence, workers, and an authenticated production workflow—and the
legacy Vercel variables and production authority are then removed and
re-audited.

## Quick Start

New contributors should begin with [AGENTS.md](AGENTS.md) for repository-specific operating rules and [docs/index.md](docs/index.md) for current product contracts. Work from `dev`; do not infer behavior from the historical OpenClaw folders.

Install the locked application dependencies:

```bash
npm --prefix app_src ci
```

Start the isolated local runtime:

```bash
./scripts/dev-start.sh
```

Open:

```text
http://127.0.0.1:4002
```

The startup script supplies an isolated local data environment. Keep its launching shell alive during browser testing. Do not replace it with `npm run dev` for normal validation.

For a first change:

1. Find the owning contract from [docs/index.md](docs/index.md).
2. Trace UI/API behavior through `app_src/components`, `app_src/app/api`, and `app_src/lib`.
3. Make the smallest coherent implementation and contract update.
4. Run the relevant focused test, then the gates below.
5. Promote from `dev` to `main` through a pull request only after development verification is green.

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

Tracked-source and onboarding hygiene:

```bash
npm run verify:repo
```

Run Railway Postgres migrations after `DATABASE_URL` is configured:

```bash
npm run db:migrate
```

## Repository Map

- `app_src/app/` - Next.js routes, server entry points, and tenant-aware API handlers.
- `app_src/components/` - module UI grouped by Dashboard, Projects, Pipeline, CRM, Docs, Agents, Accounting, POS, and Settings.
- `app_src/lib/` - domain services, authorization, provider adapters, projections, and Postgres persistence boundaries.
- `app_src/tests/` - browser acceptance and responsive workflow coverage.
- `scripts/` - local runtime, worker, migration, reconciliation, verification, release, and deployment commands.
- `db/migrations/` - append-only Postgres schema history.
- `docs/index.md` - canonical map for product, module, deployment, release, and brand contracts.
- `docs/README.md` - Obsidian vault structure, note lifecycle, and operator-only navigation.
- `.github/workflows/` - CI, deployed-runtime monitoring, and controlled repository-agent execution.
- `railway.json` and `app_src/vercel.json` - hosted runtime contracts; platform-local state remains ignored.

The old `clawd-app` folders and deleted dated notes remain available through Git history only. They are not active runtime or deployment contracts.

## Architecture And Data Authority

- **Railway Postgres** is the durable store for app-owned identities, memberships, permissions, boards, tasks, documents, audit records, execution evidence, connector state, and synchronization outboxes.
- **Google Sheets** is the writable operator table for managed pipeline opportunities. CRM, calculations, dropdowns, and dashboard tabs are generated projections, not independent authorities.
- **SuiteCRM** is the external CRM administration and history surface. ClawPilot stages tenant-scoped writes through an idempotent outbox and reconciles supported inbound changes.
- **QuickBooks, Toast, Google, Maton, and OpenAI** remain provider systems. ClawPilot stores scoped connection metadata and durable evidence; browser requests do not bypass authorization or write directly to providers.
- **Railway** is the required sole production web application, worker, and
  durable-Postgres authority after cutover acceptance. **Vercel** is being
  retired to protected compile/UI previews only; its currently assigned legacy
  production-scoped variables must be removed only after Railway exact-commit
  acceptance and must not be treated as target-state authority. Local and
  remote-local development use isolated non-production state and never share
  the production database or provider credentials.

Every request must preserve both signed-user and active-workspace scope. Global app administration, organization membership, resource sharing, CRM ownership, and provider authorization are separate controls.

## Documentation Contract

Every implementation that changes user-facing, operational, data, integration, or architectural behavior must update its owning active contract during the same slice without waiting for an operator prompt. Every promoted deployment must also add user-facing release copy. A change is not complete while its current contract or release record is stale.

## Data Safety

Keep live data, backups, logs, environment files, provider credentials, pipeline exports, and generated agent state out of Git. Local `data/` and `data-dev/` paths are runtime state, not portable source code.

`npm run verify:repo` enforces this boundary against tracked files. It does not delete local runtime data or credentials.

## Related Docs

- [Canonical knowledge index](docs/index.md)
- [Contributing](CONTRIBUTING.md)
- [Environment and deployment contract](docs/operations/clawpilot-environments.md)
- [Release documentation contract](docs/releases/README.md)
