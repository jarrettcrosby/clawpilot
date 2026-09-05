---
id: cp-operations-commerce-workspace-production-migration
title: Sales and shipping workspace production migration
summary: Plan-first selective DEV-to-PROD sales and shipping migration for French Florist, AG Alchemy, and Test Pro Bakery Bites.
status: active
kind: operations-runbook
area: operations
tags: [operations, commerce, shipping, migration, production, railway]
app_visible: false
---

# Sales and shipping workspace production migration

This runbook moves the approved app-owned CRM catalog, one representative
product image, warehouse configuration, pack configuration, and the approved
sales and shipping connection identities from the
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
| Credential-free shipping placeholders | 4 |
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

- commerce or carrier credentials, account-number ciphertext, encryption
  material, credential references, provider external-account IDs, webhook
  secrets, tokens, cursors, or provider state;
- provider cursors, continuation secrets, backfill sessions, high-watermarks,
  webhook payloads, read attempts, leases, or intake payload evidence;
- canonical orders, order revisions, fulfillment history, inventory snapshot
  evidence, reservations, cartonization evidence, or immutable provider
  attempts/effects;
- source SuiteCRM native IDs and source outbox work, meetings, interactions,
  opportunities, leads, or campaigns. Target CRM rows deliberately receive
  new target SuiteCRM identities and queued target outbox projections;
- carrier secret rows, full registered-address payloads, printers, print
  agents, labels, and all dependent provider operational state. Only masked
  last-four/fingerprint evidence and preallocated target carrier IDs are
  retained in disabled placeholders;
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
4. Migration safety migrations 0353 and 0354 are present in both databases.
   Migration 0354 is the upgrade-safe extension for any database that already
   applied the earlier commerce-only 0353 draft. Together they supply source
   cutover fences, credential-free carrier placeholders, generalized target
   provider-identity fences, source-authority bindings, and immutable v2/v3
   receipt boundaries.
5. A restorable production backup/PITR boundary is recorded.
6. Scale every DEV web and worker service that can write these workspaces to
   zero, or stop those services through the approved Railway operator process.
   Do not rely on Paused controls alone. Keep writers stopped through apply.
7. Every selected DEV commerce store has an explicit Paused control and is
   effectively not running. Every selected commerce and carrier integration
   has a `frozen` v3 cutover fence. Commerce stores must also have no live read
   lease, unexpired available continuation, actionable webhook (including
   `failed` or `dead_letter`), pending/claimed/unknown external effect, dirty
   Shopify order, catalog, or inventory reconciliation target; active,
   uncertain, failed, or dead-letter intake/provider attempt; held
   catalog/image/inventory job; or non-current/pending order-revision work.
8. The existing PROD source authorities for the two AG sandbox delegations
   have been independently verified: FedEx `gia7335302` / `gac2368052`, last
   four `1073`, and UPS `gia2057284` / `gac5139730`, last four `3574`, all
   beneath Suburbia Sandwich Co `ga5122758` at `101 Jegs Place`. They must be
   active, have a verified credential and active sender-billing carrier
   account, and match the compiled provider/environment/account/address
   fingerprints. Do not modify these authority or credential rows.
9. Every target remains the exact existing organization/pipeline/board
   scaffold with an active owner membership, contains zero scoped app-owned
   CRM/operations/order/project/board data beyond that reviewed scaffold, and
   has the exact configuration baseline recorded in the plan.
10. Independent source and target endpoint SHA-256 bindings have been reviewed
   and pinned in addition to the in-database deployment identities.
11. The reviewed plan reports `applyReady: true`, with no denied target-scope
    candidate and no direct, indirect, or explicit-JSON scoped target row.

At the September 4 reviewed snapshot, the source was **not** ready: four store
controls were running, 304 AG Shopify webhook receipts were actionable, and
two AG external effects needed resolution. No active read leases or unexpired
available continuations remained. Treat that observation as stale until a new
plan proves otherwise. A plan is read-only and safe to run in this state;
apply fails closed.

After DEV writers are stopped and all source work is drained or resolved, add
one frozen fence per selected account in a single reviewed source transaction.
Use the compiled source organization/account UUIDs from the script, the exact
v3 migration name, the confirmed owner, and an operator reason. Do not release
these fences until apply and postflight are complete:

```sql
BEGIN;
INSERT INTO operations_commerce_workspace_migration_cutover_fences AS fence (
  organization_id, integration_account_id, migration_name, state,
  frozen_by, reason
) VALUES
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   '03696a20-aaf4-4049-b0e3-051d9b937749'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   'da56c6d6-fddd-47c0-bf26-66cdfc42ae2c'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   '010fd720-bfe8-4a4c-9f8d-581eb4b6b456'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('60832306-9876-4384-98e8-e179b427c3c1'::uuid,
   '72acd52d-a547-43f9-a78d-bb96e33e0525'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('ae747fcb-eb5f-426c-afff-ee56cf7aeb90'::uuid,
   'c13e4e64-edae-4e73-9ae0-c116c1419688'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('c6c8e6e7-fffa-4969-9526-e99da0ab2754'::uuid,
   '28038134-b624-4b52-8518-e9740785e5c3'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('c6c8e6e7-fffa-4969-9526-e99da0ab2754'::uuid,
   'c8aa9ff7-35f4-44e9-9419-e54b7c977002'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
   'jarrett@suburbiasandwichco.com',
   'DEV writers stopped; selective production migration cutover'),
  ('c6c8e6e7-fffa-4969-9526-e99da0ab2754'::uuid,
   '8abcaaa5-a2a6-4800-9a4d-941bd3761a8c'::uuid,
   'sales-shipping-workspace-production-migration-v3', 'frozen',
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
WHERE migration_name = 'sales-shipping-workspace-production-migration-v3'
ORDER BY organization_id, integration_account_id;

-- Commit only after this transaction shows the eight exact frozen rows above.
COMMIT;
```

