#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptSourceModule(source, path, mocks = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Buffer,
    Error,
    Headers,
    JSON,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    URL,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [
  migration,
  unitCartonizationMigration,
  duplicateWorkbenchMigration,
  persistence,
  route,
  ordersRoute,
  operationsRoute,
  operations,
  types,
  intake,
  candidateResolver,
  drawer,
  idempotency,
  orderListQuery,
] = await Promise.all([
  read('db/migrations/0307_operations_commerce_order_workbench.sql'),
  read('db/migrations/0321_operations_unit_item_cartonization.sql'),
  read('db/migrations/0322_operations_duplicate_order_workbench_recovery.sql'),
  read('app_src/lib/persistence/commerceOrderWorkbench.ts'),
  read('app_src/app/api/operations/order-workbench/route.ts'),
  read('app_src/app/api/operations/orders/route.ts'),
  read('app_src/app/api/operations/route.ts'),
  read('app_src/lib/persistence/operations.ts'),
  read('app_src/lib/operations/types.ts'),
  read('app_src/lib/integrations/commerceIntake.ts'),
  read('app_src/lib/persistence/commerceIntake.ts'),
  read('app_src/components/operations/ImportedOrderWorkingCopyDrawer.tsx'),
  read('app_src/lib/operations/orderWorkbenchIdempotency.ts'),
  read('app_src/lib/operations/orderListQuery.ts'),
])

for (const fragment of [
  'duplicate_workbenches',
  'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL',
  "receipt.status = 'processing'",
  'canonical.external_order_id = candidate.external_order_id',
  'SET canonical_order_id = canonical.id',
]) {
  assert.ok(
    duplicateWorkbenchMigration.includes(fragment),
    `Duplicate workbench recovery migration is missing ${fragment}`,
  )
}

for (const fragment of [
  'unit_multiplier = 1',
  "packaging_state = 'not_required'",
  "array_remove(blocking_codes, 'packaging_required')",
  'line.unit_multiplier <> 1',
  'cartonization chooses',
]) {
  assert.ok(
    unitCartonizationMigration.includes(fragment),
    `Unit cartonization migration is missing ${fragment}`,
  )
}

for (const fragment of [
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '30s'",
  'SET LOCAL search_path = public, pg_catalog, pg_temp',
  'CREATE TABLE operations_commerce_order_workbench',
  'accepted_provider_source_hash',
  'ship_to_ciphertext bytea',
  "'local_missing'",
  "'local_incomplete'",
  "'local_carrier_ready'",
  "'local_only'",
  'operations_commerce_order_workbench_candidate_fkey',
  'operations_commerce_order_workbench_receipt_fkey',
  'accepted provider binding is immutable',
  'operations.commerce_order_workbench.refresh',
  'matching durable refresh receipt',
  'customer_global_id_draft text',
  'requested_delivery_at_draft timestamptz',
  'line_resolution_drafts jsonb',
  'operations_commerce_order_workbench_line_drafts_valid',
  'Commerce order working copy customer draft is invalid',
  'Commerce order working copy line draft is invalid',
]) {
  assert.ok(migration.includes(fragment), `0307 is missing ${fragment}`)
}
assert.equal(
  migration.includes('ALTER TABLE operations_orders'),
  false,
  '0307 must not weaken canonical operations orders',
)
assert.equal(
  migration.includes('ALTER TABLE operations_commerce_order_candidates'),
  false,
  '0307 must not reinterpret immutable intake candidates',
)

