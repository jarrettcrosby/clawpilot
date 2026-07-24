import type { ToastAccessType } from '@/lib/integrations/toastCredentialCrypto'

const MAX_RESPONSE_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ToastRuntimeCredential = {
  accessType: ToastAccessType
  apiBaseUrl: string
  clientId: string
  clientSecret: string
}

export type ToastRestaurant = {
  restaurantGuid: string
  restaurantName: string
  locationName: string | null
  locationCode: string | null
  timezone: string | null
  closeoutHour: number | null
  active: boolean
  testMode: boolean
  archived: boolean
}

export type ToastReportResult = {
  ready: boolean
  requestGuid: string
  records: unknown[]
}

export type ToastMenuMetadata = {
  restaurantGuid: string
  sourceRevision: string
}

export type ToastMenuCatalogMenu = {
  menuGuid: string
  sourceProvider: 'toast'
  providerMenuId: string
  name: string
  visibility: string[]
  active: boolean
  archived: boolean
  position: number
}

export type ToastMenuCatalogGroup = {
  menuGuid: string
  groupGuid: string
  parentGroupGuid: string | null
  sourceProvider: 'toast'
  providerGroupId: string
  name: string
  visibility: string[]
  active: boolean
  archived: boolean
  position: number
}

export type ToastMenuCatalogItem = {
  menuGuid: string
  groupGuid: string
  itemGuid: string
  sourceProvider: 'toast'
  providerItemId: string
  name: string
  plu: string | null
  price: number | null
  visibility: string[]
  salesCategoryGuid: string | null
  providerSalesCategoryId: string | null
  active: boolean
  archived: boolean
  position: number
}

export type ToastMenuCatalogSalesCategory = {
  salesCategoryGuid: string
  sourceProvider: 'toast'
  providerSalesCategoryId: string
  name: string
  plu: string | null
  active: boolean
  archived: boolean
}

export type ToastMenuCatalogSnapshot = {
  restaurantGuid: string
  sourceProvider: 'toast'
  providerRestaurantId: string
  sourceRevision: string
  restaurantTimeZone: string | null
  menus: ToastMenuCatalogMenu[]
  groups: ToastMenuCatalogGroup[]
  items: ToastMenuCatalogItem[]
  salesCategories: ToastMenuCatalogSalesCategory[]
}

export type ToastMenuCatalogFetchResult =
  | { status: 'updated'; metadata: ToastMenuMetadata; catalog: ToastMenuCatalogSnapshot }
  | { status: 'unchanged'; metadata: ToastMenuMetadata; catalog: null }
  | {
      status: 'unavailable'
      metadata: ToastMenuMetadata | null
      catalog: null
      reason: 'menus_scope_required' | 'menu_not_published'
      errorCode: 'TOAST_MENUS_SCOPE_REQUIRED' | 'TOAST_MENUS_NOT_PUBLISHED'
    }

export class ToastClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'TOAST_REQUEST_FAILED', status = 502) {
    super(message)
    this.name = 'ToastClientError'
    this.code = code
    this.status = status
  }
}

export function normalizeToastApiBaseUrl(value: unknown) {
  let parsed: URL
  try {
    parsed = new URL(String(value || '').trim())
  } catch {
    throw new ToastClientError('A valid Toast API access URL is required', 'TOAST_URL_INVALID', 400)
  }
  const hostname = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || (hostname !== 'toasttab.com' && !hostname.endsWith('.toasttab.com'))
  ) {
    throw new ToastClientError('Toast API access URL must be an HTTPS toasttab.com URL', 'TOAST_URL_INVALID', 400)
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname && pathname !== '/') {
    throw new ToastClientError('Toast API access URL must not contain an API path', 'TOAST_URL_INVALID', 400)
  }
  return `https://${hostname}`
}

export function normalizeToastClientId(value: unknown) {
  const clientId = String(value || '').trim()
  if (clientId.length < 8 || clientId.length > 512 || !/^[\x21-\x7e]+$/.test(clientId)) {
    throw new ToastClientError('A valid Toast client ID is required', 'TOAST_CLIENT_ID_INVALID', 400)
  }
  return clientId
}

export function normalizeToastRestaurantGuid(value: unknown) {
  const guid = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(guid)) {
    throw new ToastClientError('A valid Toast restaurant GUID is required', 'TOAST_RESTAURANT_INVALID', 400)
  }
  return guid
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cleanText(value: unknown, max = 200) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '')
  return text ? text.slice(0, max) : null
}

function optionalCloseoutHour(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 12 ? parsed : null
}

