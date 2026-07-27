---
id: cp-ops-distributed-operations
title: Distributed Operations Runbook
summary: Pre-activation deployment, monitoring, reconciliation, incident response, recovery, and rollback procedures for DOM, WMS, shipping, and 3PL billing.
status: draft
kind: operations-runbook
area: distributed-operations
tags: [clawpilot, dom, wms, 3pl, runbook, incidents, reconciliation]
app_visible: false
---

# Distributed Operations Runbook

## Status And Scope

This runbook governs the target distributed order, inventory, warehouse, carrier, printing, shipment, and 3PL billing module. The development environment has a Postgres-backed order workbench, explicit warehouse-release, bulk all-ready pick-confirmation, pack-verification, sandbox-label-create, and sandbox-label-void commands for eligible non-archived orders, a shared product/default-package import workflow, an audited exception queue, organization-scoped activation, direct carrier credential administration, UPS and FedEx sandbox rating and label execution against a fixed synthetic fixture, append-only redacted provider evidence, durable print delivery, a working-tree packing-slip/artifact and shipment-completion evidence contract, horizontally scrollable mobile Operations subpanel navigation, command-receipt health, and disposable PostgreSQL acceptance. Deterministic mock flows are automated-test evidence only and cannot be launched from the hosted workbench. This runbook remains `draft` until the module has a hosted production shipment-confirmation command, complete reconciliation and adapter health, tested production adapters, integration/warehouse activation subscopes, and on-call ownership. Current general environment, backup, promotion, and restore procedures remain authoritative:

- [ClawPilot Environments and Deployment](clawpilot-environments.md)
- [Railway Postgres Backups](railway-postgres-backups.md)
- [Agent Security and Integration Isolation](agent-security-and-isolation.md)

Operations migrations `0081` through `0094`, `0097` through `0099`, `0101`, and `0111` through `0116` are bounded development evidence only. Migrations `0089` and `0090` establish delegated rate paths, multi-account carrier billing, GL Coding, reconciliation, and settlement foundations. Migration `0091` adds capability-aware printer profiles and routing defaults. Migration `0092` hardens carrier-account, charge, match, assignment, GL-run, reconciliation, and settlement provenance. Migration `0093` adds direct checksum-bound carrier CSV import and immutable financial review evidence. Migration `0094` adds enrolled local print agents, leased delivery attempts, fallback routing, and controlled reprints. Migration `0097` enforces append-only settlement transitions and current-status projections. Migration `0098` adds immutable carrier-label attempts, one-active-label enforcement, exact carrier-account evidence, and sandbox create/void finalization. Migration `0099` adds immutable packing-slip payloads, append-only tracking observations, and durable commerce-fulfillment export state. Migration `0101` adds facility classification, editable hierarchical warehouse locations, capacity limits, product-location placement rules, and receiving data foundations. Migrations `0111` through `0115` establish commerce credentials/evidence, a disposable preview, bounded product-mapping and operational-order candidates, durable pre-call read intents, resource-scoped encrypted continuations, first-class rejection dispositions, and explicit canonical promotion; they do not establish historical import, provider inventory synchronization, or unattended commerce processing. Migration `0116` adds durable rate-selected sandbox test-label attempts and decoded bytes plus a no-order print-artifact source. These migrations do not by themselves expose or authorize production shipment confirmation or directed putaway. Do not use this document as evidence that a production commerce or carrier adapter, checkout callback, accounting export, invoice/AR workflow, payment adapter, directed putaway worker, or live warehouse worker is deployed. Migration `0088` archives legacy mock orders, releases their reservations, hides them from active workbench projections, disables mock integration/facility records, and retains immutable evidence rather than deleting it.

Operator procedures for printer configuration, multi-account carrier bills, GL Coding, and the Triangle/Square/Circle settlement model are in [Printing, Carrier Billing, And GL Coding](printing-carrier-billing-and-gl-coding.md).
Enrollment, claim fencing, retry, fallback, and reprint procedures are in [Local Print Agent](local-print-agent.md).

## Direct Carrier Credential Procedure

1. Confirm the active workspace before opening **Settings > Integrations > Shipping**. Carrier accounts belong to that organization only. The organization owner or a user with explicit **Manage operations** permission may manage them; that permission does not expose unrelated integrations.
2. Select UPS, FedEx, or USPS and select **Sandbox / developer** or **Production**. The developer selection uses UPS CIE, FedEx Sandbox, or USPS TEM. ClawPilot fixes those hosts server-side; do not enter a provider host or reuse production credentials. Configure and prove the developer workflow before production whenever the provider offers it.
3. Enter the provider client ID and client secret. Enter the billing account number for UPS or FedEx; it is optional for USPS. For every billing account, record the sender name and the address registered to that account. The sender name is operational shipper identity used with that account address for rating and label requests; it is not inferred from a credential label, carrier account number, test fixture, or signed-in user. Do not paste credentials into tickets, chat, logs, documents, or source files.
4. Use **Save and verify**. ClawPilot calls only the provider's allowlisted OAuth endpoint before atomically storing encrypted credential material. A rejection leaves the previous stored credential unchanged.
5. Confirm the permanent `gia` integration identity, masked suffixes, incremented credential version, `Verified` state, and `Disabled` state for a first-time connection. The browser never receives the stored credential or short-lived access token.
6. Use **Test connection** after any provider-side permission, account, or secret change. Do not enable a failed or unverified account.
7. Enable the account only after verification and only in the intended environment. Enabling re-runs verification. Developer and production credentials are stored, versioned, verified, and enabled independently; a developer record cannot satisfy a production adapter.
8. Rotate by entering the full replacement credential and selecting **Save and verify**. The previous ciphertext is replaced only after the candidate verifies, and the audit log records rotation metadata without a secret.
9. Use **Disconnect** only after confirming the organization, provider, and environment. Disconnect deletes encrypted credential material and disables the integration metadata; it does not delete immutable historical shipment evidence.

Credential verification is not shipping certification. The only currently authorized provider calls are the fixed UPS or FedEx sandbox rate test and the bounded sandbox label create/void procedure below. Do not activate production rating, label purchase, void, manifest, pickup, tracking, or any carrier side effect until the corresponding adapter, provider attempts, unknown-outcome reconciliation, and authorized smoke test pass the release gate in the [small parcel architecture](../architecture/small-parcel-carrier-adapters.md).

## UPS And FedEx Sandbox Rate Test

1. Confirm the active workspace and open **Settings > Integrations > Shipping**.
2. Select UPS or FedEx and **Sandbox / developer**. Confirm that the sandbox credential is verified and enable the sandbox integration. Production credentials are rejected by this action.
3. Under **Billing accounts**, add the carrier account number, sender name, and address registered to that account. Enable the billing account and select it for the sandbox test. ClawPilot uses that stored sender identity and address as the read-only origin. The bounded Settings diagnostic is sender-billed; recipient- and third-party-billed execution require a later separately tested provider flow.
4. Review and, when needed, edit the U.S. test destination. The initial value is John Doe at `101 Academy Drive, Buzzards Bay, MA 02532`. The parcel remains one fixed `Test Product` measuring `12 x 10 x 6 in` and weighing `5 lb`. To correct the origin, edit the selected billing account rather than overriding it in the rating form.
5. Select **Test sandbox rate** once. The request invokes only the provider rating API. It cannot create a shipment, label, tracking number, pickup, manifest, carrier charge, or print job, and its result contains no printable media.
6. Record the returned `grq` evidence Global ID and review only normalized service, amount, currency, transit, and delivery values. Do not copy credentials, tokens, account numbers, or raw provider payloads into operating notes.
7. A failure may be retried only after reviewing its safe error and provider/account status. The append-only evidence preserves each attempt without storing secrets or a full address payload.
8. Stop after rating unless an authorized diagnostic label is required. Choose one exact returned service and use the separate Settings diagnostic procedure below, or use the order-bound procedure for an eligible packed order. Pickup, manifest, tracking mutation, and production actions remain prohibited.

