#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const routePath = 'app_src/app/api/operations/order-revisions/route.ts'
const commandPath = 'app_src/lib/operations/commerceOrderRevisionCommands.ts'
const routeSource = readFileSync(resolve(root, routePath), 'utf8')

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
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
    Date,
    Error,
    Headers,
    JSON,
    Map,
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
    ...globals,
  }, { filename: path })
  return module.exports
}

class CommerceOrderRevisionDispositionError extends Error {
  constructor(
    code,
    message,
    status = 409,
    retryWithNewIdempotencyKey = false,
  ) {
    super(message)
    this.name = 'CommerceOrderRevisionDispositionError'
    this.code = code
    this.status = status
    this.retryWithNewIdempotencyKey = retryWithNewIdempotencyKey
  }
}

class ShopifyOrderRevisionError extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

class FaireOrderRevisionError extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

class CommerceStoreSyncProviderReadFenceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const otherOrganizationId = '22222222-2222-4222-8222-222222222222'
const orderGlobalId = 'gor1234567'
const observationGlobalId = 'gcor1234567'
const readGlobalId = 'gcrr1234567'
const expectedSourceHash = 'a'.repeat(64)
const expectedRevisionHash = 'b'.repeat(64)
const actorEmail = 'revision-manager@example.test'
const exactFields = {
  orderGlobalId,
  observationGlobalId,
  readGlobalId,
  expectedSourceHash,
  expectedRevisionHash,
  expectedRowVersion: 7,
  reason: 'Reviewed exact provider revision',
}

let actor = {
  email: actorEmail,
  organizationId,
  capabilities: {
    canView: true,
    canManage: true,
    canExecute: true,
    canActivate: false,
  },
}
let postgresEnabled = true
let readResult
let refreshResult
let applyResult
let cancellationResult
let refreshError = null
let applyError = null
const calls = {
  read: [],
  refresh: [],
  apply: [],
  cancel: [],
}

function resetResults() {
  readResult = {
    eligible: true,
    provider: 'shopify',
    orderGlobalId,
    orderRowVersion: 7,
    orderStatus: 'imported',
    state: {
      observationGlobalId,
      readGlobalId,
      sourceHash: expectedSourceHash,
      revisionHash: expectedRevisionHash,
      materialState: 'review_required',
      capturedAt: '2026-08-12T12:00:00.000Z',
      fresh: true,
      changed: true,
      applyEligible: true,
      applyBlockedCode: null,
      cancellationEligible: false,
      providerReads: 2,
      providerWrites: 0,
      applicationGlobalId: null,
      exceptionGlobalId: 'gex1234567',
    },
  }
  refreshResult = { replayed: false, revision: readResult }
  applyResult = {
    applicationGlobalId: 'gcoa1234567',
    orderGlobalId,
    observationGlobalId,
    readGlobalId,
    sourceHash: expectedSourceHash,
    revisionHash: expectedRevisionHash,
    previousRowVersion: 7,
    newRowVersion: 8,
    replayed: false,
    providerReads: 2,
    providerWrites: 0,
    changeSummary: {
      headerChanged: true,
      retainedLines: 0,
      changedLines: 0,
      addedLines: 1,
      removedLines: 0,
    },
  }
  cancellationResult = {
    dispositionGlobalId: 'gcod1234567',
    orderGlobalId,
    observationGlobalId,
    readGlobalId,
    sourceHash: expectedSourceHash,
    revisionHash: expectedRevisionHash,
    previousStatus: 'imported',
    status: 'cancelled',
    previousRowVersion: 7,
    newRowVersion: 8,
    replayed: false,
    providerReads: 2,
    providerWrites: 0,
  }
}
resetResults()

