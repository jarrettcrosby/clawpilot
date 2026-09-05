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
product image, warehouse configuration, inventory pools, credential-free
Shopify location-routing intent, pack configuration, and the approved sales
and shipping connection identities from the
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

The plan also inventories the app-owned inventory pools referenced by the
selected Shopify location mappings. Those mappings retain the exact target
warehouse, location, inventory-pool, and provider-location identities as
inactive placeholders. Provider-observed names, addresses, snapshots, and
ownership classifications are deliberately not carried across the database
boundary.

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
- Shopify provider-location observations, address snapshots, import-enable
  state, and ownership classifications. Only the credential-free routing
  intent and exact provider-location identity are migrated, inactive, for
  read-only verification during rebind;
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
5. Integration credential-key attestation migration 0356 is present with the
   exact release-pinned checksum in both databases. Each hosted environment
   has an explicit `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, an explicit
   non-secret `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID`, and a verified
   immutable sentinel for its database identity. A deployment may run in the
   temporary `adoption` mode only while installing that sentinel; provider
   credential reads and writes remain disabled in that mode. Switch back to
   `strict`, restart, and confirm health reports `providerIoReady: true` before
   any provider validation, polling, callback, activation, or rebind.
   Product-image runtime-parking migration 0357 must also be present with the
   release-pinned checksum
   `e8636998cfa8e8e24717ba7ffda11f4e2e0031fc83a439914a18f6d568c836a2`.
   Startup and `/api/health` must verify its exact ledger row, enabled import-job
   trigger, and reviewed guard-function body before provider I/O or the image
   worker can become ready. This protects retry budgets when credential proof
   maintenance or a committed Store sync pause races with an active image job.
   Hosted-production sandbox read-authority migration 0358 must also be present
   with release-pinned checksum
   `3e99c87a322816df28a76d0e00a2001d5301f978163679f950c1be856c1b5b79`.
   It permits only the compiled AG Alchemy and Test Pro Bakery Bites Shopify
   sandbox identities to perform the five named read capabilities after an
   exact migration receipt, provider identity, and credential generation are
   verified. Grants expire, may be revoked even after an account is disabled
   or errors, and never permit provider writes or automatic order promotion.
   `/api/health` warns 14 days before expiry and treats an expired, future-dated,
   identity-mismatched, or generation-mismatched grant as unusable.
   Fulfillment recovery-budget migration 0359 must also be present with the
   release-pinned checksum
   `f1ff432cb7e8af0ca83e87db75d1a6372a74fb25fcff1648c2d07eb7b3e54e11`.
   Health must verify its exact ledger row, non-null integer column with default
   zero, validated recovery-budget check, and ready partial index. This keeps
   the claim attempt as a monotonic fencing token while credential-maintenance
   parking preserves the independent automatic recovery budget.
6. A restorable production backup/PITR boundary is recorded.
7. Scale every DEV web and worker service that can write these workspaces to
   zero, or stop those services through the approved Railway operator process.
   Do not rely on Paused controls alone. Keep writers stopped through apply.
8. Every selected DEV commerce store has an explicit Paused control and is
   effectively not running. Every selected commerce and carrier integration
   has a `frozen` v3 cutover fence. Commerce stores must also have no live read
   lease, unexpired available continuation, actionable webhook (including
   `failed` or `dead_letter`), pending/claimed/unknown external effect, dirty
   Shopify order, catalog, or inventory reconciliation target; active,
   uncertain, failed, or dead-letter intake/provider attempt; held
   catalog/image/inventory job; or non-current/pending order-revision work.
9. The existing PROD source authorities for the two AG sandbox delegations
   have been independently verified: FedEx `gia7335302` / `gac2368052`, last
   four `1073`, and UPS `gia2057284` / `gac5139730`, last four `3574`, all
   beneath Suburbia Sandwich Co `ga5122758` at `101 Jegs Place`. They must be
   active, have a verified credential and active sender-billing carrier
   account, and match the compiled provider/environment/account/address
   fingerprints. Do not modify these authority or credential rows.
10. Every target remains the exact existing organization/pipeline/board
   scaffold with an active owner membership, contains zero scoped app-owned
   CRM/operations/order/project/board data beyond that reviewed scaffold, and
   has the exact configuration baseline recorded in the plan.
11. Independent source and target endpoint SHA-256 bindings have been reviewed
   and pinned in addition to the in-database deployment identities.
12. The reviewed plan reports `applyReady: true`, with no denied target-scope
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

The provider-rebind utility re-reads and locks the exact selected source
cutover fence, integration account, and credential generation. Its plan binds
the source organization/account, migration name, `frozen_by`, `frozen_at`, and
reason. Apply must observe that same frozen fence under the source advisory and
row-share locks through provider verification and the target commit. A released
or replaced fence, account mutation, credential rotation, or generation change
fails closed. Keep every DEV writer stopped and all eight source fences frozen
through the completed apply receipt; the database locks strengthen but do not
replace the operational writer stop. After any source change, provider write,
credential rotation, or uncertainty, discard the old plan, create a fresh plan,
review its new digest, and apply only that digest.

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
closed. Receipt materialization uses stable, sorted per-row lineage digests.
Only the explicit provider-rebind and SuiteCRM projection lifecycle fields are
normalized; provider identities, routing identities, and all other migrated
business data remain covered. A legitimate later rebind therefore does not
invalidate migration recovery, while unauthorized identity or business-data
changes still block `already_applied` and receipt export.

## Provider reconnection

Apply creates eight disabled, credential-free integrations and durable
provider-identity fences. The four commerce integrations receive explicit
Paused Store-sync controls; carrier integrations do not. Four carrier
placeholder rows retain only preallocated target IDs, provider/environment,
display metadata, last four, and non-secret identity fingerprints. No
credential, encrypted account number, address payload, token, webhook secret,
cursor, or provider state is copied.

App-owned inventory pools are migrated with the warehouse configuration.
Shopify location mappings arrive inactive with import disabled, row version
zero, no provider snapshot, and unknown ownership. During a commerce rebind the
tool lists Shopify locations read-only, rejects duplicate, missing, inactive,
or non-inventory locations, binds the complete observed location-set digest to
the reviewed plan, and materializes each mapping exactly once only after the
provider account identity is verified. A changed or ambiguous mapping requires
a new plan; it must never be repaired with a direct database update.

The exact approved inventory is:

| Workspace | Global ID | Provider | Environment | Rebind mode |
| --- | --- | --- | --- | --- |
| AG Alchemy | `gia5156705` | Faire commerce | production | verified source-credential transfer |
| AG Alchemy | `gia9286799` | Shopify commerce | sandbox | verified source-credential transfer and webhook reconciliation |
| AG Alchemy | `gia3106288` | FedEx carrier | sandbox | managed source-authority rebind |
| AG Alchemy | `gia5910262` | UPS carrier | sandbox | managed source-authority rebind |
| French Florist | `gia585rig3qiq7j` | Shopify commerce | production | verified source-credential transfer and webhook reconciliation |
| Test Pro Bakery Bites | `giah34fedoa5b1o` | Shopify commerce | sandbox | verified source-credential transfer and webhook reconciliation |
| Test Pro Bakery Bites | `gia4h85q2nhuig0` | UPS carrier | production | verified source-credential transfer |
| Test Pro Bakery Bites | `gia83f2h5i45ud6` | UPS carrier | sandbox | verified source-credential transfer |

"Verified source-credential transfer" is a separate, one-account-at-a-time
rebind step after the credential-free workspace migration commits. The rebind
tool decrypts the selected credential only in operator memory, proves the
expected provider/account identity with a read-only provider request,
re-encrypts it with the independently supplied production key and target AAD,
and commits only the target ciphertext plus redacted evidence. It never writes
the plaintext credential to the manifest, mapping, plan, receipt, logs, or
database. The two AG managed carrier rows instead require fresh
operator-supplied authority material through the bounded inherited descriptor.

AG mock-commerce `gia9iduqbikp5et` is deliberately excluded by exact identity
and remains excluded unless a separately reviewed change says otherwise.

Every rebind `plan` and `apply` command requires the exact reviewed database
and credential-key boundary in its environment:

- `SOURCE_DATABASE_URL` and `TARGET_DATABASE_URL`;
- `SOURCE_DATABASE_ENDPOINT_SHA256` and `TARGET_DATABASE_ENDPOINT_SHA256`;
- `SOURCE_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` and
  `TARGET_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, supplied independently; and
