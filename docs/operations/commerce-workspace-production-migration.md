---
id: cp-operations-commerce-workspace-production-migration
title: Commerce workspace production migration
summary: Plan-first selective DEV-to-PROD migration for French Florist, AG Alchemy, and Test Pro Bakery Bites.
status: active
kind: operations-runbook
area: operations
tags: [operations, commerce, migration, production, railway]
app_visible: false
---

# Commerce workspace production migration

This runbook moves the approved app-owned CRM catalog, one representative
product image, warehouse configuration, and pack configuration from the
verified Railway development database into the three existing production
workspaces. It does not clone either database.

The tool is hard-bound to development database identity
`750aa268-0e31-4065-a99c-4016e4d4fab1` and production database identity
`0474a18c-649c-491b-bea1-7da006d21d81`. It also checks the exact existing
source and target organization, pipeline, and board UUIDs compiled in
`scripts/migrate-commerce-workspaces-to-production.mjs`.

The confirmed production owner remains
`jarrett@suburbiasandwichco.com`. `jarrett@bposupplychain.com` is an email
alias, not a production `app_users` row. The migration refuses to invent it or
copy it as a user.

## Included data

The reviewed DEV selection had these totals. A new plan calculates a fresh
count fingerprint and source-state digest, so drift is visible before apply.

| Category | Reviewed rows |
| --- | ---: |
| Product categories | 39 |
| CRM organizations | 1,994 |
| CRM contacts / source aliases | 3 / 6 |
| CRM products | 487 |
| Current representative images | 425 (111,120,166 content bytes) |
| Credential-free sales-channel placeholders | 4 |
| Product mappings / channel states | 487 / 493 |
| CRM-organization external identifiers | 2,028 |
| Catalog-purpose variant pack mappings | 52 |
| Warehouses / locations | 3 / 39 |
| Packaging materials / stock rows | 16 / 12 |
| Pack profiles / versions / relationships / recipes | 94 / 97 / 40 / 46 |
| Product barcodes / legacy package profiles | 5 / 22 |

Every new UUID and Global ID is allocated in production. Foreign keys,
source keys, identity keys, and safe JSON identifiers are remapped to those
new identities. Source SuiteCRM IDs, sheet coordinates, SuiteCRM sync state,
and candidate Global IDs are not copied. Each CRM row receives a deterministic
target SuiteCRM identity, a freshly computed canonical source hash, `pending`
projection state, and exactly one idempotent target `sync_outbox` projection.

## Explicit exclusions

The tool never selects or copies:

- commerce credentials, encryption material, credential references, or
  provider external-account IDs;
- provider cursors, continuation secrets, backfill sessions, high-watermarks,
  webhook payloads, read attempts, leases, or intake payload evidence;
- canonical orders, order revisions, fulfillment history, inventory snapshot
  evidence, reservations, cartonization evidence, or immutable provider
  attempts/effects;
- source SuiteCRM native IDs and source outbox work, meetings, interactions,
  opportunities, leads, or campaigns. Target CRM rows deliberately receive
  new target SuiteCRM identities and queued target outbox projections;
- carrier accounts, carrier credentials, printers, print agents, or shipping
  labels;
- Shopify checkout-purpose pack mappings, which depend on an independently
  verified provider account and ready CarrierService configuration;
- the AG mock commerce account, synthetic AG warehouse, disabled E2E pipeline,
  replay fixture customers, or the Test John Doe fixture;
- historical image galleries. Exactly one current representative image per
  product is selected, preferring the current primary and then latest
  revision.

## Required release and cutover gates

Do not apply until all of these are true:

1. The same approved application revision and migrations are deployed to DEV
   and PROD.
2. History migrations 0349 and 0350 are present. New accounts use immutable
   `new_orders_only` history with a frozen ingestion floor unless an operator
   explicitly chooses a supported bounded history mode during reconnection.
3. Storage guard migration 0351 and the append-only follow-up storage guard
   are present. The tool checks the payload
   redaction column, history-exclusion columns, and all retention functions by
   capability rather than trusting migration filenames.
4. Migration safety migration 0353 is present in both databases. It supplies
   the source cutover fences, target provider-identity fences, and immutable
   receipt boundary.
5. A restorable production backup/PITR boundary is recorded.
6. Scale every DEV web and worker service that can write these workspaces to
   zero, or stop those services through the approved Railway operator process.
   Do not rely on Paused controls alone. Keep writers stopped through apply.
7. Every selected DEV store has an explicit Paused control, is effectively not
   running, and has a `frozen` v2 cutover fence. It must also have no live read
   lease, unexpired available continuation, actionable webhook (including
   `failed` or `dead_letter`), pending/claimed/unknown external effect, dirty
   Shopify order, catalog, or inventory reconciliation target; active,
   uncertain, failed, or dead-letter intake/provider attempt; held
   catalog/image/inventory job; or non-current/pending order-revision work.
