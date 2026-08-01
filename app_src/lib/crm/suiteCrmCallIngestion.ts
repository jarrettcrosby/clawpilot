import { decodeHtmlEntities } from '@/lib/htmlEntities.mjs'
import {
  listSuiteCrmCallsUpdatedSince,
  type SuiteCrmCallSnapshot,
} from '@/lib/crm/suiteCrmClient'
import {
  archiveCrmRecordInPostgres,
  stageCrmRecordInPostgres,
  type StageInteractionInput,
} from '@/lib/persistence/crm'
import { query } from '@/lib/persistence/postgres'

const CURSOR_KEY = 'crm.suitecrm.call_ingestion.cursor'
const FULL_HISTORY_START = '1970-01-01T00:00:00.000Z'
export const SUITE_CRM_CALL_POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_PAGES_PER_RUN = 10

type TimestampValue = string | Date
type InteractionFields = StageInteractionInput['fields']

type CursorState = {
  updatedSince: string
  pollStartedAt: string
  page: number
}

type CursorDocument = {
  state: CursorState | null
  lastPolledAt: string | null
  lastError: string | null
}

type CallInteractionRow = {
  id: string
  pipeline_id: string
  owner_email: string
  suitecrm_id: string | null
  reference_code: string
  source_key: string
  source_sheet_id: string | null
  source_row_number: number | null
  source_payload: Record<string, unknown> | null
  organization_id: string | null
  contact_id: string | null
  contact_ids: string[] | null
  lead_id: string | null
  opportunity_id: string | null
  meeting_id: string | null
  campaign_id: string | null
  interaction_type: string | null
  suitecrm_module: 'Notes' | 'Calls' | 'Meetings' | null
  subject: string
  agent_email: string | null
  agent_name: string | null
  occurred_at: TimestampValue | null
  description: string | null
  direction: 'inbound' | 'outbound' | 'internal'
  activity_status: 'planned' | 'held' | 'not_held' | null
  duration_minutes: number | null
  delivery_status: string | null
  provider_message_id: string | null
  provider_thread_id: string | null
  metadata: Record<string, unknown> | null
}

type ParentRow = {
  relationship_id: string
  organization_id: string | null
}

export type SuiteCrmCallParentType =
  | 'Accounts'
  | 'Contacts'
  | 'Leads'
  | 'Opportunities'
  | 'Meetings'

export type SuiteCrmCallParent = {
  type: SuiteCrmCallParentType
  id: string
}

export type SuiteCrmCallParentParseResult =
  | { status: 'valid'; parent: SuiteCrmCallParent }
  | { status: 'none' | 'invalid' }

type ParentResolution =
  | {
    status: 'resolved'
    parent: SuiteCrmCallParent
    relationshipId: string
    organizationId: string | null
  }
  | { status: 'unresolved'; parent: SuiteCrmCallParent | null }
  | { status: 'ambiguous'; parent: SuiteCrmCallParent }

type CallInteractionMatchResult = {
  rows: CallInteractionRow[]
  ambiguousPipelines: number
}

export type SuiteCrmCallIngestionCounts = {
  pagesPolled: number
  callsListed: number
  callsMatched: number
  interactionsMatched: number
  interactionsStaged: number
  unchangedInteractions: number
  unmatchedCalls: number
  ambiguousInteractionMatches: number
  parentsResolved: number
  parentsUnresolved: number
  parentsAmbiguous: number
  interactionsArchived: number
  deletedCallsIgnored: number
  pending: boolean
  errors: number
}

class SafeSuiteCrmCallIngestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeSuiteCrmCallIngestionError'
  }
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function hasAttribute(attributes: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(attributes, key)
}

function cleanString(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length > maxLength) {
    throw new SafeSuiteCrmCallIngestionError(`SuiteCRM ${label} is invalid`)
  }
  return normalized
}

function cleanMultiline(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (normalized.length > maxLength || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new SafeSuiteCrmCallIngestionError(`SuiteCRM ${label} is invalid`)
  }
  return normalized
}

function storedString(value: unknown): string {
  return String(value ?? '').trim()
}

