---
id: cp-ops-suitecrm
title: SuiteCRM Railway Runbook
summary: SuiteCRM service topology, credentials, Global ID fields, hierarchy, scheduler, upgrades, rollback, and native administration.
status: active
kind: operations-runbook
area: operations
tags: [suitecrm, railway, mariadb, oauth, migration]
app_visible: false
---

# SuiteCRM Railway Runbook

## Topology

Each Railway environment has a `suitecrm` service, a dedicated MariaDB service, and a SuiteCRM volume mounted at `/var/lib/suitecrm`. SuiteCRM does not share ClawPilot's Postgres database. The ClawPilot service reaches the API through the private `http://suitecrm.railway.internal:<port>` base URL and OAuth2 client credentials. Owner/admin browser access uses SuiteCRM's separate public HTTPS origin.

`SUITECRM_BASE_URL` is backend-only and must remain on Railway's private network. Never place it in a browser response or public environment variable. `SUITECRM_PUBLIC_URL` is the only browser destination and must be the exact canonical origin, with no trailing slash, path, credentials, query, or fragment. ClawPilot uses `https://crm.eigenracing.com` in production and `https://dev.crm.eigenracing.com` in development. SuiteCRM is a standalone service and must not be nested under the ClawPilot `aiapp` hostname.

The image is built from `services/suitecrm/`. It verifies the official SuiteCRM 8.10.1 release digest, serves `public/` with Apache, runs the legacy scheduler every minute, and continuously restarts the Symfony Messenger worker.

Container boot also idempotently installs the ClawPilot `Global ID` custom field on Accounts, Contacts, Leads, Opportunities, Meetings, Notes, and Campaigns. The field is named `global_id_c` in SuiteCRM metadata, labeled `Global ID`, added to native detail layouts, and enabled for reporting and unified search.

## Required Variables

SuiteCRM service:

- `SUITECRM_DB_HOST`, `SUITECRM_DB_PORT`, `SUITECRM_DB_NAME`
- `SUITECRM_DB_USER`, `SUITECRM_DB_PASSWORD`
- `SUITECRM_PUBLIC_URL`
- `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`
- `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`

ClawPilot service:

- `CRM_ENABLED=1`
- `SUITECRM_BASE_URL=http://suitecrm.railway.internal:<port>`
- the same exact `SUITECRM_PUBLIC_URL`
- the same `SUITECRM_ADMIN_USER`
- `SUITECRM_ADMIN_PORTAL_URL`, pointing to that environment's Railway `suitecrm` Variables page
- the same `SUITECRM_CLIENT_ID` and `SUITECRM_CLIENT_SECRET`

Credentials must remain Railway secrets. The container hashes the OAuth client secret before upserting it into SuiteCRM and never prints the secret.

## Organization Hierarchy

Railway Postgres is authoritative for ClawPilot users, pipeline ownership, CRM identities, and organization relationships. SuiteCRM is the native CRM projection of those records; Google Sheets is the controlled reporting and Opportunities input surface.

Each user has one workspace organization. The configured owner organization is the root, invited users receive member organizations beneath their inviter, and every pipeline belongs to its owner's workspace organization. Customer organizations are children of that pipeline organization, and contacts reference their customer organization. Owner/admin users can inspect and reparent member organizations from the CRM hierarchy panel.

Set `CLAWPILOT_ROOT_ORGANIZATION_NAME` to the same company name in development and production before migration `0021_crm_identity_and_organization_hierarchy.sql` is applied. Workspace accounts use global deterministic SuiteCRM IDs. Customer organizations use normalized names within a pipeline; contacts use normalized email, or normalized name plus organization when email is absent. Workbook row numbers are not identities.

Migration `0021` consolidates existing organization/contact duplicates, remaps dependent records, and queues idempotent SuiteCRM deletions for the redundant native records. It deliberately does not deduplicate opportunities or interactions because repeated deals and touchpoints may be valid.

## Native Punchout

`GET /api/crm/punchout` requires an active ClawPilot session and an `owner` or `admin` role. It accepts no query parameters or caller-provided destination. A successful request returns a temporary redirect to `SUITECRM_PUBLIC_URL` with `Cache-Control: no-store`; no SuiteCRM API URL, OAuth credential, or user-selected URL is exposed.

The CRM access dialog shows the non-secret native username and links administrators to the protected Railway variable that holds `SUITECRM_ADMIN_PASSWORD`. The password is never returned by a ClawPilot API or rendered in the browser. After signing in, change the native password from the SuiteCRM user profile when a rotation is required, then update the Railway secret to the same value so service recovery remains accurate.

