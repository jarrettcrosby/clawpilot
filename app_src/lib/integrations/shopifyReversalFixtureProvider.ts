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
  'shopify-reversal-fixture-v2' as const
export const SHOPIFY_REVERSAL_FIXTURE_BASE_TAG =
  'clawpilot-reversal-fixture' as const

export const SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE = Object.freeze({
  version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
  test: true as const,
  financialStatus: 'PENDING' as const,
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
  displayFinancialStatus
  displayFulfillmentStatus
  tags
  lineItems(first: 2) {
    nodes {
      id
      currentQuantity
      unfulfilledQuantity
      requiresShipping
      variant { id }
    }
    pageInfo { hasNextPage }
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
  orders(first: 3, query: $query, sortKey: CREATED_AT, reverse: true) {
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
  displayFinancialStatus: 'PENDING'
  displayFulfillmentStatus: 'UNFULFILLED'
}>

export class ShopifyReversalFixtureProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly providerMutationAttempted = false,
    readonly outcomeUnknown = false,
    readonly providerErrorSummary: string | null = null,
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
      // The fixture has no customer or email, so marketing consent must remain
      // unset in Shopify. Receipt and fulfillment notifications remain off.
      sourceIdentifier,
      tags: Object.freeze([SHOPIFY_REVERSAL_FIXTURE_BASE_TAG, uniqueTag]),
      lineItems: Object.freeze([Object.freeze({
        variantId: SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
        quantity: 1 as const,
        requiresShipping: true as const,
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
    version: 'shopify-reversal-fixture-order-provider-payload-v2',
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
    || order.displayFinancialStatus !== 'PENDING'
    || order.displayFulfillmentStatus !== 'UNFULFILLED'
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
  if (JSON.stringify(tags) !== JSON.stringify(expectedTags)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'Shopify order tags do not match the exact fixture fingerprint',
    )
  }
  const lineItems = record(order.lineItems, 'order lines')
  const pageInfo = record(lineItems.pageInfo, 'order line page information')
  if (pageInfo.hasNextPage !== false || !Array.isArray(lineItems.nodes)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_RESPONSE_INVALID',
      'Shopify returned an unbounded order line set',
      502,
    )
  }
  if (lineItems.nodes.length !== 1) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed fixture must contain exactly one order line',
    )
  }
  const line = record(lineItems.nodes[0], 'order line')
  const variant = record(line.variant, 'order line variant')
  const lineItemId = text(line.id, 'order line ID', 128)
  if (
    !SHOPIFY_LINE_ITEM_GID.test(lineItemId)
    || variant.id !== SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID
    || line.currentQuantity !== 1
    || line.unfulfilledQuantity !== 1
    || line.requiresShipping !== true
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_SHAPE_CHANGED',
      'The fixed shippable one-unit fixture line changed',
    )
  }
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
    displayFinancialStatus: 'PENDING' as const,
    displayFulfillmentStatus: 'UNFULFILLED' as const,
  })
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
    text(error.message, 'order-create error message', 500)
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
    return Object.freeze({ code, fieldPath })
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
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
      errorSummary,
      409,
      true,
      false,
      errorSummary,
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
    return normalizeFixtureOrder(payload.order, { sourceIdentifier, uniqueTag })
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
    variables: { query: `tag:${uniqueTag}` },
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
    })
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
