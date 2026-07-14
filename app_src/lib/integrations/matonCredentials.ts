import {
  createMatonConnection,
  listMatonConnections,
  MatonClientError,
  normalizeMatonCreateApp,
  type MatonClientOptions,
  type SanitizedMatonConnection,
} from '@/lib/integrations/matonClient'
import {
  decryptMatonApiKey,
  encryptMatonApiKey,
  normalizeMatonApiKey,
} from '@/lib/integrations/matonCredentialCrypto'
import {
  importPlatformMatonCredentialInPostgres,
  readEncryptedMatonApiKeyFromPostgres,
  readMatonCredentialStateFromPostgres,
  revokeMatonCredentialInPostgres,
  selectMatonConnectionInPostgres,
  syncMatonConnectionsInPostgres,
  updateMatonCredentialInPostgres,
  type MatonConnectionWrite,
  type MatonCredentialState,
} from '@/lib/persistence/matonCredentials'
import { normalizeUserEmail } from '@/lib/users'

const MAX_MANUAL_CONNECTION_CHANGES = 50
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export class MatonCredentialRequestError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'MATON_REQUEST_INVALID') {
    super(message)
    this.name = 'MatonCredentialRequestError'
    this.status = status
    this.code = code
  }
}

function asObject(value: unknown, message = 'Request body must be an object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MatonCredentialRequestError(message)
  }
  return value as Record<string, unknown>
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function normalizedOwner(ownerEmailValue: unknown): string {
  try {
    return normalizeUserEmail(ownerEmailValue)
  } catch {
    throw new MatonCredentialRequestError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
  }
}

function normalizeConnectionId(value: unknown): string {
  const connectionId = typeof value === 'string' ? value.trim() : ''
  if (!connectionId || connectionId.length > 512 || !/^[\x21-\x7e]+$/.test(connectionId)) {
    throw new MatonCredentialRequestError('A valid Maton connection ID is required')
  }
  return connectionId
}

function normalizeName(value: unknown, fallback = ''): string {
  const name = typeof value === 'string' ? value.trim() : fallback
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new MatonCredentialRequestError('Connection name must be 1-100 characters without control characters')
  }
  return name
}

function normalizeManualApp(value: unknown): string {
  const requested = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const app = requested === 'gmail' ? 'google-mail' : requested
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(app)) {
    throw new MatonCredentialRequestError('Connection app must be a lowercase app identifier')
  }
  return app
}

function normalizeStatus(value: unknown): string {
  const status = value === undefined ? 'UNKNOWN' : typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(status)) {
    throw new MatonCredentialRequestError('Connection status is invalid')
  }
  return status
}

function normalizeMethod(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const method = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!method || method.length > 64 || !/^[\x21-\x7e]+$/.test(method)) {
    throw new MatonCredentialRequestError('Connection method is invalid')
  }
  return method
}

function normalizeOptionalEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new MatonCredentialRequestError('A valid connection account email is required')
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !EMAIL_PATTERN.test(email)) {
    throw new MatonCredentialRequestError('A valid connection account email is required')
  }
  return email
}

function manualConnection(value: unknown): MatonConnectionWrite {
  const input = asObject(value, 'Manual connections must be objects')
  const app = normalizeManualApp(input.app ?? input.provider)
  return {
    connectionId: normalizeConnectionId(input.connectionId),
    name: normalizeName(input.name, app),
    app,
    status: normalizeStatus(input.status),
    method: normalizeMethod(input.method),
    accountEmail: normalizeOptionalEmail(input.accountEmail),
    source: 'manual',
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
  }
}