function absoluteTimestamp(value: unknown, label: string) {
  const raw = String(value || '').trim()
  const parsed = Date.parse(raw)
  if (!raw || !Number.isFinite(parsed)) {
    throw new ToastClientError(`Toast ${label} was invalid`, 'TOAST_RESPONSE_INVALID')
  }
  return new Date(parsed).toISOString()
}

function optionalToastGuid(value: unknown) {
  try {
    return normalizeToastRestaurantGuid(value)
  } catch {
    return null
  }
}

function visibilityList(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map((entry) => cleanText(entry, 64)?.toUpperCase() || '')
    .filter(Boolean))]
    .slice(0, 32)
}

function catalogEntityState(record: Record<string, unknown>) {
  const archived = record.archived === true
  return { active: record.active !== false && !archived, archived }
}

function catalogPrice(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const price = Number(value)
  return Number.isFinite(price) && Math.abs(price) <= 1_000_000_000 ? price : null
}

async function readResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new ToastClientError('Toast response exceeded the supported size', 'TOAST_RESPONSE_TOO_LARGE')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ToastClientError('Toast response exceeded the supported size', 'TOAST_RESPONSE_TOO_LARGE')
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new ToastClientError('Toast returned an invalid JSON response', 'TOAST_RESPONSE_INVALID')
  }
}