## Settings Sandbox Rate, Label, Print, And Void Diagnostic

1. Run the sandbox rate test above and retain the displayed `grq` evidence Global ID in the current no-store page. Rating does not return a label.
2. Choose one returned service and select **Create test label**. Confirm the warning: this invokes the carrier's separate sandbox Ship API, creates a provider test tracking reference, and is a carrier side effect even though no ClawPilot shipment or inventory record is created.
3. ClawPilot revalidates the destination fingerprint against the selected rate evidence, resolves the exact active account and origin on the server, writes a durable prepared attempt before network I/O, then finalizes the returned label exactly once. If the outcome is `prepared` or `unknown`, stop; do not submit a new key.
4. Confirm the test-label Global ID, service, format, byte length, checksum, tracking reference, and `created` state. Provider base64 is decoded before persistence: ZPL is validated as printable ZPL and binary PDF/PNG is validated by signature. The checksum and length cover the actual bytes that will be delivered.
5. Choose an online compatible organization printer and select **Test print**. This queues the already stored bytes and does not call rating or shipping again. A routing error is actionable printer configuration feedback; it does not mean label creation failed.
6. Use print retry or controlled reprint for delivery recovery. Never create another carrier label to recover a print.
7. Select **Void test label** after inspection and provide a reason. ClawPilot uses the exact persisted carrier account and provider reference. A successful void changes the diagnostic label to `voided`; it does not delete its immutable label or print evidence.
8. If an attempt is `unknown`, or remains `prepared` for more than two minutes, an organization admin with warehouse-execution permission must inspect the provider developer portal before using **Carrier reconciliation**. For create, choose **No active label exists at carrier** only after verifying that no test label remains. For void, record either **Carrier confirms label is voided** or **Carrier confirms label is still active**. Provide the portal evidence and timestamp in the note and confirm the exact `gsa` attempt. This records the verified result and clears the safety fence without another carrier API call.
9. Never use reconciliation to guess. If the carrier portal cannot establish the outcome, leave the attempt fenced and escalate with the displayed attempt and provider transaction references.

## UPS And FedEx Sandbox Label Create And Void

1. Use only an eligible packed order whose sender, receiver, line, parcel, and selected rate match the fixed John Doe sandbox fixture. The sender is `101 Jegs Place, Delaware, OH 43015`; the receiver is `101 Academy Drive, Buzzards Bay, MA 02532`; the line is `Test Product`; and the parcel is `12 x 10 x 6 in` at `5 lb`.
2. Open the order in **Operations > Orders** and confirm its selected UPS or FedEx rate, the intended active sandbox carrier account, the current order version, and the target warehouse printer. Production credentials and an account from another organization are rejected.
3. Select **Create sandbox label**, enter a specific reason, and submit once. The command first commits an immutable `prepared` attempt, performs provider I/O outside the database transaction, then finalizes the attempt and label exactly once. One package may have only one active label.
4. On success, confirm the active label, tracking reference, successful `gla` attempt, `label.created` domain event, audit event, and durable shipping-label print job. The label is committed before print routing. A print-routing warning therefore does not mean the carrier purchase failed. This result does not create a shipment, consume inventory, append tracking evidence, queue commerce fulfillment, or render a packing slip.
5. If the label exists but the print job is missing, replay the original command with the original idempotency key. ClawPilot reuses the committed label and attempts the same idempotent print enqueue without calling the carrier again. Never create a new label merely to recover printing.
6. Select **Void** immediately after inspection, enter a specific reason, and submit once. The void must use the exact persisted integration and carrier account used for purchase. Confirm the label is `voided`, the package returns to `packed`, and immutable `label.voided` and audit evidence exist.
7. If a create or void attempt is `prepared` or `unknown`, stop. Do not retry with a new key. Reconcile the provider result and finalize that attempt before any later provider command.
8. Keep the resulting tracking number, provider reference, and label payload out of tickets and chat. Retain them only in the bounded operational evidence and document/print path.

## Shipment Confirmation Safety And Durable Evidence

1. Treat sandbox rating and sandbox label execution as pre-dispatch proof only. No sandbox action is authorized to create an `operations_shipments` row, mark a package or order shipped, consume or release a reservation, append `operations_tracking_observations`, create `operations_commerce_fulfillment_exports`, or render a packing slip.
2. The deterministic mock proof is separate. Its automated-test-only transaction creates a mock shipment, consumes its mock reservation, and records a mock commerce result. Hosted users cannot launch that path, and its result is not evidence that the production completion bundle or a provider adapter is certified.
3. There is no general hosted production shipment-confirmation command in the current slice. Do not simulate one with direct SQL, by changing a sandbox label environment, or by manually consuming inventory.
4. Migration `0099` defines the required production evidence bundle. When the command is wired, one tenant-scoped transaction must create the shipment and inventory-consumption facts, immutable packing-slip metadata and PDF bytes, the first append-only `confirmed` tracking observation, and a `queued` commerce-fulfillment export intent. Carrier and commerce network calls occur only after that transaction commits.
5. Packing slips use the versioned `packing-slip-letter-v1` renderer and retain SHA-256, byte length, safe filename, MIME type, template version, and immutable render snapshot. Authorized users retrieve raw PDF bytes through the active-organization artifact route. Local print-agent JSON claims preserve validated ZPL as `utf8` and carry binary PDF/PNG documents as `base64`; integrity values always describe the decoded bytes sent to the device.
6. `operations_shipments` remains the current shipment projection. `operations_tracking_observations` is append-only evidence with `confirmed`, `in_transit`, `out_for_delivery`, `delivered`, `exception`, and `voided` statuses; the current slice does not yet include carrier webhook or polling ingestion.
7. Commerce exports start as `queued`, may move through `processing`, and record `succeeded`, `failed`, or `unsupported`. A failed export may re-enter the retry lifecycle through an approved command; `succeeded` and `unsupported` are immutable terminal outcomes. Shipment identity and payload are immutable, and provider I/O belongs to a post-commit worker. The dispatcher, provider adapter, replay/reconciliation command, and queue health are not yet implemented.

## Shopify And Faire Commerce Intake

