import { createHash } from 'node:crypto'
import {
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN,
  SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'
import {
  assertShopifyReversalFixtureOrderClaimCurrentInPostgres,
} from '@/lib/persistence/shopifyReversalFixture'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/u
const SHOPIFY_LINE_ITEM_GID =
  /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/u
const SHOPIFY_ORDER_TRANSACTION_GID =
  /^gid:\/\/shopify\/OrderTransaction\/[1-9][0-9]{0,20}$/u
const SOURCE_IDENTIFIER =
  /^clawpilot-reversal-fixture:gsfc(?:[0-9]{7}|[0-9a-v]{12})$/u
const UNIQUE_TAG = /^clawpilot-reversal-[a-f0-9]{24}$/u
const ORDER_CREATE_ERROR_FIELD_TOKEN = /^[A-Za-z0-9_]{1,64}$/u
const ORDER_CREATE_ERROR_CODES = new Set([
  'FULFILLMENT_SERVICE_INVALID',
  'INVALID',
  'INVENTORY_CLAIM_FAILED',
  'PROCESSED_AT_INVALID',
  'REDUNDANT_CUSTOMER_FIELDS',
  'SHOP_DORMANT',
  'TAX_LINE_RATE_MISSING',
])

export const SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION =
  'shopify-reversal-fixture-v5' as const
export const SHOPIFY_REVERSAL_FIXTURE_BASE_TAG =
  'clawpilot-reversal-fixture' as const

export const SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE = Object.freeze({
  version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
  test: true as const,
  expectedFinancialStatus: 'PENDING' as const,
  currencyCode: 'USD' as const,
  unitPrice: '10.00' as const,
  taxable: false as const,
  transaction: Object.freeze({
    kind: 'AUTHORIZATION' as const,
    status: 'SUCCESS' as const,
    test: true as const,
    amount: '10.00' as const,
    currencyCode: 'USD' as const,
  }),
  marketingConsent: 'UNSET' as const,
  sendReceipt: false as const,
  sendFulfillmentReceipt: false as const,
  inventoryBehaviour: 'BYPASS' as const,
  variantId: SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
  quantity: 1 as const,
  requiresShipping: true as const,
  shippingAddress: Object.freeze({
    firstName: 'John',
    lastName: 'Doe',
    address1: '101 Academy Drive',
    city: 'Buzzards Bay',
    provinceCode: 'MA',
    countryCode: 'US',
    zip: '02532',
  }),
})

const ORDER_FIELDS = `
  id
  name
  test
  sourceIdentifier
  createdAt
  updatedAt
  currencyCode
  presentmentCurrencyCode
  totalPriceSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  capturable
  totalCapturableSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  displayFinancialStatus
  displayFulfillmentStatus
  tags
  lineItems(first: 2) {
    nodes {
      id
      quantity
      currentQuantity
      unfulfilledQuantity
      taxable
      requiresShipping
      variant { id }
      originalUnitPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { amount currencyCode }
      }
    }
    pageInfo { hasNextPage }
  }
  transactions(first: 10) {
    id
    kind
    status
    test
    amountSet {
      shopMoney { amount currencyCode }
      presentmentMoney { amount currencyCode }
    }
  }
`

const ORDER_CREATE_MUTATION = `mutation ClawPilotReversalFixtureOrderCreate(
  $order: OrderCreateOrderInput!
  $options: OrderCreateOptionsInput
) {
  orderCreate(order: $order, options: $options) {
    order { ${ORDER_FIELDS} }
    userErrors { code field message }
  }
}`

const ORDER_RECONCILIATION_QUERY = `query ClawPilotReversalFixtureOrderRead(
  $query: String!
) {
  orders(first: 2, query: $query, sortKey: CREATED_AT, reverse: true) {
    nodes { ${ORDER_FIELDS} }
    pageInfo { hasNextPage }
  }
}`

export type ShopifyReversalFixtureOrder = Readonly<{
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sourceIdentifier: string
  uniqueTag: string
  lineItemId: string
  variantId: typeof SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID
  quantity: 1
  test: true
  currencyCode: 'USD'
  unitPrice: '10.00'
  taxable: false
  transactionId: string
  transactionKind: 'AUTHORIZATION'
  transactionStatus: 'SUCCESS'
  transactionTest: true
  transactionAmount: '10.00'
  transactionCurrencyCode: 'USD'
}>

export class ShopifyReversalFixtureProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly providerMutationAttempted = false,
    readonly outcomeUnknown = false,
    readonly providerErrorSummary: string | null = null,
    readonly providerErrorMessage: string | null = null,
  ) {
    super(message)
    this.name = 'ShopifyReversalFixtureProviderError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyReversalFixtureProviderError(code, message, status)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, max = 255) {
  if (typeof value !== 'string') {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return normalized
}

function iso(value: unknown, label: string) {
  const normalized = text(value, label, 64)
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
    )
  }
  return parsed.toISOString()
}

