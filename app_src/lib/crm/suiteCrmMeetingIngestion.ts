import crypto from 'node:crypto'
import {
  resolveRecordedCrmMeetingCalendarCommunication,
  stageCrmMeetingAndEnqueueCalendarAction,
} from '@/lib/crm/integrationActions'
import { decodeHtmlEntities } from '@/lib/htmlEntities.mjs'
import {
  listSuiteCrmMeetingsUpdatedSince,
  type SuiteCrmMeetingSnapshot,
} from '@/lib/crm/suiteCrmClient'
import type { CrmMeeting } from '@/lib/crm/types'
import {
  stageCrmRecordWithClient,
  type StageMeetingInput,
} from '@/lib/persistence/crm'
import { query, withTransaction } from '@/lib/persistence/postgres'

const CURSOR_KEY = 'crm.suitecrm.meeting_ingestion.cursor'
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_PAGES_PER_RUN = 10

type TimestampValue = string | Date
type MeetingFields = StageMeetingInput['fields']

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

type MeetingRow = {
  id: string
  pipeline_id: string
  owner_email: string
  organization_id: string | null
  contact_id: string | null
  lead_id: string | null
  opportunity_id: string | null
  source_key: string
  source_hash: string
  reference_code: string
  subject: string
  description: string | null
  starts_at: TimestampValue
  ends_at: TimestampValue
  timezone: string
  location: string | null
  attendee_emails: string[] | null
  status: CrmMeeting['status']
  provider: string | null
  external_event_id: string | null
  external_event_url: string | null
  join_url: string | null
  source_payload: Record<string, unknown> | null
  organization_suitecrm_id: string | null
  contact_suitecrm_id: string | null
  lead_suitecrm_id: string | null
  opportunity_suitecrm_id: string | null
}

export type SuiteCrmMeetingIngestionCounts = {
  pagesPolled: number
  meetingsListed: number
  meetingsMatched: number
  meetingsStaged: number
  calendarActionsQueued: number
  unchangedMeetings: number
  unmatchedMeetings: number
  pending: boolean
  errors: number
}

class SafeSuiteCrmMeetingIngestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeSuiteCrmMeetingIngestionError'
  }
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function cleanString(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length > maxLength) throw new SafeSuiteCrmMeetingIngestionError(`SuiteCRM ${label} is invalid`)
  return normalized
}

