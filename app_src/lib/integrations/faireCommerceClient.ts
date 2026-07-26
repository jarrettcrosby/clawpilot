export const FAIRE_API_BASE_URL = 'https://www.faire.com/external-api/v2' as const

const FAIRE_API_ORIGIN = 'https://www.faire.com'
const FAIRE_API_PATH_PREFIX = '/external-api/v2/'
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 50
const MAX_INVENTORY_SELECTORS = 50
const MAX_AVAILABILITY_ITEMS = 250
const MAX_SHIPMENTS = 100

/**
 * Faire's documented OAuth scope vocabulary. The client accepts an already
 * issued access token; it does not implement or imply an OAuth grant flow.
 */
export const FAIRE_API_SCOPES = Object.freeze([
  'READ_PRODUCTS',
  'WRITE_PRODUCTS',
  'READ_ORDERS',
  'WRITE_ORDERS',
  'READ_BRAND',
  'READ_RETAILER',
  'READ_INVENTORIES',
  'WRITE_INVENTORIES',
  'READ_SHIPMENTS',
  'READ_REVIEWS',
] as const)

/**
 * This adapter is a B2B wholesale marketplace sales-channel client, not a POS
 * or shopping-cart client. Faire does not document webhook registration, a
 * public sandbox, or return-write endpoints, so those capabilities stay false.
 */
export const FAIRE_COMMERCE_CAPABILITIES = Object.freeze({
  provider: 'faire',
  classification: 'b2b_wholesale_marketplace_sales_channel',
  environment: 'production',
  authentication: 'access_token_header',
  inventoryReadMode: 'selector_only',
  webhooks: false,
  sandbox: false,
  returnWrites: false,
  orderWrites: Object.freeze([
    'processing',
    'cancel',
    'availability',
    'shipment',
  ] as const),
})

export type FaireJsonObject = Record<string, unknown>
export type FaireBrandProfile = FaireJsonObject
export type FaireProduct = FaireJsonObject
export type FaireOrder = FaireJsonObject

export type FaireProductsPage = FaireJsonObject & {
  products: FaireProduct[]
}

export type FaireOrdersPage = FaireJsonObject & {
  orders: FaireOrder[]
}

export type FaireInventoryQuantity = FaireJsonObject & {
  type: 'QUANTITY' | 'UNTRACKED'
  quantity?: number
}

export type FaireInventoryLevel = FaireJsonObject & {
  on_hand_quantity?: FaireInventoryQuantity
  committed_quantity?: FaireInventoryQuantity
  available_quantity?: FaireInventoryQuantity
}

export type FaireInventoryResponse = FaireJsonObject & {
  inventories: Record<string, FaireInventoryLevel>
}

export type FaireListOptions = {
  cursor?: string | null
  updatedAtMin?: string | null
  limit?: number | null
}

export type FaireInventoryQuery =
  | {
      productVariantIds: readonly string[]
      skus?: never
    }
  | {
      productVariantIds?: never
      skus: readonly string[]
    }

export type FaireMoveOrderToProcessingInput = {
  expectedShipDate?: string | null
}

export const FAIRE_ORDER_CANCELLATION_REASONS = Object.freeze([
  'REQUESTED_BY_RETAILER',
  'RETAILER_NOT_GOOD_FIT',
  'CHANGE_REPLACE_ORDER',
  'ITEM_OUT_OF_STOCK',
  'INCORRECT_PRICING',
  'ORDER_TOO_SMALL',
  'REJECT_INTERNATIONAL_ORDER',
  'OTHER',
] as const)

export type FaireOrderCancellationReason =
  typeof FAIRE_ORDER_CANCELLATION_REASONS[number]

export type FaireCancelOrderInput = {
  reason: FaireOrderCancellationReason
  note?: string | null
}

export type FaireOrderItemAvailabilityInput = {
  availableQuantity?: number
  discontinued?: boolean
  backorderedUntil?: string
}

export type FaireOrderItemAvailabilities =
  Readonly<Record<string, FaireOrderItemAvailabilityInput>>

export type FaireMoneyInput = {
  amountMinor: number
  currency: string
}

export type FaireShippingType = 'SHIP_ON_YOUR_OWN' | 'SHIP_WITH_FAIRE'

export type FaireShipmentInput = {
  carrier: string
  trackingCode: string
  makerCost?: FaireMoneyInput | null
  shippingType: FaireShippingType
}