function exactSourceIdentifier(value: unknown) {
  const sourceIdentifier = text(value, 'source identifier', 128)
  if (!SOURCE_IDENTIFIER.test(sourceIdentifier)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_SOURCE_IDENTIFIER_INVALID',
      'The exact fixed fixture source identifier is invalid',
      400,
    )
  }
  return sourceIdentifier
}

function exactUniqueTag(value: unknown) {
  const uniqueTag = text(value, 'unique fixture tag', 64)
  if (!UNIQUE_TAG.test(uniqueTag)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_TAG_INVALID',
      'The exact fixed fixture tag is invalid',
      400,
    )
  }
  return uniqueTag
}

export function shopifyReversalFixtureTagFingerprint(value: unknown) {
  const uniqueTag = exactUniqueTag(value)
  return createHash('sha256').update(uniqueTag).digest('hex')
}

function exactOrderProviderPayload(input: {
  shopDomain: unknown
  sourceIdentifier: unknown
  uniqueTag: unknown
}) {
  const shopDomain = String(input.shopDomain || '').trim().toLowerCase()
  if (shopDomain !== SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_STORE_CHANGED',
      'The fixed Test Pro Bakery Bites Shopify domain is required',
      403,
    )
  }
  const sourceIdentifier = exactSourceIdentifier(input.sourceIdentifier)
  const uniqueTag = exactUniqueTag(input.uniqueTag)
  const variables = Object.freeze({
    order: Object.freeze({
      test: true as const,
      financialStatus: 'PENDING' as const,
      currency: 'USD' as const,
      // The fixture has no customer or email, so marketing consent must remain
      // unset in Shopify. Receipt and fulfillment notifications remain off.
      sourceIdentifier,
      tags: Object.freeze([SHOPIFY_REVERSAL_FIXTURE_BASE_TAG, uniqueTag]),
      lineItems: Object.freeze([Object.freeze({
        variantId: SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
        quantity: 1 as const,
        requiresShipping: true as const,
        taxable: false as const,
        priceSet: Object.freeze({
          shopMoney: Object.freeze({
            amount: '10.00' as const,
            currencyCode: 'USD' as const,
          }),
        }),
      })]),
      transactions: Object.freeze([Object.freeze({
        kind: 'AUTHORIZATION' as const,
        status: 'SUCCESS' as const,
        test: true as const,
        amountSet: Object.freeze({
          shopMoney: Object.freeze({
            amount: '10.00' as const,
            currencyCode: 'USD' as const,
          }),
        }),
      })]),
      shippingAddress: SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE.shippingAddress,
    }),
    options: Object.freeze({
      inventoryBehaviour: 'BYPASS' as const,
      sendReceipt: false as const,
      sendFulfillmentReceipt: false as const,
    }),
  })
  const providerPayloadHash = createHash('sha256').update(JSON.stringify({
    version: 'shopify-reversal-fixture-order-provider-payload-v5',
    shopDomain,
    variables,
  })).digest('hex')
  return Object.freeze({
    sourceIdentifier,
    uniqueTag,
    variables,
    providerPayloadHash,
  })
}

