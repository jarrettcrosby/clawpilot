# ClawPilot SuiteCRM service

This service packages the official SuiteCRM 8.10.1 release for Railway. It uses a dedicated MariaDB service and a persistent volume mounted at `/var/lib/suitecrm`.

The image runs Apache, the SuiteCRM scheduler, and the Symfony Messenger worker. Startup installs an empty database once, generates OAuth signing keys, upserts the ClawPilot client-credentials record, and idempotently installs the searchable `Global ID` field used by ClawPilot. An existing persisted application is never upgraded implicitly.

Required runtime variables:

- `SUITECRM_DB_HOST`, `SUITECRM_DB_PORT`, `SUITECRM_DB_NAME`
- `SUITECRM_DB_USER`, `SUITECRM_DB_PASSWORD`
- `SUITECRM_PUBLIC_URL`
- `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`
- `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`

The ClawPilot service reaches SuiteCRM over Railway's private network and exposes only the environment's canonical `https://crm.eigenracing.com` or `https://dev.crm.eigenracing.com` browser origin. Credentials stay in Railway variables. MariaDB and the SuiteCRM volume must be backed up and restored as one checkpoint.

See the [SuiteCRM Railway runbook](../../docs/operations/suitecrm.md) for topology, variables, first install, Global ID backfill, upgrades, and rollback.

SuiteCRM is licensed under AGPL-3.0 with additional notices. The image downloads the unmodified official release and verifies its published SHA-256 digest during the build.
