# ClawPilot SuiteCRM service

This service packages the official SuiteCRM 8.10.1 release for Railway. It uses a dedicated MariaDB service and a persistent volume mounted at `/var/lib/suitecrm`.

The image runs Apache, the SuiteCRM scheduler, and the Symfony Messenger worker. Startup installs an empty database once, generates OAuth signing keys, and upserts the ClawPilot client-credentials record. An existing persisted application is never upgraded implicitly.

Required runtime variables:

- `SUITECRM_DB_HOST`, `SUITECRM_DB_PORT`, `SUITECRM_DB_NAME`
- `SUITECRM_DB_USER`, `SUITECRM_DB_PASSWORD`
- `SUITECRM_SITE_URL`
- `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`
- `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`

SuiteCRM is licensed under AGPL-3.0 with additional notices. The image downloads the unmodified official release and verifies its published SHA-256 digest during the build.