const route = loadTypeScriptModule(routePath, {
  mocks: {
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
        const valueOrganizationId = String(value.organizationId || '').trim()
        if (!valueOrganizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
        return valueOrganizationId
      },
    },
    '@/lib/operations/commerceOrderRevisionCommands': {
      async refreshCommerceOrderRevisionFromProvider(input) {
        calls.refresh.push(input)
        if (refreshError) throw refreshError
        return refreshResult
      },
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled() {
        return postgresEnabled
      },
    },
    '@/lib/persistence/commerceOrderRevisions': {
      CommerceOrderRevisionDispositionError,
      async readManagerCommerceOrderRevisionStateFromPostgres(input) {
        calls.read.push(input)
        return readResult
      },
      async applyCommerceOrderRevisionToClawPilotInPostgres(input) {
        calls.apply.push(input)
        if (applyError) throw applyError
        return applyResult
      },
      async cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(input) {
        calls.cancel.push(input)
        return cancellationResult
      },
    },
    '@/lib/requestUser': {
      async requireRequestUser() {
        return actor
      },
    },
  },
})

function clearCalls() {
  for (const list of Object.values(calls)) list.length = 0
  refreshError = null
  applyError = null
  resetResults()
}

function request(method, body, options = {}) {
  const url = options.url || 'https://clawpilot.example/api/operations/order-revisions'
  const headers = new Headers(options.headers || {})
  let serialized
  if (body !== undefined) {
    serialized = typeof body === 'string' ? body : JSON.stringify(body)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  }
  const result = new Request(url, {
    method,
    headers,
    ...(serialized === undefined ? {} : { body: serialized }),
  })
  Object.defineProperty(result, 'nextUrl', { value: new URL(result.url) })
  return result
}

async function payload(response) {
  return response.json()
}

async function expectCode(response, status, code) {
  assert.equal(response.status, status)
  const body = await payload(response)
  assert.equal(body.code, code)
  return body
}

function exactCommand(action) {
  return { action, ...exactFields }
}

