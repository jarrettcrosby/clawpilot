import {
  authenticateFractionalCrmGateway, fractionalCrmGatewayConfiguration, FractionalCrmGatewayError,
  type FractionalCrmCapability, type FractionalCrmCredential, type FractionalCrmPrincipal,
} from './fractionalCrmGatewayAuth'
import { isFractionalCrmGatewayPath } from './fractionalCrmGatewayPath.mjs'

type Fields = Record<string, unknown>
export type FractionalCrmPatch = {
  ifMatch: string
  idempotencyKey: string
  fields: Fields
  assertedFractionalActor: { userId: string; organizationId: string; customerId: string }
}
export type FractionalCrmGatewayServices = {
  readFractionalCrmCredential: (id: string) => Promise<FractionalCrmCredential | null>
  readFractionalCrmCompany: (principal: FractionalCrmPrincipal, ga: string) => Promise<unknown>
  readFractionalCrmContact: (principal: FractionalCrmPrincipal, ga: string, gc: string) => Promise<unknown>
  listFractionalCrmContacts: (principal: FractionalCrmPrincipal, ga: string, page: { limit: number; cursor?: string }) => Promise<unknown>
  updateFractionalCrmCompany: (principal: FractionalCrmPrincipal, ga: string, input: FractionalCrmPatch) => Promise<unknown>
  updateFractionalCrmContact: (principal: FractionalCrmPrincipal, ga: string, gc: string, input: FractionalCrmPatch) => Promise<unknown>
  resolveOrCreateFractionalCrmOnboarding: (principal: FractionalCrmPrincipal, input: Fields, idempotencyKey: string) => Promise<unknown>
}
const responseHeaders = {
  'Cache-Control': 'private, no-store', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
}
const basePath = '/api/integrations/fractional-crm/v1/'
const scopeKeys = ['sourceInstanceId', 'workspaceOrganizationId', 'pipelineId', 'rootCompanyGlobalId'] as const
const companyKeys = ['companyName', 'website', 'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'countryCode']
const contactKeys = ['displayName', 'email', 'phone', 'jobTitle']
function invalid(status = 400, code = 'INVALID_REQUEST'): never { throw new FractionalCrmGatewayError(status, code) }
function object(value: unknown, allowed: readonly string[]): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value as Fields
}
function boundedString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
}
function idempotency(request: Request) {
  const key = request.headers.get('idempotency-key') ?? ''
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(key)) invalid(400, 'IDEMPOTENCY_KEY_REQUIRED')
  return key
}
function conditionalVersion(request: Request) {
  const value = request.headers.get('if-match')
  if (!value) invalid(428, 'PRECONDITION_REQUIRED')
  if (!/^"[^"\u0000-\u001f\u007f]{1,240}"$/u.test(value)) invalid(400, 'INVALID_PRECONDITION')
  return value.slice(1, -1)
}
async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) invalid(415, 'JSON_REQUIRED')
  if (request.headers.has('content-encoding')) invalid(415, 'CONTENT_ENCODING_UNSUPPORTED')
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 65_536)) invalid(413, 'REQUEST_TOO_LARGE')
  if (!request.body) invalid()
  const reader = request.body.getReader()
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  let length = 0
  const chunks: Uint8Array[] = []
  const read = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => reject(new FractionalCrmGatewayError(408, 'REQUEST_TIMEOUT'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
  try {
    for (;;) {
      const next = await read()
      if (next.done) break
      length += next.value.length
      if (length > 65_536) invalid(413, 'REQUEST_TOO_LARGE')
      chunks.push(next.value)
    }
  } catch (error) {
    // Cancellation is best-effort; never await a hostile stream's cancellation hook.
    void reader.cancel().catch(() => {})
    if (error instanceof FractionalCrmGatewayError) throw error
    invalid(400, 'INVALID_JSON')
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return invalid(400, 'INVALID_JSON') }
}
function exactScope(url: URL, principal: FractionalCrmPrincipal, list: boolean) {
  const allowed: readonly string[] = [...scopeKeys, ...(list ? ['limit', 'cursor'] : [])]
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) invalid(400, 'INVALID_SCOPE')
  }
  for (const key of scopeKeys) if (url.searchParams.get(key) !== principal[key]) invalid(403, 'SCOPE_DENIED')
}
function patch(input: unknown, request: Request, principal: FractionalCrmPrincipal, contact: boolean): FractionalCrmPatch {
  const value = object(input, ['fields', 'assertedFractionalActor'])
  const fields = object(value.fields, contact ? contactKeys : companyKeys)
  if (!Object.keys(fields).length || Object.values(fields).some(v => v !== null && (typeof v !== 'string' || v.length > 4096))) invalid(422, 'INVALID_FIELDS')
  const actor = object(value.assertedFractionalActor, ['userId', 'organizationId', 'customerId'])
  if (!boundedString(actor.userId) || !boundedString(actor.organizationId) || !boundedString(actor.customerId)) invalid(400, 'INVALID_ACTOR')
  if (actor.organizationId !== principal.fractionalOrganizationId) invalid(403, 'SCOPE_DENIED')
  return {
    fields, assertedFractionalActor: { userId: actor.userId, organizationId: actor.organizationId, customerId: actor.customerId },
    ifMatch: conditionalVersion(request), idempotencyKey: idempotency(request),
  }
}
function onboarding(input: unknown, principal: FractionalCrmPrincipal) {
  const value = object(input, ['schemaVersion', 'sourceInstanceId', 'origin', 'company', 'contact', 'allowCreate', 'reviewDecisionToken', 'actor'])
  const origin = object(value.origin, ['deploymentId', 'organizationId', 'customerId', 'contactId', 'onboardingId'])
  if (value.schemaVersion !== 1 || value.sourceInstanceId !== principal.sourceInstanceId
    || origin.deploymentId !== principal.fractionalDeploymentId || origin.organizationId !== principal.fractionalOrganizationId) invalid(403, 'SCOPE_DENIED')
  if (!boundedString(origin.customerId) || !boundedString(origin.onboardingId)
    || (value.contact !== undefined && !boundedString(origin.contactId))
    || (value.contact === undefined && origin.contactId !== undefined)) invalid()
  // Identity matching, reviewed decisions and atomic create permission are validated again by persistence.
  return value
}