function nullableStoredString(value: unknown): string | null {
  return storedString(value) || null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseCursor(value: unknown): CursorDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const document = value as Record<string, unknown>
  const lastPolledAt = validDate(document.lastPolledAt)?.toISOString() || null
  const rawState = document.state
  if (rawState === null) return { state: null, lastPolledAt, lastError: null }
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return null
  const state = rawState as Record<string, unknown>
  const updatedSince = validDate(state.updatedSince)
  const pollStartedAt = validDate(state.pollStartedAt)
  const page = Number(state.page)
  if (!updatedSince || !pollStartedAt || !Number.isSafeInteger(page) || page < 1) return null
  return {
    state: {
      updatedSince: updatedSince.toISOString(),
      pollStartedAt: pollStartedAt.toISOString(),
      page,
    },
    lastPolledAt,
    lastError: null,
  }
}

async function readCursor(): Promise<CursorDocument | null> {
  const result = await query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [CURSOR_KEY],
  )
  return parseCursor(result.rows[0]?.value)
}

async function writeCursor(document: CursorDocument): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CURSOR_KEY, JSON.stringify(document)],
  )
}

export function suiteCrmCallGlobalId(snapshot: SuiteCrmCallSnapshot): string | null {
  const value = String(snapshot.attributes.global_id_c ?? '').trim().toLowerCase()
  return /^gi(?:[0-9]{7}|[0-9a-v]{12})$/.test(value) ? value : null
}

export function parseSuiteCrmCallParent(
  attributes: Record<string, unknown>,
): SuiteCrmCallParentParseResult {
  const parentType = String(attributes.parent_type ?? '').trim()
  const parentId = String(attributes.parent_id ?? '').trim()
  if (!parentType && !parentId) return { status: 'none' }
  if (
    !parentType
    || !parentId
    || parentType.length > 64
    || parentId.length > 64
    || /[\u0000-\u001f\u007f]/.test(parentType)
    || /[\u0000-\u001f\u007f]/.test(parentId)
  ) return { status: 'invalid' }
  const type = ({
    accounts: 'Accounts',
    contacts: 'Contacts',
    leads: 'Leads',
    opportunities: 'Opportunities',
    meetings: 'Meetings',
  } as const)[parentType.toLowerCase()]
  return type
    ? { status: 'valid', parent: { type, id: parentId } }
    : { status: 'invalid' }
}

function suiteCrmSnapshotIsDeleted(snapshot: SuiteCrmCallSnapshot): boolean {
  const value = snapshot.attributes.deleted
  if (value === true || value === 1) return true
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalized === 'true' || normalized === '1'
}

function suiteTimestamp(value: unknown, label: string): string {
  const parsed = validDate(value)
  if (!parsed) throw new SafeSuiteCrmCallIngestionError(`SuiteCRM call ${label} is invalid`)
  return parsed.toISOString()
}

async function localCallInteractions(snapshot: SuiteCrmCallSnapshot): Promise<CallInteractionMatchResult> {
  const globalId = suiteCrmCallGlobalId(snapshot)
  const result = await query<CallInteractionRow>(
    `SELECT interaction.id::text, interaction.pipeline_id::text, pipeline.owner_email,
       interaction.suitecrm_id, interaction.reference_code, interaction.source_key,
       interaction.source_sheet_id, interaction.source_row_number, interaction.source_payload,
       interaction.organization_id::text, interaction.contact_id::text,
       ARRAY(
         SELECT selected.contact_id::text
         FROM crm_interaction_contacts selected
         WHERE selected.pipeline_id = interaction.pipeline_id
           AND selected.interaction_id = interaction.id
         ORDER BY selected.sort_order, selected.contact_id
       ) AS contact_ids,
       interaction.lead_id::text,
       interaction.opportunity_id::text, interaction.meeting_id::text, interaction.campaign_id::text,
       interaction.interaction_type, interaction.suitecrm_module,
       interaction.subject, interaction.agent_email, interaction.agent_name,
       interaction.occurred_at, interaction.description, interaction.direction,
       interaction.activity_status, interaction.duration_minutes,
       interaction.delivery_status, interaction.provider_message_id,
       interaction.provider_thread_id, interaction.metadata
     FROM crm_interactions interaction
     JOIN pipeline_spaces pipeline ON pipeline.id = interaction.pipeline_id
     WHERE lower(COALESCE(interaction.interaction_type, '')) = 'call'
       AND (
         interaction.suitecrm_id = $1
         OR ($2 <> '' AND interaction.reference_code = $2)
       )
     ORDER BY interaction.pipeline_id, interaction.id`,
    [snapshot.id, globalId || ''],
  )
  const rowsByPipeline = new Map<string, CallInteractionRow[]>()
  for (const row of result.rows) {
    const pipelineRows = rowsByPipeline.get(row.pipeline_id) || []
    pipelineRows.push(row)
    rowsByPipeline.set(row.pipeline_id, pipelineRows)
  }
  const rows: CallInteractionRow[] = []
  let ambiguousPipelines = 0
  for (const pipelineRows of rowsByPipeline.values()) {
    if (pipelineRows.length === 1) rows.push(pipelineRows[0])
    else ambiguousPipelines += 1
  }
  return { rows, ambiguousPipelines }
}