- `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID`, the non-secret identifier on the
  target database's verified key-attestation record.

The command rejects a missing or mismatched target key ID and authenticates the
target key against that database before any provider read. Keep all key material
out of arguments, evidence artifacts, terminal output, and synced folders. See
[Integration credential key attestation](./integration-credential-key-attestation.md)
for the reviewed bootstrap/adoption procedure.

For a legacy hosted environment, deploy migrations 0356 through 0359 through the
Railway predeploy migration step before starting the new application revision.
The reviewed `npm run verify:predeploy` gate must pass first; it executes both
the product-image worker suite and its disposable-PostgreSQL migration/parking
suite before compiling the application.
Deploy 0356 with
`INTEGRATION_CREDENTIAL_ATTESTATION_MODE=adoption` and the exact existing
credential key also configured as `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`.
Review and apply the attestation adoption plan while provider access is
disabled. Then set `INTEGRATION_CREDENTIAL_ATTESTATION_MODE=strict`, restart
the web and worker processes, and record a healthy response whose
`integrationCredentialRuntime.status` is `verified` and whose
`providerIoReady` value is `true`. The same health response must not report
migrations current unless the 0357 product-image runtime-parking ledger,
relation, guard function, and enabled trigger match exactly. Do not start the
worker or any rebind until that health check passes. The same response must
attest the 0358 authority schema before either compiled Shopify sandbox is
authorized for hosted-production reads, and it must attest the 0359 recovery
budget before any fulfillment-recovery worker is enabled. Do not run any
command below while the environment remains in adoption mode.