export function shopifyReversalFixtureOrderProviderPayloadHash(input: {
  shopDomain: unknown
  sourceIdentifier: unknown
  uniqueTag: unknown
}) {
  return exactOrderProviderPayload(input).providerPayloadHash
}

function normalizeFixtureOrder(
  value: unknown,
  expected: { sourceIdentifier: string; uniqueTag: string },
  proof: 'immediate' | 'reconciliation',
): ShopifyReversalFixtureOrder {
  const order = record(value, 'order')
  const id = text(order.id, 'order ID', 128)
  if (!SHOPIFY_ORDER_GID.test(id)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned an invalid order ID',
      502,
    )
  }
  if (
    order.test !== true
    || order.sourceIdentifier !== expected.sourceIdentifier
    || order.currencyCode !== 'USD'
    || order.presentmentCurrencyCode !== 'USD'
    || (
      proof === 'immediate'
      && (
        order.displayFinancialStatus !== 'PENDING'
        || order.displayFulfillmentStatus !== 'UNFULFILLED'
      )
    )
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'Shopify did not return the exact unpaid, unfulfilled test order',
    )
  }
  if (!Array.isArray(order.tags)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned malformed order tags',
      502,
    )
  }
  const tags = [...new Set(order.tags.map((tag) => text(tag, 'order tag')))]
    .sort()
  const expectedTags = [
    SHOPIFY_REVERSAL_FIXTURE_BASE_TAG,
    expected.uniqueTag,
  ].sort()
  const tagsMatch = proof === 'immediate'
    ? JSON.stringify(tags) === JSON.stringify(expectedTags)
    : expectedTags.every((tag) => tags.includes(tag))
  if (!tagsMatch) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'Shopify order tags do not match the exact fixture fingerprint',
    )
  }
  const lineItems = record(order.lineItems, 'order lines')
  if (proof === 'immediate') {
    const totalPrice = normalizedUsdMoneyBag(
      order.totalPriceSet,
      'order total price',
    )
    const totalCapturable = normalizedUsdMoneyBag(
      order.totalCapturableSet,
      'order total capturable amount',
    )
    if (
      order.capturable !== true
      || !isExactFixtureAmount(totalPrice)
      || !isExactFixtureAmount(totalCapturable)
    ) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
        'The fixed authorized USD order total changed',
      )
    }
  }
  const pageInfo = record(lineItems.pageInfo, 'order line page information')
  if (pageInfo.hasNextPage !== false || !Array.isArray(lineItems.nodes)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned an unbounded order line set',
      502,
    )
  }
  if (
    lineItems.nodes.length < 1
    || (proof === 'immediate' && lineItems.nodes.length !== 1)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed fixture must contain exactly one order line',
    )
  }
  const matchingLines = lineItems.nodes.map((value, index) => {
    const line = record(value, `order line ${index}`)
    const variantId = line.variant === null
      ? null
      : record(line.variant, `order line ${index} variant`).id
    const linePrice = normalizedUsdMoneyBag(
      line.originalUnitPriceSet,
      `order line ${index} original unit price`,
    )
    const lineItemId = text(line.id, `order line ${index} ID`, 128)
    if (!SHOPIFY_LINE_ITEM_GID.test(lineItemId)) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
        'Shopify returned an invalid order line ID',
        502,
      )
    }
    const matches = (
      variantId === SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID
      && line.quantity === 1
      && line.taxable === false
      && line.requiresShipping === true
      && isExactFixtureAmount(linePrice)
      && (
        proof !== 'immediate'
        || (
          line.currentQuantity === 1
          && line.unfulfilledQuantity === 1
        )
      )
    )
    return matches ? Object.freeze({ lineItemId }) : null
  }).filter((line): line is Readonly<{ lineItemId: string }> => line !== null)
  if (matchingLines.length !== 1) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed shippable one-unit fixture line changed',
    )
  }
  const lineItemId = matchingLines[0].lineItemId
  if (
    !Array.isArray(order.transactions)
    || order.transactions.length < 1
    || order.transactions.length >= 10
    || (proof === 'immediate' && order.transactions.length !== 1)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed fixture authorization transaction set is not bounded',
    )
  }
  const matchingTransactions = order.transactions.map((value, index) => {
    const transaction = record(value, `order transaction ${index}`)
    const transactionId = text(
      transaction.id,
      `order transaction ${index} ID`,
      128,
    )
    if (!SHOPIFY_ORDER_TRANSACTION_GID.test(transactionId)) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
        'Shopify returned an invalid order transaction ID',
        502,
      )
    }
    const transactionAmount = normalizedUsdMoneyBag(
      transaction.amountSet,
      `order transaction ${index} amount`,
    )
    const matches = (
      transaction.kind === 'AUTHORIZATION'
      && transaction.status === 'SUCCESS'
      && transaction.test === true
      && isExactFixtureAmount(transactionAmount)
    )
    return matches ? Object.freeze({ transactionId }) : null
  }).filter((transaction): transaction is Readonly<{
    transactionId: string
  }> => transaction !== null)
  if (matchingTransactions.length !== 1) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed test authorization transaction changed',
    )
  }
  const transactionId = matchingTransactions[0].transactionId
  return Object.freeze({
    id,
    name: text(order.name, 'order name'),
    createdAt: iso(order.createdAt, 'order creation time'),
    updatedAt: iso(order.updatedAt, 'order update time'),
    sourceIdentifier: expected.sourceIdentifier,
    uniqueTag: expected.uniqueTag,
    lineItemId,
    variantId: SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
    quantity: 1 as const,
    test: true as const,
    currencyCode: 'USD' as const,
    unitPrice: '10.00' as const,
    taxable: false as const,
    transactionId,
    transactionKind: 'AUTHORIZATION' as const,
    transactionStatus: 'SUCCESS' as const,
    transactionTest: true as const,
    transactionAmount: '10.00' as const,
    transactionCurrencyCode: 'USD' as const,
  })
}

