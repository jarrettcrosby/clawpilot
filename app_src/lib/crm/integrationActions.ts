import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  GLOBAL_ID_MAX_LENGTH,
  globalIdFragment,
  globalIdPattern,
} from '@/lib/globalIds.mjs'
import { resolveUserMatonGatewayCredential } from '@/lib/integrations/matonGatewayCredentials'
import { matonFetch } from '@/lib/maton'
import {
  readCrmRecordByReference,
  resolveCrmReferenceCode,
  stageCrmRecordWithClient,
  stageCrmRecordInPostgres,
  type StageCrmRecordInput,
} from '@/lib/persistence/crm'
import {
  OrganizationCommunicationPersistenceError,
  resolvePipelineCommunicationScopeInPostgres,
  resolvePipelineCommunicationSnapshotInPostgres,
  type PipelineCommunicationSnapshot,
} from '@/lib/persistence/organizationCommunications'
import { query, withTransaction } from '@/lib/persistence/postgres'
import type { CrmActivityStatus, CrmMeeting } from '@/lib/crm/types'
import { normalizeUserEmail } from '@/lib/users'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

export const CRM_INTEGRATION_ACTION_TYPES = [
  'send_email',
  'create_calendar_event',
  'log_call',
  'send_campaign',
] as const

export type CrmIntegrationActionType = (typeof CRM_INTEGRATION_ACTION_TYPES)[number]
export type CrmIntegrationActionStatus =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'cancelled'

type CrmIntegrationProvider = 'maton' | 'direct-google' | 'internal'
type JsonObject = Record<string, unknown>
type TimestampValue = string | Date
type CrmReferenceRecord = Awaited<ReturnType<typeof readCrmRecordByReference>>

type ActionRow = {
  id: string
  pipeline_id: string
  actor_email: string
  provider: CrmIntegrationProvider | null
  app: string
  action_type: CrmIntegrationActionType
  aggregate_type: string
  aggregate_id: string
  reference_code: string | null
  payload: JsonObject
  status: CrmIntegrationActionStatus
  attempts: number
  available_at: TimestampValue
  locked_at: TimestampValue | null
  lock_token: string | null
  external_id: string | null
  response_summary: JsonObject
  last_error: string | null
  idempotency_key: string
  workspace_organization_id: string | null
  communication_credential_owner_email: string | null
  communication_connection_id: string | null
  communication_account_email: string | null
  communication_identity_email: string | null
  communication_calendar_id: string | null
  communication_binding_source: 'organization' | 'user-default' | 'meeting-override' | null
  processed_at: TimestampValue | null
  created_at: TimestampValue
  updated_at: TimestampValue
}

type InsertedActionRow = ActionRow & {
  created: boolean
  matches_intent: boolean
}

type CampaignTargetRow = {
  entity: 'contacts' | 'leads'
  id: string
  reference_code: string
  first_name: string | null
  last_name: string | null
  full_name: string
  email: string | null
  email_opt_out: boolean
  organization_id: string | null
  suitecrm_id: string | null
}

type PreparedAction = {
  pipelineId: string
  actorEmail: string
  provider: CrmIntegrationProvider
  app: string
  actionType: CrmIntegrationActionType
  aggregateType: string
  aggregateId: string
  referenceCode: string
  payload: JsonObject
  idempotencyKey: string
  communication: PipelineCommunicationSnapshot | null
}

export type CrmIntegrationActionView = {
  id: string
  pipelineId: string
  provider: CrmIntegrationProvider | null
  app: string
  actionType: CrmIntegrationActionType
  referenceCode: string | null
  status: CrmIntegrationActionStatus
  attempts: number
  availableAt: string
  externalId: string | null
  responseSummary: JsonObject
  communication: {
    organizationId: string
    credentialOwnerEmail: string | null
    connectionId: string | null
    accountEmail: string | null
    identityEmail: string | null
    calendarId: string | null
    source: 'organization' | 'user-default' | 'meeting-override'
  } | null
  lastError: string | null
  processedAt: string | null
  createdAt: string
  updatedAt: string
}

export type LeasedCrmIntegrationAction = CrmIntegrationActionView & {
  actorEmail: string
  aggregateType: string
  aggregateId: string
  payload: JsonObject
  lockToken: string
  idempotencyKey: string
  communicationCredentialOwnerEmail: string | null
  communicationConnectionId: string | null
}

export class CrmIntegrationActionError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'CRM_ACTION_INVALID') {
    super(message)
    this.name = 'CrmIntegrationActionError'
    this.status = status
    this.code = code
  }
}

class PermanentCrmIntegrationActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentCrmIntegrationActionError'
  }
}

class ProviderCrmIntegrationActionError extends Error {
  constructor(
    readonly app: 'google-mail' | 'google-calendar',
    readonly providerStatus: number,
    readonly providerCode: string | null,
    readonly providerError: string,
  ) {
    super(
      `${app} provider request failed with status ${providerStatus}`
      + (providerCode ? ` (${providerCode})` : '')
      + (providerError ? `: ${providerError}` : ''),
    )
    this.name = 'ProviderCrmIntegrationActionError'
  }
}

const ACTION_RUNTIME: Record<CrmIntegrationActionType, {
  provider: CrmIntegrationProvider
  app: string
}> = {
  send_email: { provider: 'maton', app: 'google-mail' },
  create_calendar_event: { provider: 'maton', app: 'google-calendar' },
  log_call: { provider: 'internal', app: 'crm' },
  send_campaign: { provider: 'internal', app: 'crm' },
}

const AGGREGATE_TYPES: Record<CrmReferenceRecord['entity'], string> = {
  organizations: 'crm_organization',
  contacts: 'crm_contact',
  products: 'crm_product',
  leads: 'crm_lead',
  opportunities: 'crm_opportunity',
  meetings: 'crm_meeting',
  interactions: 'crm_interaction',
  campaigns: 'crm_campaign',
}

function suiteCrmParentType(entity: CrmReferenceRecord['entity']) {
  return ({
    organizations: 'Accounts',
    contacts: 'Contacts',
    leads: 'Leads',
    opportunities: 'Opportunities',
    meetings: 'Meetings',
    campaigns: 'Campaigns',
  } as const)[entity as Exclude<CrmReferenceRecord['entity'], 'interactions' | 'products'>] || null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CRM_PREFIXES = ['ga', 'gc', 'gi', 'gk', 'gl', 'gm', 'go']
const CRM_REFERENCE_PATTERN = globalIdPattern(CRM_PREFIXES)
const CAMPAIGN_RECIPIENT_PATTERN = globalIdPattern(['gc', 'gl'])
const CRM_REPLY_MARKER_PATTERN = new RegExp(
  `%gslt${globalIdFragment(CRM_PREFIXES)}(?![A-Za-z0-9_])`,
  'gi',
)
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const MAX_CAMPAIGN_RECIPIENTS = 500
const MAX_PROVIDER_ERROR_BYTES = 8 * 1024
const MAX_PROVIDER_ERROR_LENGTH = 500
const MAX_PROVIDER_CODE_LENGTH = 120
const MAX_CALENDAR_LIST_PAGES = 4
const MAX_CALENDAR_OPTIONS = 1000

function iso(value: TimestampValue | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function cleanString(value: unknown, max: number, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new CrmIntegrationActionError(`${field} is invalid`)
  }
  return normalized
}

function requiredString(value: unknown, max: number, field: string): string {
  const normalized = cleanString(value, max, field)
  if (!normalized) throw new CrmIntegrationActionError(`${field} is required`)
  return normalized
}

function objectValue(value: unknown, field = 'CRM action payload'): JsonObject {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CrmIntegrationActionError(`${field} must be an object`)
  }
  return value as JsonObject
}

function assertOnlyFields(value: JsonObject, allowed: readonly string[]) {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key))
  if (unsupported) throw new CrmIntegrationActionError(`Unsupported CRM action payload field: ${unsupported}`)
}

function normalizeEmail(value: unknown, field: string): string {
  const email = cleanString(value, 254, field).toLowerCase()
  if (!email || !EMAIL_PATTERN.test(email) || /[\r\n]/.test(email)) {
    throw new CrmIntegrationActionError(`${field} is invalid`)
  }
  return email
}

function normalizeReference(value: unknown): string {
  const referenceCode = cleanString(value, GLOBAL_ID_MAX_LENGTH, 'CRM reference').toLowerCase()
  if (!CRM_REFERENCE_PATTERN.test(referenceCode)) {
    throw new CrmIntegrationActionError('CRM reference is invalid')
  }
  return referenceCode
}

function normalizeUuid(value: unknown, field: string): string {
  const normalized = cleanString(value, 64, field)
  if (!UUID_PATTERN.test(normalized)) throw new CrmIntegrationActionError(`${field} is invalid`)
  return normalized
}

function normalizeCalendarCommunicationSnapshot(
  value: PipelineCommunicationSnapshot,
  actorEmail: string,
): PipelineCommunicationSnapshot {
  if (
    !value
    || typeof value !== 'object'
    || !['organization', 'user-default', 'meeting-override'].includes(value.source)
  ) {
    throw new CrmIntegrationActionError(
      'A reviewed Google Calendar selection is required',
      400,
      'CRM_CALENDAR_SELECTION_INVALID',
    )
  }
  const organizationId = normalizeUuid(value.organizationId, 'Calendar organization ID')
  const credentialOwnerEmail = normalizeEmail(value.credentialOwnerEmail, 'Calendar credential owner')
  if (value.source !== 'organization' && credentialOwnerEmail !== actorEmail) {
    throw new CrmIntegrationActionError(
      'The selected Google Calendar connection must belong to the signed-in user',
      403,
      'CRM_CALENDAR_SELECTION_FORBIDDEN',
    )
  }
  const selectedConnectionId = requiredString(value.connectionId, 512, 'Calendar connection ID')
  if (!/^[\x21-\x7e]+$/.test(selectedConnectionId)) {
    throw new CrmIntegrationActionError('Calendar connection ID is invalid')
  }
  const selectedCalendarId = typeof value.calendarId === 'string' ? value.calendarId.trim() : ''
  if (
    !selectedCalendarId
    || selectedCalendarId.length > 1024
    || /[\u0000-\u001f\u007f]/.test(selectedCalendarId)
  ) {
    throw new CrmIntegrationActionError('Calendar ID is invalid')
  }
  return {
    organizationId,
    credentialOwnerEmail,
    connectionId: selectedConnectionId,
    accountEmail: normalizeEmail(value.accountEmail, 'Calendar account email'),
    identityEmail: normalizeEmail(value.identityEmail, 'Calendar organizer email'),
    calendarId: selectedCalendarId,
    source: value.source,
  }
}

function normalizeReviewedCalendarSelection(
  value: PipelineCommunicationSnapshot,
  actorEmail: string,
): PipelineCommunicationSnapshot {
  if (value?.source !== 'meeting-override') {
    throw new CrmIntegrationActionError(
      'A reviewed per-meeting Google Calendar selection is required',
      400,
      'CRM_CALENDAR_SELECTION_INVALID',
    )
  }
  return normalizeCalendarCommunicationSnapshot(value, actorEmail)
}

function calendarIdentifier(value: unknown, field: string): string {
  const identifier = typeof value === 'string' ? value.trim() : ''
  if (!identifier || identifier.length > 1024 || /[\u0000-\u001f\u007f]/.test(identifier)) {
    throw new PermanentCrmIntegrationActionError(`${field} is invalid`)
  }
  return identifier
}

function normalizeActionType(value: unknown): CrmIntegrationActionType {
  const actionType = cleanString(value, 64, 'CRM action type') as CrmIntegrationActionType
  if (!CRM_INTEGRATION_ACTION_TYPES.includes(actionType)) {
    throw new CrmIntegrationActionError('CRM action type is invalid')
  }
  return actionType
}

function normalizeIdempotencyKey(value: unknown, actionType: CrmIntegrationActionType): string {
  const fallback = `crm:${actionType}:${crypto.randomUUID()}`
  const idempotencyKey = cleanString(value ?? fallback, 255, 'Idempotency key')
  if (!idempotencyKey || /\s/.test(idempotencyKey)) {
    throw new CrmIntegrationActionError('Idempotency key is invalid')
  }
  return idempotencyKey
}

function normalizeClientRequestHash(value: unknown): string {
  const hash = cleanString(value, 64, 'Client request hash').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new CrmIntegrationActionError('Client request hash is invalid')
  }
  return hash
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

/**
 * Hashes the immutable HTTP request intent separately from provider-resolved
 * Calendar metadata. This lets a lost-response retry return the committed
 * action even when a connection is later revoked or an organization default
 * changes, while a reused key with different client intent remains a conflict.
 */
export function crmIntegrationClientRequestHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalJsonValue(value)) ?? 'null'
  return crypto.createHash('sha256')
    .update(serialized)
    .digest('hex')
}

function normalizeTimezone(value: unknown): string {
  const timezone = cleanString(value, 100, 'Calendar timezone') || 'America/New_York'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw new CrmIntegrationActionError('Calendar timezone is invalid')
  }
  return timezone
}

function normalizeDateTime(value: unknown, field: string): string {
  const dateTime = requiredString(value, 64, field)
  if (!Number.isFinite(Date.parse(dateTime))) throw new CrmIntegrationActionError(`${field} is invalid`)
  return dateTime
}

function normalizeCallActivityStatus(value: unknown): CrmActivityStatus {
  const status = cleanString(value, 32, 'Call status').toLowerCase().replace(/[\s-]+/g, '_')
  if (!status) return 'held'
  if (status === 'planned' || status === 'held' || status === 'not_held') return status
  throw new CrmIntegrationActionError('Call status is invalid')
}

function normalizeCallDirection(value: unknown): 'inbound' | 'outbound' {
  const direction = cleanString(value, 32, 'Call direction').toLowerCase()
  if (!direction) return 'outbound'
  if (direction === 'inbound' || direction === 'outbound') return direction
  throw new CrmIntegrationActionError('Call direction is invalid')
}

function normalizeCallDuration(value: unknown): number {
  if (value === undefined || value === null || value === '') return 15
  const duration = Number(value)
  if (!Number.isInteger(duration) || duration < 1 || duration > 24 * 60) {
    throw new CrmIntegrationActionError('Call duration must be a whole number from 1 to 1440 minutes')
  }
  return duration
}

function normalizeEmailList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new CrmIntegrationActionError('Calendar attendees must be a list of no more than 100 emails')
  }
  return Array.from(new Set(value.map((email) => normalizeEmail(email, 'Calendar attendee email'))))
}

function actionView(row: ActionRow): CrmIntegrationActionView {
  const communication = row.workspace_organization_id && row.communication_binding_source
    ? {
        organizationId: row.workspace_organization_id,
        credentialOwnerEmail: row.communication_credential_owner_email,
        connectionId: row.communication_connection_id,
        accountEmail: row.communication_account_email,
        identityEmail: row.communication_identity_email,
        calendarId: row.communication_calendar_id,
        source: row.communication_binding_source,
      }
    : null
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    provider: row.provider,
    app: row.app,
    actionType: row.action_type,
    referenceCode: row.reference_code,
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: iso(row.available_at) as string,
    externalId: row.external_id,
    responseSummary: row.response_summary || {},
    communication,
    lastError: row.last_error,
    processedAt: iso(row.processed_at),
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  }
}

export type CrmIntegrationActionReplay = {
  action: CrmIntegrationActionView
  aggregateId: string
  referenceCode: string | null
}

/**
 * Reads an idempotent action only inside the caller's already-authorized actor
 * and pipeline scope. Rows in another actor or pipeline are intentionally
 * indistinguishable from a missing key.
 */