8. Every target remains the exact existing organization/pipeline/board
   scaffold with an active owner membership, contains zero scoped app-owned
   CRM/operations/order/project/board data beyond that reviewed scaffold, and
   has the exact configuration baseline recorded in the plan.
9. Independent source and target endpoint SHA-256 bindings have been reviewed
   and pinned in addition to the in-database deployment identities.
10. The reviewed plan reports `applyReady: true`.

At the September 4 reviewed snapshot, the source was **not** ready: four store
controls were running, 304 AG Shopify webhook receipts were actionable, and
two AG external effects needed resolution. No active read leases or unexpired
available continuations remained. Treat that observation as stale until a new
plan proves otherwise. A plan is read-only and safe to run in this state;
apply fails closed.

After DEV writers are stopped and all source work is drained or resolved, add
one frozen fence per selected account in a single reviewed source transaction.
Use the compiled source organization/account UUIDs from the script, the exact
v2 migration name, the confirmed owner, and an operator reason. Do not release
these fences until apply and postflight are complete:

```sql
BEGIN;
INSERT INTO operations_commerce_workspace_migration_cutover_fences AS fence (
  organization_id, integration_account_id, migration_name, state,
  frozen_by, reason
) VALUES
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   '03696a20-aaf4-4049-b0e3-051d9b937749'::uuid,
   'commerce-workspace-production-migration-v2', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   'da56c6d6-fddd-47c0-bf26-66cdfc42ae2c'::uuid,
   'commerce-workspace-production-migration-v2', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('ae747fcb-eb5f-426c-afff-ee56cf7aeb90'::uuid,
   'c13e4e64-edae-4e73-9ae0-c116c1419688'::uuid,
   'commerce-workspace-production-migration-v2', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('c6c8e6e7-fffa-4969-9526-e99da0ab2754'::uuid,
   '28038134-b624-4b52-8518-e9740785e5c3'::uuid,
   'commerce-workspace-production-migration-v2', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover')
ON CONFLICT (organization_id, integration_account_id) DO UPDATE
SET migration_name = EXCLUDED.migration_name,
    state = 'frozen',
    frozen_by = EXCLUDED.frozen_by,
    frozen_at = clock_timestamp(),
    released_by = NULL,
    released_at = NULL,
    reason = EXCLUDED.reason,
    updated_at = clock_timestamp()
WHERE fence.migration_name = EXCLUDED.migration_name;

SELECT organization_id, integration_account_id, migration_name, state,
       frozen_by, frozen_at
FROM operations_commerce_workspace_migration_cutover_fences
WHERE migration_name = 'commerce-workspace-production-migration-v2'
ORDER BY organization_id, integration_account_id;

-- Commit only after this transaction shows the four exact frozen rows above.
COMMIT;
```

Review these four literal identities against `WORKSPACES`, inspect the affected
rows before commit, and rerun the plan. These fences are not a substitute for
stopping DEV writers.

## Create and review a private plan

Obtain the two database URLs through the approved Railway operator session.
Do not paste or log them. In a separate trusted review, calculate the endpoint
fingerprint for each exact protocol/host/port/database/user tuple and pin the
two different values. Passwords are excluded from this fingerprint, so normal
credential rotation does not change it. The in-database identity remains a
second, independent boundary. Choose a secure local directory; the tool writes
the output atomically with mode `0600` and refuses to overwrite an existing
file.

```bash
SOURCE_DATABASE_URL='<development PostgreSQL URL>' \
TARGET_DATABASE_URL='<production PostgreSQL URL>' \
SOURCE_DATABASE_ENDPOINT_SHA256='<reviewed source endpoint fingerprint>' \
TARGET_DATABASE_ENDPOINT_SHA256='<reviewed target endpoint fingerprint>' \
node scripts/migrate-commerce-workspaces-to-production.mjs plan \
  --actor jarrett@suburbiasandwichco.com \
  --images current \
  --output '/secure/operator/path/commerce-migration-plan.json'
```

Review the source and target identities and endpoint bindings, each table
count, exclusions, account dispositions, every source blocker, the exact
target emptiness scan, target configuration baseline digest, retention
capabilities, production database and commerce-evidence relation sizes, guard
health, `countFingerprint`, and `manifestDigest`. The manifest contains only
safe counts, digests, public integration metadata, and blocker summaries; it
contains no row payload or credential.

## Apply the exact reviewed plan

Apply requires the reviewed digest as a second explicit input. It rechecks
both databases, every scaffold, source quiescence, capabilities, counts, and
the complete source-state digest before the first target insert.