1. Confirm the active organization and open **Settings > Integrations > Sales channels**. The Shopify store or Faire brand must be configured and verified. This workflow is available only when `CLAWPILOT_COMMERCE_INTAKE_ENABLED=1` in development, local, or preview; production is refused. Only an organization owner or user with **Manage operations** may use it.
2. Expand **Commerce intake · map, resolve, and promote** for the intended account. Confirm the policy version, retention period, Operations activation (`shadow` or `active` for decisions), and safety evidence: provider writes `0`, cursor advancement `no`. If activation is missing, `disabled`, or `read_only`, an authorized owner or administrator may select **Enable Shadow**, confirm the organization-level change, and continue after the workflow reloads. If activation is `frozen` or changed concurrently, use **Review Operations** and resolve the incident or state change there; the intake shortcut must refuse the override. Secrets, provider tokens, and cursor material must remain absent.
3. Start with **Product catalog intake**. Select **Fetch product catalog**; if **Fetch next product batch** appears, continue until the product session is complete. Use **Check for product changes** to start a later bounded session. Do not use the order continuation for a product request. Before mapping, inspect the rendered provider and inventory-item identities, options, vendor/type, current and compare-at price, taxability/shipping flags, quantity, and weight. Shopify needs `read_products` plus `read_inventory` for the supported evidence profile. Faire needs `READ_PRODUCTS`; grant `READ_INVENTORIES` to execute the bounded inventory hydration. A negative Faire quantity is valid provider evidence, while missing or `UNTRACKED` quantity must remain unknown rather than zero.
4. Resolve every held product candidate:
   - **Map existing** selects an active `gp` product and creates the exact integration-account/provider/variant mapping.
   - **Create and map** requires a product name, optional SKU, nonnegative price in integer minor units, and ISO currency; it creates an account-scoped CRM product and exact mapping.
   - **Exclude catalog product** requires a safe audit reason and records a terminal candidate disposition.
   Never accept a SKU, barcode, or title as identity without an explicit decision.
5. Select **Fetch operational orders**. The command starts a separate bounded order session and stages only nonterminal operational orders; it does not create a canonical order. Shopify is cutoff-fenced. Faire is explicitly a live cursor.
6. If **Fetch next order batch** appears, continue until the order session reports complete. The browser sends only the matching previous run Global ID; the server resolves it to one resource-scoped encrypted continuation. Finish Faire pages promptly, exact-**Refresh** every Faire order candidate before validation, then run **Check for newer orders** to reconcile changes made while paging.
7. For a consumed continuation, reload and use the current batch. For an invalid, expired, exhausted, resource-mismatched, or credential-mismatched continuation, use the visible **Restart session** action on the matching product or order card. Never copy or guess a provider cursor.
8. Review **Provider records need an operator disposition** after every product or order batch. Each row has executable recovery:
   - For an order rejection, correct the provider record and select **Retry exact order**. The server reads that exact external identity and either stages it or returns current rejection evidence.
   - For any rejection, enter an **Exclusion audit reason** and select **Exclude this revision**.
   - A product rejection has no safe exact-variant read; exclude it, correct it at the provider, then run **Fetch product catalog** or **Check for product changes**.
   Do not leave an open rejection with only an off-platform instruction.
9. Review each order candidate's provider identity, source update time, raw and normalized order/financial/fulfillment/return status, exact line quantities, money evidence, and blocker list. Use **Refresh** for a stale or repairably truncated staged order; reuse the same idempotency key after an uncertain response.
10. Resolve every order line with `resolve-product`. Select an existing `gp` product or explicitly create one, bind the exact account-scoped provider variant, and confirm the nonnegative order-time unit price in integer minor units and ISO currency. Never substitute the product master's mutable current price.
11. Resolve the customer with `resolve-customer`. Select an existing CRM organization or explicitly create a provider-account-scoped customer from the provider business snapshot. Creation is create-only and cannot name-upsert or update a same-name CRM master.
12. Resolve ship-to with `confirm-address`; confirm the complete provider snapshot or enter a complete manual recipient/address. Resolve delivery with `resolve-delivery`; choose the provider date, enter a requested-delivery instant, or explicitly accept the versioned default SLA. Resolve each remaining line's package with `resolve-package`; select an active profile or enter positive grams and millimeters.
13. Select **Validate**. The candidate becomes `ready` only when the current row/source/credential evidence and every required resolution pass. A stale conflict requires **Refresh**, review, and another validation. A cancelled, fully fulfilled, permanently truncated, or unsupported staged candidate uses **Mark unsupported** with a safe reason.
14. Select **Promote canonical order** only for a `ready` candidate. Promotion requires `confirmProviderWriteOff: true`, locks and rechecks all evidence, and creates or replays one canonical order transaction with its remaining lines, identifiers, explicit mappings/CRM creations, first `order.imported` event, audit event, and command receipt.
15. Verify that Shopify promotion includes only positive `unfulfilledQuantity` as canonical demand. Confirm the source payload records the provider subtotal, canonical merchandise total computed as remaining quantity multiplied by confirmed order-time unit price, the signed variance, and the versioned reconciliation policy. Already fulfilled and removed or refunded quantities must remain evidence, not new work.
16. Confirm the resulting `gor` identity and side-effect counters. Promotion does not reserve stock, choose a warehouse, plan fulfillment, purchase a label, create a shipment, advance a provider cursor, register a webhook, or export fulfillment.

Every initial, continuation, exact-retry, or exact-refresh read first commits a durable provider-read intent with its organization, account, credential generation, resource, action, idempotency key, fixed query/window, and optional exact target, then reserves a provider attempt and lease before network I/O. A successful bounded normalized response is encrypted and captured with the succeeded attempt before staging. If staging fails, repeat the same action and key: ClawPilot decrypts and stages the exact captured response without another provider read. The run, candidates/rejections, continuation, command receipt, and intent transition to `staged` commit together. If a lease or intent expires before capture, ClawPilot marks the outcome uncertain or expired and invalidates its continuation; reload the state and select the visible **Restart session** action to begin a newly keyed bounded read. A next-page call is authorized only by the durable, resource-scoped continuation created with the preceding batch.

This procedure is bounded catalog mapping plus operational open-order intake, not historical migration, inventory synchronization, or an unattended catalog worker. `read_all_orders` allows an older still-open Shopify order to participate but does not authorize a closed-order backfill.

All intake requests are active-organization scoped, use `Cache-Control: no-store`, and fence account, read-intent, run/continuation, candidate, rejection, line, CRM, product, and package Global IDs against cross-tenant use. Row-backed decisions require the current `rowVersion`; every command requires a stable `idempotencyKey` and receives an exact-result receipt. Candidate party/address values remain protected until policy expiry. Migration `0115` clears encrypted cursor material when a continuation is consumed, invalidated, or expired, but no physical intake-row purge worker is claimed. Audit and command receipts exclude credentials, tokens, cursors, raw provider bodies, email/phone, and full address values.

The canonical request bodies are:

- `fetch` and `fetch-products`: `accountGlobalId`, `action`, `idempotencyKey`, `confirmReadOnly: true`; start independent order or product read sessions.
- `fetch-next` and `fetch-next-products`: the matching fetch fields plus `continuationRunGlobalId`; continue exactly one resource-scoped encrypted batch lineage.
- `resolve-catalog-product`: product-candidate Global ID, current `rowVersion`, and `resolution` in existing, create, or exclude mode. Create supplies name/SKU/price/currency; exclude supplies safe reason code/text.
- `retry-rejection`: rejection Global ID plus `confirmReadOnly: true`; reads one exact order identity. `exclude-rejection`: rejection Global ID, current `rowVersion`, and audit `reason`.
- `resolve-product`: candidate/line Global IDs, `rowVersion`, and `product` in existing or create mode with confirmed `unitPriceMinor` and `currency`.
- `resolve-customer`: candidate Global ID, `rowVersion`, and existing or create `customer`.
- `confirm-address`, `resolve-delivery`, and `resolve-package`: candidate/line identifiers as applicable, current `rowVersion`, and the explicit resolution object.
- `refresh`, `validate`, `mark-unsupported`, and `promote`: candidate Global ID and current `rowVersion`; refresh confirms read-only behavior, unsupported includes safe reason code/text, and promotion confirms provider write-off. A terminal candidate restarts only through a later `fetch`, not by mutating the terminal row.

