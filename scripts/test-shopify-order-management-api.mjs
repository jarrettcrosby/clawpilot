#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const routePath =
  'app_src/app/api/operations/shopify-order-management/route.ts'

class MockTypedError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

function managementFixture(globalId = 'gor1234567') {
  return {
    runtimeAvailable: true,
    blockerCode: null,
    accountLabel: 'AG Alchemy',
    shopDomain: 'ag-alchemy.myshopify.com',
    order: {
      globalId,
      externalOrderId: 'gid://shopify/Order/6909860774088',
      name: '#6600',
      rowVersion: 7,
      test: true,
      closed: false,
      cancelledAt: null,
      financialStatus: 'PENDING',
      fulfillmentStatus: 'UNFULFILLED',
      merchantEditable: true,
      email: 'buyer@example.com',
      phone: '+15555550100',
      poNumber: 'PO-6600',
      note: null,
      shippingAddress: {
        firstName: 'Pat',
        lastName: 'Buyer',
        company: 'Buyer Bakery',
        address1: '100 Test Avenue',
        address2: null,
        city: 'Raleigh',
        provinceCode: 'NC',
        countryCode: 'US',
        zip: '27601',
        phone: '+15555550100',
      },
      tags: [],
      lines: [{
        lineItemId: 'gid://shopify/LineItem/123',
        title: 'Test line',
        quantity: 2,
        unfulfilledQuantity: 2,
        fulfilledQuantity: 0,
      }],
      fulfillments: [{
        fulfillmentId: 'gid://shopify/Fulfillment/456',
        name: '#6600.1',
        status: 'SUCCESS',
        displayStatus: 'FULFILLED',
        updatedAt: '2026-08-14T03:19:00.000Z',
        deliveredAt: null,
        quantity: 2,
        tracking: [{
          company: 'UPS',
          number: '1ZTEST6600',
          url: 'https://www.ups.com/track?tracknum=1ZTEST6600',
        }],
      }],
    },
    eligibility: {
      addTag: { allowed: true, reason: null },
      ordinarySave: { allowed: true, reason: null },
      cancel: {
        allowed: true,
        reason: null,
        releasesAuthorization: true,
      },
      cancelAfterFulfillmentReversal: {
        allowed: false,
        reason: 'No completed fulfillment reversal is available',
        releasesAuthorization: false,
        predecessorAuthorizationGlobalId: null,
      },
      fulfillments: [{
        fulfillmentId: 'gid://shopify/Fulfillment/456',
        expectedUpdatedAt: '2026-08-14T03:19:00.000Z',
        allowed: true,
        reason: null,
      }],
      lineEdits: [{
        lineItemId: 'gid://shopify/LineItem/123',
        allowed: true,
        reason: null,
        minQuantity: 0,
        maxQuantity: 1,
      }],
    },
    payment: {
      totalReceived: { amount: '125.00', currencyCode: 'USD' },
      totalRefunded: { amount: '0.00', currencyCode: 'USD' },
      totalCapturable: { amount: '0.00', currencyCode: 'USD' },
      refundOptions: {
        none: {
          allowed: true,
          reason: null,
          releasesAuthorization: false,
        },
        original_payment_methods: {
          allowed: true,
          reason: null,
          releasesAuthorization: false,
        },
      },
    },
    openAttempt: null,
  }
}

function authorizationFixture() {
  return {
    authorizationGlobalId: 'gsom1234567',
    intentHash: 'a'.repeat(64),
    expiresAt: '2026-08-14T03:30:00.000Z',
    confirmationStatement:
      'AUTHORIZE SHOPIFY WRITE gsom1234567 ADD_TAG #6600',
    preview: {
      accountLabel: 'AG Alchemy',
      shopDomain: 'ag-alchemy.myshopify.com',
      orderName: '#6600',
      orderTest: true,
      orderUpdatedAt: '2026-08-14T03:20:00.000Z',
      action: 'add_tag',
      fulfillmentId: null,
      expectedFulfillmentUpdatedAt: null,
      predecessorAuthorizationGlobalId: null,
      lineItemId: null,
      previousQuantity: null,
      requestedQuantity: null,
    },
    replayed: false,
    providerReads: 2,
    providerWrites: 0,
  }
}