export type FaireCommerceClientOptions = {
  accessToken: unknown
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type FaireCommerceClient = {
  probeBrandProfile: () => Promise<FaireBrandProfile>
  listProducts: (options?: FaireListOptions) => Promise<FaireProductsPage>
  listOrders: (options?: FaireListOptions) => Promise<FaireOrdersPage>
  listInventory: (query: FaireInventoryQuery) => Promise<FaireInventoryResponse>
  moveOrderToProcessing: (
    orderId: string,
    input?: FaireMoveOrderToProcessingInput,
  ) => Promise<FaireJsonObject>
  cancelOrder: (
    orderId: string,
    input: FaireCancelOrderInput,
  ) => Promise<FaireJsonObject>
  setOrderItemsAvailability: (
    orderId: string,
    availabilities: FaireOrderItemAvailabilities,
  ) => Promise<FaireJsonObject>
  setOrderItemAvailability: (
    orderId: string,
    availabilities: FaireOrderItemAvailabilities,
  ) => Promise<FaireJsonObject>
  addOrderShipments: (
    orderId: string,
    shipments: readonly FaireShipmentInput[],
  ) => Promise<FaireJsonObject>
  addOrderShipment: (
    orderId: string,
    shipment: FaireShipmentInput,
  ) => Promise<FaireJsonObject>
}

type FaireRequestInput = {
  method?: 'GET' | 'POST' | 'PUT'
  query?: URLSearchParams
  body?: unknown
}

export class FaireCommerceClientError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'FAIRE_REQUEST_FAILED',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FaireCommerceClientError'
  }
}

export function sanitizeFaireCommerceError(error: unknown) {
  if (error instanceof FaireCommerceClientError) return error
  return new FaireCommerceClientError(
    'The Faire integration request failed',
    500,
    'FAIRE_INTERNAL_ERROR',
  )
}

function invalidInput(message: string, code: string): never {
  throw new FaireCommerceClientError(message, 400, code)
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeAccessToken(value: unknown) {
  const accessToken = typeof value === 'string' ? value.trim() : ''
  if (
    accessToken.length < 8
    || accessToken.length > 4096
    || !/^[\x21-\x7e]+$/.test(accessToken)
  ) {
    invalidInput('A valid Faire access token is required', 'FAIRE_ACCESS_TOKEN_INVALID')
  }
  return accessToken
}

function normalizeTimeout(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)))
}

function normalizeCursor(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const cursor = typeof value === 'string' ? value.trim() : ''
  if (
    !cursor
    || cursor.length > 4096
    || /[\u0000-\u001f\u007f]/.test(cursor)
  ) {
    invalidInput('Faire cursor is invalid', 'FAIRE_CURSOR_INVALID')
  }
  return cursor
}

function normalizeTimestamp(value: unknown, label: string, code: string) {
  const timestamp = typeof value === 'string' ? value.trim() : ''
  const parsed = timestamp && timestamp.length <= 80
    ? new Date(timestamp)
    : new Date(Number.NaN)
  if (!Number.isFinite(parsed.getTime())) {
    invalidInput(`${label} must be a valid ISO timestamp`, code)
  }
  return parsed.toISOString()
}

function normalizeOptionalTimestamp(
  value: unknown,
  label: string,
  code: string,
) {
  if (value === undefined || value === null || value === '') return null
  return normalizeTimestamp(value, label, code)
}

function normalizeListLimit(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_LIST_LIMIT
  ) {
    invalidInput(
      `Faire list limit must be between 1 and ${MAX_LIST_LIMIT}`,
      'FAIRE_LIST_LIMIT_INVALID',
    )
  }
  return value
}

function listQuery(options: FaireListOptions = {}) {
  const query = new URLSearchParams()
  query.set('limit', String(normalizeListLimit(options?.limit)))
  const cursor = normalizeCursor(options?.cursor)
  if (cursor) query.set('cursor', cursor)
  const updatedAtMin = normalizeOptionalTimestamp(
    options?.updatedAtMin,
    'Faire updated-at minimum',
    'FAIRE_UPDATED_AT_MIN_INVALID',
  )
  if (updatedAtMin) query.set('updated_at_min', updatedAtMin)
  return query
}

function normalizeResourceId(value: unknown, label: string, code: string) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    invalidInput(`${label} is invalid`, code)
  }
  return id
}