This runbook is implementation and local/development acceptance guidance only. Do not record provider acceptance until the deployed development service completes the corresponding signed-in Shopify or Faire workflow.

## Product And Package Catalog

1. Open **Pipeline**, select the intended pipeline, and open **Configure > Products**. Confirm the active workspace first; product and package records are organization scoped.
2. Add one product manually or download the Products CSV template. Imports accept at most 500 data rows and 1 MB per file.
3. For package-aware fulfillment, provide package name, type, unit of measure, units per package, length, width, height, and weight. Select **Metric** for centimeters and kilograms or **Imperial** for inches and pounds. Supply all four measurement fields together or leave all four empty. ClawPilot stores canonical millimeters and grams for deterministic cartonization and carrier requests while retaining the selected entry system.
4. Import the CSV once and review the result. Valid rows are retained when other rows fail, and each failed row reports its source row number and reason.
5. Confirm an existing product was updated rather than duplicated. Matching uses SKU first when present and then case-insensitive product name. A conflicting name/SKU pair is rejected for review.
6. Open the product again and verify the permanent `gp` product identity and default `gpp` package profile. A later team edit must retain both identities and increment package evidence rather than create a second default profile.
7. Disable the package profile when its measurements must not drive fulfillment. The product may remain active for sales while fulfillment uses the clearly identified fallback until corrected package data is approved.

Only authorized pipeline editors can import or change the catalog. Viewers can inspect it but cannot mutate it. The current slice supports one default package profile per product; do not model alternate cartons, facility packs, or supplier-specific packs as duplicate products.

## Warehouse And Bin Setup

1. Open **Operations**, then select **Warehouses** in the horizontally scrollable subpanel row.
2. Select **New warehouse**. Choose the facility type, country, state or region, IANA timezone, and local carrier tender cutoff, then enter a unique facility code, facility name, and complete physical address. The address becomes operational master data; confirm it before later binding carrier accounts, pickup locations, or origin rules.
3. Leave **Create starter topology** enabled for a new facility unless a reviewed topology import will follow. ClawPilot creates receiving, inbound staging, storage, picking, packing, outbound staging, shipping, and returns nodes with parent-child relationships so the facility has a usable starting hierarchy.
4. Complete the **Operating profile**. Select at least one operating day, enter local opening and closing times, and record the typical release-to-carrier processing time. **Daily order capacity** is an optional planning threshold. These versioned values support configuration readiness and provide inputs for the upcoming promise and capacity execution slice; they do not schedule labor, reserve inventory, or reject work today.
5. Confirm the permanent `gwh` warehouse identity, facility type, operating profile, and active status. Use **Edit warehouse** to correct facility master data or retire the warehouse without replacing its identity.
6. Use **Add location** to create a building, zone, aisle, row, bay, level, shelf, bin, staging location, dock, pack station, workstation, or other operational location. **Physical level** identifies where the node sits in the warehouse hierarchy. **Operational use** identifies whether receiving, storage, picking, packing, staging, shipping, or returns work occurs there. Choose the parent, zone, active status, and deterministic **pick route order**. Location codes remain unique inside the warehouse and each location receives a permanent `gwl` identity.
7. Set **Pick route order** to the order in which released wave tasks should traverse source locations. Lower numbers are picked first. Leave gaps such as `100`, `200`, and `300` so a future location can be inserted without renumbering the full path. This setting is not customer priority, order priority, allocation priority, replenishment urgency, or inventory-pool priority.
8. Record optional maximum cubic storage and maximum weight in **Imperial** or **Metric** units. ClawPilot stores canonical cubic meters and kilograms while displaying capacity and current use in the operator-selected units. A new limit cannot be lower than current recorded use.
9. Add product placement rules when a location is allowed, preferred, or restricted for a catalog product. An optional positive maximum quantity may further limit that product at the location. A location may also prohibit mixed products.
10. Review **Operational readiness** for each warehouse. A complete core outbound path requires an active facility, an operating profile, and active receiving, storage or picking, packing, and outbound staging or shipping locations. The indicator reports configuration completeness; it does not certify inventory accuracy, labor availability, carrier readiness, or production activation.
11. Use **Edit location** to change topology, capacity, operational use, product placement, pick route order, or notes. A location cannot become its own parent or be moved beneath one of its descendants.
12. Use **Delete location** only after reviewing its children and operational references. A location with child nodes is blocked from removal. An unused location is deleted; a referenced location is retired and retained for historical integrity.
13. Configure physical printers under **Printing** and carrier billing files or GL Coding under **Billing & GL**. Those are separate facility services and do not become configured merely because a warehouse exists.

The current warehouse screen establishes editable facility, operating-profile, hierarchy, capacity, product-placement master data, a guided setup flow, and configuration-readiness evidence. Pick route order is authoritative when release creates pick tasks because tasks are sequenced by the source location's stored route order. Operating-profile values are persisted planning inputs but are not yet authoritative promise or throughput controls. Product placement rules and capacity limits are stored and visible but are not yet authoritative directed-putaway execution rules. Inbound appointments, ASNs, receiving execution, discrepancy capture, quality/quarantine, deterministic putaway enforcement, replenishment, cycle counts, transfers, lot/serial controls, and scanner-directed work remain subsequent WMS slices. Do not represent the topology editor, readiness indicator, migration `0101`, or operating-profile migration `0107` as evidence those workflows are complete.

## Planned Order, Warehouse Release, Pick Confirmation, And Pack Verification

1. Open **Operations**, select **Orders**, and open an eligible non-archived order received through an approved commerce boundary. The hosted workbench does not create proof orders; deterministic mock generation is reserved for automated tests.
2. Open the planned order and verify the customer, lines, warehouse plan, reservation and allocation quantities, package and selected-rate evidence, promise, and estimated cost/revenue/margin.
3. Resolve every open high or critical exception before release. Do not bypass an incomplete reservation or allocation with direct SQL.
4. Use **Release to warehouse**, record a specific operational reason, and submit once. The client keeps one idempotency key for safe retries of that release attempt.
5. On success, confirm the order and selected plan are `released`, exactly one released wave exists, and the expected pick tasks are `ready`.
6. Verify that every expected task is ready and that the displayed pick count matches the order lines. **Confirm all picks** is intentionally unavailable for partial, short, blocked, or already confirmed work.
7. Use **Confirm all picks**, record a specific operational reason, and submit once. The client keeps one idempotency key for safe retries. The command rechecks the exact order version, released plan and wave, all ready picks, active organization, inventory positions, and blocking exceptions before changing state.
8. On success, confirm the order is `picking`, the wave is `completed`, every pick task is `picked`, and the active reservation remains intact for the later pack/ship consumption command.
9. Verify the package details and use **Verify pack** only after every required pick is complete. Record a specific operational reason and submit once. The command rechecks the exact order version, selected plan, wave, picks, package state, active organization, blocking exceptions, and command receipt before changing state.
10. On success, confirm the order and package are `packed`, one pack-fee billable event exists for each applicable directive, the active reservation remains retained for shipment consumption, and no shipment, label, or print job was created by pack verification itself.
11. If the order matches the fixed sandbox fixture, follow the separate sandbox label create-and-void procedure. Label execution is not available for an arbitrary address, product, package, production credential, or production order.
12. If the screen reports a stale version, reload and re-review the current evidence before issuing a new command. Never change the idempotency key merely to bypass an uncertain result.
13. Current operator capability stops after bounded sandbox label create/void and label print routing. Scanner claims, per-task scans, short-pick handling, automatic packing-slip creation during shipment confirmation, shipment confirmation itself, pickup scheduling, manifests, tracking mutation, and production carrier actions remain unavailable until their explicit commands and reconciliation controls pass Phase 4 acceptance.