function resultFixture(state = 'succeeded') {
  return {
    authorizationGlobalId: 'gsom1234567',
    attemptGlobalId: 'gsoa1234567',
    state,
    providerReference: null,
    replayed: false,
    providerReads: 3,
    providerWrites: 1,
    management: managementFixture(),
  }
}

const calls = []
const routeErrors = []
let postgresEnabled = true
let actor = null
let session = null
let requestUserError = null
let sameOriginImpl = ({ headers, requestOrigin }) => (
  headers.get('origin') === requestOrigin
  && headers.get('sec-fetch-site') !== 'cross-site'
)
let readImpl = async (input) => {
  calls.push(['read', input])
  return managementFixture(input.orderGlobalId)
}
let saveImpl = async (input) => {
  calls.push(['save', input])
  return resultFixture('succeeded')
}
let prepareImpl = async (input) => {
  calls.push(['prepare', input])
  return authorizationFixture()
}
let executeImpl = async (input) => {
  calls.push(['execute', input])
  return resultFixture('succeeded')
}
let reconcileImpl = async (input) => {
  calls.push(['reconcile', input])
  return resultFixture('reconciled')
}

function loadRoute() {
  const source = readFileSync(resolve(root, routePath), 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: routePath,
    reportDiagnostics: true,
  })
  const diagnostics = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [], 'Shopify order management route must transpile')
  const module = { exports: {} }
  vm.runInNewContext(transpiled.outputText, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    console: {
      ...console,
      error(...args) {
        routeErrors.push(args)
      },
    },
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/integrations/integrationCredentialRuntimeHttp') {
        return { integrationCredentialRuntimeMaintenanceResponse: () => null }
      }
      if (specifier === 'next/server') {
        return {
          NextRequest: class NextRequest {},
          NextResponse: {
            json(payload, init = {}) {
              return Response.json(payload, init)
            },
          },
        }
      }
      if (specifier === '@/lib/operations/authorization') {
        return {
          activeOperationsOrganizationId(value) {
            if (!value.activeOrganizationId) {
              throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
            }
            return value.activeOrganizationId
          },
          operationsCapabilities(value) {
            return value.capabilities
          },
        }
      }
      if (
        specifier === '@/lib/operations/shopifyOrderManagementCommands'
      ) {
        return {
          executeShopifyOrderManagementCommand: (...args) => executeImpl(...args),
          prepareShopifyOrderManagementCommand: (...args) => prepareImpl(...args),
          readShopifyOrderManagementState: (...args) => readImpl(...args),
          reconcileShopifyOrderManagementCommand: (...args) => reconcileImpl(...args),
          saveShopifyOrderManagementCommand: (...args) => saveImpl(...args),
          ShopifyOrderManagementCommandError: MockTypedError,
        }
      }
      if (specifier === '@/lib/integrations/shopifyOrderManagement') {
        return { ShopifyOrderManagementError: MockTypedError }
      }
      if (specifier === '@/lib/persistence/config') {
        return { isPostgresStorageEnabled: () => postgresEnabled }
      }
      if (specifier === '@/lib/persistence/shopifyOrderManagement') {
        return { ShopifyOrderManagementPersistenceError: MockTypedError }
      }
      if (specifier === '@/lib/browserSameOrigin') {
        return {
          isBrowserSameOriginRequest: (...args) => sameOriginImpl(...args),
        }
      }
      if (specifier === '@/lib/publicUrl') {
        return { appPublicUrl: () => 'https://clawpilot.test' }
      }
      if (specifier === '@/lib/requestUser') {
        return {
          async requestSession() {
            return session
          },
          async requireRequestUser() {
            if (requestUserError) throw requestUserError
            return actor
          },
        }
      }
      throw new Error(`unexpected route dependency: ${specifier}`)
    },
  }, { filename: routePath })
  return module.exports
}

