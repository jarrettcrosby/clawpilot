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
const fulfillmentGid = 'gid://shopify/Fulfillment/6600000010'
const fulfillmentOrderGid = 'gid://shopify/FulfillmentOrder/6600000020'
const fulfillmentLocationGid = 'gid://shopify/Location/6600000040'
const fulfillmentUpdatedAt = '2026-08-13T13:30:00.000Z'
const authorizationTransactionGid = 'gid://shopify/OrderTransaction/6600000050'
const voidTransactionGid = 'gid://shopify/OrderTransaction/6600000051'
const predecessorAuthorizationGlobalId = 'gsom0123456789ab'
const fulfillmentScopes = [
  'write_orders',
  'write_merchant_managed_fulfillment_orders',
]

function providerShippingAddress(overrides = {}) {
  return {
    firstName: 'Pat',
    lastName: 'Buyer',
    company: 'Buyer Bakery',
    address1: '100 Test Avenue',
    address2: null,
    city: 'Raleigh',
    provinceCode: 'NC',
    countryCodeV2: 'US',
    zip: '27601',
    phone: '+15555550100',
    ...overrides,
  }
}

function shippingAddressInput(overrides = {}) {
  return {
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
    ...overrides,
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function providerFulfillment(overrides = {}) {
  return {
    id: fulfillmentGid,
    name: '#6600.1',
    status: 'SUCCESS',
    displayStatus: 'FULFILLED',
    createdAt: '2026-08-13T13:15:00Z',
    updatedAt: fulfillmentUpdatedAt,
    deliveredAt: null,
    totalQuantity: 3,
    trackingInfo: [{
      company: 'UPS',
      number: '1ZTEST6600',
      url: 'https://www.ups.com/track?loc=en_US&tracknum=1ZTEST6600',
    }],
    fulfillmentOrders: {
      nodes: [{
        id: fulfillmentOrderGid,
        assignedLocation: {
          location: {
            id: fulfillmentLocationGid,
            name: 'Warehouse Test',
          },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  }
}

function reversedProviderFulfillment(overrides = {}) {
  return providerFulfillment({
    status: 'CANCELLED',
    displayStatus: 'CANCELED',
    updatedAt: afterUpdatedAt,
    fulfillmentOrders: undefined,
    ...overrides,
  })
}

function providerTransaction(overrides = {}) {
  return {
    id: authorizationTransactionGid,
    kind: 'AUTHORIZATION',
    status: 'SUCCESS',
    test: true,
    manuallyCapturable: true,
    amountSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    totalUnsettledSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    ...overrides,
  }
}

function providerOrder(overrides = {}) {
  const lineOverrides = overrides.line || {}
  const orderOverrides = { ...overrides }
  delete orderOverrides.line
  const transactions = orderOverrides.transactions || []
  const transactionsCount = Object.prototype.hasOwnProperty.call(
    orderOverrides,
    'transactionsCount',
  )
    ? orderOverrides.transactionsCount
    : { count: transactions.length, precision: 'EXACT' }
  delete orderOverrides.transactions
  delete orderOverrides.transactionsCount
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
    totalReceivedSet: {
      shopMoney: { amount: '0.00', currencyCode: 'USD' },
    },
    totalRefundedSet: {
      shopMoney: { amount: '0.00', currencyCode: 'USD' },
    },
    totalCapturableSet: {
      shopMoney: { amount: '0.00', currencyCode: 'USD' },
    },
    transactionsCount,
    transactions,
    email: 'buyer@example.com',
    phone: '+15555550100',
    poNumber: 'PO-6600',
    note: null,
    shippingAddress: providerShippingAddress(),
    tags: ['warehouse-test'],
    fulfillments: [],
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

function authorizedProviderOrder(overrides = {}) {
  const transactionOverrides = overrides.transaction || {}
  const orderOverrides = { ...overrides }
  delete orderOverrides.transaction
  return providerOrder({
    capturable: true,
    totalCapturableSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    transactions: [providerTransaction(transactionOverrides)],
    ...orderOverrides,
  })
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
    ...(['cancel', 'cancel_order_after_fulfillment_reversal']
      .includes(action.type)
      ? { cancellationPaymentEvidenceMatches: () => true }
      : {}),
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

function previewResponseWithExact(
  order,
  exactFulfillment = order.fulfillments.find(({ id }) => id === fulfillmentGid),
) {
  assert.ok(exactFulfillment, 'An exact fulfillment fixture is required')
  return {
    ...previewResponse(order),
    exactFulfillment: {
      ...exactFulfillment,
      order: { id: order.id },
    },
  }
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
  'shopify-graphql-2026-07-order-management-v4',
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
  assert.deepEqual(plain(preview.shippingAddress), shippingAddressInput())
  assert.deepEqual(plain(preview.currentTotalPrice), {
    amount: '150.00',
    currencyCode: 'USD',
  })
  const request = h.calls.graphql[0].request
  assert.match(request.query, /shop \{ currencyCode \}/)
  assert.match(request.query, /currentTotalPriceSet/)
  assert.match(request.query, /totalOutstandingSet/)
  assert.match(request.query, /totalReceivedSet/)
  assert.match(request.query, /totalRefundedSet/)
  assert.match(request.query, /totalCapturableSet/)
  assert.match(request.query, /transactionsCount \{ count precision \}/)
  assert.match(request.query, /transactions\(first: 25\)/)
  assert.match(request.query, /manuallyCapturable/)
  assert.match(request.query, /totalUnsettledSet/)
  assert.match(request.query, /lineItems\(first: 250\)/)
  assert.match(request.query, /\btest\b/)
  assert.match(request.query, /\bunpaid\b/)
  assert.match(request.query, /\breturnStatus\b/)
  assert.match(request.query, /shippingAddress \{/)
  assert.match(request.query, /countryCodeV2/)
  assert.match(request.query, /fulfillments\(first: 10\)/)
  assert.match(request.query, /trackingInfo\(first: 10\)/)
  assert.match(request.query, /fulfillmentOrders\(first: 10\)/)
  assert.match(request.query, /@include\(if: \$includeFulfillmentOwnership\)/)
  assert.doesNotMatch(request.query, /\bservice\s*\{/)
  assert.match(request.query, /assignedLocation \{/)
  assert.equal(
    (request.query.match(/fulfillmentOrders\(first: 10\)/g) || []).length,
    1,
  )
  assert.ok(
    request.query.indexOf('fulfillmentOrders(first: 10)')
      < request.query.indexOf('order(id: $id)'),
    'fulfillment ownership must exist only on the exact target node',
  )
  assert.deepEqual(plain(request.variables), {
    id: orderGid,
    fulfillmentId: orderGid,
    includeExactFulfillment: false,
    includeFulfillmentOwnership: false,
  })
}

// Transaction evidence must be both bounded and exhaustive. A count beyond the
// 25-row projection, an inexact count, or a count/list mismatch is retained as
// incomplete evidence so unrelated additive actions remain available, while
// the shared destructive cancellation gate fails closed.
for (const paymentEvidence of [
  {
    transactions: Array.from({ length: 25 }, (_, index) => providerTransaction({
      id: `gid://shopify/OrderTransaction/${6600000100 + index}`,
      status: 'FAILURE',
      manuallyCapturable: false,
      totalUnsettledSet: null,
    })),
    transactionsCount: { count: 26, precision: 'EXACT' },
  },
  {
    transactions: [],
    transactionsCount: { count: 0, precision: 'AT_LEAST' },
  },
  {
    transactions: [],
    transactionsCount: { count: 1, precision: 'EXACT' },
  },
  {
    transactions: [],
    transactionsCount: null,
  },
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder(paymentEvidence)),
  }])
  const preview = await adapter.readShopifyOrderManagementPreview(
    { shopDomain, accessToken: 'short-lived-access-token' },
    orderGid,
    {},
    h.dependencies,
  )
  assert.equal(preview.paymentEvidenceComplete, false)
  assert.deepEqual(
    plain(adapter.shopifyOrderCancellationPaymentEligibility(preview)),
    {
      allowed: false,
      reason: 'Shopify payment transaction evidence is not bounded and exhaustive',
      releasesAuthorization: false,
    },
  )
  assert.equal(h.calls.graphql.length, 1)
}

// The destructive payment gate is pinned to the 2026-07 enum contract. An
// enum-shaped value outside that contract cannot be treated as terminal or
// otherwise safe.
for (const transaction of [
  providerTransaction({ kind: 'PROCESSING' }),
  providerTransaction({ status: 'PROCESSING' }),
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({ transactions: [transaction] })),
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

// Fulfillment evidence is an exact, bounded provider projection. Ownership is
// omitted from ordinary reads and requested only for fulfillment reversal.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [providerFulfillment({ fulfillmentOrders: undefined })],
      line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
    })),
  }])
  const preview = await adapter.readShopifyOrderManagementPreview(
    { shopDomain, accessToken: 'short-lived-access-token' },
    orderGid,
    {},
    h.dependencies,
  )
  assert.deepEqual(plain(preview.fulfillments), [{
    id: fulfillmentGid,
    name: '#6600.1',
    status: 'SUCCESS',
    displayStatus: 'FULFILLED',
    createdAt: '2026-08-13T13:15:00.000Z',
    updatedAt: fulfillmentUpdatedAt,
    deliveredAt: null,
    totalQuantity: 3,
    tracking: [{
      company: 'UPS',
      number: '1ZTEST6600',
      url: 'https://www.ups.com/track?loc=en_US&tracknum=1ZTEST6600',
    }],
    fulfillmentOrders: [],
  }])
  assert.equal(
    h.calls.graphql[0].request.variables.includeFulfillmentOwnership,
    false,
  )
}

// Tracking and fulfillment-order ownership evidence fail closed rather than
// silently truncating a mutation target's source facts.
for (const fulfillment of [
  providerFulfillment({
    trackingInfo: Array.from({ length: 11 }, (_, index) => ({
      company: 'UPS',
      number: `1ZTEST${index}`,
      url: null,
    })),
  }),
  providerFulfillment({
    fulfillmentOrders: {
      nodes: providerFulfillment().fulfillmentOrders.nodes,
      pageInfo: { hasNextPage: true },
    },
  }),
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(providerOrder({ fulfillments: [fulfillment] })),
  }])
  await assert.rejects(
    adapter.readShopifyOrderManagementPreview(
      { shopDomain, accessToken: 'short-lived-access-token' },
      orderGid,
      {},
      h.dependencies,
    ),
    (error) => [
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'SHOPIFY_ORDER_MANAGEMENT_FULFILLMENT_TOO_LARGE',
    ].includes(error.code),
  )
}