- Reconnect each commerce account only through the supported guarded workflow.
  The provider, integration type, and environment are immutable; the freshly
  observed external account must hash to the reviewed source identity before
  activation. Imported external identifiers remain `stale` until this check.
- Transfer each direct Test carrier credential through the guarded rebind.
  Materialize the preallocated carrier ID only after the source credential is
  authenticated, the target re-encryption round trip succeeds, and a read-only
  provider request verifies the shipper last four and registered-address
  fingerprint. Verify the carrier identity fence before activation.
  Production and sandbox capability sets remain distinct.
- The AG carrier rows remain source-managed sandbox delegations with credential
  reveal disabled. Reauthenticate the AG-scoped target projections; do not copy
  or modify the existing Suburbia authority credentials/accounts. Activation
  additionally requires the exact verified PROD authority mapping described in
  gate 8, the migrated AG warehouse as sender origin, the exact original
  sandbox capability profile, and `migrationSourceAuthorityVerified: true`.
  Any missing/mismatched authority returns BLOCK.
- Sandbox stays sandbox. A production database location is not evidence that a
  sandbox provider identity became production-capable. Hosted production may
  read the two compiled Shopify demo sandboxes only through a current 0358
  authorization for `catalog`, `images`, `inventory`, `orders_history`, and
  `webhook_hydration`. Credential rotation, provider-identity change, expiry,
  or revocation immediately removes that authority. Provider writes and
  automatic promotion remain disabled.
- Choose the commerce history mode in the reviewed rebind plan. Planning proves
  that no target policy exists and performs no write. Apply inserts the exact
  digest-bound policy inside the same serializable transaction that activates
  the provider and writes its immutable receipt. Do not copy DEV history
  policy, cursors, webhooks, high-watermarks, or carrier/provider state.
- Run one reconnect at a time and verify the receipt/fence state before the
  next. Never edit a fence or placeholder manually to bypass a failed check.
- Shopify rebind performs no CarrierService provider mutation and migrates no
  checkout-purpose pack mapping. The reviewed rebind receipt records a
  digest-bound readiness disposition with `carrierServiceVerified: false` and
  `checkoutPackRegenerationAllowed: false`. After rebind, an owner or authorized
  administrator must use the existing CarrierService Settings workflow: run
  the zero-write simulation, review the exact request/confirmation hash, make
  the explicit one-time provider change, and reconcile any uncertain result.
  Do not create or regenerate checkout-purpose pack mappings until the
  registered callback has been independently verified and the cutover
  acceptance evidence has been retained with the same rebind plan digest.