function cleanMultiline(value: unknown, maxLength: number, label: string): string {
  const normalized = decodeHtmlEntities(value).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim()
  if (normalized.length > maxLength || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new SafeSuiteCrmMeetingIngestionError(`SuiteCRM ${label} is invalid`)
  }
  return normalized
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

async function localMeeting(suiteCrmId: string): Promise<MeetingRow | null> {
  const result = await query<MeetingRow>(
    `SELECT meeting.id::text, meeting.pipeline_id::text, pipeline.owner_email,
       meeting.organization_id::text, meeting.contact_id::text, meeting.lead_id::text,
       meeting.opportunity_id::text, meeting.source_key, meeting.source_hash, meeting.reference_code,
       meeting.subject, meeting.description, meeting.starts_at, meeting.ends_at,
       meeting.timezone, meeting.location, meeting.attendee_emails, meeting.status,
       meeting.provider, meeting.external_event_id, meeting.external_event_url,
       meeting.join_url, meeting.source_payload,
       organization.suitecrm_id AS organization_suitecrm_id,
       contact.suitecrm_id AS contact_suitecrm_id,
       lead.suitecrm_id AS lead_suitecrm_id,
       opportunity.suitecrm_id AS opportunity_suitecrm_id
     FROM crm_meetings meeting
     JOIN pipeline_spaces pipeline ON pipeline.id = meeting.pipeline_id
     LEFT JOIN crm_organizations organization
       ON organization.pipeline_id = meeting.pipeline_id AND organization.id = meeting.organization_id
     LEFT JOIN crm_contacts contact
       ON contact.pipeline_id = meeting.pipeline_id AND contact.id = meeting.contact_id
     LEFT JOIN crm_leads lead
       ON lead.pipeline_id = meeting.pipeline_id AND lead.id = meeting.lead_id
     LEFT JOIN crm_opportunities opportunity
       ON opportunity.pipeline_id = meeting.pipeline_id AND opportunity.id = meeting.opportunity_id
     WHERE meeting.suitecrm_id = $1
       AND COALESCE(lower(meeting.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
     ORDER BY meeting.id ASC
     LIMIT 2`,
    [suiteCrmId],
  )
  if (result.rows.length > 1) {
    throw new SafeSuiteCrmMeetingIngestionError('SuiteCRM meeting matched multiple ClawPilot records')
  }
  return result.rows[0] || null
}

function suiteTimestamp(value: unknown, label: string): string {
  const parsed = validDate(value)
  if (!parsed) throw new SafeSuiteCrmMeetingIngestionError(`SuiteCRM meeting ${label} is invalid`)
  return parsed.toISOString()
}

function suiteMeetingEnd(attributes: Record<string, unknown>, startsAt: string): string {
  const explicit = validDate(attributes.date_end)
  if (explicit) return explicit.toISOString()
  const hours = Math.max(0, Number(attributes.duration_hours) || 0)
  const minutes = Math.max(0, Number(attributes.duration_minutes) || 0)
  const durationMs = Math.max(60_000, Math.round((hours * 60 + minutes) * 60_000))
  return new Date(Date.parse(startsAt) + durationMs).toISOString()
}

function suiteMeetingStatus(value: unknown, meeting: MeetingRow): CrmMeeting['status'] {
  const status = cleanString(value, 100, 'meeting status').toLowerCase()
  if (status === 'held') return 'completed'
  if (status === 'not held') return 'cancelled'
  if (meeting.status === 'planned' || meeting.status === 'queued') return meeting.status
  return 'scheduled'
}

function suiteCrmParent(meeting: MeetingRow): Pick<
  MeetingFields,
  'organizationSuiteCrmId' | 'parentSuiteCrmId' | 'parentSuiteCrmType'
> {
  if (meeting.opportunity_suitecrm_id) return {
    organizationSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmId: meeting.opportunity_suitecrm_id,
    parentSuiteCrmType: 'Opportunities',
  }
  if (meeting.contact_suitecrm_id) return {
    organizationSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmId: meeting.contact_suitecrm_id,
    parentSuiteCrmType: 'Contacts',
  }
  if (meeting.lead_suitecrm_id) return {
    organizationSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmId: meeting.lead_suitecrm_id,
    parentSuiteCrmType: 'Leads',
  }
  return {
    organizationSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmType: meeting.organization_suitecrm_id ? 'Accounts' : undefined,
  }
}

function meetingFields(snapshot: SuiteCrmMeetingSnapshot, meeting: MeetingRow): MeetingFields {
  const startsAt = suiteTimestamp(snapshot.attributes.date_start, 'start')
  const endsAt = suiteMeetingEnd(snapshot.attributes, startsAt)
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new SafeSuiteCrmMeetingIngestionError('SuiteCRM meeting time range is invalid')
  }
  return {
    organizationId: meeting.organization_id,
    contactId: meeting.contact_id,
    leadId: meeting.lead_id,
    opportunityId: meeting.opportunity_id,
    ...suiteCrmParent(meeting),
    subject: cleanString(snapshot.attributes.name, 300, 'meeting subject') || meeting.subject,
    description: cleanMultiline(snapshot.attributes.description, 50_000, 'meeting description'),
    startsAt,
    endsAt,
    timezone: meeting.timezone || 'America/New_York',
    location: cleanMultiline(snapshot.attributes.location, 1_000, 'meeting location'),
    attendeeEmails: Array.isArray(meeting.attendee_emails) ? meeting.attendee_emails : [],
    status: suiteMeetingStatus(snapshot.attributes.status, meeting),
    provider: meeting.provider || 'maton',
    externalEventId: meeting.external_event_id,
    externalEventUrl: meeting.external_event_url,
    joinUrl: meeting.join_url,
  }
}

function hasMeaningfulChanges(meeting: MeetingRow, fields: MeetingFields): boolean {
  return (
    meeting.subject.trim() !== fields.subject.trim()
    || cleanMultiline(meeting.description, 50_000, 'stored meeting description') !== fields.description
    || validDate(meeting.starts_at)?.getTime() !== validDate(fields.startsAt)?.getTime()
    || validDate(meeting.ends_at)?.getTime() !== validDate(fields.endsAt)?.getTime()
    || cleanMultiline(meeting.location, 1_000, 'stored meeting location') !== fields.location
    || meeting.status !== fields.status
  )
}