// Unknown-outcome reconciliation binds the complete source address inside the
// hash-only desired projection. Changing only address line 1 must change the
// projection without retaining the plaintext address in durable evidence.
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
  const unchangedHash = adapter.requestedShopifyOrderSaveProjectionHash(
    preview,
    {
      type: 'save_order',
      email: preview.email,
      phone: preview.phone,
      poNumber: preview.poNumber,
      note: preview.note,
      shippingAddress: shippingAddressInput(),
      tagAdds: [],
      tagRemoves: [],
      lineQuantities: [],
    },
  )
  const changedAddressHash = adapter.requestedShopifyOrderSaveProjectionHash(
    preview,
    {
      type: 'save_order',
      email: preview.email,
      phone: preview.phone,
      poNumber: preview.poNumber,
      note: preview.note,
      shippingAddress: shippingAddressInput({
        address1: '500 Reconciliation Lane',
      }),
      tagAdds: [],
      tagRemoves: [],
      lineQuantities: [],
    },
  )
  assert.equal(
    unchangedHash,
    adapter.shopifyOrderManagementProjectionHash(preview),
  )
  assert.notEqual(changedAddressHash, unchangedHash)
  assert.match(changedAddressHash, /^[a-f0-9]{64}$/)
  assert.equal(changedAddressHash.includes('Reconciliation Lane'), false)
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