async function parentRows(
  pipelineId: string,
  parent: SuiteCrmCallParent,
): Promise<ParentRow[]> {
  if (parent.type === 'Accounts') {
    const result = await query<ParentRow>(
      `SELECT organization.id::text AS relationship_id,
         organization.id::text AS organization_id
       FROM crm_organizations organization
       WHERE organization.pipeline_id = $1::uuid AND organization.suitecrm_id = $2
       ORDER BY organization.id
       LIMIT 2`,
      [pipelineId, parent.id],
    )
    return result.rows
  }
  if (parent.type === 'Contacts') {
    const result = await query<ParentRow>(
      `SELECT contact.id::text AS relationship_id,
         contact.organization_id::text AS organization_id
       FROM crm_contacts contact
       WHERE contact.pipeline_id = $1::uuid AND contact.suitecrm_id = $2
       ORDER BY contact.id
       LIMIT 2`,
      [pipelineId, parent.id],
    )
    return result.rows
  }
  if (parent.type === 'Leads') {
    const result = await query<ParentRow>(
      `SELECT lead.id::text AS relationship_id,
         lead.organization_id::text AS organization_id
       FROM crm_leads lead
       WHERE lead.pipeline_id = $1::uuid AND lead.suitecrm_id = $2
       ORDER BY lead.id
       LIMIT 2`,
      [pipelineId, parent.id],
    )
    return result.rows
  }
  if (parent.type === 'Opportunities') {
    const result = await query<ParentRow>(
      `SELECT opportunity.id::text AS relationship_id,
         opportunity.organization_id::text AS organization_id
       FROM crm_opportunities opportunity
       WHERE opportunity.pipeline_id = $1::uuid AND opportunity.suitecrm_id = $2
       ORDER BY opportunity.id
       LIMIT 2`,
      [pipelineId, parent.id],
    )
    return result.rows
  }
  const result = await query<ParentRow>(
    `SELECT meeting.id::text AS relationship_id,
       COALESCE(
         meeting.organization_id,
         contact.organization_id,
         lead.organization_id,
         opportunity.organization_id
       )::text AS organization_id
     FROM crm_meetings meeting
     LEFT JOIN crm_contacts contact
       ON contact.pipeline_id = meeting.pipeline_id AND contact.id = meeting.contact_id
     LEFT JOIN crm_leads lead
       ON lead.pipeline_id = meeting.pipeline_id AND lead.id = meeting.lead_id
     LEFT JOIN crm_opportunities opportunity
       ON opportunity.pipeline_id = meeting.pipeline_id AND opportunity.id = meeting.opportunity_id
     WHERE meeting.pipeline_id = $1::uuid AND meeting.suitecrm_id = $2
     ORDER BY meeting.id
     LIMIT 2`,
    [pipelineId, parent.id],
  )
  return result.rows
}

async function resolveParent(
  pipelineId: string,
  parsedParent: SuiteCrmCallParentParseResult,
): Promise<ParentResolution> {
  if (parsedParent.status !== 'valid') return { status: 'unresolved', parent: null }
  const rows = await parentRows(pipelineId, parsedParent.parent)
  if (rows.length === 0) return { status: 'unresolved', parent: parsedParent.parent }
  if (rows.length > 1) return { status: 'ambiguous', parent: parsedParent.parent }
  return {
    status: 'resolved',
    parent: parsedParent.parent,
    relationshipId: rows[0].relationship_id,
    organizationId: nullableStoredString(rows[0].organization_id),
  }
}

function currentRelations(row: CallInteractionRow): Pick<
  InteractionFields,
  'organizationId' | 'contactId' | 'contactIds' | 'leadId' | 'opportunityId' | 'meetingId' | 'campaignId'
> {
  const contactId = nullableStoredString(row.contact_id)
  const contactIds = Array.isArray(row.contact_ids)
    ? row.contact_ids.map(nullableStoredString).filter((value): value is string => Boolean(value))
    : []
  return {
    organizationId: nullableStoredString(row.organization_id),
    contactId,
    contactIds: contactIds.length > 0 ? [...new Set(contactIds)] : contactId ? [contactId] : [],
    leadId: nullableStoredString(row.lead_id),
    opportunityId: nullableStoredString(row.opportunity_id),
    meetingId: nullableStoredString(row.meeting_id),
    campaignId: nullableStoredString(row.campaign_id),
  }
}

