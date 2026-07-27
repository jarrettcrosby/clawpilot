import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  getFaireOrder,
  listFaireInventory,
  listFaireOrders,
  listFaireProducts,
} from '@/lib/integrations/faireCommerceClient'
import {
  normalizeFaireCommerce,
} from '@/lib/integrations/faireCommerceNormalizer'
import {
  normalizeShopifyCommerce,
} from '@/lib/integrations/shopifyCommerceNormalizer'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  createCommerceNormalizationRejection,
  type CommerceNormalizationRejection,
  type CommerceNormalizationContext,
  type CommerceNormalizationEnvelope,
} from '@/lib/operations/commerceNormalization'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  captureCommerceIntakeProviderReadInPostgres,
  confirmCommerceCandidateAddressInPostgres,
  excludeCommerceIntakeRejectionInPostgres,
  markCommerceIntakeProviderReadUncertainInPostgres,
  markCommerceCandidateUnsupportedInPostgres,
  markCommerceIntakeContinuationInvalidInPostgres,
  prepareCommerceIntakeReadIntentInPostgres,
  promoteCommerceCandidateInPostgres,
  readCommerceIntakeRejectionTargetFromPostgres,
  readCommerceIntakeRefreshTargetFromPostgres,
  readCommerceIntakeStateFromPostgres,
  readCommerceIntakeStageReplayFromPostgres,
  resolveCommerceCandidateCustomerInPostgres,
  resolveCommerceCandidateDeliveryInPostgres,
  resolveCommerceCandidatePackageInPostgres,
  resolveCommerceCandidateProductInPostgres,
  resolveCommerceProductCandidateInPostgres,
  reserveCommerceIntakeProviderReadInPostgres,
  stageCommerceNormalizationEnvelopeInPostgres,
  validateCommerceCandidateInPostgres,
  type CommerceIntakeReadIntentAction,
  type CommerceIntakeReadIntentTarget,
} from '@/lib/persistence/commerceIntake'

const INTAKE_POLICY_VERSION = 'commerce-intake-resolution-v1'
const INTAKE_RETENTION_DAYS = 30
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUN_PATTERN = /^gcir[0-9]{7}$/
const CANDIDATE_PATTERN = /^gcoc[0-9]{7}$/
const REJECTION_PATTERN = /^gcrj[0-9]{7}$/
const PRODUCT_CANDIDATE_PATTERN = /^gcpc[0-9]{7}$/
const LINE_PATTERN = /^gcol[0-9]{7}$/
const PRODUCT_PATTERN = /^gp[0-9]{7}$/
const CUSTOMER_PATTERN = /^ga[0-9]{7}$/
const PACKAGE_PROFILE_PATTERN = /^gpp[0-9]{7}$/

const SHOPIFY_ORDER_PAGE_SIZE = 25
const SHOPIFY_PRODUCT_VARIANT_PAGE_SIZE = 50
const SHOPIFY_ORDER_LINE_PAGE_SIZE = 250
const SHOPIFY_MAX_ORDER_LINE_PAGES = 2
const SHOPIFY_MAX_NESTED_LINE_REQUESTS = 2
const SHOPIFY_MAX_BATCH_ORDER_LINES = 1_000
const SHOPIFY_GRAPHQL_TIMEOUT_MS = 8_000
const FAIRE_ORDER_PAGE_SIZE = 50
const FAIRE_PRODUCT_PAGE_SIZE = 50
const FAIRE_MAX_EMBEDDED_ORDER_LINES = 500
const FAIRE_MAX_BATCH_ORDER_LINES = 1_000
const FAIRE_MAX_PRODUCT_VARIANTS = 500
const FAIRE_MAX_BATCH_PRODUCT_VARIANTS = 1_000
const FAIRE_INVENTORY_SELECTOR_LIMIT = 50
const FAIRE_MAX_INVENTORY_REQUESTS = 20

const SHOPIFY_LINE_ITEM_FIELDS = `
  id
  title
  variantTitle
  sku
  vendor
  quantity
  currentQuantity
  unfulfilledQuantity
  requiresShipping
  originalUnitPriceSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  originalTotalSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  discountedTotalSet(withCodeDiscounts: true) {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  totalDiscountSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  unfulfilledOriginalTotalSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  unfulfilledDiscountedTotalSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  taxLines(first: 50) {
    priceSet {
      shopMoney { amount currencyCode }
      presentmentMoney { amount currencyCode }
    }
  }
  product { id }
  variant { id }
`

// Customer and company objects require read_customers (or the provider's
// company-specific scope). Order contact/address snapshots remain available
// from read_orders, so this block is included only when read_customers is
// actually granted instead of turning an optional identity aid into a fetch
// failure.
const SHOPIFY_CUSTOMER_IDENTITY_FIELDS = `
  customer {
    id
    firstName
    lastName
    displayName
    defaultEmailAddress { emailAddress }
    defaultPhoneNumber { phoneNumber }
  }
  purchasingEntity {
    __typename
    ... on Customer {
      id
      firstName
      lastName
      displayName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
    }
    ... on PurchasingCompany {
      company { id name }
      contact {
        id
        customer {
          id
          firstName
          lastName
          displayName
          defaultEmailAddress { emailAddress }
          defaultPhoneNumber { phoneNumber }
        }
      }
    }
  }
`

const SHOPIFY_ORDER_FIELDS = `
  id
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
  returnStatus
  currencyCode
  email
  phone
  shippingAddress {
    name
    firstName
    lastName
    company
    address1
    address2
    city
    province
    provinceCode
    zip
    country
    countryCodeV2
    phone
  }
  shippingLine {
    code
    title
    deliveryCategory
  }
  currentSubtotalPriceSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  currentShippingPriceSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  currentTotalTaxSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  currentTotalDiscountsSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  currentTotalPriceSet {
    shopMoney { amount currencyCode }
    presentmentMoney { amount currencyCode }
  }
  lineItems(first: ${SHOPIFY_ORDER_LINE_PAGE_SIZE}) {
    nodes {
      ${SHOPIFY_LINE_ITEM_FIELDS}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`

function shopifyOrderFields(includeCustomerIdentity: boolean) {
  return `${SHOPIFY_ORDER_FIELDS}${
    includeCustomerIdentity ? SHOPIFY_CUSTOMER_IDENTITY_FIELDS : ''
  }`
}

function shopifyOrdersQuery(includeCustomerIdentity: boolean) {
  return `query ClawPilotCommerceOrders(
  $after: String
  $query: String!
) {
  orders(
    first: ${SHOPIFY_ORDER_PAGE_SIZE}
    after: $after
    query: $query
    sortKey: UPDATED_AT
    reverse: true
  ) {
    nodes {
      ${shopifyOrderFields(includeCustomerIdentity)}
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`
}

function shopifyOrderQuery(includeCustomerIdentity: boolean) {
  return `query ClawPilotCommerceOrder($id: ID!) {
  order(id: $id) {
    ${shopifyOrderFields(includeCustomerIdentity)}
  }
}`
}

const SHOPIFY_ORDER_LINES_QUERY =
  `query ClawPilotCommerceOrderLines($id: ID!, $after: String) {
    order(id: $id) {
      id
      lineItems(first: ${SHOPIFY_ORDER_LINE_PAGE_SIZE}, after: $after) {
        nodes {
          ${SHOPIFY_LINE_ITEM_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`

