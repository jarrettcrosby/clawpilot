#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const routePath = 'app_src/app/api/operations/order-status-sync/route.ts'
const commandPath = 'app_src/lib/operations/commerceOrderRevisionCommands.ts'
const persistencePath = 'app_src/lib/persistence/commerceOrderRevisions.ts'
const operationsPath = 'app_src/lib/persistence/operations.ts'
const uiPath = 'app_src/components/operations/OperationsSection.tsx'

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function loadTypeScriptModule(path, mocks) {
  const source = readFileSync(resolve(root, path), 'utf8')
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
    Error,
    Headers,
    JSON,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    String,
    URL,
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

class CommerceOrderRevisionDispositionError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const actorEmail = 'manager@example.test'
let actor = {
  email: actorEmail,
  organizationId,
  capabilities: { canManage: true },
}
let postgresEnabled = true
let candidates = []
let refreshResults = new Map()
let batchReplay = null
let activeRefreshes = 0
let maximumActiveRefreshes = 0
const batchReceiptId = '33333333-3333-4333-8333-333333333333'
const batchAttemptToken = '44444444-4444-4444-8444-444444444444'
const calls = { candidates: [], prepare: [], refresh: [], complete: [] }

const route = loadTypeScriptModule(routePath, {
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
  '@/lib/operations/authorization': {
    operationsCapabilities(value) {
      return value.capabilities
    },
    activeOperationsOrganizationId(value) {
      return value.organizationId
    },
  },
  '@/lib/operations/commerceOrderRevisionCommands': {
    async refreshCommerceOrderRevisionFromProvider(input) {
      calls.refresh.push(input)
      activeRefreshes += 1
      maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes)
      await Promise.resolve()
      activeRefreshes -= 1
      const retained = refreshResults.get(input.orderGlobalId)
      if (retained instanceof Error) throw retained
      return retained
    },
  },
  '@/lib/persistence/config': {
    isPostgresStorageEnabled() {
      return postgresEnabled
    },
  },
  '@/lib/persistence/commerceOrderRevisions': {
    CommerceOrderRevisionDispositionError,
    async listCommerceOrderRevisionRefreshCandidatesInPostgres(input) {
      calls.candidates.push(input)
      return candidates
    },
    async prepareCommerceOrderStatusSyncBatchInPostgres(input) {
      calls.prepare.push(input)
      return {
        receiptId: batchReceiptId,
        attemptToken: batchReplay ? null : batchAttemptToken,
        candidates: input.candidates,
        replayedResult: batchReplay,
      }
    },
    async completeCommerceOrderStatusSyncBatchInPostgres(input) {
      calls.complete.push(input)
    },
  },
  '@/lib/requestUser': {
    async requireRequestUser() {
      return actor
    },
  },
})

function request(options = {}) {
  const headers = options.headers === undefined
    ? {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'status-sync-request-1',
      }
    : options.headers
  const result = new Request(
    options.url || 'https://clawpilot.example/api/operations/order-status-sync',
    {
      method: 'POST',
      headers,
      body: options.body === undefined
        ? JSON.stringify({ excludeOrderGlobalIds: [] })
        : options.body,
    },
  )
  Object.defineProperty(result, 'nextUrl', { value: new URL(result.url) })
  return result
}

function revision(orderGlobalId, materialState, changed, providerReads = 2) {
  return {
    replayed: false,
    capture: {
      observationGlobalId: 'gcor1000001',
      readGlobalId: 'gcrr1000001',
      sourceHash: 'a'.repeat(64),
      changed,
      materialState,
      managerDispositionRequired: materialState !== 'current',
      providerReads,
      providerWrites: 0,
    },
    revision: {
      orderGlobalId,
      state: {
        materialState,
        changed,
        providerReads,
        providerWrites: 0,
      },
    },
  }
}

function reset() {
  actor = {
    email: actorEmail,
    organizationId,
    capabilities: { canManage: true },
  }
  postgresEnabled = true
  candidates = []
  refreshResults = new Map()
  batchReplay = null
  activeRefreshes = 0
  maximumActiveRefreshes = 0
  calls.candidates.length = 0
  calls.prepare.length = 0
  calls.refresh.length = 0
  calls.complete.length = 0
}