function interactionRelations(
  row: CallInteractionRow,
  parent: ParentResolution,
): Pick<
  InteractionFields,
  | 'organizationId'
  | 'contactId'
  | 'contactIds'
  | 'leadId'
  | 'opportunityId'
  | 'meetingId'
  | 'campaignId'
  | 'parentSuiteCrmId'
  | 'parentSuiteCrmType'
> {
  const current = currentRelations(row)
  if (parent.status !== 'resolved') return current
  const contactIds = parent.parent.type === 'Contacts'
    ? [parent.relationshipId, ...(current.contactIds || []).filter((id) => id !== parent.relationshipId)]
    : current.contactIds
  return {
    organizationId: parent.organizationId || current.organizationId,
    contactId: parent.parent.type === 'Contacts' ? parent.relationshipId : current.contactId,
    contactIds,
    leadId: parent.parent.type === 'Leads' ? parent.relationshipId : current.leadId,
    opportunityId: parent.parent.type === 'Opportunities' ? parent.relationshipId : current.opportunityId,
    meetingId: parent.parent.type === 'Meetings' ? parent.relationshipId : current.meetingId,
    campaignId: current.campaignId,
    parentSuiteCrmId: parent.parent.id,
    parentSuiteCrmType: parent.parent.type,
  }
}

function suiteCrmCallDirection(
  value: unknown,
  current: CallInteractionRow['direction'],
): CallInteractionRow['direction'] {
  const direction = cleanString(value, 100, 'call direction').toLowerCase()
  if (direction === 'inbound' || direction === 'outbound') return direction
  return current
}

function suiteCrmCallDeliveryStatus(value: unknown, current: string | null): string {
  const status = cleanString(value, 100, 'call status').toLowerCase().replace(/[_-]+/g, ' ')
  if (status === 'planned') return 'planned'
  if (status === 'held') return 'logged'
  if (status === 'not held') return 'not-held'
  return cleanString(current, 100, 'stored call status')
}

function suiteCrmCallActivityStatus(
  value: unknown,
  current: CallInteractionRow['activity_status'],
): NonNullable<InteractionFields['activityStatus']> {
  const status = cleanString(value, 100, 'call status').toLowerCase().replace(/[_-]+/g, ' ')
  if (status === 'planned') return 'planned'
  if (status === 'held') return 'held'
  if (status === 'not held') return 'not_held'
  return current || 'held'
}

function suiteCrmCallDuration(attributes: Record<string, unknown>): number | null {
  if (!hasAttribute(attributes, 'duration_hours') && !hasAttribute(attributes, 'duration_minutes')) return null
  const hours = Number(attributes.duration_hours ?? 0)
  const minutes = Number(attributes.duration_minutes ?? 0)
  if (
    !Number.isFinite(hours)
    || !Number.isFinite(minutes)
    || hours < 0
    || minutes < 0
    || hours > 24
    || minutes > 1440
  ) {
    throw new SafeSuiteCrmCallIngestionError('SuiteCRM call duration is invalid')
  }
  return Math.max(1, Math.min(Math.round(hours * 60 + minutes), 24 * 60))
}

