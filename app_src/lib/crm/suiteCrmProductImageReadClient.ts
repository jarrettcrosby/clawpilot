import { createHash } from 'node:crypto'

export const SUITECRM_PRODUCT_IMAGE_READ_REQUIRED_ACL = Object.freeze({
  module: 'AOS_Products',
  moduleActions: ['list', 'view'] as const,
  field: 'clawpilot_image_c',
  mediaActions: ['view'] as const,
  forbiddenActions: [
    'create',
    'edit',
    'delete',
    'import',
    'export',
    'mass_update',
  ] as const,
})

export const SUITECRM_PRODUCT_IMAGE_READ_CREDENTIAL_NAMES = Object.freeze([
  'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID',
  'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
  'SUITECRM_PRODUCT_IMAGE_READ_USERNAME',
  'SUITECRM_PRODUCT_IMAGE_READ_PASSWORD',
] as const)

export const SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION =
  'suitecrm-product-image-read-acl-v2'

export const SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_NAMES = Object.freeze([
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID',
  'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME',
] as const)

const SUITECRM_OTHER_CREDENTIAL_NAMES = Object.freeze([
  'SUITECRM_CLIENT_ID',
  'SUITECRM_CLIENT_SECRET',
  'SUITECRM_ADMIN_USER',
  'SUITECRM_ADMIN_USERNAME',
  'SUITECRM_ADMIN_PASSWORD',
  'SUITECRM_MEDIA_USERNAME',
  'SUITECRM_MEDIA_PASSWORD',
] as const)

const SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD = 'clawpilot_image_c'
const SUITECRM_FRONTEND_PRODUCT_MODULE = 'products'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

type CredentialName =
  (typeof SUITECRM_PRODUCT_IMAGE_READ_CREDENTIAL_NAMES)[number]

export type SuiteCrmProductImageProductSnapshot = {
  id: string
  globalId: string | null
  name: string
  modifiedAt: string
  deleted: boolean
}

export type SuiteCrmProductImageMediaSnapshot = {
  mediaId: string
  originalName: string
  mimeType: string
  byteLength: number
  contentSha256: string
  bytes: Uint8Array
}

export type SuiteCrmProductImageListPage = {
  products: SuiteCrmProductImageProductSnapshot[]
  totalPages: number
  totalRecords: number
}

export type SuiteCrmProductImageReadClient = {
  listProductsUpdatedSince(input: {
    updatedSince: string
    updatedBeforeOrAt: string
    page: number
    pageSize?: number
  }): Promise<SuiteCrmProductImageListPage>
  readProductImage(suiteCrmId: string, expectedModifiedAt: string): Promise<
    SuiteCrmProductImageMediaSnapshot | null
  >
}

type JsonObject = Record<string, unknown>