function shopifyProductVariantsQuery(includeInventory: boolean) {
  return `query ClawPilotCommerceProductVariants(
  $after: String
  $query: String!
) {
  shop {
    currencyCode
  }
  productVariants(
    first: ${SHOPIFY_PRODUCT_VARIANT_PAGE_SIZE}
    after: $after
    query: $query
    sortKey: ID
    reverse: true
  ) {
    nodes {
      id
      title
      displayName
      sku
      barcode
      price
      compareAtPrice
      taxable
      selectedOptions {
        name
        value
      }
      createdAt
      updatedAt
      ${includeInventory ? 'inventoryQuantity' : ''}
      inventoryItem {
        id
        requiresShipping
        measurement {
          weight {
            value
            unit
          }
        }
      }
      product {
        id
        title
        description
        status
        createdAt
        updatedAt
        vendor
        productType
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`
}

type IntakeCommandAction =
  | 'confirm-address'
  | 'exclude-rejection'
  | 'fetch'
  | 'fetch-next'
  | 'fetch-next-products'
  | 'fetch-products'
  | 'mark-unsupported'
  | 'promote'
  | 'refresh'
  | 'retry-rejection'
  | 'resolve-catalog-product'
  | 'resolve-customer'
  | 'resolve-delivery'
  | 'resolve-package'
  | 'resolve-product'
  | 'validate'

export function commerceIntakeRuntimeAvailable() {
  if (process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED !== '1') return false
  const lane = String(
    process.env.CLAWPILOT_ENV
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || '',
  ).trim().toLowerCase()
  return ['dev', 'development', 'local', 'preview'].includes(lane)
}

export function assertCommerceIntakeRuntime() {
  if (process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED !== '1') {
    throw new CommerceIntegrationRequestError(
      'Commerce intake is not enabled in this environment',
      404,
      'COMMERCE_INTAKE_DISABLED',
    )
  }
  const lane = String(
    process.env.CLAWPILOT_ENV
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || '',
  ).trim().toLowerCase()
  if (
    !commerceIntakeRuntimeAvailable()
    && !['dev', 'development', 'local', 'preview'].includes(lane)
  ) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake is restricted to development environments',
      403,
      'COMMERCE_INTAKE_DEVELOPMENT_ONLY',
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake command is invalid',
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return value as Record<string, unknown>
}

