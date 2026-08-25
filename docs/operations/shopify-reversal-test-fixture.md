---
id: cp-shopify-reversal-test-fixture
title: Shopify Reversal Test Fixture
summary: Hidden development-only two-phase operator lane for creating one fixed Shopify test order and one separately authorized external fulfillment.
status: active
kind: operations-runbook
area: commerce
tags: [shopify, development, fixtures, reversals, fulfillment, safety]
app_visible: false
---

# Shopify Reversal Test Fixture

## Boundary

This is a hidden operator fixture for proving the existing Shopify reversal and cancellation workflows. It is not an Operations feature, browser control, navigation item, or general Shopify order-creation API. The only interfaces are `POST /api/dev/shopify-test-fixtures` and the fixed-endpoint `scripts/shopify-test-fixture.mjs` client.

The route is available only when all of these facts remain exact:

- Railway project `b5169ebd-8166-4b96-9a81-7cc8adaa9270`, environment `e4abd95f-825c-4242-b37b-825a92597e98`, and environment name `development`;
- durable database identity `750aa268-0e31-4065-a99c-4016e4d4fab1`;
- `CLAWPILOT_SHOPIFY_REVERSAL_FIXTURE_ENABLED=1`;
- the existing Shopify order-test-write runtime is enabled and its allowlist contains only the intended account, including fixed fixture account `giah34fedoa5b1o`;
- the current integration is an active, verified Shopify sandbox client-credential connection with Provider writes On and current `read_orders`, `write_orders`, and `write_merchant_managed_fulfillment_orders` authority;
- a live Shopify read proves the connected shop is still a Partner development store; and
- the preparing and claiming actor has an active owner or administrator membership in the organization.

Production, Vercel, local development, a different Railway project or environment, another database, another integration account, stale credentials, stale Provider-write bindings, missing scopes, and ordinary browser sessions fail closed. The route authenticates with the existing worker secret. The CLI reads that secret only from `PIPELINE_OUTBOX_WORKER_SECRET`; it has no secret argument, endpoint override, or credential output.

## Phase 1: Fixed Test Order

`prepare-order` creates an immutable five-minute command and returns its intent hash plus the short intent-bound confirmation statement. It performs provider identity and scope reads but no provider mutation. `execute` may claim that exact command once.

The claimed provider mutation contains one fixed profile only:

- `test: true`, `financialStatus: PENDING`, and `buyerAcceptsMarketing: false`;
- fixed Selling Plans Ski Wax variant `gid://shopify/ProductVariant/51028106379511`, quantity `1`, and `requiresShipping: true`;
- the approved synthetic John Doe address at 101 Academy Drive, Buzzards Bay, Massachusetts 02532, US;
- `inventoryBehaviour: BYPASS`, `sendReceipt: false`, and `sendFulfillmentReceipt: false`; and
- a command-specific `sourceIdentifier` plus unique tag fingerprint.

It contains no customer, email, phone, billing address, transaction, discount, tax, shipping-line, or payment input. Shopify must return exactly one matching pending, unfulfilled, shippable test-order line. An explicit Shopify user error becomes a rejected terminal outcome. A timeout, transport failure, malformed response, or unverifiable returned order becomes `unknown`; never execute that command again.

Prepare and execute are separate commands:

```sh
node scripts/shopify-test-fixture.mjs prepare-order \
  --organization-id=<organization-uuid> \
  --actor-email=<active-owner-or-admin> \
  --idempotency-key=<stable-unique-key>

node scripts/shopify-test-fixture.mjs execute \
  --organization-id=<organization-uuid> \
  --actor-email=<same-active-owner-or-admin> \
  --command=<returned-command-global-id> \
  --intent=<returned-intent-hash> \
  --confirmation='<returned-confirmation-statement>'
```

For an `unknown` outcome, run the separate read-only reconciliation once. Phase 1 searches by the exact unique tag and accepts an applied result only when the source identifier, full tag set, test/payment/fulfillment state, fixed variant, quantity, and shipping requirement also match.

```sh
node scripts/shopify-test-fixture.mjs reconcile \
  --organization-id=<organization-uuid> \
  --actor-email=<same-active-owner-or-admin> \
  --command=<unknown-command-global-id>
```

An absent or ambiguous reconciliation is durable review evidence, not permission to retry the provider write.

## Phase 2: Separate External Fulfillment

Phase 2 never starts automatically. First allow the ordinary ClawPilot commerce intake to import the exact Phase-1 provider order, then use the ordinary warehouse flow to create and release one plan without picking it.

`prepare-fulfillment` fails unless the database proves all of the following at that moment and again immediately before the provider mutation:

- the canonical order is the exact provider order recorded by the successful or reconciled-applied Phase-1 command;
- the promoted Shopify candidate remains an open, pending, unfulfilled, shippable test order;
- exactly one fulfillment plan is released and its one wave has a persisted `released_at`;
- every allocation and provider-commitment reservation is complete, maps to one provider location, and has a ready pick with zero picked quantity and no picked timestamp;
- current order lines are positive whole Shopify line-item quantities and the allocations cover them exactly; and
- there are no packages, label attempts, labels, label print artifacts, shipments, commerce exports, fulfillment executions, shipment groups, external-fulfillment reconciliations, or billable events.

Preparation performs one bounded Shopify fulfillment read and seals its immutable attempt signature. It creates no fulfillment. The later one-time `execute` rechecks the exact database snapshot and the current provider plan before creating one external Shopify fulfillment with `notifyCustomer: false`. Because the provider mutation occurs only after the persisted wave release time, ordinary external-fulfillment reconciliation can identify it as post-release evidence.

```sh
node scripts/shopify-test-fixture.mjs prepare-fulfillment \
  --organization-id=<organization-uuid> \
  --actor-email=<same-active-owner-or-admin> \
  --idempotency-key=<new-stable-unique-key> \
  --predecessor-command=<successful-phase-1-command-global-id> \
  --order=<imported-operations-order-global-id>
```

Use the returned Phase-2 command, intent, and confirmation with the same `execute` form shown above. Unknown Phase-2 outcomes reconcile by the immutable fulfillment-order, location, line, quantity, carrier, and tracking signature. Reconciliation performs no mutation. The fixture never creates a label, shipment, export, pick, package, or billable event and never chains into either phase.

After the two fixture phases, use the existing ClawPilot reconciliation, reversal, or Shopify cancellation product workflow. The fixture ledger does not authorize or bypass those workflows.

## Durable Evidence and Readiness

Migration `0326_operations_shopify_reversal_test_fixture.sql` creates three append-only ledgers: commands, provider attempts, and outcomes. Preparation is serialized per organization, account, and phase. An unclaimed command may be superseded only after expiry. A claimed command has at most one attempt, and any unknown outcome permanently prevents another fixture write for that account and phase even after an absent or ambiguous reconciliation.

`/api/health` reports the fixture runtime, exact migration checksum, ledger structures, database identity, and prepared, processing, unknown, and terminal counts. When the fixture runtime flag is enabled, migration or database-identity drift makes health fail. Unresolved unknown outcomes are a warning.

Run the implementation acceptances with:

```sh
npm run test:shopify-reversal-fixture
```

Those acceptances prove fixed payload construction, runtime and route gates, command separation, unknown/reconciliation behavior, Postgres ledger fences, health readiness, and absence from normal UI. They mock provider I/O and are implementation evidence, not a Shopify provider end-to-end result. A provider E2E result exists only after an authorized operator executes the deployed two phases and records the returned provider evidence.