function configuredBaseUrl(value = process.env.SUITECRM_BASE_URL) {
  const configured = String(value || '').trim()
  if (!configured) throw new Error('SUITECRM_BASE_URL is not configured')
  try {
    const url = new URL(configured)
    const privateRailway = url.protocol === 'http:'
      && url.hostname.endsWith('.railway.internal')
    if (
      (!privateRailway && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash
    ) throw new Error('unsafe URL')
    return url.toString().replace(/\/$/u, '')
  } catch {
    throw new Error('SUITECRM_BASE_URL is not configured safely')
  }
}

function requiredCredential(name: CredentialName) {
  const raw = String(process.env[name] ?? '')
  const preserveWhitespace = name.endsWith('_PASSWORD')
    || name.endsWith('_CLIENT_SECRET')
  const value = preserveWhitespace ? raw : raw.trim()
  const maxLength = name.endsWith('_USERNAME') ? 255 : 4096
  if (
    !value
    || value.length > maxLength
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) throw new Error(`${name} is not configured safely`)
  return value
}

export function suiteCrmProductImageReverseIngestionEnabled() {
  return process.env.SUITECRM_PRODUCT_IMAGE_REVERSE_INGESTION_ENABLED === '1'
}

function comparableCredential(name: string, value: string) {
  if (name.endsWith('_USERNAME') || name.endsWith('_USER')) {
    return value.trim().toLowerCase()
  }
  if (name.endsWith('_CLIENT_ID')) return value.trim()
  return value
}

export function suiteCrmProductImageReadConfiguration() {
  const missingCredentials = SUITECRM_PRODUCT_IMAGE_READ_CREDENTIAL_NAMES.filter(
    (name) => !String(process.env[name] ?? '').trim(),
  )
  const missingAttestation = SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_NAMES
    .filter((name) => !String(process.env[name] ?? '').trim())
  const attested = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED || '',
  ).trim() === '1'
  const attestationVersion = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION || '',
  ).trim()
  const attestedUsername = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME || '',
  ).trim()
  const attestedClientId = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID || '',
  ).trim()
  const attestedOauthUsername = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME || '',
  ).trim()
  const configuredUsername = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_USERNAME || '',
  ).trim()
  const configuredClientId = String(
    process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID || '',
  ).trim()
  const normalizedConfiguredUsername = configuredUsername.toLowerCase()
  const usernameBound = Boolean(configuredUsername)
    && attestedUsername.toLowerCase() === normalizedConfiguredUsername
  const clientBound = Boolean(configuredClientId)
    && attestedClientId === configuredClientId
  const oauthPrincipalBound = Boolean(configuredUsername)
    && attestedOauthUsername.toLowerCase() === normalizedConfiguredUsername
  const attestationCurrent = attested
    && attestationVersion === SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION
    && usernameBound
    && clientBound
    && oauthPrincipalBound

  const configuredReadCredentials = SUITECRM_PRODUCT_IMAGE_READ_CREDENTIAL_NAMES
    .map((name) => ({
      name,
      value: comparableCredential(name, String(process.env[name] ?? '')),
    }))
    .filter((entry) => entry.value.length > 0)
  const configuredOtherCredentials = SUITECRM_OTHER_CREDENTIAL_NAMES
    .map((name) => ({
      name,
      value: comparableCredential(name, String(process.env[name] ?? '')),
    }))
    .filter((entry) => entry.value.length > 0)
  const credentialConflicts = configuredReadCredentials.flatMap((read) => (
    configuredOtherCredentials
      .filter((other) => read.value === other.value)
      .map((other) => `${read.name}:${other.name}`)
  ))
  const invalid = [
    ...(!attested && !missingAttestation.includes(
      'SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED',
    ) ? ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED'] : []),
    ...(attestationVersion
      && attestationVersion !== SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION
      ? ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION']
      : []),
    ...(attestedUsername && configuredUsername && !usernameBound
      ? ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_USERNAME']
      : []),
    ...(attestedClientId && configuredClientId && !clientBound
      ? ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_CLIENT_ID']
      : []),
    ...(attestedOauthUsername && configuredUsername && !oauthPrincipalBound
      ? ['SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTED_OAUTH_USERNAME']
      : []),
  ]
  const missing = [...missingCredentials, ...missingAttestation]
  return {
    enabled: suiteCrmProductImageReverseIngestionEnabled(),
    ready: missing.length === 0
      && invalid.length === 0
      && credentialConflicts.length === 0
      && attestationCurrent,
    missing,
    invalid,
    credentialConflicts,
    credentialSeparationVerified: missingCredentials.length === 0
      && credentialConflicts.length === 0,
    aclAttestation: {
      attested,
      current: attestationCurrent,
      requiredVersion: SUITECRM_PRODUCT_IMAGE_READ_ACL_ATTESTATION_VERSION,
      configuredVersion: attestationVersion || null,
      principalBound: usernameBound,
      clientBound,
      oauthPrincipalBound,
    },
    acl: SUITECRM_PRODUCT_IMAGE_READ_REQUIRED_ACL,
  }
}

