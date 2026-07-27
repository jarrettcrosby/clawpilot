import { createHash } from 'node:crypto'
import {
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'

export const SHOPIFY_ORDER_PREVIEW_POLICY_VERSION =
  'shopify-held-preview-v1'
export const SHOPIFY_ORDER_PREVIEW_MAX_ORDERS = 25
export const SHOPIFY_ORDER_PREVIEW_MAX_LINES = 20
export const SHOPIFY_ORDER_PREVIEW_TTL_HOURS = 24

const SHOPIFY_ORDER_PREVIEW_DEADLINE_MS = 45_000
const SHOPIFY_ORDER_PREVIEW_REQUEST_TIMEOUT_MS = 12_000
const SHOPIFY_ORDER_PREVIEW_RETRY_DELAYS_MS = [250, 750] as const
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOPIFY_LINE_GID = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const IDEMPOTENCY_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_STATUS = /^[A-Z][A-Z0-9_]{0,63}$/
const SAFE_SOURCE = /^[A-Za-z0-9_.:/ -]{1,120}$/
const MONEY_AMOUNT = /^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/

const SHOPIFY_ORDER_PREVIEW_IDS_QUERY = `query ClawPilotShopifyOrderPreviewIds(
  $first: Int!
  $filter: String!
) {
  orders(
    first: $first
    query: $filter
    sortKey: CREATED_AT
    reverse: true
  ) {
    nodes {
      id
      test
    }
    pageInfo {
      hasNextPage
    }
  }
}`

const SHOPIFY_ORDER_PREVIEW_DETAIL_QUERY = `query ClawPilotShopifyOrderPreviewDetail(
  $ids: [ID!]!
) {
  nodes(ids: $ids) {
    id
    ... on Order {
      name
      createdAt
      processedAt
      updatedAt
      cancelledAt
      closedAt
      test
      sourceName
      displayFinancialStatus
      displayFulfillmentStatus
      fulfillable
      requiresShipping
      currencyCode
      currentSubtotalLineItemsQuantity
      currentSubtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentShippingPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentTotalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 20) {
        nodes {
          id
          sku
          quantity
          currentQuantity
          unfulfilledQuantity
          requiresShipping
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
}`

export type ShopifyOrderPreviewGapCode =
  | 'canonical_import_not_implemented'
  | 'customer_resolution_not_evaluated'
  | 'line_items_empty'
  | 'line_items_truncated'
  | 'non_shippable_order'
  | 'order_already_fulfilled'
  | 'order_cancelled'
  | 'package_profile_missing'
  | 'product_mapping_inactive'
  | 'product_mapping_missing'
  | 'requested_delivery_not_mapped'
  | 'ship_to_not_ingested'
  | 'sku_missing'

export type ShopifyOrderPreviewLine = {
  externalLineId: string
  sku: string | null
  quantity: number
  currentQuantity: number
  unfulfilledQuantity: number
  requiresShipping: boolean
}

export type ShopifyOrderPreviewCandidate = {
  externalOrderId: string
  orderName: string
  providerCreatedAt: string
  providerProcessedAt: string
  providerUpdatedAt: string
  providerCancelledAt: string | null
  providerClosedAt: string | null
  testOrder: boolean
  sourceName: string | null
  financialStatus: string | null
  fulfillmentStatus: string
  fulfillable: boolean
  requiresShipping: boolean
  currencyCode: string
  subtotalAmount: string
  shippingAmount: string
  taxAmount: string
  totalAmount: string
  lineItemQuantity: number
  lineItemsTruncated: boolean
  normalizedLines: ShopifyOrderPreviewLine[]
  gapCodes: ShopifyOrderPreviewGapCode[]
  sourceHash: string
}

export type ShopifyOrderPreviewFetchResult = {
  windowEnd: string
  ordersSeen: number
  moreAvailable: boolean
  candidates: ShopifyOrderPreviewCandidate[]
}

export class ShopifyOrderPreviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'SHOPIFY_ORDER_PREVIEW_INVALID',
  ) {
    super(message)
    this.name = 'ShopifyOrderPreviewError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function previewInvalid(message: string): never {
  throw new ShopifyOrderPreviewError(
    message,
    502,
    'SHOPIFY_ORDER_PREVIEW_RESPONSE_INVALID',
  )
}

