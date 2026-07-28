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

Container boot also idempotently installs the ClawPilot `Global ID` custom field on Accounts, Contacts, AOS Products, Leads, Opportunities, Meetings, Calls, Notes, Campaigns, and Users. The field is named `global_id_c` in SuiteCRM metadata, labeled `Global ID`, and added to native detail and list layouts. Business-record modules are available to reporting and unified search; boot fails if any managed module or its Global ID search field remains unavailable. AOS Products is also kept enabled in SuiteCRM's persisted global-search module selection so Product Global ID lookup works without an administrator repair, while other module visibility remains administrator-controlled. Users retain their administrator-module search boundary. Notes also receive a reportable, audited `Occurred At` DateTime field named `occurred_at_c` on native edit, detail, and list layouts; it stores the interaction's business timestamp separately from SuiteCRM's system creation time.

ClawPilot does not project AOS Quotes or AOS Products Quotes. Container boot therefore removes the stock AOS Product **Purchases** subpanel instead of presenting an empty query as though it were canonical order history. A future owned relationship must use canonical Operations order/shipment identities and its own contract before that layout can return.

Every ClawPilot application user owns a permanent `gu#######` identity in Postgres. When an administrator maps that person to a native SuiteCRM User, ClawPilot queues an idempotent `global_id_c` projection through the SuiteCRM outbox. The worker refuses to overwrite a different permanent ID or duplicate one onto a second SuiteCRM User. The person's CRM Contact remains a separate `gc#######` record.

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
- SuiteCRM's reserved base-currency identity `-99` is fixed to USD with the USD name and symbol.
- unrelated persisted override settings remain unchanged.

The managed block is inserted last so stale installer values cannot override it. Startup fails closed if the existing override is unreadable, has an incomplete managed block, contains non-whitespace after its closing PHP tag, or cannot be replaced with `www-data:www-data` ownership and mode `0640`.

ClawPilot Product projections include SuiteCRM's native `currency_id`. USD resolves to the fixed `-99` base identity. Every non-USD workspace default must first exist as exactly one active native SuiteCRM Currency with an administrator-maintained conversion rate. The workspace-setting command preflights that requirement and fails with an actionable conflict before saving. ClawPilot never creates a SuiteCRM currency, guesses a rate, changes a Product amount, or substitutes the workspace default for an existing Product's record currency.

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

### Native activity projection

Migration `0095_crm_native_activity_projection.sql` runs through the normal `npm run db:migrate` predeploy path. It adds the native activity module, status, and duration fields to `crm_interactions`; repairs imported workbook interaction timestamps from the original `source_payload.Date`; normalizes Calls and unlinked Meeting/In Person interactions; and queues one `reproject_record` operation per affected interaction.

The matching worker processes each reproject in this order:

1. Delete the interaction's legacy SuiteCRM Note by its stable SuiteCRM ID.
2. Create the native Call or Meeting with the same permanent `gi` Global ID, business timestamp, status, duration, assignment, and verified relationships.
3. For a companion `gi` history row already linked to a canonical `gm` Meeting, stop after deleting the duplicate Note. The `gm` Meeting remains the only native activity projection.

Do not run a separate ad hoc production update for this conversion. Deploy the SuiteCRM metadata and application worker that understand Calls and `reproject_record`, run the normal migration once in development, and drain `/api/crm/outbox/process`. Verify:

- a planned Call appears under the related Account's or Contact's **Activities**;
- held and not-held Calls appear under **History**;
- native direction and duration match the ClawPilot interaction;
- an unlinked Meeting/In Person interaction appears as one native Meeting;
- a canonical `gm` Meeting has no duplicate `gi` Note or second native Meeting;
- workbook-imported activity dates still match their original source `Date`.

Repeat the same migration, drain, and checks in production only after development passes.

### Duplicate Contact consolidation

Migration `0096_crm_contact_identity_aliases.sql` preserves workbook source keys, former identity keys, and retired public `gc` references when two Contact rows represent the same person. Contact staging resolves those aliases before creating a row, safely enriches a single name-only Contact when an email is later supplied, and treats workbook fields as enrichment so an older sheet row cannot erase a stronger CRM email or title.

Use the guarded merge command only after migration `0096` and the matching application worker are deployed. It is a full transactional dry run unless `--apply`, an active audit actor, and the exact confirmation token are all supplied:

```bash
npm run crm:merge-contacts -- \
  --survivor gc1234567 \
  --duplicate gc7654321

npm run crm:merge-contacts -- \
  --survivor gc1234567 \
  --duplicate gc7654321 \
  --apply \
  --actor operator@example.com \
  --confirm merge:gc7654321:into:gc1234567
```

The merge keeps the survivor's local ID, public reference, and SuiteCRM ID; fills only missing survivor data; rewires local relationships; keeps the duplicate public reference as a permanent alias; and records an append-only tombstone. SuiteCRM work is dependency-ordered: update the survivor, update affected activity relationships, then delete the duplicate Contact. If the validation finds conflicting emails, organizations, names, in-flight work, an app-user identity, an unknown Contact foreign key, or an activity whose relationship payload cannot be reconstructed safely, the transaction stops without mutation.

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

The July production-hygiene cleanup for the two approved test interactions, their linked test meeting, and the obsolete pre-reconciliation workbook failure is separately guarded and auditable:

```bash
CLAWPILOT_RETIRE_CONFIRM=production-test-data-v1 \
CLAWPILOT_RETIRE_ACTOR=jarrett@suburbiasandwichco.com \
npm run crm:retire-production-test-data
```

This command verifies exact Global IDs and subjects before changing data, queues SuiteCRM record deletion, retires all affected Global IDs and short links, and records the removed dead outbox payload in `audit_events`. The historical Google Calendar provider ID is retained as audit evidence because the event is already in the past; the command does not use a current user's Calendar connection to mutate an event created under an older organizer selection.

After a public-domain change, update `SUITECRM_PUBLIC_URL` on both services and redeploy SuiteCRM before ClawPilot. Confirm the managed `site_url` and trusted-host entries, then test `/api/crm/punchout` as an owner/admin and confirm a member receives `403`.

## Upgrade Rule

The service never upgrades a persisted SuiteCRM application implicitly. A version mismatch fails closed. Take a MariaDB snapshot and SuiteCRM volume snapshot, follow the official SuiteCRM upgrade procedure, verify the API and workers, then update the version marker deliberately.

## Rollback

Disable `CRM_ENABLED` or stop CRM writes in ClawPilot, retain the Postgres outbox, and restore the MariaDB and SuiteCRM volume snapshots as one checkpoint. The source workbook remains intact during import, so it is the migration fallback until reconciliation and controlled-workbook cutover are accepted.