const route = loadRoute()
const organizationA = '11111111-1111-4111-8111-111111111111'
const organizationB = '22222222-2222-4222-8222-222222222222'
const orderGlobalId = 'gor1234567'
const authorizationGlobalId = 'gsom1234567'
const attemptGlobalId = 'gsoa1234567'
const intentHash = 'a'.repeat(64)
const reason = 'Verify the exact Shopify test order mutation'
const idempotency = 'shopify-order-test-0001'
const fullCapabilities = Object.freeze({
  canActivate: true,
  canManage: true,
  canExecute: true,
})

function reset(overrides = {}) {
  calls.length = 0
  routeErrors.length = 0
  postgresEnabled = true
  requestUserError = null
  actor = {
    email: 'owner@example.com',
    activeOrganizationId: organizationA,
    capabilities: { ...fullCapabilities },
  }
  session = {
    legacy: false,
    authMethod: 'google_sso',
    impersonating: false,
    impersonationStartedAt: null,
    impersonationExpiresAt: null,
    authenticatedUser: 'owner@example.com',
    effectiveUser: 'owner@example.com',
    activeWorkspaceOrganizationId: organizationA,
  }
  sameOriginImpl = ({ headers, requestOrigin }) => (
    headers.get('origin') === requestOrigin
    && headers.get('sec-fetch-site') !== 'cross-site'
  )
  readImpl = async (input) => {
    calls.push(['read', input])
    return managementFixture(input.orderGlobalId)
  }
  saveImpl = async (input) => {
    calls.push(['save', input])
    return resultFixture('succeeded')
  }
  prepareImpl = async (input) => {
    calls.push(['prepare', input])
    return authorizationFixture()
  }
  executeImpl = async (input) => {
    calls.push(['execute', input])
    return resultFixture('succeeded')
  }
  reconcileImpl = async (input) => {
    calls.push(['reconcile', input])
    return resultFixture('reconciled')
  }
  Object.assign(actor, overrides.actor || {})
  Object.assign(session, overrides.session || {})
  if (overrides.capabilities) {
    actor.capabilities = { ...overrides.capabilities }
  }
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  const finalHeaders = new Headers(headers)
  const init = { method, headers: finalHeaders }
  if (body !== undefined) {
    const serialized = typeof body === 'string' ? body : JSON.stringify(body)
    init.body = serialized
    if (!finalHeaders.has('content-type')) {
      finalHeaders.set('content-type', 'application/json')
    }
  }
  const req = new Request(url, init)
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req
}

