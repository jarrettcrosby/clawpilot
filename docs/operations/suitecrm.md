---
title: SuiteCRM Railway Runbook
status: active
kind: operations-runbook
tags: [suitecrm, railway, mariadb, oauth, migration]
app_visible: false
---

# SuiteCRM Railway Runbook

## Topology

Each Railway environment has a private `suitecrm` service, a dedicated MariaDB service, and a SuiteCRM volume mounted at `/var/lib/suitecrm`. SuiteCRM does not share ClawPilot's Postgres database. The ClawPilot service reaches SuiteCRM through `http://suitecrm.railway.internal:<port>` and OAuth2 client credentials.

The image is built from `services/suitecrm/`. It verifies the official SuiteCRM 8.10.1 release digest, serves `public/` with Apache, runs the legacy scheduler every minute, and continuously restarts the Symfony Messenger worker.

## Required Variables

SuiteCRM service:

- `SUITECRM_DB_HOST`, `SUITECRM_DB_PORT`, `SUITECRM_DB_NAME`
- `SUITECRM_DB_USER`, `SUITECRM_DB_PASSWORD`
- `SUITECRM_SITE_URL`
- `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`
- `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`

ClawPilot service:

- `CRM_ENABLED=1`
- `SUITECRM_BASE_URL`
- the same `SUITECRM_CLIENT_ID` and `SUITECRM_CLIENT_SECRET`

Credentials must remain Railway secrets. The container hashes the OAuth client secret before upserting it into SuiteCRM and never prints the secret.

## First Install

1. Create MariaDB and the SuiteCRM service in development.
2. Attach the SuiteCRM volume at `/var/lib/suitecrm` before the first deployment.
3. Set all variables and deploy the service.
4. Verify the SuiteCRM root, token endpoint, scheduler, and Messenger logs.
5. Enable CRM variables on the ClawPilot development service and apply migration `0020_crm_gateway_and_reporting.sql`.
6. Inspect and import the source workbook, drain the SuiteCRM and Google outboxes, then compare entity counts and pipeline totals before projecting the controlled workbook.
7. Repeat in production only after development reconciliation succeeds.

## Upgrade Rule

The service never upgrades a persisted SuiteCRM application implicitly. A version mismatch fails closed. Take a MariaDB snapshot and SuiteCRM volume snapshot, follow the official SuiteCRM upgrade procedure, verify the API and workers, then update the version marker deliberately.

## Rollback

Disable `CRM_ENABLED` or stop CRM writes in ClawPilot, retain the Postgres outbox, and restore the MariaDB and SuiteCRM volume snapshots as one checkpoint. The source workbook remains intact during import, so it is the migration fallback until reconciliation and controlled-workbook cutover are accepted.