export async function replayCrmIntegrationActionByIdempotencyKey(input: {
  pipelineId: unknown
  actorEmail: unknown
  idempotencyKey: unknown
  clientRequestHash: unknown
  actionType: unknown
  referenceCode?: unknown
  aggregateType?: unknown
}): Promise<CrmIntegrationActionReplay | null> {
  const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
  let actorEmail: string
  try {
    actorEmail = normalizeUserEmail(input.actorEmail)
  } catch {
    throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
  }
  const actionType = normalizeActionType(input.actionType)
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, actionType)
  const clientRequestHash = normalizeClientRequestHash(input.clientRequestHash)
  const referenceCode = input.referenceCode === undefined
    ? undefined
    : normalizeReference(input.referenceCode)
  const aggregateType = input.aggregateType === undefined
    ? undefined
    : requiredString(input.aggregateType, 100, 'CRM aggregate type')
  const existing = await query<ActionRow>(
    `SELECT * FROM crm_integration_actions
     WHERE actor_email = $1 AND pipeline_id = $2::uuid AND idempotency_key = $3
     LIMIT 1`,
    [actorEmail, pipelineId, idempotencyKey],
  )
  const row = existing.rows[0]
  if (!row) return null

  const storedClientRequestHash = typeof row.payload?._clientRequestHash === 'string'
    ? row.payload._clientRequestHash.toLowerCase()
    : ''
  const runtime = ACTION_RUNTIME[actionType]
  const matchesScopeAndIntent = row.pipeline_id === pipelineId
    && row.actor_email === actorEmail
    && row.provider === runtime.provider
    && row.app === runtime.app
    && row.action_type === actionType
    && (referenceCode === undefined || row.reference_code === referenceCode)
    && (aggregateType === undefined || row.aggregate_type === aggregateType)

  // Legacy actions without an immutable client-intent hash retain the existing
  // lower-level replay path, which can compare the older provider-bound hash.
  if (matchesScopeAndIntent && !storedClientRequestHash) return null
  if (!matchesScopeAndIntent || storedClientRequestHash !== clientRequestHash) {
    throw new CrmIntegrationActionError(
      'Idempotency key was already used for a different CRM action',
      409,
      'CRM_ACTION_IDEMPOTENCY_CONFLICT',
    )
  }
  return {
    action: actionView(row),
    aggregateId: row.aggregate_id,
    referenceCode: row.reference_code,
  }
}

function leasedAction(row: ActionRow): LeasedCrmIntegrationAction {
  if (!row.lock_token) throw new Error('CRM action lease token is missing')
  return {
    ...actionView(row),
    actorEmail: row.actor_email,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload || {},
    lockToken: row.lock_token,
    idempotencyKey: row.idempotency_key,
    communicationCredentialOwnerEmail: row.communication_credential_owner_email,
    communicationConnectionId: row.communication_connection_id,
  }
}

function safeErrorMessage(error: unknown): string {
  const source = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? String((error as { message: string }).message)
      : 'CRM action processing failed'
  const redacted = source
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]')
    .trim()
  return (redacted || 'CRM action processing failed').slice(0, 1000)
}

function boundedProviderValue(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return ''
  return safeErrorMessage(new Error(String(value)))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let remaining = MAX_PROVIDER_ERROR_BYTES
  let text = ''
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
      remaining -= chunk.byteLength
      text += decoder.decode(chunk, { stream: remaining > 0 })
      if (remaining === 0) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

async function providerRequestError(
  app: 'google-mail' | 'google-calendar',
  response: Response,
): Promise<ProviderCrmIntegrationActionError> {
  const raw = await boundedResponseText(response).catch(() => '')
  let payload: JsonObject = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as JsonObject
  } catch {
    // A bounded plain-text provider response is still useful failure evidence.
  }
  const nested = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error as JsonObject
    : {}
  const providerCode = boundedProviderValue(
    nested.status ?? nested.code ?? payload.code ?? response.status,
    MAX_PROVIDER_CODE_LENGTH,
  ) || null
  const providerError = boundedProviderValue(
    nested.message
      ?? (typeof payload.error === 'string' ? payload.error : undefined)
      ?? payload.message
      ?? payload.error_description
      ?? (raw || undefined)
      ?? response.statusText,
    MAX_PROVIDER_ERROR_LENGTH,
  ) || 'Provider rejected the request'
  return new ProviderCrmIntegrationActionError(
    app,
    response.status,
    providerCode,
    providerError,
  )
}

function providerFailureEvidence(error: unknown): JsonObject {
  return error instanceof ProviderCrmIntegrationActionError
    ? {
        providerStatus: error.providerStatus,
        providerCode: error.providerCode,
        providerError: error.providerError,
      }
    : {}
}

function isPermanentProviderFailure(error: unknown): boolean {
  if (!(error instanceof ProviderCrmIntegrationActionError)) return false
  return error.providerStatus >= 400
    && error.providerStatus < 500
    && ![408, 409, 425, 429].includes(error.providerStatus)
}

function safeHttpsUrl(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

async function readCampaignTargets(pipelineId: string, references: string[]): Promise<CampaignTargetRow[]> {
  if (references.length === 0) return []
  const result = await query<CampaignTargetRow>(
    `SELECT 'contacts'::text AS entity, id::text, reference_code, first_name, last_name,
       full_name, email, email_opt_out, organization_id::text, suitecrm_id
     FROM crm_contacts
     WHERE pipeline_id = $1::uuid AND reference_code = ANY($2::text[])
       AND COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
     UNION ALL
     SELECT 'leads'::text AS entity, id::text, reference_code, first_name, last_name,
       full_name, email, email_opt_out, organization_id::text, suitecrm_id
     FROM crm_leads
     WHERE pipeline_id = $1::uuid AND reference_code = ANY($2::text[])
       AND COALESCE(lower(source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')`,
    [pipelineId, references],
  )
  const found = new Set(result.rows.map((row) => row.reference_code))
  if (references.some((reference) => !found.has(reference))) {
    throw new CrmIntegrationActionError('A campaign recipient was not found in the selected pipeline', 404, 'CRM_RECIPIENT_NOT_FOUND')
  }
  return result.rows
}

type PreviousCalendarEventSnapshot = {
  eventId: string
  credentialOwnerEmail: string
  connectionId: string
  calendarId: string
  organizerEmail: string | null
}

function previousCalendarEventSnapshot(target: CrmReferenceRecord): PreviousCalendarEventSnapshot | null {
  if (target.entity !== 'meetings' || !target.externalEventId) return null
  const source = target.sourcePayload && typeof target.sourcePayload === 'object'
    && !Array.isArray(target.sourcePayload)
    ? target.sourcePayload
    : {}
  const credentialOwnerEmail = typeof source.calendarOwnerEmail === 'string'
    ? source.calendarOwnerEmail.trim()
    : ''
  const connectionId = typeof source.calendarConnectionId === 'string'
    ? source.calendarConnectionId.trim()
    : ''
  const calendarId = typeof source.calendarId === 'string' ? source.calendarId.trim() : ''
  if (!credentialOwnerEmail || !connectionId || !calendarId) return null
  return {
    eventId: requiredString(target.externalEventId, 1000, 'Existing Calendar event ID'),
    credentialOwnerEmail: normalizeEmail(credentialOwnerEmail, 'Existing Calendar credential owner'),
    connectionId: requiredString(connectionId, 512, 'Existing Calendar connection ID'),
    calendarId: cleanString(calendarId, 1024, 'Existing Calendar ID'),
    organizerEmail: typeof source.calendarOrganizerEmail === 'string' && source.calendarOrganizerEmail.trim()
      ? normalizeEmail(source.calendarOrganizerEmail, 'Existing Calendar organizer')
      : null,
  }
}

function normalizeCalendarPayload(
  value: unknown,
  target?: CrmReferenceRecord,
): JsonObject {
  const payload = objectValue(value)
  assertOnlyFields(payload, [
    'subject', 'title', 'description', 'startsAt', 'start', 'endsAt', 'end',
    'timezone', 'location', 'attendeeEmails', 'meetingStatus', 'meetingMode',
    'customJoinUrl',
  ])
  if (target?.entity === 'interactions' || target?.entity === 'campaigns') {
    throw new CrmIntegrationActionError('Calendar actions cannot target this CRM record type')
  }
  const subject = requiredString(payload.subject ?? payload.title, 300, 'Calendar event subject')
  const timezone = normalizeTimezone(payload.timezone)
  const startsAt = zonedDateTimeToIso(payload.startsAt ?? payload.start, timezone)
  const endsAt = zonedDateTimeToIso(payload.endsAt ?? payload.end, timezone)
  if (!startsAt) throw new CrmIntegrationActionError('Calendar event start is invalid for the selected timezone')
  if (!endsAt) throw new CrmIntegrationActionError('Calendar event end is invalid for the selected timezone')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new CrmIntegrationActionError('Calendar event end must be after its start')
  }
  const attendeeEmails = normalizeEmailList(payload.attendeeEmails)
  if (target?.email && EMAIL_PATTERN.test(target.email)) attendeeEmails.unshift(target.email.toLowerCase())
  const meetingStatus = normalizeMeetingStatus(payload.meetingStatus)
  const meetingMode = normalizeMeetingMode(payload.meetingMode)
  const location = cleanString(payload.location, 1000, 'Calendar event location')
  const customJoinUrl = safeHttpsUrl(payload.customJoinUrl)
  if (meetingMode === 'in_person' && !location) {
    throw new CrmIntegrationActionError('An in-person meeting requires a location')
  }
  if (meetingMode === 'custom_link' && !customJoinUrl) {
    throw new CrmIntegrationActionError('A custom-link meeting requires a valid HTTPS meeting URL')
  }
  const previousCalendar = target ? previousCalendarEventSnapshot(target) : null
  return {
    subject,
    description: cleanString(payload.description, 50_000, 'Calendar event description'),
    startsAt,
    endsAt,
    timezone,
    location,
    attendeeEmails: Array.from(new Set(attendeeEmails)),
    meetingStatus,
    meetingMode,
    customJoinUrl,
    ...(previousCalendar ? { previousCalendar } : {}),
  }
}

function calendarActionRequestHash(input: {
  pipelineId: string
  actorEmail: string
  referenceCode: string
  payload: unknown
  communicationOverride?: PipelineCommunicationSnapshot
}) {
  const communicationOverride = input.communicationOverride === undefined
    ? null
    : normalizeReviewedCalendarSelection(input.communicationOverride, input.actorEmail)
  return crypto.createHash('sha256').update(JSON.stringify({
    pipelineId: input.pipelineId,
    actorEmail: input.actorEmail,
    actionType: 'create_calendar_event',
    referenceCode: input.referenceCode,
    payload: normalizeCalendarPayload(input.payload),
    communicationOverride,
  })).digest('hex')
}

function existingCalendarActionMatchesRequest(input: {
  row: ActionRow
  pipelineId: string
  actorEmail: string
  referenceCode: string
  requestHash: string
}) {
  return input.row.pipeline_id === input.pipelineId
    && input.row.actor_email === input.actorEmail
    && input.row.provider === ACTION_RUNTIME.create_calendar_event.provider
    && input.row.app === ACTION_RUNTIME.create_calendar_event.app
    && input.row.action_type === 'create_calendar_event'
    && input.row.reference_code === input.referenceCode
    && input.row.payload?._requestHash === input.requestHash
}

async function normalizePayload(
  actionType: CrmIntegrationActionType,
  value: unknown,
  target: CrmReferenceRecord,
  pipelineId: string,
): Promise<JsonObject> {
  const payload = objectValue(value)

  if (actionType === 'send_email') {
    assertOnlyFields(payload, ['subject', 'text', 'body', 'html'])
    if (target.entity !== 'organizations' && target.entity !== 'contacts' && target.entity !== 'leads') {
      throw new CrmIntegrationActionError('Email actions require an organization, contact, or lead reference')
    }
    if (!target.email) throw new CrmIntegrationActionError('The referenced CRM record has no email address')
    normalizeEmail(target.email, 'CRM recipient email')
    if (target.emailOptOut) throw new CrmIntegrationActionError('The referenced CRM record is suppressed from email')
    const subject = requiredString(payload.subject, 300, 'Email subject')
    const text = requiredString(payload.text ?? payload.body, 100_000, 'Email body')
    const html = cleanString(payload.html, 100_000, 'Email HTML body')
    return {
      subject,
      text,
      recipientEmail: normalizeEmail(target.email, 'CRM recipient email'),
      ...(html ? { html } : {}),
    }
  }

  if (actionType === 'create_calendar_event') {
    return normalizeCalendarPayload(payload, target)
  }

  if (actionType === 'log_call') {
    assertOnlyFields(payload, ['subject', 'notes', 'activityStatus', 'durationMinutes', 'direction'])
    if (!target.phone) throw new CrmIntegrationActionError('The referenced CRM record has no phone number')
    return {
      subject: cleanString(payload.subject, 300, 'Call subject') || `Call ${target.name || target.referenceCode}`,
      notes: cleanString(payload.notes, 50_000, 'Call notes'),
      activityStatus: normalizeCallActivityStatus(payload.activityStatus),
      durationMinutes: normalizeCallDuration(payload.durationMinutes),
      direction: normalizeCallDirection(payload.direction),
    }
  }

  assertOnlyFields(payload, ['recipientReferences', 'subject', 'text', 'body', 'html'])
  if (target.entity !== 'campaigns') {
    throw new CrmIntegrationActionError('Campaign actions require a campaign reference')
  }
  if (!Array.isArray(payload.recipientReferences) || payload.recipientReferences.length === 0) {
    throw new CrmIntegrationActionError('Campaign recipient references are required')
  }
  if (payload.recipientReferences.length > MAX_CAMPAIGN_RECIPIENTS) {
    throw new CrmIntegrationActionError(`Campaigns support no more than ${MAX_CAMPAIGN_RECIPIENTS} recipient references per action`)
  }
  const requestedRecipientReferences = payload.recipientReferences.map((value) => {
    const reference = normalizeReference(value)
    if (!CAMPAIGN_RECIPIENT_PATTERN.test(reference)) {
      throw new CrmIntegrationActionError('Campaign recipients must be gc or gl references')
    }
    return reference
  })
  const recipientReferences = Array.from(new Set(await Promise.all(
    requestedRecipientReferences.map(resolveCrmReferenceCode),
  )))
  await readCampaignTargets(pipelineId, recipientReferences)
  const campaign = await query<{ name: string; subject_template: string | null; body_template: string | null }>(
    `SELECT name, subject_template, body_template
     FROM crm_campaigns WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [pipelineId, target.id],
  )
  const campaignRow = campaign.rows[0]
  if (!campaignRow) throw new CrmIntegrationActionError('CRM campaign was not found', 404, 'CRM_CAMPAIGN_NOT_FOUND')
  const subject = requiredString(payload.subject ?? campaignRow.subject_template, 300, 'Campaign subject')
  const text = requiredString(payload.text ?? payload.body ?? campaignRow.body_template, 100_000, 'Campaign body')
  const html = cleanString(payload.html, 100_000, 'Campaign HTML body')
  return { recipientReferences, subject, text, ...(html ? { html } : {}) }
}

async function prepareAction(input: {
  pipelineId: unknown
  actorEmail: unknown
  actionType: unknown
  referenceCode: unknown
  payload?: unknown
  idempotencyKey?: unknown
  communicationOverride?: PipelineCommunicationSnapshot
}): Promise<PreparedAction> {
  const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
  let actorEmail: string
  try {
    actorEmail = normalizeUserEmail(input.actorEmail)
  } catch {
    throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
  }
  const actionType = normalizeActionType(input.actionType)
  const referenceCode = normalizeReference(input.referenceCode)
  let target: CrmReferenceRecord
  try {
    target = await readCrmRecordByReference({ pipelineId, referenceCode })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/not found/i.test(message)) {
      throw new CrmIntegrationActionError('CRM record was not found in the selected pipeline', 404, 'CRM_RECORD_NOT_FOUND')
    }
    if (/reference is invalid/i.test(message)) throw new CrmIntegrationActionError('CRM reference is invalid')
    throw error
  }
  const runtime = ACTION_RUNTIME[actionType]
  const communicationApp = actionType === 'send_campaign'
    ? 'google-mail'
    : runtime.provider === 'maton'
      ? runtime.app as 'google-mail' | 'google-calendar'
      : null
  if (input.communicationOverride !== undefined && actionType !== 'create_calendar_event') {
    throw new CrmIntegrationActionError(
      'Per-meeting Calendar selection is only supported for Calendar event actions',
      400,
      'CRM_CALENDAR_SELECTION_INVALID',
    )
  }
  let communication: PipelineCommunicationSnapshot | null = null
  if (communicationApp) {
    if (input.communicationOverride !== undefined) {
      communication = normalizeReviewedCalendarSelection(input.communicationOverride, actorEmail)
    } else {
      try {
        communication = await resolvePipelineCommunicationSnapshotInPostgres({
          pipelineId,
          actorEmail,
          app: communicationApp,
        })
      } catch (error) {
        if (
          error instanceof OrganizationCommunicationPersistenceError
          && error.code === 'ORGANIZATION_COMMUNICATION_CONNECTION_REQUIRED'
        ) {
          throw new CrmIntegrationActionError(
            `Configure an active ${communicationApp === 'google-mail' ? 'Gmail' : 'Google Calendar'} connection for this organization`,
            409,
            'CRM_COMMUNICATION_CONNECTION_REQUIRED',
          )
        }
        throw error
      }
    }
    if (communicationApp === 'google-calendar' && communication) {
      communication = normalizeCalendarCommunicationSnapshot(communication, actorEmail)
    }
  }
  return {
    pipelineId,
    actorEmail,
    provider: runtime.provider,
    app: runtime.app,
    actionType,
    aggregateType: AGGREGATE_TYPES[target.entity],
    aggregateId: target.id,
    referenceCode: target.referenceCode,
    payload: await normalizePayload(actionType, input.payload, target, pipelineId),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey, actionType),
    communication,
  }
}

async function auditAction(
  client: PoolClient,
  action: Pick<PreparedAction, 'actorEmail' | 'aggregateType' | 'aggregateId' | 'pipelineId' | 'actionType' | 'referenceCode' | 'provider' | 'app'> & { id: string },
  eventType: string,
  detail: JsonObject = {},
) {
  await client.query(
    `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      action.actorEmail,
      eventType,
      action.aggregateType,
      action.aggregateId,
      JSON.stringify({
        actionId: action.id,
        pipelineId: action.pipelineId,
        actionType: action.actionType,
        referenceCode: action.referenceCode,
        provider: action.provider,
        app: action.app,
        ...detail,
      }),
    ],
  )
}