async function request(
  credential: ToastRuntimeCredential,
  path: string,
  init: RequestInit = {},
  restaurantGuid?: string,
): Promise<{ data: unknown; headers: Headers; status: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (restaurantGuid) headers.set('Toast-Restaurant-External-ID', normalizeToastRestaurantGuid(restaurantGuid))
    const response = await fetch(`${normalizeToastApiBaseUrl(credential.apiBaseUrl)}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    const data = await readResponse(response)
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      const body = safeRecord(data)
      const remoteMessage = cleanText(body.message || body.error || body.errorMessage, 240)
      const message = response.status === 401 || response.status === 403
        ? 'Toast rejected the configured credential or scope'
        : remoteMessage || `Toast request failed with HTTP ${response.status}`
      throw new ToastClientError(message, `TOAST_HTTP_${response.status}`, response.status >= 400 && response.status < 500 ? response.status : 502)
    }
    return { data, headers: response.headers, status: response.status }
  } catch (error) {
    if (error instanceof ToastClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ToastClientError('Toast request timed out', 'TOAST_TIMEOUT', 504)
    }
    throw new ToastClientError('Toast API is unavailable', 'TOAST_UNAVAILABLE', 503)
  } finally {
    clearTimeout(timeout)
  }
}

export async function authenticateToast(credential: ToastRuntimeCredential) {
  const response = await request(credential, '/authentication/v1/authentication/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: normalizeToastClientId(credential.clientId),
      clientSecret: credential.clientSecret,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  })
  const body = safeRecord(response.data)
  const token = safeRecord(body.token)
  const accessToken = String(token.accessToken || '').trim()
  if (!accessToken) throw new ToastClientError('Toast authentication did not return an access token', 'TOAST_AUTH_INVALID')
  return accessToken
}

async function authorizedRequest(
  credential: ToastRuntimeCredential,
  token: string,
  path: string,
  init: RequestInit = {},
  restaurantGuid?: string,
) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return request(credential, path, { ...init, headers }, restaurantGuid)
}

function restaurantFromAnalytics(value: unknown): ToastRestaurant | null {
  const record = safeRecord(value)
  try {
    const restaurantGuid = normalizeToastRestaurantGuid(record.restaurantGuid)
    const restaurantName = cleanText(record.restaurantName)
    if (!restaurantName) return null
    return {
      restaurantGuid,
      restaurantName,
      locationName: null,
      locationCode: null,
      timezone: null,
      closeoutHour: null,
      active: record.active !== false,
      testMode: record.testMode === true,
      archived: record.archived === true,
    }
  } catch {
    return null
  }
}

export async function listToastAnalyticsRestaurants(credential: ToastRuntimeCredential) {
  const token = await authenticateToast(credential)
  const response = await authorizedRequest(credential, token, '/era/v1/restaurants-information')
  if (!Array.isArray(response.data)) throw new ToastClientError('Toast restaurant list was invalid', 'TOAST_RESPONSE_INVALID')
  return response.data.map(restaurantFromAnalytics).filter((entry): entry is ToastRestaurant => Boolean(entry))
}

export async function getToastStandardRestaurant(
  credential: ToastRuntimeCredential,
  restaurantGuidValue: unknown,
): Promise<ToastRestaurant> {
  const restaurantGuid = normalizeToastRestaurantGuid(restaurantGuidValue)
  const token = await authenticateToast(credential)
  const response = await authorizedRequest(
    credential,
    token,
    `/restaurants/v1/restaurants/${encodeURIComponent(restaurantGuid)}`,
    {},
    restaurantGuid,
  )
  const body = safeRecord(response.data)
  const general = safeRecord(body.general)
  const restaurantName = cleanText(general.name || general.locationName || restaurantGuid)
  if (!restaurantName) throw new ToastClientError('Toast restaurant details were invalid', 'TOAST_RESPONSE_INVALID')
  return {
    restaurantGuid,
    restaurantName,
    locationName: cleanText(general.locationName),
    locationCode: cleanText(general.locationCode, 64),
    timezone: cleanText(general.timeZone, 100),
    closeoutHour: optionalCloseoutHour(general.closeoutHour),
    active: general.archived !== true,
    testMode: false,
    archived: general.archived === true,
  }
}

function reportGuid(value: unknown) {
  const raw = typeof value === 'string' ? value : String(safeRecord(value).reportRequestGuid || '')
  return normalizeToastRestaurantGuid(raw.replace(/^"|"$/g, ''))
}

async function createOrRetrieveAnalyticsReport(input: {
  credential: ToastRuntimeCredential
  createPath: string
  retrievePath: string
  requestGuid?: string | null
  body: Record<string, unknown>
}): Promise<ToastReportResult> {
  const token = await authenticateToast(input.credential)
  let requestGuid = input.requestGuid ? normalizeToastRestaurantGuid(input.requestGuid) : ''
  if (!requestGuid) {
    const created = await authorizedRequest(input.credential, token, input.createPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.body),
    })
    requestGuid = reportGuid(created.data)
  }
  const retrieved = await authorizedRequest(
    input.credential,
    token,
    `${input.retrievePath}/${encodeURIComponent(requestGuid)}`,
  )
  if (retrieved.status === 202 || retrieved.status === 204 || retrieved.data === null) {
    return { ready: false, requestGuid, records: [] }
  }
  if (!Array.isArray(retrieved.data)) {
    const body = safeRecord(retrieved.data)
    const status = String(body.status || '').toUpperCase()
    if (status === 'PENDING' || status === 'PROCESSING') return { ready: false, requestGuid, records: [] }
    throw new ToastClientError('Toast analytics report response was invalid', 'TOAST_RESPONSE_INVALID')
  }
  return { ready: true, requestGuid, records: retrieved.data }
}

export function formatToastBusinessDate(value: unknown) {
  const normalized = String(value || '').replace(/-/g, '')
  if (!/^\d{8}$/.test(normalized)) throw new ToastClientError('Business date must use YYYY-MM-DD', 'TOAST_DATE_INVALID', 400)
  const year = Number(normalized.slice(0, 4))
  const month = Number(normalized.slice(4, 6))
  const day = Number(normalized.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ToastClientError('Business date is invalid', 'TOAST_DATE_INVALID', 400)
  }
  return normalized
}

export async function getToastAnalyticsSales(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  businessDate: string
  requestGuid?: string | null
}) {
  const businessDate = formatToastBusinessDate(input.businessDate)
  return createOrRetrieveAnalyticsReport({
    credential: input.credential,
    createPath: '/era/v1/metrics',
    retrievePath: '/era/v1/metrics',
    requestGuid: input.requestGuid,
    body: {
      startBusinessDate: businessDate,
      endBusinessDate: businessDate,
      restaurantIds: [normalizeToastRestaurantGuid(input.restaurantGuid)],
      excludedRestaurantIds: [],
      groupBy: ['REVENUE_CENTER'],
    },
  })
}

export async function getToastAnalyticsPayouts(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  businessDate: string
  requestGuid?: string | null
}) {
  const businessDate = formatToastBusinessDate(input.businessDate)
  return createOrRetrieveAnalyticsReport({
    credential: input.credential,
    createPath: '/era/v1/payout/day',
    retrievePath: '/era/v1/payout',
    requestGuid: input.requestGuid,
    body: {
      startDate: businessDate,
      endDate: businessDate,
      restaurantIds: [normalizeToastRestaurantGuid(input.restaurantGuid)],
      excludedRestaurantIds: [],
    },
  })
}

function toastMenuMetadata(value: unknown, expectedRestaurantGuid: string): ToastMenuMetadata {
  const body = safeRecord(value)
  const restaurantGuid = normalizeToastRestaurantGuid(body.restaurantGuid)
  if (restaurantGuid !== expectedRestaurantGuid) {
    throw new ToastClientError('Toast menu metadata did not match the requested restaurant', 'TOAST_RESPONSE_INVALID')
  }
  return {
    restaurantGuid,
    sourceRevision: absoluteTimestamp(body.lastUpdated, 'menu revision'),
  }
}

function normalizeToastMenuCatalog(
  value: unknown,
  expectedRestaurantGuid: string,
  metadata: ToastMenuMetadata,
): ToastMenuCatalogSnapshot {
  const body = safeRecord(value)
  const restaurantGuid = normalizeToastRestaurantGuid(body.restaurantGuid)
  if (restaurantGuid !== expectedRestaurantGuid) {
    throw new ToastClientError('Toast menu data did not match the requested restaurant', 'TOAST_RESPONSE_INVALID')
  }
  const sourceRevision = absoluteTimestamp(body.lastUpdated || metadata.sourceRevision, 'menu revision')
  const menus = new Map<string, ToastMenuCatalogMenu>()
  const groups = new Map<string, ToastMenuCatalogGroup>()
  const items = new Map<string, ToastMenuCatalogItem>()
  const salesCategories = new Map<string, ToastMenuCatalogSalesCategory>()

  const visitGroup = (
    menuGuid: string,
    value: unknown,
    parentGroupGuid: string | null,
    position: number,
  ) => {
    const record = safeRecord(value)
    const groupGuid = optionalToastGuid(record.guid)
    if (!groupGuid) return
    const state = catalogEntityState(record)
    groups.set(`${menuGuid}:${groupGuid}`, {
      menuGuid,
      groupGuid,
      parentGroupGuid,
      sourceProvider: 'toast',
      providerGroupId: groupGuid,
      name: cleanText(record.name, 240) || 'Missing name',
      visibility: visibilityList(record.visibility),
      active: state.active,
      archived: state.archived,
      position,
    })

    const menuItems = Array.isArray(record.menuItems) ? record.menuItems : []
    for (const [itemPosition, itemValue] of menuItems.entries()) {
      const itemRecord = safeRecord(itemValue)
      const itemGuid = optionalToastGuid(itemRecord.guid)
      if (!itemGuid) continue
      const itemState = catalogEntityState(itemRecord)
      const salesCategoryRecord = safeRecord(itemRecord.salesCategory)
      const salesCategoryGuid = optionalToastGuid(salesCategoryRecord.guid)
      if (salesCategoryGuid) {
        const categoryState = catalogEntityState(salesCategoryRecord)
        salesCategories.set(salesCategoryGuid, {
          salesCategoryGuid,
          sourceProvider: 'toast',
          providerSalesCategoryId: salesCategoryGuid,
          name: cleanText(salesCategoryRecord.name, 240) || 'Missing name',
          plu: cleanText(salesCategoryRecord.plu, 200),
          active: categoryState.active,
          archived: categoryState.archived,
        })
      }
      items.set(`${menuGuid}:${groupGuid}:${itemGuid}`, {
        menuGuid,
        groupGuid,
        itemGuid,
        sourceProvider: 'toast',
        providerItemId: itemGuid,
        name: cleanText(itemRecord.name, 240) || 'Missing name',
        plu: cleanText(itemRecord.plu, 200),
        price: catalogPrice(itemRecord.price),
        visibility: visibilityList(itemRecord.visibility),
        salesCategoryGuid,
        providerSalesCategoryId: salesCategoryGuid,
        active: itemState.active,
        archived: itemState.archived,
        position: itemPosition,
      })
    }

    const nestedGroups = Array.isArray(record.menuGroups) ? record.menuGroups : []
    for (const [groupPosition, nestedGroup] of nestedGroups.entries()) {
      visitGroup(menuGuid, nestedGroup, groupGuid, groupPosition)
    }
  }

  const menuRecords = Array.isArray(body.menus) ? body.menus : []
  for (const [menuPosition, menuValue] of menuRecords.entries()) {
    const menuRecord = safeRecord(menuValue)
    const menuGuid = optionalToastGuid(menuRecord.guid)
    if (!menuGuid) continue
    const state = catalogEntityState(menuRecord)
    menus.set(menuGuid, {
      menuGuid,
      sourceProvider: 'toast',
      providerMenuId: menuGuid,
      name: cleanText(menuRecord.name, 240) || 'Missing name',
      visibility: visibilityList(menuRecord.visibility),
      active: state.active,
      archived: state.archived,
      position: menuPosition,
    })
    const menuGroups = Array.isArray(menuRecord.menuGroups) ? menuRecord.menuGroups : []
    for (const [groupPosition, groupValue] of menuGroups.entries()) {
      visitGroup(menuGuid, groupValue, null, groupPosition)
    }
  }

  return {
    restaurantGuid,
    sourceProvider: 'toast',
    providerRestaurantId: restaurantGuid,
    sourceRevision,
    restaurantTimeZone: cleanText(body.restaurantTimeZone, 100),
    menus: [...menus.values()],
    groups: [...groups.values()],
    items: [...items.values()],
    salesCategories: [...salesCategories.values()],
  }
}

function unavailableMenuResult(
  error: unknown,
  metadata: ToastMenuMetadata | null,
): ToastMenuCatalogFetchResult | null {
  if (!(error instanceof ToastClientError)) return null
  if (error.status === 403) {
    return {
      status: 'unavailable',
      metadata,
      catalog: null,
      reason: 'menus_scope_required',
      errorCode: 'TOAST_MENUS_SCOPE_REQUIRED',
    }
  }
  if (error.status === 404) {
    return {
      status: 'unavailable',
      metadata,
      catalog: null,
      reason: 'menu_not_published',
      errorCode: 'TOAST_MENUS_NOT_PUBLISHED',
    }
  }
  return null
}

export async function getToastMenuCatalogV2(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  currentSourceRevision?: string | null
  force?: boolean
}): Promise<ToastMenuCatalogFetchResult> {
  const restaurantGuid = normalizeToastRestaurantGuid(input.restaurantGuid)
  const token = await authenticateToast(input.credential)
  let metadata: ToastMenuMetadata
  try {
    const response = await authorizedRequest(
      input.credential,
      token,
      '/menus/v2/metadata',
      {},
      restaurantGuid,
    )
    metadata = toastMenuMetadata(response.data, restaurantGuid)
  } catch (error) {
    const unavailable = unavailableMenuResult(error, null)
    if (unavailable) return unavailable
    throw error
  }

  const currentRevision = input.currentSourceRevision ? Date.parse(input.currentSourceRevision) : Number.NaN
  if (!input.force && Number.isFinite(currentRevision) && Date.parse(metadata.sourceRevision) <= currentRevision) {
    return { status: 'unchanged', metadata, catalog: null }
  }

  try {
    const response = await authorizedRequest(
      input.credential,
      token,
      '/menus/v2/menus',
      {},
      restaurantGuid,
    )
    return {
      status: 'updated',
      metadata,
      catalog: normalizeToastMenuCatalog(response.data, restaurantGuid, metadata),
    }
  } catch (error) {
    const unavailable = unavailableMenuResult(error, metadata)
    if (unavailable) return unavailable
    throw error
  }
}

async function getToastStandardOrdersByQuery(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  query: string
}) {
  const restaurantGuid = normalizeToastRestaurantGuid(input.restaurantGuid)
  const token = await authenticateToast(input.credential)
  const records: unknown[] = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await authorizedRequest(
      input.credential,
      token,
      `/orders/v2/ordersBulk?${input.query}&pageSize=100&page=${page}`,
      {},
      restaurantGuid,
    )
    if (!Array.isArray(response.data)) throw new ToastClientError('Toast orders response was invalid', 'TOAST_RESPONSE_INVALID')
    records.push(...response.data)
    if (response.data.length < 100) return records
  }
  throw new ToastClientError('Toast orders exceeded the supported pagination limit', 'TOAST_PAGINATION_LIMIT')
}

export async function getToastStandardOrders(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  businessDate: string
}) {
  return getToastStandardOrdersByQuery({
    credential: input.credential,
    restaurantGuid: input.restaurantGuid,
    query: `businessDate=${formatToastBusinessDate(input.businessDate)}`,
  })
}

export async function getToastStandardOrderUpdates(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  startDate: string
  endDate: string
}) {
  const start = new Date(input.startDate)
  const end = new Date(input.endDate)
  const duration = end.getTime() - start.getTime()
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || duration <= 0 || duration > 31 * 86_400_000) {
    throw new ToastClientError('Toast modified-order window was invalid', 'TOAST_DATE_INVALID')
  }
  return getToastStandardOrdersByQuery({
    credential: input.credential,
    restaurantGuid: input.restaurantGuid,
    query: `startDate=${encodeURIComponent(start.toISOString())}&endDate=${encodeURIComponent(end.toISOString())}`,
  })
}