function interactionFields(
  snapshot: SuiteCrmCallSnapshot,
  row: CallInteractionRow,
  parent: ParentResolution,
): InteractionFields {
  const attributes = snapshot.attributes
  const currentSubject = cleanString(row.subject, 300, 'stored call subject')
  if (!currentSubject) throw new SafeSuiteCrmCallIngestionError('Stored CRM call interaction subject is invalid')
  const inboundSubject = hasAttribute(attributes, 'name')
    ? cleanString(attributes.name, 300, 'call subject')
    : ''
  const currentDescription = cleanMultiline(row.description, 50_000, 'stored call description')
  const description = hasAttribute(attributes, 'description')
    ? cleanMultiline(attributes.description, 50_000, 'call description')
    : currentDescription
  const currentOccurredAt = validDate(row.occurred_at)?.toISOString() || null
  const occurredAt = hasAttribute(attributes, 'date_start') && storedString(attributes.date_start)
    ? suiteTimestamp(attributes.date_start, 'start time')
    : currentOccurredAt || (hasAttribute(attributes, 'date_entered') && storedString(attributes.date_entered)
      ? suiteTimestamp(attributes.date_entered, 'created time')
      : null)
  return {
    ...interactionRelations(row, parent),
    interactionType: 'call',
    suiteCrmModule: 'Calls',
    subject: inboundSubject || currentSubject,
    agentEmail: nullableStoredString(row.agent_email),
    agentName: cleanString(row.agent_name, 300, 'stored call agent'),
    occurredAt,
    description,
    direction: hasAttribute(attributes, 'direction')
      ? suiteCrmCallDirection(attributes.direction, row.direction)
      : row.direction,
    activityStatus: hasAttribute(attributes, 'status')
      ? suiteCrmCallActivityStatus(attributes.status, row.activity_status)
      : row.activity_status || 'held',
    durationMinutes: suiteCrmCallDuration(attributes) ?? row.duration_minutes ?? 15,
    deliveryStatus: hasAttribute(attributes, 'status')
      ? suiteCrmCallDeliveryStatus(attributes.status, row.delivery_status)
      : cleanString(row.delivery_status, 100, 'stored call status'),
    providerMessageId: nullableStoredString(row.provider_message_id),
    providerThreadId: nullableStoredString(row.provider_thread_id),
    metadata: objectValue(row.metadata),
  }
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  const leftDate = validDate(left)
  const rightDate = validDate(right)
  return leftDate?.getTime() === rightDate?.getTime()
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(objectValue(left)) === JSON.stringify(objectValue(right))
}

function hasMeaningfulChanges(row: CallInteractionRow, fields: InteractionFields): boolean {
  return (
    cleanString(row.subject, 300, 'stored call subject') !== fields.subject
    || row.suitecrm_module !== fields.suiteCrmModule
    || cleanMultiline(row.description, 50_000, 'stored call description') !== fields.description
    || !sameTimestamp(row.occurred_at, fields.occurredAt)
    || row.direction !== fields.direction
    || cleanString(row.delivery_status, 100, 'stored call status') !== fields.deliveryStatus
    || row.activity_status !== fields.activityStatus
    || Number(row.duration_minutes ?? 0) !== Number(fields.durationMinutes ?? 0)
    || !sameJson(row.metadata, fields.metadata)
    || nullableStoredString(row.organization_id) !== nullableStoredString(fields.organizationId)
    || nullableStoredString(row.contact_id) !== nullableStoredString(fields.contactId)
    || nullableStoredString(row.lead_id) !== nullableStoredString(fields.leadId)
    || nullableStoredString(row.opportunity_id) !== nullableStoredString(fields.opportunityId)
    || nullableStoredString(row.meeting_id) !== nullableStoredString(fields.meetingId)
  )
}

function matchBasis(
  row: CallInteractionRow,
  snapshot: SuiteCrmCallSnapshot,
): 'suitecrm_id' | 'global_id_c' | 'suitecrm_id_and_global_id_c' {
  const suiteCrmIdMatch = nullableStoredString(row.suitecrm_id) === snapshot.id
  const globalIdMatch = row.reference_code === suiteCrmCallGlobalId(snapshot)
  if (suiteCrmIdMatch && globalIdMatch) return 'suitecrm_id_and_global_id_c'
  return suiteCrmIdMatch ? 'suitecrm_id' : 'global_id_c'
}

function suiteCrmInboundSourcePayload(
  row: CallInteractionRow,
  snapshot: SuiteCrmCallSnapshot,
  dateModified: string,
  parent: ParentResolution,
): Record<string, unknown> {
  const parsedParent = parent.parent
  return {
    ...objectValue(row.source_payload),
    suiteCrmInbound: {
      module: 'Calls',
      id: snapshot.id,
      globalId: suiteCrmCallGlobalId(snapshot),
      dateModified,
      matchedBy: matchBasis(row, snapshot),
      parent: parsedParent ? { type: parsedParent.type, id: parsedParent.id } : null,
      parentResolution: parent.status,
    },
  }
}

async function reconcileCallInteraction(
  snapshot: SuiteCrmCallSnapshot,
  row: CallInteractionRow,
  parsedParent: SuiteCrmCallParentParseResult,
): Promise<{ staged: boolean; parentStatus: ParentResolution['status'] }> {
  const parent = await resolveParent(row.pipeline_id, parsedParent)
  const fields = interactionFields(snapshot, row, parent)
  if (!hasMeaningfulChanges(row, fields)) return { staged: false, parentStatus: parent.status }
  const dateModified = suiteTimestamp(snapshot.attributes.date_modified, 'modified time')
  await stageCrmRecordInPostgres({
    entity: 'interactions',
    pipelineId: row.pipeline_id,
    localId: row.id,
    sourceKey: row.source_key,
    sourceSheetId: row.source_sheet_id,
    sourceRowNumber: row.source_row_number,
    sourcePayload: suiteCrmInboundSourcePayload(row, snapshot, dateModified, parent),
    actorEmail: row.owner_email,
    emitSuiteCrmOutbox: false,
    fields,
  })
  return { staged: true, parentStatus: parent.status }
}