function requiredText(
  value: unknown,
  label: string,
  maximum = 255,
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return value
}

function optionalText(
  value: unknown,
  pattern: RegExp,
  label: string,
): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !pattern.test(value)) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return value
}

function gid(
  value: unknown,
  pattern: RegExp,
  label: string,
  nullable = false,
): string | null {
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string' || !pattern.test(value)) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return value
}

function timestamp(
  value: unknown,
  label: string,
  nullable = false,
): string | null {
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string' || value.length > 64) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return date.toISOString()
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return Number(value)
}

function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    previewInvalid('Shopify returned an invalid currency code')
  }
  return value
}

function money(value: unknown, expectedCurrency: string, label: string): string {
  const bag = record(value)
  const shopMoney = record(bag?.shopMoney)
  const amount = shopMoney?.amount
  if (
    !shopMoney
    || typeof amount !== 'string'
    || !MONEY_AMOUNT.test(amount)
    || currency(shopMoney.currencyCode) !== expectedCurrency
  ) {
    previewInvalid(`Shopify returned invalid ${label}`)
  }
  return amount
}

function safeSku(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (
    typeof value !== 'string'
    || value.length > 255
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    previewInvalid('Shopify returned an invalid line-item SKU')
  }
  return value
}

function parseLine(value: unknown): ShopifyOrderPreviewLine {
  const line = record(value)
  if (!line) previewInvalid('Shopify returned an invalid order line')
  return {
    externalLineId: gid(
      line.id,
      SHOPIFY_LINE_GID,
      'line-item identity',
    ) as string,
    sku: safeSku(line.sku),
    quantity: integer(line.quantity, 'line-item quantity'),
    currentQuantity: integer(
      line.currentQuantity,
      'line-item current quantity',
    ),
    unfulfilledQuantity: integer(
      line.unfulfilledQuantity,
      'line-item unfulfilled quantity',
    ),
    requiresShipping: boolean(
      line.requiresShipping,
      'line-item shipping state',
    ),
  }
}

function sortedGaps(
  values: Iterable<ShopifyOrderPreviewGapCode>,
): ShopifyOrderPreviewGapCode[] {
  return [...new Set(values)].sort()
}