async function insertPreparedAction(client: PoolClient, action: PreparedAction): Promise<{
  action: CrmIntegrationActionView
  created: boolean
}> {
  const result = await client.query<InsertedActionRow>(
    `WITH inserted AS (
       INSERT INTO crm_integration_actions (
         pipeline_id, actor_email, provider, app, action_type, aggregate_type,
         aggregate_id, reference_code, payload, status, idempotency_key,
         workspace_organization_id, communication_credential_owner_email,
         communication_connection_id, communication_account_email,
         communication_identity_email, communication_calendar_id,
         communication_binding_source,
         created_at, available_at, updated_at
       )
       VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued', $10,
         $11::uuid, $12, $13, $14, $15, $16, $17,
         now(), now(), now()
       )
       ON CONFLICT (actor_email, idempotency_key) DO NOTHING
       RETURNING *
     )
     SELECT inserted.*, true AS created, true AS matches_intent FROM inserted
     UNION ALL
     SELECT existing.*, false AS created,
       (existing.pipeline_id = $1::uuid
        AND existing.provider IS NOT DISTINCT FROM $3
        AND existing.app = $4
        AND existing.action_type = $5
        AND existing.aggregate_type = $6
        AND existing.aggregate_id = $7
        AND existing.reference_code IS NOT DISTINCT FROM $8
        AND (
          (
            existing.payload = $9::jsonb
            AND existing.workspace_organization_id IS NOT DISTINCT FROM $11::uuid
            AND existing.communication_credential_owner_email IS NOT DISTINCT FROM $12
            AND existing.communication_connection_id IS NOT DISTINCT FROM $13
            AND existing.communication_account_email IS NOT DISTINCT FROM $14
            AND existing.communication_identity_email IS NOT DISTINCT FROM $15
            AND existing.communication_calendar_id IS NOT DISTINCT FROM $16
            AND existing.communication_binding_source IS NOT DISTINCT FROM $17
          )
          OR (
            $5 = 'create_calendar_event'
            AND COALESCE(existing.payload->>'_requestHash', '') <> ''
            AND existing.payload->>'_requestHash' = ($9::jsonb)->>'_requestHash'
          )
        )) AS matches_intent
     FROM crm_integration_actions existing
     WHERE existing.actor_email = $2 AND existing.idempotency_key = $10
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      action.pipelineId,
      action.actorEmail,
      action.provider,
      action.app,
      action.actionType,
      action.aggregateType,
      action.aggregateId,
      action.referenceCode,
      JSON.stringify(action.payload),
      action.idempotencyKey,
      action.communication?.organizationId || null,
      action.communication?.credentialOwnerEmail || null,
      action.communication?.connectionId || null,
      action.communication?.accountEmail || null,
      action.communication?.identityEmail || null,
      action.communication?.calendarId || null,
      action.communication?.source || null,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('CRM action could not be queued')
  if (!row.matches_intent) {
    throw new CrmIntegrationActionError(
      'Idempotency key was already used for a different CRM action',
      409,
      'CRM_ACTION_IDEMPOTENCY_CONFLICT',
    )
  }
  if (row.created) {
    await auditAction(client, { ...action, id: row.id }, 'crm.integration_action.queued', {
      communicationOrganizationId: action.communication?.organizationId || null,
      communicationAccountEmail: action.communication?.accountEmail || null,
      communicationIdentityEmail: action.communication?.identityEmail || null,
      communicationCalendarId: action.communication?.calendarId || null,
      communicationBindingSource: action.communication?.source || null,
    })
  }
  return { action: actionView(row), created: row.created }
}

type StageMeetingInput = Extract<StageCrmRecordInput, { entity: 'meetings' }>

function normalizedPreviousCalendarSnapshot(value: unknown): PreviousCalendarEventSnapshot | null {
  if (value === undefined || value === null) return null
  const snapshot = objectValue(value, 'Previous Calendar event snapshot')
  assertOnlyFields(snapshot, [
    'eventId', 'credentialOwnerEmail', 'connectionId', 'calendarId', 'organizerEmail',
  ])
  const connectionId = requiredString(snapshot.connectionId, 512, 'Previous Calendar connection ID')
  if (!/^[\x21-\x7e]+$/.test(connectionId)) {
    throw new CrmIntegrationActionError('Previous Calendar connection ID is invalid')
  }
  const calendarId = cleanString(snapshot.calendarId, 1024, 'Previous Calendar ID')
  if (!calendarId) throw new CrmIntegrationActionError('Previous Calendar ID is required')
  return {
    eventId: requiredString(snapshot.eventId, 1000, 'Previous Calendar event ID'),
    credentialOwnerEmail: normalizeEmail(snapshot.credentialOwnerEmail, 'Previous Calendar credential owner'),
    connectionId,
    calendarId,
    organizerEmail: snapshot.organizerEmail
      ? normalizeEmail(snapshot.organizerEmail, 'Previous Calendar organizer')
      : null,
  }
}

function meetingSaveRequestHash(input: {
  stageInput: StageMeetingInput
  payload: JsonObject
  communication: PipelineCommunicationSnapshot
}) {
  const requestedPayload = { ...input.payload }
  delete requestedPayload.previousCalendar
  delete requestedPayload._requestHash
  delete requestedPayload._clientRequestHash
  return crypto.createHash('sha256').update(JSON.stringify({
    pipelineId: input.stageInput.pipelineId,
    actorEmail: input.stageInput.actorEmail,
    localId: input.stageInput.localId || null,
    sourceKey: input.stageInput.sourceKey,
    fields: input.stageInput.fields,
    payload: requestedPayload,
    communication: input.communication,
  })).digest('hex')
}

function existingMeetingActionMatches(input: {
  row: ActionRow
  pipelineId: string
  actorEmail: string
  localId: string | null
  requestHash: string
  communication: PipelineCommunicationSnapshot
}) {
  const rowHash = typeof input.row.payload?._requestHash === 'string'
    ? input.row.payload._requestHash
    : ''
  return input.row.pipeline_id === input.pipelineId
    && input.row.actor_email === input.actorEmail
    && input.row.action_type === 'create_calendar_event'
    && input.row.aggregate_type === 'crm_meeting'
    && (!input.localId || input.row.aggregate_id === input.localId)
    && rowHash === input.requestHash
    && input.row.workspace_organization_id === input.communication.organizationId
    && input.row.communication_credential_owner_email === input.communication.credentialOwnerEmail
    && input.row.communication_connection_id === input.communication.connectionId
    && input.row.communication_account_email === input.communication.accountEmail
    && input.row.communication_identity_email === input.communication.identityEmail
    && input.row.communication_calendar_id === input.communication.calendarId
    && input.row.communication_binding_source === input.communication.source
}

/**
 * Persists the app-owned meeting, SuiteCRM outbox record, and Calendar action in
 * one database transaction. A client-generated key is mandatory so a retry
 * after a lost HTTP response returns the same meeting/action without restaging
 * a meeting that a worker may already have delivered.
 */
export async function stageCrmMeetingAndEnqueueCalendarAction(input: {
  stageInput: StageMeetingInput
  payload: unknown
  idempotencyKey: unknown
  clientRequestHash?: unknown
  communication: PipelineCommunicationSnapshot
  previousCalendar?: unknown
}) {
  if (input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === '') {
    throw new CrmIntegrationActionError(
      'Meeting save idempotency key is required',
      400,
      'CRM_MEETING_IDEMPOTENCY_REQUIRED',
    )
  }
  const pipelineId = normalizeUuid(input.stageInput.pipelineId, 'Pipeline ID')
  let actorEmail: string
  try {
    actorEmail = normalizeUserEmail(input.stageInput.actorEmail)
  } catch {
    throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, 'create_calendar_event')
  const communication = normalizeCalendarCommunicationSnapshot(input.communication, actorEmail)
  const previousCalendar = normalizedPreviousCalendarSnapshot(input.previousCalendar)
  const normalizedPayload = normalizeCalendarPayload(input.payload)
  const payload: JsonObject = {
    ...normalizedPayload,
    ...(previousCalendar ? { previousCalendar } : {}),
  }
  const stageInput: StageMeetingInput = {
    ...input.stageInput,
    pipelineId,
    actorEmail,
  }
  const requestHash = meetingSaveRequestHash({ stageInput, payload, communication })
  payload._requestHash = requestHash
  if (input.clientRequestHash !== undefined) {
    payload._clientRequestHash = normalizeClientRequestHash(input.clientRequestHash)
  }

  const transactionResult = await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`crm-meeting-save:${actorEmail}:${idempotencyKey}`],
    )
    const existing = await client.query<ActionRow>(
      `SELECT * FROM crm_integration_actions
       WHERE actor_email = $1 AND idempotency_key = $2
       LIMIT 1
       FOR UPDATE`,
      [actorEmail, idempotencyKey],
    )
    if (existing.rows[0]) {
      if (!existingMeetingActionMatches({
        row: existing.rows[0],
        pipelineId,
        actorEmail,
        localId: stageInput.localId || null,
        requestHash,
        communication,
      })) {
        throw new CrmIntegrationActionError(
          'Idempotency key was already used for a different CRM meeting save',
          409,
          'CRM_ACTION_IDEMPOTENCY_CONFLICT',
        )
      }
      const existingMeeting = await client.query<{
        id: string
        suitecrm_id: string
        reference_code: string
        source_hash: string
      }>(
        `SELECT id::text, suitecrm_id, reference_code, source_hash
         FROM crm_meetings
         WHERE pipeline_id = $1::uuid AND id = $2::uuid
         LIMIT 1`,
        [pipelineId, existing.rows[0].aggregate_id],
      )
      if (!existingMeeting.rows[0]) {
        throw new Error('Idempotent CRM meeting action has no persisted meeting')
      }
      return {
        action: actionView(existing.rows[0]),
        created: false,
        staged: existingMeeting.rows[0],
        reused: true as const,
      }
    }

    const staged = await stageCrmRecordWithClient(client, stageInput)
    const inserted = await insertPreparedAction(client, {
      pipelineId,
      actorEmail,
      provider: ACTION_RUNTIME.create_calendar_event.provider,
      app: ACTION_RUNTIME.create_calendar_event.app,
      actionType: 'create_calendar_event',
      aggregateType: 'crm_meeting',
      aggregateId: staged.id,
      referenceCode: staged.referenceCode,
      payload,
      idempotencyKey,
      communication,
    })
    return { ...inserted, staged, reused: false as const }
  })

  if (!transactionResult.reused) return transactionResult
  const current = await readCrmRecordByReference({
    pipelineId,
    referenceCode: transactionResult.staged.reference_code,
  })
  return {
    action: transactionResult.action,
    created: false,
    reused: true as const,
    staged: {
      id: transactionResult.staged.id,
      suiteCrmId: transactionResult.staged.suitecrm_id,
      referenceCode: transactionResult.staged.reference_code,
      shortUrl: current.shortUrl,
      sourceHash: transactionResult.staged.source_hash,
    },
  }
}

export async function replayCrmMeetingSaveByIdempotencyKey(input: {
  pipelineId: unknown
  actorEmail: unknown
  idempotencyKey: unknown
  clientRequestHash: unknown
}) {
  const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
  const replay = await replayCrmIntegrationActionByIdempotencyKey({
    pipelineId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    clientRequestHash: input.clientRequestHash,
    actionType: 'create_calendar_event',
    aggregateType: 'crm_meeting',
  })
  if (!replay) return null
  if (!replay.referenceCode) {
    throw new Error('Idempotent CRM meeting action has no persisted meeting reference')
  }
  const meeting = await query<{
    id: string
    suitecrm_id: string
    reference_code: string
    source_hash: string
  }>(
    `SELECT id::text, suitecrm_id, reference_code, source_hash
     FROM crm_meetings
     WHERE pipeline_id = $1::uuid AND id = $2::uuid
     LIMIT 1`,
    [pipelineId, replay.aggregateId],
  )
  if (!meeting.rows[0]) throw new Error('Idempotent CRM meeting action has no persisted meeting')
  const current = await readCrmRecordByReference({
    pipelineId,
    referenceCode: meeting.rows[0].reference_code,
  })
  return {
    action: replay.action,
    created: false,
    reused: true as const,
    staged: {
      id: meeting.rows[0].id,
      suiteCrmId: meeting.rows[0].suitecrm_id,
      referenceCode: meeting.rows[0].reference_code,
      shortUrl: current.shortUrl,
      sourceHash: meeting.rows[0].source_hash,
    },
  }
}

export async function enqueueCrmIntegrationAction(input: {
  pipelineId: unknown
  actorEmail: unknown
  actionType: unknown
  referenceCode: unknown
  payload?: unknown
  idempotencyKey?: unknown
  clientRequestHash?: unknown
  communicationOverride?: PipelineCommunicationSnapshot
}) {
  const actionType = normalizeActionType(input.actionType)
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, actionType)
  const preparedInput = { ...input, actionType, idempotencyKey }
  let requestHash: string | null = null
  if (actionType === 'create_calendar_event') {
    const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
    let actorEmail: string
    try {
      actorEmail = normalizeUserEmail(input.actorEmail)
    } catch {
      throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
    }
    const referenceCode = normalizeReference(input.referenceCode)
    requestHash = calendarActionRequestHash({
      pipelineId,
      actorEmail,
      referenceCode,
      payload: input.payload,
      communicationOverride: input.communicationOverride,
    })
    const existing = await query<ActionRow>(
      `SELECT * FROM crm_integration_actions
       WHERE actor_email = $1 AND idempotency_key = $2
       LIMIT 1`,
      [actorEmail, idempotencyKey],
    )
    if (existing.rows[0]) {
      if (!existingCalendarActionMatchesRequest({
        row: existing.rows[0],
        pipelineId,
        actorEmail,
        referenceCode,
        requestHash,
      })) {
        throw new CrmIntegrationActionError(
          'Idempotency key was already used for a different CRM action',
          409,
          'CRM_ACTION_IDEMPOTENCY_CONFLICT',
        )
      }
      return { action: actionView(existing.rows[0]), created: false }
    }
  }
  const action = await prepareAction(preparedInput)
  if (requestHash) action.payload._requestHash = requestHash
  if (input.clientRequestHash !== undefined) {
    action.payload._clientRequestHash = normalizeClientRequestHash(input.clientRequestHash)
  }
  return withTransaction((client) => insertPreparedAction(client, action))
}

export async function readCrmIntegrationAction(input: {
  actionId: unknown
  pipelineId: unknown
  actorEmail: unknown
}): Promise<CrmIntegrationActionView> {
  const actionId = normalizeUuid(input.actionId, 'CRM action ID')
  const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
  let actorEmail: string
  try {
    actorEmail = normalizeUserEmail(input.actorEmail)
  } catch {
    throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
  }
  const result = await query<ActionRow>(
    `SELECT * FROM crm_integration_actions
     WHERE id = $1::uuid AND pipeline_id = $2::uuid AND actor_email = $3
     LIMIT 1`,
    [actionId, pipelineId, actorEmail],
  )
  if (!result.rows[0]) {
    throw new CrmIntegrationActionError('CRM action was not found', 404, 'CRM_ACTION_NOT_FOUND')
  }
  return actionView(result.rows[0])
}

export async function leaseCrmIntegrationActions(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
  actionId?: unknown
  pipelineId?: unknown
  actorEmail?: unknown
} = {}): Promise<LeasedCrmIntegrationAction[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 10), 25))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 20))
  const leaseSeconds = Math.max(30, Math.min(Math.trunc(Number(input.leaseSeconds) || 120), 900))
  const actionId = input.actionId === undefined ? null : normalizeUuid(input.actionId, 'CRM action ID')
  const pipelineId = input.pipelineId === undefined ? null : normalizeUuid(input.pipelineId, 'Pipeline ID')
  let actorEmail: string | null = null
  if (input.actorEmail !== undefined) {
    try {
      actorEmail = normalizeUserEmail(input.actorEmail)
    } catch {
      throw new CrmIntegrationActionError('A valid signed-in user is required', 401, 'UNAUTHORIZED')
    }
  }
  const lockToken = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      `WITH stale AS (
         UPDATE crm_integration_actions action
         SET status = CASE WHEN action.attempts >= $1 THEN 'dead' ELSE 'failed' END,
             last_error = 'CRM action lease expired',
             available_at = now(),
             processed_at = CASE WHEN action.attempts >= $1 THEN now() ELSE NULL END,
             locked_at = NULL,
             lock_token = NULL,
             updated_at = now()
         WHERE action.status = 'processing'
           AND (action.locked_at IS NULL OR action.locked_at < now() - ($2::text || ' seconds')::interval)
           AND ($3::uuid IS NULL OR action.id = $3::uuid)
           AND ($4::uuid IS NULL OR action.pipeline_id = $4::uuid)
           AND ($5::text IS NULL OR action.actor_email = $5)
         RETURNING action.id, action.actor_email, action.aggregate_type, action.aggregate_id,
           action.pipeline_id, action.action_type, action.reference_code, action.provider,
           action.app, action.attempts, action.status
       ), finished_attempts AS (
         UPDATE crm_integration_action_attempts attempt
         SET status = 'failed', error = 'CRM action lease expired', finished_at = now()
         FROM stale
         WHERE attempt.action_id = stale.id
           AND attempt.attempt_number = stale.attempts
           AND attempt.status = 'started'
         RETURNING attempt.action_id
       )
       INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       SELECT stale.actor_email, 'crm.integration_action.' || stale.status,
         stale.aggregate_type, stale.aggregate_id,
         jsonb_build_object(
           'actionId', stale.id, 'pipelineId', stale.pipeline_id,
           'actionType', stale.action_type, 'referenceCode', stale.reference_code,
           'provider', stale.provider, 'app', stale.app, 'attempts', stale.attempts,
           'reason', 'lease_expired'
         )
       FROM stale`,
      [maxAttempts, leaseSeconds, actionId, pipelineId, actorEmail],
    )

    const claimed = await client.query<ActionRow>(
      `WITH candidates AS (
         SELECT id
         FROM crm_integration_actions
         WHERE status IN ('queued', 'failed')
           AND attempts < GREATEST(
             $2,
             CASE
               WHEN response_summary #>> '{operatorRetry,authorizedThroughAttempt}' ~ '^[0-9]+$'
                 THEN (response_summary #>> '{operatorRetry,authorizedThroughAttempt}')::integer
               ELSE 0
             END
           )
           AND available_at <= now()
           AND ($4::uuid IS NULL OR id = $4::uuid)
           AND ($5::uuid IS NULL OR pipeline_id = $5::uuid)
           AND ($6::text IS NULL OR actor_email = $6)
         ORDER BY available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE crm_integration_actions action
       SET status = 'processing',
           attempts = action.attempts + 1,
           locked_at = now(),
           lock_token = $3,
           updated_at = now()
       FROM candidates
       WHERE action.id = candidates.id
       RETURNING action.*`,
      [limit, maxAttempts, lockToken, actionId, pipelineId, actorEmail],
    )
    if (claimed.rows.length === 0) return []

    await client.query(
      `INSERT INTO crm_integration_action_attempts (
         action_id, attempt_number, provider, status, started_at
       )
       SELECT item.id::uuid, item.attempts, item.provider, 'started', now()
       FROM jsonb_to_recordset($1::jsonb) AS item(id text, attempts integer, provider text)
       ON CONFLICT (action_id, attempt_number) DO NOTHING`,
      [JSON.stringify(claimed.rows.map((row) => ({
        id: row.id,
        attempts: row.attempts,
        provider: row.provider || 'internal',
      })))],
    )
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       SELECT item.actor_email, 'crm.integration_action.leased', item.aggregate_type, item.aggregate_id,
         jsonb_build_object(
           'actionId', item.id, 'pipelineId', item.pipeline_id,
           'actionType', item.action_type, 'referenceCode', item.reference_code,
           'provider', item.provider, 'app', item.app, 'attempts', item.attempts
         )
       FROM jsonb_to_recordset($1::jsonb) AS item(
         id text, actor_email text, aggregate_type text, aggregate_id text,
         pipeline_id text, action_type text, reference_code text, provider text,
         app text, attempts integer
       )`,
      [JSON.stringify(claimed.rows.map((row) => ({
        id: row.id,
        actor_email: row.actor_email,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        pipeline_id: row.pipeline_id,
        action_type: row.action_type,
        reference_code: row.reference_code,
        provider: row.provider || 'internal',
        app: row.app,
        attempts: row.attempts,
      })))],
    )
    return claimed.rows.map(leasedAction)
  })
}