reset()
candidates = [
  { orderGlobalId: 'gor1000001', orderRowVersion: 3, provider: 'shopify', totalEligible: 7 },
  { orderGlobalId: 'gor1000002', orderRowVersion: 4, provider: 'shopify', totalEligible: 7 },
  { orderGlobalId: 'gor1000003', orderRowVersion: 5, provider: 'faire', totalEligible: 7 },
]
refreshResults.set('gor1000001', revision('gor1000001', 'current', false))
refreshResults.set(
  'gor1000002',
  revision('gor1000002', 'provider_fulfilled', true, 3),
)
refreshResults.set(
  'gor1000003',
  new CommerceOrderRevisionDispositionError(
    'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
    'secret provider payload must not escape',
    502,
  ),
)
const mixedResponse = await route.POST(request())
assert.equal(mixedResponse.status, 200)
assert.equal(mixedResponse.headers.get('cache-control'), 'private, no-store')
assert.equal(mixedResponse.headers.get('vary'), 'Cookie')
const mixedPayload = await mixedResponse.json()
assert.equal(mixedPayload.ok, true)
assert.equal(mixedPayload.result.status, 'partial')
assert.deepEqual(plain(mixedPayload.result.counts), {
  selected: 3,
  attempted: 3,
  refreshed: 2,
  changed: 1,
  current: 1,
  providerFulfilled: 1,
  providerCancelled: 0,
  reviewRequired: 0,
  failed: 1,
  providerReads: 5,
})
assert.equal(mixedPayload.result.totalEligible, 7)
assert.equal(mixedPayload.result.providerWrites, 0)
assert.equal(mixedPayload.result.canonicalOrderWrites, 0)
assert.equal(maximumActiveRefreshes, 1, 'provider reads must remain sequential')
assert.deepEqual(plain(calls.candidates), [{
  organizationId,
  limit: 10,
  excludeOrderGlobalIds: [],
}])
assert.deepEqual(plain(calls.prepare), [{
  organizationId,
  actorEmail,
  idempotencyKey: 'status-sync-request-1',
  batchLimit: 10,
  candidates,
  excludeOrderGlobalIds: [],
}])
assert.deepEqual(
  plain(calls.refresh.map((call) => ({
    organizationId: call.organizationId,
    actorEmail: call.actorEmail,
    orderGlobalId: call.orderGlobalId,
    expectedRowVersion: call.expectedRowVersion,
    idempotencyKey: call.idempotencyKey,
  }))),
  [
    {
      organizationId,
      actorEmail,
      orderGlobalId: 'gor1000001',
      expectedRowVersion: 3,
      idempotencyKey: 'status-sync-request-1:gor1000001:3',
    },
    {
      organizationId,
      actorEmail,
      orderGlobalId: 'gor1000002',
      expectedRowVersion: 4,
      idempotencyKey: 'status-sync-request-1:gor1000002:4',
    },
    {
      organizationId,
      actorEmail,
      orderGlobalId: 'gor1000003',
      expectedRowVersion: 5,
      idempotencyKey: 'status-sync-request-1:gor1000003:5',
    },
  ],
)
assert.equal(
  mixedPayload.result.failedByCode.FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED,
  1,
)
assert.ok(!JSON.stringify(mixedPayload).includes('secret provider payload'))
assert.deepEqual(plain(calls.complete), [{
  organizationId,
  receiptId: batchReceiptId,
  attemptToken: batchAttemptToken,
  result: mixedPayload.result,
}])

calls.refresh.length = 0
calls.complete.length = 0
batchReplay = mixedPayload.result
candidates = [{
  orderGlobalId: 'gor1000004',
  orderRowVersion: 1,
  provider: 'shopify',
  totalEligible: 1,
}]
const replayedResponse = await route.POST(request())
assert.equal(replayedResponse.status, 200)
assert.deepEqual(
  plain((await replayedResponse.json()).result),
  plain(mixedPayload.result),
)
assert.equal(calls.refresh.length, 0, 'a retained batch must not select new provider reads')
assert.equal(calls.complete.length, 0, 'a retained batch result must not be rewritten')

reset()
actor = { ...actor, organizationId: otherOrganizationId }
await route.POST(request())
assert.equal(calls.candidates[0].organizationId, otherOrganizationId)

reset()
await route.POST(request({
  body: JSON.stringify({ excludeOrderGlobalIds: ['gor1000001'] }),
}))
assert.deepEqual(plain(calls.candidates[0]), {
  organizationId,
  limit: 10,
  excludeOrderGlobalIds: ['gor1000001'],
})
assert.deepEqual(plain(calls.prepare[0].excludeOrderGlobalIds), ['gor1000001'])

reset()
actor = { ...actor, capabilities: { canManage: false } }
const forbidden = await route.POST(request())
assert.equal(forbidden.status, 403)
assert.equal((await forbidden.json()).code, 'OPERATIONS_MANAGE_REQUIRED')
assert.equal(calls.candidates.length, 0)