// Currency, received/capturable totals, and transaction shapes are mandatory
// preview fields. Bad provider shapes fail closed before a mutation is considered.
for (const response of [
  { shop: {}, order: providerOrder() },
  previewResponse(providerOrder(), 'usd'),
  previewResponse(providerOrder({ currencyCode: undefined })),
  previewResponse(providerOrder({ currencyCode: 'US' })),
  previewResponse(providerOrder({ totalReceivedSet: null })),
  previewResponse(providerOrder({ totalCapturableSet: null })),
  previewResponse({ ...providerOrder(), transactions: null }),
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
  const truncatedTransactions = Array.from(
    { length: 25 },
    (_, index) => providerTransaction({
      id: `gid://shopify/OrderTransaction/${6600000200 + index}`,
      status: 'FAILURE',
      manuallyCapturable: false,
      totalUnsettledSet: null,
    }),
  )
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(providerOrder({
        test: false,
        transactions: truncatedTransactions,
        transactionsCount: { count: 26, precision: 'EXACT' },
      })),
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
        transactions: truncatedTransactions,
        transactionsCount: { count: 26, precision: 'EXACT' },
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
  assert.equal(result.after.paymentEvidenceComplete, false)
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
          email: 'buyer@example.com',
          phone: '+15555550100',
          poNumber: 'PO-6600',
          note: 'Warehouse test note',
          shippingAddress: providerShippingAddress({
            address1: '200 Updated Avenue',
          }),
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
      shippingAddress: shippingAddressInput({
        address1: '200 Updated Avenue',
      }),
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
      shippingAddress: shippingAddressInput({
        address1: '200 Updated Avenue',
      }),
      tags: ['warehouse-test'],
    },
  })
}

// One exact test-order fulfillment can be reversed. The action is bound to the
// live fulfillment timestamp, performs only fulfillmentCancel, and requires an
// exact cancelled readback without chaining order cancellation or refunding.
{
  const before = providerOrder({
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [providerFulfillment()],
    line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
  })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    fulfillments: [providerFulfillment({
      status: 'CANCELLED',
      displayStatus: 'CANCELED',
      updatedAt: afterUpdatedAt,
    })],
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before),
    },
    {
      operation: 'ClawPilotShopifyTestFulfillmentCancel',
      response: {
        fulfillmentCancel: {
          fulfillment: { id: fulfillmentGid, status: 'CANCELLED' },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(after),
    },
  ], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReads, 3)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 1)
  assert.equal(result.providerReference, fulfillmentGid)
  assert.deepEqual(plain(result.result), {
    fulfillmentGid,
    status: 'CANCELLED',
  })
  assert.equal(result.after.fulfillments[0].status, 'CANCELLED')
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyTestFulfillmentCancel',
      'ClawPilotShopifyOrderManagementPreview',
    ],
  )
  const mutation = h.calls.graphql[1].request
  assert.deepEqual(plain(mutation.variables), { id: fulfillmentGid })
  assert.match(mutation.query, /fulfillmentCancel\(id: \$id\)/)
  assert.doesNotMatch(mutation.query, /\borderCancel\b|\brefund/i)
  for (const previewCall of [h.calls.graphql[0], h.calls.graphql[2]]) {
    assert.deepEqual(plain(previewCall.request.variables), {
      id: orderGid,
      fulfillmentId: fulfillmentGid,
      includeExactFulfillment: true,
      includeFulfillmentOwnership: true,
    })
  }
}

// The exact live fulfillment timestamp and test-order boundary are checked
// immediately before dispatch, after the scoped provider preview.
for (const testCase of [
  {
    order: providerOrder({
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [providerFulfillment()],
      line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
    }),
    expectedFulfillmentUpdatedAt: '2026-08-13T13:29:59Z',
    code: 'SHOPIFY_FULFILLMENT_STALE',
  },
  {
    order: providerOrder({
      test: false,
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [providerFulfillment()],
      line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
    }),
    expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    code: 'SHOPIFY_ORDER_MANAGEMENT_TEST_ORDER_REQUIRED',
  },
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponseWithExact(testCase.order),
  }], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel_fulfillment',
        fulfillmentGid,
        expectedFulfillmentUpdatedAt: testCase.expectedFulfillmentUpdatedAt,
      }),
      h.dependencies,
    ),
    (error) => error.code === testCase.code,
  )
  assert.equal(h.calls.graphql.length, 1)
}