Review these eight literal identities against `WORKSPACES`, inspect the affected
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

Target discovery enumerates every public CRM, operations, project-board, and
outbox candidate and classifies it as `scoped`, compiled `global-safe`, or
`denied`. Direct scope, explicit `sync_outbox` JSON scope, and every
foreign-key-reachable indirect scope are evaluated to a fixpoint with no depth
cap. Any matching row blocks. Any unclassifiable candidate blocks even when it
is empty; update and independently review the compiled classification rather
than silently skipping a new table.

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

Apply creates eight disabled, credential-free integrations and durable
provider-identity fences. The four commerce integrations receive explicit
Paused Store-sync controls; carrier integrations do not. Four carrier
placeholder rows retain only preallocated target IDs, provider/environment,
display metadata, last four, and non-secret identity fingerprints. No
credential, encrypted account number, address payload, token, webhook secret,
cursor, or provider state is copied.

The exact approved inventory is:

| Workspace | Global ID | Provider | Environment | Rebind mode |
| --- | --- | --- | --- | --- |
| AG Alchemy | `gia5156705` | Faire commerce | production | target reconnect |
| AG Alchemy | `gia9286799` | Shopify commerce | sandbox | target reconnect |
| AG Alchemy | `gia3106288` | FedEx carrier | sandbox | managed source-authority rebind |
| AG Alchemy | `gia5910262` | UPS carrier | sandbox | managed source-authority rebind |
| French Florist | `gia585rig3qiq7j` | Shopify commerce | production | target reconnect |
| Test Pro Bakery Bites | `giah34fedoa5b1o` | Shopify commerce | sandbox | target reconnect |
| Test Pro Bakery Bites | `gia4h85q2nhuig0` | UPS carrier | production | direct target reauth |
| Test Pro Bakery Bites | `gia83f2h5i45ud6` | UPS carrier | sandbox | direct target reauth |

AG mock-commerce `gia9iduqbikp5et` is deliberately excluded by exact identity
and remains excluded unless a separately reviewed change says otherwise.

- Reconnect each commerce account only through the supported guarded workflow.
  The provider, integration type, and environment are immutable; the freshly
  observed external account must hash to the reviewed source identity before
  activation. Imported external identifiers remain `stale` until this check.
- Reauthenticate each direct Test carrier in the target. Materialize the
  preallocated carrier ID only after a target credential verifies and the
  shipper last four and registered-address fingerprint match. Verify the
  carrier identity fence before activation. Production and sandbox capability
  sets remain distinct.
- The AG carrier rows remain source-managed sandbox delegations with credential
  reveal disabled. Reauthenticate the AG-scoped target projections; do not copy
  or modify the existing Suburbia authority credentials/accounts. Activation
  additionally requires the exact verified PROD authority mapping described in
  gate 8, the migrated AG warehouse as sender origin, the exact original
  sandbox capability profile, and `migrationSourceAuthorityVerified: true`.
  Any missing/mismatched authority returns BLOCK.
- Sandbox stays sandbox. A production database location is not evidence that a
  sandbox provider identity became production-capable.
- Choose the commerce history mode in the reviewed rebind plan. Planning proves
  that no target policy exists and performs no write. Apply inserts the exact
  digest-bound policy inside the same serializable transaction that activates
  the provider and writes its immutable receipt. Do not copy DEV history
  policy, cursors, webhooks, high-watermarks, or carrier/provider state.
- Run one reconnect at a time and verify the receipt/fence state before the
  next. Never edit a fence or placeholder manually to bypass a failed check.

Create and review one commerce plan at a time. Supported Shopify choices are
`new_orders_only`, `last_7_days`, `last_30_days`, and `last_60_days`; Faire also
supports `provider_all`. Apply takes the choice only from the confirmed plan,
so a second history flag is deliberately rejected:

```bash
npm run rebind:migrated-production-providers -- plan \
  --actor '<approved operator email>' \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --mapping '/secure/operator/path/commerce-migration-mapping.json' \
  --source-account-global-id '<compiled commerce Global ID>' \
  --history-mode 'last_30_days' \
  --output '/secure/operator/path/provider-rebind-plan.json'

npm run rebind:migrated-production-providers -- apply \
  --actor '<approved operator email>' \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --mapping '/secure/operator/path/commerce-migration-mapping.json' \
  --source-account-global-id '<same compiled commerce Global ID>' \
  --plan '/secure/operator/path/provider-rebind-plan.json' \
  --confirm-digest '<reviewed planDigest>' \
  --receipt-output '/secure/operator/path/provider-rebind-receipt.json'
```