function connectionChanges(value: unknown): {
  upserts: MatonConnectionWrite[]
  removals: string[]
} {
  if (value === undefined) return { upserts: [], removals: [] }
  const input = asObject(value, 'Connections must be an object')
  const upsertValues = input.upsert === undefined ? [] : input.upsert
  const removeValues = input.remove === undefined ? [] : input.remove
  if (!Array.isArray(upsertValues) || !Array.isArray(removeValues)) {
    throw new MatonCredentialRequestError('Connection upsert and remove values must be arrays')
  }
  if (
    upsertValues.length > MAX_MANUAL_CONNECTION_CHANGES
    || removeValues.length > MAX_MANUAL_CONNECTION_CHANGES
  ) {
    throw new MatonCredentialRequestError(`Use no more than ${MAX_MANUAL_CONNECTION_CHANGES} connection changes per request`)
  }
  const upsertsById = new Map<string, MatonConnectionWrite>()
  for (const value of upsertValues) {
    const connection = manualConnection(value)
    upsertsById.set(connection.connectionId, connection)
  }
  const removals = Array.from(new Set(removeValues.map((value) => (
    normalizeConnectionId(
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).connectionId
        : value,
    )
  ))))
  if (removals.some((connectionId) => upsertsById.has(connectionId))) {
    throw new MatonCredentialRequestError('A connection cannot be upserted and removed in the same request')
  }
  return { upserts: Array.from(upsertsById.values()), removals }
}

function connectionWrite(connection: SanitizedMatonConnection): MatonConnectionWrite {
  return { ...connection }
}

function clientError(error: unknown): MatonCredentialRequestError {
  if (!(error instanceof MatonClientError)) {
    return new MatonCredentialRequestError('Maton integration request failed', 500, 'MATON_INTERNAL_ERROR')
  }
  if (error.code === 'invalid-key') {
    return new MatonCredentialRequestError(error.message, 422, 'MATON_KEY_REJECTED')
  }
  if (error.code === 'configuration') {
    return new MatonCredentialRequestError(error.message, 503, 'MATON_CONFIGURATION_ERROR')
  }
  return new MatonCredentialRequestError(error.message, 502, 'MATON_UPSTREAM_ERROR')
}

function configuredOwnerEmail(): string | null {
  try {
    return normalizeUserEmail(process.env.APP_LOGIN_EMAIL)
  } catch {
    return null
  }
}

export function isConfiguredMatonPlatformOwner(ownerEmailValue: unknown): boolean {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  return configuredOwnerEmail() === ownerEmail
}

export function platformCredentialAvailable(
  ownerEmailValue: unknown,
  state: Pick<MatonCredentialState, 'configured'>,
): boolean {
  return isConfiguredMatonPlatformOwner(ownerEmailValue)
    && !state.configured
    && Boolean(String(process.env.MATON_API_KEY || '').trim())
}

export async function getMatonCredentialState(ownerEmailValue: unknown): Promise<MatonCredentialState> {
  return readMatonCredentialStateFromPostgres(normalizedOwner(ownerEmailValue))
}

export async function getMatonApiKeyForUser(ownerEmailValue: unknown): Promise<string> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  const stored = await readEncryptedMatonApiKeyFromPostgres(ownerEmail)
  if (!stored) {
    throw new MatonCredentialRequestError('A stored Maton API key is required', 409, 'MATON_KEY_REQUIRED')
  }
  try {
    return decryptMatonApiKey(stored, ownerEmail)
  } catch {
    throw new MatonCredentialRequestError(
      'Stored Maton credential could not be decrypted',
      503,
      'MATON_CREDENTIAL_UNAVAILABLE',
    )
  }
}

