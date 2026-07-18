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
  active: boolean
  testMode: boolean
  archived: boolean
}

export type ToastReportResult = {
  ready: boolean
  requestGuid: string
  records: unknown[]
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

export async function getToastStandardOrders(input: {
  credential: ToastRuntimeCredential
  restaurantGuid: string
  businessDate: string
}) {
  const restaurantGuid = normalizeToastRestaurantGuid(input.restaurantGuid)
  const businessDate = formatToastBusinessDate(input.businessDate)
  const token = await authenticateToast(input.credential)
  const records: unknown[] = []
  for (let page = 1; page <= 100; page += 1) {
    const response = await authorizedRequest(
      input.credential,
      token,
      `/orders/v2/ordersBulk?businessDate=${businessDate}&pageSize=100&page=${page}`,
      {},
      restaurantGuid,
    )
    if (!Array.isArray(response.data)) throw new ToastClientError('Toast orders response was invalid', 'TOAST_RESPONSE_INVALID')
    records.push(...response.data)
    if (response.data.length < 100) return records
  }
  throw new ToastClientError('Toast orders exceeded the supported pagination limit', 'TOAST_PAGINATION_LIMIT')
}
