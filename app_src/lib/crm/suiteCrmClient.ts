import type { CrmEntity, SuiteCrmOutboxRecord } from '@/lib/crm/types'

const ENTITY_MODULE: Record<CrmEntity, string> = {
  organizations: 'Accounts',
  contacts: 'Contacts',
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
export type SuiteCrmAccountContactModule = 'Accounts' | 'Contacts'

type SuiteCrmIncrementalListInput = {
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
  if (!Array.isArray(errors)) return ''
  return errors
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

async function listSuiteCrmModuleRecordsUpdatedSince(
  moduleName: 'Accounts' | 'Contacts' | 'Meetings',
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

export async function upsertSuiteCrmRecord(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
) {
  const moduleName = ENTITY_MODULE[record.entity]
  const existing = await request(
    `/Api/V8/module/${moduleName}/${encodeURIComponent(record.suiteCrmId)}`,
    { method: 'GET' },
    fetchImpl,
    true,
  )
  const body = {
    data: {
      type: moduleName,
      id: record.suiteCrmId,
      attributes: record.attributes,
    },
  }
  const response = await request('/Api/V8/module', {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  }, fetchImpl) as JsonApiResponse
  const id = String(response?.data?.id || record.suiteCrmId)
  if (id !== record.suiteCrmId) throw new Error('SuiteCRM returned an unexpected record ID')
  for (const relationship of record.relationships || []) {
    const linkFieldName = relationship.linkFieldName
    if (!['accounts', 'contacts', 'leads', 'opportunity'].includes(linkFieldName)) {
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
  return id
}

export async function deleteSuiteCrmRecord(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
) {
  const moduleName = ENTITY_MODULE[record.entity]
  await request(
    `/Api/V8/module/${moduleName}/${encodeURIComponent(record.suiteCrmId)}`,
    { method: 'DELETE' },
    fetchImpl,
    true,
  )
}
