import { resolveUserMatonGatewayCredential } from '@/lib/integrations/matonGatewayCredentials'
import { getMatonCredentialState } from '@/lib/integrations/matonCredentials'
import { matonFetch } from '@/lib/maton'
import {
  deleteOrganizationCommunicationBindingInPostgres,
  listOrganizationCommunicationBindingsInPostgres,
  upsertOrganizationCommunicationBindingInPostgres,
  type OrganizationCommunicationApp,
} from '@/lib/persistence/organizationCommunications'
import { normalizeUserEmail } from '@/lib/users'

export const ORGANIZATION_COMMUNICATION_APPS = ['google-mail', 'google-calendar'] as const

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 1024 * 1024

export class OrganizationCommunicationRequestError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'ORGANIZATION_COMMUNICATION_INVALID') {
    super(message)
    this.name = 'OrganizationCommunicationRequestError'
    this.status = status
    this.code = code
  }
}

function organizationId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!UUID_PATTERN.test(normalized)) {
    throw new OrganizationCommunicationRequestError(
      'An active organization is required',
      409,
      'ORGANIZATION_COMMUNICATION_ORGANIZATION_REQUIRED',
    )
  }
  return normalized
}

export function normalizeOrganizationCommunicationApp(value: unknown): OrganizationCommunicationApp {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'gmail') return 'google-mail'
  if (normalized === 'calendar') return 'google-calendar'
  if (normalized === 'google-mail' || normalized === 'google-calendar') return normalized
  throw new OrganizationCommunicationRequestError('Communication application must be Gmail or Google Calendar')
}

function connectionId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 512 || !/^[\x21-\x7e]+$/.test(normalized)) {
    throw new OrganizationCommunicationRequestError('A valid active Maton connection is required')
  }
  return normalized
}

export function normalizeCommunicationIdentityEmail(value: unknown, fallback?: string | null): string {
  let email: string
  try {
    email = normalizeUserEmail(value || fallback)
  } catch {
    throw new OrganizationCommunicationRequestError('A valid communication identity email is required')
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw new OrganizationCommunicationRequestError('A valid communication identity email is required')
  }
  return email
}

async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new OrganizationCommunicationRequestError(
      `${label} verification failed with status ${response.status}`,
      [400, 401, 403, 404].includes(response.status) ? 422 : 502,
      'ORGANIZATION_COMMUNICATION_PROVIDER_REJECTED',
    )
  }
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new OrganizationCommunicationRequestError(
      `${label} returned an invalid response`,
      502,
      'ORGANIZATION_COMMUNICATION_PROVIDER_INVALID',
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new OrganizationCommunicationRequestError(
      `${label} returned an invalid response`,
      502,
      'ORGANIZATION_COMMUNICATION_PROVIDER_INVALID',
    )
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload')
    return parsed as Record<string, unknown>
  } catch {
    throw new OrganizationCommunicationRequestError(
      `${label} returned an invalid response`,
      502,
      'ORGANIZATION_COMMUNICATION_PROVIDER_INVALID',
    )
  }
}

async function providerJson(input: {
  ownerEmail: string
  app: OrganizationCommunicationApp
  connectionId: string
  pathname: string
  label: string
}) {
  let response: Response
  try {
    response = await matonFetch(input.pathname, { headers: { Accept: 'application/json' } }, {
      ownerEmail: input.ownerEmail,
      app: input.app,
      boundConnectionId: input.connectionId,
    })
  } catch {
    throw new OrganizationCommunicationRequestError(
      `${input.label} verification is unavailable`,
      502,
      'ORGANIZATION_COMMUNICATION_PROVIDER_UNAVAILABLE',
    )
  }
  return responseJson(response, input.label)
}