const getResponse = await route.GET(request(
  'GET',
  undefined,
  { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
))
assert.equal(getResponse.status, 200)
assert.equal(getResponse.headers.get('cache-control'), 'private, no-store')
assert.equal(getResponse.headers.get('vary'), 'Cookie')
assert.deepEqual(plain(calls.read[0]), { organizationId, orderGlobalId })
const getPayload = await payload(getResponse)
assert.equal(getPayload.revision.state.providerWrites, 0)
assert.ok(!JSON.stringify(getPayload).includes('internal-provider-secret'))

clearCalls()
readResult = { ...readResult, internalSecret: 'internal-provider-secret' }
const projectedGetResponse = await route.GET(request(
  'GET',
  undefined,
  { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
))
assert.equal(projectedGetResponse.status, 200)
assert.ok(!JSON.stringify(await payload(projectedGetResponse)).includes('internal-provider-secret'))

clearCalls()
readResult = { eligible: true }
await expectCode(
  await route.GET(request(
    'GET',
    undefined,
    { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
  )),
  500,
  'COMMERCE_ORDER_REVISION_RESULT_INVALID',
)

clearCalls()
await expectCode(
  await route.GET(request(
    'GET',
    undefined,
    { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}&page=1` },
  )),
  400,
  'COMMERCE_ORDER_REVISION_QUERY_INVALID',
)
assert.equal(calls.read.length, 0)

actor = { ...actor, organizationId: otherOrganizationId }
const otherOrganizationResponse = await route.GET(request(
  'GET',
  undefined,
  { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
))
assert.equal(otherOrganizationResponse.status, 200)
assert.equal(calls.read[0].organizationId, otherOrganizationId)
actor = { ...actor, organizationId }

clearCalls()
actor = { ...actor, capabilities: { ...actor.capabilities, canManage: false } }
await expectCode(
  await route.GET(request(
    'GET',
    undefined,
    { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
  )),
  403,
  'OPERATIONS_MANAGE_REQUIRED',
)
assert.equal(calls.read.length, 0)
actor = {
  ...actor,
  capabilities: { ...actor.capabilities, canManage: true, canExecute: true },
}

clearCalls()
actor = { ...actor, organizationId: null }
await expectCode(
  await route.POST(request(
    'POST',
    '{not-json',
    { headers: { 'Content-Type': 'text/plain' } },
  )),
  409,
  'ACTIVE_ORGANIZATION_REQUIRED',
)
assert.deepEqual(
  { refresh: calls.refresh.length, apply: calls.apply.length, cancel: calls.cancel.length },
  { refresh: 0, apply: 0, cancel: 0 },
)
actor = { ...actor, organizationId }

clearCalls()
postgresEnabled = false
await expectCode(
  await route.GET(request(
    'GET',
    undefined,
    { url: `https://clawpilot.example/api/operations/order-revisions?orderGlobalId=${orderGlobalId}` },
  )),
  503,
  'COMMERCE_ORDER_REVISION_POSTGRES_REQUIRED',
)
postgresEnabled = true

clearCalls()
refreshResult = { ...refreshResult, internalSecret: 'internal-provider-secret' }
const refreshResponse = await route.POST(request(
  'POST',
  { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
  { headers: { 'Idempotency-Key': 'revision-refresh-1' } },
))
assert.equal(refreshResponse.status, 200)
assert.equal(refreshResponse.headers.get('cache-control'), 'private, no-store')
assert.equal(refreshResponse.headers.get('vary'), 'Cookie')
assert.deepEqual(plain(calls.refresh[0]), {
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  idempotencyKey: 'revision-refresh-1',
})
const refreshPayload = await payload(refreshResponse)
assert.equal(refreshPayload.result.revision.state.providerWrites, 0)
assert.equal(
  refreshPayload.result.revision.state.exceptionGlobalId,
  'gex1234567',
)
assert.ok(!JSON.stringify(refreshPayload).includes('internal-provider-secret'))

for (const code of [
  'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED',
  'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
]) {
  clearCalls()
  refreshError = new CommerceOrderRevisionDispositionError(
    code,
    'The exact provider order refresh failed',
    502,
    true,
  )
  const terminalFailurePayload = await expectCode(
    await route.POST(request(
      'POST',
      { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
      { headers: { 'Idempotency-Key': `revision-refresh-${code.toLowerCase()}` } },
    )),
    502,
    code,
  )
  assert.equal(
    terminalFailurePayload.retryWithNewIdempotencyKey,
    true,
    `${code} must tell the client to issue a new refresh key`,
  )
}

clearCalls()
refreshResult = {
  replayed: false,
  revision: { ...readResult, orderGlobalId: 'gor7654321' },
  internalSecret: 'internal-provider-secret',
}
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Idempotency-Key': 'revision-refresh-mismatch-1' } },
  )),
  500,
  'COMMERCE_ORDER_REVISION_RESULT_INVALID',
)

clearCalls()
refreshResult = {
  replayed: false,
  revision: {
    ...readResult,
    state: { ...readResult.state, providerWrites: 1 },
  },
}
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Idempotency-Key': 'revision-refresh-writes-1' } },
  )),
  409,
  'COMMERCE_ORDER_REVISION_PROVIDER_WRITE_BLOCKED',
)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7, readGlobalId },
    { headers: { 'Idempotency-Key': 'revision-refresh-2' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
)
assert.equal(calls.refresh.length, 0)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
  )),
  400,
  'COMMERCE_ORDER_REVISION_IDEMPOTENCY_KEY_INVALID',
)
assert.equal(calls.refresh.length, 0)

clearCalls()
actor = { ...actor, capabilities: { ...actor.capabilities, canExecute: false } }
postgresEnabled = false
await expectCode(
  await route.POST(request('POST', exactCommand('apply-to-clawpilot'))),
  403,
  'OPERATIONS_EXECUTE_REQUIRED',
)
assert.equal(calls.apply.length, 0)