async function bindAttemptConnection(action: LeasedCrmIntegrationAction, connectionId: string) {
  const result = await query(
    `UPDATE crm_integration_action_attempts attempt
     SET connection_id = $4
     WHERE attempt.action_id = $1::uuid AND attempt.attempt_number = $2
       AND attempt.status = 'started'
       AND EXISTS (
         SELECT 1 FROM crm_integration_actions action
         WHERE action.id = attempt.action_id AND action.status = 'processing' AND action.lock_token = $3
       )`,
    [action.id, action.attempts, action.lockToken, connectionId],
  )
  if (result.rowCount !== 1) throw new Error('CRM action lease was lost')
}

function sameCommunicationSnapshot(
  left: PipelineCommunicationSnapshot,
  right: NonNullable<LeasedCrmIntegrationAction['communication']>,
) {
  return left.organizationId === right.organizationId
    && left.credentialOwnerEmail === right.credentialOwnerEmail
    && left.connectionId === right.connectionId
    && left.accountEmail === right.accountEmail
    && left.identityEmail === right.identityEmail
    && left.calendarId === right.calendarId
    && left.source === right.source
}

async function assertQueuedCommunicationAuthorization(
  action: LeasedCrmIntegrationAction,
  app: 'google-mail' | 'google-calendar',
) {
  if (!action.communication) {
    throw new PermanentCrmIntegrationActionError(
      'The queued communication action has no reviewed identity snapshot; create a new action',
    )
  }
  let scope: { organizationId: string }
  try {
    scope = await resolvePipelineCommunicationScopeInPostgres({
      pipelineId: action.pipelineId,
      actorEmail: action.actorEmail,
    })
  } catch {
    throw new PermanentCrmIntegrationActionError(
      'The queued communication actor is no longer authorized for this organization',
    )
  }
  if (scope.organizationId !== action.communication.organizationId) {
    throw new PermanentCrmIntegrationActionError(
      'The queued communication organization no longer matches the selected pipeline',
    )
  }
  if (action.communication.source === 'organization') {
    let active: PipelineCommunicationSnapshot
    try {
      active = await resolvePipelineCommunicationSnapshotInPostgres({
        pipelineId: action.pipelineId,
        actorEmail: action.actorEmail,
        app,
      })
    } catch {
      throw new PermanentCrmIntegrationActionError(
        'The queued organization communication identity is no longer active',
      )
    }
    if (!sameCommunicationSnapshot(active, action.communication)) {
      throw new PermanentCrmIntegrationActionError(
        'The queued organization communication identity no longer matches the active binding',
      )
    }
  } else if (action.communication.credentialOwnerEmail !== action.actorEmail) {
    throw new PermanentCrmIntegrationActionError(
      'The queued personal communication identity must belong to the action actor',
    )
  }
}

async function selectedMatonConnection(
  action: LeasedCrmIntegrationAction,
  app: string,
): Promise<{
  credentialOwnerEmail: string
  connectionId: string
  accountEmail: string | null
  identityEmail: string | null
  calendarId: string | null
  bindingSource: 'organization' | 'user-default' | 'meeting-override' | null
}> {
  if (
    !action.communicationCredentialOwnerEmail
    || !action.communicationConnectionId
    || !action.communication
    || !action.communication.organizationId
    || !action.communication.accountEmail
    || !action.communication.identityEmail
    || !action.communication.source
  ) {
    throw new PermanentCrmIntegrationActionError(
      'The queued communication action has no reviewed identity snapshot; create a new action',
    )
  }
  if (app === 'google-calendar' && !action.communication.calendarId) {
    throw new PermanentCrmIntegrationActionError(
      'The queued Calendar action has no reviewed calendar snapshot; create a new action',
    )
  }
  if (app !== 'google-mail' && app !== 'google-calendar') {
    throw new PermanentCrmIntegrationActionError('The queued communication provider is not supported')
  }
  await assertQueuedCommunicationAuthorization(action, app)
  const credentialOwnerEmail = action.communicationCredentialOwnerEmail
  const { connectionId, accountEmail } = await resolveUserMatonGatewayCredential({
    ownerEmail: credentialOwnerEmail,
    app,
    boundConnectionId: action.communicationConnectionId,
  })
  if (connectionId !== action.communicationConnectionId) {
    throw new PermanentCrmIntegrationActionError('The queued communication connection no longer matches its reviewed identity')
  }
  if (
    action.communication?.accountEmail
    && accountEmail
    && normalizeEmail(accountEmail, 'Selected provider account') !== action.communication.accountEmail
  ) {
    throw new PermanentCrmIntegrationActionError('The queued communication account no longer matches its reviewed identity')
  }
  await bindAttemptConnection(action, connectionId)
  return {
    credentialOwnerEmail,
    connectionId,
    accountEmail: action.communication?.accountEmail || accountEmail,
    identityEmail: action.communication?.identityEmail || accountEmail,
    calendarId: action.communication?.calendarId || null,
    bindingSource: action.communication?.source || null,
  }
}

async function verifiedCalendarConnection(
  action: LeasedCrmIntegrationAction,
  selectedConnection: Awaited<ReturnType<typeof selectedMatonConnection>>,
): Promise<{
  organizerEmail: string
  calendarId: string
  calendarSummary: string
  accessRole: 'owner' | 'writer'
}> {
  const requestedCalendarId = calendarIdentifier(selectedConnection.calendarId, 'Queued Calendar ID')
  const calendars = await writableCalendarsForAction(action, selectedConnection.connectionId)
  const selectedCalendar = requestedCalendarId === 'primary'
    ? calendars.find((calendar) => calendar.primary)
    : calendars.find((calendar) => calendar.id === requestedCalendarId)
  if (!selectedCalendar) {
    throw new PermanentCrmIntegrationActionError(
      'The queued Calendar is no longer accessible with write permission on its reviewed connection',
    )
  }
  const organizerEmail = normalizeEmail(selectedCalendar.id, 'Selected Calendar organizer')
  if (
    selectedConnection.identityEmail
    && organizerEmail !== normalizeEmail(selectedConnection.identityEmail, 'Queued Calendar organizer')
  ) {
    throw new PermanentCrmIntegrationActionError('The queued Calendar organizer no longer matches its reviewed identity')
  }
  return {
    organizerEmail,
    calendarId: selectedCalendar.id,
    calendarSummary: selectedCalendar.summary,
    accessRole: selectedCalendar.accessRole,
  }
}

async function recordAttemptSucceeded(
  action: LeasedCrmIntegrationAction,
  externalId: string | null,
  responseSummary: JsonObject,
) {
  const safeExternalId = externalId ? cleanString(externalId, 1000, 'Provider result ID') : null
  await withTransaction(async (client) => {
    const current = await client.query(
      `UPDATE crm_integration_actions
       SET external_id = $3, response_summary = $4::jsonb, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [action.id, action.lockToken, safeExternalId, JSON.stringify(responseSummary)],
    )
    if (current.rowCount !== 1) throw new Error('CRM action lease was lost')
    await client.query(
      `UPDATE crm_integration_action_attempts
       SET status = 'succeeded', external_id = $3, response_summary = $4::jsonb,
         error = NULL, finished_at = now()
       WHERE action_id = $1::uuid AND attempt_number = $2 AND status = 'started'`,
      [action.id, action.attempts, safeExternalId, JSON.stringify(responseSummary)],
    )
  })
}

async function recordAttemptProgress(
  action: LeasedCrmIntegrationAction,
  externalId: string,
  responseSummary: JsonObject,
) {
  const safeExternalId = requiredString(externalId, 1000, 'Provider result ID')
  await withTransaction(async (client) => {
    const current = await client.query(
      `UPDATE crm_integration_actions
       SET external_id = COALESCE($3, external_id), response_summary = $4::jsonb, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [action.id, action.lockToken, safeExternalId, JSON.stringify(responseSummary)],
    )
    if (current.rowCount !== 1) throw new Error('CRM action lease was lost')
    await client.query(
      `UPDATE crm_integration_action_attempts
       SET external_id = $3, response_summary = $4::jsonb
       WHERE action_id = $1::uuid AND attempt_number = $2 AND status = 'started'`,
      [action.id, action.attempts, safeExternalId, JSON.stringify(responseSummary)],
    )
  })
}

async function refreshCampaignCountsWithClient(client: PoolClient, campaignId: string) {
  await client.query(
    `UPDATE crm_campaigns campaign
     SET recipient_count = counts.total,
         sent_count = counts.sent,
         failed_count = counts.failed,
         status = CASE
           WHEN counts.queued > 0 THEN 'sending'
           WHEN counts.failed > 0 THEN 'failed'
           ELSE 'sent'
         END,
         updated_at = now()
     FROM (
       SELECT count(*)::integer AS total,
         count(*) FILTER (WHERE status = 'sent')::integer AS sent,
         count(*) FILTER (WHERE status = 'failed')::integer AS failed,
         count(*) FILTER (WHERE status IN ('pending', 'queued'))::integer AS queued
       FROM crm_campaign_recipients WHERE campaign_id = $1::uuid
     ) counts
     WHERE campaign.id = $1::uuid`,
    [campaignId],
  )
}