## Mobile Operations Subpanel Navigation

1. On a narrow screen, use the horizontally scrollable tab row beneath the Operations header to reach **Orders**, **Exceptions**, **Warehouses**, **Billing & GL**, and **Printing**. Swipe the tab strip or use its labeled left/right controls; the controls disable at the corresponding edge.
2. Keep the active subpanel visible before acting. Changing tabs clears the Orders/Exceptions search and closes open detail drawers so a command cannot be issued against a hidden prior context.
3. The tab strip owns horizontal movement and each selected subpanel owns its normal content scrolling. Do not interpret a clipped off-screen tab as a missing capability, and do not rely on page-level horizontal scrolling.

## Exception Queue Procedure

1. Open **Operations**, then select **Exceptions**.
2. Filter by status or search by exception Global ID, order number, title, or customer.
3. Open the exception and review its linked order, recommendation, and evidence before changing status.
4. Use **Acknowledge** when an operator has accepted ownership but work remains. Use **Resolve** only after the underlying operational state is verified. Use **Dismiss** only when the signal is invalid or non-actionable, and record supporting evidence at the source.
5. Reopen a resolved or dismissed exception when new evidence changes the disposition. ClawPilot retains the prior transitions in operations domain events and the global audit log.

Exception updates require operations-management permission. They never alter immutable inventory ledger, shipment, or billing evidence, and they do not silently create Projects tasks.

## Non-Negotiable Controls

1. Railway Postgres is the operational authority. File storage and Google Sheets never accept operations writes.
2. Freeze the smallest affected organization, integration account, warehouse, or command type before repairing uncertain state.
3. Never delete or update inventory ledger entries, domain events, published pricing facts, or billable facts. Correct them with approved compensating commands.
4. Never repeat a label purchase, shipment confirmation, inventory mutation, or accounting export with a new idempotency key merely because a response timed out.
5. Never hold a database transaction open while calling a provider, optimizer, or print agent.
6. Preserve Global IDs, correlation ID, idempotency key, adapter version, provider reference, timestamps, and safe error code during diagnosis.
7. Keep credentials, full addresses, customs data, raw labels, and unrestricted provider payloads out of tickets, chat, logs, audit payloads, and this repository.
8. Database restore is a last-resort coordinated recovery. Application defects use feature containment and code rollback; isolated data defects use compensating commands or later migrations.
9. Require each customer organization to configure and verify separate credentials for every enabled carrier and sandbox or production environment. Never substitute another organization's or a platform-wide account when credentials are absent, disabled, unverified, or environment-mismatched.
10. Never use a sandbox label, sandbox tracking number, successful print acknowledgement, or browser-visible package state as shipment confirmation or authority to consume inventory.

## Required Operating Roles

| Role | Responsibility | Required access |
| --- | --- | --- |
| Incident lead | Declares severity, contains scope, coordinates providers/customer communication, owns timeline | Operations health and audit, no routine database write needed |
| Application operator | Activation control, queues, workers, adapter health, code rollback | Operations administration and Railway app access |
| Database operator | Backups, migration verification, read-only diagnostics, approved recovery | Railway Postgres and backup permissions |
| Warehouse lead | Stops/restarts physical work, validates picks/packages/prints/shipments | Facility-scoped warehouse execution |
| Integration owner | Verifies provider account, webhook, rate/label/tracking state, cursor, and reconciliation | Named provider account only |
| Billing owner | Validates contract version, billable facts, credits/rebills, and export | Contract/billing access; margin/cost only when granted |
| Security lead | Handles cross-tenant, credential, portal, or unauthorized-action incidents | System audit, session/credential revocation |

One person may hold several roles for a small deployment, but the same person must not both create and independently approve a sensitive billing adjustment or cross-owner inventory override.

## Activation States

Runtime delivery provides durable audited organization activation. Production delivery must extend it to integration and warehouse subscopes:

| State | Allowed behavior |
| --- | --- |
| `disabled` | No operations routes, webhooks, workers, or UI commands; health and migration diagnostics only |
| `shadow` | Verify/store bounded provider receipts and compute comparisons; no reservations, labels, provider acknowledgements, or exports |
| `read_only` | Authorized queries, health, reconciliation, and evidence export; no domain commands |
| `active` | Approved command and adapter capabilities for the named cohort |
| `frozen` | Existing evidence remains queryable; new consequential commands and provider claims stop; approved reconciliation/void work is explicit |

Absence or invalid configuration means `disabled`. A global environment switch cannot expand a tenant that is not independently active.

## Health Contract

The existing endpoints remain required:

- `/api/persistence/status`: Postgres driver, reachability, and non-empty environment database fingerprint.
- `/api/health`: migration, worker, provider, queue, and dependency health.

Current `/api/health` verifies the required bounded operations migrations through `0115`, their recorded checksums, command failures, stale processing, and active/shadow organization counts. Before production activation health must additionally report:

- foundation and corrective migration applied/checksum state;
- activation state by cohort without exposing credentials;
- inventory reconciliation time, checked positions, drift count, and frozen scope count;
- command/outbox pending, failed, dead, stale, overdue, oldest due age, and last success;
- commerce/carrier/print/accounting adapter capability version, environment, circuit state, and last reconciliation;
- optimizer version, fallback rate, timeout/error count, and last successful health probe;
- label unknown-outcome count, print failure count, open critical exceptions, and oldest unbilled fact;
- worker heartbeat, claim lease age, and code version.

Health reports safe codes and counts, not source payloads, addresses, labels, tokens, or connection IDs.

## Routine Checks

### Start Of Operating Day

1. Confirm `/api/persistence/status` is Postgres, reachable, and points to the expected environment fingerprint.
2. Confirm `/api/health` is healthy and the expected operations cohort is `active`.
3. Confirm no inventory drift, dead jobs, stale leases, ambiguous labels, expired reservations, or critical exceptions.
4. Confirm each active commerce/carrier account is verified for the correct environment and reconciliation cursor is current.
5. Confirm facility calendar, cutoff, capacity, stations, printers, fallback routes, and carrier pickups for the day.
6. Confirm contract versions and required pricing directives are published for active customers.
7. Review orders on hold, promise risk, short picks, shipment exceptions, and prior-day unbilled activity.

### During Operations

- Watch import lag, unmatched products/customers, reservation failures, optimizer fallback, split plans, missed cutoffs, carrier circuits, label unknown outcomes, printer reroutes, short picks, shipment exceptions, and unbilled age.
- Treat a nonzero ledger drift, cross-customer allocation attempt, duplicate active label, or unauthorized data result as critical even if aggregate health remains green.
- Do not dismiss sustained fallback as harmless. A fallback can be safe while still signaling an optimizer or data-quality outage.

### End Of Operating Day