async function verifiedGmailIdentity(input: {
  ownerEmail: string
  connectionId: string
  requestedIdentityEmail?: unknown
}): Promise<{ accountEmail: string; identityEmail: string; calendarId: null }> {
  const profile = await providerJson({
    ownerEmail: input.ownerEmail,
    app: 'google-mail',
    connectionId: input.connectionId,
    pathname: '/google-mail/gmail/v1/users/me/profile',
    label: 'Gmail account',
  })
  const accountEmail = normalizeCommunicationIdentityEmail(profile.emailAddress)
  const identityEmail = normalizeCommunicationIdentityEmail(input.requestedIdentityEmail, accountEmail)
  if (identityEmail !== accountEmail) {
    const sendAs = await providerJson({
      ownerEmail: input.ownerEmail,
      app: 'google-mail',
      connectionId: input.connectionId,
      pathname: `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(identityEmail)}`,
      label: 'Gmail sender',
    })
    const verifiedEmail = normalizeCommunicationIdentityEmail(sendAs.sendAsEmail)
    const verificationStatus = String(sendAs.verificationStatus || '').trim().toLowerCase()
    if (verifiedEmail !== identityEmail || verificationStatus !== 'accepted') {
      throw new OrganizationCommunicationRequestError(
        'The requested Gmail sender is not an accepted send-as identity',
        422,
        'ORGANIZATION_COMMUNICATION_SENDER_NOT_VERIFIED',
      )
    }
  }
  return { accountEmail, identityEmail, calendarId: null }
}

async function verifiedCalendarIdentity(input: {
  ownerEmail: string
  connectionId: string
}): Promise<{ accountEmail: string; identityEmail: string; calendarId: 'primary' }> {
  const calendar = await providerJson({
    ownerEmail: input.ownerEmail,
    app: 'google-calendar',
    connectionId: input.connectionId,
    pathname: '/google-calendar/calendar/v3/users/me/calendarList/primary',
    label: 'Google Calendar account',
  })
  const accountEmail = normalizeCommunicationIdentityEmail(calendar.id)
  return { accountEmail, identityEmail: accountEmail, calendarId: 'primary' }
}

export async function getOrganizationCommunicationState(input: {
  organizationId: unknown
  actorEmail: unknown
}) {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const [bindings, credential] = await Promise.all([
    listOrganizationCommunicationBindingsInPostgres(normalizedOrganizationId),
    getMatonCredentialState(actorEmail),
  ])
  return {
    organizationId: normalizedOrganizationId,
    bindings,
    availableConnections: credential.connections
      .filter((connection) => (
        connection.source === 'maton'
        && connection.status === 'ACTIVE'
        && ORGANIZATION_COMMUNICATION_APPS.includes(connection.app as OrganizationCommunicationApp)
      ))
      .map((connection) => ({
        connectionId: connection.connectionId,
        name: connection.name,
        app: connection.app,
        accountEmail: connection.accountEmail,
        selectedForUser: connection.selected,
      })),
  }
}

export async function bindOrganizationCommunication(input: {
  organizationId: unknown
  actorEmail: unknown
  app: unknown
  connectionId: unknown
  identityEmail?: unknown
}) {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const app = normalizeOrganizationCommunicationApp(input.app)
  const normalizedConnectionId = connectionId(input.connectionId)
  const credential = await resolveUserMatonGatewayCredential({
    ownerEmail: actorEmail,
    app,
    boundConnectionId: normalizedConnectionId,
  }).catch(() => {
    throw new OrganizationCommunicationRequestError(
      'The selected Maton connection is not active for this account and application',
      422,
      'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
    )
  })
  const verified = app === 'google-mail'
    ? await verifiedGmailIdentity({
        ownerEmail: actorEmail,
        connectionId: credential.connectionId,
        requestedIdentityEmail: input.identityEmail,
      })
    : await verifiedCalendarIdentity({
        ownerEmail: actorEmail,
        connectionId: credential.connectionId,
      })

  await upsertOrganizationCommunicationBindingInPostgres({
    organizationId: normalizedOrganizationId,
    app,
    credentialOwnerEmail: actorEmail,
    connectionId: credential.connectionId,
    accountEmail: verified.accountEmail,
    identityEmail: verified.identityEmail,
    calendarId: verified.calendarId,
    actorEmail,
  })
  return getOrganizationCommunicationState({ organizationId: normalizedOrganizationId, actorEmail })
}

export async function disconnectOrganizationCommunication(input: {
  organizationId: unknown
  actorEmail: unknown
  app: unknown
}) {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const app = normalizeOrganizationCommunicationApp(input.app)
  await deleteOrganizationCommunicationBindingInPostgres({
    organizationId: normalizedOrganizationId,
    app,
    actorEmail,
  })
  return getOrganizationCommunicationState({ organizationId: normalizedOrganizationId, actorEmail })
}

export function sanitizeOrganizationCommunicationError(error: unknown) {
  if (error instanceof OrganizationCommunicationRequestError) return error
  return new OrganizationCommunicationRequestError(
    'Organization communication integration failed',
    500,
    'ORGANIZATION_COMMUNICATION_INTERNAL_ERROR',
  )
}
