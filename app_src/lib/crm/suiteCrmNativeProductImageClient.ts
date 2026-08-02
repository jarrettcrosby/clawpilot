import { createHash } from 'node:crypto'

import type { SuiteCrmOutboxRecord } from '@/lib/crm/types'
import { publicCrmProductImageUrl } from '@/lib/crm/productImagePublic'
import { appPublicUrl } from '@/lib/publicUrl'

export const SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD = 'clawpilot_image_c'

const SUITECRM_FRONTEND_PRODUCT_MODULE = 'products'
const SUITECRM_MEDIA_MAX_BYTES = 2 * 1024 * 1024
const SUITECRM_MEDIA_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const MEDIA_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

type NativeProductImageRecord = Pick<
  SuiteCrmOutboxRecord,
  'entity' | 'suiteCrmId' | 'productImage'
>

type GraphQlRecord = {
  _id?: unknown
  module?: unknown
  attributes?: unknown
}

type MediaObjectRecord = {
  id: string
  originalName: string
}

export type SuiteCrmNativeProductImageResult =
  | { action: 'disabled'; mediaId: null }
  | { action: 'unchanged'; mediaId: string | null }
  | { action: 'attached'; mediaId: string }
  | { action: 'cleared'; mediaId: null }

function nativeProductImageProjectionEnabled() {
  return process.env.SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED === '1'
}

function suiteCrmNativeBaseUrl(value = process.env.SUITECRM_BASE_URL) {
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
    ) {
      throw new Error('unsafe URL')
    }
    return url.toString().replace(/\/$/u, '')
  } catch {
    throw new Error('SUITECRM_BASE_URL is not configured safely')
  }
}