export async function updateMatonCredential(
  ownerEmailValue: unknown,
  value: unknown,
): Promise<MatonCredentialState> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  const input = asObject(value)
  const action = typeof input.action === 'string' ? input.action : 'update-credential'
  if (action !== 'update-credential') throw new MatonCredentialRequestError('Unsupported Maton action')
  for (const key of Object.keys(input)) {
    if (!['action', 'loginEmail', 'apiKey', 'connections'].includes(key)) {
      throw new MatonCredentialRequestError(`Unsupported Maton credential field: ${key}`)
    }
  }

  const setLoginEmail = hasOwn(input, 'loginEmail')
  let loginEmail: string | null = null
  if (setLoginEmail && input.loginEmail !== null && input.loginEmail !== '') {
    try {
      loginEmail = normalizeUserEmail(input.loginEmail)
    } catch {
      throw new MatonCredentialRequestError('A valid Maton login email is required')
    }
  }

  const changes = connectionChanges(input.connections)
  let apiKey: ReturnType<typeof encryptMatonApiKey> & { lastFour: string } | undefined
  let refreshedConnections: MatonConnectionWrite[] = []
  if (hasOwn(input, 'apiKey')) {
    let normalized: string
    try {
      normalized = normalizeMatonApiKey(input.apiKey)
    } catch (error) {
      throw new MatonCredentialRequestError(error instanceof Error ? error.message : 'A valid Maton API key is required')
    }
    try {
      refreshedConnections = (await listMatonConnections(normalized)).map(connectionWrite)
    } catch (error) {
      throw clientError(error)
    }
    try {
      apiKey = { ...encryptMatonApiKey(normalized, ownerEmail), lastFour: normalized.slice(-4) }
    } catch {
      throw new MatonCredentialRequestError(
        'Maton credential encryption is not configured',
        503,
        'MATON_CONFIGURATION_ERROR',
      )
    }
  }

  if (!setLoginEmail && !apiKey && changes.upserts.length === 0 && changes.removals.length === 0) {
    throw new MatonCredentialRequestError('No Maton credential changes were provided')
  }
  return updateMatonCredentialInPostgres({
    ownerEmail,
    setLoginEmail,
    loginEmail,
    apiKey,
    refreshedConnections,
    connectionUpserts: changes.upserts,
    connectionRemovals: changes.removals,
  })
}

export async function refreshMatonConnections(
  ownerEmailValue: unknown,
  options: MatonClientOptions = {},
): Promise<MatonCredentialState> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  const apiKey = await getMatonApiKeyForUser(ownerEmail)
  try {
    const connections = await listMatonConnections(apiKey, options)
    return syncMatonConnectionsInPostgres({
      ownerEmail,
      connections: connections.map(connectionWrite),
      eventType: 'maton.connections.refreshed',
      replaceRemote: true,
    })
  } catch (error) {
    if (error instanceof MatonCredentialRequestError) throw error
    throw clientError(error)
  }
}

export async function createUserMatonConnection(
  ownerEmailValue: unknown,
  inputValue: unknown,
  options: MatonClientOptions = {},
): Promise<{
  credential: MatonCredentialState
  connection: MatonConnectionWrite
  authorizationUrl: string
}> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  const input = asObject(inputValue)
  let app: string
  try {
    app = normalizeMatonCreateApp(input.app)
  } catch (error) {
    throw new MatonCredentialRequestError(error instanceof Error ? error.message : 'A valid Maton app is required')
  }
  const name = normalizeName(input.name, app)
  const apiKey = await getMatonApiKeyForUser(ownerEmail)
  try {
    const created = await createMatonConnection(apiKey, { app, name }, options)
    const connection = connectionWrite(created.connection)
    const credential = await syncMatonConnectionsInPostgres({
      ownerEmail,
      connections: [connection],
      eventType: 'maton.connection.created',
      replaceRemote: false,
    })
    return { credential, connection, authorizationUrl: created.authorizationUrl }
  } catch (error) {
    if (error instanceof MatonCredentialRequestError) throw error
    throw clientError(error)
  }
}