The punchout opens SuiteCRM's native login/session surface. PHP sessions are cookie-only with `Secure`, `HttpOnly`, `SameSite=Lax`, and strict mode enabled. This slice does not establish cross-application SSO.

## Boot Configuration Refresh

The SuiteCRM volume persists application configuration across deploys. On every container boot, the entrypoint validates `SUITECRM_PUBLIC_URL` before starting SuiteCRM and atomically refreshes a ClawPilot-managed block in `public/legacy/config_override.php`:

- `site_url` is set to the exact public HTTPS origin.
- `trusted_hosts` is replaced with anchored expressions for the public hostname, `suitecrm.railway.internal`, and Railway's `healthcheck.railway.app` probe host.
- unrelated persisted override settings remain unchanged.

The managed block is inserted last so stale installer values cannot override it. Startup fails closed if the existing override is unreadable, has an incomplete managed block, contains non-whitespace after its closing PHP tag, or cannot be replaced with `www-data:www-data` ownership and mode `0640`.

## First Install

1. Create MariaDB and the SuiteCRM service in development.
2. Attach the SuiteCRM volume at `/var/lib/suitecrm` before the first deployment.
3. Create the SuiteCRM public Railway domain, set its exact HTTPS origin as `SUITECRM_PUBLIC_URL` on both services, and set the private service URL only as ClawPilot's `SUITECRM_BASE_URL`.
4. Deploy and verify the public SuiteCRM root, private token endpoint, scheduler, Messenger logs, and persisted runtime override.
5. Enable CRM variables on the ClawPilot development service and apply migration `0020_crm_gateway_and_reporting.sql`.
6. Inspect and import the source workbook, drain the SuiteCRM and Google outboxes, then compare entity counts and pipeline totals before projecting the controlled workbook.
7. Repeat in production only after development reconciliation succeeds.

After the Global ID metadata is live, refresh historical records and meeting subpanel links from each environment's ClawPilot service shell:

```bash
CLAWPILOT_BACKFILL_CONFIRM=global-id-v1 npm run crm:backfill-suitecrm
```

Drain `/api/crm/outbox/process`, then verify an exact V8 filter on `global_id_c` and inspect a meeting's Contacts and Accounts subpanels. The backfill is transactionally queued and may be rerun; unchanged payloads are not duplicated.

After deploying the native Note-to-Contact relationship contract, queue the historical Note repair from each environment using an explicit audit actor:

```bash
CLAWPILOT_BACKFILL_CONFIRM=interaction-contacts-v1 \
CLAWPILOT_BACKFILL_ACTOR=jarrett@suburbiasandwichco.com \
npm run crm:backfill-suitecrm-interaction-contacts
```

The repair keeps the Account as the Note parent and adds both SuiteCRM's native `contact_id` and `contact` relationship. Drain `/api/crm/outbox/process`, then confirm the Contact field and relationship subpanel on a historical Note.

The operator-approved unresolved interaction cleanup is deliberately limited to two production Global IDs and their verified development source fingerprints. Run it only with the explicit deletion guard:

```bash
CLAWPILOT_DELETE_CONFIRM=unresolved-interactions-v1 \
CLAWPILOT_DELETE_ACTOR=jarrett@suburbiasandwichco.com \
npm run crm:delete-unresolved-interactions
```

The cleanup cancels stale upserts, queues native SuiteCRM deletion, removes active Postgres records and generated workbook projections, disables their short links, and retires every matched Global ID so it can never be allocated again.

After a public-domain change, update `SUITECRM_PUBLIC_URL` on both services and redeploy SuiteCRM before ClawPilot. Confirm the managed `site_url` and trusted-host entries, then test `/api/crm/punchout` as an owner/admin and confirm a member receives `403`.

## Upgrade Rule

The service never upgrades a persisted SuiteCRM application implicitly. A version mismatch fails closed. Take a MariaDB snapshot and SuiteCRM volume snapshot, follow the official SuiteCRM upgrade procedure, verify the API and workers, then update the version marker deliberately.

## Rollback

Disable `CRM_ENABLED` or stop CRM writes in ClawPilot, retain the Postgres outbox, and restore the MariaDB and SuiteCRM volume snapshots as one checkpoint. The source workbook remains intact during import, so it is the migration fallback until reconciliation and controlled-workbook cutover are accepted.
