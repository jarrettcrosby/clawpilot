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

function unavailable() {
  throw new Error('A focused test dependency was not overridden')
}

function normalizeDomain(value) {
  const domain = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(domain)) {
    throw new Error('invalid Shopify domain')
  }
  return domain
}

function hasEffectiveScope(scopes, required) {
  const effective = new Set(scopes)
  for (const scope of scopes) {
    if (scope.startsWith('write_')) {
      effective.add(`read_${scope.slice('write_'.length)}`)
    }
  }
  return effective.has(required)
}

function loadAdapterModule() {
  const path = 'app_src/lib/integrations/shopifyOrderManagement.ts'
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Boolean,
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
      if (specifier === '@/lib/integrations/commerceCapabilities') {
        return {
          SHOPIFY_ADMIN_API_VERSION: '2026-07',
          hasEffectiveShopifyScope: hasEffectiveScope,
        }
      }
      if (specifier === '@/lib/integrations/shopifyCommerceClient') {
        return {
          normalizeShopifyShopDomain: normalizeDomain,
          probeShopifyConnection: unavailable,
          requestShopifyAccessToken: unavailable,
          shopifyAdminGraphql: unavailable,
        }
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const adapter = loadAdapterModule()
const orderGid = 'gid://shopify/Order/6600000000'
const lineGid = 'gid://shopify/LineItem/6600000001'
const shopGid = 'gid://shopify/Shop/987654321'
const shopDomain = 'warehouse-test.myshopify.com'
const beforeUpdatedAt = '2026-08-13T14:00:00.000Z'
const afterUpdatedAt = '2026-08-13T14:01:00.000Z'
const calculatedOrderGid = 'gid://shopify/CalculatedOrder/6600000000'
const orderEditSessionGid = 'gid://shopify/OrderEditSession/6600000000'
const calculatedLineGid = 'gid://shopify/CalculatedLineItem/6600000001'
const cancellationJobGid = 'gid://shopify/Job/123e4567-e89b-12d3-a456-426614174000'

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function providerOrder(overrides = {}) {
  const lineOverrides = overrides.line || {}
  const orderOverrides = { ...overrides }
  delete orderOverrides.line
  return {
    id: orderGid,
    legacyResourceId: '6600000000',
    name: '#6600',
    test: true,
    createdAt: '2026-08-13T13:00:00Z',
    updatedAt: beforeUpdatedAt,
    cancelledAt: null,
    closed: false,
    unpaid: true,
    capturable: false,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    merchantEditable: true,
    merchantEditableErrors: [],
    returnStatus: 'NO_RETURN',
    currencyCode: 'USD',
    currentTotalPriceSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    totalOutstandingSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    note: null,
    tags: ['warehouse-test'],
    lineItems: {
      nodes: [{
        id: lineGid,
        name: 'Test warehouse case',
        sku: '',
        currentQuantity: 3,
        unfulfilledQuantity: 3,
        nonFulfillableQuantity: 0,
        merchantEditable: true,
        ...lineOverrides,
      }],
      pageInfo: { hasNextPage: false },
    },
    ...orderOverrides,
  }
}

function expected(overrides = {}) {
  return {
    shopId: shopGid,
    shopDomain,
    orderGid,
    orderName: '#6600',
    updatedAt: beforeUpdatedAt,
    ...overrides,
  }
}

function input(action, overrides = {}) {
  return {
    credential: {
      shopDomain,
      clientId: 'shopify-client-id',
      clientSecret: 'shopify-client-secret-value',
    },
    expected: expected(),
    action,
    clientOptions: { timeoutMs: 5_000 },
    ...overrides,
  }
}

function harness(queue, overrides = {}) {
  const calls = {
    token: [],
    probe: [],
    graphql: [],
  }
  const dependencies = {
    async requestAccessToken(credential, options) {
      calls.token.push({ credential, options })
      return {
        accessToken: 'short-lived-access-token',
        grantedScopes: overrides.tokenScopes || ['write_orders', 'write_order_edits'],
        expiresIn: 86_400,
        expiresAt: '2026-08-14T14:00:00.000Z',
      }
    },
    async probeConnection(credential, options) {
      calls.probe.push({ credential, options })
      return {
        provider: 'shopify',
        apiVersion: '2026-07',
        shopId: overrides.shopId || shopGid,
        shopDomain: overrides.shopDomain || shopDomain,
        shopName: 'Warehouse Test',
        grantedScopes: overrides.probeScopes || ['write_orders', 'write_order_edits'],
      }
    },
    async graphql(credential, request, options) {
      calls.graphql.push({ credential, request, options })
      const next = queue.shift()
      assert.ok(next, `Unexpected GraphQL operation ${request.operationName}`)
      assert.equal(request.operationName, next.operation)
      if (next.error) throw next.error
      return typeof next.response === 'function'
        ? next.response(request)
        : next.response
    },
  }
  return { calls, dependencies, queue }
}

function previewResponse(order = providerOrder(), shopCurrencyCode = 'USD') {
  return { shop: { currencyCode: shopCurrencyCode }, order }
}

function stagedQuantityResponse(overrides = {}) {
  return {
    orderEditSetQuantity: {
      calculatedOrder: {
        id: calculatedOrderGid,
        totalPriceSet: {
          shopMoney: { amount: '50.00', currencyCode: 'USD' },
        },
        totalOutstandingSet: {
          shopMoney: { amount: '50.00', currencyCode: 'USD' },
        },
        ...(overrides.calculatedOrder || {}),
      },
      calculatedLineItem: {
        id: calculatedLineGid,
        quantity: 1,
        ...(overrides.calculatedLineItem || {}),
      },
      userErrors: overrides.userErrors || [],
    },
  }
}

assert.equal(adapter.SHOPIFY_ORDER_MANAGEMENT_API_VERSION, '2026-07')
assert.equal(
  adapter.SHOPIFY_ORDER_MANAGEMENT_ADAPTER_VERSION,
  'shopify-graphql-2026-07-order-management-v1',
)

// The read contract is pinned, bounded, accepts Shopify's valid blank SKU, and
// rejects pagination because eligibility cannot be proven from a partial order.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(),
  }])
  const preview = await adapter.readShopifyOrderManagementPreview(
    { shopDomain, accessToken: 'short-lived-access-token' },
    orderGid,
    {},
    h.dependencies,
  )
  assert.equal(preview.id, orderGid)
  assert.equal(preview.lines[0].sku, '')
  assert.equal(preview.updatedAt, beforeUpdatedAt)
  assert.equal(preview.shopCurrencyCode, 'USD')
  assert.equal(preview.orderCurrencyCode, 'USD')
  assert.deepEqual(plain(preview.currentTotalPrice), {
    amount: '150.00',
    currencyCode: 'USD',
  })
  const request = h.calls.graphql[0].request
  assert.match(request.query, /shop \{ currencyCode \}/)
  assert.match(request.query, /currentTotalPriceSet/)
  assert.match(request.query, /totalOutstandingSet/)
  assert.match(request.query, /lineItems\(first: 250\)/)
  assert.match(request.query, /\btest\b/)
  assert.match(request.query, /\bunpaid\b/)
  assert.match(request.query, /\breturnStatus\b/)
  assert.deepEqual(plain(request.variables), { id: orderGid })
}