async function reconcileMeeting(snapshot: SuiteCrmMeetingSnapshot): Promise<{
  matched: boolean
  staged: boolean
  calendarActionQueued: boolean
}> {
  const meeting = await localMeeting(snapshot.id)
  if (!meeting) return { matched: false, staged: false, calendarActionQueued: false }
  const fields = meetingFields(snapshot, meeting)
  if (!hasMeaningfulChanges(meeting, fields)) {
    return { matched: true, staged: false, calendarActionQueued: false }
  }
  const dateModified = suiteTimestamp(snapshot.attributes.date_modified, 'modified time')
  const stageInput: StageMeetingInput = {
    entity: 'meetings',
    pipelineId: meeting.pipeline_id,
    localId: meeting.id,
    sourceKey: meeting.source_key,
    sourcePayload: {
      ...(meeting.source_payload || {}),
      source: 'suitecrm-inbound',
      suiteCrmDateModified: dateModified,
    },
    actorEmail: meeting.owner_email,
    fields,
  }
  // A never-configured local meeting has no provider event to update. Do not
  // silently adopt an organization/user default during an ordinary CRM edit.
  if (
    !meeting.external_event_id
    && meeting.source_payload?.calendarDeliveryStatus === 'not-configured'
    && !meeting.source_payload?.calendarConnectionId
    && !meeting.source_payload?.calendarId
  ) {
    await withTransaction(async (client) => {
      const current = await client.query<{ source_hash: string }>(
        `SELECT source_hash FROM crm_meetings
         WHERE pipeline_id = $1::uuid AND id = $2::uuid
           AND COALESCE(lower(crm_meetings.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
         FOR UPDATE`,
        [meeting.pipeline_id, meeting.id],
      )
      if (!meeting.source_hash || current.rows[0]?.source_hash !== meeting.source_hash) {
        throw new SafeSuiteCrmMeetingIngestionError('The meeting changed during SuiteCRM reconciliation')
      }
      await stageCrmRecordWithClient(client, stageInput)
    })
    return { matched: true, staged: true, calendarActionQueued: false }
  }
  const recorded = await resolveRecordedCrmMeetingCalendarCommunication({
    pipelineId: meeting.pipeline_id,
    meetingId: meeting.id,
    referenceCode: meeting.reference_code,
    externalEventId: meeting.external_event_id,
    sourcePayload: meeting.source_payload,
  })
  const revision = crypto.createHash('sha256')
    .update(snapshot.id)
    .update('\u0000')
    .update(dateModified)
    .digest('hex')
    .slice(0, 24)
  const queued = await stageCrmMeetingAndEnqueueCalendarAction({
    stageInput: { ...stageInput, actorEmail: recorded.actorEmail },
    payload: {
      subject: fields.subject,
      description: fields.description,
      startsAt: fields.startsAt,
      endsAt: fields.endsAt,
      timezone: fields.timezone,
      location: fields.location,
      attendeeEmails: fields.attendeeEmails,
      meetingStatus: fields.status,
      meetingMode: meeting.source_payload?.meetingMode,
      customJoinUrl: meeting.source_payload?.customJoinUrl,
    },
    communication: recorded.communication,
    previousCalendar: recorded.previousCalendar,
    expectedMeetingSourceHash: meeting.source_hash,
    idempotencyKey: `crm:suitecrm-meeting-calendar:${meeting.reference_code}:${revision}`,
  })
  return { matched: true, staged: true, calendarActionQueued: queued.created }
}

export function sanitizeSuiteCrmMeetingIngestionError(error: unknown): string {
  return error instanceof SafeSuiteCrmMeetingIngestionError
    ? cleanString(error.message, 500, 'meeting ingestion error')
    : 'SuiteCRM meeting ingestion failed'
}

export async function processSuiteCrmMeetingIngestion(): Promise<SuiteCrmMeetingIngestionCounts> {
  const counts: SuiteCrmMeetingIngestionCounts = {
    pagesPolled: 0,
    meetingsListed: 0,
    meetingsMatched: 0,
    meetingsStaged: 0,
    calendarActionsQueued: 0,
    unchangedMeetings: 0,
    unmatchedMeetings: 0,
    pending: false,
    errors: 0,
  }
  const now = new Date()
  const cursor = await readCursor()
  let state = cursor?.state || {
    updatedSince: new Date(
      cursor?.lastPolledAt
        ? Date.parse(cursor.lastPolledAt) - POLL_OVERLAP_MS
        : now.getTime() - INITIAL_LOOKBACK_MS,
    ).toISOString(),
    pollStartedAt: now.toISOString(),
    page: 1,
  }

  try {
    await writeCursor({ state, lastPolledAt: now.toISOString(), lastError: null })
    for (let attempt = 0; attempt < MAX_PAGES_PER_RUN; attempt += 1) {
      const page = await listSuiteCrmMeetingsUpdatedSince({
        updatedSince: state.updatedSince,
        page: state.page,
      })
      counts.pagesPolled += 1
      counts.meetingsListed += page.meetings.length
      for (const snapshot of page.meetings) {
        const result = await reconcileMeeting(snapshot)
        if (!result.matched) counts.unmatchedMeetings += 1
        else if (!result.staged) {
          counts.meetingsMatched += 1
          counts.unchangedMeetings += 1
        } else {
          counts.meetingsMatched += 1
          counts.meetingsStaged += 1
          if (result.calendarActionQueued) counts.calendarActionsQueued += 1
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
      lastError: sanitizeSuiteCrmMeetingIngestionError(error),
    })
    return counts
  }
}