Before planning or applying a rebind, require the v5 target-schema attestation.
It must prove one exact ledger row for 0349 and 0353 through 0359; fingerprint
the image-import job relation, its enabled write trigger, and
`guard_operations_commerce_product_image_import_job()`; and fingerprint the
0358 authority relation, trigger, and current-authority function. It must also
fingerprint the fulfillment-export relation including the 0359 recovery-budget
column, constraint, and index. Generate and enroll the PostgreSQL-major-specific
digest only from the complete production migration runner on disposable
PostgreSQL 16 and 18. Do not reuse a v2/v3/v4 digest or proceed when any ledger,
relation, column, constraint, index, trigger, or function fingerprint differs.

Create and review one commerce plan at a time. Supported Shopify choices are
`new_orders_only`, `last_7_days`, `last_30_days`, and `last_60_days`; Faire also
supports `provider_all`. Apply takes the choice only from the confirmed plan,
so a second history flag is deliberately rejected. Plan time and the immutable
history cutoff come from the millisecond-truncated target database clock. Apply
fails before provider validation when the plan is more than 15 minutes old or
more than 5 seconds ahead of the target database clock, and rechecks that fence
inside the serializable target transaction before any provider callback write.
If review exceeds that window, rerun plan and review the new digest:

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

If apply exits after the target may have committed, or if the local receipt
artifact write is interrupted, do **not** rerun apply first. Recover the exact
committed receipt from PROD with no source connection. Recovery still requires
the attested target credential key so it can prove that the committed
credential generation and reference decrypt under the current production key;
the source key is neither required nor accepted:

```bash
TARGET_RAILWAY_PROJECT_ID='b5169ebd-8166-4b96-9a81-7cc8adaa9270' \
TARGET_RAILWAY_ENVIRONMENT_ID='058ce52f-1d3b-44bb-afe2-0df2bf24efb9' \
TARGET_RAILWAY_ENVIRONMENT_NAME='production' \
TARGET_DATABASE_URL='<same production PostgreSQL URL>' \
TARGET_DATABASE_ENDPOINT_SHA256='<same reviewed target endpoint fingerprint>' \
TARGET_INTEGRATION_CREDENTIAL_ENCRYPTION_KEY='<same attested production key>' \
INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID='<same reviewed target key ID>' \
npm run rebind:migrated-production-providers -- export-receipt \
  --actor '<same approved operator email>' \
  --manifest '/secure/operator/path/commerce-migration-plan.json' \
  --mapping '/secure/operator/path/commerce-migration-mapping.json' \
  --source-account-global-id '<same compiled provider Global ID>' \
  --plan '/secure/operator/path/provider-rebind-plan.json' \
  --confirm-digest '<same reviewed planDigest>' \
  --receipt-output '/secure/operator/path/recovered-provider-rebind-receipt.json'
```

A successful `export-receipt` proves the immutable receipt and verifies the
current external identity, credential reference/generation/decryptability,
receipt-intake state, Shopify subscription readiness groups, and Store Sync
control/cursor coverage against the reviewed plan; keep that artifact and do
not apply again. Do not expose the reconnected account settings or edit its Shopify
notification policy until this receipt artifact is secured. If export proves
there is no committed receipt **and** the target placeholder is still disabled
and fail-closed, inspect whether Shopify changed before doing anything else.
Shopify webhook changes are external provider mutations and do not roll back
with PostgreSQL. After any such partial Shopify mutation, the old callback
action list is stale: run a fresh `plan`, review its newly observed webhooks and
new digest, then apply only that new digest. Never reuse an old plan after a
partial Shopify provider mutation. Any other export failure, including an
existing receipt with mismatched materialized state, is a release blocker:
stop and investigate; do not plan or apply again.

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
   matches the reviewed provider, mode, floor, frozen time, and operator. For
   each Shopify account, also confirm exactly one fulfillment-notification
   policy has version `shopify-fulfillment-notification-v1`, default customer
   notification `false`, revision `1`, the approved rebind reason, and both
   actor fields equal to the rebind operator. A pre-existing or different row
   is a release blocker, not a value to overwrite.