{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({
      lineItems: {
        nodes: providerOrder().lineItems.nodes,
        pageInfo: { hasNextPage: true },
      },
    })),
  }])
  await assert.rejects(
    adapter.readShopifyOrderManagementPreview(
      { shopDomain, accessToken: 'short-lived-access-token' },
      orderGid,
      {},
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_ORDER_TOO_LARGE',
  )
}

// Currency and current financial evidence are mandatory preview fields. Bad
// provider shapes fail closed before eligibility or mutation is considered.
for (const response of [
  { shop: {}, order: providerOrder() },
  previewResponse(providerOrder(), 'usd'),
  previewResponse(providerOrder({ currencyCode: undefined })),
  previewResponse(providerOrder({ currencyCode: 'US' })),
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response,
  }])
  await assert.rejects(
    adapter.readShopifyOrderManagementPreview(
      { shopDomain, accessToken: 'short-lived-access-token' },
      orderGid,
      {},
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A valid order currency that differs from the shop currency is readable, but
// cannot enter an order-edit session.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({ currencyCode: 'CAD' })),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'set_line_quantity',
        lineItemGid: lineGid,
        quantity: 1,
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_EDIT_CURRENCY_MISMATCH',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// The lower-level set-quantity mutation strictly proves calculated line and
// shop-money totals before a dispatcher can proceed to commit.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderEditSetQuantity',
    response: stagedQuantityResponse(),
  }])
  const result = await adapter.setShopifyOrderEditLineQuantity(
    { shopDomain, accessToken: 'short-lived-access-token' },
    {
      calculatedOrderGid,
      lineItemGid: lineGid,
      quantity: 1,
      expectedCurrencyCode: 'USD',
    },
    {},
    h.dependencies,
  )
  assert.deepEqual(plain(result), {
    calculatedOrderGid,
    calculatedLineItemGid: calculatedLineGid,
    quantity: 1,
    totalPrice: { amount: '50.00', currencyCode: 'USD' },
    totalOutstanding: { amount: '50.00', currencyCode: 'USD' },
  })
  assert.match(h.calls.graphql[0].request.query, /totalPriceSet/)
  assert.match(h.calls.graphql[0].request.query, /totalOutstandingSet/)
  assert.match(h.calls.graphql[0].request.query, /calculatedLineItem \{ id quantity \}/)
}