postgresEnabled = true
actor = { ...actor, capabilities: { ...actor.capabilities, canExecute: true } }

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { ...exactCommand('apply-to-clawpilot'), reason: 'short' },
    { headers: { 'Idempotency-Key': 'revision-apply-short-reason-1' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_REASON_INVALID',
)
assert.equal(calls.apply.length, 0)

clearCalls()
applyResult = { ...applyResult, internalSecret: 'internal-provider-secret' }
const applyResponse = await route.POST(request(
  'POST',
  exactCommand('apply-to-clawpilot'),
  { headers: { 'Idempotency-Key': 'revision-apply-1' } },
))
assert.equal(applyResponse.status, 200)
assert.deepEqual(plain(calls.apply[0]), {
  organizationId,
  actorEmail,
  ...exactFields,
  idempotencyKey: 'revision-apply-1',
})
const applyPayload = await payload(applyResponse)
assert.equal(applyPayload.result.providerWrites, 0)
assert.ok(!JSON.stringify(applyPayload).includes('internal-provider-secret'))
assert.deepEqual(applyPayload.result.changeSummary, {
  headerChanged: true,
  retainedLines: 0,
  changedLines: 0,
  addedLines: 1,
  removedLines: 0,
})

clearCalls()
applyResult = {
  ...applyResult,
  readGlobalId: 'gcrr7654321',
  internalSecret: 'internal-provider-secret',
}
await expectCode(
  await route.POST(request(
    'POST',
    exactCommand('apply-to-clawpilot'),
    { headers: { 'Idempotency-Key': 'revision-apply-mismatch-1' } },
  )),
  500,
  'COMMERCE_ORDER_REVISION_RESULT_INVALID',
)

clearCalls()
applyResult = { providerWrites: 0 }
await expectCode(
  await route.POST(request(
    'POST',
    exactCommand('apply-to-clawpilot'),
    { headers: { 'Idempotency-Key': 'revision-apply-incomplete-1' } },
  )),
  500,
  'COMMERCE_ORDER_REVISION_RESULT_INVALID',
)

clearCalls()
cancellationResult = {
  ...cancellationResult,
  internalSecret: 'internal-provider-secret',
}
const cancelResponse = await route.POST(request(
  'POST',
  exactCommand('accept-provider-cancellation'),
  { headers: { 'Idempotency-Key': 'revision-cancel-1' } },
))
assert.equal(cancelResponse.status, 200)
assert.deepEqual(plain(calls.cancel[0]), {
  organizationId,
  actorEmail,
  ...exactFields,
  idempotencyKey: 'revision-cancel-1',
})
assert.equal(calls.cancel[0].readGlobalId, readGlobalId)
const cancelPayload = await payload(cancelResponse)
assert.equal(cancelPayload.result.providerWrites, 0)
assert.ok(!Object.hasOwn(cancelPayload.result, 'internalSecret'))

clearCalls()
cancellationResult = {
  ...cancellationResult,
  sourceHash: 'c'.repeat(64),
  internalSecret: 'internal-provider-secret',
}
await expectCode(
  await route.POST(request(
    'POST',
    exactCommand('accept-provider-cancellation'),
    { headers: { 'Idempotency-Key': 'revision-cancel-mismatch-1' } },
  )),
  500,
  'COMMERCE_ORDER_REVISION_RESULT_INVALID',
)

clearCalls()
const { readGlobalId: _omittedRead, ...missingReadFields } = exactFields
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'accept-provider-cancellation', ...missingReadFields },
    { headers: { 'Idempotency-Key': 'revision-cancel-2' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
)
assert.equal(calls.cancel.length, 0)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'apply-to-clawpilot', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Idempotency-Key': 'revision-apply-2' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
)
assert.equal(calls.apply.length, 0)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'delete-provider-order', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Idempotency-Key': 'revision-delete-1' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_ACTION_INVALID',
)
assert.deepEqual(
  { refresh: calls.refresh.length, apply: calls.apply.length, cancel: calls.cancel.length },
  { refresh: 0, apply: 0, cancel: 0 },
)

clearCalls()
applyResult = { ...applyResult, providerWrites: 1 }
await expectCode(
  await route.POST(request(
    'POST',
    exactCommand('apply-to-clawpilot'),
    { headers: { 'Idempotency-Key': 'revision-apply-writes-1' } },
  )),
  409,
  'COMMERCE_ORDER_REVISION_PROVIDER_WRITE_BLOCKED',
)