6. Confirm the production owner remains
   `jarrett@suburbiasandwichco.com` and no BPO alias user was created.
7. Confirm the exact target SuiteCRM outbox count and canonical CRM source
   hashes match the receipt, then allow the ordinary outbox worker to project
   them.
8. Validate representative image hashes and byte lengths and visually sample
   each workspace's product, warehouse, inventory-pool, location-routing, and
   pack configuration. For Shopify, confirm every planned routing placeholder
   is active only after the receipt proves the exact provider location-set
   digest and every warehouse/location/pool identity.
9. For each reconnected commerce organization, the owner must first open the
   signed-in **Orders** page and choose **Refresh** exactly once, or invoke the
   same authenticated `POST /api/operations/order-reconciliation-schedule`
   workflow with a new Idempotency-Key. This first manager action creates the
   provider-history schedule and order-sync policy; a raw worker poll alone
   cannot initialize a missing policy/high-watermark. Record its retained
   scheduled/already-scheduled/deferred counts.
10. Allow the Railway poller to run the bounded
    `POST /api/integrations/commerce/orders/process` drain. Do not create an
    unbounded shell loop or direct database workaround. Continue only through
    separately observed bounded cycles until the historical session reaches a
    terminal success and the continuous high-watermark is non-null. Verify
    `/api/health` reports `commerceOrderHistory.status` healthy, a reachable
    non-degraded worker, cursor-key readiness, and zero pending, processing,
    stale, failed, blocked, dead, historical-blocked, historical-dead, and
    overdue-poll backlog.
11. For AG Alchemy and Test Pro Bakery Bites, confirm the hosted-production
    sandbox read authority is current, expires within the reviewed 90-day
    window, carries exactly the five read capabilities, and is bound to the
    receipt's provider-identity digest and credential generation. Schedule
    renewal before the 14-day warning; revoke the old grant before any
    credential rotation. Confirm provider writes and automatic promotion remain
    disabled.
12. For each Shopify account, keep CarrierService and checkout pack regeneration
    blocked until the explicit Settings simulation/confirmation/provider-write
    workflow succeeds, the registered callback is verified, and the retained
    acceptance references the exact rebind plan digest.
13. Confirm `/api/health` reports
    `commerceFulfillmentRecoveryBudget.status: ready` before enabling the
    fulfillment-recovery worker. Credential-maintenance parking must not consume
    the automatic recovery budget, and the monotonic claim fence must never be
    rewound.
14. Before the first schedule and after the bounded drain, record
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

Run these checks in a read-only transaction. Replace each
`REPLACE_WITH_CONFIRMED_PLAN_DIGEST_*` value with the exact digest from the
reviewed and confirmed plan for that source account; replace neither identity
nor target IDs:

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