function normalizedUsdMoneyBag(value: unknown, label: string) {
  const moneyBag = record(value, label)
  const shopMoney = record(moneyBag.shopMoney, `${label} shop money`)
  const presentmentMoney = record(
    moneyBag.presentmentMoney,
    `${label} presentment money`,
  )
  const shopAmount = text(shopMoney.amount, `${label} shop amount`, 64)
  const presentmentAmount = text(
    presentmentMoney.amount,
    `${label} presentment amount`,
    64,
  )
  if (
    shopMoney.currencyCode !== 'USD'
    || presentmentMoney.currencyCode !== 'USD'
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(shopAmount)
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(presentmentAmount)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      `Shopify returned malformed USD ${label}`,
    )
  }
  return Object.freeze({ shopAmount, presentmentAmount })
}

function isExactFixtureAmount(value: Readonly<{
  shopAmount: string
  presentmentAmount: string
}>) {
  return /^10(?:\.0+)?$/u.test(value.shopAmount)
    && /^10(?:\.0+)?$/u.test(value.presentmentAmount)
}

export function sanitizeShopifyReversalFixtureProviderErrorMessage(
  value: unknown,
) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned a malformed order-create error message',
      502,
    )
  }
  const sanitized = value
    .normalize('NFKC')
    .replace(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/giu, '[redacted-url]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(/gid:\/\/shopify\/[A-Za-z][A-Za-z0-9_]*\/[^\s,;]+/gu, '[redacted-gid]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, '[redacted-uuid]')
    .replace(/\b(?:account|card|payment)(?:\s+(?:number|id|ending(?:\s+in)?))?\s*[:#-]?\s*(?:\*{2,}[ -]*)*\d(?:[ -]?\d){3,}\b/giu, '[redacted-account]')
    .replace(/\b\d{7,}\b/gu, '[redacted-number]')
    .replace(/(?:\+?1[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/gu, '[redacted-phone]')
    .replace(/\b\d(?:[ -]?\d){6,}\b/gu, '[redacted-number]')
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]+\b/gu, '[redacted-token]')
    .replace(/\b(?=[A-Za-z0-9_-]{16,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b/gu, '[redacted-token]')
    .replace(/\d{7,}/gu, '[redacted-number]')
    .replace(/[^\x20-\x7e]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (sanitized || '[redacted]').slice(0, 240).trimEnd()
}

function normalizeUserErrors(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned malformed order-create errors',
      502,
    )
  }
  return value.map((entry) => {
    const error = record(entry, 'order-create error')
    const message = sanitizeShopifyReversalFixtureProviderErrorMessage(
      error.message,
    )
    const code = error.code === null
      ? null
      : text(error.code, 'order-create error code', 64)
    if (code !== null && !ORDER_CREATE_ERROR_CODES.has(code)) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
        'Shopify returned an unknown order-create error code',
        502,
      )
    }
    let fieldPath: string | null = null
    if (error.field !== null) {
      if (
        !Array.isArray(error.field)
        || error.field.length < 1
        || error.field.length > 16
        || error.field.some((token) => (
          typeof token !== 'string'
          || !ORDER_CREATE_ERROR_FIELD_TOKEN.test(token)
        ))
      ) {
        fail(
          'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
          'Shopify returned a malformed order-create error field',
          502,
        )
      }
      fieldPath = error.field.join('.')
      if (fieldPath.length > 255) {
        fail(
          'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
          'Shopify returned an oversized order-create error field',
          502,
        )
      }
    }
    return Object.freeze({ code, fieldPath, message })
  })
}