function sourceHash(value: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parseCandidate(
  value: unknown,
  expectedOrderId: string,
): ShopifyOrderPreviewCandidate {
  const order = record(value)
  if (!order) {
    previewInvalid('Shopify order changed during the diagnostic read')
  }
  const externalOrderId = gid(
    order.id,
    SHOPIFY_ORDER_GID,
    'order identity',
  ) as string
  if (externalOrderId !== expectedOrderId) {
    previewInvalid('Shopify returned a mismatched order identity')
  }
  const currencyCode = currency(order.currencyCode)
  const lines = record(order.lineItems)
  if (!lines || !Array.isArray(lines.nodes)) {
    previewInvalid('Shopify returned invalid line-item data')
  }
  if (lines.nodes.length > SHOPIFY_ORDER_PREVIEW_MAX_LINES) {
    previewInvalid('Shopify returned too many line items')
  }
  const normalizedLines = lines.nodes.map(parseLine)
  const uniqueLines = new Set(
    normalizedLines.map((line) => line.externalLineId),
  )
  if (uniqueLines.size !== normalizedLines.length) {
    previewInvalid('Shopify returned duplicate line-item identities')
  }
  const pageInfo = record(lines.pageInfo)
  const lineItemsTruncated = boolean(
    pageInfo?.hasNextPage,
    'line-item pagination state',
  )
  const lineItemQuantity = integer(
    order.currentSubtotalLineItemsQuantity,
    'order line-item count',
  )
  const testOrder = boolean(order.test, 'test-order state')
  if (testOrder) {
    previewInvalid(
      'Shopify returned a test order outside the non-test diagnostic filter',
    )
  }
  const requiresShipping = boolean(
    order.requiresShipping,
    'order shipping state',
  )
  const fulfillmentStatus = optionalText(
    order.displayFulfillmentStatus,
    SAFE_STATUS,
    'fulfillment status',
  )
  if (!fulfillmentStatus) {
    previewInvalid('Shopify returned an invalid fulfillment status')
  }
  const gaps = new Set<ShopifyOrderPreviewGapCode>([
    'canonical_import_not_implemented',
    'customer_resolution_not_evaluated',
    'requested_delivery_not_mapped',
  ])
  if (requiresShipping) gaps.add('ship_to_not_ingested')
  else gaps.add('non_shippable_order')
  if (!normalizedLines.length) gaps.add('line_items_empty')
  if (lineItemsTruncated) gaps.add('line_items_truncated')
  if (normalizedLines.some((line) => !line.sku)) gaps.add('sku_missing')
  if (order.cancelledAt) gaps.add('order_cancelled')
  if (
    fulfillmentStatus === 'FULFILLED'
    || fulfillmentStatus === 'SHIPPED'
  ) {
    gaps.add('order_already_fulfilled')
  }
  const projection = {
    externalOrderId,
    orderName: requiredText(order.name, 'order name'),
    providerCreatedAt: timestamp(order.createdAt, 'order creation time') as string,
    providerProcessedAt: timestamp(
      order.processedAt,
      'order processed time',
    ) as string,
    providerUpdatedAt: timestamp(order.updatedAt, 'order update time') as string,
    providerCancelledAt: timestamp(
      order.cancelledAt,
      'order cancellation time',
      true,
    ),
    providerClosedAt: timestamp(
      order.closedAt,
      'order close time',
      true,
    ),
    testOrder,
    sourceName: optionalText(
      order.sourceName,
      SAFE_SOURCE,
      'order source',
    ),
    financialStatus: optionalText(
      order.displayFinancialStatus,
      SAFE_STATUS,
      'financial status',
    ),
    fulfillmentStatus,
    fulfillable: boolean(order.fulfillable, 'order fulfillable state'),
    requiresShipping,
    currencyCode,
    subtotalAmount: money(
      order.currentSubtotalPriceSet,
      currencyCode,
      'order subtotal',
    ),
    shippingAmount: money(
      order.currentShippingPriceSet,
      currencyCode,
      'order shipping total',
    ),
    taxAmount: money(
      order.currentTotalTaxSet,
      currencyCode,
      'order tax total',
    ),
    totalAmount: money(
      order.currentTotalPriceSet,
      currencyCode,
      'order total',
    ),
    lineItemQuantity,
    lineItemsTruncated,
    normalizedLines,
  }
  return {
    ...projection,
    gapCodes: sortedGaps(gaps),
    sourceHash: sourceHash(projection),
  }
}

export function assertShopifyOrderPreviewRuntime(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.CLAWPILOT_SHOPIFY_ORDER_PREVIEW_ENABLED !== '1') {
    throw new ShopifyOrderPreviewError(
      'Shopify order preview is not enabled in this environment',
      404,
      'SHOPIFY_ORDER_PREVIEW_DISABLED',
    )
  }
  const lane = String(
    environment.CLAWPILOT_ENV
    || environment.RAILWAY_ENVIRONMENT_NAME
    || environment.VERCEL_ENV
    || environment.NODE_ENV
    || '',
  ).trim().toLowerCase()
  if (!['dev', 'development', 'local', 'preview'].includes(lane)) {
    throw new ShopifyOrderPreviewError(
      'Shopify order preview is restricted to development environments',
      403,
      'SHOPIFY_ORDER_PREVIEW_DEVELOPMENT_ONLY',
    )
  }
}

export function normalizeShopifyOrderPreviewIdempotencyKey(
  value: unknown,
): string {
  const key = String(value || '').trim().toLowerCase()
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ShopifyOrderPreviewError(
      'A valid order-preview idempotency key is required',
      400,
      'SHOPIFY_ORDER_PREVIEW_IDEMPOTENCY_INVALID',
    )
  }
  return key
}

async function waitForRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

