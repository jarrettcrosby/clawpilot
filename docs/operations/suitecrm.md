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

The sole Railway production environment has a `suitecrm` service, a dedicated MariaDB service, and a SuiteCRM volume mounted at `/var/lib/suitecrm`. SuiteCRM does not share ClawPilot's Postgres database. The ClawPilot production service reaches the V8 API through the private `http://suitecrm.railway.internal:<port>` base URL and OAuth2 client credentials. SuiteCRM 8 native media is not exposed by V8, so the optional native Product-image projection uses a separate least-privilege SuiteCRM user and the same cookie-session plus CSRF flow used by SuiteCRM's own UI. Owner/admin browser access uses SuiteCRM's separate public HTTPS origin. Local, remote-local, and Vercel preview runtimes must not receive these credentials or act as SuiteCRM workers.

`SUITECRM_BASE_URL` is backend-only and must remain on Railway's private network. Never place it in a browser response or public environment variable. `SUITECRM_PUBLIC_URL` is the only browser destination and must be the exact canonical production origin, with no trailing slash, path, credentials, query, or fragment. ClawPilot uses `https://crm.eigenracing.com`. The former `https://dev.crm.eigenracing.com` origin is retired migration history, not an active service or deployment target. SuiteCRM is a standalone service and must not be nested under the ClawPilot `aiapp` hostname.

The image is built from `services/suitecrm/`. It verifies the official SuiteCRM 8.10.1 release digest, serves `public/` with Apache, runs the legacy scheduler every minute, and continuously restarts the Symfony Messenger worker.

Container boot also idempotently installs the ClawPilot `Global ID` custom field on Accounts, Contacts, AOS Products, Leads, Opportunities, Meetings, Calls, Notes, Campaigns, and Users. The field is named `global_id_c` in SuiteCRM metadata, labeled `Global ID`, and added to native detail and list layouts. Business-record modules are available to reporting and unified search; boot fails if any managed module or its Global ID search field remains unavailable. AOS Products is also kept enabled in SuiteCRM's persisted global-search module selection so Product Global ID lookup works without an administrator repair, while other module visibility remains administrator-controlled. Users retain their administrator-module search boundary. Notes also receive a reportable, audited `Occurred At` DateTime field named `occurred_at_c` on native edit, detail, and list layouts; it stores the interaction's business timestamp separately from SuiteCRM's system creation time. AOS Products receive the native non-database image field `clawpilot_image_c`, backed by SuiteCRM's `private-images` media store and shown on native detail and edit layouts. Boot verifies the field type, storage metadata, 2 MiB limit, thumbnail configuration, and layout placement before reporting readiness.

ClawPilot does not project AOS Quotes or AOS Products Quotes. Container boot therefore removes the stock AOS Product **Purchases** subpanel instead of presenting an empty query as though it were canonical order history. A future owned relationship must use canonical Operations order/shipment identities and its own contract before that layout can return.

Every ClawPilot application user owns a permanent `gu#######` identity in Postgres. When an administrator maps that person to a native SuiteCRM User, ClawPilot queues an idempotent `global_id_c` projection through the SuiteCRM outbox. The worker refuses to overwrite a different permanent ID or duplicate one onto a second SuiteCRM User. The person's CRM Contact remains a separate `gc#######` record.

## Required Variables

SuiteCRM service:

- `SUITECRM_DB_HOST`, `SUITECRM_DB_PORT`, `SUITECRM_DB_NAME`
- `SUITECRM_DB_USER`, `SUITECRM_DB_PASSWORD`
- `SUITECRM_PUBLIC_URL`
- `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`
- `SUITECRM_CLIENT_ID`, `SUITECRM_CLIENT_SECRET`
- when native Product-image projection is being provisioned, the same exact `SUITECRM_MEDIA_USERNAME` and `SUITECRM_MEDIA_PASSWORD` used by ClawPilot
- when reverse Product-image ingestion is being provisioned, the same exact `SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID`, `SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET`, `SUITECRM_PRODUCT_IMAGE_READ_USERNAME`, and `SUITECRM_PRODUCT_IMAGE_READ_PASSWORD` used by ClawPilot

ClawPilot service:

- `CRM_ENABLED=1`
- `SUITECRM_BASE_URL=http://suitecrm.railway.internal:<port>`
- the same exact `SUITECRM_PUBLIC_URL`
- the same `SUITECRM_ADMIN_USER`
- `SUITECRM_ADMIN_PORTAL_URL`, pointing to production's Railway `suitecrm` Variables page
- the same `SUITECRM_CLIENT_ID` and `SUITECRM_CLIENT_SECRET`
- `SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED=1`, only after the native-media user and permissions below are ready
- `SUITECRM_MEDIA_USERNAME`, for a dedicated non-admin native-media user
- `SUITECRM_MEDIA_PASSWORD`, for that dedicated user
- `SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED=1`, only after the separate read principal, client, and ACL attestation below are ready
- `SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID` and `SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET`, for a dedicated read-only OAuth client
- `SUITECRM_PRODUCT_IMAGE_READ_USERNAME` and `SUITECRM_PRODUCT_IMAGE_READ_PASSWORD`, for a dedicated read-only SuiteCRM user
- `SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED=1`
- `SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION=suitecrm-product-image-read-acl-v2`
- `SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME`, exactly matching `SUITECRM_PRODUCT_IMAGE_READ_USERNAME`
- `SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID`, exactly matching `SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID`
- `SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME`, exactly matching `SUITECRM_PRODUCT_IMAGE_READ_USERNAME`

Credentials must remain Railway secrets. Native Product-image projection is disabled unless `SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED` equals exactly `1`. While disabled, the existing content-addressed legacy Product image URL is still projected through V8 and SuiteCRM outbox rows do not require media credentials. When enabled, the media username must be an active SuiteCRM user with `ROLE_USER` plus AOS Products view/edit and image-upload access; it must not reuse `SUITECRM_ADMIN_USER`, `SUITECRM_ADMIN_PASSWORD`, the installer account, OAuth client credentials, or the reverse-ingestion read credentials. The enabled path fails closed rather than falling back to those broader credentials when media credentials are missing or reused. `/api/health` reports native projection enablement, missing or invalid variables, credential conflicts, queue state, and the latest completed result including SuiteCRM's returned native media ID. The container hashes OAuth client secrets before upserting them into SuiteCRM and never prints a secret.

SuiteCRM container boot owns both image service principals. Supplying either credential in a principal group—or placing that feature's enable flag on the SuiteCRM service—makes the complete group mandatory. User passwords require at least 16 characters; the read client ID must be a UUID and its secret requires at least 32 characters. Boot rejects partial groups, invalid values, any credential value reused across the administrator, general V8 client, forward media principal, or reverse reader principal, and any username, role name, or client ID already owned by an object that lacks the exact ClawPilot management marker. It creates or repairs active non-admin users, resets their configured passwords without logging them, assigns each user exactly one dedicated direct ACL role, and removes Security Group memberships that could broaden effective access. Both roles disable every other SuiteCRM module. The forward role enables AOS Products access with only view/edit; list, delete, import, export, and mass-update are denied. The reverse role enables AOS Products access with only list/view; edit, delete, import, export, and mass-update are denied. SuiteCRM uses `edit` as its create permission, so reverse create is denied by the same `edit = none` override. The native private-media download route checks view access on its parent Product.

The reverse OAuth client is confidential, uses `client_credentials`, and is assigned only to the reverse reader user. Boot invalidates that client's previously issued tokens after reconciling the client, then queries every active ACL action, role membership, Security Group membership, user property, and OAuth property as hard postconditions. A missing Product image field, broadened role, shared managed role, extra OAuth client, or failed verification stops the container before Apache starts. The boot success line contains no username, password, client ID, or secret. Keep the existing ACL attestation variables on ClawPilot: they bind application readiness to the reviewed user/client even though SuiteCRM now converges and verifies the ACL mechanically.

Reverse Product-image ingestion is independently disabled unless `SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED` equals exactly `1`. Its dedicated OAuth client and SuiteCRM user may have only `list` and `view` on `AOS_Products`, view access to `clawpilot_image_c`, and view access to the private media object. Explicitly deny create, edit, delete, import, export, and mass-update. The read user/client/password/secret must differ from the administrator, general V8 client, and forward native-media credentials. After reviewing that ACL, bind the attestation variables to the exact username and client ID. Any missing value, stale attestation version, mismatched binding, or credential reuse makes the health readiness false and prevents the ingestion worker from reading SuiteCRM. The reverse worker writes only immutable ClawPilot observations, provenance, and snapshot fences; its database constraints keep `providerWrites=0`.

## Organization Hierarchy

Railway Postgres is authoritative for ClawPilot users, pipeline ownership, CRM identities, and organization relationships. SuiteCRM is the native CRM projection of those records; Google Sheets is the controlled reporting and Opportunities input surface.

Each user has one workspace organization. The configured owner organization is the root, invited users receive member organizations beneath their inviter, and every pipeline belongs to its owner's workspace organization. Customer organizations are children of that pipeline organization, and contacts reference their customer organization. Owner/admin users can inspect and reparent member organizations from the CRM hierarchy panel.

Set `CLAWPILOT_ROOT_ORGANIZATION_NAME` to the reviewed production company name before migration `0021_crm_identity_and_organization_hierarchy.sql` is applied. The retired hosted-development environment historically used the same value during migration rehearsal; that history does not create a second current configuration target. Workspace accounts use global deterministic SuiteCRM IDs. Customer organizations use normalized names within a pipeline; contacts use normalized email, or normalized name plus organization when email is absent. Workbook row numbers are not identities.

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