async function completeAction(
  action: LeasedCrmIntegrationAction,
  externalId: string | null,
  responseSummary: JsonObject,
) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE crm_integration_action_attempts
       SET status = 'succeeded', external_id = COALESCE($3, external_id),
         response_summary = $4::jsonb, error = NULL, finished_at = COALESCE(finished_at, now())
       WHERE action_id = $1::uuid AND attempt_number = $2 AND status = 'started'`,
      [action.id, action.attempts, externalId, JSON.stringify(responseSummary)],
    )
    const result = await client.query(
      `UPDATE crm_integration_actions
       SET status = 'succeeded', external_id = COALESCE($3, external_id),
         response_summary = $4::jsonb, last_error = NULL, processed_at = now(),
         locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [action.id, action.lockToken, externalId, JSON.stringify(responseSummary)],
    )
    if (result.rowCount !== 1) throw new Error('CRM action lease was lost')

    const campaignRecipientId = typeof action.payload.campaignRecipientId === 'string'
      ? action.payload.campaignRecipientId
      : ''
    const campaignId = typeof action.payload.campaignId === 'string' ? action.payload.campaignId : ''
    if (UUID_PATTERN.test(campaignRecipientId) && UUID_PATTERN.test(campaignId)) {
      await client.query(
        `UPDATE crm_campaign_recipients
         SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
         WHERE id = $1::uuid AND campaign_id = $2::uuid AND integration_action_id = $3::uuid`,
        [campaignRecipientId, campaignId, action.id],
      )
      await refreshCampaignCountsWithClient(client, campaignId)
    }

    await auditAction(client, {
      id: action.id,
      actorEmail: action.actorEmail,
      aggregateType: action.aggregateType,
      aggregateId: action.aggregateId,
      pipelineId: action.pipelineId,
      actionType: action.actionType,
      referenceCode: action.referenceCode || '',
      provider: action.provider || 'internal',
      app: action.app,
    }, 'crm.integration_action.succeeded', { attempts: action.attempts })
  })
}

async function failAction(input: {
  action: LeasedCrmIntegrationAction
  error: unknown
  maxAttempts: number
  retryBaseSeconds: number
  permanent: boolean
}): Promise<'failed' | 'dead'> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(input.maxAttempts), 20))
  const retryBaseSeconds = Math.max(5, Math.min(Math.trunc(input.retryBaseSeconds), 3600))
  const status = input.permanent || input.action.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.action.attempts - 1)), 3600)
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  const error = safeErrorMessage(input.error)
  const failureEvidence = providerFailureEvidence(input.error)

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE crm_integration_action_attempts
       SET status = 'failed', error = $3,
         response_summary = COALESCE(response_summary, '{}'::jsonb) || $4::jsonb,
         finished_at = now()
       WHERE action_id = $1::uuid AND attempt_number = $2 AND status = 'started'`,
      [input.action.id, input.action.attempts, error, JSON.stringify(failureEvidence)],
    )
    const result = await client.query(
      `UPDATE crm_integration_actions
       SET status = $3, last_error = $4, available_at = $5::timestamptz,
         response_summary = COALESCE(response_summary, '{}'::jsonb) || $6::jsonb,
         processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
         locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [
        input.action.id,
        input.action.lockToken,
        status,
        error,
        availableAt,
        JSON.stringify(failureEvidence),
      ],
    )
    if (result.rowCount !== 1) throw new Error('CRM action lease was lost')

    if (status === 'dead' && input.action.actionType === 'create_calendar_event') {
      await client.query(
        `UPDATE crm_meetings
         SET status = 'failed',
           source_payload = COALESCE(source_payload, '{}'::jsonb) || jsonb_build_object(
             'calendarDeliveryStatus', 'failed',
             'calendarDeliveryError', $4::text,
             'calendarDeliveryFailure', $5::jsonb
           ),
           updated_at = now()
         WHERE pipeline_id = $1::uuid
           AND (
             source_payload->>'actionId' = $2
             OR ($3 = 'crm_meeting' AND id = $6::uuid)
           )`,
        [
          input.action.pipelineId,
          input.action.id,
          input.action.aggregateType,
          error,
          JSON.stringify(failureEvidence),
          input.action.aggregateType === 'crm_meeting' ? input.action.aggregateId : null,
        ],
      )
    }

    const campaignRecipientId = typeof input.action.payload.campaignRecipientId === 'string'
      ? input.action.payload.campaignRecipientId
      : ''
    const campaignId = typeof input.action.payload.campaignId === 'string'
      ? input.action.payload.campaignId
      : ''
    if (UUID_PATTERN.test(campaignRecipientId) && UUID_PATTERN.test(campaignId)) {
      await client.query(
        `UPDATE crm_campaign_recipients
         SET status = 'failed', last_error = $4, updated_at = now()
         WHERE id = $1::uuid AND campaign_id = $2::uuid AND integration_action_id = $3::uuid`,
        [campaignRecipientId, campaignId, input.action.id, error],
      )
      await refreshCampaignCountsWithClient(client, campaignId)
    }

    await auditAction(client, {
      id: input.action.id,
      actorEmail: input.action.actorEmail,
      aggregateType: input.action.aggregateType,
      aggregateId: input.action.aggregateId,
      pipelineId: input.action.pipelineId,
      actionType: input.action.actionType,
      referenceCode: input.action.referenceCode || '',
      provider: input.action.provider || 'internal',
      app: input.action.app,
    }, `crm.integration_action.${status}`, {
      attempts: input.action.attempts,
      error,
      availableAt: status === 'failed' ? availableAt : null,
      ...failureEvidence,
    })
  })
  return status
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64Body(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
}

function encodedHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function crmReplyMarkers(referenceCodes: string[]): string[] {
  return Array.from(new Set(referenceCodes.map((referenceCode) => (
    `%gslt${normalizeReference(referenceCode)}`
  ))))
}

function appendTextReplyMarkers(value: string, referenceCodes: string[]): string {
  const markers = crmReplyMarkers(referenceCodes)
  const withoutDuplicates = value
    .replace(CRM_REPLY_MARKER_PATTERN, '')
    .trimEnd()
  return `${withoutDuplicates}${withoutDuplicates ? '\r\n\r\n' : ''}${markers.join('\r\n')}`
}

function appendHtmlReplyMarkers(value: string, referenceCodes: string[]): string {
  const references = Array.from(new Set(referenceCodes.map(normalizeReference)))
  const withoutDuplicates = value
    .replace(CRM_REPLY_MARKER_PATTERN, '')
    .trimEnd()
  const markerElement = references.map((referenceCode) => (
    `<div data-clawpilot-crm-reference="${referenceCode}">%gslt${referenceCode}</div>`
  )).join('')
  const closingBody = withoutDuplicates.match(/<\/body\s*>/i)
  if (!closingBody || closingBody.index === undefined) {
    const closingHtml = withoutDuplicates.match(/<\/html\s*>/i)
    if (closingHtml?.index !== undefined) {
      return `${withoutDuplicates.slice(0, closingHtml.index)}<body>${markerElement}</body>\n${withoutDuplicates.slice(closingHtml.index)}`
    }
    return `${withoutDuplicates}${withoutDuplicates ? '\n' : ''}${markerElement}`
  }
  return `${withoutDuplicates.slice(0, closingBody.index)}${markerElement}\n${withoutDuplicates.slice(closingBody.index)}`
}

async function outboundEmailReferenceCodes(
  action: LeasedCrmIntegrationAction,
  target: CrmReferenceRecord,
): Promise<string[]> {
  const references = [normalizeReference(target.referenceCode)]
  if (target.entity !== 'contacts' || !target.organizationId) return references
  const organization = await query<{ reference_code: string }>(
    `SELECT reference_code
     FROM crm_organizations
     WHERE pipeline_id = $1::uuid AND id = $2::uuid
     LIMIT 1`,
    [action.pipelineId, target.organizationId],
  )
  const organizationReference = organization.rows[0]?.reference_code
  if (!organizationReference) {
    throw new PermanentCrmIntegrationActionError('Contact organization is no longer available')
  }
  references.push(normalizeReference(organizationReference))
  return Array.from(new Set(references))
}