1. Reconcile imported/provider order counts and terminal/cancelled orders.
2. Reconcile inventory ledger to materialized balances and investigate every nonzero difference.
3. Reconcile label purchases/voids, manifests, shipments, tracking, and commerce fulfillment exports.
4. Reconcile estimated/accrued/final billable facts, credits, exports, and unbilled exceptions.
5. Review manual overrides, ownership borrowing, inventory adjustments, reprints, service changes, and margin erosion.
6. Confirm queues are draining and provider cursors have advanced.
7. Record unresolved exceptions with owner, next action, and due time.

## Deployment And Migration Procedure

### Before Development Application

1. Confirm whether `0081_distributed_operations_foundation.sql` and `0082_operations_activation_and_command_safety.sql` exist in `schema_migrations` as described in the [delivery plan](../architecture/distributed-operations-delivery-plan.md).
2. If it has applied anywhere, do not edit it. Require a later corrective migration.
3. Run schema tests against an empty database and a restored current snapshot.
4. Resolve every blocker in the [integration and gap map](../maps/distributed-operations-integration-gap-map.md) required for the enabled slice.
5. Capture a provider backup and validated logical dump.
6. Confirm operations activation defaults to `disabled` and no worker target can claim operations rows.

### Additive Schema Deployment

1. Apply through `npm run db:migrate` in development.
2. Confirm the migration filename and checksum:

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
WHERE filename LIKE '%distributed_operations%'
ORDER BY filename;
```

3. Confirm expected constraints/triggers/indexes through schema contract tests, not by row existence alone.
4. Compare existing application counts and `/api/health` before and after migration.
5. Deploy code with operations disabled, then verify lint, build, focused tests, full tests, docs, and predeploy checks.
6. Verify authenticated development queries and negative authorization before enabling a cohort.

### Cohort Activation

1. Name one organization, integration account, warehouse, provider environment, and capability set.
2. Complete configuration and opening-balance reconciliation from the delivery plan.
3. Use `shadow`, then `read_only`, before `active`.
4. Record provider cursor/cutoff, activation actor/time, application commit, migration checksums, adapter versions, contract versions, inventory totals, and rollback point.
5. Start with bounded orders that can be manually verified before warehouse release.
6. Expand only after one complete import-to-export cycle, required scenario pass, and zero unexplained reconciliation drift.

### Production Promotion

Use a reviewed `dev` to `main` pull request. Repeat backups, migration checks, hosted health, protected Vercel build status, one authenticated workflow, and cohort reconciliation. Do not copy development operational data or credentials into production.

## Read-Only Diagnostic Queries

Run queries through an approved read-only session when possible. Replace placeholders with internal UUIDs obtained from an authorized screen; do not paste results containing customer data into shared channels.

### Migration State

```sql
SELECT filename, checksum, applied_at
FROM schema_migrations
WHERE filename >= '0081'
ORDER BY filename;
```

### Queue State

```sql
SELECT target_system, status, count(*) AS jobs,
       min(available_at) AS oldest_available,
       max(updated_at) AS last_updated
FROM sync_outbox
WHERE aggregate_type LIKE 'operations.%'
GROUP BY target_system, status
ORDER BY target_system, status;
```

Inspect one job only by its authorized aggregate/correlation identifiers. Do not dump all payloads.

### Order Deduplication

```sql
SELECT organization_id, integration_account_id, external_order_id, count(*)
FROM operations_orders
GROUP BY organization_id, integration_account_id, external_order_id
HAVING count(*) > 1;
```

The expected result is zero rows. Duplicate webhook receipts require their own receipt-table diagnostic once implemented.

### Inventory Ledger Reconciliation

The `0081` draft can reconcile only on-hand and reserved deltas. Full activation requires ledger deltas for every projected bucket, including damaged/quarantine/allocated/picked/in-transit.

```sql
WITH ledger AS (
  SELECT organization_id, position_id,
         sum(on_hand_delta) AS ledger_on_hand,
         sum(reserved_delta) AS ledger_reserved
  FROM operations_inventory_ledger
  GROUP BY organization_id, position_id
)
SELECT position.global_id, position.on_hand_quantity,
       coalesce(ledger.ledger_on_hand, 0) AS ledger_on_hand,
       position.reserved_quantity,
       coalesce(ledger.ledger_reserved, 0) AS ledger_reserved
FROM operations_inventory_positions position
LEFT JOIN ledger
  ON ledger.organization_id = position.organization_id
 AND ledger.position_id = position.id
WHERE position.organization_id = :organization_id
  AND (
    position.on_hand_quantity <> coalesce(ledger.ledger_on_hand, 0)
    OR position.reserved_quantity <> coalesce(ledger.ledger_reserved, 0)
  )
ORDER BY position.global_id;
```

The expected result is zero rows. Any row triggers inventory containment.

### Active Reservations

```sql
SELECT reservation.global_id, reservation.status, reservation.quantity,
       reservation.expires_at, position.global_id AS position_global_id,
       order_row.global_id AS order_global_id
FROM operations_reservations reservation
JOIN operations_inventory_positions position
  ON position.organization_id = reservation.organization_id
 AND position.id = reservation.position_id
JOIN operations_orders order_row
  ON order_row.organization_id = reservation.organization_id
 AND order_row.id = reservation.order_id
WHERE reservation.organization_id = :organization_id
  AND reservation.status = 'active'
ORDER BY reservation.expires_at NULLS LAST, reservation.created_at;
```

### Label And Shipment Ambiguity

```sql
SELECT label.global_id AS label_global_id, label.carrier, label.service_code,
       label.status AS label_status, package.global_id AS package_global_id,
       shipment.global_id AS shipment_global_id, shipment.status AS shipment_status
FROM operations_labels label
JOIN operations_packages package
  ON package.organization_id = label.organization_id
 AND package.id = label.package_id
LEFT JOIN operations_shipments shipment
  ON shipment.organization_id = package.organization_id
 AND shipment.package_id = package.id
WHERE label.organization_id = :organization_id
  AND (label.status <> 'voided' OR shipment.id IS NOT NULL)
ORDER BY label.created_at DESC;
```

Use `operations_label_attempts` to identify `prepared` or `unknown` purchases and voids. Label rows alone cannot prove that a timed-out provider request did not succeed remotely.

### Shipment Completion Evidence

Do not select `payload.payload` during routine diagnosis. The following checks identities, states, and byte counts without returning customer-facing document bytes:

```sql
SELECT shipment.global_id AS shipment_global_id,
       shipment.status AS shipment_status,
       artifact.global_id AS packing_slip_global_id,
       artifact.content_sha256,
       octet_length(payload.payload) AS packing_slip_bytes,
       tracking.global_id AS first_tracking_global_id,
       tracking.status AS first_tracking_status,
       export.global_id AS commerce_export_global_id,
       export.state AS commerce_export_state,
       export.attempts AS commerce_export_attempts
FROM operations_shipments shipment
LEFT JOIN operations_print_artifacts artifact
  ON artifact.organization_id = shipment.organization_id
 AND artifact.source_shipment_id = shipment.id
 AND artifact.document_type = 'packing_slip'
LEFT JOIN operations_print_artifact_payloads payload
  ON payload.organization_id = artifact.organization_id
 AND payload.artifact_id = artifact.id
LEFT JOIN LATERAL (
  SELECT observation.global_id, observation.status
  FROM operations_tracking_observations observation
  WHERE observation.organization_id = shipment.organization_id
    AND observation.shipment_id = shipment.id
  ORDER BY observation.observed_at, observation.id
  LIMIT 1
) tracking ON true
LEFT JOIN operations_commerce_fulfillment_exports export
  ON export.organization_id = shipment.organization_id
 AND export.shipment_id = shipment.id
