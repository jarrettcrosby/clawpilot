import { decryptMatonApiKey } from '@/lib/integrations/matonCredentialCrypto'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { resolveMatonGatewayCredentialFromPostgres } from '@/lib/persistence/matonCredentials'
import { normalizeUserEmail } from '@/lib/users'

export type MatonGatewayCredential = {
  apiKey: string
  connectionId: string
}

export class MatonGatewayCredentialError extends Error {
  code: 'configuration' | 'missing-key' | 'missing-connection' | 'unavailable'

  constructor(
    message: string,
    code: 'configuration' | 'missing-key' | 'missing-connection' | 'unavailable',
  ) {
    super(message)
    this.name = 'MatonGatewayCredentialError'
    this.code = code
  }
}

export function normalizeMatonGatewayApp(value: unknown): string {
  const app = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(app)) {
    throw new MatonGatewayCredentialError('A valid Maton app is required', 'configuration')
  }
  return app
}

function normalizeBoundConnectionId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const connectionId = typeof value === 'string' ? value.trim() : ''
  if (!connectionId || connectionId.length > 512 || !/^[\x21-\x7e]+$/.test(connectionId)) {
    throw new MatonGatewayCredentialError('A valid bound Maton connection is required', 'configuration')
  }
  return connectionId
}

async function resolveStoredCredential(input: {
  ownerEmail: unknown
  app: unknown
  boundConnectionId?: unknown
  allowMissingKey: boolean
}): Promise<MatonGatewayCredential | null> {
  if (!isPostgresStorageEnabled()) {
    if (input.allowMissingKey) return null
    throw new MatonGatewayCredentialError('Stored Maton credentials require Postgres storage', 'configuration')
  }

  let ownerEmail: string
  try {
    ownerEmail = normalizeUserEmail(input.ownerEmail)
  } catch {
    if (input.allowMissingKey) return null
    throw new MatonGatewayCredentialError('A valid Maton credential owner is required', 'configuration')
  }
  const app = normalizeMatonGatewayApp(input.app)
  const boundConnectionId = normalizeBoundConnectionId(input.boundConnectionId)

  let lookup: Awaited<ReturnType<typeof resolveMatonGatewayCredentialFromPostgres>>
  try {
    lookup = await resolveMatonGatewayCredentialFromPostgres({ ownerEmail, app, boundConnectionId })
  } catch {
    throw new MatonGatewayCredentialError('Stored Maton credential lookup failed', 'unavailable')
  }
  if (lookup.status === 'missing-key') {
    if (input.allowMissingKey) return null
    throw new MatonGatewayCredentialError('A stored Maton API key is required', 'missing-key')
  }
  if (lookup.status === 'missing-connection') {
    throw new MatonGatewayCredentialError(`No ACTIVE Maton connection is configured for ${app}`, 'missing-connection')
  }
  try {
    return {
      apiKey: decryptMatonApiKey(lookup.credential, ownerEmail),
      connectionId: lookup.connectionId,
    }
  } catch {
    throw new MatonGatewayCredentialError('Stored Maton credential is unavailable', 'unavailable')
  }
}

export async function resolveUserMatonGatewayCredential(input: {
  ownerEmail: unknown
  app: unknown
  boundConnectionId?: unknown
}): Promise<MatonGatewayCredential> {
  const resolved = await resolveStoredCredential({ ...input, allowMissingKey: false })
  if (!resolved) throw new MatonGatewayCredentialError('A stored Maton API key is required', 'missing-key')
  return resolved
}

export async function resolveConfiguredOwnerMatonGatewayCredential(input: {
  app: unknown
}): Promise<MatonGatewayCredential | null> {
  return resolveStoredCredential({
    ownerEmail: process.env.APP_LOGIN_EMAIL,
    app: input.app,
    allowMissingKey: true,
  })
}