const publicErrors = new Set([
  'AUTHENTICATION_REQUIRED', 'GATEWAY_UNAVAILABLE', 'ORIGIN_DENIED', 'MACHINE_REQUEST_REQUIRED', 'CAPABILITY_DENIED',
  'INVALID_REQUEST', 'INVALID_SCOPE', 'SCOPE_DENIED', 'IDEMPOTENCY_KEY_REQUIRED', 'PRECONDITION_REQUIRED', 'INVALID_PRECONDITION',
  'JSON_REQUIRED', 'CONTENT_ENCODING_UNSUPPORTED', 'REQUEST_TOO_LARGE', 'REQUEST_TIMEOUT', 'INVALID_JSON', 'INVALID_FIELDS', 'INVALID_ACTOR',
  'RECORD_NOT_FOUND', 'RECORD_RETIRED', 'IDENTITY_CONFLICT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'MAPPING_REVIEW',
  'MANAGED_RECORD', 'REVIEW_REQUIRED', 'REVIEW_STALE', 'EXCLUDED_FROM_CRM', 'DISCOVERY_LIMIT',
  'UNAUTHORIZED', 'INVALID_GLOBAL_ID', 'INVALID_PAGE', 'INVALID_IDEMPOTENCY_KEY',
  'ADDRESS_SHAPE_CONFLICT', 'CONTACT_NAME_SHAPE_CONFLICT', 'CONTACT_RELATIONSHIP_REVIEW', 'CANONICAL_WRITE_MISMATCH',
])
function errorResponse(error: unknown) {
  const known = error instanceof FractionalCrmGatewayError && publicErrors.has(error.code)
  const status = known && [400, 401, 403, 404, 408, 409, 410, 412, 413, 415, 422, 428, 503].includes(error.status) ? error.status : 503
  const code = known ? error.code : 'GATEWAY_UNAVAILABLE'
  return Response.json({ error: code, message: 'The scoped CRM request could not be completed.' }, {
    status, headers: { ...responseHeaders, ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="fractional-crm"' } : {}) },
  })
}

/** Testable HTTP boundary. Persistence rechecks the live grant in its own transaction. */
export async function handleFractionalCrmGateway(
  request: Request, services: FractionalCrmGatewayServices,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (!isFractionalCrmGatewayPath(url.pathname, request.method)) invalid(404, 'RECORD_NOT_FOUND')
    const parts = url.pathname.slice(basePath.length).split('/')
    const isOnboarding = parts[0] === 'onboarding'
    const isContact = parts.length >= 3
    const isList = parts.length === 3
    const capability: FractionalCrmCapability = isOnboarding ? 'crm.onboarding.write'
      : request.method === 'PATCH' ? (isContact ? 'crm.contact.write' : 'crm.company.write')
        : isContact ? 'crm.contact.read' : 'crm.company.read'
    const principal = await authenticateFractionalCrmGateway(request, fractionalCrmGatewayConfiguration(env), services.readFractionalCrmCredential, capability)
    exactScope(url, principal, isList)
    let result: unknown
    if (isOnboarding) {
      const key = idempotency(request)
      result = await services.resolveOrCreateFractionalCrmOnboarding(principal, onboarding(await readJson(request), principal), key)
    } else if (request.method === 'PATCH') {
      // Reject absent write preconditions before receiving the body.
      conditionalVersion(request); idempotency(request)
      const input = patch(await readJson(request), request, principal, isContact)
      result = isContact ? await services.updateFractionalCrmContact(principal, parts[1], parts[3], input)
        : await services.updateFractionalCrmCompany(principal, parts[1], input)
    } else if (isList) {
      const limit = url.searchParams.get('limit') ?? '50'
      const cursor = url.searchParams.get('cursor') ?? undefined
      if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100 || (cursor !== undefined && !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor))) invalid()
      result = await services.listFractionalCrmContacts(principal, parts[1], { limit: Number(limit), ...(cursor ? { cursor } : {}) })
    } else {
      result = isContact ? await services.readFractionalCrmContact(principal, parts[1], parts[3])
        : await services.readFractionalCrmCompany(principal, parts[1])
    }
    return Response.json(result, { status: 200, headers: responseHeaders })
  } catch (error) { return errorResponse(error) }
}