WHERE shipment.organization_id = :organization_id
ORDER BY shipment.shipped_at DESC NULLS LAST, shipment.global_id;
```

The `0099` completion columns are expected to be empty for sandbox labels and the legacy deterministic mock path. Until the production confirmation writer is implemented, do not repair those absences by inserting rows manually.

### Unbilled Activity

```sql
SELECT customer_id, currency, status, count(*) AS facts,
       sum(amount_minor) AS amount_minor,
       min(occurred_at) AS oldest_fact
FROM operations_billable_events
WHERE organization_id = :organization_id
  AND status IN ('estimated', 'unbilled')
GROUP BY customer_id, currency, status
ORDER BY oldest_fact;
```

This query reflects the `0081` draft. The final model must separate immutable charge facts from mutable invoice/export lifecycle.

## Incident Severity

| Severity | Examples | Initial action |
| --- | --- | --- |
| SEV-1 | Cross-tenant/customer disclosure, oversell or unexplained inventory drift with active work, duplicate live label/ship confirmation, unauthorized provider/accounting action, broad data corruption | Freeze affected and potentially related scopes immediately; page security/database/provider owners; preserve evidence |
| SEV-2 | Import or warehouse work blocked, carrier/print outage without safe fallback, accumulating critical exceptions, optimizer outage causing material backlog, billing export blocked near deadline | Freeze risky command only, activate approved fallback, assign incident lead, communicate operating impact |
| SEV-3 | Isolated order/print/rate/reconciliation failure with safe manual path, noncritical report delay, single mapping issue | Create owned exception/task, contain one object, resolve within operating SLA |

## Standard Incident Flow

1. **Detect and scope:** environment, organization, customer, integration account, warehouse, order/package/shipment Global IDs, first/last observed time, correlation ID, and safe error code.
2. **Contain:** move the narrowest activation scope to `frozen`; stop physical work when digital state may be wrong.
3. **Preserve:** capture health counts, migration/application/adapter versions, audit/event IDs, queue IDs, provider references, and a backup when data repair may follow.
4. **Classify authority:** determine whether ClawPilot, provider, physical stock, or accounting destination has the trusted fact for this incident.
5. **Reconcile:** use read-only comparisons and provider lookup before retrying or compensating.
6. **Recover:** use the authorized domain command, same idempotency key, provider void/reconciliation, compensating ledger/charge fact, code rollback, or later migration.
7. **Verify:** rerun the relevant S-ID scenario, health, reconciliation, and one real workflow before unfreezing.
8. **Close:** record root cause, customer/financial effect, exact repairs, prevention, owners, and release evidence without sensitive payloads.

## Incident Playbooks

### Migration Or Startup Failure

**Contain**

- Keep operations disabled. If migration is inside a transaction, allow `db:migrate` to roll it back; do not manually mark it applied.
- Do not edit an applied migration to make a retry pass.

**Diagnose**

- Inspect the migration filename/checksum row, safe database error, existing constraint/table shape, and deployment commit.
- Determine whether failure is additive schema, data precondition, lock timeout, or checksum mismatch.

**Recover**

- Fix an unapplied migration only if it has never applied in any shared environment. Otherwise add a corrective migration.
- Redeploy with operations disabled and repeat schema/health checks. Restore only if a failed operation escaped its transaction and broad integrity is affected.

### Duplicate, Missing, Or Stuck Order Import

**Contain**

- Freeze import for the affected integration account, not unrelated warehouses.
- Continue read-only provider reconciliation; do not delete one of two apparent orders.

**Diagnose**

- Compare provider event ID or intake-run ID, durable read intent, resource-scoped batch/session lineage, external order ID, rejection Global ID/disposition, candidate source hash/revision and row version, command receipt, canonical order, external identifier, import event, and outbox state.
- Verify credential generation, signature or provider-read intent/attempt, encrypted-continuation state, Shopify cutoff or Faire live-cursor/exact-refresh evidence, query hash, normalizer/adapter version, candidate retention state, exact remaining quantities, monetary-reconciliation evidence, resolutions, and promotion receipt. Determine whether this is redelivery, provider correction, stale resolution, consumed/invalid continuation, open/retried/excluded rejection, missed webhook/poll, mapping failure, or an uncertain promotion response.

**Recover**

- For an operator-controlled candidate, use `refresh`, redo only invalidated resolutions, `validate`, and retry `promote` with the original idempotency key. Never delete and recreate a candidate to bypass stale or uniqueness evidence.
- For a consumed continuation, reload and continue from the current batch. For an invalid, expired, exhausted, superseded, resource-mismatched, or credential-mismatched continuation, restart the matching order or product session; never alter cursor rows directly.
- For an order rejection, correct the external ID and select **Retry exact order**, or record an audit reason and **Exclude record**. For a product rejection, exclude the rejected revision, correct it at the provider, then run the bounded catalog fetch again. If a later order candidate stages but remains permanently unsupported, use **Mark unsupported**.
- For automated intake after it is released, replay the stored receipt with its original idempotency key after fixing mapping/code. Use reconciliation to import a missed provider order. Provider corrections become versioned order commands, not replacement rows.
- If duplicate side effects exist, stop and reconcile reservations, labels, shipments, and exports before merging any work through an approved repair.

### Inventory Drift Or Oversell Risk

**Contain**

- SEV-1. Freeze reservation, allocation, pick, adjustment, and shipment confirmation for every affected pool/position. Stop physical picking when system quantity cannot be trusted.
- Do not release reservations or edit positions with SQL.

**Diagnose**

- Run ledger reconciliation and compare physical count, open reservations, allocations, picks, shipments, returns, adjustments, pool ownership, lot/serial, and UOM conversion.
- Identify the first divergent ledger/event/correlation record and whether a transaction, offline replay, import, or manual process bypassed the command path.

**Recover**

- Fix code or configuration first. Record an approved physical count or compensating inventory command with reason, actor, source evidence, and new reconciliation.
- Replan affected orders and quantify customer/margin effect. Unfreeze only after zero drift and S07-S09 plus S23 pass for the affected pattern.

### Optimizer, Promise, Or Quote Failure

**Contain**

- Disable public checkout quotes if a response can violate a promise, leak cost, or select ineligible inventory.
- Permit deterministic fallback only when input completeness and fallback health are good.

**Diagnose**

- Compare input hash, algorithm/version, deadline, hard constraints, candidate/rejection evidence, carrier rate age, facility calendar/cutoff, and fallback reason.
- Distinguish solver outage from missing dimensions, inventory drift, carrier outage, or policy conflict.

**Recover**

- Restore the optimizer or correct versioned data. Replay the exact stored input to prove deterministic result.
- Never manually relax a promise or ownership constraint. An override creates a new plan version and exception with financial effect.

### Carrier Timeout Or Unknown Label Outcome

Provider behavior, capability, credential, timeout, response, and certification boundaries are defined in the [small parcel carrier adapter architecture](../architecture/small-parcel-carrier-adapters.md). RocketShipIt is an optional provider transport; it does not change the durable command and reconciliation requirements below.

**Contain**

- Freeze label purchase for the affected carrier account/service if reconciliation cannot determine outcomes.
- Keep package and order in exception; do not create a new purchase key.

**Diagnose**

- Locate the durable purchase intent, package version, provider key/reference, request hash, timeout, adapter/circuit state, and any carrier-side shipment/label.

**Recover**

- Query/reconcile by the original provider key or approved reference. If the label exists, persist that result idempotently. If the provider proves no purchase, retry with the same key.
- Void unwanted confirmed duplicates at the provider, retain both facts, prevent dispatch, and quantify cost. Never delete label evidence.

### Printer Failure Or Missing Physical Output

**Contain**

- Stop packing from assuming a queued job printed. Keep package shipment confirmation blocked if the process requires a physical label.

**Diagnose**

- Inspect job lease token, agent heartbeat, printer status/capability, route/rule version, attempts, fallback approval, and acknowledgement.

**Recover**

- Retry the same print job or create an auditable reprint command; route only to an approved compatible fallback. A print action never purchases another label.
- Mark every reprint and capture actor/reason. Confirm barcode readability before resuming.

### Short Pick

**Contain**

- Confirm the physical short and stop that task from completing as fully picked.

**Diagnose**

- Compare expected position, scans, lot/serial/UOM, physical count, reservation/allocation, replenishment, and other eligible positions/warehouses.

**Recover**

- Use the short-pick command. Allow deterministic reallocation only when ownership, pool, promise, cutoff, handling, and contract constraints still pass.
- Otherwise create one owned exception/task, update promise/customer communication through approved workflow, and reconcile the source position.

### Shipment Or Tracking Mismatch

**Contain**

- Stop duplicate confirmation/export. Do not set shipped/delivered based only on a stale browser response.

**Diagnose**

- Compare shipment, package, active label, manifest/pickup, append-only `gto` tracking observations, `gfe` commerce-export state, packing-slip artifact integrity, and outbox acknowledgements.

**Recover**

- Reconcile carrier and commerce state using original references. Append tracking observations and replay idempotent exports.
- If physical dispatch occurred without digital confirmation, use an approved recovery command that consumes inventory and creates missing immutable facts once.

### Contract Or Billing Discrepancy

**Contain**

- Stop the affected customer's invoice/export cohort; do not rewrite facts or publish a new contract version retroactively.

**Diagnose**

- Compare operational source, occurred time, contract/version/directive, precedence, base cost, quantity/UOM, rounding, estimate/accrual/final facts, credits, and provider cost.

**Recover**

- Correct future rules through a new effective version. Correct historical financial effect with approved credit/rebill facts linked to the original.
- Rebuild projections from facts and export only after totals reconcile by customer, currency, and accounting destination.

### Cross-Tenant, Portal, Or Credential Incident

**Contain**

- SEV-1. Disable affected routes/cohort, revoke sessions/service identity, and rotate provider credentials when exposure is possible.
- Preserve security audit and access logs; do not copy sensitive returned data into the incident record.

**Diagnose**

- Identify authenticated/effective identity, active workspace, membership, customer scope, permission, resource Global ID, worker claim, and adapter credential reference.

**Recover**

- Fix server-side scope enforcement; invalidate caches/sessions; verify direct-object-reference negative tests across list/detail/search/export.
- Determine disclosure/action scope with security and legal owners before reactivation. Rerun S07, S22, and all affected permission tests.

## Queue Recovery

- First freeze creation of new affected jobs when a target is failing materially.
- Distinguish pending, retryable failed, stale processing, dead, and succeeded. A high pending count can be load; a dead or stale job is an integrity concern.
- Recover stale leases only through the worker's lease-expiry path. Do not clear lock columns manually during normal operations.
- Replay by original outbox row/idempotency key after correcting the cause. Never clone the payload to force another attempt.
- For consequential provider outcomes, reconcile remote state before retry.
- A dead-letter replay records actor, reason, previous attempts/error code, next attempt, and resulting provider reference.

## Backup, Restore, And Disaster Recovery

Before risky migration, bulk inventory import, tenant cutover, or broad repair, verify Railway daily/weekly/monthly backup policy and take a validated logical export according to the backup runbook.

An operations restore additionally requires:

1. Freeze provider webhooks/claims or route them to durable quarantine so events are not lost.
2. Record provider cursors, label/shipment/accounting references, physical warehouse cutoff, and last trusted event time.
3. Restore to an isolated database first and run migrations plus operations reconciliation.
4. Compare orders, inventory ledger/positions, reservations, plans, labels, shipments, billable facts, domain events, outbox jobs, and external identifiers.
5. Plan provider replay/reconciliation from the restored cutoff. Do not blindly resend all outbox rows.
6. Rebind the application deliberately, verify environment fingerprint and credentials, then activate one cohort at a time.

The owner must define operations-specific RPO/RTO and each provider's webhook/replay retention before production activation.

## Credential And Adapter Rotation

1. Create and validate the candidate credential against the exact provider environment and account without exposing it.
2. Compare declared capabilities and account ownership to the active integration account.
3. Atomically switch the opaque credential reference and increment credential/configuration version.
4. Keep old credential only for a bounded rollback window in the secret store, never in Postgres configuration JSON.
5. Verify webhook signatures, rate/label/tracking or commerce reconciliation, then revoke the old credential.
6. Record safe audit metadata: actor, account Global ID, provider, environment, old/new version, verification result, and time.

Changing provider account identity is not a key rotation. It requires explicit re-binding, external-ID and shipment reconciliation, and usually a new integration account.

## Append-Only Repair Policy

| Incorrect fact | Allowed correction |
| --- | --- |
| Inventory quantity/status/ownership | Approved adjustment, transfer, release, damage, return, or ownership-borrow compensation ledger event |
| Reservation/allocation | Release/consume/reallocation command and new plan version |
| Promise/plan | New calculation/input snapshot and plan version; old selection remains evidence |
| Package/rate/label | New package version, re-rate, provider reconciliation, void, or marked reprint |
| Shipment/tracking | Recovery confirmation or new tracking observation; never overwrite provider history |
| Contract/pricing | New effective contract version/directive; no retroactive mutation |
| Charge | Credit/rebill/adjustment fact with approval and original reference |
| Domain event | Corrective event with causation link; no deletion or payload rewrite |

Direct SQL data changes require a reviewed, idempotent repair script or migration, a backup, dry run, row-count guard, explicit organization scope, audit evidence, reconciliation, and rollback/compensation plan. Ad hoc SQL updates are not an operating workflow.

## Reactivation Checklist

- Root cause is fixed or a bounded safe fallback is approved.
- No migration checksum mismatch or unexpected schema state exists.
- Inventory and provider reconciliation is exact for affected scope.
- No unknown label outcome, duplicate active shipment, stale lease, or dead consequential job remains.
- Contract and billing totals reconcile when financially affected.
- Relevant S-ID tests, focused regression, health, and one real development workflow pass.
- Warehouse and integration owners agree on physical/provider state and cutoff.
- Activation resumes from `read_only` or `shadow` before `active` when state changed materially.
- Incident record names impact, repair, evidence, remaining risk, and follow-up owner.

## Connected Notes

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Integration and Gap Map](../maps/distributed-operations-integration-gap-map.md)
- [Distributed Operations Delivery, Migration, and Test Plan](../architecture/distributed-operations-delivery-plan.md)
- [Native Distributed Operations Authority and Adapter Boundaries](../decisions/0006-native-distributed-operations-authority.md)
- [Application Shell and Access](../modules/application-shell-and-access.md)
- [User Integrations and Credentials](../modules/user-integrations.md)