function gmailMessage(input: {
  sender: string
  recipient: string
  subject: string
  text: string
  html?: string
}): string {
  const headers = [
    `From: <${input.sender}>`,
    `To: <${input.recipient}>`,
    `Subject: ${encodedHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (!input.html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(input.text),
      '',
    ].join('\r\n')
  }
  const boundary = `clawpilot-${crypto.randomUUID()}`
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function matonJson(
  action: LeasedCrmIntegrationAction,
  app: 'google-mail' | 'google-calendar',
  connectionId: string,
  pathname: string,
  init?: RequestInit,
): Promise<JsonObject> {
  if (!action.communicationCredentialOwnerEmail) {
    throw new PermanentCrmIntegrationActionError(
      'The queued communication action has no reviewed credential owner; create a new action',
    )
  }
  const response = await matonFetch(pathname, init, {
    ownerEmail: action.communicationCredentialOwnerEmail,
    app,
    boundConnectionId: connectionId,
  })
  if (!response.ok) throw await providerRequestError(app, response)
  const parsed = await response.json().catch(() => ({}))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
}

type WritableCalendarOption = {
  id: string
  summary: string
  primary: boolean
  accessRole: 'owner' | 'writer'
}

async function listWritableCalendars(
  readPage: (pathname: string) => Promise<JsonObject>,
): Promise<WritableCalendarOption[]> {
  const calendars: WritableCalendarOption[] = []
  const seen = new Set<string>()
  let pageToken = ''
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES && calendars.length < MAX_CALENDAR_OPTIONS; page += 1) {
    const parameters = new URLSearchParams({
      maxResults: '250',
      minAccessRole: 'writer',
      showHidden: 'false',
    })
    if (pageToken) parameters.set('pageToken', pageToken)
    const response = await readPage(
      `/google-calendar/calendar/v3/users/me/calendarList?${parameters.toString()}`,
    )
    const items = Array.isArray(response.items) ? response.items : []
    for (const value of items) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const item = value as JsonObject
      const accessRole = String(item.accessRole || '').trim().toLowerCase()
      if (accessRole !== 'owner' && accessRole !== 'writer') continue
      let id: string
      try {
        id = calendarIdentifier(item.id, 'Provider Calendar ID')
      } catch {
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      const rawSummary = String(item.summaryOverride || item.summary || id)
      const summary = rawSummary.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) || id
      calendars.push({ id, summary, primary: item.primary === true, accessRole })
      if (calendars.length >= MAX_CALENDAR_OPTIONS) break
    }
    const nextPageToken = typeof response.nextPageToken === 'string' ? response.nextPageToken.trim() : ''
    if (!nextPageToken) break
    if (nextPageToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(nextPageToken)) {
      throw new PermanentCrmIntegrationActionError('Google Calendar list returned an invalid page token')
    }
    pageToken = nextPageToken
  }
  return calendars
}

async function writableCalendarsForAction(
  action: LeasedCrmIntegrationAction,
  connectionId: string,
): Promise<WritableCalendarOption[]> {
  return listWritableCalendars((pathname) => matonJson(
    action,
    'google-calendar',
    connectionId,
    pathname,
    { headers: { Accept: 'application/json' } },
  ))
}

async function previousCalendarJson(
  selection: PreviousCalendarEventSnapshot,
  pathname: string,
  init?: RequestInit,
): Promise<JsonObject> {
  const response = await matonFetch(pathname, init, {
    ownerEmail: selection.credentialOwnerEmail,
    app: 'google-calendar',
    boundConnectionId: selection.connectionId,
  })
  if (!response.ok) throw await providerRequestError('google-calendar', response)
  const parsed = await response.json().catch(() => ({}))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
}

async function verifiedPreviousCalendarSelection(
  action: LeasedCrmIntegrationAction,
  selection: PreviousCalendarEventSnapshot,
) {
  if (selection.credentialOwnerEmail !== action.actorEmail) {
    let activeOrganizationCalendar: PipelineCommunicationSnapshot
    try {
      activeOrganizationCalendar = await resolvePipelineCommunicationSnapshotInPostgres({
        pipelineId: action.pipelineId,
        actorEmail: action.actorEmail,
        app: 'google-calendar',
      })
    } catch {
      throw new PermanentCrmIntegrationActionError(
        'The previous Calendar credential owner is no longer authorized for this organization',
      )
    }
    if (
      activeOrganizationCalendar.source !== 'organization'
      || activeOrganizationCalendar.organizationId !== action.communication?.organizationId
      || activeOrganizationCalendar.credentialOwnerEmail !== selection.credentialOwnerEmail
      || activeOrganizationCalendar.connectionId !== selection.connectionId
      || activeOrganizationCalendar.calendarId !== selection.calendarId
      || (
        selection.organizerEmail
        && activeOrganizationCalendar.identityEmail !== selection.organizerEmail
      )
    ) {
      throw new PermanentCrmIntegrationActionError(
        'The previous Calendar credential owner is no longer authorized for this organization',
      )
    }
  }
  const credential = await resolveUserMatonGatewayCredential({
    ownerEmail: selection.credentialOwnerEmail,
    app: 'google-calendar',
    boundConnectionId: selection.connectionId,
  })
  if (credential.connectionId !== selection.connectionId) {
    throw new PermanentCrmIntegrationActionError(
      'The previous Calendar connection no longer matches its recorded identity',
    )
  }
  const calendars = await listWritableCalendars((pathname) => previousCalendarJson(
    selection,
    pathname,
    { headers: { Accept: 'application/json' } },
  ))
  const requestedCalendarId = calendarIdentifier(selection.calendarId, 'Previous Calendar ID')
  const calendar = requestedCalendarId === 'primary'
    ? calendars.find((value) => value.primary)
    : calendars.find((value) => value.id === requestedCalendarId)
  if (!calendar) {
    throw new PermanentCrmIntegrationActionError(
      'The previous Calendar is no longer accessible with write permission on its recorded connection',
    )
  }
  if (
    selection.organizerEmail
    && normalizeEmail(calendar.id, 'Previous Calendar organizer') !== selection.organizerEmail
  ) {
    throw new PermanentCrmIntegrationActionError(
      'The previous Calendar organizer no longer matches its recorded identity',
    )
  }
  return calendar
}

function interactionLinks(target: CrmReferenceRecord, meetingId?: string | null) {
  return {
    organizationId: target.entity === 'organizations' ? target.id : target.organizationId,
    contactId: target.entity === 'contacts' ? target.id : null,
    leadId: target.entity === 'leads' ? target.id : null,
    opportunityId: target.entity === 'opportunities' ? target.id : null,
    meetingId: meetingId || (target.entity === 'meetings' ? target.id : null),
    campaignId: target.entity === 'campaigns' ? target.id : null,
  }
}

async function stageActionInteraction(input: {
  action: LeasedCrmIntegrationAction
  target: CrmReferenceRecord
  subject: string
  description: string
  interactionType: string
  deliveryStatus: string
  providerMessageId?: string | null
  providerThreadId?: string | null
  meetingId?: string | null
  activityStatus?: CrmActivityStatus | null
  durationMinutes?: number | null
  direction?: 'inbound' | 'outbound'
}) {
  const links = interactionLinks(input.target, input.meetingId)
  const parentSuiteCrmType = suiteCrmParentType(input.target.entity)
  const campaignId = typeof input.action.payload.campaignId === 'string' && UUID_PATTERN.test(input.action.payload.campaignId)
    ? input.action.payload.campaignId
    : links.campaignId
  return stageCrmRecordInPostgres({
    entity: 'interactions',
    pipelineId: input.action.pipelineId,
    sourceKey: `crm-action:${input.action.id}`,
    sourcePayload: {
      source: 'crm-integration-action',
      actionId: input.action.id,
      actionType: input.action.actionType,
      provider: input.action.provider,
    },
    actorEmail: input.action.actorEmail,
    fields: {
      ...links,
      campaignId,
      parentSuiteCrmId: parentSuiteCrmType ? input.target.suiteCrmId : null,
      parentSuiteCrmType: parentSuiteCrmType || undefined,
      interactionType: input.interactionType,
      ...(input.interactionType === 'call' ? {
        suiteCrmModule: 'Calls' as const,
        activityStatus: input.activityStatus || 'held',
        durationMinutes: input.durationMinutes || 15,
      } : {}),
      subject: input.subject,
      agentEmail: input.action.actorEmail,
      agentName: input.action.actorEmail,
      occurredAt: new Date().toISOString(),
      description: input.description,
      direction: input.direction || 'outbound',
      deliveryStatus: input.deliveryStatus,
      providerMessageId: input.providerMessageId || null,
      providerThreadId: input.providerThreadId || null,
      metadata: {
        actionId: input.action.id,
        actionType: input.action.actionType,
        app: input.action.app,
      },
    },
  })
}

async function sendEmailAction(action: LeasedCrmIntegrationAction, target: CrmReferenceRecord) {
  if (target.entity !== 'organizations' && target.entity !== 'contacts' && target.entity !== 'leads') {
    throw new PermanentCrmIntegrationActionError('Email action target is no longer an organization, contact, or lead')
  }
  if (target.emailOptOut) throw new PermanentCrmIntegrationActionError('CRM recipient is suppressed from email')
  const recipient = normalizeEmail(target.email, 'CRM recipient email')
  const intendedRecipient = typeof action.payload.recipientEmail === 'string'
    ? normalizeEmail(action.payload.recipientEmail, 'Queued recipient email')
    : recipient
  if (intendedRecipient !== recipient) {
    throw new PermanentCrmIntegrationActionError('CRM recipient email changed after the action was queued')
  }
  const subject = requiredString(action.payload.subject, 300, 'Email subject')
  const text = requiredString(action.payload.text, 100_000, 'Email body')
  const html = cleanString(action.payload.html, 100_000, 'Email HTML body') || undefined
  const markerReferences = await outboundEmailReferenceCodes(action, target)
  const messageText = appendTextReplyMarkers(text, markerReferences)
  const messageHtml = html ? appendHtmlReplyMarkers(html, markerReferences) : undefined

  let messageId = action.externalId
  let threadId = typeof action.responseSummary.threadId === 'string' ? action.responseSummary.threadId : null
  let senderEmail = typeof action.responseSummary.senderEmail === 'string'
    ? normalizeEmail(action.responseSummary.senderEmail, 'Recorded Gmail sender')
    : null
  if (!messageId) {
    const selectedConnection = await selectedMatonConnection(action, 'google-mail')
    const { connectionId } = selectedConnection
    const profile = await matonJson(
      action,
      'google-mail',
      connectionId,
      '/google-mail/gmail/v1/users/me/profile',
      { headers: { Accept: 'application/json' } },
    )
    const profileEmail = normalizeEmail(profile.emailAddress, 'Selected Gmail profile')
    if (selectedConnection.accountEmail && profileEmail !== selectedConnection.accountEmail) {
      throw new PermanentCrmIntegrationActionError('The queued Gmail account no longer matches its reviewed identity')
    }
    senderEmail = selectedConnection.identityEmail
      ? normalizeEmail(selectedConnection.identityEmail, 'Queued Gmail sender')
      : profileEmail
    if (senderEmail !== profileEmail) {
      const sendAs = await matonJson(
        action,
        'google-mail',
        connectionId,
        `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(senderEmail)}`,
        { headers: { Accept: 'application/json' } },
      )
      if (
        normalizeEmail(sendAs.sendAsEmail, 'Verified Gmail sender') !== senderEmail
        || String(sendAs.verificationStatus || '').trim().toLowerCase() !== 'accepted'
      ) {
        throw new PermanentCrmIntegrationActionError('The queued Gmail sender is no longer an accepted send-as identity')
      }
    }
    const delivered = await matonJson(
      action,
      'google-mail',
      connectionId,
      '/google-mail/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw: base64Url(gmailMessage({
            sender: senderEmail,
            recipient,
            subject,
            text: messageText,
            html: messageHtml,
          })),
        }),
      },
    )
    messageId = cleanString(delivered.id, 1000, 'Gmail message ID')
      || cleanString(objectValue(delivered.message, 'Gmail result').id, 1000, 'Gmail message ID')
    if (!messageId) throw new Error('google-mail provider returned no message ID')
    threadId = cleanString(delivered.threadId, 1000, 'Gmail thread ID') || null
  }
  const summary = {
    messageId,
    threadId,
    senderEmail,
    accountEmail: action.communication?.accountEmail || senderEmail,
    communicationBindingSource: action.communication?.source || null,
    communicationOrganizationId: action.communication?.organizationId || null,
    markerReferences,
  }
  await recordAttemptSucceeded(action, messageId, summary)
  await stageActionInteraction({
    action,
    target,
    subject,
    description: text,
    interactionType: 'email',
    deliveryStatus: 'sent',
    providerMessageId: messageId,
    providerThreadId: threadId,
  })
  await completeAction(action, messageId, summary)
}

async function stageCalendarMeeting(
  action: LeasedCrmIntegrationAction,
  target: CrmReferenceRecord,
  result: { eventId: string | null; eventUrl: string | null; joinUrl: string | null },
  status: CrmMeeting['status'],
  options: { preserveMissingJoinUrl?: boolean } = {},
) {
  const meetingMode = storedMeetingMode(action.payload.meetingMode)
  const customJoinUrl = storedCustomJoinUrl(action.payload.customJoinUrl, meetingMode)
  const calendarDeliveryStatus = status === 'queued' || status === 'planned'
    ? 'queued'
    : status === 'failed'
      ? 'failed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'sent'
  let organizationId = target.entity === 'organizations' ? target.id : target.organizationId
  let contactId = target.entity === 'contacts' ? target.id : null
  let leadId = target.entity === 'leads' ? target.id : null
  let opportunityId = target.entity === 'opportunities' ? target.id : null
  let sourceKey = `crm-action:${action.id}:meeting`
  let localId: string | null = null
  let existingSourcePayload: JsonObject = {}

  if (target.entity === 'meetings') {
    const current = await query<{
      organization_id: string | null
      contact_id: string | null
      lead_id: string | null
      opportunity_id: string | null
      source_key: string
      source_payload: JsonObject | null
    }>(
      `SELECT organization_id::text, contact_id::text, lead_id::text,
         opportunity_id::text, source_key, source_payload
       FROM crm_meetings WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [action.pipelineId, target.id],
    )
    const meeting = current.rows[0]
    if (!meeting) throw new PermanentCrmIntegrationActionError('CRM meeting no longer exists')
    organizationId = meeting.organization_id
    contactId = meeting.contact_id
    leadId = meeting.lead_id
    opportunityId = meeting.opportunity_id
    sourceKey = meeting.source_key
    localId = target.id
    existingSourcePayload = meeting.source_payload && typeof meeting.source_payload === 'object'
      && !Array.isArray(meeting.source_payload)
      ? meeting.source_payload
      : {}
  }

  let organizationSuiteCrmId: string | null = null
  if (organizationId) {
    const organization = await query<{ suitecrm_id: string | null }>(
      `SELECT suitecrm_id FROM crm_organizations
       WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [action.pipelineId, organizationId],
    )
    organizationSuiteCrmId = organization.rows[0]?.suitecrm_id || null
  }
  let parentSuiteCrmId: string | null = null
  let parentSuiteCrmType: 'Accounts' | 'Contacts' | 'Leads' | 'Opportunities' | null = null
  if (opportunityId) {
    const opportunity = await query<{ suitecrm_id: string | null }>(
      `SELECT suitecrm_id FROM crm_opportunities
       WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [action.pipelineId, opportunityId],
    )
    parentSuiteCrmId = opportunity.rows[0]?.suitecrm_id || null
    parentSuiteCrmType = parentSuiteCrmId ? 'Opportunities' : null
  } else if (contactId) {
    const contact = await query<{ suitecrm_id: string | null }>(
      `SELECT suitecrm_id FROM crm_contacts
       WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [action.pipelineId, contactId],
    )
    parentSuiteCrmId = contact.rows[0]?.suitecrm_id || null
    parentSuiteCrmType = parentSuiteCrmId ? 'Contacts' : null
  } else if (leadId) {
    const lead = await query<{ suitecrm_id: string | null }>(
      `SELECT suitecrm_id FROM crm_leads
       WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
      [action.pipelineId, leadId],
    )
    parentSuiteCrmId = lead.rows[0]?.suitecrm_id || null
    parentSuiteCrmType = parentSuiteCrmId ? 'Leads' : null
  } else if (organizationSuiteCrmId) {
    parentSuiteCrmId = organizationSuiteCrmId
    parentSuiteCrmType = 'Accounts'
  }

  const staged = await stageCrmRecordInPostgres({
    entity: 'meetings',
    pipelineId: action.pipelineId,
    localId,
    sourceKey,
    sourcePayload: {
      ...existingSourcePayload,
      source: 'crm-integration-action',
      actionId: action.id,
      provider: action.provider,
      calendarOwnerEmail: action.communicationCredentialOwnerEmail || action.actorEmail,
      calendarConnectionId: action.communicationConnectionId,
      calendarOrganizerEmail: action.communication?.identityEmail || null,
      calendarId: action.communication?.calendarId || null,
      calendarDeliveryStatus,
      calendarDeliveryError: null,
      calendarDeliveryFailure: null,
      meetingMode,
      customJoinUrl,
      communicationOrganizationId: action.communication?.organizationId || null,
    },
    actorEmail: action.actorEmail,
    fields: {
      organizationId,
      organizationSuiteCrmId,
      contactId,
      leadId,
      opportunityId,
      parentSuiteCrmId,
      parentSuiteCrmType: parentSuiteCrmType || undefined,
      subject: requiredString(action.payload.subject, 300, 'Calendar event subject'),
      description: cleanString(action.payload.description, 50_000, 'Calendar event description'),
      startsAt: normalizeDateTime(action.payload.startsAt, 'Calendar event start'),
      endsAt: normalizeDateTime(action.payload.endsAt, 'Calendar event end'),
      timezone: normalizeTimezone(action.payload.timezone),
      location: cleanString(action.payload.location, 1000, 'Calendar event location'),
      attendeeEmails: normalizeEmailList(action.payload.attendeeEmails),
      status,
      provider: 'maton',
      externalEventId: result.eventId,
      externalEventUrl: result.eventUrl,
      joinUrl: result.joinUrl,
    },
  })
  if (!result.joinUrl && !options.preserveMissingJoinUrl) {
    await query(
      `UPDATE crm_meetings
       SET join_url = NULL, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [action.pipelineId, staged.id],
    )
  }
  return staged
}

function normalizeMeetingStatus(value: unknown): CrmMeeting['status'] {
  const status = cleanString(value, 32, 'Meeting status').toLowerCase()
  if (!status) return 'scheduled'
  if (['planned', 'queued', 'scheduled', 'completed', 'cancelled', 'failed'].includes(status)) {
    return status as CrmMeeting['status']
  }
  throw new PermanentCrmIntegrationActionError('Calendar action meeting status is invalid')
}

type CalendarMeetingMode = 'google_meet' | 'in_person' | 'custom_link'

function calendarMeetingMode(value: unknown): CalendarMeetingMode | null {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!mode) return 'google_meet'
  return mode === 'google_meet' || mode === 'in_person' || mode === 'custom_link'
    ? mode
    : null
}

function normalizeMeetingMode(value: unknown): CalendarMeetingMode {
  const mode = calendarMeetingMode(value)
  if (!mode) throw new CrmIntegrationActionError('Meeting mode must be Google Meet, in person, or custom link')
  return mode
}

function storedMeetingMode(value: unknown): CalendarMeetingMode {
  const mode = calendarMeetingMode(value)
  if (!mode) throw new PermanentCrmIntegrationActionError('Calendar action meeting mode is invalid')
  return mode
}

function storedCustomJoinUrl(value: unknown, mode: CalendarMeetingMode): string | null {
  const joinUrl = safeHttpsUrl(value)
  if (mode === 'custom_link' && !joinUrl) {
    throw new PermanentCrmIntegrationActionError('Calendar action custom meeting URL is invalid')
  }
  return mode === 'custom_link' ? joinUrl : null
}

function calendarEventIdForMeeting(referenceCode: string): string {
  const normalized = normalizeReference(referenceCode)
  if (!globalIdPattern('gm').test(normalized)) {
    throw new PermanentCrmIntegrationActionError('Calendar event requires a meeting reference')
  }
  return normalized
}

function meetingCalendarDescription(description: string, referenceCode: string, shortUrl: string): string {
  const managedBoundary = '\n\n---\nClawPilot meeting:'
  const existingBoundary = description.indexOf(managedBoundary)
  const operatorDescription = (existingBoundary >= 0 ? description.slice(0, existingBoundary) : description).trimEnd()
  const footer = `ClawPilot meeting: ${shortUrl}\nClawPilot ID: ${normalizeReference(referenceCode)}`
  return `${operatorDescription}${operatorDescription ? '\n\n---\n' : ''}${footer}`
}

function queuedPreviousCalendarSnapshot(value: unknown): PreviousCalendarEventSnapshot | null {
  try {
    return normalizedPreviousCalendarSnapshot(value)
  } catch (error) {
    throw new PermanentCrmIntegrationActionError(
      error instanceof Error ? error.message : 'Previous Calendar event snapshot is invalid',
    )
  }
}

type PendingCalendarMove = {
  sourceEventId: string
  sourceCalendarId: string
  destinationEventId: string
  destinationCalendarId: string
}

function queuedPendingCalendarMove(value: unknown): PendingCalendarMove | null {
  if (value === undefined || value === null) return null
  try {
    const pending = objectValue(value, 'Pending Calendar move')
    assertOnlyFields(pending, [
      'state', 'sourceEventId', 'sourceCalendarId', 'destinationEventId', 'destinationCalendarId',
    ])
    if (pending.state !== 'destination-written-source-delete-pending') {
      throw new CrmIntegrationActionError('Pending Calendar move state is invalid')
    }
    return {
      sourceEventId: requiredString(pending.sourceEventId, 1000, 'Pending source Calendar event ID'),
      sourceCalendarId: calendarIdentifier(pending.sourceCalendarId, 'Pending source Calendar ID'),
      destinationEventId: requiredString(pending.destinationEventId, 1000, 'Pending destination Calendar event ID'),
      destinationCalendarId: calendarIdentifier(pending.destinationCalendarId, 'Pending destination Calendar ID'),
    }
  } catch (error) {
    throw new PermanentCrmIntegrationActionError(
      error instanceof Error ? error.message : 'Pending Calendar move evidence is invalid',
    )
  }
}

function previousCalendarSnapshotFromSource(
  eventId: string,
  sourcePayload: JsonObject | null,
): PreviousCalendarEventSnapshot | null {
  if (!sourcePayload || typeof sourcePayload !== 'object' || Array.isArray(sourcePayload)) return null
  const candidate = {
    eventId,
    credentialOwnerEmail: sourcePayload.calendarOwnerEmail,
    connectionId: sourcePayload.calendarConnectionId,
    calendarId: sourcePayload.calendarId,
    organizerEmail: sourcePayload.calendarOrganizerEmail || null,
  }
  if (!candidate.credentialOwnerEmail || !candidate.connectionId || !candidate.calendarId) return null
  return queuedPreviousCalendarSnapshot(candidate)
}

function sameCalendarSelection(
  previous: PreviousCalendarEventSnapshot,
  selected: Awaited<ReturnType<typeof selectedMatonConnection>>,
) {
  return previous.credentialOwnerEmail === selected.credentialOwnerEmail
    && previous.connectionId === selected.connectionId
    && (
      previous.calendarId === selected.calendarId
      || Boolean(
        previous.organizerEmail
        && selected.identityEmail
        && previous.organizerEmail === selected.identityEmail,
      )
    )
}

async function existingCalendarEvent(pipelineId: string, target: CrmReferenceRecord) {
  if (target.entity !== 'meetings') return null
  const result = await query<{
    external_event_id: string | null
    external_event_url: string | null
    join_url: string | null
    source_payload: JsonObject | null
  }>(
    `SELECT external_event_id, external_event_url, join_url, source_payload
     FROM crm_meetings WHERE pipeline_id = $1::uuid AND id = $2::uuid LIMIT 1`,
    [pipelineId, target.id],
  )
  const row = result.rows[0]
  return row?.external_event_id ? row : null
}

async function createCalendarEventAction(action: LeasedCrmIntegrationAction, target: CrmReferenceRecord) {
  const subject = requiredString(action.payload.subject, 300, 'Calendar event subject')
  const startsAt = normalizeDateTime(action.payload.startsAt, 'Calendar event start')
  const endsAt = normalizeDateTime(action.payload.endsAt, 'Calendar event end')
  const timezone = normalizeTimezone(action.payload.timezone)
  const description = cleanString(action.payload.description, 50_000, 'Calendar event description')
  const meetingMode = storedMeetingMode(action.payload.meetingMode)
  const customJoinUrl = storedCustomJoinUrl(action.payload.customJoinUrl, meetingMode)
  const location = cleanString(action.payload.location, 1000, 'Calendar event location')
  if (meetingMode === 'in_person' && !location) {
    throw new PermanentCrmIntegrationActionError('An in-person meeting requires a location')
  }
  const eventLocation = meetingMode === 'custom_link' ? location || customJoinUrl || '' : location
  const attendeeEmails = normalizeEmailList(action.payload.attendeeEmails)
  const desiredMeetingStatus = normalizeMeetingStatus(action.payload.meetingStatus)
  const provisionalStatus: CrmMeeting['status'] = ['completed', 'cancelled', 'failed'].includes(desiredMeetingStatus)
    ? desiredMeetingStatus
    : 'queued'
  const finalMeetingStatus: CrmMeeting['status'] = ['planned', 'queued'].includes(desiredMeetingStatus)
    ? 'scheduled'
    : desiredMeetingStatus

  const currentEvent = await existingCalendarEvent(action.pipelineId, target)
  const currentEventId = cleanString(currentEvent?.external_event_id, 1000, 'Calendar event ID') || null
  const queuedPreviousCalendar = queuedPreviousCalendarSnapshot(action.payload.previousCalendar)
  if (
    queuedPreviousCalendar
    && currentEventId
    && queuedPreviousCalendar.eventId !== currentEventId
  ) {
    throw new PermanentCrmIntegrationActionError(
      'The recorded Calendar event changed after this action was queued; review and create a new action',
    )
  }
  const previousCalendar = queuedPreviousCalendar || (
    currentEventId
      ? previousCalendarSnapshotFromSource(currentEventId, currentEvent?.source_payload || null)
      : null
  )
  const pendingCalendarMove = queuedPendingCalendarMove(action.responseSummary.calendarMove)
  if (currentEventId && !previousCalendar) {
    throw new PermanentCrmIntegrationActionError(
      'The existing Calendar event has no verified Calendar identity; review the meeting before updating it',
    )
  }
  if (
    pendingCalendarMove
    && (
      !action.externalId
      || action.externalId !== pendingCalendarMove.destinationEventId
      || !previousCalendar
      || currentEventId !== pendingCalendarMove.sourceEventId
    )
  ) {
    throw new PermanentCrmIntegrationActionError(
      'The pending Calendar move no longer matches its durable provider evidence; review and create a new action',
    )
  }

  const provisionalMeeting = await stageCalendarMeeting(
    action,
    target,
    { eventId: null, eventUrl: null, joinUrl: customJoinUrl },
    provisionalStatus,
    { preserveMissingJoinUrl: true },
  )
  const meetingTarget = await readCrmRecordByReference({
    pipelineId: action.pipelineId,
    referenceCode: provisionalMeeting.referenceCode,
  })
  const meetingUrl = safeHttpsUrl(provisionalMeeting.shortUrl)
  if (!meetingUrl) throw new PermanentCrmIntegrationActionError('CRM meeting short link is unavailable')
  let eventId = action.externalId
  let eventUrl = safeHttpsUrl(action.responseSummary.eventUrl) || safeHttpsUrl(currentEvent?.external_event_url)
  let joinUrl = meetingMode === 'custom_link'
    ? customJoinUrl
    : meetingMode === 'in_person'
      ? null
      : safeHttpsUrl(action.responseSummary.joinUrl) || safeHttpsUrl(currentEvent?.join_url)
  let organizerEmail = typeof action.responseSummary.organizerEmail === 'string'
    ? normalizeEmail(action.responseSummary.organizerEmail, 'Recorded Calendar organizer')
    : null
  let verifiedCalendarId = typeof action.responseSummary.calendarId === 'string'
    ? cleanString(action.responseSummary.calendarId, 1024, 'Recorded Calendar ID')
    : null
  let calendarSummary = typeof action.responseSummary.calendarSummary === 'string'
    ? cleanString(action.responseSummary.calendarSummary, 300, 'Recorded Calendar summary')
    : null
  let calendarAccessRole = action.responseSummary.calendarAccessRole === 'owner'
    || action.responseSummary.calendarAccessRole === 'writer'
    ? action.responseSummary.calendarAccessRole
    : null

  if (desiredMeetingStatus === 'cancelled') {
    eventId = eventId || currentEventId
    if (eventId) {
      const selectedConnection = await selectedMatonConnection(action, 'google-calendar')
      const calendar = await verifiedCalendarConnection(action, selectedConnection)
      organizerEmail = calendar.organizerEmail
      verifiedCalendarId = calendar.calendarId
      calendarSummary = calendar.calendarSummary
      calendarAccessRole = calendar.accessRole
      const deleteFromPrevious = previousCalendar
        && !sameCalendarSelection(previousCalendar, selectedConnection)
      let response: Response
      if (deleteFromPrevious && previousCalendar) {
        const previous = await verifiedPreviousCalendarSelection(action, previousCalendar)
        organizerEmail = previous.id
        verifiedCalendarId = previous.id
        calendarSummary = previous.summary
        calendarAccessRole = previous.accessRole
        response = await matonFetch(
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(previous.id)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
          { method: 'DELETE' },
          {
            ownerEmail: previousCalendar.credentialOwnerEmail,
            app: 'google-calendar',
            boundConnectionId: previousCalendar.connectionId,
          },
        )
      } else {
        const calendarId = selectedConnection.calendarId || 'primary'
        response = await matonFetch(
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
          { method: 'DELETE' },
          {
            ownerEmail: selectedConnection.credentialOwnerEmail,
            app: 'google-calendar',
            boundConnectionId: selectedConnection.connectionId,
          },
        )
      }
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        throw await providerRequestError('google-calendar', response)
      }
    }
    const summary = {
      eventId,
      eventUrl,
      joinUrl,
      meetingReferenceCode: provisionalMeeting.referenceCode,
      meetingUrl,
      organizerEmail,
      calendarId: verifiedCalendarId,
      calendarSummary,
      calendarAccessRole,
      accountEmail: action.communication?.accountEmail || organizerEmail,
      communicationBindingSource: action.communication?.source || null,
      communicationOrganizationId: action.communication?.organizationId || null,
      meetingStatus: 'cancelled',
      meetingMode,
      customJoinUrl,
    }
    await recordAttemptSucceeded(action, eventId, summary)
    await stageCalendarMeeting(
      action,
      meetingTarget,
      { eventId, eventUrl, joinUrl },
      'cancelled',
    )
    await completeAction(action, eventId, summary)
    return
  }

  if (!eventId || pendingCalendarMove) {
    const selectedConnection = await selectedMatonConnection(action, 'google-calendar')
    const { connectionId } = selectedConnection
    const calendar = await verifiedCalendarConnection(action, selectedConnection)
    organizerEmail = calendar.organizerEmail
    verifiedCalendarId = calendar.calendarId
    calendarSummary = calendar.calendarSummary
    calendarAccessRole = calendar.accessRole
    const calendarId = selectedConnection.calendarId || 'primary'
    const existingEventId = currentEventId || previousCalendar?.eventId || ''
    const existingEventOnSelectedCalendar = Boolean(
      existingEventId
      && previousCalendar
      && previousCalendar.credentialOwnerEmail === selectedConnection.credentialOwnerEmail
      && previousCalendar.connectionId === selectedConnection.connectionId
      && (
        previousCalendar.calendarId === calendar.calendarId
        || previousCalendar.calendarId === calendarId
        || previousCalendar.organizerEmail === calendar.organizerEmail
      ),
    )
    const calendarSelectionChanged = Boolean(existingEventId && !existingEventOnSelectedCalendar)
    const createDestinationEvent = !existingEventId || calendarSelectionChanged
    const verifiedPreviousCalendar = calendarSelectionChanged && previousCalendar
      ? await verifiedPreviousCalendarSelection(action, previousCalendar)
      : null
    if (
      pendingCalendarMove
      && (
        !verifiedPreviousCalendar
        || pendingCalendarMove.destinationCalendarId !== calendar.calendarId
        || pendingCalendarMove.sourceCalendarId !== verifiedPreviousCalendar.id
      )
    ) {
      throw new PermanentCrmIntegrationActionError(
        'The pending Calendar move no longer matches the reviewed source and destination Calendars',
      )
    }
    const requestedEventId = createDestinationEvent
      ? calendarEventIdForMeeting(provisionalMeeting.referenceCode)
      : existingEventId
    const eventBody: JsonObject = {
      ...(createDestinationEvent ? { id: requestedEventId } : {}),
      ...(meetingMode === 'google_meet' ? {
        conferenceData: {
          createRequest: {
            requestId: `clawpilot-${provisionalMeeting.referenceCode}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      } : !createDestinationEvent ? { conferenceData: null } : {}),
      summary: subject,
      description: meetingCalendarDescription(description, provisionalMeeting.referenceCode, meetingUrl),
      location: eventLocation || (!createDestinationEvent ? null : undefined),
      start: { dateTime: startsAt, timeZone: timezone },
      end: { dateTime: endsAt, timeZone: timezone },
      attendees: attendeeEmails.map((email) => ({ email })),
      extendedProperties: {
        private: {
          clawpilotMeetingReference: provisionalMeeting.referenceCode,
          clawpilotPipelineId: action.pipelineId,
        },
      },
    }
    const eventWriteQuery = meetingMode === 'google_meet' || !createDestinationEvent
      ? 'conferenceDataVersion=1&sendUpdates=all'
      : 'sendUpdates=all'
    let delivered: JsonObject
    if (pendingCalendarMove) {
      delivered = {
        id: pendingCalendarMove.destinationEventId,
        htmlLink: eventUrl,
        hangoutLink: joinUrl,
      }
    } else if (!createDestinationEvent) {
      delivered = await matonJson(
        action,
        'google-calendar',
        connectionId,
        `/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingEventId)}?${eventWriteQuery}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody),
        },
      )
    } else {
      try {
        delivered = await matonJson(
          action,
          'google-calendar',
          connectionId,
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${eventWriteQuery}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(eventBody),
          },
        )
      } catch (error) {
        if (!(error instanceof ProviderCrmIntegrationActionError) || error.providerStatus !== 409) throw error
        const existingDestination = await matonJson(
          action,
          'google-calendar',
          connectionId,
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(requestedEventId)}`,
          { headers: { Accept: 'application/json' } },
        )
        const extendedProperties = existingDestination.extendedProperties
          && typeof existingDestination.extendedProperties === 'object'
          && !Array.isArray(existingDestination.extendedProperties)
          ? existingDestination.extendedProperties as JsonObject
          : {}
        const existingPrivate = extendedProperties.private
          && typeof extendedProperties.private === 'object'
          && !Array.isArray(extendedProperties.private)
          ? extendedProperties.private as JsonObject
          : {}
        if (existingPrivate.clawpilotMeetingReference !== provisionalMeeting.referenceCode) {
          throw new PermanentCrmIntegrationActionError(
            'The destination Calendar already contains an event with the reserved ClawPilot ID',
          )
        }
        const patchBody = { ...eventBody }
        delete patchBody.id
        delivered = await matonJson(
          action,
          'google-calendar',
          connectionId,
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(requestedEventId)}?${eventWriteQuery}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody),
          },
        )
      }
    }
    eventId = cleanString(delivered.id, 1000, 'Calendar event ID') || requestedEventId
    if (!eventId) throw new Error('google-calendar provider returned no event ID')
    eventUrl = safeHttpsUrl(delivered.htmlLink) || (calendarSelectionChanged ? null : eventUrl)
    joinUrl = meetingMode === 'google_meet'
      ? safeHttpsUrl(delivered.hangoutLink)
      : meetingMode === 'custom_link'
        ? customJoinUrl
        : null

    if (calendarSelectionChanged && previousCalendar && verifiedPreviousCalendar) {
      const previous = verifiedPreviousCalendar
      const sameVerifiedCalendar = previousCalendar.credentialOwnerEmail === selectedConnection.credentialOwnerEmail
        && previousCalendar.connectionId === selectedConnection.connectionId
        && previous.id === calendar.calendarId
      if (!sameVerifiedCalendar) {
        const pendingMoveSummary = {
          eventId,
          eventUrl,
          joinUrl,
          meetingReferenceCode: provisionalMeeting.referenceCode,
          meetingUrl,
          organizerEmail,
          calendarId: verifiedCalendarId,
          calendarSummary,
          calendarAccessRole,
          accountEmail: action.communication?.accountEmail || organizerEmail,
          communicationBindingSource: action.communication?.source || null,
          communicationOrganizationId: action.communication?.organizationId || null,
          meetingStatus: finalMeetingStatus,
          meetingMode,
          customJoinUrl,
          calendarMove: {
            state: 'destination-written-source-delete-pending',
            sourceEventId: previousCalendar.eventId,
            sourceCalendarId: previous.id,
            destinationEventId: eventId,
            destinationCalendarId: calendar.calendarId,
          },
        }
        await recordAttemptProgress(action, eventId, pendingMoveSummary)
        const response = await matonFetch(
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(previous.id)}/events/${encodeURIComponent(previousCalendar.eventId)}?sendUpdates=all`,
          { method: 'DELETE' },
          {
            ownerEmail: previousCalendar.credentialOwnerEmail,
            app: 'google-calendar',
            boundConnectionId: previousCalendar.connectionId,
          },
        )
        if (!response.ok && response.status !== 404 && response.status !== 410) {
          throw await providerRequestError('google-calendar', response)
        }
      }
    }
  }
  const summary = {
    eventId,
    eventUrl,
    joinUrl,
    meetingReferenceCode: provisionalMeeting.referenceCode,
    meetingUrl,
    organizerEmail,
    calendarId: verifiedCalendarId,
    calendarSummary,
    calendarAccessRole,
    accountEmail: action.communication?.accountEmail || organizerEmail,
    communicationBindingSource: action.communication?.source || null,
    communicationOrganizationId: action.communication?.organizationId || null,
    meetingStatus: finalMeetingStatus,
    meetingMode,
    customJoinUrl,
  }
  await recordAttemptSucceeded(action, eventId, summary)
  await stageCalendarMeeting(
    action,
    meetingTarget,
    { eventId, eventUrl, joinUrl },
    finalMeetingStatus,
  )
  await completeAction(action, eventId, summary)
}

function telUrl(value: unknown): string {
  const raw = cleanString(value, 100, 'CRM phone number')
  const normalized = raw.replace(/[^0-9+*#,;]/g, '')
  if (
    normalized.length < 3
    || normalized.length > 40
    || normalized.slice(1).includes('+')
    || !/[0-9]/.test(normalized)
  ) {
    throw new PermanentCrmIntegrationActionError('CRM phone number cannot be dialed')
  }
  return `tel:${normalized}`
}

async function logCallAction(action: LeasedCrmIntegrationAction, target: CrmReferenceRecord) {
  const url = telUrl(target.phone)
  const subject = requiredString(action.payload.subject, 300, 'Call subject')
  const notes = cleanString(action.payload.notes, 50_000, 'Call notes')
  const activityStatus = normalizeCallActivityStatus(action.payload.activityStatus)
  const durationMinutes = normalizeCallDuration(action.payload.durationMinutes)
  const direction = normalizeCallDirection(action.payload.direction)
  const summary = { telUrl: url, activityStatus, durationMinutes, direction }
  await stageActionInteraction({
    action,
    target,
    subject,
    description: notes,
    interactionType: 'call',
    deliveryStatus: activityStatus === 'planned'
      ? 'planned'
      : activityStatus === 'not_held'
        ? 'not-held'
        : 'logged',
    activityStatus,
    durationMinutes,
    direction,
  })
  await completeAction(action, null, summary)
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => values[key] || '')
}

async function expandCampaignAction(action: LeasedCrmIntegrationAction, target: CrmReferenceRecord) {
  if (target.entity !== 'campaigns') {
    throw new PermanentCrmIntegrationActionError('Campaign action target is no longer a campaign')
  }
  const references = Array.isArray(action.payload.recipientReferences)
    ? action.payload.recipientReferences.map((value) => normalizeReference(value))
    : []
  if (references.length === 0 || references.some((reference) => !CAMPAIGN_RECIPIENT_PATTERN.test(reference))) {
    throw new PermanentCrmIntegrationActionError('Campaign recipient references are invalid')
  }
  const targets = await readCampaignTargets(action.pipelineId, references)
  const targetByReference = new Map(targets.map((record) => [record.reference_code, record]))
  const grouped = new Map<string, {
    target: CampaignTargetRow
    suppressed: boolean
    duplicateCount: number
  }>()
  let missingEmailCount = 0
  for (const reference of references) {
    const recipient = targetByReference.get(reference)
    if (!recipient) throw new PermanentCrmIntegrationActionError('Campaign recipient no longer exists')
    const email = typeof recipient.email === 'string' ? recipient.email.trim().toLowerCase() : ''
    if (!email || !EMAIL_PATTERN.test(email)) {
      missingEmailCount += 1
      continue
    }
    const existing = grouped.get(email)
    if (existing) {
      existing.duplicateCount += 1
      if (recipient.email_opt_out) {
        existing.suppressed = true
        existing.target = recipient
      }
      continue
    }
    grouped.set(email, { target: recipient, suppressed: recipient.email_opt_out, duplicateCount: 0 })
  }

  const subjectTemplate = requiredString(action.payload.subject, 300, 'Campaign subject')
  const textTemplate = requiredString(action.payload.text, 100_000, 'Campaign body')
  const htmlTemplate = cleanString(action.payload.html, 100_000, 'Campaign HTML body')
  const recipientWrites = Array.from(grouped.entries()).map(([email, entry]) => {
    const mergeData = {
      firstName: entry.target.first_name || '',
      lastName: entry.target.last_name || '',
      name: entry.target.full_name,
      email,
      referenceCode: entry.target.reference_code,
    }
    return {
      email,
      contactId: entry.target.entity === 'contacts' ? entry.target.id : null,
      leadId: entry.target.entity === 'leads' ? entry.target.id : null,
      referenceCode: entry.target.reference_code,
      mergeData,
      status: entry.suppressed ? 'suppressed' : 'pending',
      duplicateCount: entry.duplicateCount,
    }
  })

  const summary = await withTransaction(async (client) => {
    const recipients = recipientWrites.length === 0
      ? { rows: [] as Array<{ id: string; email: string; status: string }> }
      : await client.query<{ id: string; email: string; status: string }>(
        `INSERT INTO crm_campaign_recipients (
           pipeline_id, campaign_id, contact_id, lead_id, email, merge_data, status, created_at, updated_at
         )
         SELECT $1::uuid, $2::uuid, item.contact_id::uuid, item.lead_id::uuid, item.email,
           item.merge_data, item.status, now(), now()
         FROM jsonb_to_recordset($3::jsonb) AS item(
           contact_id text, lead_id text, email text, merge_data jsonb, status text
         )
         ON CONFLICT (campaign_id, email) DO UPDATE SET
           contact_id = EXCLUDED.contact_id,
           lead_id = EXCLUDED.lead_id,
           merge_data = EXCLUDED.merge_data,
           status = CASE
             WHEN crm_campaign_recipients.status = 'sent' THEN 'sent'
             WHEN EXCLUDED.status = 'suppressed' THEN 'suppressed'
             WHEN crm_campaign_recipients.integration_action_id IS NOT NULL THEN crm_campaign_recipients.status
             ELSE 'pending'
           END,
           integration_action_id = CASE
             WHEN crm_campaign_recipients.status = 'sent' THEN crm_campaign_recipients.integration_action_id
             WHEN EXCLUDED.status = 'suppressed' THEN NULL
             ELSE crm_campaign_recipients.integration_action_id
           END,
           last_error = CASE WHEN EXCLUDED.status = 'suppressed' THEN NULL ELSE crm_campaign_recipients.last_error END,
           updated_at = now()
         RETURNING id::text, email, status`,
        [
          action.pipelineId,
          target.id,
          JSON.stringify(recipientWrites.map(({ contactId, leadId, mergeData, ...recipient }) => ({
            ...recipient,
            contact_id: contactId,
            lead_id: leadId,
            merge_data: mergeData,
          }))),
        ],
      )
    const writeByEmail = new Map(recipientWrites.map((recipient) => [recipient.email, recipient]))
    let queuedCount = 0
    let suppressedCount = 0
    let duplicateCount = 0
    for (const recipient of recipients.rows) {
      const write = writeByEmail.get(recipient.email)
      if (!write) continue
      duplicateCount += write.duplicateCount
      if (write.status === 'suppressed' || recipient.status === 'suppressed') {
        suppressedCount += 1
        continue
      }
      if (recipient.status === 'sent') continue
      const values = write.mergeData
      const child = await insertPreparedAction(client, {
        pipelineId: action.pipelineId,
        actorEmail: action.actorEmail,
        provider: 'maton',
        app: 'google-mail',
        actionType: 'send_email',
        aggregateType: 'crm_campaign_recipient',
        aggregateId: recipient.id,
        referenceCode: write.referenceCode,
        payload: {
          subject: renderTemplate(subjectTemplate, values),
          text: renderTemplate(textTemplate, values),
          ...(htmlTemplate ? { html: renderTemplate(htmlTemplate, values) } : {}),
          recipientEmail: recipient.email,
          campaignId: target.id,
          campaignRecipientId: recipient.id,
        },
        idempotencyKey: `crm:campaign:${action.id}:recipient:${recipient.id}`,
        communication: action.communication
          && action.communicationCredentialOwnerEmail
          && action.communicationConnectionId
          && action.communication.accountEmail
          && action.communication.identityEmail
          ? {
              organizationId: action.communication.organizationId,
              credentialOwnerEmail: action.communicationCredentialOwnerEmail,
              connectionId: action.communicationConnectionId,
              accountEmail: action.communication.accountEmail,
              identityEmail: action.communication.identityEmail,
              calendarId: action.communication.calendarId,
              source: action.communication.source,
            }
          : null,
      })
      await client.query(
        `UPDATE crm_campaign_recipients
         SET integration_action_id = $2::uuid,
           status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'queued' END,
           last_error = CASE WHEN status = 'sent' THEN last_error ELSE NULL END,
           updated_at = now()
         WHERE id = $1::uuid`,
        [recipient.id, child.action.id],
      )
      queuedCount += 1
    }
    await refreshCampaignCountsWithClient(client, target.id)
    return {
      recipientCount: grouped.size,
      queuedCount,
      suppressedCount,
      duplicateCount,
      missingEmailCount,
    }
  })

  await stageActionInteraction({
    action,
    target,
    subject: `Campaign queued: ${target.name || target.referenceCode}`,
    description: `${summary.queuedCount} recipients queued; ${summary.suppressedCount} suppressed.`,
    interactionType: 'campaign',
    deliveryStatus: 'queued',
  })
  await completeAction(action, null, summary)
}

async function loadActionTarget(action: LeasedCrmIntegrationAction): Promise<CrmReferenceRecord> {
  if (!action.referenceCode) throw new PermanentCrmIntegrationActionError('CRM action has no record reference')
  try {
    return await readCrmRecordByReference({
      pipelineId: action.pipelineId,
      referenceCode: action.referenceCode,
    })
  } catch (error) {
    if (error instanceof Error && /not found|invalid/i.test(error.message)) {
      throw new PermanentCrmIntegrationActionError('Referenced CRM record is no longer available')
    }
    throw error
  }
}

export async function processCrmIntegrationAction(
  action: LeasedCrmIntegrationAction,
  options: { maxAttempts?: number; retryBaseSeconds?: number } = {},
): Promise<CrmIntegrationActionView> {
  try {
    const target = await loadActionTarget(action)
    if (action.actionType === 'send_email') await sendEmailAction(action, target)
    else if (action.actionType === 'create_calendar_event') await createCalendarEventAction(action, target)
    else if (action.actionType === 'log_call') await logCallAction(action, target)
    else if (action.actionType === 'send_campaign') await expandCampaignAction(action, target)
    else throw new PermanentCrmIntegrationActionError('CRM action type is not supported')
  } catch (error) {
    await failAction({
      action,
      error,
      maxAttempts: Math.max(1, Math.min(Math.trunc(Number(options.maxAttempts) || 5), 20)),
      retryBaseSeconds: Math.max(5, Math.min(Math.trunc(Number(options.retryBaseSeconds) || 30), 3600)),
      permanent: error instanceof PermanentCrmIntegrationActionError || isPermanentProviderFailure(error),
    })
  }
  return readCrmIntegrationAction({
    actionId: action.id,
    pipelineId: action.pipelineId,
    actorEmail: action.actorEmail,
  })
}

export async function processCrmIntegrationActionNow(input: {
  actionId: unknown
  pipelineId: unknown
  actorEmail: unknown
  maxAttempts?: number
  retryBaseSeconds?: number
}): Promise<CrmIntegrationActionView> {
  const leased = await leaseCrmIntegrationActions({
    limit: 1,
    actionId: input.actionId,
    pipelineId: input.pipelineId,
    actorEmail: input.actorEmail,
    maxAttempts: input.maxAttempts,
  })
  if (leased[0]) {
    return processCrmIntegrationAction(leased[0], {
      maxAttempts: input.maxAttempts,
      retryBaseSeconds: input.retryBaseSeconds,
    })
  }
  return readCrmIntegrationAction(input)
}

export async function processDueCrmIntegrationActions(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
  retryBaseSeconds?: number
} = {}) {
  const actions = await leaseCrmIntegrationActions(input)
  const results: CrmIntegrationActionView[] = []
  for (const action of actions) {
    results.push(await processCrmIntegrationAction(action, input))
  }
  return results
}

export async function retryCrmIntegrationAction(input: {
  actionId: unknown
  pipelineId: unknown
  actorEmail: unknown
  reviewed?: unknown
  reason?: unknown
}): Promise<CrmIntegrationActionView> {
  const actionId = normalizeUuid(input.actionId, 'CRM action ID')
  const pipelineId = normalizeUuid(input.pipelineId, 'Pipeline ID')
  const actorEmail = normalizeUserEmail(input.actorEmail)
  const reviewed = input.reviewed === true
  const reason = cleanString(input.reason, 1000, 'CRM action retry reason')
  await withTransaction(async (client) => {
    const selected = await client.query<ActionRow>(
      `SELECT *
       FROM crm_integration_actions
       WHERE id = $1::uuid AND pipeline_id = $2::uuid AND actor_email = $3
       FOR UPDATE`,
      [actionId, pipelineId, actorEmail],
    )
    const current = selected.rows[0]
    if (!current) {
      throw new CrmIntegrationActionError('CRM action was not found', 404, 'CRM_ACTION_NOT_FOUND')
    }
    if (current.status !== 'failed' && current.status !== 'dead') {
      throw new CrmIntegrationActionError('Only failed or dead CRM actions can be retried', 409, 'CRM_ACTION_NOT_RETRYABLE')
    }
    if (current.status === 'dead' && (!reviewed || !reason)) {
      throw new CrmIntegrationActionError(
        'Retrying a dead CRM action requires an explicit review and reason',
        409,
        'CRM_ACTION_RETRY_REVIEW_REQUIRED',
      )
    }
    if (
      current.provider === 'maton'
      && (
        !current.workspace_organization_id
        || !current.communication_credential_owner_email
        || !current.communication_connection_id
        || !current.communication_account_email
        || !current.communication_identity_email
        || !current.communication_binding_source
        || (current.app === 'google-calendar' && !current.communication_calendar_id)
      )
    ) {
      throw new CrmIntegrationActionError(
        'This historical communication action has no reviewed identity snapshot; create a new action instead',
        409,
        'CRM_ACTION_COMMUNICATION_SNAPSHOT_REQUIRED',
      )
    }
    const authorizedThroughAttempt = current.status === 'dead'
      ? Number(current.attempts) + 1
      : null
    const retried = await client.query<ActionRow>(
      `UPDATE crm_integration_actions
       SET status = 'queued', available_at = now(), last_error = NULL,
         response_summary = COALESCE(response_summary, '{}'::jsonb) || jsonb_build_object(
           'operatorRetry', jsonb_build_object(
             'reviewed', $4::boolean,
             'reason', NULLIF($5::text, ''),
             'authorizedThroughAttempt', $6::integer,
             'reviewedAt', now()
           )
         ),
         processed_at = NULL, locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND pipeline_id = $2::uuid AND actor_email = $3
         AND status IN ('failed', 'dead')
       RETURNING *`,
      [actionId, pipelineId, actorEmail, reviewed, reason, authorizedThroughAttempt],
    )
    const row = retried.rows[0]
    if (!row) throw new CrmIntegrationActionError('CRM action is no longer retryable', 409, 'CRM_ACTION_NOT_RETRYABLE')
    if (row.action_type === 'create_calendar_event') {
      await client.query(
        `UPDATE crm_meetings
         SET status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
           source_payload = COALESCE(source_payload, '{}'::jsonb) || jsonb_build_object(
             'calendarDeliveryStatus', 'queued',
             'calendarDeliveryError', NULL,
             'calendarDeliveryFailure', NULL
           ),
           updated_at = now()
         WHERE pipeline_id = $1::uuid
           AND (
             source_payload->>'actionId' = $2
             OR ($3 = 'crm_meeting' AND id = $4::uuid)
           )`,
        [
          row.pipeline_id,
          row.id,
          row.aggregate_type,
          row.aggregate_type === 'crm_meeting' ? row.aggregate_id : null,
        ],
      )
    }
    await auditAction(client, {
      id: row.id,
      actorEmail: row.actor_email,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      pipelineId: row.pipeline_id,
      actionType: row.action_type,
      referenceCode: row.reference_code || '',
      provider: row.provider || 'internal',
      app: row.app,
    }, 'crm.integration_action.retried', {
      previousStatus: current.status,
      reason: reason || null,
      reviewed,
      authorizedThroughAttempt,
    })
  })
  return readCrmIntegrationAction(input)
}

export const enqueueCrmIntegrationActionInPostgres = enqueueCrmIntegrationAction
export const claimCrmIntegrationActionsInPostgres = leaseCrmIntegrationActions
export const readCrmIntegrationActionInPostgres = readCrmIntegrationAction