function text(
  value: unknown,
  label: string,
  maximum = 500,
  minimum = 1,
) {
  const result = String(value || '').trim()
  if (
    result.length < minimum
    || result.length > maximum
    || /[\u0000-\u001f\u007f]/.test(result)
  ) {
    throw new CommerceIntegrationRequestError(
      `${label} is invalid`,
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function optionalText(value: unknown, label: string, maximum = 500) {
  if (value === null || value === undefined || value === '') return null
  return text(value, label, maximum)
}

function globalId(value: unknown, pattern: RegExp, label: string) {
  const result = text(value, label, 20)
  if (!pattern.test(result)) {
    throw new CommerceIntegrationRequestError(
      `${label} is invalid`,
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function idempotencyKey(value: unknown) {
  const result = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(result)) {
    throw new CommerceIntegrationRequestError(
      'A UUID idempotency key is required',
      400,
      'COMMERCE_INTAKE_IDEMPOTENCY_REQUIRED',
    )
  }
  return result
}

function rowVersion(value: unknown) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CommerceIntegrationRequestError(
      'Candidate row version is invalid',
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new CommerceIntegrationRequestError(
      `${label} is invalid`,
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function minorAmount(value: unknown) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0 || result > 9_000_000_000_000) {
    throw new CommerceIntegrationRequestError(
      'Order-line price is invalid',
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function currency(value: unknown) {
  const result = text(value, 'Currency', 3).toUpperCase()
  if (!/^[A-Z]{3}$/.test(result)) {
    throw new CommerceIntegrationRequestError(
      'Currency is invalid',
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function timestamp(value: unknown, label: string) {
  const result = text(value, label, 64)
  const parsed = new Date(result)
  if (Number.isNaN(parsed.getTime())) {
    throw new CommerceIntegrationRequestError(
      `${label} is invalid`,
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return parsed.toISOString()
}

function dimensions(value: unknown) {
  const input = record(value)
  return {
    length: positiveInteger(input.length, 'Package length', 20_000),
    width: positiveInteger(input.width, 'Package width', 20_000),
    height: positiveInteger(input.height, 'Package height', 20_000),
  }
}

function action(value: unknown): IntakeCommandAction {
  const result = String(value || '').trim() as IntakeCommandAction
  const allowed: IntakeCommandAction[] = [
    'confirm-address',
    'exclude-rejection',
    'fetch',
    'fetch-next',
    'fetch-next-products',
    'fetch-products',
    'mark-unsupported',
    'promote',
    'refresh',
    'retry-rejection',
    'resolve-catalog-product',
    'resolve-customer',
    'resolve-delivery',
    'resolve-package',
    'resolve-product',
    'validate',
  ]
  if (!allowed.includes(result)) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake action is invalid',
      400,
      'COMMERCE_INTAKE_COMMAND_INVALID',
    )
  }
  return result
}

function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function providerRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommerceIntegrationRequestError(
      `${label} returned an invalid paginated response`,
      502,
      'COMMERCE_INTAKE_PAGINATION_INVALID',
    )
  }
  return value as Record<string, unknown>
}

function providerNodes(value: unknown, label: string) {
  const connection = providerRecord(value, label)
  if (!Array.isArray(connection.nodes)) {
    throw new CommerceIntegrationRequestError(
      `${label} returned an invalid record page`,
      502,
      'COMMERCE_INTAKE_PAGINATION_INVALID',
    )
  }
  return connection.nodes.map((node) => providerRecord(node, label))
}

function nextShopifyCursor(value: unknown, label: string) {
  const connection = providerRecord(value, label)
  const pageInfo = providerRecord(connection.pageInfo, label)
  if (pageInfo.hasNextPage !== true) return null
  const cursor = typeof pageInfo.endCursor === 'string'
    ? pageInfo.endCursor.trim()
    : ''
  if (!cursor || cursor.length > 4_096) {
    throw new CommerceIntegrationRequestError(
      `${label} did not provide the next page cursor`,
      502,
      'COMMERCE_INTAKE_PAGINATION_INVALID',
    )
  }
  return cursor
}

function completeConnection(nodes: readonly Record<string, unknown>[]) {
  return {
    nodes,
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
    },
  }
}

type OperationalPageRequest = {
  mode: 'operational'
  resource: 'orders' | 'products'
  sessionId: string
  batchNumber: number
  previousRunGlobalId: string | null
  windowStart: string | null
  windowEnd: string
  queryHash: string
  orderCursor: string | null
  cursorHash: string | null
}

type OperationalPageResult = {
  envelope: CommerceNormalizationEnvelope
  page: {
    mode: 'operational'
    resource: 'orders' | 'products'
    sessionId: string
    batchNumber: number
    previousRunGlobalId: string | null
    windowStart: string | null
    windowEnd: string
    queryHash: string
    nextOrderCursor: string | null
    providerRowsSeen: number
    eligibleOrdersSeen: number
  }
}

function operationalOrders(envelope: CommerceNormalizationEnvelope) {
  return envelope.orders.filter((order) => (
    order.canonicalStates.lifecycle !== 'cancelled'
    && order.canonicalStates.lifecycle !== 'closed'
    && order.canonicalStates.fulfillment !== 'fulfilled'
  ))
}

function envelopeWith(
  envelope: CommerceNormalizationEnvelope,
  input: {
    rejections?: readonly CommerceNormalizationRejection[]
    operationalOnly?: boolean
  },
): CommerceNormalizationEnvelope {
  return Object.freeze({
    ...envelope,
    orders: Object.freeze(
      input.operationalOnly ? operationalOrders(envelope) : envelope.orders,
    ),
    rejections: Object.freeze([
      ...envelope.rejections,
      ...(input.rejections || []),
    ]),
  })
}

async function completeShopifyOrderLines(input: {
  credential: { shopDomain: string; accessToken: string }
  order: Record<string, unknown>
  budget: { remainingRequests: number; remainingLines: number }
}): Promise<
  | { order: Record<string, unknown>; rejection: null }
  | { order: null; rejection: CommerceNormalizationRejection }
> {
  const identity = typeof input.order.id === 'string'
    ? input.order.id.trim()
    : ''
  const rejected = (
    errorCode:
      | 'COMMERCE_ORDER_LINE_PAGINATION_LIMIT'
      | 'COMMERCE_ORDER_RECORD_INVALID',
  ) => ({
    order: null,
    rejection: createCommerceNormalizationRejection({
      resourceType: 'order',
      source: input.order,
      externalId: identity || undefined,
      errorCode,
    }),
  } as const)
  if (!identity) {
    return rejected('COMMERCE_ORDER_RECORD_INVALID')
  }
  try {
    const initial = input.order.lineItems
    const nodes = [...providerNodes(initial, 'Shopify order lines')]
    if (nodes.length > input.budget.remainingLines) {
      return rejected('COMMERCE_ORDER_LINE_PAGINATION_LIMIT')
    }
    const cursors = new Set<string>()
    let pages = 1
    let cursor = nextShopifyCursor(initial, 'Shopify order lines')
    while (cursor) {
      if (
        pages >= SHOPIFY_MAX_ORDER_LINE_PAGES
        || input.budget.remainingRequests < 1
      ) {
        return rejected('COMMERCE_ORDER_LINE_PAGINATION_LIMIT')
      }
      if (cursors.has(cursor)) {
        return rejected('COMMERCE_ORDER_RECORD_INVALID')
      }
      cursors.add(cursor)
      input.budget.remainingRequests -= 1
      const data = await shopifyAdminGraphql<Record<string, unknown>>(
        input.credential,
        {
          query: SHOPIFY_ORDER_LINES_QUERY,
          operationName: 'ClawPilotCommerceOrderLines',
          variables: { id: identity, after: cursor },
        },
        { timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS },
      )
      const order = providerRecord(data.order, 'Shopify order')
      if (order.id !== identity) {
        return rejected('COMMERCE_ORDER_RECORD_INVALID')
      }
      const connection = order.lineItems
      const pageNodes = providerNodes(connection, 'Shopify order lines')
      if (nodes.length + pageNodes.length > input.budget.remainingLines) {
        return rejected('COMMERCE_ORDER_LINE_PAGINATION_LIMIT')
      }
      nodes.push(...pageNodes)
      pages += 1
      cursor = nextShopifyCursor(connection, 'Shopify order lines')
    }
    input.budget.remainingLines -= nodes.length
    return {
      order: {
        ...input.order,
        lineItems: completeConnection(nodes),
      },
      rejection: null,
    }
  } catch {
    return rejected('COMMERCE_ORDER_RECORD_INVALID')
  }
}

function faireCollection(value: unknown, key: 'orders' | 'products') {
  const page = providerRecord(value, `Faire ${key}`)
  const collection = page[key]
  if (!Array.isArray(collection)) {
    throw new CommerceIntegrationRequestError(
      `Faire ${key} returned an invalid record page`,
      502,
      'COMMERCE_INTAKE_PAGINATION_INVALID',
    )
  }
  return collection.map((entry) => providerRecord(entry, `Faire ${key}`))
}

function nextFaireCursor(value: unknown, label: string) {
  const page = providerRecord(value, label)
  const paginationValue = page.pagination ?? page.page_info ?? page.pageInfo
  const pagination = (
    paginationValue
    && typeof paginationValue === 'object'
    && !Array.isArray(paginationValue)
  )
    ? paginationValue as Record<string, unknown>
    : {}
  const raw = (
    page.next_cursor
    ?? page.nextCursor
    ?? pagination.next_cursor
    ?? pagination.nextCursor
  )
  const cursor = typeof raw === 'string' ? raw.trim() : ''
  const hasMore = (
    page.truncated === true
    || page.has_more === true
    || page.hasNextPage === true
    || pagination.has_more === true
    || pagination.hasNextPage === true
    || Boolean(cursor)
  )
  if (!hasMore) return null
  if (!cursor || cursor.length > 4_096) {
    throw new CommerceIntegrationRequestError(
      `${label} did not provide the next page cursor`,
      502,
      'COMMERCE_INTAKE_PAGINATION_INVALID',
    )
  }
  return cursor
}

function completedFairePage(
  firstPage: Record<string, unknown>,
  key: 'orders' | 'products',
  values: readonly Record<string, unknown>[],
) {
  const paginationValue = firstPage.pagination
    ?? firstPage.page_info
    ?? firstPage.pageInfo
  const pagination = (
    paginationValue
    && typeof paginationValue === 'object'
    && !Array.isArray(paginationValue)
  )
    ? paginationValue as Record<string, unknown>
    : {}
  return {
    ...firstPage,
    [key]: values,
    truncated: false,
    has_more: false,
    hasNextPage: false,
    next_cursor: null,
    nextCursor: null,
    pagination: {
      ...pagination,
      has_more: false,
      hasNextPage: false,
      next_cursor: null,
      nextCursor: null,
    },
    page_info: null,
    pageInfo: null,
  }
}

function providerConnectionHasMore(value: unknown) {
  const connection = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const pageInfo = (
    connection.pagination
    ?? connection.page_info
    ?? connection.pageInfo
  )
  const pagination = (
    pageInfo && typeof pageInfo === 'object' && !Array.isArray(pageInfo)
  )
    ? pageInfo as Record<string, unknown>
    : {}
  return (
    connection.truncated === true
    || connection.has_more === true
    || connection.hasNextPage === true
    || pagination.has_more === true
    || pagination.hasNextPage === true
    || Boolean(
      connection.next_cursor
      ?? connection.nextCursor
      ?? pagination.next_cursor
      ?? pagination.nextCursor,
    )
  )
}

function boundedFaireOrders(orders: readonly Record<string, unknown>[]) {
  const accepted: Record<string, unknown>[] = []
  const rejections: CommerceNormalizationRejection[] = []
  let acceptedLines = 0
  for (const order of orders) {
    const items = order.items ?? order.order_items
    const itemRecord = (
      items && typeof items === 'object' && !Array.isArray(items)
    )
      ? items as Record<string, unknown>
      : null
    const values = Array.isArray(items)
      ? items
      : Array.isArray(itemRecord?.nodes)
        ? itemRecord.nodes
        : Array.isArray(itemRecord?.items)
          ? itemRecord.items
          : []
    if (
      values.length > FAIRE_MAX_EMBEDDED_ORDER_LINES
      || acceptedLines + values.length > FAIRE_MAX_BATCH_ORDER_LINES
      || providerConnectionHasMore(items)
    ) {
      rejections.push(createCommerceNormalizationRejection({
        resourceType: 'order',
        source: order,
        externalId: order.id ?? order.order_id,
        errorCode: 'COMMERCE_ORDER_LINE_PAGINATION_LIMIT',
      }))
      continue
    }
    accepted.push(order)
    acceptedLines += values.length
  }
  return { accepted, rejections }
}

function boundedFaireProducts(products: readonly Record<string, unknown>[]) {
  const accepted: Record<string, unknown>[] = []
  const rejections: CommerceNormalizationRejection[] = []
  let acceptedVariants = 0
  for (const product of products) {
    const variants = (
      product.variants
      ?? product.product_variants
      ?? product.productVariants
    )
    const variantRecord = (
      variants && typeof variants === 'object' && !Array.isArray(variants)
    )
      ? variants as Record<string, unknown>
      : null
    const values = Array.isArray(variants)
      ? variants
      : Array.isArray(variantRecord?.nodes)
        ? variantRecord.nodes
        : Array.isArray(variantRecord?.items)
          ? variantRecord.items
          : []
    if (
      values.length > FAIRE_MAX_PRODUCT_VARIANTS
      || acceptedVariants + values.length
        > FAIRE_MAX_BATCH_PRODUCT_VARIANTS
      || providerConnectionHasMore(variants)
    ) {
      rejections.push(createCommerceNormalizationRejection({
        resourceType: 'product',
        source: product,
        externalId: product.id ?? product.product_id,
        errorCode: 'COMMERCE_PRODUCT_VARIANT_PAGINATION_LIMIT',
      }))
      continue
    }
    accepted.push(product)
    acceptedVariants += values.length
  }
  return { accepted, rejections }
}

function normalizationContext(
  runtime: CommerceRuntimeCredentialRecord,
  sourceState: 'current' | 'stale' = 'current',
): CommerceNormalizationContext {
  const observedAt = new Date()
  return {
    organizationId: runtime.organizationId,
    integrationAccountId: runtime.integrationAccountId,
    externalAccountId: runtime.externalAccountId,
    apiVersion: runtime.provider === 'shopify'
      ? '2026-07'
      : 'v2',
    observedAt: observedAt.toISOString(),
    credentialGeneration: runtime.credentialVersion,
    retentionExpiresAt: new Date(
      observedAt.getTime() + INTAKE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    sourceState,
  }
}

async function runtimeFor(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId,
    accountGlobalId,
  })
  if (!runtime || runtime.verificationStatus !== 'verified') {
    throw new CommerceIntegrationRequestError(
      'Verify the commerce connection before reading orders and products',
      409,
      'COMMERCE_INTAKE_VERIFICATION_REQUIRED',
    )
  }
  if (runtime.status === 'error') {
    throw new CommerceIntegrationRequestError(
      'Repair the commerce connection before reading orders and products',
      409,
      'COMMERCE_INTAKE_CONNECTION_ERROR',
    )
  }
  return runtime
}

async function shopifyEnvelope(
  runtime: CommerceRuntimeCredentialRecord,
  page: OperationalPageRequest,
  targetExternalOrderId: string | null = null,
): Promise<OperationalPageResult> {
  const credential = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'shopify') {
    throw new Error('Stored commerce credential could not be decrypted')
  }
  const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  })
  if (
    !grant.grantedScopes.includes('read_orders')
    || !grant.grantedScopes.includes('read_all_orders')
  ) {
    throw new CommerceIntegrationRequestError(
      'Shopify must grant read_orders and read_all_orders for complete operational intake',
      409,
      'COMMERCE_INTAKE_SCOPE_REQUIRED',
    )
  }
  const probe = await probeShopifyConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    throw new CommerceIntegrationRequestError(
      'Shopify returned a different store identity',
      409,
      'SHOPIFY_STORE_IDENTITY_CHANGED',
    )
  }
  const providerCredential = { shopDomain, accessToken: grant.accessToken }
  const includeCustomerIdentity = grant.grantedScopes.includes('read_customers')
  const data = targetExternalOrderId
    ? await shopifyAdminGraphql<Record<string, unknown>>(
        providerCredential,
        {
          query: shopifyOrderQuery(includeCustomerIdentity),
          operationName: 'ClawPilotCommerceOrder',
          variables: { id: targetExternalOrderId },
        },
        { timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS },
      )
    : await shopifyAdminGraphql<Record<string, unknown>>(
        providerCredential,
        {
          query: shopifyOrdersQuery(includeCustomerIdentity),
          operationName: 'ClawPilotCommerceOrders',
          variables: {
            after: page.orderCursor,
            query: `test:false status:open updated_at:<='${page.windowEnd}'`,
          },
        },
        { timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS },
      )
  const connection = targetExternalOrderId
    ? null
    : data.orders
  const orderNodes = targetExternalOrderId
    ? (
        data.order && typeof data.order === 'object' && !Array.isArray(data.order)
          ? [providerRecord(data.order, 'Shopify order')]
          : []
      )
    : providerNodes(connection, 'Shopify orders')
  const nextOrderCursor = targetExternalOrderId
    ? null
    : nextShopifyCursor(connection, 'Shopify orders')
  const orders: Record<string, unknown>[] = []
  const rejections: CommerceNormalizationRejection[] = []
  const lineBudget = {
    remainingRequests: targetExternalOrderId
      ? SHOPIFY_MAX_ORDER_LINE_PAGES - 1
      : SHOPIFY_MAX_NESTED_LINE_REQUESTS,
    remainingLines: targetExternalOrderId
      ? SHOPIFY_ORDER_LINE_PAGE_SIZE * SHOPIFY_MAX_ORDER_LINE_PAGES
      : SHOPIFY_MAX_BATCH_ORDER_LINES,
  }
  for (const order of orderNodes) {
    const result = await completeShopifyOrderLines({
      credential: providerCredential,
      order,
      budget: lineBudget,
    })
    if (result.order) orders.push(result.order)
    if (result.rejection) rejections.push(result.rejection)
  }
  const normalized = envelopeWith(normalizeShopifyCommerce({
    data: {
      products: completeConnection([]),
      orders: completeConnection(orders),
    },
    shopDomain,
  }, normalizationContext(runtime)), {
    operationalOnly: !targetExternalOrderId,
    rejections,
  })
  return {
    envelope: normalized,
    page: {
      mode: 'operational',
      resource: 'orders',
      sessionId: page.sessionId,
      batchNumber: page.batchNumber,
      previousRunGlobalId: page.previousRunGlobalId,
      windowStart: page.windowStart,
      windowEnd: page.windowEnd,
      queryHash: page.queryHash,
      nextOrderCursor,
      providerRowsSeen: orderNodes.length,
      eligibleOrdersSeen: normalized.orders.length,
    },
  }
}

async function shopifyProductEnvelope(
  runtime: CommerceRuntimeCredentialRecord,
  page: OperationalPageRequest,
): Promise<OperationalPageResult> {
  const credential = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'shopify') {
    throw new Error('Stored commerce credential could not be decrypted')
  }
  const shopDomain = normalizeShopifyShopDomain(runtime.configuration.shopDomain)
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  })
  if (!grant.grantedScopes.includes('read_products')) {
    throw new CommerceIntegrationRequestError(
      'Shopify must grant read_products for catalog intake',
      409,
      'COMMERCE_INTAKE_SCOPE_REQUIRED',
    )
  }
  const probe = await probeShopifyConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== runtime.externalAccountId) {
    throw new CommerceIntegrationRequestError(
      'Shopify returned a different store identity',
      409,
      'SHOPIFY_STORE_IDENTITY_CHANGED',
    )
  }
  const data = await shopifyAdminGraphql<Record<string, unknown>>(
    {
      shopDomain,
      accessToken: grant.accessToken,
    },
    {
      query: shopifyProductVariantsQuery(
        grant.grantedScopes.includes('read_inventory'),
      ),
      operationName: 'ClawPilotCommerceProductVariants',
      variables: {
        after: page.orderCursor,
        query: `updated_at:<='${page.windowEnd}'`,
      },
    },
    { timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS },
  )
  const connection = data.productVariants
  const variantNodes = providerNodes(connection, 'Shopify product variants')
  const nextProductCursor = nextShopifyCursor(
    connection,
    'Shopify product variants',
  )
  const productsByIdentity = new Map<string, {
    product: Record<string, unknown>
    variants: Record<string, unknown>[]
  }>()
  const rejections: CommerceNormalizationRejection[] = []
  for (const variant of variantNodes) {
    const product = (
      variant.product
      && typeof variant.product === 'object'
      && !Array.isArray(variant.product)
    )
      ? variant.product as Record<string, unknown>
      : null
    const productIdentity = typeof product?.id === 'string'
      ? product.id.trim()
      : ''
    if (!productIdentity || !product) {
      rejections.push(createCommerceNormalizationRejection({
        resourceType: 'product',
        source: variant,
        errorCode: 'COMMERCE_PRODUCT_RECORD_INVALID',
      }))
      continue
    }
    const grouped = productsByIdentity.get(productIdentity) || {
      product,
      variants: [] as Record<string, unknown>[],
    }
    grouped.variants.push(variant)
    productsByIdentity.set(productIdentity, grouped)
  }
  const productNodes = [...productsByIdentity.values()].map((grouped) => ({
    ...grouped.product,
    variants: completeConnection(grouped.variants),
  }))
  const normalized = envelopeWith(normalizeShopifyCommerce({
    data: {
      shop: data.shop,
      products: completeConnection(productNodes),
      orders: completeConnection([]),
    },
    shopDomain,
  }, normalizationContext(runtime)), {
    rejections,
  })
  const normalizedVariants = normalized.products.reduce(
    (count, product) => count + product.variants.length,
    0,
  )
  return {
    envelope: normalized,
    page: {
      mode: 'operational',
      resource: 'products',
      sessionId: page.sessionId,
      batchNumber: page.batchNumber,
      previousRunGlobalId: page.previousRunGlobalId,
      windowStart: page.windowStart,
      windowEnd: page.windowEnd,
      queryHash: page.queryHash,
      nextOrderCursor: nextProductCursor,
      providerRowsSeen: variantNodes.length,
      eligibleOrdersSeen: normalizedVariants,
    },
  }
}