// Delivered, cancelled, non-successful, zero-quantity, or source-ambiguous
// fulfillments stay out of this reversal slice and require a future return flow.
for (const fulfillment of [
  providerFulfillment({ status: 'CANCELLED', displayStatus: 'CANCELED' }),
  providerFulfillment({ status: 'PENDING' }),
  providerFulfillment({ displayStatus: 'IN_TRANSIT' }),
  providerFulfillment({ deliveredAt: '2026-08-13T13:45:00Z' }),
  providerFulfillment({ totalQuantity: 0 }),
  providerFulfillment({
    fulfillmentOrders: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
  }),
  providerFulfillment({
    fulfillmentOrders: {
      nodes: [{
        ...providerFulfillment().fulfillmentOrders.nodes[0],
        assignedLocation: { location: null },
      }],
      pageInfo: { hasNextPage: false },
    },
  }),
]) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponseWithExact(providerOrder({
      displayFulfillmentStatus: 'FULFILLED',
      fulfillments: [fulfillment],
      line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
    })),
  }], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel_fulfillment',
        fulfillmentGid,
        expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_FULFILLMENT_CANCEL_NOT_ELIGIBLE',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// A missing fulfillment-write scope is rejected before any provider order read.
{
  const h = harness([], {
    tokenScopes: ['write_orders'],
    probeScopes: ['write_orders'],
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel_fulfillment',
        fulfillmentGid,
        expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_SCOPE_MISSING',
  )
  assert.equal(h.calls.graphql.length, 0)
}

// A provider rejection proves zero writes. A transport ambiguity after dispatch
// and a failed final readback both remain terminal, non-retryable unknowns.
{
  const before = providerOrder({
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [providerFulfillment()],
    line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before),
    },
    {
      operation: 'ClawPilotShopifyTestFulfillmentCancel',
      response: {
        fulfillmentCancel: {
          fulfillment: null,
          userErrors: [{ field: ['id'], message: 'Cannot cancel fulfillment' }],
        },
      },
    },
  ], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.errorCode, 'SHOPIFY_FULFILLMENT_CANCEL_REJECTED')
}

{
  const before = providerOrder({
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [providerFulfillment()],
    line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before),
    },
    {
      operation: 'ClawPilotShopifyTestFulfillmentCancel',
      error: new Error('socket closed after fulfillment cancellation dispatch'),
    },
  ], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, false)
  assert.equal(result.providerWrites, null)
  assert.equal(h.calls.graphql.length, 2)
}

{
  const before = providerOrder({
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [providerFulfillment()],
    line: { unfulfilledQuantity: 0, nonFulfillableQuantity: 3 },
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before),
    },
    {
      operation: 'ClawPilotShopifyTestFulfillmentCancel',
      response: {
        fulfillmentCancel: {
          fulfillment: { id: fulfillmentGid, status: 'CANCELLED' },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before),
    },
  ], {
    tokenScopes: fulfillmentScopes,
    probeScopes: fulfillmentScopes,
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_fulfillment',
      fulfillmentGid,
      expectedFulfillmentUpdatedAt: fulfillmentUpdatedAt,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 1)
  assert.equal(
    result.errorCode,
    'SHOPIFY_FULFILLMENT_CANCEL_READBACK_MISMATCH',
  )
  assert.equal(h.calls.graphql.length, 3)
}

// Cancelling the order after a proven fulfillment reversal is a distinct
// Shopify write. It needs only order access, binds the exact cancelled
// fulfillment by ID, dispatches orderCancel alone, and performs an exact
// cancelled-order readback without requesting fulfillment ownership.
{
  const reversedFulfillment = reversedProviderFulfillment()
  const before = providerOrder({ fulfillments: [] })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    fulfillments: [],
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(before, reversedFulfillment),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(after, reversedFulfillment),
    },
  ], {
    tokenScopes: ['read_orders', 'write_orders'],
    probeScopes: ['read_orders', 'write_orders'],
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId,
      reversedFulfillmentGid: fulfillmentGid,
      reason: 'STAFF',
      staffNote: 'Cancel after exact fulfillment reversal',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerReads, 3)
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 1)
  assert.equal(result.providerReference, cancellationJobGid)
  assert.equal(result.after.cancelledAt, afterUpdatedAt)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderCancel',
      'ClawPilotShopifyOrderManagementPreview',
    ],
  )
  for (const previewCall of [h.calls.graphql[0], h.calls.graphql[2]]) {
    assert.deepEqual(plain(previewCall.request.variables), {
      id: orderGid,
      fulfillmentId: fulfillmentGid,
      includeExactFulfillment: true,
      includeFulfillmentOwnership: false,
    })
    assert.match(previewCall.request.query, /exactFulfillment: node/)
  }
  const mutation = h.calls.graphql[1].request
  assert.match(mutation.query, /\borderCancel\s*\(/)
  assert.doesNotMatch(
    mutation.query,
    /\bfulfillmentCancel\s*\(|\brefundCreate\s*\(|\brefund\s*\(/,
  )
  assert.deepEqual(plain(mutation.variables), {
    orderId: orderGid,
    notifyCustomer: false,
    refundMethod: null,
    restock: false,
    reason: 'STAFF',
    staffNote: 'Cancel after exact fulfillment reversal',
  })
  assert.equal(
    JSON.stringify(h.calls.graphql).includes(predecessorAuthorizationGlobalId),
    false,
    'the local predecessor authorization must never be sent to Shopify',
  )
}

// The exact predecessor fulfillment must already be CANCELLED. A live exact
// node in any other state blocks the separate order-cancel mutation.
{
  const before = providerOrder({ fulfillments: [] })
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponseWithExact(
      before,
      reversedProviderFulfillment({ status: 'SUCCESS' }),
    ),
  }], {
    tokenScopes: ['read_orders', 'write_orders'],
    probeScopes: ['read_orders', 'write_orders'],
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel_order_after_fulfillment_reversal',
        predecessorAuthorizationGlobalId,
        reversedFulfillmentGid: fulfillmentGid,
      }),
      h.dependencies,
    ),
    (error) => (
      error.code === 'SHOPIFY_ORDER_POST_REVERSAL_CANCEL_NOT_ELIGIBLE'
    ),
  )
  assert.equal(h.calls.graphql.length, 1)
  assert.equal(
    h.calls.graphql[0].request.variables.fulfillmentId,
    fulfillmentGid,
  )
  assert.equal(
    h.calls.graphql[0].request.variables.includeFulfillmentOwnership,
    false,
  )
}

