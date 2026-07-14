import { normalizeMatonApiKey } from '@/lib/integrations/matonCredentialCrypto'

const DEFAULT_API_BASE_URL = 'https://api.maton.ai'
const AUTHORIZATION_HOST = 'connect.maton.ai'
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CONNECTIONS = 500
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const MATON_APP_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export type MatonClientErrorCode = 'configuration' | 'invalid-key' | 'invalid-response' | 'unavailable'

export class MatonClientError extends Error {
  code: MatonClientErrorCode

  constructor(message: string, code: MatonClientErrorCode) {
    super(message)
    this.name = 'MatonClientError'
    this.code = code
  }
}

export type SanitizedMatonConnection = {
  connectionId: string
  name: string
  app: string
  status: string
  method: string | null
  accountEmail: string | null
  source: 'maton' | 'manual'
  remoteCreatedAt: string | null
  remoteUpdatedAt: string | null
}

export type MatonClientOptions = {
  fetchImpl?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeRemoteConnectionId(value: unknown): string {
  const connectionId = typeof value === 'string' ? value.trim() : ''
  if (!connectionId || connectionId.length > 512 || !/^[\x21-\x7e]+$/.test(connectionId)) {
    throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  }
  return connectionId
}

function normalizeRemoteApp(value: unknown, fallback = ''): string {
  const app = (typeof value === 'string' ? value : fallback).trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(app)) {
    throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  }
  return app
}

function normalizeRemoteStatus(value: unknown, fallback = ''): string {
  const status = (typeof value === 'string' ? value : fallback).trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(status)) {
    throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  }
  return status
}

function normalizeRemoteMethod(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const method = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!method || method.length > 64 || !/^[\x21-\x7e]+$/.test(method)) {
    throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  }
  return method
}

function normalizeConnectionName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name && name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name)) return name
  return fallback
}

function normalizeRemoteEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && /^[\x21-\x7e]+$/.test(email) && EMAIL_PATTERN.test(email) ? email : null
}

function normalizeRemoteTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function normalizeMatonCreateApp(value: unknown): string {
  const rawApp = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const app = rawApp === 'gmail' ? 'google-mail' : rawApp
  if (!MATON_APP_PATTERN.test(app)) {
    throw new Error('A valid Maton application ID is required')
  }
  return app
}

export function validateMatonAuthorizationUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MatonClientError('Maton did not return a valid authorization URL', 'invalid-response')
  }
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.hostname !== AUTHORIZATION_HOST
      || url.port
      || url.username
      || url.password
    ) {
      throw new Error('invalid authorization origin')
    }
    return url.toString()
  } catch {
    throw new MatonClientError('Maton did not return a valid authorization URL', 'invalid-response')
  }
}

export function resolveMatonApiBaseUrl(value = process.env.MATON_CONNECTIONS_API_BASE_URL): string {
  const configured = String(value || DEFAULT_API_BASE_URL).trim()
  try {
    const url = new URL(configured)
    const allowedHost = url.hostname === 'api.maton.ai' || url.hostname.endsWith('.api.maton.ai')
    if (
      url.protocol !== 'https:'
      || !allowedHost
      || url.port
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    ) {
      throw new Error('invalid Maton API origin')
    }
    return url.origin
  } catch {
    throw new MatonClientError('Maton connections API is not configured safely', 'configuration')
  }
}

export function sanitizeMatonConnection(
  value: unknown,
  fallback: { app?: string; status?: string; name?: string } = {},
): SanitizedMatonConnection {
  const record = asRecord(value)
  if (!record) throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  const metadata = asRecord(record.metadata) || {}
  const app = normalizeRemoteApp(record.app, fallback.app)
  return {
    connectionId: normalizeRemoteConnectionId(
      record.connection_id ?? record.connection_Id ?? record.connectionId ?? record.id,
    ),
    name: normalizeConnectionName(record.name, fallback.name || app),
    app,
    status: normalizeRemoteStatus(record.status, fallback.status),
    method: normalizeRemoteMethod(record.method),
    accountEmail: normalizeRemoteEmail(
      record.account_email ?? record.accountEmail ?? metadata.account_email ?? metadata.accountEmail ?? metadata.email,
    ),
    source: 'maton',
    remoteCreatedAt: normalizeRemoteTimestamp(record.creation_time ?? record.created_at ?? record.createdAt),
    remoteUpdatedAt: normalizeRemoteTimestamp(record.last_updated_time ?? record.updated_at ?? record.updatedAt),
  }
}

async function matonRequest(
  apiKeyValue: unknown,
  method: 'GET' | 'POST',
  body: Record<string, unknown> | undefined,
  options: MatonClientOptions,
): Promise<Record<string, unknown>> {
  const apiKey = normalizeMatonApiKey(apiKeyValue)
  const fetchImpl = options.fetchImpl || fetch
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs || 15_000, 30_000))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${resolveMatonApiBaseUrl(options.baseUrl)}/connections`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      throw new MatonClientError('Maton API key was rejected', 'invalid-key')
    }
    if (!response.ok) throw new MatonClientError('Maton connections API request failed', 'unavailable')
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
    }
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
    }
    try {
      const parsed = JSON.parse(raw)
      const record = asRecord(parsed)
      if (!record) throw new Error('response was not an object')
      return record
    } catch {
      throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
    }
  } catch (error) {
    if (error instanceof MatonClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MatonClientError('Maton connections API request timed out', 'unavailable')
    }
    throw new MatonClientError('Maton connections API request failed', 'unavailable')
  } finally {
    clearTimeout(timer)
  }
}

export async function listMatonConnections(
  apiKey: unknown,
  options: MatonClientOptions = {},
): Promise<SanitizedMatonConnection[]> {
  const response = await matonRequest(apiKey, 'GET', undefined, options)
  if (!Array.isArray(response.connections) || response.connections.length > MAX_CONNECTIONS) {
    throw new MatonClientError('Maton returned an invalid connection response', 'invalid-response')
  }
  const byId = new Map<string, SanitizedMatonConnection>()
  for (const value of response.connections) {
    const connection = sanitizeMatonConnection(value)
    byId.set(connection.connectionId, connection)
  }
  return Array.from(byId.values())
}

export async function createMatonConnection(
  apiKey: unknown,
  input: { app: unknown; name?: unknown },
  options: MatonClientOptions = {},
): Promise<{ connection: SanitizedMatonConnection; authorizationUrl: string }> {
  const app = normalizeMatonCreateApp(input.app)
  const name = normalizeConnectionName(input.name, app)
  const response = await matonRequest(apiKey, 'POST', { app }, options)
  const nested = asRecord(response.connection)
  const connectionRecord = nested ? { ...response, ...nested } : response
  const connection = sanitizeMatonConnection(connectionRecord, { app, status: 'PENDING', name })
  const authorizationUrl = validateMatonAuthorizationUrl(
    connectionRecord.authorization_url
      ?? connectionRecord.authorizationUrl
      ?? connectionRecord.url
      ?? response.authorization_url
      ?? response.authorizationUrl
      ?? response.url,
  )
  return { connection: { ...connection, name }, authorizationUrl }
}