for (const testCase of [
  {
    response: stagedQuantityResponse({
      calculatedOrder: { totalOutstandingSet: null },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
  },
  {
    response: stagedQuantityResponse({
      calculatedOrder: {
        totalPriceSet: {
          shopMoney: { amount: 50, currencyCode: 'USD' },
        },
      },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
  },
  {
    response: stagedQuantityResponse({
      calculatedOrder: {
        totalPriceSet: {
          shopMoney: { amount: '50.00', currencyCode: 'usd' },
        },
      },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
  },
  {
    response: stagedQuantityResponse({
      calculatedOrder: {
        totalOutstandingSet: {
          shopMoney: { amount: '50.00', currencyCode: 'CAD' },
        },
      },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_CURRENCY_MISMATCH',
  },
  {
    response: stagedQuantityResponse({
      calculatedLineItem: { quantity: 2 },
    }),
    code: 'SHOPIFY_ORDER_EDIT_QUANTITY_RESPONSE_MISMATCH',
  },
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderEditSetQuantity',
    response: testCase.response,
  }])
  await assert.rejects(
    adapter.setShopifyOrderEditLineQuantity(
      { shopDomain, accessToken: 'short-lived-access-token' },
      {
        calculatedOrderGid,
        lineItemGid: lineGid,
        quantity: 1,
        expectedCurrencyCode: 'USD',
      },
      {},
      h.dependencies,
    ),
    (error) => error.code === testCase.code,
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A high-level inspection owns token acquisition, canonical identity, scope,
// and the exact live preview without requiring a stale-prone updatedAt value.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({ test: false })),
  }])
  const result = await adapter.inspectShopifyOrderManagementTarget({
    credential: {
      shopDomain,
      clientId: 'shopify-client-id',
      clientSecret: 'shopify-client-secret-value',
    },
    expected: {
      shopId: shopGid,
      shopDomain,
      orderGid,
      orderName: '#6600',
    },
    requiredActions: ['add_tag', 'set_line_quantity'],
    clientOptions: { timeoutMs: 5_000 },
  }, h.dependencies)
  assert.equal(result.preview.id, orderGid)
  assert.equal(result.preview.test, false)
  assert.equal(result.job, null)
  assert.equal(result.providerReads, 2)
  assert.deepEqual(plain(result.grantedScopes), [
    'write_orders',
    'write_order_edits',
  ])
  assert.equal(h.calls.token.length, 1)
  assert.equal(h.calls.probe.length, 1)
  assert.equal(h.calls.graphql.length, 1)
}

// Reconciliation can inspect the order and its pending cancellation Job with
// the same short-lived token and one additional provider read.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({ test: false })),
    },
    {
      operation: 'ClawPilotShopifyOrderManagementJob',
      response: {
        job: { id: cancellationJobGid, done: false },
      },
    },
  ])
  const result = await adapter.inspectShopifyOrderManagementTarget({
    credential: {
      shopDomain,
      clientId: 'shopify-client-id',
      clientSecret: 'shopify-client-secret-value',
    },
    expected: { shopId: shopGid, shopDomain, orderGid },
    requiredActions: ['cancel'],
    jobGid: cancellationJobGid,
  }, h.dependencies)
  assert.deepEqual(plain(result.job), {
    jobGid: cancellationJobGid,
    done: false,
  })
  assert.equal(result.providerReads, 3)
  assert.equal(h.calls.token.length, 1)
  assert.equal(h.calls.probe.length, 1)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderManagementJob',
    ],
  )
}

