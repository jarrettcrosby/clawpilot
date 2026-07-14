import type { CrmEntity, SuiteCrmOutboxRecord } from '@/lib/crm/types'

const ENTITY_MODULE: Record<CrmEntity, string> = {
  organizations: 'Accounts',
  contacts: 'Contacts',
  opportunities: 'Opportunities',
  interactions: 'Notes',
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
  if (!response.ok || !token) throw new Error(`SuiteCRM authentication failed (${response.status})`)
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
  if (allowNotFound && response.status === 404) return null
  const parsed = await readJson(response)
  if (!response.ok) throw new Error(`SuiteCRM request failed (${response.status})`)
  return parsed
}

export async function testSuiteCrmConnection(fetchImpl: typeof fetch = fetch) {
  const response = await request('/Api/V8/meta/modules', { method: 'GET' }, fetchImpl)
  return Boolean(response)
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
  return id
}