for (const fragment of [
  'readCommerceOrderWorkbenchFromPostgres',
  'updateCommerceOrderWorkbenchShipToInPostgres',
  'acceptCommerceOrderWorkbenchInPostgres',
  "sync_state = 'local_only'",
  'providerWrites: 0',
  'providerWriteIntentCreated: false',
  'expectedRowVersion',
  'operations_command_receipts',
  'recordAuditEvent',
  'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
  'selected_candidate_ids',
  "ILIKE $3 ESCAPE '!'",
  'latest_provider_source_hash',
  'confirmCommerceCandidateAddressInPostgres',
  'validateCommerceCandidateInPostgres',
  'promoteCommerceCandidateInPostgres',
  "promotionStatus: 'promoted'",
  "remainingBlockerCodes: ['provider_refresh_rebase_required']",
  'retained.canonical_order_id IS NULL',
  'retained_candidate.canonical_order_id IS NULL',
  'canonical_order_id = canonical.canonical_order_id',
  'mergeCommerceOrderWorkbenchProviderAddress',
  'mergeCommerceOrderWorkbenchRequestedDelivery',
  'mergeCommerceOrderWorkbenchLineDrafts',
  'rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres',
  'readCommerceOrderWorkbenchRefreshTargetFromPostgres',
  'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT',
  'provider_rebased',
  'returnedQuantity: optionalTimelineInteger(line.returnedQuantity)',
  'providerObservationKinds:',
  "'manual_exact_read', 'webhook_exact_read'",
  'row.latest_exact_history_observed_at?.toISOString() || null',
  'resolveCommerceCandidateCustomerInPostgres',
  'resolveCommerceCandidateDeliveryInPostgres',
  'resolveCommerceCandidateProductInPostgres',
  'resolveCommerceCandidatePackageInPostgres',
  'applyWorkbenchResolutionDraft',
  'includeResolutionDetails',
  'preservedLineDrafts',
  "input.action === 'save'",
  'AS requires_carrier_address',
  'saved.candidate.requires_carrier_address',
  'requested_delivery_at_draft = $15::timestamptz',
  "field: 'requestedDeliveryAt'",
]) {
  assert.ok(persistence.includes(fragment), `Persistence is missing ${fragment}`)
}
assert.match(
  persistence,
  /SELECT provider_candidate\.id,[\s\S]{0,900}ORDER BY\s+COALESCE\(\s*provider_candidate\.provider_updated_at,\s*provider_candidate\.observed_at\s*\) DESC,\s*provider_candidate\.observed_at DESC/u,
  'terminal display candidates must follow provider revision time before arrival time',
)
assert.match(
  persistence,
  /SELECT observation\.observed_at[\s\S]{0,900}observation_kind IN \([\s\S]{0,180}ORDER BY COALESCE\(\s*observation\.provider_updated_at,\s*observation\.observed_at\s*\) DESC,\s*observation\.observed_at DESC,\s*observation\.id DESC/u,
  'the current exact-history marker must follow provider revision time before arrival time',
)
assert.equal(
  persistence.includes('INSERT INTO operations_commerce_external_effect_intents'),
  false,
  'A local save must create zero provider-write intents',
)
assert.equal(
  /UPDATE operations_commerce_order_candidates/u.test(persistence),
  false,
  'A local save must not mutate the provider intake candidate',
)
assert.ok(
  persistence.indexOf("ILIKE $3 ESCAPE '!'")
    < persistence.indexOf('LIMIT $10::integer'),
  'Search must execute in SQL before the bounded result cap',
)
assert.ok(
  persistence.includes('LIMIT $10::integer'),
  'Each Orders pane keyset query must retain a bounded page size',
)
assert.equal(
  /candidate\.id DESC\s+LIMIT 1000`/u.test(persistence),
  false,
  'The Orders pane must not silently stop at 1,000 current provider orders',
)
assert.equal(
  persistence.includes('.filter((order)'),
  false,
  'Bounded rows must not be filtered in memory after the SQL limit',
)
assert.equal(
  persistence.includes('.slice(0, 100)'),
  false,
  'The Orders pane must not hide staged provider orders after the SQL query',
)

for (const fragment of [
  'export async function GET',
  'export async function PATCH',
  'export async function POST',
  "'resolution'",
  'resolutionDraftValue(body.resolution)',
  'includeResolutionDetails: true',
  'refreshCommerceOrderWorkbenchCandidate',
  'rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres',
  'acceptCommerceOrderWorkbenchInPostgres',
  'capabilities.canManage',
  'idempotencyKeyValue(req)',
  'derivedOrderWorkbenchIdempotencyKey',
  "purpose: 'provider'",
]) {
  assert.ok(route.includes(fragment), `Route is missing ${fragment}`)
}

for (const fragment of [
  "input.purpose === 'provider'",
  '(bytes[6] & 0x0f) | 0x50',
  '(bytes[8] & 0x3f) | 0x80',
]) {
  assert.ok(
    idempotency.includes(fragment),
    `Order workbench idempotency is missing ${fragment}`,
  )
}

for (const fragment of [
  'refreshCommerceOrderWorkbenchCandidate',
  'runAutomaticOrderHooks: false',
  "action: 'refresh'",
  'confirmReadOnly: true',
]) {
  assert.ok(intake.includes(fragment), `Intake refresh is missing ${fragment}`)
}
assert.ok(
  candidateResolver.includes(
    "WHEN $2 = 'provider' THEN provider_requested_delivery_at",
  ),
  'Provider delivery resolution must preserve exact stored timestamp precision',
)
for (const fragment of [
  'readCurrentLineRuntimePackMapping',
  'resolveCommerceRuntimePack({',
  "packagingSource = mappedPackaging",
  "? 'variant_pack_mapping'",
  "array_remove(blocking_codes, 'product_mapping_required')",
  "'packaging_required'",
  'packResolution:',
]) {
  assert.ok(
    candidateResolver.includes(fragment),
    `Product resolution must reconcile the current mapped Product pack: ${fragment}`,
  )
}
for (const fragment of [
  'Review each local value changed by the provider refresh.',
  'Keep mine:',
  'Use {providerLabel(order!.provider)}:',
  'Use refreshed provider item',
  'It has not been discarded.',
  'Apply choices',
  'Accept &amp; import',
  "field === 'requestedDeliveryAt'",
  'savedDraftComplete',
  "shippingRequired && draftReadiness !== 'carrier_ready'",
  'Approved pack constraint (optional)',
  'No pack constraint — use cartonization',
  'Unit item — cartonization chooses outbound packaging.',
]) {
  assert.ok(drawer.includes(fragment), `Drawer refresh is missing ${fragment}`)
}
assert.equal(
  drawer.includes('!line.requiresShipping || draft.packageProfileGlobalId'),
  false,
  'The workbench must not require a manual legacy package profile when the mapped Product pack can be reconciled during acceptance',
)
assert.ok(
  persistence.includes('canonical.external_order_id = candidate.external_order_id'),
  'Already-canonical provider identities must not remain in the imported working-copy list',
)
assert.equal(
  /reasonValue|confirmationStatement|canActivate/u.test(route),
  false,
  'Ordinary local order edits must not require activation ceremony',
)
assert.ok(
  route.includes("'requestedDeliveryAt'"),
  'Refresh choices must accept an explicit requested-delivery resolution',
)
assert.ok(
  operationsRoute.includes('error instanceof CommerceOrderWorkbenchError'),
  'The ordinary Operations route must preserve safe workbench error codes',
)

assert.ok(
  operations.includes('readCommerceOrderWorkbenchPageFromPostgres'),
  'Operations workspace must load a bounded imported-order page',
)
assert.ok(
  operations.includes('importedOrders: importedOrderResult.orders'),
  'Operations workspace must expose imported working copies',
)
assert.ok(
  types.includes('importedOrders: OperationsImportedOrderWorkingCopy[]'),
  'Workspace contract must expose imported working copies',
)
for (const fragment of [
  'readCommerceOrderWorkbenchPageFromPostgres',
  'count(*) OVER ()::text AS matching_total_count',
  'matching.cursor_sort_value ${comparison} $8::${sortSql.cursorCast}',
  'matching.candidate_id ${comparison} $9::uuid',
  'selected.cursor_sort_value',
  'candidate_context.tracking_number ILIKE',
  'COALESCE(line.sku_snapshot',
  'COALESCE(line.sku',
  'nextCursor',
  'complete: nextCursor === null',
  'truncated: nextCursor !== null',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Workbench pagination is missing ${fragment}`,
  )
}
assert.ok(
  types.includes('importedOrderPage: OperationsImportedOrderPage'),
  'Workspace contract must expose imported-order page completion evidence',
)
for (const fragment of [
  'export async function readOperationsOrderPageFromPostgres',
  'WITH matching_order_ids AS',
  'count(*) OVER ()::text AS matching_total_count',
  'matching.cursor_sort_value ${comparison} $8::${sortSql.cursorCast}',
  'matching.id ${comparison} $9::uuid',
  'line.channel_sku ILIKE',
  'latest_tracking.tracking_number ILIKE',
  'LIMIT $10::integer',
  'orderPage: orderPageResult.page',
]) {
  assert.ok(
    operations.includes(fragment),
    `Canonical order pagination is missing ${fragment}`,
  )
}
for (const fragment of [
  'export async function GET',
  'readOperationsOrderPageFromPostgres',
  'cursor: cursor || null',
  'pageSize',
  'sort: sortValue',
  'direction: directionValue',
  'provider: providerValue || null',
  'tracking,',
  'updatedAfter: updatedAfterValue || null',
]) {
  assert.ok(
    ordersRoute.includes(fragment),
    `Canonical order page route is missing ${fragment}`,
  )
}
assert.ok(
  types.includes('orderPage: OperationsOrderPage'),
  'Workspace contract must expose canonical order page completion evidence',
)
for (const fragment of [
  'workflowState:',
  'actionAvailable: boolean',
  'candidate_context.display_status',
  'display_snapshot.order_number_snapshot',
]) {
  assert.ok(
    types.includes(fragment) || persistence.includes(fragment),
    `Unified order contract is missing ${fragment}`,
  )
}
assert.ok(
  orderListQuery.includes('OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS = 500'),
  'Order-list cursor sort keys must have a shared bounded width',
)
for (const fragment of [
  "'updated'",
  "'order_number'",
  "'customer'",
  "'status'",
  "'provider'",
  "'tracking'",
  'isOperationsOrderUpdatedAfter',
]) {
  assert.ok(
    orderListQuery.includes(fragment),
    `Order-list query contract is missing ${fragment}`,
  )
}
for (const source of [route, ordersRoute, operationsRoute]) {
  for (const fragment of [
    "searchParams.get('sort')",
    "searchParams.get('direction')",
    "searchParams.get('provider')",
    "searchParams.get('tracking')",
    "searchParams.get('updatedAfter')",
  ]) {
    assert.ok(source.includes(fragment), `Order route is missing ${fragment}`)
  }
}
for (const fragment of [
  'canonicalOrderGlobalId: string | null',
  "promotionStatus: 'not_ready' | 'needs_info' | 'promoted'",
  'remainingBlockerCodes: string[]',
  'resolutionDetailsLoaded: boolean',
  'OperationsImportedOrderWorkingCopyDraft',
  'requestedDeliveryAt: string | null',
  'updatedAt: string',
  'trackingNumber: string | null',
  'orderValueMinor: string | null',
  'currency: string',
]) {
  assert.ok(types.includes(fragment), `Result contract is missing ${fragment}`)
}

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.status = status
    this.code = code
  }
}