async function faireEnvelope(
  runtime: CommerceRuntimeCredentialRecord,
  page: OperationalPageRequest,
  targetExternalOrderId: string | null = null,
): Promise<OperationalPageResult> {
  const credential = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'faire') {
    throw new Error('Stored commerce credential could not be decrypted')
  }
  if (
    credential.authMode === 'faire_oauth'
    && !credential.scopes.includes('READ_ORDERS')
  ) {
    throw new CommerceIntegrationRequestError(
      'Faire must grant READ_ORDERS for operational intake',
      409,
      'COMMERCE_INTAKE_SCOPE_REQUIRED',
    )
  }
  const options = credential.authMode === 'faire_oauth'
      ? {
        accessToken: credential.accessToken,
        applicationId: credential.applicationId,
        applicationSecret: credential.applicationSecret,
        timeoutMs: 15_000,
      }
    : {
        accessToken: credential.accessToken,
        timeoutMs: 15_000,
      }
  const providerPage = targetExternalOrderId
    ? {
        orders: [await getFaireOrder(options, targetExternalOrderId)],
      }
    : await listFaireOrders(options, {
        cursor: page.orderCursor,
        limit: FAIRE_ORDER_PAGE_SIZE,
      })
  const orderNodes = faireCollection(providerPage, 'orders')
  const nextOrderCursor = targetExternalOrderId
    ? null
    : nextFaireCursor(providerPage, 'Faire orders')
  const bounded = boundedFaireOrders(orderNodes)
  const normalized = envelopeWith(normalizeFaireCommerce({
    brand: { id: runtime.externalAccountId },
    orders: completedFairePage(providerPage, 'orders', bounded.accepted),
    products: completedFairePage({ products: [] }, 'products', []),
  }, normalizationContext(
    runtime,
    targetExternalOrderId ? 'current' : 'stale',
  )), {
    operationalOnly: !targetExternalOrderId,
    rejections: bounded.rejections,
  })
  return {
    envelope: normalized,
    page: {
      mode: 'operational',
      resource: 'orders',
      sessionId: page.sessionId,
      batchNumber: page.batchNumber,
      previousRunGlobalId: page.previousRunGlobalId,
      windowStart: page.windowStart,
      windowEnd: page.windowEnd,
      queryHash: page.queryHash,
      nextOrderCursor,
      providerRowsSeen: orderNodes.length,
      eligibleOrdersSeen: normalized.orders.length,
    },
  }
}