clearCalls()
applyError = new CommerceOrderRevisionDispositionError(
  'COMMERCE_ORDER_REVISION_APPLICATION_STALE',
  'Refresh the provider revision before applying it',
  409,
)
const dispositionResponse = await route.POST(request(
  'POST',
  exactCommand('apply-to-clawpilot'),
  { headers: { 'Idempotency-Key': 'revision-apply-stale-1' } },
))
const dispositionPayload = await expectCode(
  dispositionResponse,
  409,
  'COMMERCE_ORDER_REVISION_APPLICATION_STALE',
)
assert.equal(dispositionPayload.error, 'Refresh the provider revision before applying it')
assert.equal(
  Object.hasOwn(dispositionPayload, 'retryWithNewIdempotencyKey'),
  false,
  'nonterminal disposition errors must not release an idempotency key',
)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'revision-refresh-3' } },
  )),
  415,
  'COMMERCE_ORDER_REVISION_CONTENT_TYPE_INVALID',
)
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
    { headers: { 'Content-Type': 'application/jsonp', 'Idempotency-Key': 'revision-refresh-3b' } },
  )),
  415,
  'COMMERCE_ORDER_REVISION_CONTENT_TYPE_INVALID',
)
await expectCode(
  await route.POST(request(
    'POST',
    '{broken json',
    { headers: { 'Idempotency-Key': 'revision-refresh-4' } },
  )),
  400,
  'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
)

clearCalls()
await expectCode(
  await route.POST(request(
    'POST',
    { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
    {
      headers: {
        'Content-Length': String(64 * 1024 + 1),
        'Idempotency-Key': 'revision-refresh-5',
      },
    },
  )),
  413,
  'COMMERCE_ORDER_REVISION_REQUEST_TOO_LARGE',
)
assert.equal(calls.refresh.length, 0)

clearCalls()
let oversizedStreamCancelled = false
const oversizedStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array(64 * 1024))
    controller.enqueue(new Uint8Array([1]))
  },
  cancel() {
    oversizedStreamCancelled = true
  },
})
const oversizedStreamRequest = new Request(
  'https://clawpilot.example/api/operations/order-revisions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'revision-refresh-stream-1',
    },
    body: oversizedStream,
    duplex: 'half',
  },
)
Object.defineProperty(oversizedStreamRequest, 'nextUrl', {
  value: new URL(oversizedStreamRequest.url),
})
assert.equal(oversizedStreamRequest.headers.get('content-length'), null)
await expectCode(
  await route.POST(oversizedStreamRequest),
  413,
  'COMMERCE_ORDER_REVISION_REQUEST_TOO_LARGE',
)
assert.equal(oversizedStreamCancelled, true)
assert.equal(calls.refresh.length, 0)

clearCalls()
const originalConsoleError = console.error
const logged = []
console.error = (...values) => logged.push(values)
try {
  refreshError = new Error('provider secret must never appear in logs: top-secret-value')
  refreshError.name = 'top-secret-error-name'
  const internalErrorPayload = await expectCode(
    await route.POST(request(
      'POST',
      { action: 'refresh-from-provider', orderGlobalId, expectedRowVersion: 7 },
      { headers: { 'Idempotency-Key': 'revision-refresh-error-1' } },
    )),
    500,
    'COMMERCE_ORDER_REVISION_INTERNAL_ERROR',
  )
  assert.equal(
    Object.hasOwn(internalErrorPayload, 'retryWithNewIdempotencyKey'),
    false,
    'ambiguous internal failures must retain the current refresh key',
  )
} finally {
  console.error = originalConsoleError
}
assert.equal(logged.length, 1)
assert.ok(!JSON.stringify(logged).includes('top-secret-value'))
assert.ok(!JSON.stringify(logged).includes('top-secret-error-name'))