class CommerceOrderWorkbenchError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

class CommerceOrderSyncError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

class ShopifyCommerceClientError extends Error {
  constructor(message, status = 502, code = 'SHOPIFY_UPSTREAM_FAILED') {
    super(message)
    this.status = status
    this.code = code
  }
}

const organizationId = 'bb13beb0-2b75-48a2-8b1d-2bd154950668'
const actorEmail = 'workbench-route@example.test'
const candidateGlobalId = 'gcoc1000001'
const latestTargetCandidateGlobalId = 'gcoc1000002'
const inboundIdempotencyKey = 'd4783b27-b341-49d0-8e1e-1278b39039a8'
const providerRefreshCalls = []
const historyReadCalls = []
const historyAppendCalls = []
const historyReplayCalls = []
const rebaseCalls = []
let historyReadError = null
let historyAppendError = null
let historyReplay = null
const idempotencyModule = loadTypeScriptSourceModule(
  idempotency,
  'app_src/lib/operations/orderWorkbenchIdempotency.ts',
)
const orderListQueryModule = loadTypeScriptSourceModule(
  orderListQuery,
  'app_src/lib/operations/orderListQuery.ts',
)
const workbenchRoute = loadTypeScriptSourceModule(
  route,
  'app_src/app/api/operations/order-workbench/route.ts',
  {
    'next/server': {
      NextResponse: {
        json(payload, init = {}) {
          return new Response(JSON.stringify(payload), {
            status: init.status || 200,
            headers: {
              'Content-Type': 'application/json',
              ...(init.headers || {}),
            },
          })
        },
      },
    },
    '@/lib/integrations/commerceIntake': {
      async refreshCommerceOrderWorkbenchCandidate(input) {
        providerRefreshCalls.push(input)
      },
    },
    '@/lib/integrations/commerceOrderHistory': {
      exactShopifyOrderHistoryProviderReads(error) {
        return Number.isSafeInteger(error?.providerReads)
          ? error.providerReads
          : null
      },
      async readExactShopifyOrderHistoryObservation(input) {
        historyReadCalls.push(input)
        if (historyReadError) throw historyReadError
        return {
          observation: {
            observationKind: 'manual_exact_read',
            externalOrderId: input.externalOrderId,
            providerReadCount: 3,
          },
          providerReads: 3,
          providerWrites: 0,
        }
      },
    },
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError,
      sanitizedCommerceIntegrationError(error) {
        return {
          code: error.code,
          message: error.message,
          status: error.status,
        }
      },
    },
    '@/lib/integrations/shopifyCommerceClient': {
      ShopifyCommerceClientError,
    },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId(actor) {
        return actor.organizationId
      },
      operationsCapabilities(actor) {
        return actor.capabilities
      },
    },
    '@/lib/operations/orderListQuery': orderListQueryModule,
    '@/lib/operations/orderWorkbenchIdempotency': idempotencyModule,
    '@/lib/operations/orderShipTo': {
      ORDER_SHIP_TO_FIELDS: [
        'name',
        'line1',
        'line2',
        'city',
        'region',
        'postalCode',
        'country',
      ],
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled() {
        return true
      },
    },
    '@/lib/persistence/commerceOrderSync': {
      CommerceOrderSyncError,
      async readCommerceOrderWorkbenchExactReadReplayInPostgres(input) {
        historyReplayCalls.push(input)
        return historyReplay
      },
      async appendCommerceOrderWorkbenchExactReadInPostgres(input) {
        historyAppendCalls.push(input)
        if (historyAppendError) throw historyAppendError
        return { providerReads: 3, providerWrites: 0 }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
        return input.read({
          id: '66f1bf15-ad9e-4b62-a099-7e91c01b43dc',
          authorityKind: 'manual_read_only',
          readKind: 'order_history',
          intentFingerprintSha256: 'a'.repeat(64),
          controlRevision: 1,
          activationRevision: 1,
          expiresAt: '2026-09-01T18:00:00.000Z',
        })
      },
    },
    '@/lib/persistence/commerceOrderWorkbench': {
      CommerceOrderWorkbenchError,
      async readCommerceOrderWorkbenchRefreshTargetFromPostgres(input) {
        assert.deepEqual(JSON.parse(JSON.stringify(input)), {
          organizationId,
          candidateGlobalId,
        })
        return {
          accountGlobalId: 'gia1000001',
          integrationAccountId: 'f923a810-9f0d-45ae-865b-cbb4f41553cc',
          provider: 'shopify',
          externalOrderId: 'gid://shopify/Order/1000001',
          credentialGeneration: 1,
          candidateGlobalId: latestTargetCandidateGlobalId,
          candidateRowVersion: 0,
        }
      },
      async rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres(input) {
        rebaseCalls.push(input)
        return {
          previousCandidateGlobalId: candidateGlobalId,
          candidateGlobalId,
          rowVersion: 0,
          status: 'unchanged',
          providerChangedFields: [],
          preservedLocalFields: [],
          preservedLineDrafts: [],
          providerWrites: 0,
          providerWriteIntentCreated: false,
          replayed: false,
        }
      },
      async readCommerceOrderWorkbenchFromPostgres() {
        return [{ candidateGlobalId, provider: 'shopify' }]
      },
    },
    '@/lib/requestUser': {
      async requireRequestUser() {
        return {
          email: actorEmail,
          organizationId,
          capabilities: { canManage: true },
        }
      },
    },
  },
)
const refreshRequest = new Request(
  'https://clawpilot.example/api/operations/order-workbench',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': inboundIdempotencyKey,
    },
    body: JSON.stringify({
      action: 'refresh',
      candidateGlobalId,
      expectedRowVersion: 0,
    }),
  },
)
const refreshResponse = await workbenchRoute.POST(refreshRequest)
assert.equal(refreshResponse.status, 200)
assert.equal((await refreshResponse.json()).ok, true)
assert.equal(providerRefreshCalls.length, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(providerRefreshCalls[0])),
  {
    organizationId,
    accountGlobalId: 'gia1000001',
    actorEmail,
    idempotencyKey: idempotencyModule.derivedOrderWorkbenchIdempotencyKey({
      organizationId,
      idempotencyKey: inboundIdempotencyKey,
      candidateGlobalId,
      purpose: 'provider',
    }),
    candidateGlobalId,
  },
  'the POST refresh route must pass the derived provider key to commerce intake',
)
assert.match(
  providerRefreshCalls[0].idempotencyKey,
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  'commerce intake must receive a valid UUID idempotency key',
)
assert.equal(rebaseCalls.length, 1)
assert.equal(historyReadCalls.length, 1)
assert.equal(historyAppendCalls.length, 1)
assert.equal(historyReadCalls[0].observationKind, 'manual_exact_read')
assert.equal(historyReplayCalls.length, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(historyReplayCalls[0])),
  {
    organizationId,
    integrationAccountId: 'f923a810-9f0d-45ae-865b-cbb4f41553cc',
    externalOrderId: 'gid://shopify/Order/1000001',
    intentKey: `order-workbench-history:${inboundIdempotencyKey}:${candidateGlobalId}`,
  },
  'exact-history replay lookup must remain bound to the accepted order command',
)

