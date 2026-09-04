import { resolveUserMatonGatewayCredential } from '@/lib/integrations/matonGatewayCredentials'
import { getMatonCredentialState } from '@/lib/integrations/matonCredentials'
import { matonFetch } from '@/lib/maton'
import {
  deleteOrganizationCommunicationBindingInPostgres,
  listOrganizationCommunicationBindingsInPostgres,
  resolvePipelineCommunicationScopeInPostgres,
  upsertOrganizationCommunicationBindingInPostgres,
  type OrganizationCommunicationApp,
  type PipelineCommunicationSnapshot,
} from '@/lib/persistence/organizationCommunications'
import { normalizeUserEmail } from '@/lib/users'

export const ORGANIZATION_COMMUNICATION_APPS = ['google-mail', 'google-calendar'] as const

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CALENDAR_LIST_PAGES = 4
const MAX_CALENDAR_OPTIONS = 1000
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

type GmailSendAsIdentity = {
  email: string
  verificationStatus: string
  isPrimary: boolean
  isDefault: boolean
}

type AccessibleGoogleCalendar = {
  id: string
  summary: string
  primary: boolean
  accessRole: 'owner' | 'writer'
}

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

function calendarId(value: unknown, fallback = ''): string {
  const normalized = typeof value === 'string' ? value.trim() : fallback
  if (!normalized || normalized.length > 1024 || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new OrganizationCommunicationRequestError('A valid accessible Google Calendar is required')
  }
  return normalized
}

function providerObjectList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => (
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      ))
    : []
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

async function listGmailSendAsIdentities(input: {
  ownerEmail: string
  connectionId: string
}): Promise<GmailSendAsIdentity[]> {
  const response = await providerJson({
    ownerEmail: input.ownerEmail,
    app: 'google-mail',
    connectionId: input.connectionId,
    pathname: '/google-mail/gmail/v1/users/me/settings/sendAs',
    label: 'Gmail sender list',
  })
  return providerObjectList(response.sendAs)
    .flatMap((item) => {
      try {
        const email = normalizeCommunicationIdentityEmail(item.sendAsEmail)
        const verificationStatus = String(item.verificationStatus || '').trim().toLowerCase()
        return [{
          email,
          verificationStatus,
          isPrimary: item.isPrimary === true,
          isDefault: item.isDefault === true,
        }]
      } catch {
        return []
      }
    })
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.email.localeCompare(right.email))
}