// Post-reversal order cancellation does not inherit the merchant-managed
// fulfillment-order scope. Missing write_orders still fails before any order
// read, while the successful path above intentionally omits the merchant scope.
{
  const h = harness([], {
    tokenScopes: ['read_orders'],
    probeScopes: ['read_orders'],
  })
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({
        type: 'cancel_order_after_fulfillment_reversal',
        predecessorAuthorizationGlobalId,
        reversedFulfillmentGid: fulfillmentGid,
      }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_MANAGEMENT_SCOPE_MISSING',
  )
  assert.equal(h.calls.graphql.length, 0)
}

// An explicit orderCancel rejection proves zero writes for the distinct action.
{
  const before = providerOrder({ fulfillments: [] })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(
        before,
        reversedProviderFulfillment(),
      ),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
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
  ], {
    tokenScopes: ['read_orders', 'write_orders'],
    probeScopes: ['read_orders', 'write_orders'],
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId,
      reversedFulfillmentGid: fulfillmentGid,
      reason: 'OTHER',
      staffNote: 'Expected post-reversal provider rejection',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.providerWritesKnown, true)
  assert.equal(result.providerWrites, 0)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_REJECTED')
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderCancel',
    ],
  )
}

// A transport failure after dispatch is terminal outcomeUnknown for the
// distinct action and is never converted into a retryable second attempt.
{
  const before = providerOrder({ fulfillments: [] })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponseWithExact(
        before,
        reversedProviderFulfillment(),
      ),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      error: new Error('socket closed after post-reversal order cancel'),
    },
  ], {
    tokenScopes: ['read_orders', 'write_orders'],
    probeScopes: ['read_orders', 'write_orders'],
  })
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId,
      reversedFulfillmentGid: fulfillmentGid,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.retryable, false)
  assert.equal(result.providerWritesKnown, false)
  assert.equal(result.providerWrites, null)
  assert.equal(h.calls.graphql.length, 2)
}

// The fresh pre-write authorization must match the durable preparation
// binding. A same-revision payment change fails before orderCancel.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(authorizedProviderOrder()),
  }])
  const {
    cancellationPaymentEvidenceMatches: omittedBinding,
    ...unboundInput
  } = input({ type: 'cancel' })
  assert.equal(typeof omittedBinding, 'function')
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      unboundInput,
      h.dependencies,
    ),
    (error) => (
      error.code === 'SHOPIFY_ORDER_CANCEL_PAYMENT_EVIDENCE_BINDING_REQUIRED'
    ),
  )
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    ['ClawPilotShopifyOrderManagementPreview'],
  )
}

{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(authorizedProviderOrder()),
  }])
  let observedEvidence = null
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction({
      ...input({ type: 'cancel' }),
      cancellationPaymentEvidenceMatches(evidence) {
        observedEvidence = plain(evidence)
        return false
      },
    }, h.dependencies),
    (error) => (
      error.code === 'SHOPIFY_ORDER_CANCEL_PAYMENT_EVIDENCE_CHANGED'
    ),
  )
  assert.deepEqual(observedEvidence, {
    schema: 'shopify-order-cancel-payment-evidence-v2',
    transactionsCount: 1,
    transactionsHash:
      'f9f0b1774e7a079fa5c8f6bbc8eb3b67566ed38932471151432877e44c1d26b9',
    totalReceived: { amount: '0.00', currencyCode: 'USD' },
    totalRefunded: { amount: '0.00', currencyCode: 'USD' },
    totalCapturable: { amount: '150.00', currencyCode: 'USD' },
    refundMethod: 'none',
  })
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    ['ClawPilotShopifyOrderManagementPreview'],
  )
}