WITH expected(
  source_account_global_id, organization_id, provider, confirmed_plan_digest
) AS (
  VALUES
    ('gia5156705', '33785418-9927-4e10-a492-d3a44b9b6f21'::uuid, 'faire',
     'REPLACE_WITH_CONFIRMED_PLAN_DIGEST_GIA5156705'),
    ('gia9286799', '33785418-9927-4e10-a492-d3a44b9b6f21'::uuid, 'shopify',
     'REPLACE_WITH_CONFIRMED_PLAN_DIGEST_GIA9286799'),
    ('gia585rig3qiq7j', '3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid, 'shopify',
     'REPLACE_WITH_CONFIRMED_PLAN_DIGEST_GIA585RIG3QIQ7J'),
    ('giah34fedoa5b1o', 'c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid, 'shopify',
     'REPLACE_WITH_CONFIRMED_PLAN_DIGEST_GIAH34FEDOA5B1O')
)
SELECT expected.source_account_global_id,
       expected.organization_id,
       expected.confirmed_plan_digest,
       receipt_evidence.reviewed_plan_digest,
       receipt_evidence.reviewed_target_account_global_id,
       account_evidence.target_account_global_id,
       expected.provider AS expected_provider,
       receipt_evidence.receipt_count,
       policy_evidence.policy_count,
       notification_evidence.notification_policy_count,
       receipt_evidence.reviewed_history_mode,
       policy_evidence.actual_history_mode,
       receipt_evidence.reviewed_ingestion_floor,
       policy_evidence.actual_ingestion_floor,
       receipt_evidence.reviewed_frozen_at,
       policy_evidence.actual_frozen_at,
       receipt_evidence.reviewed_configured_by,
       policy_evidence.actual_configured_by,
       receipt_evidence.receipt_count = 1
         AND account_evidence.account_count = 1
         AND policy_evidence.policy_count = 1
         AND expected.confirmed_plan_digest ~ '^[a-f0-9]{64}$'
         AND receipt_evidence.reviewed_plan_digest =
           expected.confirmed_plan_digest
         AND receipt_evidence.reviewed_target_account_global_id =
           account_evidence.target_account_global_id
         AND receipt_evidence.reviewed_provider = expected.provider
         AND policy_evidence.actual_provider = expected.provider
         AND policy_evidence.actual_history_mode =
           receipt_evidence.reviewed_history_mode
         AND policy_evidence.actual_ingestion_floor IS NOT DISTINCT FROM
           receipt_evidence.reviewed_ingestion_floor::timestamptz
         AND policy_evidence.actual_frozen_at =
           receipt_evidence.reviewed_frozen_at::timestamptz
         AND policy_evidence.actual_configured_by =
           receipt_evidence.reviewed_configured_by
         AND (
           (expected.provider = 'shopify'
             AND notification_evidence.notification_policy_count = 1
             AND receipt_evidence.reviewed_notification_policy_version =
               'shopify-fulfillment-notification-v1'
             AND receipt_evidence.reviewed_notify_customer_default = 'false'
             AND receipt_evidence.reviewed_notification_revision = '1'
             AND receipt_evidence.reviewed_notification_reason =
               'Safe default established during approved production rebind'
             AND receipt_evidence.reviewed_notification_created_by =
               receipt_evidence.reviewed_configured_by
             AND receipt_evidence.reviewed_notification_updated_by =
               receipt_evidence.reviewed_configured_by
             AND notification_evidence.actual_policy_version =
               receipt_evidence.reviewed_notification_policy_version
             AND notification_evidence.actual_notify_customer_default =
               receipt_evidence.reviewed_notify_customer_default
             AND notification_evidence.actual_revision::text =
               receipt_evidence.reviewed_notification_revision
             AND notification_evidence.actual_change_reason =
               receipt_evidence.reviewed_notification_reason
             AND notification_evidence.actual_created_by =
               receipt_evidence.reviewed_notification_created_by
             AND notification_evidence.actual_updated_by =
               receipt_evidence.reviewed_notification_updated_by)
           OR (expected.provider = 'faire'
             AND notification_evidence.notification_policy_count = 0
             AND receipt_evidence.reviewed_notification_policy_version IS NULL)
         ) AS exact_rebind_match
