import { createHash } from 'node:crypto'
import {
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]{0,20}$/u
const SHOPIFY_LINE_ITEM_GID =
  /^gid:\/\/shopify\/LineItem\/[1-9][0-9]{0,20}$/u
const SOURCE_IDENTIFIER =
  /^clawpilot-reversal-fixture:gsfc(?:[0-9]{7}|[0-9a-v]{12})$/u
const UNIQUE_TAG = /^clawpilot-reversal-[a-f0-9]{24}$/u

export const SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION =
  'shopify-reversal-fixture-v1' as const
export const SHOPIFY_REVERSAL_FIXTURE_BASE_TAG =
  'clawpilot-reversal-fixture' as const

export const SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE = Object.freeze({
  version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
  test: true as const,
  financialStatus: 'PENDING' as const,
  buyerAcceptsMarketing: false as const,
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
    userErrors { field message }
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
    return text(error.message, 'order-create error message', 500)
  })
}

export async function createShopifyReversalFixtureOrder(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    sourceIdentifier: unknown
    uniqueTag: unknown
    beforeProviderMutation?: () => Promise<void>
  },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyReversalFixtureOrder> {
  const sourceIdentifier = exactSourceIdentifier(input.sourceIdentifier)
  const uniqueTag = exactUniqueTag(input.uniqueTag)
  await input.beforeProviderMutation?.()
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
      variables: {
        order: {
          test: true,
          financialStatus: 'PENDING',
          buyerAcceptsMarketing: false,
          sourceIdentifier,
          tags: [SHOPIFY_REVERSAL_FIXTURE_BASE_TAG, uniqueTag],
          lineItems: [{
            variantId: SHOPIFY_REVERSAL_FIXTURE_VARIANT_GID,
            quantity: 1,
            requiresShipping: true,
          }],
          shippingAddress: {
            ...SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE.shippingAddress,
          },
        },
        options: {
          inventoryBehaviour: 'BYPASS',
          sendReceipt: false,
          sendFulfillmentReceipt: false,
        },
      },
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
  const errors = normalizeUserErrors(payload.userErrors)
  if (errors.length > 0) {
    throw new ShopifyReversalFixtureProviderError(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
      errors.join('; ').slice(0, 500),
      409,
      true,
      false,
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