export async function selectUserMatonConnection(
  ownerEmailValue: unknown,
  connectionIdValue: unknown,
  options: MatonClientOptions = {},
): Promise<MatonCredentialState> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  const connectionId = normalizeConnectionId(connectionIdValue)
  const apiKey = await getMatonApiKeyForUser(ownerEmail)
  try {
    const connections = await listMatonConnections(apiKey, options)
    const selected = connections.find((connection) => connection.connectionId === connectionId)
    if (!selected) {
      throw new MatonCredentialRequestError(
        'Maton connection was not found for the signed-in user',
        404,
        'MATON_CONNECTION_NOT_FOUND',
      )
    }
    if (selected.status !== 'ACTIVE') {
      throw new MatonCredentialRequestError(
        'Only an ACTIVE Maton connection can be selected',
        409,
        'MATON_CONNECTION_INACTIVE',
      )
    }
    await syncMatonConnectionsInPostgres({
      ownerEmail,
      connections: connections.map(connectionWrite),
      eventType: 'maton.connections.refreshed',
      replaceRemote: true,
    })
    return selectMatonConnectionInPostgres({ ownerEmail, connectionId })
  } catch (error) {
    if (error instanceof MatonCredentialRequestError) throw error
    throw clientError(error)
  }
}

export async function importPlatformMatonCredential(
  ownerEmailValue: unknown,
  options: MatonClientOptions = {},
): Promise<MatonCredentialState> {
  const ownerEmail = normalizedOwner(ownerEmailValue)
  if (!isConfiguredMatonPlatformOwner(ownerEmail)) {
    throw new MatonCredentialRequestError(
      'Only the configured owner can import the platform Maton credential',
      403,
      'MATON_PLATFORM_IMPORT_FORBIDDEN',
    )
  }
  const current = await readMatonCredentialStateFromPostgres(ownerEmail)
  if (current.configured) {
    throw new MatonCredentialRequestError('A per-user Maton credential is already configured', 409, 'MATON_KEY_EXISTS')
  }
  let apiKey: string
  try {
    apiKey = normalizeMatonApiKey(process.env.MATON_API_KEY)
  } catch {
    throw new MatonCredentialRequestError(
      'The platform Maton credential is not available',
      409,
      'MATON_PLATFORM_KEY_UNAVAILABLE',
    )
  }
  let connections: SanitizedMatonConnection[]
  try {
    connections = await listMatonConnections(apiKey, options)
  } catch (error) {
    throw clientError(error)
  }
  const platformGmailConnectionId = String(process.env.MATON_GMAIL_CONNECTION_ID || '').trim()
  const selectedConnectionIds: string[] = []
  if (platformGmailConnectionId) {
    const configuredSenderConnection = connections.find((connection) => (
      connection.connectionId === platformGmailConnectionId
      && connection.app === 'google-mail'
      && connection.status === 'ACTIVE'
    ))
    if (!configuredSenderConnection) {
      throw new MatonCredentialRequestError(
        'The verified platform Gmail connection is not available to the imported Maton key',
        503,
        'MATON_CONFIGURATION_ERROR',
      )
    }
    selectedConnectionIds.push(configuredSenderConnection.connectionId)
  }
  let encrypted: ReturnType<typeof encryptMatonApiKey>
  try {
    encrypted = encryptMatonApiKey(apiKey, ownerEmail)
  } catch {
    throw new MatonCredentialRequestError(
      'Maton credential encryption is not configured',
      503,
      'MATON_CONFIGURATION_ERROR',
    )
  }
  try {
    return await importPlatformMatonCredentialInPostgres({
      ownerEmail,
      apiKey: { ...encrypted, lastFour: apiKey.slice(-4) },
      connections: connections.map(connectionWrite),
      selectedConnectionIds,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'A per-user Maton credential is already configured') {
      throw new MatonCredentialRequestError(error.message, 409, 'MATON_KEY_EXISTS')
    }
    throw new MatonCredentialRequestError(
      'Maton credential import failed',
      500,
      'MATON_INTERNAL_ERROR',
    )
  }
}

export async function revokeMatonCredential(ownerEmailValue: unknown): Promise<MatonCredentialState> {
  return revokeMatonCredentialInPostgres(normalizedOwner(ownerEmailValue))
}