async function responseJson(response) {
  return {
    status: response.status,
    headers: response.headers,
    payload: await response.json(),
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function get(order = orderGlobalId, suffix = '') {
  return responseJson(await route.GET(request(
    `https://clawpilot.test/api/operations/shopify-order-management?orderGlobalId=${order}${suffix}`,
  )))
}

async function post(body, options = {}) {
  return responseJson(await route.POST(request(
    'https://clawpilot.test/api/operations/shopify-order-management',
    {
      method: 'POST',
      body,
      headers: {
        'idempotency-key': idempotency,
        ...(options.headers || {}),
      },
    },
  )))
}

// Ordinary order reads and saves require Operations-management permission.
// Account-level On remains a separate owner/admin control in its own route.
reset({ capabilities: { ...fullCapabilities, canManage: false } })
let denied = await get()
assert.equal(denied.status, 403)
assert.equal(denied.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_AUTHORITY_REQUIRED')
assert.equal(calls.length, 0, 'authority rejection must precede command reads')
for (const capability of ['canActivate', 'canExecute']) {
  reset({ capabilities: { ...fullCapabilities, [capability]: false } })
  const allowed = await get()
  assert.equal(allowed.status, 200, `${capability} must not gate normal order work`)
  assert.equal(calls.length, 1)
}

reset()
requestUserError = new Error('Unauthorized')
let result = await get()
assert.equal(result.status, 401)
assert.equal(result.payload.code, 'UNAUTHORIZED')
assert.equal(calls.length, 0)

reset({ actor: { activeOrganizationId: null } })
result = await get()
assert.equal(result.status, 409)
assert.equal(result.payload.code, 'ACTIVE_ORGANIZATION_REQUIRED')
assert.equal(calls.length, 0)

reset()
postgresEnabled = false
result = await get()
assert.equal(result.status, 503)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_POSTGRES_REQUIRED')
assert.equal(calls.length, 0)

// The route derives tenant scope from the authenticated actor and accepts no
// organization identifier from either query or body.
reset({ actor: { activeOrganizationId: organizationB } })
result = await get()
assert.equal(result.status, 200, JSON.stringify(result.payload))
assert.deepEqual(plain(calls), [['read', {
  organizationId: organizationB,
  orderGlobalId,
}]])
assert.equal(result.headers.get('cache-control'), 'private, no-store')
assert.equal(result.headers.get('vary'), 'Cookie')
assert.deepEqual(
  result.payload.management.order.fulfillments,
  managementFixture(orderGlobalId).order.fulfillments,
)
assert.deepEqual(
  result.payload.management.eligibility.fulfillments,
  managementFixture(orderGlobalId).eligibility.fulfillments,
)
assert.deepEqual(
  result.payload.management.eligibility.cancelAfterFulfillmentReversal,
  managementFixture(orderGlobalId).eligibility
    .cancelAfterFulfillmentReversal,
)
assert.deepEqual(
  result.payload.management.eligibility.cancel,
  managementFixture(orderGlobalId).eligibility.cancel,
)
assert.deepEqual(
  result.payload.management.payment,
  managementFixture(orderGlobalId).payment,
)

result = await get(orderGlobalId, `&organizationId=${organizationA}`)
assert.equal(result.status, 400)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_QUERY_INVALID')
result = await get(orderGlobalId, `&orderGlobalId=${orderGlobalId}`)
assert.equal(result.status, 400)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_QUERY_INVALID')
result = await get('gid://shopify/Order/123')
assert.equal(result.status, 400)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID')

const addTagMutation = Object.freeze({ kind: 'add_tag', tag: 'ClawPilot test' })
reset({ actor: { activeOrganizationId: organizationB } })
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: addTagMutation,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['save', {
  organizationId: organizationB,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: addTagMutation,
  idempotencyKey: idempotency,
}]])
assert.equal(JSON.stringify(result.payload).includes(organizationB), false)

const reverseFulfillmentMutation = Object.freeze({
  kind: 'cancel_fulfillment',
  fulfillmentId: 'gid://shopify/Fulfillment/456',
  expectedFulfillmentUpdatedAt: '2026-08-14T03:19:00.000Z',
})
reset()
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: reverseFulfillmentMutation,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['save', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: reverseFulfillmentMutation,
  idempotencyKey: idempotency,
}]])

const cancelAfterReversalMutation = Object.freeze({
  kind: 'cancel_order_after_fulfillment_reversal',
  predecessorAuthorizationGlobalId: 'gsom7654321',
})

// Post-reversal cancellation is still an irreversible order cancellation.
// The route and the enabled UI control therefore share the same owner/admin
// manage+activate+execute authority, direct-session, and same-origin boundary.
for (const [capability, expectedCode] of [
  ['canManage', 'SHOPIFY_ORDER_MANAGEMENT_AUTHORITY_REQUIRED'],
  ['canActivate', 'SHOPIFY_ORDER_CANCEL_AUTHORITY_REQUIRED'],
  ['canExecute', 'SHOPIFY_ORDER_CANCEL_AUTHORITY_REQUIRED'],
]) {
  reset({ capabilities: { ...fullCapabilities, [capability]: false } })
  result = await post({
    action: 'save',
    orderGlobalId,
    expectedRowVersion: 7,
    mutation: cancelAfterReversalMutation,
  }, {
    headers: {
      origin: 'https://clawpilot.test',
      'sec-fetch-site': 'same-origin',
    },
  })
  assert.equal(result.status, 403)
  assert.equal(result.payload.code, expectedCode)
  assert.equal(calls.length, 0)
}

reset({
  session: {
    impersonating: true,
    impersonationStartedAt: '2026-08-14T03:00:00.000Z',
    impersonationExpiresAt: '2026-08-14T03:30:00.000Z',
    authenticatedUser: 'support-owner@example.com',
    effectiveUser: 'owner@example.com',
  },
})
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelAfterReversalMutation,
}, {
  headers: {
    origin: 'https://clawpilot.test',
    'sec-fetch-site': 'same-origin',
  },
})
assert.equal(result.status, 403)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_CANCEL_DIRECT_SESSION_REQUIRED')
assert.equal(calls.length, 0)