1. Complete container, migration, and integration tests against disposable local services with synthetic data and no production credential.
2. Create MariaDB and the SuiteCRM service in Railway production.
3. Attach the SuiteCRM volume at `/var/lib/suitecrm` before the first deployment.
4. Create the SuiteCRM public Railway domain, set its exact HTTPS origin as `SUITECRM_PUBLIC_URL` on both production services, and set the private service URL only as ClawPilot's `SUITECRM_BASE_URL`.
5. Deploy and verify the public SuiteCRM root, private token endpoint, scheduler, Messenger logs, and persisted runtime override.
6. Generate separate random credentials for the forward media user and reverse reader user/client. Put each complete credential group on the SuiteCRM service and deploy it. Confirm the boot log reports `SuiteCRM image service principals and exact ACLs are ready`; the container creates the two non-admin users, dedicated roles, and reverse OAuth client and fails boot if any exact postcondition is absent.
7. Put those same exact credentials only on the Railway production ClawPilot service. Review the two managed roles in native SuiteCRM, bind every `SUITECRM_PRODUCT_IMAGE_READ_*` attestation variable to the generated reverse user/client, then explicitly set `SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED=1` and `SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED=1` on ClawPilot.
8. Enable the remaining CRM variables on the ClawPilot production service and let the normal Railway predeploy path apply migration `0020_crm_gateway_and_reporting.sql`.
9. Inspect and import the source workbook, drain the SuiteCRM and Google outboxes, then compare entity counts and pipeline totals before projecting the controlled workbook.

### Native Product-image activation and proof

Enabling the forward native-media variables does not silently replay historical Product images. Queue one reviewed current primary image by permanent Product Global ID. The command is plan-first and binds approval to the exact Product, SuiteCRM record, asset revision, row version, and content SHA-256:

```bash
npm run crm:reproject-suitecrm-product-image -- --product gp0123456

CLAWPILOT_SUITECRM_IMAGE_REPROJECT_ACTOR=owner@example.com \
CLAWPILOT_SUITECRM_IMAGE_REPROJECT_CONFIRM='copy-the-exact-confirmation-from-the-plan' \
npm run crm:reproject-suitecrm-product-image -- \
  --product gp0123456 \
  --apply
```

The apply path requires an active owner or administrator in the Product's organization. It reuses the content-addressed image outbox identity, never races a processing lease, and is idempotent when the same work is already queued or when a completed native result already identifies the same media. Its outbox payload marks native projection as required, so disabled or invalid native configuration fails the job instead of recording a false success. The operator queue event and system completion event preserve the exact image fence, outbox attempt, action, and returned native media ID. Neither command performs a commerce-provider write.

After apply, let the normal SuiteCRM outbox poller drain the item. Check `/api/health` at `suiteCrmNativeProductImageProjection`: `status` must be `ready`, `dead` and `retrying` must be zero, and `latestResult.mediaId` must be a UUID with `action` equal to `attached` or `unchanged`. Open the same Product in native SuiteCRM and visually confirm the image. A rerun of the plan must report `alreadyProjected: true` for the same content hash.

For the reverse proof, confirm `/api/health` at `suiteCrmProductImageIngestion` reports `enabled: true`, `ready: true`, a current `completed` heartbeat, and `providerWrites: 0`. Change the test Product image in native SuiteCRM, let `/api/crm/integrations/process` complete the bounded discover/verify sweep, and verify a new immutable observation and provenance row appears with `importedPrimary` or `importedSecondary` incremented. Re-reading an unchanged image must increment neither import count nor provider writes; a deterministic ClawPilot filename is echo-suppressed.

After the Global ID metadata is live, refresh historical records and meeting subpanel links from the Railway production ClawPilot service shell:

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

Do not run a separate ad hoc production update for this conversion. Prove the migration and worker against a disposable PostgreSQL/SuiteCRM fixture, then deploy the SuiteCRM metadata and application worker that understand Calls and `reproject_record`. Let the normal Railway production predeploy path run the migration once and drain `/api/crm/outbox/process`. Verify:

- a planned Call appears under the related Account's or Contact's **Activities**;
- held and not-held Calls appear under **History**;
- native direction and duration match the ClawPilot interaction;
- an unlinked Meeting/In Person interaction appears as one native Meeting;
- a canonical `gm` Meeting has no duplicate `gi` Note or second native Meeting;
- workbook-imported activity dates still match their original source `Date`.

Record the production migration, drain, and checks as the release evidence. A Vercel preview or remote-local UI check cannot substitute for that Railway production evidence.

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

After deploying the native Note-to-Contact relationship contract, queue the historical Note repair from Railway production using an explicit audit actor:

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