// A PENDING order display status is eligible when the transaction itself is a
// bounded successful test AUTHORIZATION, no money was received, and the exact
// capturable balance matches. orderCancel is the only provider mutation and
// readback proves Shopify released the authorization. The boundary fixture
// leaves one row for Shopify's VOID evidence: 24 rows before, 25 after.
{
  const terminalTransactions = Array.from(
    { length: 23 },
    (_, index) => providerTransaction({
      id: `gid://shopify/OrderTransaction/${6600000300 + index}`,
      status: 'FAILURE',
      manuallyCapturable: false,
      totalUnsettledSet: null,
    }),
  )
  const before = authorizedProviderOrder({
    transactions: [providerTransaction(), ...terminalTransactions],
  })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    transactions: [
      providerTransaction({
        manuallyCapturable: false,
        totalUnsettledSet: null,
      }),
      ...terminalTransactions,
      providerTransaction({
        id: voidTransactionGid,
        kind: 'VOID',
        manuallyCapturable: false,
        totalUnsettledSet: null,
      }),
    ],
  })
  const paymentRead = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(before),
  }])
  const normalizedBefore = await adapter.readShopifyOrderManagementPreview(
    { shopDomain, accessToken: 'short-lived-access-token' },
    orderGid,
    {},
    paymentRead.dependencies,
  )
  assert.deepEqual(
    plain(adapter.shopifyOrderCancellationPaymentEligibility(
      normalizedBefore,
    )),
    { allowed: true, reason: null, releasesAuthorization: true },
  )
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'STAFF',
      staffNote: 'Release the fixture test authorization',
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerWrites, 1)
  assert.equal(result.providerReads, 3)
  assert.equal(result.after.cancelledAt, afterUpdatedAt)
  assert.equal(result.after.totalCapturable.amount, '0.00')
  assert.equal(result.before.transactionsCount, 24)
  assert.equal(result.after.transactionsCount, 25)
  assert.equal(result.after.transactions[0].totalUnsettled, null)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderCancel',
      'ClawPilotShopifyOrderManagementPreview',
    ],
  )
  assert.doesNotMatch(
    h.calls.graphql[1].request.query,
    /transactionVoid|transactionCapture|refundCreate/,
  )
}

// Shopify may replace a released authorization with a VOID row. Cancellation
// is proven from the bound financial aggregates plus the absence of any live
// authorization; it does not depend on Shopify retaining historical row IDs.
{
  const before = authorizedProviderOrder()
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    transactions: [providerTransaction({
      id: voidTransactionGid,
      kind: 'VOID',
      manuallyCapturable: false,
      totalUnsettledSet: null,
    })],
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'cancel' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.errorCode, null)
  assert.equal(result.providerWrites, 1)
  assert.deepEqual(
    h.calls.graphql.map((call) => call.request.operationName),
    [
      'ClawPilotShopifyOrderManagementPreview',
      'ClawPilotShopifyOrderCancel',
      'ClawPilotShopifyOrderManagementPreview',
    ],
  )
}

// Financial aggregates remain bound across dispatch. A changed received total
// cannot satisfy immediate readback even when every transaction is terminal.
{
  const before = authorizedProviderOrder()
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    totalReceivedSet: {
      shopMoney: { amount: '1.00', currencyCode: 'USD' },
    },
    transactions: [providerTransaction({
      amountSet: {
        shopMoney: { amount: '149.00', currencyCode: 'USD' },
      },
      manuallyCapturable: false,
      totalUnsettledSet: null,
    })],
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'cancel' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_READBACK_MISMATCH')
  assert.equal(result.providerWrites, 1)
  assert.equal(h.calls.graphql.length, 3)
}

// Historical transaction evidence may not regress after dispatch. Keeping the
// original authorization inert is insufficient when the exact count shrinks.
{
  const historicalFailure = providerTransaction({
    id: 'gid://shopify/OrderTransaction/6600000550',
    status: 'FAILURE',
    manuallyCapturable: false,
    totalUnsettledSet: null,
  })
  const before = authorizedProviderOrder({
    transactions: [providerTransaction(), historicalFailure],
  })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    transactions: [providerTransaction({
      manuallyCapturable: false,
      totalUnsettledSet: null,
    })],
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'cancel' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_READBACK_MISMATCH')
  assert.equal(result.providerWrites, 1)
  assert.equal(result.before.transactionsCount, 2)
  assert.equal(result.after, null)
  assert.equal(h.calls.graphql.length, 3)
}

// A 25-row pre-write projection cannot safely prove the additional VOID row
// after orderCancel. Reserve that readback capacity and block before mutation.
{
  const terminalTransactions = Array.from(
    { length: 24 },
    (_, index) => providerTransaction({
      id: `gid://shopify/OrderTransaction/${6600000400 + index}`,
      status: 'FAILURE',
      manuallyCapturable: false,
      totalUnsettledSet: null,
    }),
  )
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(authorizedProviderOrder({
      transactions: [providerTransaction(), ...terminalTransactions],
    })),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({ type: 'cancel' }),
      h.dependencies,
    ),
    (error) => (
      error.code === 'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE'
      && /no bounded room/i.test(error.message)
    ),
  )
  assert.equal(h.calls.graphql.length, 1)
}