function providerRejectionSummary(
  errors: ReadonlyArray<Readonly<{ code: string | null; fieldPath: string | null }>>,
) {
  const evidence = [...new Set(errors.map((error) => (
    `${error.code || 'UNSPECIFIED'}${
      error.fieldPath ? ` at ${error.fieldPath}` : ''
    }`
  )))]
  const prefix = 'Shopify rejected order creation ('
  const suffix = ')'
  let details = ''
  for (const fact of evidence) {
    const candidate = details ? `${details}; ${fact}` : fact
    if (`${prefix}${candidate}${suffix}`.length > 500) break
    details = candidate
  }
  return `${prefix}${details}${suffix}`
}

function providerRejectionMessage(
  errors: ReadonlyArray<Readonly<{ message: string }>>,
) {
  const evidence = [...new Set(errors.map((error) => error.message))]
  let result = ''
  for (const message of evidence) {
    const candidate = result ? `${result}; ${message}` : message
    if (candidate.length > 240) {
      if (!result) result = candidate.slice(0, 240).trimEnd()
      break
    }
    result = candidate
  }
  return result || '[redacted]'
}

export async function createShopifyReversalFixtureOrder(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    sourceIdentifier: unknown
    uniqueTag: unknown
    claim: {
      organizationId: string
      commandId: string
      attemptId: string
      actorEmail: string
    }
  },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyReversalFixtureOrder> {
  if (credential.shopDomain !== SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_STORE_CHANGED',
      'The fixed Test Pro Bakery Bites Shopify domain is required',
      403,
    )
  }
  const providerPayload = exactOrderProviderPayload({
    shopDomain: credential.shopDomain,
    sourceIdentifier: input.sourceIdentifier,
    uniqueTag: input.uniqueTag,
  })
  const {
    sourceIdentifier,
    uniqueTag,
    variables,
    providerPayloadHash,
  } = providerPayload
  await assertShopifyReversalFixtureOrderClaimCurrentInPostgres({
    ...input.claim,
    providerPayloadHash,
  })
  let data: {
    orderCreate?: {
      order?: unknown
      userErrors?: unknown
    }
  }
  try {
    data = await shopifyAdminGraphql(credential, {
      query: ORDER_CREATE_MUTATION,
      operationName: 'ClawPilotReversalFixtureOrderCreate',
      variables,
    }, options)
  } catch {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
      'Shopify order creation did not return a verifiable outcome; reconcile this exact attempt before any other fixture write',
      502,
      true,
      true,
    )
  }
  const payload = data.orderCreate
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
      'Shopify order creation returned an unverifiable response; reconcile this exact attempt',
      502,
      true,
      true,
    )
  }
  let errors: ReadonlyArray<Readonly<{
    code: string | null
    fieldPath: string | null
    message: string
  }>>
  try {
    errors = normalizeUserErrors(payload.userErrors)
  } catch {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
      'Shopify order creation returned malformed error evidence; reconcile this attempt',
      502,
      true,
      true,
    )
  }
  if (errors.length > 0) {
    const errorSummary = providerRejectionSummary(errors)
    const errorMessage = providerRejectionMessage(errors)
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
      errorSummary,
      409,
      true,
      false,
      errorSummary,
      errorMessage,
    )
  }
  if (!payload.order) {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
      'Shopify accepted the request without returning exact order evidence; reconcile this attempt',
      502,
      true,
      true,
    )
  }
  try {
    return normalizeFixtureOrder(
      payload.order,
      { sourceIdentifier, uniqueTag },
      'immediate',
    )
  } catch {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
      'Shopify returned order evidence that could not be proven exact; reconcile this attempt',
      502,
      true,
      true,
    )
  }
}

