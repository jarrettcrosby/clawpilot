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
const scheduleRoutePath =
  'app_src/app/api/operations/order-reconciliation-schedule/route.ts'
const discoveryRoutePath = 'app_src/app/api/operations/order-discovery/route.ts'
const discoveryPersistencePath =
  'app_src/lib/persistence/commerceOrderDiscovery.ts'
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

class CommerceOrderSyncError extends Error {
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
const scheduleCalls = []
const historyScheduleCalls = []
let scheduleResult = {
  totalEligible: 111,
  scheduled: 110,
  alreadyScheduled: 1,
  providerWrites: 0,
}
let historyScheduleResult = {
  totalEligibleAccounts: 2,
  scheduledAccounts: 1,
  alreadyScheduledAccounts: 1,
  deferredAccounts: 0,
  newSessions: 1,
  resumedSessions: 0,
  newDeferredRefreshes: 0,
  alreadyDeferredRefreshes: 0,
  providerWrites: 0,
}

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
  '@/lib/persistence/commerceOrderSync': {
    CommerceOrderSyncError,
    async scheduleAllCommerceOrderHistoryRefreshesInPostgres(input) {
      historyScheduleCalls.push(input)
      return historyScheduleResult
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

const scheduleRoute = loadTypeScriptModule(scheduleRoutePath, {
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
  '@/lib/persistence/config': {
    isPostgresStorageEnabled() {
      return postgresEnabled
    },
  },
  '@/lib/persistence/commerceOrderSync': {
    CommerceOrderSyncError,
    async scheduleAllCommerceOrderHistoryRefreshesInPostgres(input) {
      historyScheduleCalls.push(input)
      return historyScheduleResult
    },
  },
  '@/lib/persistence/commerceOrderRevisions': {
    CommerceOrderRevisionDispositionError,
    async scheduleAllCommerceOrderRevisionRefreshesInPostgres(input) {
      scheduleCalls.push(input)
      return scheduleResult
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

function scheduleRequest(options = {}) {
  const headers = options.headers === undefined
    ? {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'schedule-refresh-request-1',
      }
    : options.headers
  const result = new Request(
    options.url
      || 'https://clawpilot.example/api/operations/order-reconciliation-schedule',
    {
      method: 'POST',
      headers,
      body: options.body === undefined ? JSON.stringify({}) : options.body,
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
await route.POST(request({
  body: JSON.stringify({
    excludeOrderGlobalIds: ['gor1000001'],
    orderGlobalIds: ['gor1000002', 'gor1000003'],
  }),
}))
assert.deepEqual(plain(calls.candidates[0]), {
  organizationId,
  limit: 10,
  excludeOrderGlobalIds: ['gor1000001'],
  orderGlobalIds: ['gor1000002', 'gor1000003'],
})
assert.deepEqual(
  plain(calls.prepare[0].orderGlobalIds),
  ['gor1000002', 'gor1000003'],
)

reset()
const explicitEmptyTargets = await route.POST(request({
  body: JSON.stringify({ orderGlobalIds: [] }),
}))
assert.equal(explicitEmptyTargets.status, 200)
assert.deepEqual(plain(calls.candidates[0]), {
  organizationId,
  limit: 10,
  excludeOrderGlobalIds: [],
  orderGlobalIds: [],
})
assert.deepEqual(plain(calls.prepare[0].orderGlobalIds), [])

const maximumTargetIds = Array.from(
  { length: 101 },
  (_, index) => `gor${String(2_000_000 + index).padStart(7, '0')}`,
)
reset()
const maximumTargets = await route.POST(request({
  body: JSON.stringify({ orderGlobalIds: maximumTargetIds.slice(0, 100) }),
}))
assert.equal(maximumTargets.status, 200)
assert.deepEqual(
  plain(calls.candidates[0].orderGlobalIds),
  maximumTargetIds.slice(0, 100),
)

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
const duplicateTargets = await route.POST(request({
  body: JSON.stringify({
    orderGlobalIds: ['gor1000001', 'gor1000001'],
  }),
}))
assert.equal(duplicateTargets.status, 400)
assert.equal(
  (await duplicateTargets.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
)
assert.equal(calls.candidates.length, 0)

reset()
const invalidTarget = await route.POST(request({
  body: JSON.stringify({ orderGlobalIds: ['gcoc1000001'] }),
}))
assert.equal(invalidTarget.status, 400)
assert.equal(
  (await invalidTarget.json()).code,
  'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
)
assert.equal(calls.candidates.length, 0)

reset()
const tooManyTargets = await route.POST(request({
  body: JSON.stringify({ orderGlobalIds: maximumTargetIds }),
}))
assert.equal(tooManyTargets.status, 400)
assert.equal(
  (await tooManyTargets.json()).code,
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

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
const scheduled = await scheduleRoute.POST(scheduleRequest())
assert.equal(scheduled.status, 200)
assert.equal(scheduled.headers.get('cache-control'), 'private, no-store')
assert.deepEqual(plain(await scheduled.json()), {
  ok: true,
  result: {
    ...scheduleResult,
    providerHistory: historyScheduleResult,
  },
})
assert.deepEqual(plain(scheduleCalls), [{
  organizationId,
  actorEmail,
  idempotencyKey: 'schedule-refresh-request-1',
  excludeOrderGlobalIds: [],
}])
assert.deepEqual(plain(historyScheduleCalls), [{
  organizationId,
  actorEmail,
  idempotencyKey: 'schedule-refresh-request-1',
}])

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
const scheduleExclusions = maximumTargetIds.slice(0, 100)
const scheduledWithExclusions = await scheduleRoute.POST(scheduleRequest({
  body: JSON.stringify({ excludeOrderGlobalIds: scheduleExclusions }),
}))
assert.equal(scheduledWithExclusions.status, 200)
assert.deepEqual(plain(scheduleCalls), [{
  organizationId,
  actorEmail,
  idempotencyKey: 'schedule-refresh-request-1',
  excludeOrderGlobalIds: scheduleExclusions,
}])
assert.deepEqual(plain(historyScheduleCalls), [{
  organizationId,
  actorEmail,
  idempotencyKey: 'schedule-refresh-request-1',
}], 'provider-history scheduling must remain independent from exclusions')

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
actor = { ...actor, capabilities: { canManage: false } }
const scheduleForbidden = await scheduleRoute.POST(scheduleRequest())
assert.equal(scheduleForbidden.status, 403)
assert.equal(
  (await scheduleForbidden.json()).code,
  'OPERATIONS_MANAGE_REQUIRED',
)
assert.equal(scheduleCalls.length, 0)
assert.equal(historyScheduleCalls.length, 0)

for (const invalidExclusions of [
  'gor1000001',
  ['gor1000001', 'gor1000001'],
  ['gcoc1000001'],
  maximumTargetIds.slice(0, 101),
]) {
  reset()
  scheduleCalls.length = 0
  historyScheduleCalls.length = 0
  const invalidExclusionsResponse = await scheduleRoute.POST(scheduleRequest({
    body: JSON.stringify({ excludeOrderGlobalIds: invalidExclusions }),
  }))
  assert.equal(invalidExclusionsResponse.status, 400)
  assert.equal(
    (await invalidExclusionsResponse.json()).code,
    'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
  )
  assert.equal(scheduleCalls.length, 0)
  assert.equal(historyScheduleCalls.length, 0)
}

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
const scheduleOversizedBody = await scheduleRoute.POST(scheduleRequest({
  body: `{${' '.repeat(4096)}}`,
}))
assert.equal(scheduleOversizedBody.status, 400)
assert.equal(
  (await scheduleOversizedBody.json()).code,
  'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
)
assert.equal(scheduleCalls.length, 0)
assert.equal(historyScheduleCalls.length, 0)

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
const scheduleInvalidBody = await scheduleRoute.POST(scheduleRequest({
  body: JSON.stringify({ organizationId: otherOrganizationId }),
}))
assert.equal(scheduleInvalidBody.status, 400)
assert.equal(
  (await scheduleInvalidBody.json()).code,
  'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
)
assert.equal(scheduleCalls.length, 0)
assert.equal(historyScheduleCalls.length, 0)

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
const scheduleInvalidQuery = await scheduleRoute.POST(scheduleRequest({
  url: 'https://clawpilot.example/api/operations/order-reconciliation-schedule?organizationId=attacker',
}))
assert.equal(scheduleInvalidQuery.status, 400)
assert.equal(
  (await scheduleInvalidQuery.json()).code,
  'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_QUERY_INVALID',
)
assert.equal(scheduleCalls.length, 0)
assert.equal(historyScheduleCalls.length, 0)

reset()
scheduleCalls.length = 0
historyScheduleCalls.length = 0
postgresEnabled = false
const scheduleUnavailable = await scheduleRoute.POST(scheduleRequest())
assert.equal(scheduleUnavailable.status, 503)
assert.equal(
  (await scheduleUnavailable.json()).code,
  'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_POSTGRES_REQUIRED',
)
assert.equal(scheduleCalls.length, 0)
assert.equal(historyScheduleCalls.length, 0)

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

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.status = status
    this.code = code
  }
}

const discoveryCalls = {
  process: [],
  controls: [],
  reset: [],
  state: [],
  receiptPrepare: [],
  receiptComplete: [],
}
const discoveryReceipts = new Map()
let discoveryActor = {
  email: actorEmail,
  organizationId,
  capabilities: { canManage: true },
}
let discoveryControls = [{
  accountGlobalId: 'gia1000001',
  provider: 'shopify',
  environment: 'sandbox',
  displayName: 'Test Shopify',
  accountStatus: 'active',
  desiredState: 'running',
  effectiveState: 'running',
  effectiveReason: 'STORE_SYNC_EXPLICIT_RUNNING',
  effectiveReasonLabel: 'Running',
  explicitChoice: true,
  revision: 1,
  reason: 'test',
  updatedAt: '2026-08-31T20:00:00.000Z',
}]
let discoveryState = {
  status: 'failed',
  recordsSeen: 100,
  recordsHeld: 90,
  consecutiveFailures: 1,
  lastErrorCode: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  lastStartedAt: '2026-08-31T20:00:00.000Z',
  lastCompletedAt: null,
  resumable: false,
  resetRequired: true,
  providerWrites: 0,
  canonicalOrderWrites: 0,
  inventoryWrites: 0,
}
let discoveryExecution = {
  skipped: false,
  providerWrites: 0,
  canonicalOrderWrites: 2,
  inventoryWrites: 0,
  claimed: 1,
  staged: 3,
  preserved: 5,
  skippedCanonical: 2,
  providerRecordsSeen: 10,
  rejected: 4,
  failed: 0,
  pagesRead: 2,
  resumable: 0,
  failureCodes: {},
}
const discoveryRoute = loadTypeScriptModule(discoveryRoutePath, {
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
  '@/lib/commerceOrderReconciliationWorker': {
    async processCommerceOrderReconciliation(input) {
      discoveryCalls.process.push(input)
      discoveryState = {
        ...discoveryState,
        status: discoveryExecution.claimed === 0
          ? 'running'
          : discoveryExecution.failed > 0
            ? 'failed'
            : 'succeeded',
        recordsSeen: discoveryExecution.failed > 0 ? 0 : 10,
        recordsHeld: discoveryExecution.failed > 0 ? 0 : 3,
        lastErrorCode: discoveryExecution.failed > 0
          ? 'COMMERCE_PROVIDER_READ_FAILED'
          : null,
        lastStartedAt: '2026-08-31T20:01:00.000Z',
        lastCompletedAt: discoveryExecution.claimed === 0
          ? null
          : '2026-08-31T20:01:01.000Z',
        resetRequired: false,
      }
      return discoveryExecution
    },
  },
  '@/lib/operations/authorization': {
    activeOperationsOrganizationId(value) {
      return value.organizationId
    },
    operationsCapabilities(value) {
      return value.capabilities
    },
  },
  '@/lib/persistence/config': {
    isPostgresStorageEnabled() {
      return true
    },
  },
  '@/lib/persistence/commerceStoreSync': {
    async readCommerceStoreSyncControlsFromPostgres(value) {
      discoveryCalls.controls.push(value)
      return discoveryControls
    },
  },
  '@/lib/persistence/commerceOrderReconciliation': {
    async readCommerceOrderReconciliationStateInPostgres(input) {
      discoveryCalls.state.push(input)
      return discoveryState
    },
    async resetCommerceOrderReconciliationInPostgres(input) {
      discoveryCalls.reset.push(input)
      discoveryState = {
        ...discoveryState,
        status: 'idle',
        recordsSeen: 0,
        recordsHeld: 0,
        lastErrorCode: null,
        lastStartedAt: null,
        resetRequired: false,
      }
      return {
        accountGlobalId: input.accountGlobalId,
        status: 'idle',
        providerWrites: 0,
        canonicalOrderWrites: 0,
        inventoryWrites: 0,
      }
    },
  },
  '@/lib/persistence/commerceOrderDiscovery': {
    async prepareCommerceOrderDiscoveryCommandInPostgres(input) {
      discoveryCalls.receiptPrepare.push(input)
      const key = `${input.organizationId}:${input.idempotencyKey}`
      const prior = discoveryReceipts.get(key)
      if (prior) {
        if (prior.accountGlobalId !== input.accountGlobalId) {
          throw new CommerceIntegrationRequestError(
            'This idempotency key was already used for a different connected store refresh',
            409,
            'COMMERCE_ORDER_DISCOVERY_IDEMPOTENCY_CONFLICT',
          )
        }
        if (prior.result) return { kind: 'replay', result: prior.result }
        throw new CommerceIntegrationRequestError(
          'This connected-store refresh request is already being processed',
          409,
          'COMMERCE_ORDER_DISCOVERY_COMMAND_IN_PROGRESS',
        )
      }
      const receiptId = `receipt-${discoveryReceipts.size + 1}`
      const attemptToken = `00000000-0000-4000-8000-${String(
        discoveryReceipts.size + 1,
      ).padStart(12, '0')}`
      discoveryReceipts.set(key, {
        accountGlobalId: input.accountGlobalId,
        receiptId,
        attemptToken,
        result: null,
      })
      return { kind: 'execute', receiptId, attemptToken }
    },
    async completeCommerceOrderDiscoveryCommandInPostgres(input) {
      discoveryCalls.receiptComplete.push(input)
      const key = `${input.organizationId}:${input.idempotencyKey}`
      const receipt = discoveryReceipts.get(key)
      assert.equal(receipt?.receiptId, input.receiptId)
      assert.equal(receipt?.attemptToken, input.attemptToken)
      if (receipt.result) return receipt.result
      receipt.result = plain(input.result)
      return receipt.result
    },
  },
  '@/lib/requestUser': {
    async requireRequestUser() {
      return discoveryActor
    },
  },
})

function discoveryRequest(options = {}) {
  const request = new Request(
    options.url || 'https://clawpilot.example/api/operations/order-discovery',
    {
      method: 'POST',
      headers: options.headers || {
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey
          || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      body: options.body || JSON.stringify({
        accountGlobalId: 'gia1000001',
      }),
    },
  )
  Object.defineProperty(request, 'nextUrl', { value: new URL(request.url) })
  return request
}

const discoveredResponse = await discoveryRoute.POST(discoveryRequest())
assert.equal(discoveredResponse.status, 200)
const discoveredPayload = plain(await discoveredResponse.json())
assert.deepEqual(discoveredPayload, {
  ok: true,
  result: {
    accountGlobalId: 'gia1000001',
    displayName: 'Test Shopify',
    provider: 'shopify',
    counts: {
      providerRowsSeen: 10,
      eligibleOrdersSeen: 10,
      ordersStaged: 3,
      ordersPreserved: 5,
      ordersSkippedCanonical: 2,
      recordsRejected: 4,
      canonicalOrdersCreated: 2,
    },
    pagination: {
      batchNumber: 2,
      continuationRunGlobalId: null,
      hasNextBatch: false,
      sessionComplete: true,
    },
    refresh: {
      claimed: 1,
      failed: 0,
      failureCodes: {},
      reset: true,
      status: 'succeeded',
      resumable: false,
    },
    providerWrites: 0,
  },
})
assert.deepEqual(discoveryCalls.controls, [organizationId])
assert.deepEqual(plain(discoveryCalls.process), [{
  limit: 1,
  organizationId,
  accountGlobalIds: ['gia1000001'],
  force: true,
  processRevisionWorkers: false,
}])
assert.equal(discoveryCalls.reset.length, 1)
assert.deepEqual({
  organizationId: discoveryCalls.reset[0].organizationId,
  accountGlobalId: discoveryCalls.reset[0].accountGlobalId,
  actorEmail: discoveryCalls.reset[0].actorEmail,
  expectedLastErrorCode: discoveryCalls.reset[0].expectedLastErrorCode,
  expectedLastStartedAt: discoveryCalls.reset[0].expectedLastStartedAt,
  confirmReset: discoveryCalls.reset[0].confirmReset,
}, {
  organizationId,
  accountGlobalId: 'gia1000001',
  actorEmail,
  expectedLastErrorCode: 'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  expectedLastStartedAt: '2026-08-31T20:00:00.000Z',
  confirmReset: true,
})
assert.match(
  discoveryCalls.reset[0].idempotencyKey,
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
)
assert.notEqual(
  discoveryCalls.reset[0].idempotencyKey,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
)
const discoveryReplay = await discoveryRoute.POST(discoveryRequest())
assert.equal(discoveryReplay.status, 200)
assert.deepEqual(
  plain(await discoveryReplay.json()),
  discoveredPayload,
  'a lost-response retry must replay the exact completed result',
)
assert.equal(discoveryCalls.process.length, 1)
assert.equal(discoveryCalls.receiptComplete.length, 1)

discoveryExecution = {
  ...discoveryExecution,
  claimed: 0,
  staged: 0,
  rejected: 0,
  pagesRead: 0,
}
const runningDiscovery = await discoveryRoute.POST(discoveryRequest({
  idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}))
assert.equal(runningDiscovery.status, 202)
const runningDiscoveryPayload = await runningDiscovery.json()
assert.equal(runningDiscoveryPayload.result.refresh.status, 'running')
assert.equal(runningDiscoveryPayload.result.pagination.hasNextBatch, true)
assert.equal(runningDiscoveryPayload.result.pagination.sessionComplete, false)

discoveryExecution = {
  ...discoveryExecution,
  claimed: 1,
  failed: 1,
  failureCodes: { COMMERCE_PROVIDER_READ_FAILED: 1 },
}
const failedDiscovery = await discoveryRoute.POST(discoveryRequest({
  idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}))
assert.equal(failedDiscovery.status, 502)
assert.equal(
  (await failedDiscovery.json()).code,
  'COMMERCE_ORDER_DISCOVERY_PROVIDER_READ_FAILED',
)

discoveryExecution = {
  ...discoveryExecution,
  claimed: 1,
  failed: 0,
  failureCodes: {},
}

discoveryControls = [{ ...discoveryControls[0], effectiveState: 'paused' }]
const pausedResponse = await discoveryRoute.POST(discoveryRequest({
  idempotencyKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
}))
assert.equal(pausedResponse.status, 409)
assert.equal(
  (await pausedResponse.json()).code,
  'COMMERCE_ORDER_DISCOVERY_ACCOUNT_PAUSED',
)
assert.equal(discoveryCalls.process.length, 3)

discoveryControls = [{ ...discoveryControls[0], effectiveState: 'running' }]
discoveryActor = { ...discoveryActor, organizationId: otherOrganizationId }
const otherTenantSameKey = await discoveryRoute.POST(discoveryRequest())
assert.equal(otherTenantSameKey.status, 200)
assert.equal(
  (await otherTenantSameKey.json()).result.accountGlobalId,
  'gia1000001',
)
discoveryActor = { ...discoveryActor, organizationId }
discoveryControls = [
  discoveryControls[0],
  {
    ...discoveryControls[0],
    accountGlobalId: 'gia1000002',
    displayName: 'Other Shopify',
  },
]
const mismatchedAccountReplay = await discoveryRoute.POST(discoveryRequest({
  body: JSON.stringify({ accountGlobalId: 'gia1000002' }),
}))
assert.equal(mismatchedAccountReplay.status, 409)
assert.equal(
  (await mismatchedAccountReplay.json()).code,
  'COMMERCE_ORDER_DISCOVERY_IDEMPOTENCY_CONFLICT',
)

discoveryActor = {
  ...discoveryActor,
  capabilities: { canManage: false },
}
const forbiddenDiscovery = await discoveryRoute.POST(discoveryRequest())
assert.equal(forbiddenDiscovery.status, 403)
assert.equal((await forbiddenDiscovery.json()).code, 'OPERATIONS_MANAGE_REQUIRED')

const durableDiscoveryReceipts = new Map()
const durableDiscoveryLocks = []
const durableDiscoveryClient = {
  async query(sql, values = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const lookupKey = `${values[0]}:${values[1]}:${values[2]}`
    if (
      normalized.startsWith('SELECT id::text, request_hash')
      && normalized.includes('FROM operations_command_receipts')
    ) {
      const receipt = durableDiscoveryReceipts.get(lookupKey)
      if (!receipt || (values[3] && receipt.id !== values[3])) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [receipt], rowCount: 1 }
    }
    if (normalized.startsWith('INSERT INTO operations_command_receipts')) {
      const receiptNumber = durableDiscoveryReceipts.size + 1
      const receipt = {
        id: receiptNumber === 1
          ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
          : `00000000-0000-4000-8000-${String(receiptNumber).padStart(12, '0')}`,
        request_hash: values[3],
        target_global_id: values[6],
        status: 'processing',
        correlation_id: values[5],
        result_payload: null,
        updated_at: new Date(),
      }
      durableDiscoveryReceipts.set(lookupKey, receipt)
      return {
        rows: [{ id: receipt.id, correlation_id: receipt.correlation_id }],
        rowCount: 1,
      }
    }
    if (
      normalized.startsWith('UPDATE operations_command_receipts')
      && normalized.includes("SET status = 'succeeded'")
    ) {
      const receipt = [...durableDiscoveryReceipts.values()]
        .find((candidate) => candidate.id === values[0])
      assert.ok(receipt)
      if (
        receipt.status !== 'processing'
        || receipt.correlation_id !== values[3]
      ) {
        return { rows: [], rowCount: 0 }
      }
      receipt.status = 'succeeded'
      receipt.target_global_id = values[1]
      receipt.result_payload = JSON.parse(values[2])
      receipt.updated_at = new Date()
      return { rows: [receipt], rowCount: 1 }
    }
    if (
      normalized.startsWith('UPDATE operations_command_receipts')
      && normalized.includes("SET status = 'processing'")
    ) {
      const receipt = [...durableDiscoveryReceipts.values()]
        .find((candidate) => candidate.id === values[0])
      assert.ok(receipt)
      receipt.status = 'processing'
      receipt.correlation_id = values[2]
      receipt.result_payload = null
      receipt.updated_at = new Date()
      return {
        rows: [{ id: receipt.id, correlation_id: receipt.correlation_id }],
        rowCount: 1,
      }
    }
    throw new Error(`Unexpected discovery receipt SQL: ${normalized}`)
  },
}
const discoveryReceiptPersistence = loadTypeScriptModule(
  discoveryPersistencePath,
  {
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError,
    },
    '@/lib/persistence/postgres': {
      async acquireTransactionAdvisoryLock(_client, key) {
        durableDiscoveryLocks.push(key)
      },
      async withTransaction(action) {
        return action(durableDiscoveryClient)
      },
    },
  },
)
const durableCommandInput = {
  organizationId,
  accountGlobalId: 'gia1000001',
  actorEmail,
  idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
}
const durablePrepared = await discoveryReceiptPersistence
  .prepareCommerceOrderDiscoveryCommandInPostgres(durableCommandInput)
assert.deepEqual(plain(durablePrepared), {
  kind: 'execute',
  receiptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  attemptToken: durablePrepared.attemptToken,
})
assert.match(
  durablePrepared.attemptToken,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
)
const durableHttpResult = {
  status: 202,
  body: {
    ok: true,
    result: {
      accountGlobalId: 'gia1000001',
      providerWrites: 0,
      pagination: { hasNextBatch: true, sessionComplete: false },
    },
  },
}
assert.deepEqual(
  plain(await discoveryReceiptPersistence
    .completeCommerceOrderDiscoveryCommandInPostgres({
      ...durableCommandInput,
      receiptId: durablePrepared.receiptId,
      attemptToken: durablePrepared.attemptToken,
      result: durableHttpResult,
    })),
  durableHttpResult,
)
assert.deepEqual(
  plain(await discoveryReceiptPersistence
    .completeCommerceOrderDiscoveryCommandInPostgres({
      ...durableCommandInput,
      receiptId: durablePrepared.receiptId,
      attemptToken: durablePrepared.attemptToken,
      result: durableHttpResult,
    })),
  durableHttpResult,
  'same-attempt completion retries must replay an already committed result',
)
assert.deepEqual(
  plain(await discoveryReceiptPersistence
    .prepareCommerceOrderDiscoveryCommandInPostgres(durableCommandInput)),
  { kind: 'replay', result: durableHttpResult },
  'the durable receipt must replay the exact response status and body',
)
let durableConflict = null
try {
  await discoveryReceiptPersistence
    .prepareCommerceOrderDiscoveryCommandInPostgres({
      ...durableCommandInput,
      accountGlobalId: 'gia1000002',
    })
} catch (error) {
  durableConflict = error
}
assert.equal(
  durableConflict?.code,
  'COMMERCE_ORDER_DISCOVERY_IDEMPOTENCY_CONFLICT',
)
const isolatedTenantPrepared = await discoveryReceiptPersistence
  .prepareCommerceOrderDiscoveryCommandInPostgres({
    ...durableCommandInput,
    organizationId: otherOrganizationId,
  })
assert.equal(isolatedTenantPrepared.kind, 'execute')

const takeoverCommandInput = {
  ...durableCommandInput,
  idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
}
const originalAttempt = await discoveryReceiptPersistence
  .prepareCommerceOrderDiscoveryCommandInPostgres(takeoverCommandInput)
assert.equal(originalAttempt.kind, 'execute')
const takeoverReceipt = [...durableDiscoveryReceipts.values()]
  .find((receipt) => receipt.id === originalAttempt.receiptId)
assert.ok(takeoverReceipt)
takeoverReceipt.updated_at = new Date(Date.now() - 7 * 60_000)
const retryAttempt = await discoveryReceiptPersistence
  .prepareCommerceOrderDiscoveryCommandInPostgres(takeoverCommandInput)
assert.equal(retryAttempt.kind, 'execute')
assert.equal(retryAttempt.receiptId, originalAttempt.receiptId)
assert.notEqual(retryAttempt.attemptToken, originalAttempt.attemptToken)

let supersededAttemptError = null
try {
  await discoveryReceiptPersistence
    .completeCommerceOrderDiscoveryCommandInPostgres({
      ...takeoverCommandInput,
      receiptId: originalAttempt.receiptId,
      attemptToken: originalAttempt.attemptToken,
      result: {
        status: 200,
        body: { ok: true, result: { source: 'stale-original' } },
      },
    })
} catch (error) {
  supersededAttemptError = error
}
assert.equal(
  supersededAttemptError?.code,
  'COMMERCE_ORDER_DISCOVERY_ATTEMPT_SUPERSEDED',
)
assert.equal(takeoverReceipt.status, 'processing')
assert.equal(takeoverReceipt.result_payload, null)

const takeoverHttpResult = {
  status: 200,
  body: { ok: true, result: { source: 'retry-takeover' } },
}
assert.deepEqual(
  plain(await discoveryReceiptPersistence
    .completeCommerceOrderDiscoveryCommandInPostgres({
      ...takeoverCommandInput,
      receiptId: retryAttempt.receiptId,
      attemptToken: retryAttempt.attemptToken,
      result: takeoverHttpResult,
    })),
  takeoverHttpResult,
)
assert.deepEqual(
  plain(await discoveryReceiptPersistence
    .prepareCommerceOrderDiscoveryCommandInPostgres(takeoverCommandInput)),
  { kind: 'replay', result: takeoverHttpResult },
  'a stale original attempt must not overwrite the retry takeover result',
)
assert.ok(durableDiscoveryLocks.every((key) => (
  key.includes('commerce-order-discovery:')
)))

const routeSource = readFileSync(resolve(root, routePath), 'utf8')
const scheduleRouteSource = readFileSync(
  resolve(root, scheduleRoutePath),
  'utf8',
)
const discoveryRouteSource = readFileSync(resolve(root, discoveryRoutePath), 'utf8')
const discoveryPersistenceSource = readFileSync(
  resolve(root, discoveryPersistencePath),
  'utf8',
)
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
assert.match(
  scheduleRouteSource,
  /scheduleAllCommerceOrderRevisionRefreshesInPostgres/,
)
assert.match(
  scheduleRouteSource,
  /scheduleAllCommerceOrderHistoryRefreshesInPostgres/,
)
assert.match(scheduleRouteSource, /const MAX_REQUEST_BYTES = 4096/)
assert.match(scheduleRouteSource, /const MAX_EXCLUDED_ORDERS = 100/)
assert.match(
  scheduleRouteSource,
  /const GLOBAL_ORDER_ID = \/\^gor/,
)
assert.match(
  scheduleRouteSource,
  /keys\.some\(\(key\) => key !== 'excludeOrderGlobalIds'\)/,
)
assert.match(scheduleRouteSource, /operationsCapabilities\(actor\)\.canManage/)
assert.match(discoveryRouteSource, /processCommerceOrderReconciliation/)
assert.match(
  discoveryRouteSource,
  /prepareCommerceOrderDiscoveryCommandInPostgres/,
)
assert.match(
  discoveryRouteSource,
  /completeCommerceOrderDiscoveryCommandInPostgres/,
)
assert.match(discoveryRouteSource, /processRevisionWorkers: false/)
assert.match(discoveryRouteSource, /providerRecordsSeen/)
assert.match(discoveryRouteSource, /ordersPreserved/)
assert.match(discoveryRouteSource, /ordersSkippedCanonical/)
assert.match(discoveryRouteSource, /control\.effectiveState !== 'running'/)
assert.match(discoveryRouteSource, /providerWrites: 0/)
assert.match(discoveryPersistenceSource, /operations_command_receipts/)
assert.match(
  discoveryPersistenceSource,
  /WHERE organization_id = \$1::uuid[\s\S]*command_type = \$2[\s\S]*idempotency_key = \$3/,
)
assert.match(discoveryPersistenceSource, /target_global_id !== input\.accountGlobalId/)
assert.match(discoveryPersistenceSource, /receipt\.request_hash !== expectedRequestHash/)
assert.match(discoveryPersistenceSource, /status = 'succeeded'/)
assert.match(discoveryPersistenceSource, /result_payload = \$3::jsonb/)
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
assert.match(operationsSource, /\$3::text = 'fulfilled_externally'/)
assert.match(
  operationsSource,
  /\$3::text NOT IN \('fulfilled_externally', 'closed_externally'\)[\s\S]*AND NOT \(\$\{externallyFulfilledOrderSql\('orders'\)\}\)/,
  'canonical status filters must exclude externally fulfilled display overrides',
)
assert.match(uiSource, /fetch\('\/api\/operations\/order-status-sync'/)
assert.match(
  uiSource,
  /fetch\(\s*'\/api\/operations\/order-reconciliation-schedule'/,
)
assert.match(uiSource, /fetch\('\/api\/operations\/order-discovery'/)
assert.match(uiSource, /Refresh connected-store orders/)
assert.doesNotMatch(uiSource, /MAX_ORDER_STATUS_SYNC_ORDERS/)
assert.match(uiSource, /MAX_ORDER_DISCOVERY_INVOCATIONS_PER_ACCOUNT = 1/)
assert.match(
  uiSource,
  /invocation < MAX_ORDER_DISCOVERY_INVOCATIONS_PER_ACCOUNT/,
)
assert.match(uiSource, /if \(!result\.pagination\.hasNextBatch\)/)
assert.match(uiSource, /accountComplete = true/)
assert.match(routeSource, /MAX_EXCLUDED_ORDERS = 500/)
assert.match(routeSource, /MAX_TARGETED_ORDERS = 100/)
assert.match(persistenceSource, /excludeOrderGlobalIds\.length > 500/)
assert.match(persistenceSource, /orderGlobalIds\.length > 100/)
assert.match(
  persistenceSource,
  /\$4::text\[\] IS NULL OR order_row\.global_id = ANY\(\$4::text\[\]\)/,
)
assert.match(uiSource, /excludeOrderGlobalIds: \[\.\.\.checkedOrderGlobalIds\]/)
assert.match(uiSource, /const visibleCanonicalOrderGlobalIds =/)
assert.match(uiSource, /runOrderStatusSyncBatch\(\s*visibleCanonicalOrderGlobalIds/)
assert.match(uiSource, /excludeOrderGlobalIds: \[\.\.\.checkedOrderGlobalIds\],[\s\S]*orderGlobalIds,/)
assert.doesNotMatch(
  uiSource,
  /runOrderStatusSyncBatch\(\s*\)/,
  'manager refresh must not start an unscoped synchronous status scan',
)
assert.match(uiSource, /Background canonical status: queued/)
assert.match(uiSource, /active ClawPilot/)
assert.match(uiSource, /for an exact background status check/)
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
