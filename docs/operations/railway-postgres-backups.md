# Railway Postgres Backups

## Policy

Railway Postgres is the durable store for ClawPilot-owned state. Use two independent recovery layers:

1. Railway volume backups as the primary restore mechanism.
2. A logical `pg_dump` export before risky migrations or major production promotions.

In the Railway `Postgres` service, open **Backups** and enable:

- Daily backups for short-horizon recovery.
- Weekly backups for a longer recovery window.
- A manual backup immediately before destructive or high-risk database work.

Railway documents daily, weekly, and monthly schedules and restores into a staged replacement volume. Restoring changes the mounted volume and redeploys the database service, so review the staged change before applying it.

References:

- https://docs.railway.com/volumes/backups
- https://docs.railway.com/databases/postgresql
- https://docs.railway.com/volumes/point-in-time-recovery

## Logical Export

Keep exports outside the repository. The root `.gitignore` excludes `backups/` through the runtime-data policy; verify with `git status` before and after every export.

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

For a Railway-native restore:

1. Announce a maintenance window and stop application writes.
2. Select the intended backup in the Postgres service **Backups** tab.
3. Restore it and review Railway's staged volume replacement.
4. Deploy the staged change.
5. Run migrations and deployed smoke checks.
6. Verify task, thread, execution, pipeline projection, and outbox counts before reopening writes.

For a logical restore, provision a separate Postgres database first. Restore into the separate database, validate it, then change `DATABASE_URL` deliberately. Do not overwrite the active production database as the first restore step.

## Recovery Targets

- Record a successful native backup before schema changes.
- Keep at least daily and weekly schedules enabled.
- Perform a restore drill after material schema changes and at least quarterly.
- Consider Railway point-in-time recovery if the operator needs recovery between scheduled snapshots; enabling it adds storage and a database redeploy.