function normalizeInventorySelectors(
  values: unknown,
  kind: 'product variant ID' | 'SKU',
) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.length > MAX_INVENTORY_SELECTORS
  ) {
    invalidInput(
      `Faire inventory requires 1-${MAX_INVENTORY_SELECTORS} ${kind}s`,
      'FAIRE_INVENTORY_SELECTORS_INVALID',
    )
  }

  const normalized = values.map((value) => {
    if (kind === 'product variant ID') {
      return normalizeResourceId(
        value,
        'Faire product variant ID',
        'FAIRE_PRODUCT_VARIANT_ID_INVALID',
      )
    }
    const sku = typeof value === 'string' ? value.trim() : ''
    if (
      !sku
      || sku.length > 128
      || sku.includes(',')
      || /[\u0000-\u001f\u007f]/.test(sku)
    ) {
      invalidInput('Faire SKU is invalid', 'FAIRE_SKU_INVALID')
    }
    return sku
  })
  return [...new Set(normalized)]
}

function inventoryRequest(query: FaireInventoryQuery) {
  const productVariantIds = query?.productVariantIds
  const skus = query?.skus
  const selectorCount = Number(productVariantIds !== undefined)
    + Number(skus !== undefined)
  if (selectorCount !== 1) {
    invalidInput(
      'Faire inventory requires product variant IDs or SKUs, but not both',
      'FAIRE_INVENTORY_SELECTOR_TYPE_INVALID',
    )
  }

  const search = new URLSearchParams()
  if (productVariantIds !== undefined) {
    const values = normalizeInventorySelectors(
      productVariantIds,
      'product variant ID',
    )
    search.set('ids', values.join(','))
    return {
      pathname: '/product-inventory/by-product-variant-ids',
      query: search,
    }
  }

  const values = normalizeInventorySelectors(skus, 'SKU')
  search.set('skus', values.join(','))
  return {
    pathname: '/product-inventory/by-skus',
    query: search,
  }
}

function normalizeCancellation(input: FaireCancelOrderInput) {
  const reason = input?.reason
  if (
    typeof reason !== 'string'
    || !(FAIRE_ORDER_CANCELLATION_REASONS as readonly string[]).includes(reason)
  ) {
    invalidInput(
      'Faire cancellation reason is invalid',
      'FAIRE_CANCELLATION_REASON_INVALID',
    )
  }

  const payload: { reason: FaireOrderCancellationReason; note?: string } = {
    reason,
  }
  if (input?.note !== undefined && input.note !== null) {
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (note) {
      if (
        note.length < 30
        || note.length > 1000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)
      ) {
        invalidInput(
          'Faire cancellation note must be 30-1000 readable characters',
          'FAIRE_CANCELLATION_NOTE_INVALID',
        )
      }
      payload.note = note
    }
  }
  return payload
}

function normalizeAvailabilities(
  input: FaireOrderItemAvailabilities,
): Record<string, Record<string, unknown>> {
  const entries = safeRecord(input) ? Object.entries(input) : []
  if (entries.length === 0 || entries.length > MAX_AVAILABILITY_ITEMS) {
    invalidInput(
      `Faire availability requires 1-${MAX_AVAILABILITY_ITEMS} order items`,
      'FAIRE_AVAILABILITY_ITEMS_INVALID',
    )
  }

  return Object.fromEntries(entries.map(([keyValue, value]) => {
    const key = normalizeResourceId(
      keyValue,
      'Faire order-item availability key',
      'FAIRE_ORDER_ITEM_ID_INVALID',
    )
    const item = safeRecord(value)
    if (!item) {
      invalidInput(
        'Faire order-item availability is invalid',
        'FAIRE_AVAILABILITY_INVALID',
      )
    }

    const payload: Record<string, unknown> = {}
    if (item.availableQuantity !== undefined) {
      if (
        typeof item.availableQuantity !== 'number'
        || !Number.isInteger(item.availableQuantity)
        || item.availableQuantity < 0
      ) {
        invalidInput(
          'Faire available quantity must be a non-negative integer',
          'FAIRE_AVAILABLE_QUANTITY_INVALID',
        )
      }
      payload.available_quantity = item.availableQuantity
    }
    if (item.discontinued !== undefined) {
      if (typeof item.discontinued !== 'boolean') {
        invalidInput(
          'Faire discontinued status must be true or false',
          'FAIRE_DISCONTINUED_INVALID',
        )
      }
      payload.discontinued = item.discontinued
    }
    if (item.backorderedUntil !== undefined) {
      payload.backordered_until = normalizeTimestamp(
        item.backorderedUntil,
        'Faire backordered-until value',
        'FAIRE_BACKORDERED_UNTIL_INVALID',
      )
    }
    if (Object.keys(payload).length === 0) {
      invalidInput(
        'Faire order-item availability requires at least one change',
        'FAIRE_AVAILABILITY_EMPTY',
      )
    }
    return [key, payload]
  }))
}