For each managed AG carrier, store exactly one three-field JSON object
`{"clientId":"...","clientSecret":"...","accountNumber":"..."}` in macOS
Keychain or an equivalent password manager. Never put those values in command
arguments, environment variables, terminal output, the repository, or a synced
folder. Feed the same record to plan and apply over an inherited pipe descriptor;
the process rejects stdin, terminals, and regular files. The non-secret approval
tokens are exact compiled authority bindings:

- FedEx `approve:gia3106288:ga5122758:gia7335302:gac2368052:*1073`
- UPS `approve:gia5910262:ga5122758:gia2057284:gac5139730:*3574`

```bash
exec 3< <(security find-generic-password -s 'clawpilot-cutover-ag-fedex' -w)
npm run rebind:migrated-production-providers -- plan \
  --actor '<approved operator email>' \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --mapping '/secure/operator/path/commerce-migration-mapping.json' \
  --source-account-global-id 'gia3106288' \
  --managed-rebind-secrets-fd 3 \
  --confirm-managed-source-authority \
  'approve:gia3106288:ga5122758:gia7335302:gac2368052:*1073' \
  --output '/secure/operator/path/fedex-rebind-plan.json'
exec 3<&-

exec 3< <(security find-generic-password -s 'clawpilot-cutover-ag-fedex' -w)
npm run rebind:migrated-production-providers -- apply \
  --actor '<approved operator email>' \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --mapping '/secure/operator/path/commerce-migration-mapping.json' \
  --source-account-global-id 'gia3106288' \
  --managed-rebind-secrets-fd 3 \
  --plan '/secure/operator/path/fedex-rebind-plan.json' \
  --confirm-digest '<reviewed planDigest>' \
  --receipt-output '/secure/operator/path/fedex-rebind-receipt.json'
exec 3<&-
```

The plan and receipt contain only non-secret authority evidence, last-four
evidence, a commitment digest, and a target-keyed material fingerprint. Remove
temporary Keychain records only after receipt recovery and signed-in smoke
checks succeed.

## Postflight

For each target:

1. Confirm the immutable migration receipt and its manifest and receipt
   identity digests.
2. Confirm the migrated table counts match the mapping artifact.
3. Confirm all eight integration placeholders are disabled, have no external
   account or credential reference, use generation zero, and have receipt
   intake off. Confirm only the four commerce integrations have explicit
   Paused/effectively stopped Store-sync controls.
4. Confirm all four carrier placeholders are awaiting rebind and the three
   target organizations contain zero carrier credential/account secret rows.
   For AG, confirm the receipt authority digest resolves to the two unchanged,
   active, verified Suburbia source authorities before any activation.
5. Confirm no order-history policy exists after migration and before each
   commerce rebind plan. After apply, confirm exactly one immutable policy
   matches the reviewed provider, mode, floor, frozen time, and operator.
6. Confirm the production owner remains
   `jarrett@suburbiasandwichco.com` and no BPO alias user was created.
7. Confirm the exact target SuiteCRM outbox count and canonical CRM source
   hashes match the receipt, then allow the ordinary outbox worker to project
   them.
8. Validate representative image hashes and byte lengths and visually sample
   each workspace's product, warehouse, and pack configuration.
9. Before and after one controlled polling cycle, record
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

WITH target(organization_id) AS (
  VALUES
    ('33785418-9927-4e10-a492-d3a44b9b6f21'::uuid),
    ('3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid),
    ('c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid)
)
SELECT account.organization_id, account.global_id, account.provider,
       account.environment, account.status, account.credential_reference,
       placeholder.global_id AS carrier_placeholder_global_id,
       placeholder.rebind_mode, placeholder.state,
       fence.verification_state
FROM operations_integration_accounts account
JOIN target ON target.organization_id = account.organization_id
JOIN operations_carrier_account_migration_placeholders placeholder
  ON placeholder.organization_id = account.organization_id
 AND placeholder.integration_account_id = account.id
JOIN operations_commerce_migration_provider_identity_fences fence
  ON fence.organization_id = account.organization_id
 AND fence.integration_account_id = account.id
WHERE account.integration_type = 'carrier'
ORDER BY account.organization_id, account.provider, account.environment;

SELECT organization_id,
       count(*) AS carrier_credential_or_account_rows
FROM (
  SELECT organization_id FROM operations_carrier_credentials
  UNION ALL
  SELECT organization_id FROM operations_carrier_accounts
) carrier_secret_row
WHERE organization_id IN (
  '33785418-9927-4e10-a492-d3a44b9b6f21'::uuid,
  '3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid,
  'c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid
)
GROUP BY organization_id;

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
provider fence, target CRM identity, SuiteCRM outbox projection, and compiled
source-authority dependency before writing. Carrier fence verification may
advance after a legitimate rebind without invalidating the immutable receipt
identity projection; missing/mismatched authority rows still block recovery.
Receipt rows cannot be updated or deleted.

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