FROM expected
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS receipt_count,
         min(event.payload->>'planDigest') AS reviewed_plan_digest,
         min(event.payload#>>'{providers,0,targetAccountGlobalId}')
           AS reviewed_target_account_global_id,
         min(event.payload#>>'{providers,0,orderHistoryPolicy,provider}')
           AS reviewed_provider,
         min(event.payload#>>'{providers,0,orderHistoryPolicy,historyMode}')
           AS reviewed_history_mode,
         min(event.payload#>>'{providers,0,orderHistoryPolicy,ingestionFloor}')
           AS reviewed_ingestion_floor,
         min(event.payload#>>'{providers,0,orderHistoryPolicy,frozenAt}')
           AS reviewed_frozen_at,
         min(event.payload#>>'{providers,0,orderHistoryPolicy,configuredBy}')
           AS reviewed_configured_by,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,policyVersion}')
           AS reviewed_notification_policy_version,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,notifyCustomerDefault}')
           AS reviewed_notify_customer_default,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,revision}')
           AS reviewed_notification_revision,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,changeReason}')
           AS reviewed_notification_reason,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,createdBy}')
           AS reviewed_notification_created_by,
         min(event.payload#>>'{providers,0,fulfillmentNotificationPolicy,updatedBy}')
           AS reviewed_notification_updated_by
  FROM audit_events event
  WHERE event.organization_id = expected.organization_id
    AND event.event_type = 'operations.migrated_provider_rebind.completed'
    AND event.payload#>>'{providers,0,sourceAccountGlobalId}' =
      expected.source_account_global_id
) receipt_evidence ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS account_count,
         min(account.global_id) AS target_account_global_id
  FROM operations_commerce_migration_provider_identity_fences fence
  JOIN operations_integration_accounts account
    ON account.organization_id = fence.organization_id
   AND account.id = fence.integration_account_id
  WHERE fence.organization_id = expected.organization_id
    AND fence.source_account_global_id = expected.source_account_global_id
    AND account.integration_type = 'commerce'
) account_evidence ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS policy_count,
         min(policy.provider) AS actual_provider,
         min(policy.history_mode) AS actual_history_mode,
         min(policy.ingestion_floor) AS actual_ingestion_floor,
         min(policy.frozen_at) AS actual_frozen_at,
         min(policy.configured_by) AS actual_configured_by
  FROM operations_commerce_migration_provider_identity_fences fence
  JOIN operations_commerce_order_history_policies policy
    ON policy.organization_id = fence.organization_id
   AND policy.integration_account_id = fence.integration_account_id
  WHERE fence.organization_id = expected.organization_id
    AND fence.source_account_global_id = expected.source_account_global_id
) policy_evidence ON true
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS notification_policy_count,
         min(notification.policy_version) AS actual_policy_version,
         min(notification.notify_customer_default::text)
           AS actual_notify_customer_default,
         min(notification.revision)::integer AS actual_revision,
         min(notification.change_reason) AS actual_change_reason,
         min(notification.created_by) AS actual_created_by,
         min(notification.updated_by) AS actual_updated_by
  FROM operations_commerce_migration_provider_identity_fences fence
  JOIN operations_shopify_fulfillment_notification_policies notification
    ON notification.organization_id = fence.organization_id
   AND notification.integration_account_id = fence.integration_account_id
  WHERE fence.organization_id = expected.organization_id
    AND fence.source_account_global_id = expected.source_account_global_id
) notification_evidence ON true
ORDER BY expected.organization_id, expected.source_account_global_id;

WITH target(organization_id) AS (
  VALUES
    ('33785418-9927-4e10-a492-d3a44b9b6f21'::uuid),
    ('3b9ceada-a4ff-4363-8e78-6069dee76328'::uuid),
    ('c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid)
)
SELECT account.organization_id, account.global_id, account.provider,
       policy.policy_version, policy.authority,
       policy.historical_observation_enabled,
       policy.continuous_observation_enabled,
       policy.continuous_transport,
       policy.provider_event_processor_state,
       policy.revision,
       policy.continuous_high_watermark,
       policy.continuous_next_poll_at,
       session_health.historical_succeeded,
       session_health.pending, session_health.processing,
       session_health.failed, session_health.blocked,
       session_health.dead
FROM operations_integration_accounts account
JOIN target ON target.organization_id = account.organization_id
LEFT JOIN operations_commerce_order_sync_policies policy
  ON policy.organization_id = account.organization_id
 AND policy.integration_account_id = account.id
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (
           WHERE session.session_kind = 'historical_backfill'
             AND session.status = 'succeeded'
         ) AS historical_succeeded,
         count(*) FILTER (WHERE session.status = 'pending') AS pending,
         count(*) FILTER (WHERE session.status = 'processing') AS processing,
         count(*) FILTER (WHERE session.status = 'failed') AS failed,
         count(*) FILTER (WHERE session.status = 'blocked') AS blocked,
         count(*) FILTER (WHERE session.status = 'dead') AS dead
  FROM operations_commerce_order_backfill_sessions session
  WHERE session.organization_id = account.organization_id
    AND session.integration_account_id = account.id
) session_health ON true
WHERE account.integration_type = 'commerce'
ORDER BY account.organization_id, account.provider, account.global_id;

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
identity projection. The stable lineage attestation likewise normalizes only
the sanctioned rebind/projection lifecycle fields; provider identity,
provider-location identity, warehouse/location/pool routing, and other business
data remain tamper-evident. Missing or mismatched authority rows still block recovery.
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