// Pending cancellation reconciliation uses one exact Job read. It never polls.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementJob',
    response: {
      job: { id: cancellationJobGid, done: true },
    },
  }])
  const result = await adapter.readShopifyOrderManagementJob(
    { shopDomain, accessToken: 'short-lived-access-token' },
    cancellationJobGid,
    {},
    h.dependencies,
  )
  assert.deepEqual(plain(result), {
    jobGid: cancellationJobGid,
    done: true,
  })
  assert.deepEqual(plain(h.calls.graphql[0].request.variables), {
    id: cancellationJobGid,
  })
  assert.equal(h.calls.graphql.length, 1)
}

{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementJob',
    response: {
      job: { id: 'gid://shopify/Job/different-job', done: true },
    },
  }])
  await assert.rejects(
    adapter.readShopifyOrderManagementJob(
      { shopDomain, accessToken: 'short-lived-access-token' },
      cancellationJobGid,
      {},
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_JOB_MISMATCH',
  )
  assert.equal(h.calls.graphql.length, 1)
}

{
  const h = harness([])
  await assert.rejects(
    adapter.readShopifyOrderManagementJob(
      { shopDomain, accessToken: 'short-lived-access-token' },
      `gid://shopify/Job/${'a'.repeat(300)}`,
      {},
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
  )
  assert.equal(h.calls.graphql.length, 0)
}

// #6600's initial write is additive tagsAdd, followed by a strict readback;
// neither orderUpdate nor a full tag replacement is dispatched.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({ test: false })),
    },
    {
      operation: 'ClawPilotShopifyOrderTagAdd',
      response: {
        tagsAdd: {
          node: {
            id: orderGid,
            name: '#6600',
            updatedAt: afterUpdatedAt,
            tags: ['warehouse-test', 'clawpilot-managed'],
          },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({
        test: false,
        updatedAt: afterUpdatedAt,
        tags: ['warehouse-test', 'clawpilot-managed'],
      })),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'add_tag', tag: 'clawpilot-managed' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReads, 3)
  assert.equal(result.providerWrites, 1)
  assert.equal(result.providerReference, orderGid)
  assert.equal(result.after.tags.includes('clawpilot-managed'), true)
  const operations = h.calls.graphql.map((call) => call.request.operationName)
  assert.deepEqual(operations, [
    'ClawPilotShopifyOrderManagementPreview',
    'ClawPilotShopifyOrderTagAdd',
    'ClawPilotShopifyOrderManagementPreview',
  ])
  const mutation = h.calls.graphql[1].request
  assert.deepEqual(plain(mutation.variables), {
    id: orderGid,
    tags: ['clawpilot-managed'],
  })
  assert.doesNotMatch(mutation.query, /orderUpdate/)
  assert.equal(JSON.stringify(result).includes('short-lived-access-token'), false)
  assert.equal(h.queue.length, 0)
}

// An already-present additive tag is a proven zero-write success.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({
      tags: ['warehouse-test', 'clawpilot-managed'],
    })),
  }])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'add_tag', tag: 'clawpilot-managed' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReads, 2)
  assert.equal(result.providerMutationAttempted, false)
  assert.equal(result.providerWrites, 0)
  assert.equal(h.calls.graphql.length, 1)
}

// The lower-level orderUpdate primitive is exact, but is deliberately not a
// dispatcher action because its tags argument replaces the full tag list.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderMetadataUpdate',
    response: {
      orderUpdate: {
        order: {
          id: orderGid,
          name: '#6600',
          updatedAt: afterUpdatedAt,
          note: 'Warehouse test note',
          tags: ['warehouse-test'],
        },
        userErrors: [],
      },
    },
  }])
  const result = await adapter.updateShopifyOrderMetadata(
    { shopDomain, accessToken: 'short-lived-access-token' },
    {
      orderGid,
      note: 'Warehouse test note',
      tags: ['warehouse-test'],
    },
    {},
    h.dependencies,
  )
  assert.equal(result.note, 'Warehouse test note')
  assert.deepEqual(plain(h.calls.graphql[0].request.variables), {
    input: {
      id: orderGid,
      note: 'Warehouse test note',
      tags: ['warehouse-test'],
    },
  })
}

