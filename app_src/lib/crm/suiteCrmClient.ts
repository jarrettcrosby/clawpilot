import type { CrmEntity, SuiteCrmOutboxRecord, SuiteCrmUserIdentityOutboxRecord } from '@/lib/crm/types'
import { isIso4217CurrencyCode } from '@/lib/currency'
import { publicCrmProductImageUrl } from '@/lib/crm/productImagePublic'
import {
  projectSuiteCrmNativeProductImage,
  type SuiteCrmNativeProductImageResult,
} from '@/lib/crm/suiteCrmNativeProductImageClient'
import { appPublicUrl } from '@/lib/publicUrl'

type SuiteCrmRecordModule =
  | 'Accounts'
  | 'Contacts'
  | 'AOS_Products'
  | 'Leads'
  | 'Opportunities'
  | 'Meetings'
  | 'Notes'
  | 'Calls'
  | 'Campaigns'

const ENTITY_MODULE: Record<CrmEntity, SuiteCrmRecordModule> = {
  organizations: 'Accounts',
  contacts: 'Contacts',
  products: 'AOS_Products',
  leads: 'Leads',
  opportunities: 'Opportunities',
  meetings: 'Meetings',
  interactions: 'Notes',
  campaigns: 'Campaigns',
}

type SuiteCrmToken = {
  access_token?: string
  expires_in?: number
  token_type?: string
}

type JsonApiResponse = {
  data?: { id?: string; type?: string; attributes?: Record<string, unknown> }
  errors?: unknown
}

type JsonApiCollectionResponse = {
  data?: Array<{ id?: string; type?: string }>
  errors?: unknown
}

export type SuiteCrmRecordSnapshot = {
  id: string
  attributes: Record<string, unknown>
}

export type SuiteCrmMeetingSnapshot = SuiteCrmRecordSnapshot
export type SuiteCrmNoteSnapshot = SuiteCrmRecordSnapshot
export type SuiteCrmCallSnapshot = SuiteCrmRecordSnapshot
export type SuiteCrmAccountContactModule = 'Accounts' | 'Contacts'
export type SuiteCrmUserMatch = {
  id: string
  username: string
  displayName: string
  email: string
  globalId: string | null
}

export type SuiteCrmIncrementalListInput = {
  updatedSince: string
  page: number
  pageSize?: number
}

let cachedToken: { value: string; expiresAt: number } | null = null