async function readBoundedBytes(response: Response) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('SuiteCRM Product image exceeds the ingestion limit')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('SuiteCRM Product image exceeds the ingestion limit')
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBoundedJson(response: Response): Promise<JsonObject> {
  const bytes = await readBoundedBytes(response)
  const raw = Buffer.from(bytes).toString('utf8')
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as JsonObject
  } catch {
    throw new Error(`SuiteCRM returned an invalid response (${response.status})`)
  }
}

function errorDetail(parsed: JsonObject) {
  const errors = Array.isArray(parsed.errors) ? parsed.errors : []
  const violations = Array.isArray(parsed.violations) ? parsed.violations : []
  return [...errors, ...violations]
    .slice(0, 3)
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
      const error = entry as JsonObject
      return String(error.message || error.detail || error.title || error.code || '')
        .replace(/[\r\n]+/gu, ' ')
        .trim()
    })
    .filter(Boolean)
    .join('; ')
    .slice(0, 500)
}

function setCookieValues(headers: Headers) {
  const modern = headers as Headers & { getSetCookie?: () => string[] }
  const values = typeof modern.getSetCookie === 'function'
    ? modern.getSetCookie()
    : [headers.get('set-cookie') || '']
  return values.flatMap((value) => value
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/u)
    .map((entry) => entry.trim())
    .filter(Boolean))
}

class SuiteCrmReadSession {
  private cookies = new Map<string, string>()

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private absorbCookies(response: Response) {
    for (const setCookie of setCookieValues(response.headers)) {
      const pair = setCookie.split(';', 1)[0] || ''
      const equals = pair.indexOf('=')
      if (equals < 1) continue
      const name = pair.slice(0, equals).trim()
      const value = pair.slice(equals + 1).trim()
      if (
        (name === 'XSRF-TOKEN' || name === 'SCRMSESSID')
        && value
        && !CONTROL_CHARACTER_PATTERN.test(value)
      ) this.cookies.set(name, value)
    }
  }

  private authenticatedHeaders(init?: HeadersInit) {
    const xsrfCookie = this.cookies.get('XSRF-TOKEN')
    const sessionCookie = this.cookies.get('SCRMSESSID')
    if (!xsrfCookie || !sessionCookie) {
      throw new Error('SuiteCRM did not establish a complete read session')
    }
    let xsrfToken = ''
    try {
      xsrfToken = decodeURIComponent(xsrfCookie)
    } catch {
      throw new Error('SuiteCRM returned an invalid CSRF token')
    }
    if (!xsrfToken || CONTROL_CHARACTER_PATTERN.test(xsrfToken)) {
      throw new Error('SuiteCRM returned an invalid CSRF token')
    }
    const headers = new Headers(init)
    headers.set('Cookie', `XSRF-TOKEN=${xsrfCookie}; SCRMSESSID=${sessionCookie}`)
    headers.set('X-XSRF-TOKEN', xsrfToken)
    return headers
  }