reset()
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelAfterReversalMutation,
})
assert.equal(result.status, 403)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_CANCEL_SAME_ORIGIN_REQUIRED')
assert.equal(calls.length, 0)

reset()
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelAfterReversalMutation,
}, {
  headers: {
    origin: 'https://clawpilot.test',
    'sec-fetch-site': 'same-origin',
  },
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['save', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelAfterReversalMutation,
  idempotencyKey: idempotency,
}]])

const ordinarySaveMutation = Object.freeze({
  kind: 'save_order',
  email: 'receiving@example.com',
  phone: '+15555550199',
  poNumber: 'PO-UPDATED',
  note: 'Handle together',
  shippingAddress: {
    firstName: 'Pat',
    lastName: 'Buyer',
    company: 'Receiving Bakery',
    address1: '500 Receiving Lane',
    address2: 'Dock 4',
    city: 'Durham',
    provinceCode: 'NC',
    countryCode: 'US',
    zip: '27701',
    phone: '+15555550199',
  },
  tagAdds: ['priority'],
  tagRemoves: ['old-tag'],
  lineQuantities: [
    { lineItemId: 'gid://shopify/LineItem/123', quantity: 1 },
    { lineItemId: 'gid://shopify/LineItem/124', quantity: 2 },
  ],
})
reset()
result = await post({
  action: 'save',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: ordinarySaveMutation,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls[0]), ['save', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: ordinarySaveMutation,
  idempotencyKey: idempotency,
}])

// Legacy prepare/execute actions remain accepted only for rolling-runtime
// compatibility; the normal UI uses the single save action above.
reset({ actor: { activeOrganizationId: organizationB } })
result = await post({
  action: 'prepare',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: addTagMutation,
  reason,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['prepare', {
  organizationId: organizationB,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: addTagMutation,
  reason,
  idempotencyKey: idempotency,
}]])
assert.equal(JSON.stringify(result.payload).includes(organizationB), false)

// Execute repeats and binds the mutation, reason, intent, and typed
// confirmation rather than accepting only an authorization identifier.
reset()
const confirmationStatement =
  'AUTHORIZE SHOPIFY WRITE gsom1234567 ADD_TAG #6600'
result = await post({
  action: 'execute',
  authorizationGlobalId,
  intentHash,
  confirmationStatement,
  mutation: addTagMutation,
  reason,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['execute', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  authorizationGlobalId,
  intentHash,
  confirmationStatement,
  mutation: addTagMutation,
  reason,
  idempotencyKey: idempotency,
}]])

const cancelMutation = Object.freeze({
  kind: 'cancel',
  reasonCode: 'CUSTOMER',
  refundMethod: 'none',
  restock: true,
  notifyCustomer: false,
})
const cancelReason =
  'Customer requested cancellation before any warehouse work began'
const cancelConfirmation =
  'AUTHORIZE SHOPIFY WRITE gsom1234567 CANCEL #6600 REFUND NONE RESTOCK YES NOTIFY NO'

// Irreversible cancellation preparation and execution require the actual
// signed-in user, never a support-impersonated effective user. Rejection must
// happen before either durable command can attribute authorized_by to the
// impersonated target.
for (const action of ['prepare', 'execute']) {
  reset({
    session: {
      impersonating: true,
      impersonationStartedAt: '2026-08-14T03:00:00.000Z',
      impersonationExpiresAt: '2026-08-14T03:30:00.000Z',
      authenticatedUser: 'support-owner@example.com',
      effectiveUser: 'owner@example.com',
    },
  })
  const body = action === 'prepare'
    ? {
        action,
        orderGlobalId,
        expectedRowVersion: 7,
        mutation: cancelMutation,
        reason: cancelReason,
      }
    : {
        action,
        authorizationGlobalId,
        intentHash,
        confirmationStatement: cancelConfirmation,
        mutation: cancelMutation,
        reason: cancelReason,
      }
  result = await post(body, {
    headers: {
      origin: 'https://clawpilot.test',
      'sec-fetch-site': 'same-origin',
    },
  })
  assert.equal(result.status, 403)
  assert.equal(
    result.payload.code,
    'SHOPIFY_ORDER_CANCEL_DIRECT_SESSION_REQUIRED',
  )
  assert.equal(calls.length, 0)
}