historyReplay = {
  status: 'captured',
  code: null,
  providerReads: 0,
  providerWrites: 0,
}
const replayResponse = await workbenchRoute.POST(new Request(
  'https://clawpilot.example/api/operations/order-workbench',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': inboundIdempotencyKey,
    },
    body: JSON.stringify({
      action: 'refresh',
      candidateGlobalId,
      expectedRowVersion: 0,
    }),
  },
))
assert.equal(replayResponse.status, 200)
assert.deepEqual(
  JSON.parse(JSON.stringify((await replayResponse.json()).historyRefresh)),
  historyReplay,
  'a lost-response retry must replay the durable exact capture',
)
assert.equal(historyReadCalls.length, 1)
assert.equal(historyAppendCalls.length, 1)
assert.equal(historyReplayCalls.length, 2)
assert.equal(
  historyReplayCalls[1].intentKey,
  historyReplayCalls[0].intentKey,
  'a changed latest candidate must not change the same command replay key',
)
historyReplay = null

historyReadError = new ShopifyCommerceClientError(
  'Shopify exact-order read timed out',
  502,
  'SHOPIFY_UPSTREAM_FAILED',
)
historyReadError.providerReads = 2
const unavailableResponse = await workbenchRoute.POST(new Request(
  'https://clawpilot.example/api/operations/order-workbench',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': '9eadcadd-ef5c-45dd-99ce-bf1b5d71dd20',
    },
    body: JSON.stringify({
      action: 'refresh',
      candidateGlobalId,
      expectedRowVersion: 0,
    }),
  },
))
assert.equal(unavailableResponse.status, 200)
const unavailablePayload = await unavailableResponse.json()
assert.equal(unavailablePayload.ok, true)
assert.deepEqual(
  JSON.parse(JSON.stringify(unavailablePayload.historyRefresh)),
  {
    status: 'unavailable',
    code: 'SHOPIFY_UPSTREAM_FAILED',
    providerReads: 2,
    providerWrites: 0,
  },
  'a genuine Shopify read failure may degrade without losing the refreshed order',
)
historyReadError = null