async function faireProductEnvelope(
  runtime: CommerceRuntimeCredentialRecord,
  page: OperationalPageRequest,
): Promise<OperationalPageResult> {
  const credential = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (credential.provider !== 'faire') {
    throw new Error('Stored commerce credential could not be decrypted')
  }
  if (
    credential.authMode === 'faire_oauth'
    && !credential.scopes.includes('READ_PRODUCTS')
  ) {
    throw new CommerceIntegrationRequestError(
      'Faire must grant READ_PRODUCTS for catalog intake',
      409,
      'COMMERCE_INTAKE_SCOPE_REQUIRED',
    )
  }
  const options = credential.authMode === 'faire_oauth'
    ? {
        accessToken: credential.accessToken,
        applicationId: credential.applicationId,
        applicationSecret: credential.applicationSecret,
        timeoutMs: 15_000,
      }
    : {
        accessToken: credential.accessToken,
        timeoutMs: 15_000,
      }
  const providerPage = await listFaireProducts(options, {
    cursor: page.orderCursor,
    limit: FAIRE_PRODUCT_PAGE_SIZE,
  })
  const productNodes = faireCollection(providerPage, 'products')
  const nextProductCursor = nextFaireCursor(providerPage, 'Faire products')
  const bounded = boundedFaireProducts(productNodes)
  const context = normalizationContext(runtime, 'stale')
  const normalizedSource = {
    brand: { id: runtime.externalAccountId },
    orders: completedFairePage({ orders: [] }, 'orders', []),
    products: completedFairePage(
      providerPage,
      'products',
      bounded.accepted,
    ),
  }
  const baseNormalized = normalizeFaireCommerce(normalizedSource, context)
  const canReadInventory = (
    credential.authMode === 'faire_oauth'
    && credential.scopes.includes('READ_INVENTORIES')
  )
  let providerNormalized = baseNormalized
  if (canReadInventory) {
    const variantIds = [...new Set(baseNormalized.products.flatMap(
      (product) => product.variants.map((variant) => variant.identity.value),
    ))]
    const requestCount = Math.ceil(
      variantIds.length / FAIRE_INVENTORY_SELECTOR_LIMIT,
    )
    if (requestCount > FAIRE_MAX_INVENTORY_REQUESTS) {
      throw new CommerceIntegrationRequestError(
        'Faire inventory hydration exceeded the bounded request budget',
        502,
        'COMMERCE_INTAKE_PAGINATION_LIMIT',
      )
    }
    const inventories: Record<string, unknown> = {}
    for (
      let offset = 0;
      offset < variantIds.length;
      offset += FAIRE_INVENTORY_SELECTOR_LIMIT
    ) {
      const response = await listFaireInventory(options, {
        productVariantIds: variantIds.slice(
          offset,
          offset + FAIRE_INVENTORY_SELECTOR_LIMIT,
        ),
      })
      Object.assign(inventories, response.inventories)
    }
    providerNormalized = normalizeFaireCommerce({
      ...normalizedSource,
      inventories,
    }, context)
  }
  const normalized = envelopeWith(providerNormalized, {
    rejections: bounded.rejections,
  })
  return {
    envelope: normalized,
    page: {
      mode: 'operational',
      resource: 'products',
      sessionId: page.sessionId,
      batchNumber: page.batchNumber,
      previousRunGlobalId: page.previousRunGlobalId,
      windowStart: page.windowStart,
      windowEnd: page.windowEnd,
      queryHash: page.queryHash,
      nextOrderCursor: nextProductCursor,
      providerRowsSeen: productNodes.length,
      eligibleOrdersSeen: normalized.products.length,
    },
  }
}