reset()
result = await post({
  action: 'prepare',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelMutation,
  reason: cancelReason,
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['prepare', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: cancelMutation,
  reason: cancelReason,
  idempotencyKey: idempotency,
}]])

// The session cookie alone is not treated as CSRF protection for the
// irreversible provider call. Execute requires an explicit same-origin
// browser Origin and rejects cross-site requests before the command.
reset()
result = await post({
  action: 'execute',
  authorizationGlobalId,
  intentHash,
  confirmationStatement: cancelConfirmation,
  mutation: cancelMutation,
  reason: cancelReason,
})
assert.equal(result.status, 403)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_CANCEL_SAME_ORIGIN_REQUIRED')
assert.equal(calls.length, 0)

reset()
result = await post({
  action: 'execute',
  authorizationGlobalId,
  intentHash,
  confirmationStatement: cancelConfirmation,
  mutation: cancelMutation,
  reason: cancelReason,
}, {
  headers: {
    origin: 'https://clawpilot.test',
    'sec-fetch-site': 'same-origin',
  },
})
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['execute', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  authorizationGlobalId,
  intentHash,
  confirmationStatement: cancelConfirmation,
  mutation: cancelMutation,
  reason: cancelReason,
  idempotencyKey: idempotency,
}]])

reset()
result = await post({ action: 'reconcile', attemptGlobalId })
assert.equal(result.status, 200)
assert.deepEqual(plain(calls), [['reconcile', {
  organizationId: organizationA,
  actorEmail: 'owner@example.com',
  attemptGlobalId,
  idempotencyKey: idempotency,
}]])

// Strict field and value allowlists prevent tenant injection, action
// smuggling, multi-tag ambiguity, and malformed idempotency keys.
for (const [body, expectedCode] of [
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: addTagMutation, reason,
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'prepare', orderGlobalId, expectedRowVersion: 7,
    mutation: addTagMutation, reason, organizationId: organizationB,
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'prepare', orderGlobalId, expectedRowVersion: 7,
    mutation: { kind: 'add_tag', tag: 'one,two' }, reason,
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'prepare', orderGlobalId, expectedRowVersion: 7,
    mutation: { kind: 'cancel', restock: true }, reason,
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...reverseFulfillmentMutation,
      fulfillmentId: 'gid://shopify/Fulfillment/not-numeric',
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...reverseFulfillmentMutation,
      expectedFulfillmentUpdatedAt: '2026-08-14T03:19:00Z',
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...reverseFulfillmentMutation,
      refund: true,
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...cancelAfterReversalMutation,
      predecessorAuthorizationGlobalId: 'gsom-not-valid',
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...cancelAfterReversalMutation,
      refund: true,
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...ordinarySaveMutation,
      tagAdds: ['priority'],
      tagRemoves: ['priority'],
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...ordinarySaveMutation,
      shippingAddress: {
        ...ordinarySaveMutation.shippingAddress,
        countryCode: 'us',
      },
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'save', orderGlobalId, expectedRowVersion: 7,
    mutation: {
      ...ordinarySaveMutation,
      shippingAddress: {
        ...ordinarySaveMutation.shippingAddress,
        localShipmentOverride: 'must-not-cross-provider-boundary',
      },
    },
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{
    action: 'execute', authorizationGlobalId, intentHash,
    confirmationStatement, mutation: addTagMutation, reason,
    providerWrites: 1,
  }, 'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
  [{ action: 'delete', attemptGlobalId },
    'SHOPIFY_ORDER_MANAGEMENT_REQUEST_INVALID'],
]) {
  reset()
  result = await post(body)
  assert.equal(result.status, 400)
  assert.equal(result.payload.code, expectedCode)
  assert.equal(calls.length, 0)
}