export type ShopifyReversalFixtureOrderReconciliation = Readonly<{
  resolution: 'applied' | 'absent' | 'ambiguous'
  order: ShopifyReversalFixtureOrder | null
  evidenceHash: string
}>

export async function reconcileShopifyReversalFixtureOrder(
  credential: ShopifyCommerceRuntimeCredential,
  input: { sourceIdentifier: unknown; uniqueTag: unknown },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyReversalFixtureOrderReconciliation> {
  const sourceIdentifier = exactSourceIdentifier(input.sourceIdentifier)
  const uniqueTag = exactUniqueTag(input.uniqueTag)
  const data = await shopifyAdminGraphql<{
    orders?: unknown
  }>(credential, {
    query: ORDER_RECONCILIATION_QUERY,
    operationName: 'ClawPilotReversalFixtureOrderRead',
    variables: {
      query: `source_identifier:${JSON.stringify(sourceIdentifier)} AND tag:${uniqueTag} AND test:true`,
    },
  }, options)
  const connection = record(data.orders, 'order search')
  const pageInfo = record(connection.pageInfo, 'order search page information')
  if (pageInfo.hasNextPage !== false || !Array.isArray(connection.nodes)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_RECONCILIATION_AMBIGUOUS',
      'The exact fixture order search exceeded its bounded result',
    )
  }
  if (connection.nodes.length === 0) {
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
      sourceIdentifier,
      uniqueTag,
      resolution: 'absent',
    })).digest('hex')
    return Object.freeze({ resolution: 'absent', order: null, evidenceHash })
  }
  if (connection.nodes.length !== 1) {
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
      sourceIdentifier,
      uniqueTag,
      resolution: 'ambiguous',
      count: connection.nodes.length,
    })).digest('hex')
    return Object.freeze({ resolution: 'ambiguous', order: null, evidenceHash })
  }
  let order: ShopifyReversalFixtureOrder
  try {
    order = normalizeFixtureOrder(connection.nodes[0], {
      sourceIdentifier,
      uniqueTag,
    }, 'reconciliation')
  } catch {
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
      sourceIdentifier,
      uniqueTag,
      resolution: 'ambiguous',
      count: 1,
    })).digest('hex')
    return Object.freeze({ resolution: 'ambiguous', order: null, evidenceHash })
  }
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
    sourceIdentifier,
    uniqueTag,
    resolution: 'applied',
    order,
  })).digest('hex')
  return Object.freeze({ resolution: 'applied', order, evidenceHash })
}

export const SHOPIFY_REVERSAL_FIXTURE_PROVIDER_QUERIES = Object.freeze({
  orderCreate: ORDER_CREATE_MUTATION,
  orderReconciliation: ORDER_RECONCILIATION_QUERY,
})