// Payment transaction PENDING/AWAITING/UNKNOWN is not the same as the order's
// display status and blocks before orderCancel. Captured money remains blocked.
for (const status of ['PENDING', 'AWAITING_RESPONSE', 'UNKNOWN']) {
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(authorizedProviderOrder({
      transaction: { status },
    })),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({ type: 'cancel' }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// Even with matching aggregates, a second transaction that still presents as
// live means the payment evidence is not one exact capturable authorization.
{
  const h = harness([{
    operation: 'ClawPilotShopifyOrderManagementPreview',
    response: previewResponse(authorizedProviderOrder({
      transactions: [
        providerTransaction(),
        providerTransaction({
          id: 'gid://shopify/OrderTransaction/6600000500',
          status: 'FAILURE',
          amountSet: {
            shopMoney: { amount: '1.00', currencyCode: 'USD' },
          },
          totalUnsettledSet: {
            shopMoney: { amount: '1.00', currencyCode: 'USD' },
          },
        }),
      ],
    })),
  }])
  await assert.rejects(
    adapter.executeShopifyOrderManagementAction(
      input({ type: 'cancel' }),
      h.dependencies,
    ),
    (error) => error.code === 'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
  )
  assert.equal(h.calls.graphql.length, 1)
}

// An ordinary paid order may be cancelled without a refund when the operator
// makes that choice explicitly. Readback proves the paid/refunded aggregates
// did not change, and Shopify receives the exact restock/notification choices.
{
  const capturedTransaction = providerTransaction({
    kind: 'CAPTURE',
    test: false,
    manuallyCapturable: false,
    totalUnsettledSet: null,
  })
  const before = providerOrder({
    test: false,
    unpaid: false,
    totalReceivedSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    transactions: [capturedTransaction],
  })
  const after = providerOrder({
    ...before,
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'CUSTOMER',
      staffNote: 'Customer requested cancellation',
      refundMethod: 'none',
      restock: true,
      notifyCustomer: false,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.before.test, false)
  assert.equal(result.providerWrites, 1)
  assert.deepEqual(plain(h.calls.graphql[1].request.variables), {
    orderId: orderGid,
    notifyCustomer: false,
    refundMethod: null,
    restock: true,
    reason: 'CUSTOMER',
    staffNote: 'Customer requested cancellation',
  })
}

// An ordinary paid order may instead request a full refund to the original
// payment methods. Shopify receives that explicit choice and readback must
// prove the previously received amount is now refunded.
{
  const capturedTransaction = providerTransaction({
    kind: 'SALE',
    test: false,
    manuallyCapturable: false,
    totalUnsettledSet: null,
  })
  const before = providerOrder({
    test: false,
    unpaid: false,
    totalReceivedSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
    transactions: [capturedTransaction],
  })
  const after = providerOrder({
    ...before,
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
    totalRefundedSet: {
      shopMoney: { amount: '150.00', currencyCode: 'USD' },
    },
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'cancel',
      reason: 'INVENTORY',
      staffNote: 'Inventory unavailable before warehouse release',
      refundMethod: 'original_payment_methods',
      restock: false,
      notifyCustomer: true,
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.before.test, false)
  assert.equal(result.providerWrites, 1)
  assert.equal(result.after.totalRefunded.amount, '150.00')
  assert.deepEqual(plain(h.calls.graphql[1].request.variables), {
    orderId: orderGid,
    notifyCustomer: true,
    refundMethod: { originalPaymentMethodsRefund: true },
    restock: false,
    reason: 'INVENTORY',
    staffNote: 'Inventory unavailable before warehouse release',
  })
}

// If a completed job readback still exposes a capturable authorization, the
// accepted write is outcomeUnknown and must be reconciled rather than resent.
{
  const before = authorizedProviderOrder()
  const after = authorizedProviderOrder({
    updatedAt: afterUpdatedAt,
    cancelledAt: afterUpdatedAt,
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
      response: {
        orderCancel: {
          job: { id: cancellationJobGid, done: true },
          orderCancelUserErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({ type: 'cancel' }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'outcomeUnknown')
  assert.equal(result.providerWrites, 1)
  assert.equal(result.retryable, false)
  assert.equal(result.errorCode, 'SHOPIFY_ORDER_CANCEL_READBACK_MISMATCH')
  assert.equal(h.calls.graphql.length, 3)
}

// An accepted asynchronous cancellation job for the authorized test order
// stays unknown and is never converted into permission to resend the mutation.
{
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(authorizedProviderOrder()),
    },
    {
      operation: 'ClawPilotShopifyOrderCancel',
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
    refundMethod: null,
    restock: false,
    reason: 'STAFF',
    staffNote: 'ClawPilot warehouse test cancellation',
  })
  assert.equal(h.calls.graphql.length, 2)
}

// An ordinary order with fulfillment or return activity is blocked before any
// mutation regardless of its payment or test flag. One representative carries
// every unsafe order-state signal to keep the focused test compact.
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
    (error) => error.code === 'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
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
      operation: 'ClawPilotShopifyOrderCancel',
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
      operation: 'ClawPilotShopifyOrderCancel',
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

// An address-only Save uses the same orderUpdate and exact final readback. It
// uses the non-deprecated MailingAddressInput code fields and no edit session.
{
  const desiredAddress = shippingAddressInput({
    address1: '700 Address Only Road',
    city: 'Cary',
    zip: '27513',
  })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    shippingAddress: providerShippingAddress({
      address1: desiredAddress.address1,
      city: desiredAddress.city,
      zip: desiredAddress.zip,
    }),
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(),
    },
    {
      operation: 'ClawPilotShopifyOrderMetadataUpdate',
      response: {
        orderUpdate: {
          order: {
            id: orderGid,
            name: '#6600',
            updatedAt: afterUpdatedAt,
            email: 'buyer@example.com',
            phone: '+15555550100',
            poNumber: 'PO-6600',
            note: null,
            shippingAddress: after.shippingAddress,
            tags: ['warehouse-test'],
          },
          userErrors: [],
        },
      },
    },
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'save_order',
      email: 'buyer@example.com',
      phone: '+15555550100',
      poNumber: 'PO-6600',
      note: null,
      shippingAddress: desiredAddress,
      tagAdds: [],
      tagRemoves: [],
      lineQuantities: [],
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerWrites, 1)
  assert.deepEqual(h.calls.graphql.map(
    (call) => call.request.operationName,
  ), [
    'ClawPilotShopifyOrderManagementPreview',
    'ClawPilotShopifyOrderMetadataUpdate',
    'ClawPilotShopifyOrderManagementPreview',
  ])
  assert.deepEqual(
    plain(h.calls.graphql[1].request.variables.input.shippingAddress),
    desiredAddress,
  )
  assert.equal(
    'country' in h.calls.graphql[1].request.variables.input.shippingAddress,
    false,
    'the address write must use countryCode, not Shopify deprecated country',
  )
  assert.equal(
    'province' in h.calls.graphql[1].request.variables.input.shippingAddress,
    false,
    'the address write must use provinceCode, not Shopify deprecated province',
  )
}

// One ordinary Save can update contact/order metadata, source address, exact
// tag deltas, and multiple eligible line decreases. Quantities share one
// Shopify order-edit session and the commit hardcodes notifyCustomer=false.
{
  const secondLineGid = 'gid://shopify/LineItem/6600000002'
  const before = providerOrder({
    lineItems: {
      nodes: [
        providerOrder().lineItems.nodes[0],
        {
          id: secondLineGid,
          name: 'Second test line',
          sku: 'SECOND',
          currentQuantity: 2,
          unfulfilledQuantity: 2,
          nonFulfillableQuantity: 0,
          merchantEditable: true,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  })
  const after = providerOrder({
    updatedAt: afterUpdatedAt,
    email: 'receiving@example.com',
    phone: '+15555550199',
    poNumber: 'PO-UPDATED',
    note: 'Handle together',
    shippingAddress: providerShippingAddress({
      company: 'Receiving Bakery',
      address1: '500 Receiving Lane',
      address2: 'Dock 4',
      city: 'Durham',
      zip: '27701',
      phone: '+15555550199',
    }),
    tags: ['priority'],
    currentTotalPriceSet: {
      shopMoney: { amount: '75.00', currencyCode: 'USD' },
    },
    totalOutstandingSet: {
      shopMoney: { amount: '75.00', currencyCode: 'USD' },
    },
    lineItems: {
      nodes: [
        {
          ...providerOrder().lineItems.nodes[0],
          currentQuantity: 1,
          unfulfilledQuantity: 1,
        },
        {
          id: secondLineGid,
          name: 'Second test line',
          sku: 'SECOND',
          currentQuantity: 1,
          unfulfilledQuantity: 1,
          nonFulfillableQuantity: 0,
          merchantEditable: true,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
  })
  const h = harness([
    {
      operation: 'ClawPilotShopifyOrderManagementPreview',
      response: previewResponse(before),
    },
    {
      operation: 'ClawPilotShopifyOrderMetadataUpdate',
      response: {
        orderUpdate: {
          order: {
            id: orderGid,
            name: '#6600',
            updatedAt: afterUpdatedAt,
            email: 'receiving@example.com',
            phone: '+15555550199',
            poNumber: 'PO-UPDATED',
            note: 'Handle together',
            shippingAddress: providerShippingAddress({
              company: 'Receiving Bakery',
              address1: '500 Receiving Lane',
              address2: 'Dock 4',
              city: 'Durham',
              zip: '27701',
              phone: '+15555550199',
            }),
            tags: ['priority'],
          },
          userErrors: [],
        },
      },
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
      operation: 'ClawPilotShopifyOrderEditSetQuantity',
      response: stagedQuantityResponse({
        calculatedLineItem: { quantity: 1 },
      }),
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
      response: previewResponse(after),
    },
  ])
  const result = await adapter.executeShopifyOrderManagementAction(
    input({
      type: 'save_order',
      email: 'receiving@example.com',
      phone: '+15555550199',
      poNumber: 'PO-UPDATED',
      note: 'Handle together',
      shippingAddress: shippingAddressInput({
        company: 'Receiving Bakery',
        address1: '500 Receiving Lane',
        address2: 'Dock 4',
        city: 'Durham',
        zip: '27701',
        phone: '+15555550199',
      }),
      tagAdds: ['priority'],
      tagRemoves: ['warehouse-test'],
      lineQuantities: [
        { lineItemGid: lineGid, quantity: 1 },
        { lineItemGid: secondLineGid, quantity: 1 },
      ],
    }),
    h.dependencies,
  )
  assert.equal(result.outcome, 'succeeded')
  assert.equal(result.providerWrites, 5)
  assert.equal(result.providerReads, 3)
  assert.equal(result.result.changedLineCount, 2)
  assert.deepEqual(
    plain(h.calls.graphql[1].request.variables.input),
    {
      id: orderGid,
      email: 'receiving@example.com',
      phone: '+15555550199',
      poNumber: 'PO-UPDATED',
      note: 'Handle together',
      shippingAddress: shippingAddressInput({
        company: 'Receiving Bakery',
        address1: '500 Receiving Lane',
        address2: 'Dock 4',
        city: 'Durham',
        zip: '27701',
        phone: '+15555550199',
      }),
      tags: ['priority'],
    },
  )
  assert.equal(h.calls.graphql[5].request.variables.notifyCustomer, false)
  assert.equal(
    h.calls.graphql.filter((call) => (
      call.request.operationName === 'ClawPilotShopifyOrderEditBegin'
    )).length,
    1,
  )
}

console.log('Shopify order-management adapter tests passed')