function normalizeShipment(input: FaireShipmentInput) {
  const carrier = typeof input?.carrier === 'string'
    ? input.carrier.trim()
    : ''
  if (
    !carrier
    || carrier.length > 80
    || /[\u0000-\u001f\u007f]/.test(carrier)
  ) {
    invalidInput('Faire shipment carrier is invalid', 'FAIRE_CARRIER_INVALID')
  }

  const trackingCode = typeof input?.trackingCode === 'string'
    ? input.trackingCode.trim()
    : ''
  if (
    !trackingCode
    || trackingCode.length > 255
    || /[\u0000-\u001f\u007f]/.test(trackingCode)
  ) {
    invalidInput(
      'Faire shipment tracking code is invalid',
      'FAIRE_TRACKING_CODE_INVALID',
    )
  }

  if (
    input?.shippingType !== 'SHIP_ON_YOUR_OWN'
    && input?.shippingType !== 'SHIP_WITH_FAIRE'
  ) {
    invalidInput(
      'Faire shipment type is invalid',
      'FAIRE_SHIPPING_TYPE_INVALID',
    )
  }

  const payload: Record<string, unknown> = {
    carrier,
    tracking_code: trackingCode,
    shipping_type: input.shippingType,
  }
  if (input?.makerCost !== undefined && input.makerCost !== null) {
    const amountMinor = input.makerCost.amountMinor
    const currency = typeof input.makerCost.currency === 'string'
      ? input.makerCost.currency.trim().toUpperCase()
      : ''
    if (
      typeof amountMinor !== 'number'
      || !Number.isInteger(amountMinor)
      || amountMinor < 0
      || !/^[A-Z]{3}$/.test(currency)
    ) {
      invalidInput(
        'Faire shipment maker cost is invalid',
        'FAIRE_MAKER_COST_INVALID',
      )
    }
    payload.maker_cost = {
      amount_minor: amountMinor,
      currency,
    }
  }
  return payload
}

function normalizeShipments(input: readonly FaireShipmentInput[]) {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.length > MAX_SHIPMENTS
  ) {
    invalidInput(
      `Faire shipment request requires 1-${MAX_SHIPMENTS} shipments`,
      'FAIRE_SHIPMENTS_INVALID',
    )
  }
  return input.map(normalizeShipment)
}

function requestUrl(pathname: string, query?: URLSearchParams) {
  if (
    !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || pathname.includes('..')
    || pathname.includes('?')
    || pathname.includes('#')
    || /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    throw new FaireCommerceClientError(
      'Faire request path is invalid',
      500,
      'FAIRE_REQUEST_PATH_INVALID',
    )
  }
  const url = new URL(`${FAIRE_API_BASE_URL}${pathname}`)
  if (
    url.origin !== FAIRE_API_ORIGIN
    || !url.pathname.startsWith(FAIRE_API_PATH_PREFIX)
  ) {
    throw new FaireCommerceClientError(
      'Faire request origin is invalid',
      500,
      'FAIRE_REQUEST_ORIGIN_INVALID',
    )
  }
  if (query) url.search = query.toString()
  return url
}

function serializeRequestBody(value: unknown) {
  let body: string
  try {
    body = JSON.stringify(value)
  } catch {
    throw new FaireCommerceClientError(
      'Faire request body is invalid',
      400,
      'FAIRE_REQUEST_BODY_INVALID',
    )
  }
  if (typeof body !== 'string') {
    throw new FaireCommerceClientError(
      'Faire request body is invalid',
      400,
      'FAIRE_REQUEST_BODY_INVALID',
    )
  }
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new FaireCommerceClientError(
      'Faire request exceeded the safe size limit',
      400,
      'FAIRE_REQUEST_TOO_LARGE',
    )
  }
  return body
}