async function listAccessibleGoogleCalendars(input: {
  ownerEmail: string
  connectionId: string
}): Promise<AccessibleGoogleCalendar[]> {
  const calendars: AccessibleGoogleCalendar[] = []
  const seen = new Set<string>()
  let pageToken = ''
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES && calendars.length < MAX_CALENDAR_OPTIONS; page += 1) {
    const parameters = new URLSearchParams({
      maxResults: '250',
      minAccessRole: 'writer',
      showHidden: 'false',
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await providerJson({
      ownerEmail: input.ownerEmail,
      app: 'google-calendar',
      connectionId: input.connectionId,
      pathname: `/google-calendar/calendar/v3/users/me/calendarList?${parameters.toString()}`,
      label: 'Google Calendar list',
    })
    for (const item of providerObjectList(response.items)) {
      const accessRole = String(item.accessRole || '').trim().toLowerCase()
      if (accessRole !== 'owner' && accessRole !== 'writer') continue
      let id: string
      try {
        id = calendarId(item.id)
      } catch {
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      calendars.push({
        id,
        summary: String(item.summaryOverride || item.summary || id).trim().slice(0, 300) || id,
        primary: item.primary === true,
        accessRole,
      })
      if (calendars.length >= MAX_CALENDAR_OPTIONS) break
    }
    const nextPageToken = String(response.nextPageToken || '').trim()
    if (!nextPageToken) break
    if (nextPageToken.length > 2048 || CONTROL_CHARACTER_PATTERN.test(nextPageToken)) {
      throw new OrganizationCommunicationRequestError(
        'Google Calendar list returned an invalid response',
        502,
        'ORGANIZATION_COMMUNICATION_PROVIDER_INVALID',
      )
    }
    pageToken = nextPageToken
  }
  return calendars.sort((left, right) => Number(right.primary) - Number(left.primary) || left.summary.localeCompare(right.summary))
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
  const sendAsIdentities = await listGmailSendAsIdentities(input)
  const selectedIdentity = sendAsIdentities.find((candidate) => candidate.email === identityEmail)
  if (!selectedIdentity || (
    selectedIdentity.verificationStatus !== 'accepted'
    && !(selectedIdentity.isPrimary && selectedIdentity.email === accountEmail)
  )) {
    throw new OrganizationCommunicationRequestError(
      'The requested Gmail sender is not an accepted send-as identity',
      422,
      'ORGANIZATION_COMMUNICATION_SENDER_NOT_VERIFIED',
    )
  }
  return { accountEmail, identityEmail, calendarId: null }
}

async function verifiedCalendarIdentity(input: {
  ownerEmail: string
  connectionId: string
  accountEmail: string | null
  requestedCalendarId?: unknown
}): Promise<{ accountEmail: string; identityEmail: string; calendarId: string }> {
  const calendars = await listAccessibleGoogleCalendars(input)
  const requestedCalendarId = input.requestedCalendarId === undefined || input.requestedCalendarId === null
    || String(input.requestedCalendarId).trim() === ''
    ? null
    : calendarId(input.requestedCalendarId)
  const selectedCalendar = requestedCalendarId
    ? calendars.find((calendar) => calendar.id === requestedCalendarId)
    : calendars.find((calendar) => calendar.primary)
  if (!selectedCalendar) {
    throw new OrganizationCommunicationRequestError(
      requestedCalendarId
        ? 'The selected Google Calendar is not accessible with write permission on this connection'
        : 'This connection has no writable primary Google Calendar',
      422,
      'ORGANIZATION_COMMUNICATION_CALENDAR_NOT_WRITABLE',
    )
  }
  const identityEmail = normalizeCommunicationIdentityEmail(selectedCalendar.id)
  const primaryCalendar = calendars.find((calendar) => calendar.primary)
  const accountEmail = normalizeCommunicationIdentityEmail(primaryCalendar?.id, input.accountEmail || identityEmail)
  return { accountEmail, identityEmail, calendarId: selectedCalendar.id }
}

export async function resolveVerifiedPipelineCalendarSelection(input: {
  pipelineId: unknown
  actorEmail: unknown
  connectionId: unknown
  calendarId: unknown
}): Promise<PipelineCommunicationSnapshot> {
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const normalizedConnectionId = connectionId(input.connectionId)
  const normalizedCalendarId = calendarId(input.calendarId)
  const scope = await resolvePipelineCommunicationScopeInPostgres({
    pipelineId: String(input.pipelineId || ''),
    actorEmail,
  })
  const credential = await resolveUserMatonGatewayCredential({
    ownerEmail: actorEmail,
    app: 'google-calendar',
    boundConnectionId: normalizedConnectionId,
  }).catch(() => {
    throw new OrganizationCommunicationRequestError(
      'The selected Google Calendar connection is not active for this account',
      422,
      'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
    )
  })
  const verified = await verifiedCalendarIdentity({
    ownerEmail: actorEmail,
    connectionId: credential.connectionId,
    accountEmail: credential.accountEmail,
    requestedCalendarId: normalizedCalendarId,
  })
  return {
    organizationId: scope.organizationId,
    credentialOwnerEmail: actorEmail,
    connectionId: credential.connectionId,
    accountEmail: verified.accountEmail,
    identityEmail: verified.identityEmail,
    calendarId: verified.calendarId,
    source: 'meeting-override',
  }
}

export async function resolveVerifiedPipelineGmailSelection(input: {
  pipelineId: unknown
  actorEmail: unknown
  connectionId: unknown
  gmailSendAsEmail: unknown
}): Promise<PipelineCommunicationSnapshot> {
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const normalizedConnectionId = connectionId(input.connectionId)
  const normalizedIdentityEmail = normalizeCommunicationIdentityEmail(input.gmailSendAsEmail)
  const scope = await resolvePipelineCommunicationScopeInPostgres({
    pipelineId: String(input.pipelineId || ''),
    actorEmail,
  })
  const credential = await resolveUserMatonGatewayCredential({
    ownerEmail: actorEmail,
    app: 'google-mail',
    boundConnectionId: normalizedConnectionId,
  }).catch(() => {
    throw new OrganizationCommunicationRequestError(
      'The selected Gmail connection is not active for this account',
      422,
      'ORGANIZATION_COMMUNICATION_CONNECTION_INVALID',
    )
  })
  const verified = await verifiedGmailIdentity({
    ownerEmail: actorEmail,
    connectionId: credential.connectionId,
    requestedIdentityEmail: normalizedIdentityEmail,
  })
  return {
    organizationId: scope.organizationId,
    credentialOwnerEmail: actorEmail,
    connectionId: credential.connectionId,
    accountEmail: verified.accountEmail,
    identityEmail: verified.identityEmail,
    calendarId: null,
    source: 'email-override',
  }
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
  const availableConnections = await Promise.all(credential.connections
    .filter((connection) => (
      connection.source === 'maton'
      && connection.status === 'ACTIVE'
      && ORGANIZATION_COMMUNICATION_APPS.includes(connection.app as OrganizationCommunicationApp)
    ))
    .map(async (connection) => {
      const base = {
        connectionId: connection.connectionId,
        name: connection.name,
        app: connection.app,
        accountEmail: connection.accountEmail,
        selectedForUser: connection.selected,
      }
      try {
        if (connection.app === 'google-mail') {
          const gmailSendAsIdentities = await listGmailSendAsIdentities({
            ownerEmail: actorEmail,
            connectionId: connection.connectionId,
          })
          return {
            ...base,
            // The provider's current primary address may differ from cached
            // connection metadata after a Workspace domain/account rename.
            accountEmail: gmailSendAsIdentities.find((identity) => identity.isPrimary)?.email
              || base.accountEmail,
            gmailSendAsIdentities,
          }
        }
        return {
          ...base,
          calendars: await listAccessibleGoogleCalendars({
            ownerEmail: actorEmail,
            connectionId: connection.connectionId,
          }),
        }
      } catch (error) {
        const sanitized = error instanceof OrganizationCommunicationRequestError
          ? error
          : new OrganizationCommunicationRequestError('Provider options are unavailable', 502)
        return {
          ...base,
          ...(connection.app === 'google-mail' ? { gmailSendAsIdentities: [] } : { calendars: [] }),
          selectionError: sanitized.message,
        }
      }
    }))
  return {
    organizationId: normalizedOrganizationId,
    bindings,
    availableConnections,
  }
}

export async function bindOrganizationCommunication(input: {
  organizationId: unknown
  actorEmail: unknown
  app: unknown
  connectionId: unknown
  identityEmail?: unknown
  gmailSendAsEmail?: unknown
  calendarId?: unknown
}) {
  const normalizedOrganizationId = organizationId(input.organizationId)
  const actorEmail = normalizeCommunicationIdentityEmail(input.actorEmail)
  const app = normalizeOrganizationCommunicationApp(input.app)
  const normalizedConnectionId = connectionId(input.connectionId)
  const suppliedIdentity = String(input.identityEmail || '').trim()
  const suppliedGmailSendAs = String(input.gmailSendAsEmail || '').trim()
  if (suppliedIdentity && suppliedGmailSendAs && suppliedIdentity.toLowerCase() !== suppliedGmailSendAs.toLowerCase()) {
    throw new OrganizationCommunicationRequestError('Conflicting Gmail sender identities were supplied')
  }
  if (app === 'google-mail' && String(input.calendarId || '').trim()) {
    throw new OrganizationCommunicationRequestError('Gmail sender selection cannot select a Google Calendar')
  }
  if (app === 'google-calendar' && (suppliedIdentity || suppliedGmailSendAs)) {
    throw new OrganizationCommunicationRequestError(
      'Google Calendar organizer identity is derived from the selected writable calendar',
    )
  }
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
        requestedIdentityEmail: suppliedGmailSendAs || suppliedIdentity,
      })
    : await verifiedCalendarIdentity({
        ownerEmail: actorEmail,
        connectionId: credential.connectionId,
        accountEmail: credential.accountEmail,
        requestedCalendarId: input.calendarId,
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