async function fetchEnvelope(
  runtime: CommerceRuntimeCredentialRecord,
  page: OperationalPageRequest,
  targetExternalOrderId: string | null = null,
): Promise<OperationalPageResult> {
  return page.resource === 'products'
    ? runtime.provider === 'shopify'
      ? shopifyProductEnvelope(runtime, page)
      : faireProductEnvelope(runtime, page)
    : runtime.provider === 'shopify'
      ? shopifyEnvelope(runtime, page, targetExternalOrderId)
      : faireEnvelope(runtime, page, targetExternalOrderId)
}

export async function getCommerceIntake(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  assertCommerceIntakeRuntime()
  const runtime = await runtimeFor(input)
  return readCommerceIntakeStateFromPostgres({
    organizationId: runtime.organizationId,
    accountGlobalId: runtime.globalId,
  })
}

export async function executeCommerceIntakeCommand(input: {
  organizationId: unknown
  actorEmail: string
  body: Record<string, unknown>
}) {
  assertCommerceIntakeRuntime()
  const commandAction = action(input.body.action)
  const key = idempotencyKey(input.body.idempotencyKey)
  const runtime = await runtimeFor({
    organizationId: input.organizationId,
    accountGlobalId: input.body.accountGlobalId,
  })
  const shared = {
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: key,
  }

  if (
    commandAction === 'fetch'
    || commandAction === 'fetch-next'
    || commandAction === 'fetch-products'
    || commandAction === 'fetch-next-products'
    || commandAction === 'refresh'
    || commandAction === 'retry-rejection'
  ) {
    if (input.body.confirmReadOnly !== true) {
      throw new CommerceIntegrationRequestError(
        'Confirm the read-only provider fetch',
        400,
        'COMMERCE_INTAKE_READ_CONFIRMATION_REQUIRED',
      )
    }
    const resource: 'orders' | 'products' = (
      commandAction === 'fetch-products'
      || commandAction === 'fetch-next-products'
    )
      ? 'products'
      : 'orders'
    const refreshCandidateGlobalId = commandAction === 'refresh'
      ? globalId(
        input.body.candidateGlobalId,
        CANDIDATE_PATTERN,
        'Candidate Global ID',
      )
      : null
    const retryRejectionGlobalId = commandAction === 'retry-rejection'
      ? globalId(
          input.body.rejectionGlobalId,
          REJECTION_PATTERN,
          'Rejection Global ID',
        )
      : null
    const continuationRunGlobalId = (
      commandAction === 'fetch-next'
      || commandAction === 'fetch-next-products'
    )
      ? globalId(
        input.body.continuationRunGlobalId,
        RUN_PATTERN,
        'Continuation run Global ID',
      )
      : null
    const replayTarget = refreshCandidateGlobalId
      ? {
          kind: 'candidate' as const,
          globalId: refreshCandidateGlobalId,
        }
      : retryRejectionGlobalId
        ? {
            kind: 'rejection' as const,
            globalId: retryRejectionGlobalId,
          }
        : continuationRunGlobalId
          ? {
              kind: 'continuation' as const,
              globalId: continuationRunGlobalId,
            }
          : {
              kind: 'none' as const,
              globalId: null,
            }
    const replay = await readCommerceIntakeStageReplayFromPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
      idempotencyKey: key,
      action: commandAction,
      target: replayTarget,
    })
    if (replay) {
      return {
        command: replay,
        intake: await readCommerceIntakeStateFromPostgres({
          organizationId: runtime.organizationId,
          accountGlobalId: runtime.globalId,
        }),
      }
    }
    const refreshTarget = refreshCandidateGlobalId
      ? await readCommerceIntakeRefreshTargetFromPostgres({
          organizationId: runtime.organizationId,
          accountGlobalId: runtime.globalId,
          candidateGlobalId: refreshCandidateGlobalId,
        })
      : null
    const rejectionTarget = retryRejectionGlobalId
      ? await readCommerceIntakeRejectionTargetFromPostgres({
          organizationId: runtime.organizationId,
          accountGlobalId: runtime.globalId,
          rejectionGlobalId: retryRejectionGlobalId,
        })
      : null
    const targetProvider = refreshTarget?.provider || rejectionTarget?.provider
    if (targetProvider && targetProvider !== runtime.provider) {
      throw new CommerceIntegrationRequestError(
        'The selected record does not match this commerce connection',
        409,
        'COMMERCE_NORMALIZATION_SCOPE_MISMATCH',
      )
    }
    if (rejectionTarget?.resource_type === 'product') {
      throw new CommerceIntegrationRequestError(
        'This product rejection cannot be safely re-read by identity. Exclude it with a reason, then fetch the catalog again after correcting the provider record.',
        409,
        'COMMERCE_INTAKE_REJECTION_EXCLUSION_REQUIRED',
      )
    }
    let page: OperationalPageRequest
    let readIntentId: string
    try {
      const target: CommerceIntakeReadIntentTarget = refreshTarget
        ? {
            kind: 'candidate',
            globalId: refreshCandidateGlobalId as string,
            externalId: refreshTarget.external_order_id,
            sourceHash: refreshTarget.source_hash,
          }
        : rejectionTarget
          ? {
              kind: 'rejection',
              globalId: retryRejectionGlobalId as string,
              externalId: rejectionTarget.external_id,
              sourceHash: rejectionTarget.source_hash,
            }
          : { kind: 'none' }
      const intentAction = commandAction as CommerceIntakeReadIntentAction
      const prepared = await prepareCommerceIntakeReadIntentInPostgres({
        ...shared,
        action: intentAction,
        resource,
        target,
        continuationRunGlobalId,
        pageSize: (
          refreshTarget || rejectionTarget
            ? 1
            : resource === 'products'
              ? runtime.provider === 'shopify'
                ? SHOPIFY_PRODUCT_VARIANT_PAGE_SIZE
                : FAIRE_PRODUCT_PAGE_SIZE
              : runtime.provider === 'shopify'
                ? SHOPIFY_ORDER_PAGE_SIZE
                : FAIRE_ORDER_PAGE_SIZE
        ),
      })
      readIntentId = prepared.id
      page = prepared
    } catch (error) {
      if (
        continuationRunGlobalId
        && !(error instanceof CommerceIntegrationRequestError)
      ) {
        await markCommerceIntakeContinuationInvalidInPostgres({
          organizationId: runtime.organizationId,
          accountGlobalId: runtime.globalId,
          continuationRunGlobalId,
          actorEmail: input.actorEmail,
        }).catch(() => undefined)
      }
      if (!(error instanceof CommerceIntegrationRequestError)) {
        if (!continuationRunGlobalId) {
          throw new CommerceIntegrationRequestError(
            `The read-only ${resource} request could not be prepared. Retry the same action; no provider request was sent.`,
            500,
            'COMMERCE_INTAKE_READ_PREPARATION_FAILED',
          )
        }
        throw new CommerceIntegrationRequestError(
          `The saved ${resource} batch cannot be resumed. Restart that read-only fetch.`,
          409,
          'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
        )
      }
      throw error
    }
    const targetExternalOrderId = refreshTarget?.external_order_id
      || rejectionTarget?.external_id
      || null
    const pageSize = targetExternalOrderId
      ? 1
      : resource === 'products'
        ? runtime.provider === 'shopify'
          ? SHOPIFY_PRODUCT_VARIANT_PAGE_SIZE
          : FAIRE_PRODUCT_PAGE_SIZE
        : runtime.provider === 'shopify'
          ? SHOPIFY_ORDER_PAGE_SIZE
          : FAIRE_ORDER_PAGE_SIZE
    const redactedRequest = {
      policyVersion: INTAKE_POLICY_VERSION,
      credentialVersion: runtime.credentialVersion,
      mode: page.mode,
      resource: page.resource,
      batchNumber: page.batchNumber,
      continuationPresent: Boolean(page.orderCursor),
      continuationCursorHash: page.cursorHash,
      targetedRead: Boolean(targetExternalOrderId),
      targetHash: targetExternalOrderId
        ? requestHash(targetExternalOrderId)
        : null,
      pageSize,
      productsFetched: page.resource === 'products',
      oneRootPage: !targetExternalOrderId,
      readOnly: true,
      providerWrites: 0,
      syncCursorAdvanced: false,
    }
    const adapterVersion =
      `commerce-normalization-${runtime.provider}-v1`
    const reservation = await reserveCommerceIntakeProviderReadInPostgres({
      ...shared,
      readIntentId,
      adapterVersion,
      redactedRequest,
    })
    let captured: {
      result: OperationalPageResult
      responseHash: string
    }
    if (reservation.kind === 'captured') {
      captured = {
        result: reservation.result as OperationalPageResult,
        responseHash: reservation.responseHash,
      }
    } else {
      try {
        const result = await fetchEnvelope(
          runtime,
          page,
          targetExternalOrderId,
        )
        const normalizedVariants = result.envelope.products.reduce(
          (count, product) => count + product.variants.length,
          0,
        )
        const durable = await captureCommerceIntakeProviderReadInPostgres({
          ...shared,
          readIntentId,
          providerAttemptId: reservation.providerAttemptId,
          leaseToken: reservation.leaseToken,
          requestHash: reservation.requestHash,
          result,
          redactedResponse: {
            providerRowsSeen: result.page.providerRowsSeen,
            ordersNormalized: result.envelope.orders.length,
            productsNormalized: result.envelope.products.length,
            variantsNormalized: normalizedVariants,
            recordsRejected: result.envelope.rejections.length,
            hasNextBatch: Boolean(result.page.nextOrderCursor),
            providerWrites: 0,
            syncCursorAdvanced: false,
          },
        })
        captured = {
          result: durable.result as OperationalPageResult,
          responseHash: durable.responseHash,
        }
      } catch (error) {
        const sanitized = sanitizedCommerceIntegrationError(error)
        await markCommerceIntakeProviderReadUncertainInPostgres({
          ...shared,
          readIntentId,
          providerAttemptId: reservation.providerAttemptId,
          leaseToken: reservation.leaseToken,
          errorCode: sanitized.code,
        }).catch(() => undefined)
        throw new CommerceIntegrationRequestError(
          page.previousRunGlobalId
            ? 'The provider read outcome is uncertain. Reload, then use Restart session to begin a new bounded read.'
            : 'The provider read outcome is uncertain. Retry the action to begin a newly reserved bounded read.',
          409,
          'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
        )
      }
    }
    const result = captured.result
    const command = await stageCommerceNormalizationEnvelopeInPostgres({
      ...shared,
      envelope: result.envelope,
      stageAction: commandAction,
      page: (
        commandAction === 'refresh'
        || commandAction === 'retry-rejection'
      )
        ? null
        : result.page,
      refreshCandidateGlobalId,
      retryRejectionGlobalId,
      readIntentId,
      capturedResponseHash: captured.responseHash,
    })
    return {
      command,
      intake: await readCommerceIntakeStateFromPostgres({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
      }),
    }
  }

  if (commandAction === 'exclude-rejection') {
    const command = await excludeCommerceIntakeRejectionInPostgres({
      ...shared,
      rejectionGlobalId: globalId(
        input.body.rejectionGlobalId,
        REJECTION_PATTERN,
        'Rejection Global ID',
      ),
      rejectionRowVersion: rowVersion(input.body.rowVersion),
      reason: text(input.body.reason, 'Exclusion reason', 500),
    })
    return {
      command,
      intake: await readCommerceIntakeStateFromPostgres({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
      }),
    }
  }

  if (commandAction === 'resolve-catalog-product') {
    const candidateGlobalId = globalId(
      input.body.candidateGlobalId,
      PRODUCT_CANDIDATE_PATTERN,
      'Product candidate Global ID',
    )
    const resolution = record(input.body.resolution)
    const mode = text(
      resolution.mode,
      'Catalog product resolution mode',
      20,
    )
    if (!['existing', 'create', 'exclude'].includes(mode)) {
      throw new CommerceIntegrationRequestError(
        'Catalog product resolution must select, create, or exclude',
        400,
        'COMMERCE_INTAKE_COMMAND_INVALID',
      )
    }
    const command = await resolveCommerceProductCandidateInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: rowVersion(input.body.rowVersion),
      resolution: mode === 'existing'
        ? {
            mode: 'existing',
            productGlobalId: globalId(
              resolution.productGlobalId,
              PRODUCT_PATTERN,
              'Product Global ID',
            ),
          } as const
        : mode === 'create'
          ? {
              mode: 'create',
              name: text(resolution.name, 'Product name', 255),
              sku: optionalText(resolution.sku, 'Product SKU', 25),
              unitPriceMinor: minorAmount(resolution.unitPriceMinor),
              currency: currency(resolution.currency),
            } as const
          : {
              mode: 'exclude',
              reasonCode: text(
                resolution.reasonCode,
                'Exclusion reason code',
                128,
              ),
              reason: text(
                resolution.reason,
                'Exclusion reason',
                1_000,
              ),
            } as const,
    })
    return {
      command,
      intake: await readCommerceIntakeStateFromPostgres({
        organizationId: runtime.organizationId,
        accountGlobalId: runtime.globalId,
      }),
    }
  }

  const candidateGlobalId = globalId(
    input.body.candidateGlobalId,
    CANDIDATE_PATTERN,
    'Candidate Global ID',
  )
  const version = rowVersion(input.body.rowVersion)
  let command: unknown

  if (commandAction === 'resolve-product') {
    const product = record(input.body.product)
    const mode = text(product.mode, 'Product resolution mode', 20)
    if (mode !== 'existing' && mode !== 'create') {
      throw new CommerceIntegrationRequestError(
        'Product resolution mode must be existing or create',
        400,
        'COMMERCE_INTAKE_COMMAND_INVALID',
      )
    }
    command = await resolveCommerceCandidateProductInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      lineGlobalId: globalId(
        input.body.lineGlobalId,
        LINE_PATTERN,
        'Candidate line Global ID',
      ),
      product: mode === 'existing'
        ? {
            mode,
            productGlobalId: globalId(
              product.productGlobalId,
              PRODUCT_PATTERN,
              'Product Global ID',
            ),
            unitPriceMinor: minorAmount(product.unitPriceMinor),
            currency: currency(product.currency),
          } as const
        : {
            mode,
            name: text(product.name, 'Product name', 255),
            sku: optionalText(product.sku, 'Product SKU', 255),
            unitPriceMinor: minorAmount(product.unitPriceMinor),
            currency: currency(product.currency),
          } as const,
    })
  } else if (commandAction === 'resolve-customer') {
    const customer = record(input.body.customer)
    const mode = text(customer.mode, 'Customer resolution mode', 20)
    if (mode !== 'existing' && mode !== 'create') {
      throw new CommerceIntegrationRequestError(
        'Customer resolution mode must be existing or create',
        400,
        'COMMERCE_INTAKE_COMMAND_INVALID',
      )
    }
    command = await resolveCommerceCandidateCustomerInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      customer: mode === 'existing'
        ? {
            mode,
            customerGlobalId: globalId(
              customer.customerGlobalId,
              CUSTOMER_PATTERN,
              'Customer Global ID',
            ),
          } as const
        : {
            mode,
            name: text(customer.name, 'Customer name', 255),
            email: optionalText(customer.email, 'Customer email', 320),
            phone: optionalText(customer.phone, 'Customer phone', 50),
          } as const,
    })
  } else if (commandAction === 'confirm-address') {
    const address = record(input.body.address)
    command = await confirmCommerceCandidateAddressInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      address: {
        name: text(address.name, 'Recipient name', 255),
        line1: text(address.line1, 'Address line 1', 255),
        line2: optionalText(address.line2, 'Address line 2', 255),
        city: text(address.city, 'City', 120),
        region: text(address.region, 'Region', 120),
        postalCode: text(address.postalCode, 'Postal code', 30),
        country: text(address.country, 'Country', 3).toUpperCase(),
      },
    })
  } else if (commandAction === 'resolve-delivery') {
    const decision = record(input.body.decision)
    const mode = text(decision.mode, 'Delivery decision mode', 20)
    if (!['provider', 'manual', 'default_sla'].includes(mode)) {
      throw new CommerceIntegrationRequestError(
        'Delivery decision mode is invalid',
        400,
        'COMMERCE_INTAKE_COMMAND_INVALID',
      )
    }
    command = await resolveCommerceCandidateDeliveryInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      decision: {
        mode: mode as 'provider' | 'manual' | 'default_sla',
        requestedDeliveryAt: mode === 'manual'
          ? timestamp(
            decision.requestedDeliveryAt,
            'Requested delivery time',
          )
          : null,
      },
    })
  } else if (commandAction === 'resolve-package') {
    const packageInput = record(input.body.package)
    const mode = text(packageInput.mode, 'Package resolution mode', 20)
    if (mode !== 'profile' && mode !== 'manual') {
      throw new CommerceIntegrationRequestError(
        'Package resolution mode must be profile or manual',
        400,
        'COMMERCE_INTAKE_COMMAND_INVALID',
      )
    }
    command = await resolveCommerceCandidatePackageInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      lineGlobalId: globalId(
        input.body.lineGlobalId,
        LINE_PATTERN,
        'Candidate line Global ID',
      ),
      package: mode === 'profile'
        ? {
            mode,
            packageProfileGlobalId: globalId(
              packageInput.packageProfileGlobalId,
              PACKAGE_PROFILE_PATTERN,
              'Package profile Global ID',
            ),
          } as const
        : {
            mode,
            weightGrams: positiveInteger(
              packageInput.weightGrams,
              'Package weight',
              1_000_000,
            ),
            dimensionsMm: dimensions(packageInput.dimensionsMm),
          } as const,
    })
  } else if (commandAction === 'validate') {
    command = await validateCommerceCandidateInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
    })
  } else if (commandAction === 'mark-unsupported') {
    command = await markCommerceCandidateUnsupportedInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      reasonCode: text(input.body.reasonCode, 'Unsupported reason code', 100),
      reason: text(input.body.reason, 'Unsupported reason', 500),
    })
  } else if (commandAction === 'promote') {
    if (input.body.confirmProviderWriteOff !== true) {
      throw new CommerceIntegrationRequestError(
        'Confirm that provider write-back remains disabled',
        400,
        'COMMERCE_INTAKE_PROMOTION_CONFIRMATION_REQUIRED',
      )
    }
    command = await promoteCommerceCandidateInPostgres({
      ...shared,
      candidateGlobalId,
      candidateRowVersion: version,
      requestHash: requestHash({
        candidateGlobalId,
        candidateRowVersion: version,
        providerWrites: 0,
      }),
    })
  }

  return {
    command,
    intake: await readCommerceIntakeStateFromPostgres({
      organizationId: runtime.organizationId,
      accountGlobalId: runtime.globalId,
    }),
  }
}