// Cancellation is limited to a test, unpaid, non-capturable, wholly
// unfulfilled order without returns. Every financial/notification decision is
// hardcoded to the non-refunding test-safe path.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyTestOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: false },
          orderCancelUserErrors: [],
        },
      },
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'STAFF',
      staffNote: 'ClawPilot warehouse test cancellation',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.providerReads, 2)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_JOB_PENDING')
  assert.equal(result.providerReference, cancellationJobGid)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 1)
  const mutation = h.calls.graphql[1].request
  assert.deepEqual(plain(mutation.variables), {
    orderId: orderGid,
    notifyCustomer: false,
    refundMethod: { originalPaymentMethodsRefund: false },
    restock: false,
    reason: 'STAFF',
    staffNote: 'ClawPilot warehouse test cancellation',
  })
  assert.equal(h.calls.graphql.length, 2)
}

// A production, paid, partially fulfilled, capturable, returned, or stale
// order is blocked before any mutation. One representative carries every
// unsafe state to keep the focused test compact.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({
      test: false,
      unpaid: false,
      capturable: true,
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      returnStatus: 'RETURN_REQUESTED',
      line: { unfulfilledQuantity: 1 },
    })),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel',
        reason: 'STAFF',
        staffNote: 'Blocked test cancellation',
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_TEST_ORDER_REQUIRED',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A synchronous provider rejection proves zero writes; a transport error after
// dispatch is terminal outcomeUnknown and is never retried.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyTestOrderCancel',
      response: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{
            field: ['orderId'],
            message: 'Order cannot be cancelled',
            code: 'ORDER_NOT_FOUND',
          }],
        },
      },
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'OTHER',
      staffNote: 'Expected provider rejection',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.providerWrites, 0)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_REJECTED')
  assert.equal(h.calls.graphql.length, 2)
}

{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyTestOrderCancel',
      error: new Error('socket closed after request dispatch'),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'STAFF',
      staffNote: 'Ambiguous provider transport',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, false)
  assert.equal(result.providerWrites, null)
  assert.equal(h.calls.graphql.length, 2)
}