```bash
SOURCE_DATABASE_URL='<same development PostgreSQL URL>' \
TARGET_DATABASE_URL='<same production PostgreSQL URL>' \
SOURCE_DATABASE_ENDPOINT_SHA256='<same reviewed source endpoint fingerprint>' \
TARGET_DATABASE_ENDPOINT_SHA256='<same reviewed target endpoint fingerprint>' \
node scripts/migrate-commerce-workspaces-to-production.mjs apply \
  --actor jarrett@suburbiasandwichco.com \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --confirm-digest '<reviewed manifestDigest>' \
  --mapping-output '/secure/operator/path/commerce-migration-mapping.json'
```

Each workspace is serialized with a production advisory lock and its own
`SERIALIZABLE` transaction. The source remains in one repeatable-read,
read-only transaction while NOWAIT share locks hold every selected and
source-work table. The tool compares the target configuration to the reviewed
plan immediately before insert, so target drift fails before that workspace is
changed. The immutable migration receipt commits atomically with workspace
data, provider fences, target SuiteCRM outbox rows, image hashes, and the safe
source-to-target UUID/Global-ID mapping. An exact rerun returns
`already_applied` only if the same reviewed receipt exists and its full
materialization still validates; partial or unreceipted target data fails
closed.

## Provider reconnection

Apply creates four empty-configuration, disabled accounts with no external
provider identity, no credential reference, credential generation zero,
receipt intake off, an explicit Paused store-sync control, and a durable
provider-identity fence. Imported external identifiers remain `stale` until
the corresponding eligible provider account is freshly verified.

- French Florist Shopify production and AG Faire production may be reconnected
  only through ClawPilot's supported connection workflow. The credential write
  hashes the freshly observed provider external-account identity, locks and
  verifies the migration fence, then writes and activates the account in the
  same transaction. A missing identity, hash mismatch, provider/environment
  mismatch, or ineligible fence rejects the reconnect before migrated mappings
  become authoritative.
- AG Shopify and Test Pro Bakery Bites Shopify are sandbox identities. Keep
  them disabled and disconnected in production unless provider evidence proves
  a production-capable identity. Never relabel a sandbox account as production.
- Choose and freeze the production history policy during the supported
  connection workflow before starting reads. Do not copy DEV history policy,
  cursor, webhook, or high-watermark state.
- Run one account at a time. Before enabling the next account, confirm the
  retention health backlog is bounded and one polling cycle did not produce
  unexplained intake or inventory-evidence growth.

## Postflight

For each target:

1. Confirm the immutable migration receipt and its manifest and receipt
   identity digests.
2. Confirm the migrated table counts match the mapping artifact.
3. Confirm all placeholders are disabled, have no external account or
   credential reference, use generation zero, have receipt intake off, and are
   explicitly Paused/effectively stopped.
4. Confirm no order-history policy exists until the supported provider
   connection workflow freezes one.
5. Confirm the production owner remains
   `jarrett@suburbiasandwichco.com` and no BPO alias user was created.
6. Confirm the exact target SuiteCRM outbox count and canonical CRM source
   hashes match the receipt, then allow the ordinary outbox worker to project
   them.
7. Validate representative image hashes and byte lengths and visually sample
   each workspace's product, warehouse, and pack configuration.
8. Before and after one controlled polling cycle, record
   `operations_commerce_storage_bloat_health(...)`, intake backlog rows/bytes,
   legacy capture backlog, inventory alias backlog, inventory level backlog,
   level row estimate, and level storage bytes. Stop if backlogs grow without
   a successful bounded maintenance drain.

After the maintenance pass, every eligible backlog counter should be zero and
every `Truncated` flag should be false. An unchanged inventory poll must add no
level or inventory-item-location evidence rows; a changed poll may add one new
immutable level set. Do not connect another store if the health result is
truncated, an eligible backlog remains, intake reads are failing/held, or the
level relation grows on an unchanged poll.

Run these checks in a read-only transaction (replace neither identity nor
target IDs):

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT value->>'id' AS database_identity
FROM app_settings
WHERE key = 'deployment.database.identity';