historyReplay = {
  status: 'unavailable',
  code: 'COMMERCE_ORDER_HISTORY_PREVIOUSLY_UNAVAILABLE',
  providerReads: 0,
  providerWrites: 0,
}
const unavailableReplayResponse = await workbenchRoute.POST(new Request(
  'https://clawpilot.example/api/operations/order-workbench',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': '9eadcadd-ef5c-45dd-99ce-bf1b5d71dd20',
    },
    body: JSON.stringify({
      action: 'refresh',
      candidateGlobalId,
      expectedRowVersion: 0,
    }),
  },
))
assert.equal(unavailableReplayResponse.status, 200)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    (await unavailableReplayResponse.json()).historyRefresh,
  )),
  historyReplay,
  'a same-key unavailable result must replay without a duplicate provider read',
)
assert.equal(historyReadCalls.length, 2)
historyReplay = null

historyAppendError = new Error('exact history append failed')
const persistenceFailureResponse = await workbenchRoute.POST(new Request(
  'https://clawpilot.example/api/operations/order-workbench',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': '27649439-c8c3-4bb1-a9cb-e602637bb566',
    },
    body: JSON.stringify({
      action: 'refresh',
      candidateGlobalId,
      expectedRowVersion: 0,
    }),
  },
))
assert.equal(persistenceFailureResponse.status, 500)
assert.equal((await persistenceFailureResponse.json()).ok, false)
historyAppendError = null

console.log('Commerce order workbench contract passed')