// Quantity changes use the three-stage Shopify order-edit contract and allow
// only one decrease/removal on a fresh, test, wholly unfulfilled order.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderEditBegin',
      response: {
        orderEditBegin: {
          calculatedOrder: { id: calculatedOrderGid },
          orderEditSession: { id: orderEditSessionGid },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderEditSetQuantity',
      response: {
        orderEditSetQuantity: {
          calculatedOrder: {
            id: calculatedOrderGid,
            totalPriceSet: {
              shopMoney: { amount: '50.00', currencyCode: 'USD' },
            },
            totalOutstandingSet: {
              shopMoney: { amount: '50.00', currencyCode: 'USD' },
            },
          },
          calculatedLineItem: { id: calculatedLineGid, quantity: 1 },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderEditCommit',
      response: {
        orderEditCommit: {
          order: { id: orderGid, name: '#6600', updatedAt: afterUpdatedAt },
          successMessages: ['Order edited'],
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({
        updatedAt: afterUpdatedAt,
        currentTotalPriceSet: {
          shopMoney: { amount: '50.0', currencyCode: 'USD' },
        },
        totalOutstandingSet: {
          shopMoney: { amount: '50', currencyCode: 'USD' },
        },
        line: { currentQuantity: 1, unfulfilledQuantity: 1 },
      })),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'set_line_quantity',
      lineItemGid: lineGid,
      quantity: 1,
      staffNote: 'ClawPilot warehouse quantity test',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReads, 3)
  assert.equal(result.providerWrites, 3)
  assert.equal(result.after.lines[0].currentQuantity, 1)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderEditBegin',
      'ClawPilotShopifyOrderEditSetQuantity',
      'ClawPilotShopifyOrderEditCommit',
      'ClawPilotShopifyOrderManagementPreview',
    ],
  )
  assert.deepEqual(plain(h.calls.graphql[2].request.variables), {
    id: calculatedOrderGid,
    lineItemId: lineGid,
    quantity: 1,
    restock: false,
  })
  assert.deepEqual(plain(h.calls.graphql[3].request.variables), {
    id: calculatedOrderGid,
    notifyCustomer: false,
    staffNote: 'ClawPilot warehouse quantity test',
  })
}

// Missing staged financial proof and a staged increase both stop the workflow
// before orderEditCommit. Since orderEditBegin was accepted, each result is
// terminal outcomeUnknown and must never be retried.
for (const testCase of [
  {
    response: stagedQuantityResponse({
      calculatedOrder: { totalOutstandingSet: null },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
  },
  {
    response: stagedQuantityResponse({
      calculatedOrder: {
        totalPriceSet: {
          shopMoney: { amount: '150.01', currencyCode: 'USD' },
        },
        totalOutstandingSet: {
          shopMoney: { amount: '150.01', currencyCode: 'USD' },
        },
      },
    }),
    code: 'SHOPIFY_ORDER_EDIT_FINANCIAL_INCOHERENT',
  },
]) {
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderEditBegin',
      response: {
        orderEditBegin: {
          calculatedOrder: { id: calculatedOrderGid },
          orderEditSession: { id: orderEditSessionGid },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderEditSetQuantity',
      response: testCase.response,
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'set_line_quantity',
      lineItemGid: lineGid,
      quantity: 1,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, false)
  assert.equal(result.providerWrites, null)
  assert.equal(result.errorCode, testCase.code)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderEditBegin',
      'ClawPilotShopifyOrderEditSetQuantity',
    ],
  )
}

// A committed edit with a mismatched financial readback is not reported as a
// success. All three writes are known, but the outcome remains unknown and is
// never retried.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderEditBegin',
      response: {
        orderEditBegin: {
          calculatedOrder: { id: calculatedOrderGid },
          orderEditSession: { id: orderEditSessionGid },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderEditSetQuantity',
      response: stagedQuantityResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderEditCommit',
      response: {
        orderEditCommit: {
          order: { id: orderGid, name: '#6600', updatedAt: afterUpdatedAt },
          successMessages: ['Order edited'],
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({
        updatedAt: afterUpdatedAt,
        currentTotalPriceSet: {
          shopMoney: { amount: '51.00', currencyCode: 'USD' },
        },
        totalOutstandingSet: {
          shopMoney: { amount: '50.00', currencyCode: 'USD' },
        },
        line: { currentQuantity: 1, unfulfilledQuantity: 1 },
      })),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'set_line_quantity',
      lineItemGid: lineGid,
      quantity: 1,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 3)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_EDIT_READBACK_MISMATCH')
  assert.equal(h.calls.graphql.length, 5)
}

// Increasing or preserving a quantity is blocked before orderEditBegin.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'set_line_quantity',
        lineItemGid: lineGid,
        quantity: 3,
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_EDIT_NOT_ELIGIBLE',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A later-stage explicit rejection still leaves an accepted edit session, so
// the whole workflow is terminal outcomeUnknown and no commit/retry occurs.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderEditBegin',
      response: {
        orderEditBegin: {
          calculatedOrder: { id: calculatedOrderGid },
          orderEditSession: { id: orderEditSessionGid },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderEditSetQuantity',
      response: {
        orderEditSetQuantity: {
          calculatedOrder: null,
          calculatedLineItem: null,
          userErrors: [{ field: ['quantity'], message: 'Quantity rejected' }],
        },
      },
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'set_line_quantity',
      lineItemGid: lineGid,
      quantity: 0,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 1)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_EDIT_QUANTITY_REJECTED')
  assert.equal(h.calls.graphql.length, 3)
}

// Token scope, live installation scope, canonical shop identity, and fresh
// order identity are all checked before mutation.
{
  const h = harness([], {
    tokenScopes: ['write_orders'],
    probeScopes: ['read_orders'],
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({ type: 'add_tag', tag: 'clawpilot-managed' }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_SCOPE_MISSING',
  )
  assert.equal(h.calls.graphql.length, 0)
}

{
  const h = harness([], { shopId: 'gid://shopify/Shop/123456789' })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({ type: 'add_tag', tag: 'clawpilot-managed' }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_SHOP_MISMATCH',
  )
  assert.equal(h.calls.graphql.length, 0)
}

{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input(
        { type: 'add_tag', tag: 'clawpilot-managed' },
        { expected: expected({ updatedAt: '2026-08-13T13:59:59Z' }) },
      ),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_ORDER_STALE',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A response mismatch after tagsAdd may have mutated Shopify and must never be
// converted into a retryable zero-write failure.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderTagAdd',
      response: {
        tagsAdd: {
          node: {
            id: 'gid://shopify/Order/6600000999',
            name: '#6600',
            updatedAt: afterUpdatedAt,
            tags: ['warehouse-test', 'clawpilot-managed'],
          },
          userErrors: [],
        },
      },
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'add_tag', tag: 'clawpilot-managed' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, false)
  assert.equal(result.providerWrites, null)
  assert.equal(h.calls.graphql.length, 2)
}

console.log('Shopify order-management adapter tests passed')