function recordParentStatus(
  status: ParentResolution['status'],
  counts: SuiteCrmCallIngestionCounts,
): void {
  if (status === 'resolved') counts.parentsResolved += 1
  else if (status === 'ambiguous') counts.parentsAmbiguous += 1
  else counts.parentsUnresolved += 1
}

export function sanitizeSuiteCrmCallIngestionError(error: unknown): string {
  return error instanceof SafeSuiteCrmCallIngestionError
    ? error.message.replace(/[\r\n]+/g, ' ').trim().slice(0, 500)
    : 'SuiteCRM call ingestion failed'
}

export async function processSuiteCrmCallIngestion(): Promise<SuiteCrmCallIngestionCounts> {
  const counts: SuiteCrmCallIngestionCounts = {
    pagesPolled: 0,
    callsListed: 0,
    callsMatched: 0,
    interactionsMatched: 0,
    interactionsStaged: 0,
    unchangedInteractions: 0,
    unmatchedCalls: 0,
    ambiguousInteractionMatches: 0,
    parentsResolved: 0,
    parentsUnresolved: 0,
    parentsAmbiguous: 0,
    interactionsArchived: 0,
    deletedCallsIgnored: 0,
    pending: false,
    errors: 0,
  }
  const now = new Date()
  const cursor = await readCursor()
  let state: CursorState = cursor?.state || {
    updatedSince: cursor?.lastPolledAt
      ? new Date(Date.parse(cursor.lastPolledAt) - SUITE_CRM_CALL_POLL_OVERLAP_MS).toISOString()
      : FULL_HISTORY_START,
    pollStartedAt: now.toISOString(),
    page: 1,
  }

  try {
    await writeCursor({ state, lastPolledAt: now.toISOString(), lastError: null })
    for (let attempt = 0; attempt < MAX_PAGES_PER_RUN; attempt += 1) {
      const page = await listSuiteCrmCallsUpdatedSince({
        updatedSince: state.updatedSince,
        page: state.page,
      })
      counts.pagesPolled += 1
      counts.callsListed += page.calls.length
      for (const snapshot of page.calls) {
        const matches = await localCallInteractions(snapshot)
        counts.ambiguousInteractionMatches += matches.ambiguousPipelines
        if (suiteCrmSnapshotIsDeleted(snapshot)) {
          if (matches.rows.length === 0) {
            counts.deletedCallsIgnored += 1
            continue
          }
          counts.callsMatched += 1
          for (const row of matches.rows) {
            counts.interactionsMatched += 1
            const result = await archiveCrmRecordInPostgres({
              pipelineId: row.pipeline_id,
              entity: 'interactions',
              id: row.id,
              actorEmail: row.owner_email,
              emitSuiteCrmOutbox: false,
              archiveSource: 'suitecrm',
            })
            if (result.changed) counts.interactionsArchived += 1
          }
          continue
        }
        if (matches.rows.length === 0) {
          if (matches.ambiguousPipelines === 0) counts.unmatchedCalls += 1
          continue
        }
        counts.callsMatched += 1
        const parsedParent = parseSuiteCrmCallParent(snapshot.attributes)
        for (const row of matches.rows) {
          counts.interactionsMatched += 1
          const result = await reconcileCallInteraction(snapshot, row, parsedParent)
          recordParentStatus(result.parentStatus, counts)
          if (result.staged) counts.interactionsStaged += 1
          else counts.unchangedInteractions += 1
        }
      }
      if (state.page >= page.totalPages) {
        await writeCursor({ state: null, lastPolledAt: state.pollStartedAt, lastError: null })
        return counts
      }
      state = { ...state, page: state.page + 1 }
      await writeCursor({ state, lastPolledAt: new Date().toISOString(), lastError: null })
    }
    counts.pending = true
    return counts
  } catch (error) {
    counts.errors += 1
    await writeCursor({
      state,
      lastPolledAt: new Date().toISOString(),
      lastError: sanitizeSuiteCrmCallIngestionError(error),
    })
    return counts
  }
}