async function readBoundedResponse(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new FaireCommerceClientError(
      'Faire response exceeded the safe size limit',
      502,
      'FAIRE_RESPONSE_TOO_LARGE',
    )
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the bounded-response error if cancellation also fails.
      }
      throw new FaireCommerceClientError(
        'Faire response exceeded the safe size limit',
        502,
        'FAIRE_RESPONSE_TOO_LARGE',
      )
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function upstreamError(status: number) {
  if (status === 400 || status === 422) {
    return new FaireCommerceClientError(
      'Faire rejected the integration request',
      422,
      'FAIRE_REQUEST_REJECTED',
    )
  }
  if (status === 401 || status === 403) {
    return new FaireCommerceClientError(
      'Faire denied access for the configured integration',
      422,
      'FAIRE_ACCESS_DENIED',
    )
  }
  if (status === 404) {
    return new FaireCommerceClientError(
      'The requested Faire resource was not found',
      404,
      'FAIRE_RESOURCE_NOT_FOUND',
    )
  }
  if (status === 409) {
    return new FaireCommerceClientError(
      'The Faire request conflicted with the current resource state',
      409,
      'FAIRE_RESOURCE_CONFLICT',
    )
  }
  if (status === 429) {
    return new FaireCommerceClientError(
      'Faire is temporarily rate limiting integration requests',
      503,
      'FAIRE_RATE_LIMITED',
      true,
    )
  }
  if (status >= 500) {
    return new FaireCommerceClientError(
      'Faire is temporarily unavailable',
      503,
      'FAIRE_UPSTREAM_UNAVAILABLE',
      true,
    )
  }
  return new FaireCommerceClientError(
    'Faire integration request failed',
    502,
    'FAIRE_UPSTREAM_FAILED',
  )
}

function isAbortError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError',
  )
}

function parseJsonResponse(bytes: Uint8Array) {
  if (bytes.byteLength === 0) return {}
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
}

