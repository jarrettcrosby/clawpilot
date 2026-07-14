# Railway Postgres Backups

## Required Policy

Railway Postgres is the durable store for ClawPilot-owned state. Use two independent recovery layers:

1. Railway volume backups as the primary provider-native restore mechanism.
2. A logical `pg_dump` export before risky migrations or major production promotions.

Both the `development` and `production` Postgres volume instances must have:

- `DAILY` backups, retained by Railway for 6 days.
- `WEEKLY` backups, retained by Railway for 1 month.
- At least one completed provider backup no more than 30 hours old.
- A manual provider backup immediately before destructive or high-risk database work.

Railway also offers `MONTHLY` backups retained for 3 months. Provider backups are incremental, Copy-on-Write volume snapshots and are billed as volume storage. Railway limits a manual backup to 50% of the volume's total capacity.

Current Railway references, checked on 2026-07-13 EDT:

- [Volume backups](https://docs.railway.com/volumes/backups)
- [PostgreSQL backups and observability](https://docs.railway.com/databases/postgresql)
- [Manage volume backups with the public API](https://docs.railway.com/integrations/api/manage-volumes)
- [Point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery)

## Live Provider Evidence

The final read-only Railway GraphQL audit at `2026-07-14T00:39:54.682Z` returned the following state for project `clawpilot` (`b5169ebd-8166-4b96-9a81-7cc8adaa9270`):

| Environment | Environment ID | Volume instance ID | Used / capacity | Schedules | Provider backups |
|---|---|---|---:|---|---|
| `development` | `e4abd95f-825c-4242-b37b-825a92597e98` | `3a8032ad-3de7-44c6-82df-cd932b9b2b99` | 221.77 / 5000 MB | none | none |
| `production` | `058ce52f-1d3b-44bb-afe2-0df2bf24efb9` | `ace353d0-0c86-43b9-905a-4dd2fcc2cb5e` | 222.40 / 5000 MB | none | none |

Both instances were `READY`, mounted at `/var/lib/postgresql/data`, and attached to the shared Railway service definition `Postgres` (`bc62c97a-e87f-43fa-8c87-a7503d5565e9`). The volumes are isolated by environment even though Railway reports the same logical volume and service IDs.

**Status: provider backups are not configured or verified in either environment.** Do not describe either environment as provider-backed until Railway returns both required schedules and a completed backup record.

### Configuration Blocker

The authenticated Railway CLI session could read both volume instances, schedule lists, and backup lists. Attempts to configure `DAILY` + `WEEKLY` schedules through `volumeInstanceBackupScheduleUpdate` and to create a manual development backup through `volumeInstanceBackupCreate` were rejected by Railway with `Not Authorized`. The manual-backup rejection was an HTTP 200 GraphQL error with trace ID `8509242877894352621`.

No backup policy or snapshot was created by those attempts. A subsequent read returned the same empty state shown above. The current Railway CLI exposes volume management but no backup subcommand, and the CLI OAuth token does not have the write authorization needed for the backup mutations.

Resolve this in an operator-authenticated Railway dashboard session:

1. Open project `clawpilot`, environment `production`, service `Postgres`, then **Backups**.
2. Enable **Daily** and **Weekly** schedules.
3. Trigger a manual backup and wait until Railway lists a completed snapshot.
4. Repeat the same steps in environment `development`.
5. Run the audit below with an account or workspace API token that can read the project.

## Repeatable Audit

`scripts/railway-backup-audit.mjs` is read-only. It queries Railway's public GraphQL API and exits nonzero unless both named environments have `DAILY` + `WEEKLY` schedules and a provider backup no more than 30 hours old.

Use an account or workspace API token supplied through the environment. Do not commit or print the token.

```bash
export RAILWAY_API_TOKEN
node scripts/railway-backup-audit.mjs \
  --project-id b5169ebd-8166-4b96-9a81-7cc8adaa9270
unset RAILWAY_API_TOKEN
```

An exit code of `0` is the verification gate. Exit code `1` means the API call succeeded but policy is unmet. Exit code `2` means the audit itself could not complete.

## Logical Export

Keep exports outside tracked source. The root `.gitignore` excludes `backups/`.

```bash
mkdir -p backups/postgres
railway run --service Postgres --environment production -- \
  sh -lc 'pg_dump --format=custom --no-owner --no-acl "$DATABASE_PUBLIC_URL"' \
  > "backups/postgres/clawpilot-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Validate the export without restoring it:

```bash
pg_restore --list backups/postgres/clawpilot-YYYYMMDDTHHMMSSZ.dump >/dev/null
```

## Restore Drill

For a Railway volume restore:

1. Announce a maintenance window and stop application writes.
2. Select the intended backup in the Postgres service **Backups** tab.
3. Restore it and review Railway's staged volume replacement.
4. Deploy the staged change.
5. Run migrations and deployed smoke checks.
6. Verify task, thread, execution, pipeline projection, and outbox counts before reopening writes.

Railway retains the original volume unmounted after staging the replacement. A restore is limited to the same project and environment, and restoring a snapshot removes newer snapshots. Test the workflow in `development` before relying on it for production.

For a logical restore, provision a separate Postgres database first. Restore into the separate database, validate it, then change `DATABASE_URL` deliberately. Do not overwrite the active production database as the first restore step.

Railway point-in-time recovery is a separate feature. Enabling it creates a storage bucket, adds WAL archive variables, and redeploys Postgres. It was not enabled or verified during this review.

## Shared `/s/{slug}` Routing

### Live Routing Evidence

As of `2026-07-14T00:31Z`:

- `eigenracing.com` resolves to `216.198.79.1` and Vercel returns `307` to `https://www.eigenracing.com`, preserving the request path.
- `www.eigenracing.com` is a CNAME to `ce2788e7ac79f119.vercel-dns-017.com`.
- Vercel project `eigenracing-web` (`prj_KhJEIzrjBjaY91CTijziDdyMM58A`) owns both `eigenracing.com` and `www.eigenracing.com`.
- `https://www.eigenracing.com/s/clawpilot-routing-probe-404` returns Vercel `404`; no `/s/{slug}` route exists in the deployed application.
- ClawPilot's `aiapp.eigenracing.com` and `dev.aiapp.eigenracing.com` remain separate Railway CNAMEs.

### Recommended Ownership

Keep the apex and `www` records on the existing `eigenracing-web` Vercel project. DNS selects a host, not a URL path, so DNS cannot route only `/s/{slug}` to ClawPilot or another service. Moving either existing record would move the entire Eigen Racing site.

The current workspace has an uncommitted ClawPilot implementation in `app_src/app/s/[slug]/route.ts`, `app_src/app/api/shortlinks/route.ts`, `app_src/lib/shortlinks.ts`, and `db/migrations/0015_short_links.sql`. It uses ClawPilot Postgres as one shared short-link store and exposes a bearer-authenticated management API for another application. It is not deployed platform evidence.

Given that implementation, the lowest-change production routing shape is:

1. Treat ClawPilot production as the canonical short-link API and data owner.
2. Serve the public lookup at `https://aiapp.eigenracing.com/s/:slug`, which uses an existing verified Railway custom domain.
3. Add an external Vercel rewrite in `eigenracing-web` from `/s/:slug` to `https://aiapp.eigenracing.com/s/:slug`.
4. Set ClawPilot production's public short-link origin to `https://eigenracing.com` so generated URLs use the requested public host.
5. Give the Eigen Racing application a scoped service credential for link management and keep browser/operator access session-authenticated.

Vercel documents external rewrites as a reverse proxy that preserves the browser URL: [Rewrites on Vercel](https://vercel.com/docs/routing/rewrites). Rewrites to external origins are not cached by default; leave redirect lookups uncached until invalidation and abuse controls are proven.

The public lookup endpoint should accept only strict URL-safe slugs and `GET`/`HEAD`, return `404` for unknown links and `410` for disabled, expired, or exhausted links, and issue a temporary `302` or `307` for mutable links. Link creation and mutation must use authenticated service credentials with issuer identity, idempotency, audit records, rate limits, and absolute `https:` destination validation. Never accept a destination from the public lookup request.

### Implementation Status

- The public proxy exemption, service-authenticated API path, HTTPS-only destination constraint, and source-bound client credentials are implemented in the current short-link release.
- Eigen Racing owns the user-facing `/app/links` and `/s/:slug` routes. Its server proxy fixes the source to `eigenracing`, binds the owner to the signed-in email, and keeps the service credential out of browser bundles.
- Development and production use separate service secrets and public origins.
- **Open platform control:** the ClawPilot production database still has no Railway backup schedule or provider snapshot. The short-link store does not meet the provider-backup requirement until the Backups tab or a write-capable platform token enables and verifies the schedule.

### External Work Required

- **Required platform configuration:** enable and verify Railway Postgres backups using an operator-authorized dashboard session or write-capable token.
- **Not required:** no change to the `eigenracing.com` apex A record, the `www` CNAME, or either ClawPilot custom-domain record.
- **Optional:** a future dedicated `links.eigenracing.com` origin would require the exact CNAME and ownership-verification TXT records Railway provides. It is not needed for the current `aiapp.eigenracing.com` rewrite design.

Do not create a DNS record named `/s`; DNS labels cannot contain or route HTTP paths.