async function previewGraphql<T>(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    query: string
    variables?: Record<string, unknown>
    operationName: string
  },
  deadlineAt: number,
): Promise<T> {
  for (
    let attempt = 0;
    attempt <= SHOPIFY_ORDER_PREVIEW_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs < 1_000) {
      throw new ShopifyOrderPreviewError(
        'Shopify order preview exceeded its safe read deadline',
        504,
        'SHOPIFY_ORDER_PREVIEW_DEADLINE_EXCEEDED',
      )
    }
    try {
      return await shopifyAdminGraphql<T>(
        credential,
        input,
        {
          timeoutMs: Math.min(
            SHOPIFY_ORDER_PREVIEW_REQUEST_TIMEOUT_MS,
            remainingMs,
          ),
        },
      )
    } catch (error) {
      const delayMs = SHOPIFY_ORDER_PREVIEW_RETRY_DELAYS_MS[attempt]
      if (
        !(error instanceof ShopifyCommerceClientError)
        || !error.retryable
        || delayMs === undefined
        || deadlineAt - Date.now() < delayMs + 1_000
      ) {
        throw error
      }
      await waitForRetry(delayMs)
    }
  }
  throw new ShopifyOrderPreviewError(
    'Shopify order preview exhausted its safe retry budget',
    503,
    'SHOPIFY_ORDER_PREVIEW_RETRY_EXHAUSTED',
  )
}

export async function fetchShopifyOrderPreview(
  credential: ShopifyCommerceRuntimeCredential,
  options: { deadlineAt?: number } = {},
): Promise<ShopifyOrderPreviewFetchResult> {
  const localDeadlineAt = Date.now() + SHOPIFY_ORDER_PREVIEW_DEADLINE_MS
  const deadlineAt = (
    typeof options.deadlineAt === 'number'
    && Number.isFinite(options.deadlineAt)
  )
    ? Math.min(localDeadlineAt, Math.floor(options.deadlineAt))
    : localDeadlineAt
  const windowEnd = new Date().toISOString()
  const list = await previewGraphql<{
    orders?: unknown
  }>(
    credential,
    {
      query: SHOPIFY_ORDER_PREVIEW_IDS_QUERY,
      operationName: 'ClawPilotShopifyOrderPreviewIds',
      variables: {
        first: SHOPIFY_ORDER_PREVIEW_MAX_ORDERS,
        filter: `test:false created_at:<='${windowEnd}'`,
      },
    },
    deadlineAt,
  )
  const orders = record(list.orders)
  const pageInfo = record(orders?.pageInfo)
  if (
    !orders
    || !Array.isArray(orders.nodes)
    || orders.nodes.length > SHOPIFY_ORDER_PREVIEW_MAX_ORDERS
  ) {
    previewInvalid('Shopify returned invalid order-preview pagination data')
  }
  const orderIds = orders.nodes.map((value) => {
    const order = record(value)
    if (!order || boolean(order.test, 'test-order state')) {
      previewInvalid('Shopify returned an invalid non-test order candidate')
    }
    return gid(order.id, SHOPIFY_ORDER_GID, 'order identity') as string
  })
  if (new Set(orderIds).size !== orderIds.length) {
    previewInvalid('Shopify returned duplicate order identities')
  }

  let candidates: ShopifyOrderPreviewCandidate[] = []
  if (orderIds.length) {
    const detail = await previewGraphql<{
      nodes?: unknown
    }>(
      credential,
      {
        query: SHOPIFY_ORDER_PREVIEW_DETAIL_QUERY,
        operationName: 'ClawPilotShopifyOrderPreviewDetail',
        variables: { ids: orderIds },
      },
      deadlineAt,
    )
    if (
      !Array.isArray(detail.nodes)
      || detail.nodes.length !== orderIds.length
    ) {
      previewInvalid('Shopify returned invalid order-preview detail data')
    }
    candidates = detail.nodes.map((order, index) => (
      parseCandidate(order, orderIds[index])
    ))
  }
  return {
    windowEnd,
    ordersSeen: orderIds.length,
    moreAvailable: boolean(
      pageInfo?.hasNextPage,
      'order-preview pagination state',
    ),
    candidates,
  }
}

export const SHOPIFY_ORDER_PREVIEW_QUERY_CONTRACT = {
  ids: SHOPIFY_ORDER_PREVIEW_IDS_QUERY,
  detail: SHOPIFY_ORDER_PREVIEW_DETAIL_QUERY,
} as const