reset()
const invalidBody = await route.POST(request({
  body: JSON.stringify({ organizationId: otherOrganizationId }),
}))
assert.equal(invalidBody.status, 400)
assert.equal(
  (await invalidBody.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
)
assert.equal(calls.candidates.length, 0)

reset()
const duplicateExclusions = await route.POST(request({
  body: JSON.stringify({
    excludeOrderGlobalIds: ['gor1000001', 'gor1000001'],
  }),
}))
assert.equal(duplicateExclusions.status, 400)
assert.equal(
  (await duplicateExclusions.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
)
assert.equal(calls.candidates.length, 0)

reset()
postgresEnabled = false
const unavailable = await route.POST(request())
assert.equal(unavailable.status, 503)
assert.equal(
  (await unavailable.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_POSTGRES_REQUIRED',
)

reset()
const missingKey = await route.POST(request({ headers: {} }))
assert.equal(missingKey.status, 400)
assert.equal(
  (await missingKey.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_IDEMPOTENCY_KEY_INVALID',
)

reset()
const invalidQuery = await route.POST(request({
  url: 'https://clawpilot.example/api/operations/order-status-sync?organizationId=attacker',
}))
assert.equal(invalidQuery.status, 400)
assert.equal(
  (await invalidQuery.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_QUERY_INVALID',
)
assert.equal(calls.candidates.length, 0)

const retainedReplayCapture = {
  observationGlobalId: 'gcor1000011',
  readGlobalId: 'gcrr1000011',
  sourceHash: 'c'.repeat(64),
  changed: true,
  materialState: 'provider_fulfilled',
  managerDispositionRequired: true,
  providerReads: 2,
  providerWrites: 0,
}
const laterRevision = {
  eligible: true,
  provider: 'shopify',
  orderGlobalId: 'gor1000011',
  orderRowVersion: 3,
  orderStatus: 'imported',
  state: {
    observationGlobalId: 'gcor1000012',
    readGlobalId: 'gcrr1000012',
    sourceHash: 'd'.repeat(64),
    revisionHash: 'e'.repeat(64),
    materialState: 'provider_cancelled',
    capturedAt: '2026-08-31T17:00:00.000Z',
    fresh: true,
    changed: true,
    applyEligible: false,
    applyBlockedCode: 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE',
    cancellationEligible: true,
    providerReads: 4,
    providerWrites: 0,
    applicationGlobalId: null,
    exceptionGlobalId: null,
  },
}
const replayCalls = {
  prepare: [],
  readCurrent: [],
  shopifyInspect: 0,
  faireInspect: 0,
  providerFence: 0,
  capture: 0,
  failure: 0,
}
class ShopifyOrderRevisionError extends Error {}
class FaireOrderRevisionError extends Error {}
class CommerceStoreSyncProviderReadFenceError extends Error {}
const command = loadTypeScriptModule(commandPath, {
  '@/lib/integrations/faireOrderRevision': {
    FaireOrderRevisionError,
    async inspectFaireCanonicalOrderRevision() {
      replayCalls.faireInspect += 1
      throw new Error('a replay must not read Faire')
    },
  },
  '@/lib/integrations/shopifyOrderRevision': {
    ShopifyOrderRevisionError,
    async inspectShopifyCanonicalOrderRevision() {
      replayCalls.shopifyInspect += 1
      throw new Error('a replay must not read Shopify')
    },
  },
  '@/lib/persistence/commerceOrderRevisions': {
    CommerceOrderRevisionDispositionError,
    async prepareManagerCommerceOrderRevisionRefreshInPostgres(input) {
      replayCalls.prepare.push(input)
      return {
        replayed: true,
        replayedCapture: retainedReplayCapture,
        readGlobalId: retainedReplayCapture.readGlobalId,
        claim: null,
        commandReceiptId: '55555555-5555-4555-8555-555555555555',
      }
    },
    async readManagerCommerceOrderRevisionStateFromPostgres(input) {
      replayCalls.readCurrent.push(input)
      return laterRevision
    },
    async captureCommerceOrderRevisionObservationInPostgres() {
      replayCalls.capture += 1
      throw new Error('a replay must not capture provider evidence')
    },
    async failManagerCommerceOrderRevisionRefreshInPostgres() {
      replayCalls.failure += 1
      throw new Error('a replay must not enter failure handling')
    },
  },
  '@/lib/persistence/commerceStoreSync': {
    CommerceStoreSyncProviderReadFenceError,
    async withCommerceStoreSyncProviderReadFenceInPostgres() {
      replayCalls.providerFence += 1
      throw new Error('a replay must not acquire a provider-read fence')
    },
  },
})
const replayInput = {
  organizationId,
  actorEmail,
  orderGlobalId: 'gor1000011',
  expectedRowVersion: 3,
  idempotencyKey: 'status-sync-child-replay-1',
}
const exactReplay = await command.refreshCommerceOrderRevisionFromProvider(replayInput)
assert.deepEqual(plain(exactReplay), {
  replayed: true,
  capture: retainedReplayCapture,
  revision: laterRevision,
})
assert.deepEqual(plain(replayCalls.prepare), [replayInput])
assert.deepEqual(plain(replayCalls.readCurrent), [{
  organizationId,
  orderGlobalId: 'gor1000011',
}])
assert.deepEqual({
  shopifyInspect: replayCalls.shopifyInspect,
  faireInspect: replayCalls.faireInspect,
  providerFence: replayCalls.providerFence,
  capture: replayCalls.capture,
  failure: replayCalls.failure,
}, {
  shopifyInspect: 0,
  faireInspect: 0,
  providerFence: 0,
  capture: 0,
  failure: 0,
})

const routeSource = readFileSync(resolve(root, routePath), 'utf8')
const persistenceSource = readFileSync(resolve(root, persistencePath), 'utf8')
const operationsSource = readFileSync(resolve(root, operationsPath), 'utf8')
const uiSource = readFileSync(resolve(root, uiPath), 'utf8')
assert.doesNotMatch(routeSource, /process(?:Shopify|Faire)OrderRevisions/)
assert.match(routeSource, /refreshCommerceOrderRevisionFromProvider/)
assert.match(routeSource, /prepareCommerceOrderStatusSyncBatchInPostgres/)
assert.match(routeSource, /completeCommerceOrderStatusSyncBatchInPostgres/)
assert.match(routeSource, /attemptToken: batch\.attemptToken/)
assert.match(routeSource, /providerWrites: 0/)
assert.match(routeSource, /canonicalOrderWrites: 0/)
assert.match(persistenceSource, /WHERE order_row\.organization_id = \$1::uuid/)
assert.match(persistenceSource, /order_row\.global_id = ANY\(\$3::text\[\]\)/)
assert.match(persistenceSource, /target\.claim_state <> 'processing'/)
assert.match(persistenceSource, /target\.locked_until <= now\(\)/)
assert.match(
  persistenceSource,
  /target\.claim_state NOT IN \('failed', 'dead_letter'\)/,
)
assert.match(persistenceSource, /target\.next_check_at <= now\(\)/)
assert.match(persistenceSource, /GREATEST\([\s\S]*target\.checked_at[\s\S]*target\.updated_at/)
assert.match(persistenceSource, /LIMIT \$2/)
assert.match(
  operationsSource,
  /#>> '\{order,canonicalStates,fulfillment\}' = 'fulfilled'/,
)
assert.match(operationsSource, /provider_read\.provider_write_count = 0/)
assert.match(
  operationsSource,
  /\$\{orderAlias\}\.status = 'imported'/,
  'unreconciled provider evidence must not close released warehouse work',
)
assert.match(operationsSource, /AND NOT \(\$\{externallyFulfilledOrderSql\('summary_order'\)\}\)/)
assert.match(operationsSource, /input\.status === 'fulfilled_externally'/)
assert.match(
  operationsSource,
  /where\.push\(`NOT \(\$\{externallyFulfilledOrderSql\('orders'\)\}\)`\)/,
  'canonical status filters must exclude externally fulfilled display overrides',
)
assert.match(uiSource, /fetch\('\/api\/operations\/order-status-sync'/)
assert.match(uiSource, /MAX_ORDER_STATUS_SYNC_ORDERS = 100/)
assert.match(uiSource, /excludeOrderGlobalIds: \[\.\.\.checkedOrderGlobalIds\]/)
assert.match(uiSource, /\{ value: 'fulfilled_externally', label: 'Fulfilled externally' \}/)
assert.match(uiSource, /ClawPilot shipped today/)
assert.match(
  uiSource,
  /pendingOrderStatusSyncReload\.current = true/,
  'the provider sync must queue a fresh workspace projection',
)
assert.match(
  uiSource,
  /void loadWorkspace\(selectedGlobalId, undefined, \{ preserveFeedback: true \}\)/,
  'the provider sync must reload the current query state after it finishes',
)
assert.match(uiSource, /!order\.externallyFulfilled/)
assert.match(uiSource, /No ClawPilot shipment or label was created\./)

console.log('Commerce order status sync contract checks passed')