reset()
result = await responseJson(await route.POST(request(
  'https://clawpilot.test/api/operations/shopify-order-management',
  {
    method: 'POST',
    body: JSON.stringify({
      action: 'prepare', orderGlobalId, expectedRowVersion: 7,
      mutation: addTagMutation, reason,
    }),
    headers: { 'content-type': 'application/json' },
  },
)))
assert.equal(result.status, 400)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_KEY_INVALID')
assert.equal(calls.length, 0)

reset()
result = await post({ action: 'reconcile', attemptGlobalId }, {
  headers: { 'idempotency-key': 'short' },
})
assert.equal(result.status, 400)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_IDEMPOTENCY_KEY_INVALID')
assert.equal(calls.length, 0)

reset()
result = await responseJson(await route.POST(request(
  'https://clawpilot.test/api/operations/shopify-order-management',
  {
    method: 'POST',
    body: '{}',
    headers: {
      'content-type': 'text/plain',
      'idempotency-key': idempotency,
    },
  },
)))
assert.equal(result.status, 415)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_CONTENT_TYPE_INVALID')
assert.equal(calls.length, 0)

// Unexpected failures are projected to a stable error and never reflect
// secrets or upstream exception detail.
reset()
readImpl = async () => {
  throw new Error('client-secret-value must never be returned')
}
result = await get()
assert.equal(result.status, 500)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_INTERNAL_ERROR')
assert.equal(JSON.stringify(result.payload).includes('client-secret-value'), false)
assert.equal(JSON.stringify(routeErrors).includes('client-secret-value'), false)

reset()
readImpl = async (input) => {
  const fixture = managementFixture(input.orderGlobalId)
  fixture.order.fulfillments[0].tracking[0].url = 'javascript:alert(1)'
  return fixture
}
result = await get()
assert.equal(result.status, 500)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_RESULT_INVALID')

reset()
readImpl = async (input) => {
  const fixture = managementFixture(input.orderGlobalId)
  fixture.eligibility.cancelAfterFulfillmentReversal = {
    allowed: true,
    reason: null,
    releasesAuthorization: false,
    predecessorAuthorizationGlobalId: null,
  }
  return fixture
}
result = await get()
assert.equal(result.status, 500)
assert.equal(result.payload.code, 'SHOPIFY_ORDER_MANAGEMENT_RESULT_INVALID')

// Successful responses are explicit public projections rather than a spread
// of command objects. Unknown credential/evidence fields cannot cross the API.
reset()
readImpl = async (input) => ({
  ...managementFixture(input.orderGlobalId),
  clientSecret: 'client-secret-value',
  encryptedCredential: 'encrypted-secret-value',
})
result = await get()
assert.equal(result.status, 200)
assert.equal(JSON.stringify(result.payload).includes('client-secret-value'), false)
assert.equal(JSON.stringify(result.payload).includes('encrypted-secret-value'), false)

reset()
prepareImpl = async () => ({
  ...authorizationFixture(),
  clientSecret: 'client-secret-value',
  preview: {
    ...authorizationFixture().preview,
    encryptedCredential: 'encrypted-secret-value',
  },
})
result = await post({
  action: 'prepare',
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: addTagMutation,
  reason,
})
assert.equal(result.status, 200)
assert.equal(JSON.stringify(result.payload).includes('client-secret-value'), false)
assert.equal(JSON.stringify(result.payload).includes('encrypted-secret-value'), false)

reset()
executeImpl = async () => ({
  ...resultFixture('succeeded'),
  clientSecret: 'client-secret-value',
  management: {
    ...managementFixture(),
    encryptedCredential: 'encrypted-secret-value',
  },
})
result = await post({
  action: 'execute',
  authorizationGlobalId,
  intentHash,
  confirmationStatement,
  mutation: addTagMutation,
  reason,
})
assert.equal(result.status, 200)
assert.equal(JSON.stringify(result.payload).includes('client-secret-value'), false)
assert.equal(JSON.stringify(result.payload).includes('encrypted-secret-value'), false)

console.log('Shopify order management API tests passed')
