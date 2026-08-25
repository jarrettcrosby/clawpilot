#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const commandsPath =
  'app_src/lib/operations/shopifyOrderManagementCommands.ts'

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`
}

function evidenceHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

class MockAdapterError extends Error {
  constructor(code, message = code, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia1234567'
const orderGlobalId = 'gor1234567'
const authorizationGlobalId = 'gsom1234567'
const predecessorAuthorizationGlobalId = 'gsom7654321'
const attemptGlobalId = 'gsoa1234567'
const externalAccountId = 'gid://shopify/Shop/123'
const externalOrderId = 'gid://shopify/Order/6909860774088'
const lineItemGid = 'gid://shopify/LineItem/123'
const fulfillmentGid = 'gid://shopify/Fulfillment/456'
const actorEmail = 'owner@example.com'
const reason = 'Verify exact mutation against the Shopify test order'
const idempotencyKey = 'shopify-order-test-0001'
const intentHash = 'a'.repeat(64)
const providerUpdatedAt = '2026-08-14T03:20:00.000Z'
const fulfillmentUpdatedAt = '2026-08-14T03:19:00.000Z'
const sourceShippingAddress = {
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
}
const updatedShippingAddress = {
  ...sourceShippingAddress,
  company: 'Receiving Bakery',
  address1: '500 Receiving Lane',
  address2: 'Dock 4',
  city: 'Durham',
  zip: '27701',
  phone: '+15555550199',
}

function targetFixture(overrides = {}) {
  return {
    organizationId,
    accountGlobalId,
    accountDisplayName: 'AG Alchemy',
    accountEnvironment: 'sandbox',
    externalAccountId,
    shopDomain: 'ag-alchemy.myshopify.com',
    credentialGeneration: 3,
    credentialCurrent: true,
    providerWriteRequestedMode: 'on',
    providerWriteControlRowVersion: 8,
    providerWriteBindingCurrent: true,
    providerWriteScopeDigest: 'f'.repeat(64),
    orderGlobalId,
    externalOrderId,
    orderNumber: '#6600',
    orderRowVersion: 7,
    orderStatus: 'imported',
    sourceHash: 'b'.repeat(64),
    acceptedSourceHash: 'b'.repeat(64),
    acceptedProviderUpdatedAt: providerUpdatedAt,
    latestSourceHash: 'b'.repeat(64),
    materialState: 'current',
    latestObservedAt: '2026-08-14T03:19:00.000Z',
    latestProviderUpdatedAt: providerUpdatedAt,
    latestProviderOrderTest: true,
    zeroDownstream: true,
    reversibleExternalFulfillmentGid: null,
    reversibleExternalFulfillmentUpdatedAt: null,
    fulfillmentReversalSafe: false,
    postReversalOrderCancellationSafe: false,
    postReversalOrderCancellationPredecessorGlobalId: null,
    latestOpenAuthorization: null,
    ...overrides,
  }
}

function reversalTargetFixture(overrides = {}) {
  return targetFixture({
    orderStatus: 'cancelled',
    zeroDownstream: false,
    materialState: 'provider_fulfilled',
    reversibleExternalFulfillmentGid: fulfillmentGid,
    reversibleExternalFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    fulfillmentReversalSafe: true,
    ...overrides,
  })
}

function postReversalCancellationTargetFixture(overrides = {}) {
  return reversalTargetFixture({
    fulfillmentReversalSafe: false,
    postReversalOrderCancellationSafe: true,
    postReversalOrderCancellationPredecessorGlobalId:
      predecessorAuthorizationGlobalId,
    ...overrides,
  })
}

function previewFixture(overrides = {}) {
  return {
    id: externalOrderId,
    legacyResourceId: '6909860774088',
    name: '#6600',
    test: true,
    createdAt: '2026-08-14T03:00:00.000Z',
    updatedAt: providerUpdatedAt,
    cancelledAt: null,
    closed: false,
    unpaid: true,
    capturable: false,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    merchantEditable: true,
    merchantEditableErrors: [],
    returnStatus: 'NO_RETURN',
    shopCurrencyCode: 'USD',
    orderCurrencyCode: 'USD',
    currentTotalPrice: { amount: '40.00', currencyCode: 'USD' },
    totalOutstanding: { amount: '40.00', currencyCode: 'USD' },
    email: 'buyer@example.com',
    phone: '+15555550100',
    poNumber: 'PO-6600',
    note: null,
    shippingAddress: sourceShippingAddress,
    tags: [],
    lines: [{
      id: lineItemGid,
      name: 'Test line',
      sku: 'TEST-1',
      currentQuantity: 2,
      unfulfilledQuantity: 2,
      nonFulfillableQuantity: 0,
      merchantEditable: true,
    }],
    fulfillments: [],
    ...overrides,
  }
}

function fulfillmentFixture(overrides = {}) {
  return {
    id: fulfillmentGid,
    name: '#6600.1',
    status: 'SUCCESS',
    displayStatus: 'FULFILLED',
    createdAt: '2026-08-14T03:15:00.000Z',
    updatedAt: fulfillmentUpdatedAt,
    deliveredAt: null,
    totalQuantity: 2,
    tracking: [{
      company: 'UPS',
      number: '1ZTEST6600',
      url: 'https://www.ups.com/track?loc=en_US&tracknum=1ZTEST6600',
    }],
    service: null,
    fulfillmentOrders: [{
      id: 'gid://shopify/FulfillmentOrder/789',
      assignedLocation: {
        location: {
          id: 'gid://shopify/Location/321',
          name: 'AG Alchemy HQ',
        },
      },
    }],
    ...overrides,
  }
}

function postReversalPreviewFixture(overrides = {}) {
  return previewFixture({
    fulfillments: [fulfillmentFixture({
      status: 'CANCELLED',
      displayStatus: 'CANCELLED',
      updatedAt: '2026-08-14T03:21:00.000Z',
    })],
    ...overrides,
  })
}

function inspectionFixture(preview = previewFixture(), overrides = {}) {
  return {
    probe: {
      shopId: externalAccountId,
      shopDomain: 'ag-alchemy.myshopify.com',
      grantedScopes: [
        'read_orders', 'write_orders', 'write_order_edits',
        'write_merchant_managed_fulfillment_orders',
      ],
    },
    preview,
    job: null,
    grantedScopes: [
      'read_orders', 'write_orders', 'write_order_edits',
      'write_merchant_managed_fulfillment_orders',
    ],
    providerReads: 2,
    ...overrides,
  }
}

function actionFixture(kind = 'add_tag') {
  if (kind === 'add_tag') return { type: 'add_tag', tag: 'ClawPilot test' }
  if (kind === 'cancel_fulfillment') {
    return {
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    }
  }
  if (kind === 'cancel_order_after_fulfillment_reversal') {
    return {
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId,
      reason: 'STAFF',
      staffNote: `ClawPilot authorized test action: ${reason}`,
    }
  }
  if (kind === 'cancel') {
    return {
      type: 'cancel',
      reason: 'STAFF',
      staffNote: `ClawPilot authorized test action: ${reason}`,
    }
  }
  return {
    type: 'set_line_quantity',
    lineItemGid,
    quantity: 1,
    staffNote: `ClawPilot authorized test action: ${reason}`,
  }
}

function authorizationFixture({
  action = actionFixture(),
  predecessorFulfillmentGid = undefined,
  status = 'prepared',
  providerAttemptGlobalId = null,
  providerWriteCount = 0,
  providerReference = null,
  errorCode = null,
  authorizationReason = reason,
} = {}) {
  return {
    authorizationGlobalId,
    organizationId,
    accountGlobalId,
    provider: 'shopify',
    accountEnvironment: 'sandbox',
    externalAccountId,
    shopDomain: 'ag-alchemy.myshopify.com',
    credentialGeneration: 3,
    legacyActivationState: null,
    legacyActivationRevision: null,
    providerWriteControlRowVersion: 8,
    providerWriteScopeDigest: 'f'.repeat(64),
    orderGlobalId,
    externalOrderId,
    orderNumber: '#6600',
    expectedOrderRowVersion: 7,
    expectedSourceHash: 'b'.repeat(64),
    acceptedObservationId: [
      'add_tag', 'cancel_fulfillment',
      'cancel_order_after_fulfillment_reversal',
    ].includes(action.type)
      ? null : '11111111-1111-4111-8111-111111111112',
    acceptedProviderOrderUpdatedAt: [
      'add_tag', 'cancel_fulfillment',
      'cancel_order_after_fulfillment_reversal',
    ].includes(action.type)
      ? null : providerUpdatedAt,
    providerOrderUpdatedAt: providerUpdatedAt,
    providerOrderObservedAt: '2026-08-14T03:20:01.000Z',
    providerOrderTest: true,
    providerSnapshotHash: 'c'.repeat(64),
    action: action.type,
    fulfillmentGid: action.type === 'cancel_fulfillment'
      ? action.fulfillmentGid : null,
    expectedFulfillmentUpdatedAt: action.type === 'cancel_fulfillment'
      ? action.expectedFulfillmentUpdatedAt : null,
    predecessorAuthorizationGlobalId:
      action.type === 'cancel_order_after_fulfillment_reversal'
        ? action.predecessorAuthorizationGlobalId : null,
    predecessorFulfillmentGid: predecessorFulfillmentGid === undefined
      ? action.type === 'cancel_order_after_fulfillment_reversal'
        ? fulfillmentGid : null
      : predecessorFulfillmentGid,
    lineItemGid: action.type === 'set_line_quantity'
      ? action.lineItemGid : null,
    expectedLineQuantity: action.type === 'set_line_quantity' ? 2 : null,
    requestedQuantity: action.type === 'set_line_quantity'
      ? action.quantity : null,
    tagHash: action.type === 'add_tag'
      ? evidenceHash({
          schema: 'shopify-order-management-tag-v1',
          tag: action.tag,
        })
      : null,
    cancelReason: [
      'cancel', 'cancel_order_after_fulfillment_reversal',
    ].includes(action.type) ? action.reason : null,
    staffNoteHash: action.type === 'cancel'
      || action.type === 'cancel_order_after_fulfillment_reversal'
      || action.type === 'set_line_quantity'
      ? evidenceHash({
          schema: 'shopify-order-management-staff-note-v1',
          staffNote: action.staffNote,
      })
      : null,
    requestedProjectionHash: action.type === 'save_order'
      ? '9'.repeat(64) : null,
    requiresOrderEdits: action.type === 'save_order'
      && action.lineQuantities.length > 0,
    authorizationReason,
    intentHash,
    idempotencyKey,
    requestHash: 'd'.repeat(64),
    status,
    storedStatus: status,
    authorizedBy: actorEmail,
    authorizedRole: 'owner',
    providerAttemptGlobalId,
    latestOutcomeGlobalId: null,
    latestOutcomeState: status === 'unknown' ? 'unknown'
      : status === 'succeeded' ? 'succeeded'
        : status === 'failed' ? 'failed'
          : status === 'reconciled' ? 'reconciled' : null,
    reconciliationResolution: status === 'reconciled' ? 'applied' : null,
    providerWriteCount,
    providerReference,
    errorCode,
    preparedAt: '2026-08-14T03:20:01.000Z',
    expiresAt: '2026-08-14T03:25:01.000Z',
    processingAt: providerAttemptGlobalId
      ? '2026-08-14T03:21:00.000Z' : null,
    completedAt: ['prepared', 'processing'].includes(status)
      ? null : '2026-08-14T03:21:10.000Z',
    replayed: false,
  }
}

let events = []
let target = targetFixture()
let runtime = { available: true, blockerCode: null }
let accountAllowed = true
let inspection = inspectionFixture()
let currentAuthorization = null
let adapterExecution = null
let adapterExecutionError = null
let lastPrepareInput = null
let lastClaimInput = null
let lastOutcomeInput = null
let lastReconcileInput = null
let lastRecoveryInput = null
let recoverAsUnknown = false
let revokeAfterCredentialRead = false
let providerExecutionCount = 0

function reset() {
  events = []
  target = targetFixture()
  runtime = { available: true, blockerCode: null }
  accountAllowed = true
  inspection = inspectionFixture()
  currentAuthorization = null
  adapterExecution = null
  adapterExecutionError = null
  lastPrepareInput = null
  lastClaimInput = null
  lastOutcomeInput = null
  lastReconcileInput = null
  lastRecoveryInput = null
  recoverAsUnknown = false
  revokeAfterCredentialRead = false
  providerExecutionCount = 0
}

function loadCommands() {
  const source = readFileSync(resolve(root, commandsPath), 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: commandsPath,
    reportDiagnostics: true,
  })
  const diagnostics = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(
    diagnostics,
    [],
    'Shopify order management commands must transpile',
  )
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
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
        return {
          decryptCommerceCredential(
            encrypted,
            requestedOrganizationId,
            provider,
            environment,
            requestedExternalAccountId,
          ) {
            events.push(['decrypt', {
              encrypted,
              organizationId: requestedOrganizationId,
              provider,
              environment,
              externalAccountId: requestedExternalAccountId,
            }])
            return {
              provider: 'shopify',
              clientId: 'client-id-value',
              clientSecret: 'client-secret-value',
            }
          },
        }
      }
      if (specifier === '@/lib/integrations/commerceCapabilities') {
        return {
          hasEffectiveShopifyScope(scopes, scope) {
            return scopes.includes(scope)
          },
        }
      }
      if (specifier === '@/lib/integrations/shopifyOrderManagement') {
        return {
          ShopifyOrderManagementError: MockAdapterError,
          requestedShopifyOrderSaveProjectionHash() {
            return '9'.repeat(64)
          },
          shopifyOrderManagementProjectionHash() {
            return '9'.repeat(64)
          },
          async inspectShopifyOrderManagementTarget(input) {
            events.push(['inspect', input])
            return inspection
          },
          async executeShopifyOrderManagementAction(input) {
            providerExecutionCount += 1
            events.push(['provider-execute', input])
            assert.ok(
              events.some(([event]) => event === 'claim'),
              'provider mutation must never run before the durable claim',
            )
            if (adapterExecutionError) throw adapterExecutionError
            return adapterExecution
          },
        }
      }
      if (specifier === '@/lib/integrations/shopifyOrderManagementRuntime') {
        return {
          shopifyOrderManagementRuntime() {
            events.push(['runtime'])
            return runtime
          },
          shopifyOrderManagementAccountAllowed(value) {
            events.push(['account-allowed', value])
            return accountAllowed
          },
        }
      }
      if (specifier === '@/lib/persistence/commerceIntegrations') {
        return {
          async readCommerceRuntimeCredentialFromPostgres(input) {
            events.push(['credential-read', input])
            const result = {
              organizationId: input.organizationId,
              provider: 'shopify',
              environment: 'sandbox',
              status: 'active',
              verificationStatus: 'verified',
              credentialVersion: 3,
              externalAccountId,
              encrypted: 'encrypted-secret-value',
            }
            if (revokeAfterCredentialRead) {
              runtime = {
                available: false,
                blockerCode: 'SHOPIFY_ORDER_MANAGEMENT_RUNTIME_DISABLED',
              }
            }
            return result
          },
        }
      }
      if (specifier === '@/lib/persistence/shopifyOrderManagement') {
        return {
          async readShopifyOrderManagementTargetInPostgres(input) {
            events.push(['target-read', input])
            if (
              input.organizationId !== organizationId
              || input.orderGlobalId !== orderGlobalId
            ) return null
            return target
          },
          async prepareShopifyOrderManagementInPostgres(input) {
            events.push(['prepare-persist', input])
            lastPrepareInput = input
            const action = input.action
            currentAuthorization = authorizationFixture({
              action,
              authorizationReason: input.reason,
            })
            return { ...currentAuthorization, replayed: false }
          },
          async readShopifyOrderManagementAuthorizationInPostgres(input) {
            events.push(['authorization-read', input])
            if (
              input.organizationId !== organizationId
              || input.authorizationGlobalId !== authorizationGlobalId
            ) return null
            return currentAuthorization
          },
          async readShopifyOrderManagementAuthorizationByAttemptInPostgres(input) {
            events.push(['attempt-read', input])
            if (
              input.organizationId !== organizationId
              || input.attemptGlobalId !== attemptGlobalId
            ) return null
            return currentAuthorization
          },
          async claimShopifyOrderManagementInPostgres(input) {
            events.push(['claim', input])
            lastClaimInput = input
            const claimed = {
              ...currentAuthorization,
              status: 'processing',
              storedStatus: 'processing',
              providerAttemptGlobalId: attemptGlobalId,
              attemptHash: 'e'.repeat(64),
              claimedAt: '2026-08-14T03:21:00.000Z',
              actionInput: input.action,
            }
            currentAuthorization = claimed
            return claimed
          },
          async recordShopifyOrderManagementOutcomeInPostgres(input) {
            events.push(['outcome-record', input])
            lastOutcomeInput = input
            currentAuthorization = {
              ...currentAuthorization,
              status: input.outcome,
              storedStatus: input.outcome,
              latestOutcomeState: input.outcome,
              providerWriteCount: input.providerWriteCount,
              providerReference: input.providerReference || null,
              errorCode: input.errorCode || null,
              completedAt: '2026-08-14T03:21:10.000Z',
            }
            return currentAuthorization
          },
          async reconcileShopifyOrderManagementOutcomeInPostgres(input) {
            events.push(['reconcile-persist', input])
            lastReconcileInput = input
            currentAuthorization = {
              ...currentAuthorization,
              status: 'reconciled',
              storedStatus: 'reconciled',
              latestOutcomeState: 'reconciled',
              reconciliationResolution: input.resolution,
              completedAt: '2026-08-14T03:22:10.000Z',
            }
            return currentAuthorization
          },
          async recoverStaleShopifyOrderManagementAttemptInPostgres(input) {
            events.push(['recover-processing', input])
            lastRecoveryInput = input
            if (!recoverAsUnknown) {
              return {
                authorization: currentAuthorization,
                recovered: false,
              }
            }
            currentAuthorization = {
              ...currentAuthorization,
              status: 'unknown',
              storedStatus: 'unknown',
              latestOutcomeState: 'unknown',
              providerWriteCount: null,
              providerReference: null,
              errorCode:
                'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
              completedAt: '2026-08-14T03:27:00.000Z',
            }
            return {
              authorization: currentAuthorization,
              recovered: true,
            }
          },
          shopifyOrderManagementEvidenceHash: evidenceHash,
        }
      }
      throw new Error(`unexpected command dependency: ${specifier}`)
    },
  }, { filename: commandsPath })
  return module.exports
}

const commands = loadCommands()

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function commandInput(overrides = {}) {
  return {
    organizationId,
    actorEmail,
    authorizationGlobalId,
    intentHash,
    confirmationStatement:
      'AUTHORIZE SHOPIFY WRITE gsom1234567 ADD_TAG #6600',
    mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
    reason,
    idempotencyKey,
    ...overrides,
  }
}

function successfulExecution(overrides = {}) {
  const before = previewFixture()
  return {
    action: 'add_tag',
    outcome: 'succeeded',
    providerReads: 3,
    providerMutationAttempted: true,
    providerWritesKnown: true,
    providerWrites: 1,
    retryable: false,
    probe: inspection.probe,
    before,
    after: previewFixture({
      updatedAt: '2026-08-14T03:21:09.000Z',
      tags: ['ClawPilot test'],
    }),
    result: {
      orderGid: externalOrderId,
      orderName: '#6600',
      updatedAt: '2026-08-14T03:21:09.000Z',
      tags: ['ClawPilot test'],
    },
    providerReference: externalOrderId,
    errorCode: null,
    safeMessage: null,
    ...overrides,
  }
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

// Prepare derives all tenant/account/order authority from the exact current
// target, performs a read-only provider inspection, and persists before
// returning a projected authorization. No credential material is returned.
reset()
let prepared = await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
  reason,
  idempotencyKey,
})
assert.deepEqual(events.map(([event]) => event), [
  'target-read',
  'credential-read',
  'decrypt',
  'inspect',
  'prepare-persist',
])
assert.equal(lastPrepareInput.organizationId, organizationId)
assert.equal(lastPrepareInput.accountGlobalId, accountGlobalId)
assert.equal(lastPrepareInput.orderGlobalId, orderGlobalId)
assert.equal(lastPrepareInput.expectedOrderRowVersion, 7)
assert.equal(lastPrepareInput.expectedSourceHash, target.sourceHash)
assert.deepEqual(plain(lastPrepareInput.action), {
  type: 'add_tag',
  tag: 'ClawPilot test',
})
assert.equal(lastPrepareInput.reason, reason)
assert.equal(lastPrepareInput.idempotencyKey, idempotencyKey)
assert.equal(prepared.providerWrites, 0)
assert.equal(prepared.confirmationStatement,
  'AUTHORIZE SHOPIFY WRITE gsom1234567 ADD_TAG #6600')
for (const secret of [
  'client-secret-value',
  'client-id-value',
  'encrypted-secret-value',
]) {
  assert.equal(JSON.stringify(prepared).includes(secret), false)
}

// Combined ordinary Save binds one desired-projection hash and asks the live
// inspection for both write_orders and write_order_edits when quantities are
// included. Plaintext fields reach only the short-lived action input.
reset()
const combinedMutation = {
  kind: 'save_order',
  email: 'receiving@example.com',
  phone: '+15555550199',
  poNumber: 'PO-UPDATED',
  note: 'Handle together',
  shippingAddress: updatedShippingAddress,
  tagAdds: ['priority'],
  tagRemoves: [],
  lineQuantities: [{ lineItemId: lineItemGid, quantity: 1 }],
}
prepared = await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: combinedMutation,
  reason: 'Save ordinary Shopify order changes together',
  idempotencyKey: 'shopify-combined-save-0001',
})
assert.equal(lastPrepareInput.requestedProjectionHash, '9'.repeat(64))
assert.deepEqual(plain(lastPrepareInput.action), {
  type: 'save_order',
  email: combinedMutation.email,
  phone: combinedMutation.phone,
  poNumber: combinedMutation.poNumber,
  note: combinedMutation.note,
  shippingAddress: updatedShippingAddress,
  tagAdds: ['priority'],
  tagRemoves: [],
  lineQuantities: [{ lineItemGid, quantity: 1 }],
})
const combinedInspection = events.find(([event]) => event === 'inspect')[1]
assert.deepEqual(plain(combinedInspection.requiredActions), [
  'save_order',
  'set_line_quantity',
])
assert.equal(prepared.providerWrites, 0)

// Provider writes Off rejects before credential access, inspection, durable
// intent, or any provider call.
reset()
target = targetFixture({
  providerWriteRequestedMode: 'off',
  providerWriteControlRowVersion: 9,
  providerWriteBindingCurrent: false,
  providerWriteScopeDigest: null,
})
await expectCode(commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
  reason,
  idempotencyKey,
}), 'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF')
assert.deepEqual(events.map(([event]) => event), ['target-read'])
assert.equal(lastPrepareInput, null)
assert.equal(providerExecutionCount, 0)

reset()
target = targetFixture({
  providerWriteRequestedMode: 'off',
  providerWriteControlRowVersion: 9,
  providerWriteBindingCurrent: false,
  providerWriteScopeDigest: null,
})
await expectCode(commands.saveShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: combinedMutation,
  idempotencyKey: 'shopify-address-draft-provider-writes-off',
}), 'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF')
assert.deepEqual(
  events.map(([event]) => event),
  ['target-read'],
  'Provider writes Off must reject the address-aware Save before credentials, provider calls, or durable intent',
)
assert.equal(lastPrepareInput, null)
assert.equal(providerExecutionCount, 0)

// New per-account commands have no dependency on the retired global runtime
// activation or account allowlist.
reset()
accountAllowed = false
runtime = {
  available: false,
  blockerCode: 'SHOPIFY_ORDER_MANAGEMENT_RUNTIME_DISABLED',
}
prepared = await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
  reason,
  idempotencyKey,
})
assert.equal(prepared.providerWrites, 0)
assert.deepEqual(events.map(([event]) => event), [
  'target-read', 'credential-read', 'decrypt', 'inspect', 'prepare-persist',
])

// The user-facing Save command internally prepares, claims, writes once, and
// retains the outcome without exposing typed confirmation or a reason field.
reset()
adapterExecution = successfulExecution()
let saved = await commands.saveShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
  idempotencyKey,
})
assert.equal(saved.state, 'succeeded')
assert.equal(saved.providerWrites, 1)
assert.equal(providerExecutionCount, 1)
assert.equal(lastPrepareInput.reason, 'Saved Shopify order tag in ClawPilot')
assert.equal(lastClaimInput.reason, 'Saved Shopify order tag in ClawPilot')
assert.deepEqual(events.map(([event]) => event), [
  'target-read',
  'credential-read',
  'decrypt',
  'inspect',
  'prepare-persist',
  'authorization-read',
  'target-read',
  'credential-read',
  'decrypt',
  'claim',
  'provider-execute',
  'outcome-record',
])

// Destructive controls are offered only when the accepted immutable provider
// observation is the same exact revision returned by the live preview. A tag
// remains additive, while a currency mismatch blocks only line editing.
reset()
target = targetFixture({
  acceptedProviderUpdatedAt: '2026-08-14T03:19:59.000Z',
})
let management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.equal(management.eligibility.addTag.allowed, true)
assert.equal(management.eligibility.cancel.allowed, false)
assert.match(management.eligibility.cancel.reason, /accept the current provider revision/i)
assert.equal(management.eligibility.lineEdits[0].allowed, false)

reset()
inspection = inspectionFixture(previewFixture({
  orderCurrencyCode: 'CAD',
  currentTotalPrice: { amount: '40.00', currencyCode: 'CAD' },
  totalOutstanding: { amount: '40.00', currencyCode: 'CAD' },
}))
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.equal(management.eligibility.cancel.allowed, true)
assert.equal(management.eligibility.lineEdits[0].allowed, false)
assert.match(management.eligibility.lineEdits[0].reason, /currencies to match/i)

// Warehouse history must not hide the current Shopify facts. A shipped order
// remains ineligible, but the UI receives the real fulfillment reason instead
// of the internal unstarted-order write fence.
reset()
target = targetFixture({
  orderStatus: 'shipped',
  zeroDownstream: false,
  materialState: 'provider_fulfilled',
  acceptedProviderUpdatedAt: '2026-08-14T03:19:59.000Z',
})
inspection = inspectionFixture(previewFixture({
  test: false,
  displayFulfillmentStatus: 'FULFILLED',
  lines: [{
    ...previewFixture().lines[0],
    unfulfilledQuantity: 0,
  }],
}))
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.equal(management.runtimeAvailable, true)
assert.equal(management.blockerCode, null)
assert.equal(management.eligibility.cancel.allowed, false)
assert.match(management.eligibility.cancel.reason, /fulfillment activity/i)
assert.deepEqual(events.map(([event]) => event), [
  'target-read', 'credential-read', 'decrypt', 'inspect',
])

// Fulfillment reversal has its own tightly bounded lane. It is available only
// for the exact externally reconciled fulfillment on a locally cancelled,
// provider-fulfilled order, while the ordinary editor keeps its original
// unstarted-order fence.
reset()
target = reversalTargetFixture()
inspection = inspectionFixture(previewFixture({
  displayFulfillmentStatus: 'FULFILLED',
  lines: [{
    ...previewFixture().lines[0],
    unfulfilledQuantity: 0,
  }],
  fulfillments: [fulfillmentFixture()],
}))
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.deepEqual(
  plain(events.filter(([event]) => event === 'inspect').at(-1)[1]
    .requiredActions),
  ['cancel_fulfillment'],
)
assert.equal(management.blockerCode, null)
assert.equal(management.eligibility.ordinarySave.allowed, false)
assert.equal(management.eligibility.cancel.allowed, false)
assert.deepEqual(plain(management.order.fulfillments), [{
  fulfillmentId: fulfillmentGid,
  name: '#6600.1',
  status: 'SUCCESS',
  displayStatus: 'FULFILLED',
  updatedAt: fulfillmentUpdatedAt,
  deliveredAt: null,
  quantity: 2,
  tracking: [{
    company: 'UPS',
    number: '1ZTEST6600',
    url: 'https://www.ups.com/track?loc=en_US&tracknum=1ZTEST6600',
  }],
}])
assert.deepEqual(plain(management.eligibility.fulfillments), [{
  fulfillmentId: fulfillmentGid,
  expectedUpdatedAt: fulfillmentUpdatedAt,
  allowed: true,
  reason: null,
}])

prepared = await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: {
    kind: 'cancel_fulfillment',
    fulfillmentId: fulfillmentGid,
    expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
  },
  reason: 'Reverse the exact Shopify test fulfillment',
  idempotencyKey: 'shopify-fulfillment-reversal-0001',
})
assert.deepEqual(plain(lastPrepareInput.action), {
  type: 'cancel_fulfillment',
  fulfillmentGid,
  expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
})
assert.deepEqual(
  plain(events.filter(([event]) => event === 'inspect').at(-1)[1]
    .requiredActions),
  ['cancel_fulfillment'],
)
assert.equal(
  events.filter(([event]) => event === 'inspect').at(-1)[1]
    .fulfillmentGid,
  fulfillmentGid,
)
assert.equal(prepared.preview.fulfillmentId, fulfillmentGid)
assert.equal(
  prepared.preview.expectedFulfillmentUpdatedAt,
  fulfillmentUpdatedAt,
)

for (const override of [{
  reversibleExternalFulfillmentGid: 'gid://shopify/Fulfillment/999',
}, {
  reversibleExternalFulfillmentUpdatedAt: '2026-08-14T03:18:59.000Z',
}]) {
  reset()
  target = reversalTargetFixture(override)
  inspection = inspectionFixture(previewFixture({
    fulfillments: [fulfillmentFixture()],
  }))
  management = await commands.readShopifyOrderManagementState({
    organizationId,
    orderGlobalId,
  })
  assert.equal(management.eligibility.fulfillments[0].allowed, false)
  assert.match(
    management.eligibility.fulfillments[0].reason,
    /exact reconciled external fulfillment/i,
  )
}

for (const override of [{ orderStatus: 'shipped' }, {
  materialState: 'current',
}, {
  fulfillmentReversalSafe: false,
}]) {
  reset()
  target = reversalTargetFixture(override)
  inspection = inspectionFixture(previewFixture({
    fulfillments: [fulfillmentFixture()],
  }))
  management = await commands.readShopifyOrderManagementState({
    organizationId,
    orderGlobalId,
  })
  assert.equal(management.eligibility.fulfillments[0].allowed, false)
  assert.match(
    management.eligibility.fulfillments[0].reason,
    /not eligible for Shopify fulfillment reversal/i,
  )
}

// The timestamp shown with the exact fulfillment is part of the mutation.
// A stale or substituted value fails before durable preparation.
reset()
target = reversalTargetFixture()
inspection = inspectionFixture(previewFixture({
  displayFulfillmentStatus: 'FULFILLED',
  fulfillments: [fulfillmentFixture()],
}))
await expectCode(commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: {
    kind: 'cancel_fulfillment',
    fulfillmentId: fulfillmentGid,
    expectedFulfillmentUpdatedAt: '2026-08-14T03:18:59.000Z',
  },
  reason: 'Reverse the exact Shopify test fulfillment',
  idempotencyKey: 'shopify-fulfillment-reversal-stale-0001',
}), 'SHOPIFY_FULFILLMENT_CANCEL_NOT_ELIGIBLE')
assert.equal(lastPrepareInput, null)

// Provider scope, the test-order lane, delivered state, and exact successful
// fulfillment status each independently prevent reversal.
for (const fixture of [
  {
    preview: previewFixture({ fulfillments: [fulfillmentFixture()] }),
    inspection: {
      grantedScopes: ['write_merchant_managed_fulfillment_orders'],
    },
    reason: /read_orders/i,
  },
  {
    preview: previewFixture({ fulfillments: [fulfillmentFixture()] }),
    inspection: {
      grantedScopes: [
        'read_orders', 'write_order_edits',
        'write_merchant_managed_fulfillment_orders',
      ],
    },
    reason: /write_orders/i,
  },
  {
    preview: previewFixture({ fulfillments: [fulfillmentFixture()] }),
    inspection: {
      grantedScopes: [
        'read_orders', 'write_orders', 'write_order_edits',
      ],
    },
    reason: /write_merchant_managed_fulfillment_orders/i,
  },
  {
    preview: previewFixture({
      test: false,
      fulfillments: [fulfillmentFixture()],
    }),
    reason: /test orders/i,
  },
  {
    preview: previewFixture({
      fulfillments: [fulfillmentFixture({
        deliveredAt: '2026-08-14T04:00:00.000Z',
      })],
    }),
    reason: /require a return/i,
  },
  {
    preview: previewFixture({
      fulfillments: [fulfillmentFixture({ status: 'CANCELLED' })],
    }),
    reason: /already reversed/i,
  },
  {
    preview: previewFixture({
      fulfillments: [fulfillmentFixture({ displayStatus: null })],
    }),
    reason: /successful, fulfilled/i,
  },
  {
    preview: previewFixture({
      fulfillments: [fulfillmentFixture({
        fulfillmentOrders: [{
          id: 'gid://shopify/FulfillmentOrder/789',
          assignedLocation: { location: null },
        }],
      })],
    }),
    reason: /assigned fulfillment location/i,
  },
]) {
  reset()
  target = reversalTargetFixture()
  inspection = inspectionFixture(fixture.preview, fixture.inspection || {})
  management = await commands.readShopifyOrderManagementState({
    organizationId,
    orderGlobalId,
  })
  assert.equal(management.eligibility.fulfillments[0].allowed, false)
  assert.match(management.eligibility.fulfillments[0].reason, fixture.reason)
}

// A completed fulfillment reversal unlocks one distinct order-cancellation
// action. Ordinary cancellation remains blocked by its imported-order fence,
// and the provider must still report the exact predecessor fulfillment as
// CANCELLED before this second write can be prepared.
reset()
target = postReversalCancellationTargetFixture()
inspection = inspectionFixture(previewFixture({
  fulfillments: [fulfillmentFixture({
    status: 'CANCELLED',
    displayStatus: 'CANCELLED',
    updatedAt: '2026-08-14T03:21:00.000Z',
  })],
}))
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.deepEqual(
  plain(events.filter(([event]) => event === 'inspect').at(-1)[1]
    .requiredActions),
  ['cancel_order_after_fulfillment_reversal'],
)
assert.equal(management.blockerCode, null)
assert.equal(management.eligibility.cancel.allowed, false)
assert.deepEqual(
  plain(management.eligibility.cancelAfterFulfillmentReversal),
  {
    allowed: true,
    reason: null,
    predecessorAuthorizationGlobalId,
  },
)

prepared = await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: {
    kind: 'cancel_order_after_fulfillment_reversal',
    predecessorAuthorizationGlobalId,
  },
  reason: 'Cancel the Shopify test order after fulfillment reversal',
  idempotencyKey: 'shopify-post-reversal-cancel-0001',
})
assert.deepEqual(plain(lastPrepareInput.action), {
  type: 'cancel_order_after_fulfillment_reversal',
  predecessorAuthorizationGlobalId,
  reason: 'STAFF',
  staffNote: 'ClawPilot authorized test action: Cancel the Shopify test order after fulfillment reversal',
})
assert.deepEqual(
  plain(events.filter(([event]) => event === 'inspect').at(-1)[1]
    .requiredActions),
  ['cancel_order_after_fulfillment_reversal'],
)
assert.equal(
  prepared.preview.predecessorAuthorizationGlobalId,
  predecessorAuthorizationGlobalId,
)

// Shopify refresh/webhook reconciliation may mark the local material state for
// review after the fulfillment reversal. The separately confirmed order cancel
// remains available while the exact predecessor is still CANCELLED.
reset()
target = postReversalCancellationTargetFixture({
  materialState: 'review_required',
})
inspection = inspectionFixture(postReversalPreviewFixture())
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.deepEqual(
  plain(management.eligibility.cancelAfterFulfillmentReversal),
  {
    allowed: true,
    reason: null,
    predecessorAuthorizationGlobalId,
  },
)

reset()
target = postReversalCancellationTargetFixture()
inspection = inspectionFixture(previewFixture({
  fulfillments: [fulfillmentFixture({
    status: 'CANCELLED',
    displayStatus: 'CANCELLED',
  })],
}))
await expectCode(commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: {
    kind: 'cancel_order_after_fulfillment_reversal',
    predecessorAuthorizationGlobalId: 'gsom9999999',
  },
  reason: 'Cancel the Shopify test order after fulfillment reversal',
  idempotencyKey: 'shopify-post-reversal-cancel-altered-0001',
}), 'SHOPIFY_ORDER_POST_REVERSAL_CANCEL_NOT_ELIGIBLE')
assert.equal(lastPrepareInput, null)

reset()
target = postReversalCancellationTargetFixture()
inspection = inspectionFixture(previewFixture({
  fulfillments: [fulfillmentFixture()],
}))
management = await commands.readShopifyOrderManagementState({
  organizationId,
  orderGlobalId,
})
assert.equal(
  management.eligibility.cancelAfterFulfillmentReversal.allowed,
  false,
)
assert.match(
  management.eligibility.cancelAfterFulfillmentReversal.reason,
  /predecessor fulfillment is not cancelled/i,
)

for (const fixture of [
  {
    preview: postReversalPreviewFixture(),
    inspection: {
      grantedScopes: [
        'read_orders', 'write_merchant_managed_fulfillment_orders',
      ],
    },
    reason: /write_orders/i,
  },
  {
    preview: postReversalPreviewFixture({ test: false }),
    reason: /test orders/i,
  },
  {
    preview: postReversalPreviewFixture({ cancelledAt: providerUpdatedAt }),
    reason: /already cancelled/i,
  },
  {
    preview: postReversalPreviewFixture({ closed: true }),
    reason: /closed/i,
  },
  {
    preview: postReversalPreviewFixture({ capturable: true }),
    reason: /payment authorization/i,
  },
  {
    preview: postReversalPreviewFixture({ returnStatus: 'RETURNED' }),
    reason: /return activity/i,
  },
  {
    preview: postReversalPreviewFixture({
      lines: [{
        ...previewFixture().lines[0],
        unfulfilledQuantity: 0,
      }],
    }),
    reason: /wholly unfulfilled/i,
  },
  {
    preview: postReversalPreviewFixture({ unpaid: false }),
    reason: /refund settings/i,
  },
]) {
  reset()
  target = postReversalCancellationTargetFixture()
  inspection = inspectionFixture(fixture.preview, fixture.inspection || {})
  management = await commands.readShopifyOrderManagementState({
    organizationId,
    orderGlobalId,
  })
  assert.equal(
    management.eligibility.cancelAfterFulfillmentReversal.allowed,
    false,
  )
  assert.match(
    management.eligibility.cancelAfterFulfillmentReversal.reason,
    fixture.reason,
  )
}

// Execution repeats and revalidates the exact mutation, reason, intent hash,
// and typed confirmation before it resolves credentials or claims an attempt.
reset()
currentAuthorization = authorizationFixture()
await expectCode(commands.executeShopifyOrderManagementCommand(commandInput({
  mutation: { kind: 'add_tag', tag: 'Changed tag' },
})), 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH')
assert.deepEqual(events.map(([event]) => event), ['authorization-read'])
assert.equal(providerExecutionCount, 0)

reset()
currentAuthorization = authorizationFixture()
await expectCode(commands.executeShopifyOrderManagementCommand(commandInput({
  reason: 'Changed reason after preparation',
})), 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH')
assert.deepEqual(events.map(([event]) => event), ['authorization-read'])
assert.equal(providerExecutionCount, 0)

reset()
currentAuthorization = authorizationFixture()
await expectCode(commands.executeShopifyOrderManagementCommand(commandInput({
  confirmationStatement: 'AUTHORIZE SOMETHING ELSE',
})), 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH')
assert.deepEqual(events.map(([event]) => event), ['authorization-read'])
assert.equal(providerExecutionCount, 0)

reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel_fulfillment'),
})
await expectCode(commands.executeShopifyOrderManagementCommand(commandInput({
  confirmationStatement:
    'AUTHORIZE SHOPIFY WRITE gsom1234567 CANCEL_FULFILLMENT #6600',
  mutation: {
    kind: 'cancel_fulfillment',
    fulfillmentId: fulfillmentGid,
    expectedFulfillmentUpdatedAt: '2026-08-14T03:18:59.000Z',
  },
})), 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH')
assert.deepEqual(events.map(([event]) => event), ['authorization-read'])
assert.equal(providerExecutionCount, 0)

reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel_order_after_fulfillment_reversal'),
})
await expectCode(commands.executeShopifyOrderManagementCommand(commandInput({
  confirmationStatement:
    'AUTHORIZE SHOPIFY WRITE gsom1234567 CANCEL_ORDER_AFTER_FULFILLMENT_REVERSAL #6600',
  mutation: {
    kind: 'cancel_order_after_fulfillment_reversal',
    predecessorAuthorizationGlobalId: 'gsom9999999',
  },
})), 'SHOPIFY_ORDER_MANAGEMENT_AUTHORIZATION_MISMATCH')
assert.deepEqual(events.map(([event]) => event), ['authorization-read'])
assert.equal(providerExecutionCount, 0)

// Execution resolves the original fulfillment through the exact predecessor
// authorization and passes that durable binding to the adapter. The operator
// never supplies or alters this fulfillment GID in the second mutation.
reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel_order_after_fulfillment_reversal'),
})
adapterExecution = successfulExecution({
  action: 'cancel_order_after_fulfillment_reversal',
})
const postReversalResult = await commands.executeShopifyOrderManagementCommand(commandInput({
  confirmationStatement:
    'AUTHORIZE SHOPIFY WRITE gsom1234567 CANCEL_ORDER_AFTER_FULFILLMENT_REVERSAL #6600',
  mutation: {
    kind: 'cancel_order_after_fulfillment_reversal',
    predecessorAuthorizationGlobalId,
  },
}))
const postReversalProviderCall = events.find(
  ([event]) => event === 'provider-execute',
)[1]
assert.deepEqual(plain(postReversalProviderCall.action), {
  type: 'cancel_order_after_fulfillment_reversal',
  predecessorAuthorizationGlobalId,
  reason: 'STAFF',
  staffNote: `ClawPilot authorized test action: ${reason}`,
  reversedFulfillmentGid: fulfillmentGid,
})
assert.equal(postReversalResult.state, 'succeeded')

// A claimed post-reversal command without its durable predecessor fulfillment
// fails before the adapter can dispatch Shopify's orderCancel mutation.
reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel_order_after_fulfillment_reversal'),
  predecessorFulfillmentGid: null,
})
const missingPredecessorResult = await commands.executeShopifyOrderManagementCommand(commandInput({
  confirmationStatement:
    'AUTHORIZE SHOPIFY WRITE gsom1234567 CANCEL_ORDER_AFTER_FULFILLMENT_REVERSAL #6600',
  mutation: {
    kind: 'cancel_order_after_fulfillment_reversal',
    predecessorAuthorizationGlobalId,
  },
}))
assert.equal(providerExecutionCount, 0)
assert.equal(missingPredecessorResult.state, 'failed')
assert.equal(
  lastOutcomeInput.errorCode,
  'SHOPIFY_ORDER_POST_REVERSAL_PREDECESSOR_MISSING',
)

// The durable provider-attempt claim is completed before the adapter can
// dispatch a mutation, and the adapter outcome is retained afterward.
reset()
currentAuthorization = authorizationFixture()
adapterExecution = successfulExecution()
let result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read',
  'target-read',
  'credential-read',
  'decrypt',
  'claim',
  'provider-execute',
  'outcome-record',
])
assert.equal(lastClaimInput.organizationId, organizationId)
assert.equal(lastClaimInput.authorizationGlobalId, authorizationGlobalId)
assert.deepEqual(plain(lastClaimInput.action), {
  type: 'add_tag',
  tag: 'ClawPilot test',
})
assert.equal(lastOutcomeInput.outcome, 'succeeded')
assert.equal(lastOutcomeInput.providerWriteCount, 1)
assert.equal(result.state, 'succeeded')
assert.equal(result.providerReads, 3)
assert.equal(result.providerWrites, 1)
assert.equal(result.replayed, false)
for (const secret of [
  'client-secret-value',
  'client-id-value',
  'encrypted-secret-value',
]) {
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(lastOutcomeInput).includes(secret), false)
}

// If the exact tag appears between preparation and execution, the adapter
// proves an idempotent zero-write success from its existing preview. Preserve
// the exact two-read count instead of inventing a readback request.
reset()
currentAuthorization = authorizationFixture()
adapterExecution = successfulExecution({
  providerReads: 2,
  providerMutationAttempted: false,
  providerWrites: 0,
  before: previewFixture({ tags: ['ClawPilot test'] }),
  after: previewFixture({ tags: ['ClawPilot test'] }),
})
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'succeeded')
assert.equal(result.providerReads, 2)
assert.equal(result.providerWrites, 0)
assert.equal(lastOutcomeInput.providerWriteCount, 0)

// Turning this exact account Off after prepare leaves the authorization
// prepared and prevents credential resolution, claim, or provider call.
reset()
await commands.prepareShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  orderGlobalId,
  expectedRowVersion: 7,
  mutation: { kind: 'add_tag', tag: 'ClawPilot test' },
  reason,
  idempotencyKey,
})
assert.equal(currentAuthorization.status, 'prepared')
events = []
target = targetFixture({
  providerWriteRequestedMode: 'off',
  providerWriteControlRowVersion: 9,
  providerWriteBindingCurrent: false,
  providerWriteScopeDigest: null,
})
await expectCode(
  commands.executeShopifyOrderManagementCommand(commandInput()),
  'SHOPIFY_ORDER_MANAGEMENT_PROVIDER_WRITES_OFF',
)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'target-read',
])
assert.equal(currentAuthorization.status, 'prepared')
assert.equal(lastClaimInput, null)
assert.equal(lastOutcomeInput, null)
assert.equal(providerExecutionCount, 0)

// Only the exact legacy rolling-runtime authorization shape consults the old
// activation allowlist. New normal commands can never construct this shape.
reset()
currentAuthorization = authorizationFixture({})
currentAuthorization = {
  ...currentAuthorization,
  legacyActivationState: 'shadow',
  legacyActivationRevision: 13,
  providerWriteControlRowVersion: null,
  providerWriteScopeDigest: null,
}
runtime = {
  available: false,
  blockerCode: 'SHOPIFY_ORDER_MANAGEMENT_RUNTIME_DISABLED',
}
await expectCode(
  commands.executeShopifyOrderManagementCommand(commandInput()),
  'SHOPIFY_ORDER_MANAGEMENT_RUNTIME_DISABLED',
)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'target-read', 'runtime',
])
assert.equal(currentAuthorization.status, 'prepared')
assert.equal(lastClaimInput, null)
assert.equal(lastOutcomeInput, null)
assert.equal(providerExecutionCount, 0)

// Adapter rejection before its first mutation is durably terminal with an
// exact zero-write count. A repeated execute replays that retained failure.
reset()
currentAuthorization = authorizationFixture()
adapterExecutionError = new MockAdapterError(
  'SHOPIFY_ORDER_MANAGEMENT_PRE_DISPATCH_REJECTED',
  'Credential probe rejected before mutation',
)
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'failed')
assert.equal(result.providerWrites, 0)
assert.equal(lastOutcomeInput.outcome, 'failed')
assert.equal(lastOutcomeInput.providerWriteCount, 0)
assert.equal(lastOutcomeInput.evidence.stage, 'adapter_rejected_before_dispatch')
assert.equal(providerExecutionCount, 1)
events = []
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'failed')
assert.equal(result.replayed, true)
assert.equal(providerExecutionCount, 1)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'target-read',
])

// An unknown provider outcome is persisted once. A repeated execute returns
// only retained local state and can never call the provider again.
reset()
currentAuthorization = authorizationFixture()
adapterExecution = successfulExecution({
  outcome: 'outcomeUnknown',
  after: null,
  result: null,
  providerWritesKnown: false,
  providerWrites: null,
  providerReference: null,
  errorCode: 'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_UNKNOWN',
  safeMessage: 'The provider outcome is unknown',
})
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'unknown')
assert.equal(lastOutcomeInput.outcome, 'unknown')
assert.equal(providerExecutionCount, 1)
events = []
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'unknown')
assert.equal(result.replayed, true)
assert.equal(providerExecutionCount, 1)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'target-read',
])

// A duplicate execute or reconcile while the provider-dispatch lease is live
// must stay visibly processing. Recovery uses the database clock; if it does
// not durably change processing to unknown, both commands reject without a
// provider read, a second claim, or a provider write.
reset()
currentAuthorization = authorizationFixture({
  status: 'processing',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
await expectCode(
  commands.executeShopifyOrderManagementCommand(commandInput()),
  'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
)
assert.equal(providerExecutionCount, 0)
assert.equal(lastClaimInput, null)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'recover-processing',
])
events = []
await expectCode(
  commands.reconcileShopifyOrderManagementCommand({
    organizationId,
    actorEmail,
    attemptGlobalId,
    idempotencyKey: 'shopify-processing-reconcile-0001',
  }),
  'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_PROCESSING',
)
assert.equal(providerExecutionCount, 0)
assert.deepEqual(events.map(([event]) => event), [
  'attempt-read', 'recover-processing',
])

// Once that exact five-minute lease is stale, persistence appends a durable
// unknown outcome. Execute replays that outcome without a second mutation;
// reconcile may proceed with read-only provider observation.
reset()
currentAuthorization = authorizationFixture({
  status: 'processing',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
recoverAsUnknown = true
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'unknown')
assert.equal(result.replayed, true)
assert.equal(currentAuthorization.status, 'unknown')
assert.equal(
  currentAuthorization.errorCode,
  'SHOPIFY_ORDER_MANAGEMENT_PROCESSING_LEASE_EXPIRED',
)
assert.equal(providerExecutionCount, 0)
assert.equal(lastClaimInput, null)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'recover-processing', 'target-read',
])

reset()
const recoveredTagAction = actionFixture('add_tag')
currentAuthorization = authorizationFixture({
  action: recoveredTagAction,
  status: 'processing',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
recoverAsUnknown = true
inspection = inspectionFixture(previewFixture({
  tags: [recoveredTagAction.tag],
}))
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-stale-reconcile-0001',
})
assert.equal(result.state, 'reconciled')
assert.equal(providerExecutionCount, 0)
assert.equal(lastReconcileInput.resolution, 'applied')
assert.deepEqual(events.map(([event]) => event), [
  'attempt-read',
  'recover-processing',
  'target-read',
  'credential-read',
  'decrypt',
  'inspect',
  'reconcile-persist',
])

// A retained terminal outcome is likewise replay-only and cannot resolve a
// credential, claim another attempt, or call the provider.
reset()
currentAuthorization = authorizationFixture({
  status: 'succeeded',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: 1,
  providerReference: externalOrderId,
})
result = await commands.executeShopifyOrderManagementCommand(commandInput())
assert.equal(result.state, 'succeeded')
assert.equal(result.replayed, true)
assert.equal(providerExecutionCount, 0)
assert.deepEqual(events.map(([event]) => event), [
  'authorization-read', 'target-read',
])

// A combined Save unknown outcome reconciles only when the complete current
// provider projection hashes to the retained desired projection. No plaintext
// draft is needed for this read-only decision and no second write is sent.
reset()
const combinedAction = {
  type: 'save_order',
  email: 'receiving@example.com',
  phone: '+15555550199',
  poNumber: 'PO-UPDATED',
  note: 'Handle together',
  shippingAddress: updatedShippingAddress,
  tagAdds: ['priority'],
  tagRemoves: [],
  lineQuantities: [{ lineItemGid, quantity: 1 }],
}
currentAuthorization = authorizationFixture({
  action: combinedAction,
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-combined-save-reconcile-0001',
})
assert.equal(result.state, 'reconciled')
assert.equal(lastReconcileInput.resolution, 'applied')
assert.equal(lastReconcileInput.evidence.requestedProjectionHash, '9'.repeat(64))
assert.equal(lastReconcileInput.evidence.observedProjectionHash, '9'.repeat(64))
assert.equal(providerExecutionCount, 0)

// Reconciliation is an exact-tenant, read-only observation. It records a
// resolution when the hashed tag is observed and never invokes the mutation
// adapter. Repeating a reconciled attempt is local-only.
reset()
const tagAction = actionFixture('add_tag')
currentAuthorization = authorizationFixture({
  action: tagAction,
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
target = targetFixture({
  providerWriteRequestedMode: 'off',
  providerWriteControlRowVersion: 9,
  providerWriteBindingCurrent: false,
  providerWriteScopeDigest: null,
})
inspection = inspectionFixture(previewFixture({ tags: [tagAction.tag] }))
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-order-reconcile-0001',
})
assert.equal(result.state, 'reconciled')
assert.equal(lastReconcileInput.organizationId, organizationId)
assert.equal(lastReconcileInput.authorizationGlobalId, authorizationGlobalId)
assert.equal(lastReconcileInput.providerAttemptGlobalId, attemptGlobalId)
assert.equal(lastReconcileInput.resolution, 'applied')
assert.equal(providerExecutionCount, 0)
assert.equal(result.management.blockerCode, null)
assert.equal(result.management.eligibility.addTag.allowed, false)
assert.deepEqual(events.map(([event]) => event), [
  'attempt-read',
  'target-read',
  'credential-read',
  'decrypt',
  'inspect',
  'reconcile-persist',
])
events = []
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-order-reconcile-0002',
})
assert.equal(result.state, 'reconciled')
assert.equal(result.replayed, true)
assert.equal(providerExecutionCount, 0)
assert.deepEqual(events.map(([event]) => event), [
  'attempt-read', 'target-read',
])

// Unknown writes are reconciled only from affirmative provider state. An
// immediate unchanged read can race eventual Shopify visibility, so absence
// of the tag or the original line quantity must remain unknown.
reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('add_tag'),
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
inspection = inspectionFixture(previewFixture({ tags: [] }))
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-tag-reconcile-unknown-0001',
})
assert.equal(result.state, 'unknown')
assert.equal(lastReconcileInput, null)

reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('set_line_quantity'),
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: null,
})
inspection = inspectionFixture(previewFixture())
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-line-reconcile-unknown-0001',
})
assert.equal(result.state, 'unknown')
assert.equal(lastReconcileInput, null)

// Reconciliation is bound to the durable account, shop, external order, and
// provider order name captured before the write. A rebound local target must
// fail before credentials or any provider read are resolved.
for (const [field, value] of [
  ['accountGlobalId', 'gia7654321'],
  ['externalAccountId', 'gid://shopify/Shop/999'],
  ['shopDomain', 'different-shop.myshopify.com'],
  ['externalOrderId', 'gid://shopify/Order/999'],
  ['orderNumber', '#DIFFERENT'],
]) {
  reset()
  currentAuthorization = authorizationFixture({
    action: actionFixture('add_tag'),
    status: 'unknown',
    providerAttemptGlobalId: attemptGlobalId,
    providerWriteCount: null,
  })
  target = targetFixture({ [field]: value })
  await expectCode(
    commands.reconcileShopifyOrderManagementCommand({
      organizationId,
      actorEmail,
      attemptGlobalId,
      idempotencyKey: `shopify-reconcile-target-${field}`,
    }),
    'SHOPIFY_ORDER_MANAGEMENT_RECONCILIATION_TARGET_MISMATCH',
  )
  assert.deepEqual(events.map(([event]) => event), [
    'attempt-read', 'target-read',
  ])
  assert.equal(lastReconcileInput, null)
  assert.equal(providerExecutionCount, 0)
}

// A completed Shopify cancellation Job does not by itself prove that the
// order was cancelled or that the mutation was not applied. Because the
// inspector reads the order before the Job, a completion race must remain
// unknown unless the exact order preview affirmatively shows cancelledAt.
reset()
const cancellationJobGid = 'gid://shopify/Job/cancel-6600'
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel'),
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: 1,
  providerReference: cancellationJobGid,
})
inspection = inspectionFixture(previewFixture(), {
  job: { jobGid: cancellationJobGid, done: true },
  providerReads: 3,
})
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-cancel-reconcile-unknown-0001',
})
assert.equal(result.state, 'unknown')
assert.equal(result.providerReads, 3)
assert.equal(lastReconcileInput, null)

// Fulfillment-reversal reconciliation is affirmative-only: the exact
// fulfillment must still be present and report CANCELLED. SUCCESS or a
// missing fulfillment can race Shopify visibility and remains unknown.
reset()
currentAuthorization = authorizationFixture({
  action: actionFixture('cancel_fulfillment'),
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
  providerWriteCount: 1,
  providerReference: fulfillmentGid,
})
inspection = inspectionFixture(previewFixture({
  fulfillments: [fulfillmentFixture({
    status: 'CANCELLED',
    updatedAt: '2026-08-14T03:21:00.000Z',
  })],
}))
result = await commands.reconcileShopifyOrderManagementCommand({
  organizationId,
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-fulfillment-reconcile-applied-0001',
})
assert.equal(result.state, 'reconciled')
assert.equal(lastReconcileInput.resolution, 'applied')
assert.equal(lastReconcileInput.evidence.fulfillmentId, fulfillmentGid)
assert.equal(
  lastReconcileInput.evidence.observedFulfillmentStatus,
  'CANCELLED',
)

for (const fulfillments of [[fulfillmentFixture()], []]) {
  reset()
  currentAuthorization = authorizationFixture({
    action: actionFixture('cancel_fulfillment'),
    status: 'unknown',
    providerAttemptGlobalId: attemptGlobalId,
    providerWriteCount: 1,
    providerReference: fulfillmentGid,
  })
  inspection = inspectionFixture(previewFixture({ fulfillments }))
  result = await commands.reconcileShopifyOrderManagementCommand({
    organizationId,
    actorEmail,
    attemptGlobalId,
    idempotencyKey: `shopify-fulfillment-reconcile-unknown-${fulfillments.length}`,
  })
  assert.equal(result.state, 'unknown')
  assert.equal(lastReconcileInput, null)
}

// A different organization cannot read or reconcile the attempt even when it
// knows the opaque global identifier.
reset()
currentAuthorization = authorizationFixture({
  status: 'unknown',
  providerAttemptGlobalId: attemptGlobalId,
})
await expectCode(commands.reconcileShopifyOrderManagementCommand({
  organizationId: '22222222-2222-4222-8222-222222222222',
  actorEmail,
  attemptGlobalId,
  idempotencyKey: 'shopify-order-reconcile-0003',
}), 'SHOPIFY_ORDER_MANAGEMENT_ATTEMPT_NOT_FOUND')
assert.equal(providerExecutionCount, 0)
assert.deepEqual(events.map(([event]) => event), ['attempt-read'])

console.log('Shopify order management command tests passed')