function requiredMediaCredential(
  name: 'SUITECRM_MEDIA_USERNAME' | 'SUITECRM_MEDIA_PASSWORD',
) {
  const raw = String(process.env[name] ?? '')
  const value = name === 'SUITECRM_MEDIA_USERNAME' ? raw.trim() : raw
  const maxLength = name === 'SUITECRM_MEDIA_USERNAME' ? 255 : 4096
  if (!value || value.length > maxLength || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${name} is not configured safely`)
  }
  return value
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > SUITECRM_MEDIA_MAX_BYTES) {
    throw new Error('SuiteCRM returned an oversized response')
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`SuiteCRM returned an invalid response (${response.status})`)
  }
}

function suiteCrmErrorDetail(parsed: Record<string, unknown>) {
  const graphQlErrors = Array.isArray(parsed.errors) ? parsed.errors : []
  const violations = Array.isArray(parsed.violations) ? parsed.violations : []
  return [...graphQlErrors, ...violations]
    .slice(0, 3)
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ''
      const error = entry as Record<string, unknown>
      return String(error.message || error.detail || error.title || error.code || '')
        .replace(/[\r\n]+/gu, ' ')
        .trim()
    })
    .filter(Boolean)
    .join('; ')
    .slice(0, 500)
}

function combinedSetCookieValues(value: string) {
  return value
    .split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function responseSetCookies(headers: Headers) {
  const modern = headers as Headers & { getSetCookie?: () => string[] }
  const values = typeof modern.getSetCookie === 'function'
    ? modern.getSetCookie()
    : [headers.get('set-cookie') || '']
  return values.flatMap(combinedSetCookieValues)
}

class SuiteCrmSession {
  private cookies = new Map<string, string>()

  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch,
  ) {}

  absorbCookies(response: Response) {
    for (const setCookie of responseSetCookies(response.headers)) {
      const pair = setCookie.split(';', 1)[0] || ''
      const equals = pair.indexOf('=')
      if (equals < 1) continue
      const name = pair.slice(0, equals).trim()
      const value = pair.slice(equals + 1).trim()
      if (
        (name === 'XSRF-TOKEN' || name === 'SCRMSESSID')
        && value
        && !CONTROL_CHARACTER_PATTERN.test(value)
      ) {
        this.cookies.set(name, value)
      }
    }
  }

  private authenticatedHeaders(init?: HeadersInit) {
    const xsrfCookie = this.cookies.get('XSRF-TOKEN')
    const sessionCookie = this.cookies.get('SCRMSESSID')
    if (!xsrfCookie || !sessionCookie) {
      throw new Error('SuiteCRM did not establish a complete media session')
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
    const username = requiredMediaCredential('SUITECRM_MEDIA_USERNAME')
    const password = requiredMediaCredential('SUITECRM_MEDIA_PASSWORD')
    const statusResponse = await this.fetchImpl(`${this.baseUrl}/session-status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    this.absorbCookies(statusResponse)
    const initialStatus = await readBoundedJson(statusResponse)
    if (!statusResponse.ok) {
      const detail = suiteCrmErrorDetail(initialStatus)
      throw new Error(`SuiteCRM media session initialization failed (${statusResponse.status})${
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
        username,
        password,
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    this.absorbCookies(loginResponse)
    const login = await readBoundedJson(loginResponse)
    if (!loginResponse.ok || String(login.login_success || '') !== 'true') {
      const detail = suiteCrmErrorDetail(login)
      throw new Error(`SuiteCRM media authentication failed (${loginResponse.status})${
        detail ? `: ${detail}` : ''
      }`)
    }

    const verifiedResponse = await this.request('/session-status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const verified = await readBoundedJson(verifiedResponse)
    if (!verifiedResponse.ok || verified.active !== true) {
      throw new Error(`SuiteCRM media session verification failed (${verifiedResponse.status})`)
    }
  }

  async request(pathname: string, init: RequestInit) {
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: this.authenticatedHeaders(init.headers),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    this.absorbCookies(response)
    return response
  }
}

function graphQlRecord(parsed: Record<string, unknown>, path: 'record' | 'saveRecord') {
  const data = parsed.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (path === 'record') {
    const record = (data as Record<string, unknown>).record
    return record && typeof record === 'object' && !Array.isArray(record)
      ? record as GraphQlRecord
      : null
  }
  const saveRecord = (data as Record<string, unknown>).saveRecord
  if (!saveRecord || typeof saveRecord !== 'object' || Array.isArray(saveRecord)) return null
  const record = (saveRecord as Record<string, unknown>).record
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record as GraphQlRecord
    : null
}

async function graphQlRequest(
  session: SuiteCrmSession,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await session.request('/api/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operationName, query, variables }),
  })
  const parsed = await readBoundedJson(response)
  const detail = suiteCrmErrorDetail(parsed)
  if (!response.ok || detail) {
    throw new Error(`SuiteCRM media GraphQL request failed (${response.status})${
      detail ? `: ${detail}` : ''
    }`)
  }
  return parsed
}

function fieldMediaRecord(value: unknown): MediaObjectRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const attributes = record.attributes && typeof record.attributes === 'object'
    && !Array.isArray(record.attributes)
    ? record.attributes as Record<string, unknown>
    : {}
  const id = String(record.id || attributes.id || '').trim()
  if (!SUITECRM_MEDIA_ID_PATTERN.test(id)) return null
  return {
    id,
    originalName: String(
      attributes.original_name || attributes.originalName || record.originalName || '',
    ).trim(),
  }
}

function imageFieldValue(record: GraphQlRecord) {
  const attributes = record.attributes
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  return fieldMediaRecord(
    (attributes as Record<string, unknown>)[SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD],
  )
}

async function readCurrentProductImage(
  session: SuiteCrmSession,
  suiteCrmId: string,
) {
  const parsed = await graphQlRequest(
    session,
    'ClawPilotProductImage',
    `query ClawPilotProductImage($module: String!, $record: String!) {
      record(module: $module, record: $record) {
        _id
        module
        attributes
      }
    }`,
    { module: SUITECRM_FRONTEND_PRODUCT_MODULE, record: suiteCrmId },
  )
  const record = graphQlRecord(parsed, 'record')
  if (!record || String(record._id || '') !== suiteCrmId) {
    throw new Error('SuiteCRM returned an unexpected Product image record')
  }
  return imageFieldValue(record)
}

async function saveProductImage(
  session: SuiteCrmSession,
  suiteCrmId: string,
  fieldValue: Record<string, unknown>,
  expectedMediaId: string | null,
) {
  const parsed = await graphQlRequest(
    session,
    'ClawPilotSaveProductImage',
    `mutation ClawPilotSaveProductImage($input: saveRecordInput!) {
      saveRecord(input: $input) {
        record {
          _id
          module
          attributes
        }
      }
    }`,
    {
      input: {
        _id: suiteCrmId,
        module: SUITECRM_FRONTEND_PRODUCT_MODULE,
        // SuiteCRM 8.10.1's GraphQL input carries `_id`, but its legacy
        // RecordHandler selects the bean to update from attributes.id. Keep
        // both identities exact so a retry updates this AOS Product instead
        // of creating another record.
        attributes: {
          id: suiteCrmId,
          [SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD]: fieldValue,
        },
      },
    },
  )
  const record = graphQlRecord(parsed, 'saveRecord')
  if (!record || String(record._id || '') !== suiteCrmId) {
    throw new Error('SuiteCRM returned an unexpected saved Product image record')
  }
  const savedMedia = imageFieldValue(record)
  if (expectedMediaId === null ? savedMedia !== null : savedMedia?.id !== expectedMediaId) {
    throw new Error('SuiteCRM did not confirm the native Product image association')
  }
}

async function readBytesWithLimit(response: Response) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > SUITECRM_MEDIA_MAX_BYTES) {
      await reader.cancel()
      throw new Error('Product image exceeds the SuiteCRM media limit')
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

async function fetchProductImage(
  imageUrl: string,
  expectedSha256: string,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(imageUrl, {
    method: 'GET',
    headers: { Accept: 'image/png, image/jpeg, image/webp' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new Error(`ClawPilot Product image source failed (${response.status})`)
  }
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > SUITECRM_MEDIA_MAX_BYTES) {
    throw new Error('Product image exceeds the SuiteCRM media limit')
  }
  const mimeType = String(response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const extension = MEDIA_EXTENSION[mimeType]
  if (!extension) throw new Error('Product image source returned an unsupported media type')
  const bytes = await readBytesWithLimit(response)
  if (!bytes.byteLength) throw new Error('Product image source returned an empty file')
  const contentSha256 = createHash('sha256').update(bytes).digest('hex')
  if (contentSha256 !== expectedSha256) {
    throw new Error('Product image source content identity does not match the projection')
  }
  return { bytes, mimeType, extension }
}

async function uploadProductImage(
  session: SuiteCrmSession,
  input: { bytes: Uint8Array; mimeType: string; filename: string },
) {
  const form = new FormData()
  const blobBytes = new Uint8Array(input.bytes.byteLength)
  blobBytes.set(input.bytes)
  form.append('parentType', SUITECRM_FRONTEND_PRODUCT_MODULE)
  form.append('parentField', SUITECRM_NATIVE_PRODUCT_IMAGE_FIELD)
  form.append('file', new Blob([blobBytes.buffer], { type: input.mimeType }), input.filename)
  const response = await session.request('/api/private-image-media-objects', {
    method: 'POST',
    headers: { Accept: 'application/ld+json' },
    body: form,
  })
  const parsed = await readBoundedJson(response)
  if (response.status !== 201) {
    const detail = suiteCrmErrorDetail(parsed)
    throw new Error(`SuiteCRM native Product image upload failed (${response.status})${
      detail ? `: ${detail}` : ''
    }`)
  }
  const id = String(parsed.id || '').trim()
  const originalName = String(parsed.originalName || '').trim()
  const mimeType = String(parsed.mimeType || '').trim().toLowerCase()
  const size = Number(parsed.size)
  if (
    !SUITECRM_MEDIA_ID_PATTERN.test(id)
    || originalName !== input.filename
    || mimeType !== input.mimeType
    || size !== input.bytes.byteLength
  ) {
    throw new Error('SuiteCRM returned invalid native Product image metadata')
  }
  return {
    id,
    contentUrl: String(parsed.contentUrl || '').trim(),
    originalName,
    mimeType,
    size,
  }
}

function safeSuiteCrmId(value: unknown) {
  const id = String(value || '').trim()
  if (!id || id.length > 100 || CONTROL_CHARACTER_PATTERN.test(id)) {
    throw new Error('SuiteCRM Product image record ID is invalid')
  }
  return id
}

export async function projectSuiteCrmNativeProductImage(
  record: NativeProductImageRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<SuiteCrmNativeProductImageResult> {
  if (record.entity !== 'products') {
    throw new Error('SuiteCRM native Product images can only be projected for Products')
  }
  if (record.productImage === undefined) {
    return { action: 'unchanged', mediaId: null }
  }
  if (!nativeProductImageProjectionEnabled()) {
    return { action: 'disabled', mediaId: null }
  }
  const suiteCrmId = safeSuiteCrmId(record.suiteCrmId)
  const session = new SuiteCrmSession(suiteCrmNativeBaseUrl(), fetchImpl)
  await session.establish()
  const current = await readCurrentProductImage(session, suiteCrmId)

  if (record.productImage === null) {
    if (!current) return { action: 'unchanged', mediaId: null }
    await saveProductImage(session, suiteCrmId, {
      id: '',
      module: 'media-objects',
      attributes: { id: '' },
    }, null)
    return { action: 'cleared', mediaId: null }
  }

  const referenceCode = String(record.productImage.referenceCode || '').trim().toLowerCase()
  const contentSha256 = String(record.productImage.contentSha256 || '').trim().toLowerCase()
  const imageUrl = publicCrmProductImageUrl({
    publicOrigin: appPublicUrl(),
    productReferenceCode: referenceCode,
    contentSha256,
  })
  const extensionFromCurrent = current?.originalName.split('.').at(-1)?.toLowerCase()
  if (
    current
    && extensionFromCurrent
    && Object.values(MEDIA_EXTENSION).includes(extensionFromCurrent)
    && current.originalName === `${referenceCode}-${contentSha256}.${extensionFromCurrent}`
  ) {
    return { action: 'unchanged', mediaId: current.id }
  }

  const image = await fetchProductImage(imageUrl, contentSha256, fetchImpl)
  const filename = `${referenceCode}-${contentSha256}.${image.extension}`
  const uploaded = await uploadProductImage(session, {
    bytes: image.bytes,
    mimeType: image.mimeType,
    filename,
  })
  // If the save fails, SuiteCRM retains the upload as a temporary object and
  // its own cleanup scheduler removes it. A retry first checks for an attached
  // deterministic filename, so completed associations are idempotent.
  await saveProductImage(session, suiteCrmId, {
    id: uploaded.id,
    module: 'media-objects',
    attributes: {
      id: uploaded.id,
      original_name: uploaded.originalName,
      size: uploaded.size,
      mime_type: uploaded.mimeType,
      contentUrl: uploaded.contentUrl,
    },
  }, uploaded.id)
  return { action: 'attached', mediaId: uploaded.id }
}