function expectObject(value: unknown) {
  const record = safeRecord(value)
  if (!record) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

function expectObjectCollection(
  value: unknown,
  key: 'products' | 'orders',
) {
  const record = expectObject(value)
  const collection = record[key]
  if (
    !Array.isArray(collection)
    || collection.some((item) => !safeRecord(item))
  ) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

function expectInventoryResponse(value: unknown) {
  const record = expectObject(value)
  const inventories = safeRecord(record.inventories)
  const validQuantity = (quantity: unknown) => {
    const candidate = safeRecord(quantity)
    if (!candidate) return false
    if (candidate.type !== 'QUANTITY' && candidate.type !== 'UNTRACKED') {
      return false
    }
    return candidate.quantity === undefined
      ? candidate.type === 'UNTRACKED'
      : Number.isInteger(candidate.quantity)
  }
  const validLevel = (value: unknown) => {
    const level = safeRecord(value)
    if (!level) return false
    return [
      level.on_hand_quantity,
      level.committed_quantity,
      level.available_quantity,
    ].every((quantity) => (
      quantity === undefined || validQuantity(quantity)
    ))
  }
  if (
    !inventories
    || Object.values(inventories).some((item) => !validLevel(item))
  ) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

export function createFaireCommerceClient(
  options: FaireCommerceClientOptions,
): FaireCommerceClient {
  const accessToken = normalizeAccessToken(options?.accessToken)
  const fetchImpl = typeof options?.fetchImpl === 'function'
    ? options.fetchImpl
    : fetch
  const timeoutMs = normalizeTimeout(options?.timeoutMs)

  async function request(
    pathname: string,
    input: FaireRequestInput = {},
  ): Promise<unknown> {
    const url = requestUrl(pathname, input.query)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const headers = new Headers({
      Accept: 'application/json',
      'X-FAIRE-ACCESS-TOKEN': accessToken,
    })
    const body = input.body === undefined
      ? undefined
      : serializeRequestBody(input.body)
    if (body !== undefined) headers.set('Content-Type', 'application/json')

    let response: Response
    let bytes: Uint8Array
    try {
      response = await fetchImpl(url, {
        method: input.method || 'GET',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      })
      bytes = await readBoundedResponse(response)
    } catch (error) {
      if (error instanceof FaireCommerceClientError) throw error
      if (controller.signal.aborted || isAbortError(error)) {
        throw new FaireCommerceClientError(
          'Faire integration request timed out',
          504,
          'FAIRE_REQUEST_TIMEOUT',
          true,
        )
      }
      throw new FaireCommerceClientError(
        'Faire is temporarily unavailable',
        503,
        'FAIRE_UPSTREAM_UNAVAILABLE',
        true,
      )
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) throw upstreamError(response.status)
    return parseJsonResponse(bytes)
  }

  async function probeBrandProfile() {
    return expectObject(await request('/brands/profile')) as FaireBrandProfile
  }

  async function listProducts(options: FaireListOptions = {}) {
    return expectObjectCollection(
      await request('/products', { query: listQuery(options) }),
      'products',
    ) as FaireProductsPage
  }

  async function listOrders(options: FaireListOptions = {}) {
    return expectObjectCollection(
      await request('/orders', { query: listQuery(options) }),
      'orders',
    ) as FaireOrdersPage
  }

  async function listInventory(query: FaireInventoryQuery) {
    const inventory = inventoryRequest(query)
    return expectInventoryResponse(await request(inventory.pathname, {
      query: inventory.query,
    })) as FaireInventoryResponse
  }

  async function moveOrderToProcessing(
    orderIdValue: string,
    input: FaireMoveOrderToProcessingInput = {},
  ) {
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    const expectedShipDate = normalizeOptionalTimestamp(
      input?.expectedShipDate,
      'Faire expected ship date',
      'FAIRE_EXPECTED_SHIP_DATE_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/processing`, {
      method: 'PUT',
      body: expectedShipDate
        ? { expected_ship_date: expectedShipDate }
        : {},
    }))
  }

  async function cancelOrder(
    orderIdValue: string,
    input: FaireCancelOrderInput,
  ) {
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/cancel`, {
      method: 'PUT',
      body: normalizeCancellation(input),
    }))
  }

  async function setOrderItemsAvailability(
    orderIdValue: string,
    availabilities: FaireOrderItemAvailabilities,
  ) {
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/items/availability`, {
      method: 'POST',
      body: {
        availabilities: normalizeAvailabilities(availabilities),
      },
    }))
  }

  async function addOrderShipments(
    orderIdValue: string,
    shipments: readonly FaireShipmentInput[],
  ) {
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/shipments`, {
      method: 'POST',
      body: {
        shipments: normalizeShipments(shipments),
      },
    }))
  }

  async function addOrderShipment(
    orderId: string,
    shipment: FaireShipmentInput,
  ) {
    return addOrderShipments(orderId, [shipment])
  }

  return Object.freeze({
    probeBrandProfile,
    listProducts,
    listOrders,
    listInventory,
    moveOrderToProcessing,
    cancelOrder,
    setOrderItemsAvailability,
    setOrderItemAvailability: setOrderItemsAvailability,
    addOrderShipments,
    addOrderShipment,
  })
}

export function probeFaireBrandProfile(options: FaireCommerceClientOptions) {
  return createFaireCommerceClient(options).probeBrandProfile()
}

export function listFaireProducts(
  options: FaireCommerceClientOptions,
  listOptions?: FaireListOptions,
) {
  return createFaireCommerceClient(options).listProducts(listOptions)
}

export function listFaireOrders(
  options: FaireCommerceClientOptions,
  listOptions?: FaireListOptions,
) {
  return createFaireCommerceClient(options).listOrders(listOptions)
}

export function listFaireInventory(
  options: FaireCommerceClientOptions,
  query: FaireInventoryQuery,
) {
  return createFaireCommerceClient(options).listInventory(query)
}

export function moveFaireOrderToProcessing(
  options: FaireCommerceClientOptions,
  orderId: string,
  input?: FaireMoveOrderToProcessingInput,
) {
  return createFaireCommerceClient(options).moveOrderToProcessing(orderId, input)
}

export function cancelFaireOrder(
  options: FaireCommerceClientOptions,
  orderId: string,
  input: FaireCancelOrderInput,
) {
  return createFaireCommerceClient(options).cancelOrder(orderId, input)
}

export function setFaireOrderItemAvailability(
  options: FaireCommerceClientOptions,
  orderId: string,
  availabilities: FaireOrderItemAvailabilities,
) {
  return createFaireCommerceClient(options)
    .setOrderItemsAvailability(orderId, availabilities)
}

export function setFaireOrderItemsAvailability(
  options: FaireCommerceClientOptions,
  orderId: string,
  availabilities: FaireOrderItemAvailabilities,
) {
  return setFaireOrderItemAvailability(options, orderId, availabilities)
}

export function addFaireOrderShipment(
  options: FaireCommerceClientOptions,
  orderId: string,
  shipment: FaireShipmentInput,
) {
  return createFaireCommerceClient(options).addOrderShipment(orderId, shipment)
}

export function addFaireOrderShipments(
  options: FaireCommerceClientOptions,
  orderId: string,
  shipments: readonly FaireShipmentInput[],
) {
  return createFaireCommerceClient(options).addOrderShipments(orderId, shipments)
}