function requiredCredential(name: 'SUITECRM_CLIENT_ID' | 'SUITECRM_CLIENT_SECRET') {
  const value = String(process.env[name] || '').trim()
  if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${name} is not configured safely`)
  }
  return value
}

export function suiteCrmBaseUrl(value = process.env.SUITECRM_BASE_URL) {
  const configured = String(value || '').trim()
  if (!configured) throw new Error('SUITECRM_BASE_URL is not configured')
  try {
    const url = new URL(configured)
    const privateRailway = url.protocol === 'http:' && url.hostname.endsWith('.railway.internal')
    if (
      (!privateRailway && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.search
      || url.hash
    ) throw new Error('unsafe URL')
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error('SUITECRM_BASE_URL is not configured safely')
  }
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('SuiteCRM returned an oversized response')
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object') throw new Error('not a JSON container')
    return parsed
  } catch {
    throw new Error(`SuiteCRM returned an invalid response (${response.status})`)
  }
}

function responseErrorDetail(parsed: unknown) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  const errors = (parsed as { errors?: unknown }).errors
  const entries = Array.isArray(errors) ? errors : errors && typeof errors === 'object' ? [errors] : []
  return entries
    .slice(0, 3)
    .map((error) => {
      if (!error || typeof error !== 'object' || Array.isArray(error)) return ''
      const item = error as Record<string, unknown>
      return String(item.detail || item.title || item.message || item.code || '').replace(/[\r\n]+/g, ' ').trim()
    })
    .filter(Boolean)
    .join('; ')
    .slice(0, 500)
}

async function accessToken(fetchImpl: typeof fetch) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value
  const response = await fetchImpl(`${suiteCrmBaseUrl()}/Api/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: requiredCredential('SUITECRM_CLIENT_ID'),
      client_secret: requiredCredential('SUITECRM_CLIENT_SECRET'),
    }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await readJson(response) as SuiteCrmToken
  const token = String(parsed.access_token || '').trim()
  if (!response.ok || !token) {
    const detail = responseErrorDetail(parsed)
    throw new Error(`SuiteCRM authentication failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const ttl = Math.max(60, Math.min(Number(parsed.expires_in) || 3600, 86_400))
  cachedToken = { value: token, expiresAt: Date.now() + ttl * 1000 }
  return token
}

async function request(
  pathname: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  allowNotFound = false,
) {
  const token = await accessToken(fetchImpl)
  const response = await fetchImpl(`${suiteCrmBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  // SuiteCRM V8 reports a valid module/id lookup with no matching bean as 400.
  // This compatibility path is used only by the deterministic upsert preflight.
  if (allowNotFound && (response.status === 400 || response.status === 404)) return null
  const parsed = await readJson(response)
  if (!response.ok) {
    const detail = responseErrorDetail(parsed)
    throw new Error(`SuiteCRM request failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return parsed
}

export async function testSuiteCrmConnection(fetchImpl: typeof fetch = fetch) {
  const response = await request('/Api/V8/meta/modules', { method: 'GET' }, fetchImpl)
  return Boolean(response)
}

export async function resolveSuiteCrmCurrencyId(
  currencyCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const normalized = String(currencyCode || '').trim().toUpperCase()
  if (!isIso4217CurrencyCode(normalized)) {
    throw new Error('SuiteCRM product currency must be a supported ISO 4217 code')
  }
  // ClawPilot fixes the SuiteCRM base currency to USD at container boot.
  // SuiteCRM represents that base currency with its reserved -99 identity.
  if (normalized === 'USD') return '-99'

  const parameters = new URLSearchParams({
    'fields[Currencies]': 'iso4217,status,conversion_rate',
    'filter[iso4217][eq]': normalized,
    'page[number]': '1',
    'page[size]': '10',
  })
  const response = await request(
    `/Api/V8/module/Currencies?${parameters}`,
    { method: 'GET' },
    fetchImpl,
  ) as {
    data?: Array<{ id?: unknown; type?: unknown; attributes?: unknown }>
  }
  if (!Array.isArray(response.data)) {
    throw new Error('SuiteCRM returned an invalid currency collection')
  }
  const matches = response.data.flatMap((record) => {
    const id = String(record?.id || '').trim()
    const type = String(record?.type || '').trim()
    const attributes = record?.attributes
    if (
      !id
      || (type !== 'Currency' && type !== 'Currencies')
      || !attributes
      || typeof attributes !== 'object'
      || Array.isArray(attributes)
    ) return []
    const values = attributes as Record<string, unknown>
    const iso4217 = String(values.iso4217 || '').trim().toUpperCase()
    const status = String(values.status || '').trim().toLowerCase()
    const conversionRate = Number(values.conversion_rate)
    return iso4217 === normalized
      && status === 'active'
      && Number.isFinite(conversionRate)
      && conversionRate > 0
      ? [id]
      : []
  })
  if (matches.length === 0) {
    throw new Error(
      `${normalized} is not active in SuiteCRM with a positive conversion rate. Open SuiteCRM Admin > Currencies, enable ${normalized} with an administrator-maintained conversion rate, then retry.`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `SuiteCRM has multiple active ${normalized} currencies. Keep exactly one active record, then retry.`,
    )
  }
  return matches[0]
}

export async function findSuiteCrmUser(input: {
  email?: string
  globalId?: string
}, fetchImpl: typeof fetch = fetch): Promise<SuiteCrmUserMatch | null> {
  const email = String(input.email || '').trim().toLowerCase()
  const globalId = String(input.globalId || '').trim().toLowerCase()
  if (globalId && !/^gu(?:[0-9]{7}|[0-9a-v]{12})$/.test(globalId)) throw new Error('SuiteCRM user Global ID is invalid')
  if (!globalId && (!email || email.length > 254)) throw new Error('SuiteCRM user email is invalid')
  const field = globalId ? 'global_id_c' : 'email1'
  const value = globalId || email
  const parameters = new URLSearchParams({
    'fields[Users]': 'user_name,first_name,last_name,email1,status,global_id_c',
    [`filter[${field}][eq]`]: value,
    'page[number]': '1',
    'page[size]': '5',
  })
  const response = await request(
    `/Api/V8/module/Users?${parameters}`,
    { method: 'GET' },
    fetchImpl,
  ) as { data?: Array<{ id?: unknown; type?: unknown; attributes?: unknown }> }
  if (!Array.isArray(response.data)) throw new Error('SuiteCRM returned an invalid user collection')
  const matches = response.data.flatMap((record) => {
    const id = String(record?.id || '').trim()
    const type = String(record?.type || '').trim()
    const attributes = record?.attributes
    if (!id || (type && type !== 'Users' && type !== 'User') || !attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
      return []
    }
    const values = attributes as Record<string, unknown>
    const matchedUsername = String(values.user_name || '').trim()
    const matchedEmail = String(values.email1 || '').trim().toLowerCase()
    const status = String(values.status || '').trim().toLowerCase()
    if (status && status !== 'active') return []
    if (globalId
      ? globalId !== String(values.global_id_c || '').trim().toLowerCase()
      : matchedEmail !== email) return []
    const displayName = [values.first_name, values.last_name].map((part) => String(part || '').trim()).filter(Boolean).join(' ')
    const matchedGlobalId = String(values.global_id_c || '').trim().toLowerCase() || null
    return [{ id, username: matchedUsername || matchedGlobalId || '', displayName: displayName || matchedUsername || matchedEmail, email: matchedEmail, globalId: matchedGlobalId }]
  })
  if (matches.length > 1) throw new Error('SuiteCRM user mapping is ambiguous')
  return matches[0] || null
}

async function listSuiteCrmModuleRecordsUpdatedSince(
  moduleName: 'Accounts' | 'Contacts' | 'Meetings' | 'Notes' | 'Calls',
  recordLabel: string,
  input: SuiteCrmIncrementalListInput,
  fetchImpl: typeof fetch,
) {
  const updatedSince = new Date(input.updatedSince)
  if (!Number.isFinite(updatedSince.getTime())) throw new Error(`SuiteCRM ${recordLabel} cursor is invalid`)
  const requestedPage = Number(input.page)
  const requestedPageSize = Number(input.pageSize || 100)
  if (!Number.isFinite(requestedPage) || !Number.isFinite(requestedPageSize)) {
    throw new Error(`SuiteCRM ${recordLabel} pagination is invalid`)
  }
  const page = Math.max(1, Math.min(Math.trunc(requestedPage), 10_000))
  const pageSize = Math.max(1, Math.min(Math.trunc(requestedPageSize), 250))
  const parameters = new URLSearchParams({
    'filter[date_modified][gte]': updatedSince.toISOString(),
    'page[number]': String(page),
    'page[size]': String(pageSize),
    sort: 'date_modified',
  })
  const response = await request(
    `/Api/V8/module/${moduleName}?${parameters}`,
    { method: 'GET' },
    fetchImpl,
  ) as {
    data?: Array<{ id?: unknown; type?: unknown; attributes?: unknown }>
    meta?: { 'total-pages'?: unknown }
  }
  if (!Array.isArray(response.data)) throw new Error(`SuiteCRM returned an invalid ${recordLabel} collection`)
  const recordType = moduleName.slice(0, -1)
  const records = response.data.map((record) => {
    const id = String(record?.id || '').trim()
    const type = String(record?.type || '').trim()
    const attributes = record?.attributes
    if (
      !id
      || id.length > 64
      || (type && type !== moduleName && type !== recordType)
      || !attributes
      || typeof attributes !== 'object'
      || Array.isArray(attributes)
    ) {
      throw new Error(`SuiteCRM returned an invalid ${recordLabel}`)
    }
    return { id, attributes: attributes as Record<string, unknown> } satisfies SuiteCrmRecordSnapshot
  })
  const totalPages = Number(response.meta?.['total-pages'])
  return {
    records,
    totalPages: Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : page,
  }
}

export async function listSuiteCrmAccountContactRecordsUpdatedSince(
  input: SuiteCrmIncrementalListInput & { module: SuiteCrmAccountContactModule },
  fetchImpl: typeof fetch = fetch,
) {
  return listSuiteCrmModuleRecordsUpdatedSince(
    input.module,
    input.module === 'Accounts' ? 'account' : 'contact',
    input,
    fetchImpl,
  )
}

export async function listSuiteCrmMeetingsUpdatedSince(
  input: SuiteCrmIncrementalListInput,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await listSuiteCrmModuleRecordsUpdatedSince('Meetings', 'meeting', input, fetchImpl)
  return { meetings: response.records, totalPages: response.totalPages }
}

export async function listSuiteCrmNotesUpdatedSince(
  input: SuiteCrmIncrementalListInput,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await listSuiteCrmModuleRecordsUpdatedSince('Notes', 'note', input, fetchImpl)
  return { notes: response.records, totalPages: response.totalPages }
}

export async function listSuiteCrmCallsUpdatedSince(
  input: SuiteCrmIncrementalListInput,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await listSuiteCrmModuleRecordsUpdatedSince('Calls', 'call', input, fetchImpl)
  return { calls: response.records, totalPages: response.totalPages }
}

function suiteCrmRecordModule(record: SuiteCrmOutboxRecord): SuiteCrmRecordModule {
  const canonicalModule = ENTITY_MODULE[record.entity]
  const explicitModule = record.suiteCrmModule
  if (explicitModule === undefined) return canonicalModule
  if (record.entity === 'interactions') {
    if (explicitModule === 'Notes' || explicitModule === 'Calls' || explicitModule === 'Meetings') {
      return explicitModule
    }
    throw new Error('SuiteCRM interaction module is invalid')
  }
  if (explicitModule !== canonicalModule) {
    throw new Error('SuiteCRM record module does not match its entity')
  }
  return canonicalModule
}

export type SuiteCrmUpsertResult = {
  suiteCrmId: string
  productImageProjection: SuiteCrmNativeProductImageResult | null
}

export async function upsertSuiteCrmRecordWithResult(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<SuiteCrmUpsertResult> {
  const moduleName = suiteCrmRecordModule(record)
  const existing = await request(
    `/Api/V8/module/${moduleName}/${encodeURIComponent(record.suiteCrmId)}`,
    { method: 'GET' },
    fetchImpl,
    true,
  )
  const currencyId = record.currencyCode
    ? await resolveSuiteCrmCurrencyId(record.currencyCode, fetchImpl)
    : null
  const attributes = { ...record.attributes }
  if (record.productImage === null) {
    attributes.product_image = ''
  } else if (record.productImage !== undefined) {
    attributes.product_image = publicCrmProductImageUrl({
      publicOrigin: appPublicUrl(),
      productReferenceCode: record.productImage.referenceCode,
      contentSha256: record.productImage.contentSha256,
    })
  }
  const body = {
    data: {
      type: moduleName,
      id: record.suiteCrmId,
      attributes: currencyId
        ? { ...attributes, currency_id: currencyId }
        : attributes,
    },
  }
  const response = await request('/Api/V8/module', {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  }, fetchImpl) as JsonApiResponse
  const id = String(response?.data?.id || record.suiteCrmId)
  if (id !== record.suiteCrmId) throw new Error('SuiteCRM returned an unexpected record ID')
  const productImageProjection = record.productImage !== undefined
    ? await projectSuiteCrmNativeProductImage(record, fetchImpl)
    : null
  for (const relationship of record.relationships || []) {
    const linkFieldName = relationship.linkFieldName
    if (!['accounts', 'contact', 'contacts', 'leads', 'opportunity'].includes(linkFieldName)) {
      throw new Error('SuiteCRM relationship link field is invalid')
    }
    const path = `/Api/V8/module/${moduleName}/${encodeURIComponent(record.suiteCrmId)}/relationships/${linkFieldName}`
    const existingRelationships = await request(
      `${path}?page[size]=200&page[number]=1`,
      { method: 'GET' },
      fetchImpl,
    ) as JsonApiCollectionResponse
    const alreadyLinked = Array.isArray(existingRelationships.data)
      && existingRelationships.data.some((related) => related?.id === relationship.relatedBeanId)
    if (alreadyLinked) continue
    await request(path, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: relationship.relatedModuleName,
          id: relationship.relatedBeanId,
        },
      }),
    }, fetchImpl)
  }
  return { suiteCrmId: id, productImageProjection }
}

export async function upsertSuiteCrmRecord(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
) {
  return (await upsertSuiteCrmRecordWithResult(record, fetchImpl)).suiteCrmId
}

export async function upsertSuiteCrmUserIdentity(
  record: SuiteCrmUserIdentityOutboxRecord,
  fetchImpl: typeof fetch = fetch,
) {
  const suiteCrmUserId = String(record.suiteCrmUserId || '').trim().toLowerCase()
  const referenceCode = String(record.referenceCode || '').trim().toLowerCase()
  const username = String(record.username || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(suiteCrmUserId)) {
    throw new Error('SuiteCRM user identity has an invalid record ID')
  }
  if (!/^gu(?:[0-9]{7}|[0-9a-v]{12})$/.test(referenceCode)) {
    throw new Error('SuiteCRM user identity has an invalid Global ID')
  }
  if (username !== referenceCode) {
    throw new Error('SuiteCRM employee username must equal the permanent ClawPilot Global ID')
  }

  const existing = await request(
    `/Api/V8/module/Users/${encodeURIComponent(suiteCrmUserId)}`,
    { method: 'GET' },
    fetchImpl,
  ) as JsonApiResponse
  const existingId = String(existing?.data?.id || '').trim().toLowerCase()
  const existingGlobalId = String(existing?.data?.attributes?.global_id_c || '').trim().toLowerCase()
  if (existingId !== suiteCrmUserId) throw new Error('SuiteCRM returned an unexpected user record')
  if (existingGlobalId && existingGlobalId !== referenceCode) {
    throw new Error('SuiteCRM user already has a different permanent ClawPilot Global ID')
  }

  const parameters = new URLSearchParams({
    'fields[Users]': 'global_id_c',
    'filter[global_id_c][eq]': referenceCode,
    'page[number]': '1',
    'page[size]': '2',
  })
  const matches = await request(
    `/Api/V8/module/Users?${parameters}`,
    { method: 'GET' },
    fetchImpl,
  ) as { data?: Array<{ id?: unknown }> }
  if (!Array.isArray(matches.data)) throw new Error('SuiteCRM returned an invalid user Global ID lookup')
  if (matches.data.some((entry) => String(entry?.id || '').trim().toLowerCase() !== suiteCrmUserId)) {
    throw new Error('ClawPilot user Global ID is already assigned to another SuiteCRM user')
  }

  const usernameParameters = new URLSearchParams({
    'fields[Users]': 'user_name',
    'filter[user_name][eq]': username,
    'page[number]': '1',
    'page[size]': '2',
  })
  const usernameMatches = await request(
    `/Api/V8/module/Users?${usernameParameters}`,
    { method: 'GET' },
    fetchImpl,
  ) as { data?: Array<{ id?: unknown }> }
  if (!Array.isArray(usernameMatches.data)) throw new Error('SuiteCRM returned an invalid username lookup')
  if (usernameMatches.data.some((entry) => String(entry?.id || '').trim().toLowerCase() !== suiteCrmUserId)) {
    throw new Error('ClawPilot user Global ID is already used as another SuiteCRM username')
  }

  const response = await request('/Api/V8/module', {
    method: 'PATCH',
    body: JSON.stringify({
      data: {
        type: 'Users',
        id: suiteCrmUserId,
        attributes: { user_name: username, global_id_c: referenceCode },
      },
    }),
  }, fetchImpl) as JsonApiResponse
  const updatedId = String(response?.data?.id || '').trim().toLowerCase()
  if (updatedId !== suiteCrmUserId) throw new Error('SuiteCRM returned an unexpected updated user ID')
  return updatedId
}

export async function deleteSuiteCrmRecord(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
) {
  const moduleName = suiteCrmRecordModule(record)
  await request(
    `/Api/V8/module/${moduleName}/${encodeURIComponent(record.suiteCrmId)}`,
    { method: 'DELETE' },
    fetchImpl,
    true,
  )
}