  async establish() {
    const statusResponse = await this.fetchImpl(`${this.baseUrl}/session-status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    this.absorbCookies(statusResponse)
    const status = await readBoundedJson(statusResponse)
    if (!statusResponse.ok) {
      const detail = errorDetail(status)
      throw new Error(`SuiteCRM read session initialization failed (${statusResponse.status})${
        detail ? `: ${detail}` : ''
      }`)
    }
    const loginResponse = await this.fetchImpl(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: this.authenticatedHeaders({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        username: requiredCredential('SUITECRM_PRODUCT_IMAGE_READ_USERNAME'),
        password: requiredCredential('SUITECRM_PRODUCT_IMAGE_READ_PASSWORD'),
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    this.absorbCookies(loginResponse)
    const login = await readBoundedJson(loginResponse)
    if (!loginResponse.ok || String(login.login_success || '') !== 'true') {
      const detail = errorDetail(login)
      throw new Error(`SuiteCRM read authentication failed (${loginResponse.status})${
        detail ? `: ${detail}` : ''
      }`)
    }
    const verifiedResponse = await this.request('/session-status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const verified = await readBoundedJson(verifiedResponse)
    if (!verifiedResponse.ok || verified.active !== true) {
      throw new Error(`SuiteCRM read session verification failed (${verifiedResponse.status})`)
    }
  }

  async request(pathname: string, init: RequestInit) {
    const method = String(init.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      throw new Error('SuiteCRM Product image reader forbids write methods')
    }
    if (method === 'POST' && pathname !== '/api/graphql') {
      throw new Error('SuiteCRM Product image reader only permits read queries')
    }
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      method,
      headers: this.authenticatedHeaders(init.headers),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    this.absorbCookies(response)
    return response
  }
}

function safeSuiteCrmId(value: unknown) {
  const id = String(value || '').trim()
  if (!id || id.length > 100 || CONTROL_CHARACTER_PATTERN.test(id)) {
    throw new Error('SuiteCRM Product image record ID is invalid')
  }
  return id
}

function safeProductName(value: unknown) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500)
}

function parsedDate(value: unknown, label: string) {
  const parsed = new Date(String(value || ''))
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`SuiteCRM Product image ${label} is invalid`)
  }
  return parsed.toISOString()
}

function deletedValue(value: unknown) {
  if (value === true || value === 1) return true
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

function safePage(input: {
  updatedSince: string
  updatedBeforeOrAt: string
  page: number
  pageSize?: number
}) {
  const updatedSince = parsedDate(input.updatedSince, 'cursor')
  const updatedBeforeOrAt = parsedDate(
    input.updatedBeforeOrAt,
    'upper cursor',
  )
  const page = Math.trunc(Number(input.page))
  const pageSize = Math.trunc(Number(input.pageSize || 50))
  if (Date.parse(updatedBeforeOrAt) < Date.parse(updatedSince)) {
    throw new Error('SuiteCRM Product image cursor range is invalid')
  }
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new Error('SuiteCRM Product image page is invalid')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('SuiteCRM Product image page size is invalid')
  }
  return { updatedSince, updatedBeforeOrAt, page, pageSize }
}

class SuiteCrmProductImageReader implements SuiteCrmProductImageReadClient {
  private accessToken: { value: string; expiresAt: number } | null = null
  private mediaSession: SuiteCrmReadSession | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async oauthToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) {
      return this.accessToken.value
    }
    const response = await this.fetchImpl(`${this.baseUrl}/Api/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: requiredCredential('SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID'),
        client_secret: requiredCredential(
          'SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET',
        ),
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    const parsed = await readBoundedJson(response)
    const token = String(parsed.access_token || '').trim()
    if (!response.ok || !token || CONTROL_CHARACTER_PATTERN.test(token)) {
      const detail = errorDetail(parsed)
      throw new Error(`SuiteCRM Product image read OAuth failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`)
    }
    const ttl = Math.max(60, Math.min(Number(parsed.expires_in) || 3600, 86_400))
    this.accessToken = { value: token, expiresAt: Date.now() + ttl * 1000 }
    return token
  }

  async listProductsUpdatedSince(input: {
    updatedSince: string
    updatedBeforeOrAt: string
    page: number
    pageSize?: number
  }): Promise<SuiteCrmProductImageListPage> {
    const cursor = safePage(input)
    const token = await this.oauthToken()
    const parameters = new URLSearchParams({
      'fields[AOS_Products]': 'global_id_c,name,date_modified,deleted',
      'filter[date_modified][gte]': cursor.updatedSince,
      'filter[date_modified][lte]': cursor.updatedBeforeOrAt,
      'page[number]': String(cursor.page),
      'page[size]': String(cursor.pageSize),
      sort: 'date_modified',
    })
    const response = await this.fetchImpl(
      `${this.baseUrl}/Api/V8/module/AOS_Products?${parameters}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    )
    const parsed = await readBoundedJson(response)
    if (!response.ok) {
      const detail = errorDetail(parsed)
      throw new Error(`SuiteCRM Product image listing failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`)
    }
    if (!Array.isArray(parsed.data)) {
      throw new Error('SuiteCRM returned an invalid Product collection')
    }
    const products = parsed.data.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('SuiteCRM returned an invalid Product')
      }
      const record = entry as JsonObject
      const type = String(record.type || '').trim()
      const attributes = record.attributes
      if (
        type && type !== 'AOS_Products' && type !== 'AOS_Product'
        || !attributes
        || typeof attributes !== 'object'
        || Array.isArray(attributes)
      ) throw new Error('SuiteCRM returned an invalid Product')
      const values = attributes as JsonObject
      const globalId = String(values.global_id_c || '').trim().toLowerCase()
      const modifiedAt = parsedDate(
        values.date_modified,
        'modified timestamp',
      )
      if (
        Date.parse(modifiedAt) < Date.parse(cursor.updatedSince)
        || Date.parse(modifiedAt) > Date.parse(cursor.updatedBeforeOrAt)
      ) {
        throw new Error('SuiteCRM returned a Product outside the requested snapshot')
      }
      return {
        id: safeSuiteCrmId(record.id),
        globalId: /^gp(?:[0-9]{7}|[0-9a-v]{12})$/u.test(globalId)
          ? globalId
          : null,
        name: safeProductName(values.name),
        modifiedAt,
        deleted: deletedValue(values.deleted),
      }
    })
    if (products.length > cursor.pageSize) {
      throw new Error('SuiteCRM returned too many Products for one page')
    }
    const meta = parsed.meta
    const rawTotalPages = meta
      && typeof meta === 'object'
      && !Array.isArray(meta)
      ? (meta as JsonObject)['total-pages']
      : undefined
    const totalPages = Number(rawTotalPages)
    if (
      rawTotalPages === undefined
      || rawTotalPages === null
      || !Number.isSafeInteger(totalPages)
      || totalPages < 0
    ) throw new Error('SuiteCRM returned invalid Product pagination metadata')
    const rawTotalRecords = meta
      && typeof meta === 'object'
      && !Array.isArray(meta)
      ? (meta as JsonObject)['total-records']
        ?? (meta as JsonObject).totalRecords
      : undefined
    const totalRecords = Number(rawTotalRecords)
    if (
      rawTotalRecords === undefined
      || rawTotalRecords === null
      || !Number.isSafeInteger(totalRecords)
      || totalRecords < 0
      || totalRecords < products.length
    ) throw new Error('SuiteCRM returned invalid Product record count metadata')
    const normalizedTotalPages = Math.max(1, totalPages)
    if (
      normalizedTotalPages !== Math.max(
        1,
        Math.ceil(totalRecords / cursor.pageSize),
      )
    ) throw new Error('SuiteCRM returned inconsistent Product pagination metadata')
    return {
      products,
      totalPages: normalizedTotalPages,
      totalRecords,
    }
  }

  private async session() {
    if (this.mediaSession) return this.mediaSession
    const session = new SuiteCrmReadSession(this.baseUrl, this.fetchImpl)
    await session.establish()
    this.mediaSession = session
    return session
  }

  async readProductImage(
    suiteCrmId: string,
    expectedModifiedAt: string,
  ): Promise<
    SuiteCrmProductImageMediaSnapshot | null
  > {
    const id = safeSuiteCrmId(suiteCrmId)
    const expectedRevision = parsedDate(
      expectedModifiedAt,
      'expected image revision',
    )
    const session = await this.session()
    const query = `query ClawPilotReadProductImage($module: String!, $record: String!) {
      record(module: $module, record: $record) {
        _id
        module
        attributes
      }
    }`
    if (!/^\s*query\b/u.test(query) || /\bmutation\b/u.test(query)) {
      throw new Error('SuiteCRM Product image reader only permits GraphQL queries')
    }
    const response = await session.request('/api/graphql', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ClawPilotReadProductImage',
        query,
        variables: {
          module: SUITECRM_FRONTEND_PRODUCT_MODULE,
          record: id,
        },
      }),
    })
    const parsed = await readBoundedJson(response)
    const detail = errorDetail(parsed)
    if (!response.ok || detail) {
      throw new Error(`SuiteCRM Product image read query failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`)
    }
    const data = parsed.data
    const record = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as JsonObject).record
      : null
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('SuiteCRM returned an unexpected Product image record')
    }
    const graphRecord = record as JsonObject
    if (
      String(graphRecord._id || '') !== id
      || String(graphRecord.module || '').toLowerCase()
        !== SUITECRM_FRONTEND_PRODUCT_MODULE
    ) throw new Error('SuiteCRM returned an unexpected Product image record')
    const attributes = graphRecord.attributes
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw new Error('SuiteCRM returned invalid Product image attributes')
    }
    const imageAttributes = attributes as JsonObject
    const currentRevision = parsedDate(
      imageAttributes.date_modified,
      'image record modified timestamp',
    )
    if (currentRevision !== expectedRevision) {
      throw new Error('SuiteCRM Product image changed during the read')
    }
    const rawMedia = imageAttributes[SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD]
    if (rawMedia === null || rawMedia === undefined || rawMedia === '') return null
    if (!rawMedia || typeof rawMedia !== 'object' || Array.isArray(rawMedia)) {
      throw new Error('SuiteCRM returned invalid Product image metadata')
    }
    const media = rawMedia as JsonObject
    const mediaAttributes = media.attributes
      && typeof media.attributes === 'object'
      && !Array.isArray(media.attributes)
      ? media.attributes as JsonObject
      : {}
    const mediaId = String(
      media.id || mediaAttributes.id || '',
    ).trim().toLowerCase()
    const originalName = String(
      mediaAttributes.original_name
      || mediaAttributes.originalName
      || media.originalName
      || '',
    ).trim()
    const mimeType = String(
      mediaAttributes.mime_type
      || mediaAttributes.mimeType
      || media.mimeType
      || '',
    ).trim().toLowerCase()
    const byteLength = Number(
      mediaAttributes.size ?? media.size ?? Number.NaN,
    )
    const contentUrl = String(
      mediaAttributes.contentUrl
      || mediaAttributes.content_url
      || media.contentUrl
      || '',
    ).trim()
    if (
      !MEDIA_ID_PATTERN.test(mediaId)
      || !originalName
      || originalName.length > 512
      || CONTROL_CHARACTER_PATTERN.test(originalName)
      || !SUPPORTED_MIME_TYPES.has(mimeType)
      || !Number.isSafeInteger(byteLength)
      || byteLength < 1
      || byteLength > MAX_RESPONSE_BYTES
      || !contentUrl
    ) throw new Error('SuiteCRM returned invalid Product image metadata')
    let content: URL
    try {
      content = new URL(contentUrl, `${this.baseUrl}/`)
      const base = new URL(this.baseUrl)
      if (
        content.origin !== base.origin
        || content.username
        || content.password
        || content.search
        || content.hash
        || content.pathname !== `/api/private-image-media-objects/${mediaId}`
      ) throw new Error('unsafe content URL')
    } catch {
      throw new Error('SuiteCRM returned an unsafe Product image content URL')
    }
    const imageResponse = await session.request(
      content.pathname,
      {
        method: 'GET',
        headers: { Accept: 'image/png, image/jpeg, image/webp' },
      },
    )
    if (!imageResponse.ok) {
      throw new Error(`SuiteCRM Product image content read failed (${imageResponse.status})`)
    }
    const responseMimeType = String(
      imageResponse.headers.get('content-type') || '',
    ).split(';', 1)[0]!.trim().toLowerCase()
    if (responseMimeType !== mimeType) {
      throw new Error('SuiteCRM Product image content type does not match metadata')
    }
    const bytes = await readBoundedBytes(imageResponse)
    if (bytes.byteLength !== byteLength) {
      throw new Error('SuiteCRM Product image content length does not match metadata')
    }
    return {
      mediaId,
      originalName,
      mimeType,
      byteLength,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    }
  }
}

export function createSuiteCrmProductImageReadClient(
  fetchImpl: typeof fetch = fetch,
): SuiteCrmProductImageReadClient {
  return new SuiteCrmProductImageReader(configuredBaseUrl(), fetchImpl)
}