WITH target(organization_id) AS (
  VALUES
    ('33785418-9927-4e10-a492-d3a44b9b6f21'::uuid),
    ('3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid),
    ('c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid)
)
SELECT account.organization_id, account.global_id, account.provider,
       account.environment, account.status, account.external_account_id,
       account.credential_reference, account.commerce_credential_generation,
       account.receipt_intake_enabled, control.desired_state,
       control.explicit_choice,
       operations_commerce_store_sync_is_running(
         account.organization_id, account.id
       ) AS effective_running
FROM operations_integration_accounts account
JOIN target ON target.organization_id = account.organization_id
LEFT JOIN operations_commerce_store_sync_controls control
  ON control.organization_id = account.organization_id
 AND control.integration_account_id = account.id
WHERE account.integration_type = 'commerce'
ORDER BY account.organization_id, account.provider, account.environment;

SELECT organization_id, event_key,
       payload->>'manifestDigest' AS manifest_digest,
       payload->>'receiptIdentityDigest' AS receipt_identity_digest,
       payload#>>'{source,sourceStateDigest}' AS source_state_digest
FROM audit_events
WHERE event_type = 'operations.commerce_workspace_migration.completed'
ORDER BY organization_id;

SELECT email, status FROM app_users
WHERE email IN (
  'jarrett@suburbiasandwichco.com',
  'jarrett@bposupplychain.com'
)
ORDER BY email;

SELECT organization_id, count(*) AS history_policy_count
FROM operations_commerce_order_history_policies
WHERE organization_id IN (
  '33785418-9927-4e10-a492-d3a44b9b6f21'::uuid,
  '3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid,
  'c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid
)
GROUP BY organization_id;

SELECT operations_commerce_storage_bloat_health(1000) AS storage_health;

SELECT 'operations_commerce_intake_read_intents' AS relation_name,
       count(*) AS row_count,
       pg_total_relation_size(
         'operations_commerce_intake_read_intents'::regclass
       ) AS total_bytes
FROM operations_commerce_intake_read_intents
UNION ALL
SELECT 'operations_commerce_inventory_captures', count(*),
       pg_total_relation_size(
         'operations_commerce_inventory_captures'::regclass
       )
FROM operations_commerce_inventory_captures
UNION ALL
SELECT 'operations_commerce_inventory_sync_runs', count(*),
       pg_total_relation_size(
         'operations_commerce_inventory_sync_runs'::regclass
       )
FROM operations_commerce_inventory_sync_runs
UNION ALL
SELECT 'operations_commerce_inventory_levels', count(*),
       pg_total_relation_size(
         'operations_commerce_inventory_levels'::regclass
       )
FROM operations_commerce_inventory_levels;

COMMIT;
```

The September 4 read-only production baseline was 194,410,175 database bytes, with
about 956.7 MB of a 5 GB Railway volume used and about 4,043.3 MB headroom.
The selected image content was about 106 MiB; allow at least 150 MiB plus
normal PostgreSQL/WAL overhead. Recheck current storage immediately before
apply because those figures are observational and can drift.

## Rollback and recovery

A failure before a workspace commit rolls back that workspace, including
allocated UUID/Global-ID registry rows, outbox rows, provider fences, and its
receipt. Workspaces commit independently, so a later failure can leave earlier
workspaces correctly committed. After understanding and correcting the cause,
rerun the same exact manifest and digest: committed workspaces validate as
`already_applied`, while the failed workspace is retried. Do not create a new
plan merely to bypass a partial failure.

If apply committed data but the mapping file was interrupted, recover it only
from the immutable target receipts. This command needs no source URL, but it
still requires the reviewed manifest/digest and independently pinned target
endpoint:

```bash
TARGET_DATABASE_URL='<same production PostgreSQL URL>' \
TARGET_DATABASE_ENDPOINT_SHA256='<same reviewed target endpoint fingerprint>' \
node scripts/migrate-commerce-workspaces-to-production.mjs receipt-export \
  --actor jarrett@suburbiasandwichco.com \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --confirm-digest '<reviewed manifestDigest>' \
  --mapping-output '/secure/operator/path/recovered-commerce-mapping.json'
```

The recovered file is an atomic `0600` artifact and the command refuses to
overwrite an existing path. It validates every receipt mapping, image,
provider fence, target CRM identity, and SuiteCRM outbox projection before
writing. Receipt rows cannot be updated or deleted.

Do not manually delete migrated rows. Several image and operational tables are
immutable, and ad-hoc deletion would destroy the audit boundary. After any
committed migration, rollback means restore the recorded production backup/PITR
boundary into an isolated recovery database, verify the target receipt and
count fingerprint there, and use the approved Railway restore/cutover process.
If the data is correct but should not go live, leave provider placeholders
disabled/Paused and use an audited retirement change rather than destructive
cleanup.

Before approving a restored database for cutover, run the same read-only SQL
above and additionally confirm the restored point predates every migration
receipt:

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT count(*) AS migration_receipts
FROM audit_events
WHERE event_type = 'operations.commerce_workspace_migration.completed';
SELECT value->>'id' AS database_identity
FROM app_settings
WHERE key = 'deployment.database.identity';
COMMIT;
```

The expected rollback result is zero migration receipts and production database
identity `0474a18c-649c-491b-bea1-7da006d21d81`. A restored database with a
different identity or any migration receipt is not the recorded pre-apply
boundary and must not be promoted.

Run the focused offline contract gate with:

```bash
npm run test:commerce-workspace-migration
```