for (const fragment of [
  "'Cache-Control': 'private, no-store'",
  "Vary: 'Cookie'",
  'const MAX_REQUEST_BYTES = 64 * 1024',
  "action !== 'refresh-from-provider'",
  "action !== 'apply-to-clawpilot'",
  "action !== 'accept-provider-cancellation'",
  "'readGlobalId'",
  "if (action !== 'refresh-from-provider' && !capabilities.canExecute)",
  'const idempotencyKey = idempotencyKeyValue(req)',
  'function publicRevisionState',
  'function publicApplyResult',
  'function publicCancellationResult',
  'function zeroProviderWrites',
  "await reader.cancel('request_too_large')",
]) {
  assert.ok(routeSource.includes(fragment), `Order revision API contract is missing ${fragment}`)
}
assert.ok(
  routeSource.indexOf("if (action !== 'refresh-from-provider' && !capabilities.canExecute)")
    < routeSource.indexOf('const idempotencyKey = idempotencyKeyValue(req)'),
  'Apply and cancellation authorization must precede mutation-header validation',
)
assert.doesNotMatch(
  routeSource,
  /tenderShipment|createShipment|purchaseLabel|schedulePickup|captureCharge|writeProvider|updateShopify|updateFaire/u,
  'The exact revision API dispatch surface must not expose provider-write actions',
)

let commandProvider = 'shopify'
let commandReceiptFailed = true
const commandFailureCalls = []
const command = loadTypeScriptModule(commandPath, {
  mocks: {
    '@/lib/integrations/faireOrderRevision': {
      FaireOrderRevisionError,
      async inspectFaireCanonicalOrderRevision() {
        throw new FaireOrderRevisionError(
          'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
          'Faire exact order revision read failed',
          true,
        )
      },
    },
    '@/lib/integrations/shopifyOrderRevision': {
      ShopifyOrderRevisionError,
      async inspectShopifyCanonicalOrderRevision() {
        throw new ShopifyOrderRevisionError(
          'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED',
          'Shopify exact order revision read failed',
          true,
        )
      },
    },
    '@/lib/persistence/commerceOrderRevisions': {
      CommerceOrderRevisionDispositionError,
      async prepareManagerCommerceOrderRevisionRefreshInPostgres() {
        return {
          replayed: false,
          commandReceiptId: '33333333-3333-4333-8333-333333333333',
          claim: {
            organizationId,
            integrationAccountId: '44444444-4444-4444-8444-444444444444',
            targetId: '55555555-5555-4555-8555-555555555555',
            leaseToken: '66666666-6666-4666-8666-666666666666',
            provider: commandProvider,
          },
        }
      },
      async failManagerCommerceOrderRevisionRefreshInPostgres(input) {
        commandFailureCalls.push(input)
        return commandReceiptFailed
      },
      async captureCommerceOrderRevisionObservationInPostgres() {
        throw new Error('capture must not run after a provider failure')
      },
      async readManagerCommerceOrderRevisionStateFromPostgres() {
        throw new Error('failed refresh must not return revision state')
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      CommerceStoreSyncProviderReadFenceError,
      async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
        return input.read({ lease: 'provider-read-test-lease' })
      },
    },
  },
})

for (const [provider, code] of [
  ['shopify', 'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED'],
  ['faire', 'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED'],
]) {
  commandProvider = provider
  commandReceiptFailed = true
  commandFailureCalls.length = 0
  await assert.rejects(
    () => command.refreshCommerceOrderRevisionFromProvider({
      organizationId,
      actorEmail,
      orderGlobalId,
      expectedRowVersion: 7,
      idempotencyKey: `command-${provider}-refresh-failure`,
    }),
    (error) => {
      assert.equal(error.code, code)
      assert.equal(error.status, 502)
      assert.equal(error.retryWithNewIdempotencyKey, true)
      return true
    },
  )
  assert.equal(commandFailureCalls.length, 1)
  assert.equal(commandFailureCalls[0].errorCode, code)
}

commandProvider = 'shopify'
commandReceiptFailed = false
await assert.rejects(
  () => command.refreshCommerceOrderRevisionFromProvider({
    organizationId,
    actorEmail,
    orderGlobalId,
    expectedRowVersion: 7,
    idempotencyKey: 'command-shopify-ambiguous-receipt',
  }),
  (error) => {
    assert.equal(error.code, 'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED')
    assert.equal(error.retryWithNewIdempotencyKey, false)
    return true
  },
)

console.log('Commerce order revision isolated API checks passed.')
