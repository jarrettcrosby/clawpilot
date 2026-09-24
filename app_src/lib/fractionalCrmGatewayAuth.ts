import { createHash, timingSafeEqual } from 'node:crypto'

export const fractionalCrmCapabilities = [
  'crm.company.read', 'crm.contact.read', 'crm.company.write', 'crm.contact.write', 'crm.onboarding.write',
] as const
export type FractionalCrmCapability = typeof fractionalCrmCapabilities[number]
export type FractionalCrmPrincipal = {
  credentialId: string
  sourceInstanceId: string
  workspaceOrganizationId: string
  pipelineId: string
  rootCompanyGlobalId: string
  allowedCompanyGlobalIds: string[]
  capabilities: FractionalCrmCapability[]
  fractionalDeploymentId: string
  fractionalOrganizationId: string
  actorEmail: string
}
export type FractionalCrmCredential = FractionalCrmPrincipal & {
  tokenHash: string
  expiresAt: Date | string
  revokedAt: Date | string | null
  enabled: boolean
}
export class FractionalCrmGatewayError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
    this.name = 'FractionalCrmGatewayError'
  }
}
export type FractionalCrmGatewayConfiguration = { origin: string; sourceInstanceId: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ga = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/
const tokenPattern = /^fcg_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/
const denied = (): never => { throw new FractionalCrmGatewayError(401, 'AUTHENTICATION_REQUIRED') }

/** No browser/worker/provider credential fallback, including local development. */
export function fractionalCrmGatewayConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FractionalCrmGatewayConfiguration {
  const origin = env.FRACTIONAL_CRM_GATEWAY_ORIGIN ?? ''
  const sourceInstanceId = env.FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID ?? ''
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new FractionalCrmGatewayError(503, 'GATEWAY_UNAVAILABLE') }
  if (env.FRACTIONAL_CRM_GATEWAY_ENABLED !== '1' || parsed.protocol !== 'https:'
    || parsed.origin !== origin || parsed.username || parsed.password || !uuid.test(sourceInstanceId)) {
    throw new FractionalCrmGatewayError(503, 'GATEWAY_UNAVAILABLE')
  }
  return { origin, sourceInstanceId }
}

/** Hash only a newly generated gateway credential; callers must never log its raw value. */
export function hashFractionalCrmGatewayToken(token: string): string {
  if (!tokenPattern.test(token)) throw new FractionalCrmGatewayError(400, 'INVALID_CREDENTIAL_FORMAT')
  return createHash('sha256').update(`fractional-crm-gateway-token:v1\n${token}`).digest('hex')
}

/** The public UUID selects a single row; the independent random secret authenticates it. */
export function fractionalCrmCredentialId(token: string): string {
  const match = tokenPattern.exec(token)
  if (!match) return denied()
  const hex = match[1]
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  if (!uuid.test(id)) return denied()
  return id
}

export async function authenticateFractionalCrmGateway(
  request: Request,
  config: FractionalCrmGatewayConfiguration,
  readCredential: (id: string) => Promise<FractionalCrmCredential | null>,
  capability: FractionalCrmCapability,
  now = Date.now(),
): Promise<FractionalCrmPrincipal> {
  if (new URL(request.url).origin !== config.origin) throw new FractionalCrmGatewayError(403, 'ORIGIN_DENIED')
  // A machine request carries no ambient browser authority or cross-site context.
  if (request.headers.has('cookie') || request.headers.has('origin') || request.headers.has('sec-fetch-site')) {
    throw new FractionalCrmGatewayError(403, 'MACHINE_REQUEST_REQUIRED')
  }
  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.startsWith('Bearer ') || authorization.length > 256) return denied()
  const token = authorization.slice(7)
  const credentialId = fractionalCrmCredentialId(token)
  const row = await readCredential(credentialId)
  const expected = row && /^[0-9a-f]{64}$/.test(row.tokenHash) ? row.tokenHash : '0'.repeat(64)
  const validHash = timingSafeEqual(Buffer.from(hashFractionalCrmGatewayToken(token), 'hex'), Buffer.from(expected, 'hex'))
  if (!row || !validHash || row.credentialId !== credentialId || !row.enabled || row.revokedAt !== null
    || !Number.isFinite(new Date(row.expiresAt).getTime()) || new Date(row.expiresAt).getTime() <= now) return denied()
  if (row.sourceInstanceId !== config.sourceInstanceId || !uuid.test(row.sourceInstanceId)
    || !uuid.test(row.workspaceOrganizationId) || !uuid.test(row.pipelineId) || !uuid.test(row.fractionalDeploymentId)
    || !ga.test(row.rootCompanyGlobalId) || !row.fractionalOrganizationId || row.fractionalOrganizationId.length > 200
    || /[\u0000-\u001f\u007f]/u.test(row.fractionalOrganizationId)
    || !row.actorEmail || row.actorEmail.length > 254 || /[\s\u0000-\u001f\u007f]/u.test(row.actorEmail)
    || !Array.isArray(row.allowedCompanyGlobalIds) || row.allowedCompanyGlobalIds.length > 1000
    || row.allowedCompanyGlobalIds.some(id => !ga.test(id))
    || new Set(row.allowedCompanyGlobalIds).size !== row.allowedCompanyGlobalIds.length
    || !Array.isArray(row.capabilities) || !row.capabilities.length
    || row.capabilities.some(value => !fractionalCrmCapabilities.includes(value))
    || new Set(row.capabilities).size !== row.capabilities.length) return denied()
  if (!row.capabilities.includes(capability)) throw new FractionalCrmGatewayError(403, 'CAPABILITY_DENIED')
  return {
    credentialId, sourceInstanceId: row.sourceInstanceId, workspaceOrganizationId: row.workspaceOrganizationId,
    pipelineId: row.pipelineId, rootCompanyGlobalId: row.rootCompanyGlobalId,
    allowedCompanyGlobalIds: [...row.allowedCompanyGlobalIds], capabilities: [...row.capabilities],
    fractionalDeploymentId: row.fractionalDeploymentId, fractionalOrganizationId: row.fractionalOrganizationId,
    actorEmail: row.actorEmail,
  }
}
