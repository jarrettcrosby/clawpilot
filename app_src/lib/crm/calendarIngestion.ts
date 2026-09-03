import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import { resolveRecordedCrmMeetingCalendarCommunication } from '@/lib/crm/integrationActions'
import type { CrmMeeting } from '@/lib/crm/types'
import { globalIdFragment, globalIdPattern } from '@/lib/globalIds.mjs'
import { matonFetch } from '@/lib/maton'
import {
  stageCrmRecordWithClient,
  type StageMeetingInput,
} from '@/lib/persistence/crm'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

const CALENDAR_APP = 'google-calendar'
const CALENDAR_EVENTS_PATH = '/google-calendar/calendar/v3/calendars/primary/events'
const CALENDAR_PAGE_SIZE = 250
const MAX_PAGES_PER_CALENDAR = 10
const MAX_RECORDED_MEETINGS_PER_CALENDAR = 50
// Same active-row semantics as persistence/crm.ts activeCrmRecordSql.
const ACTIVE_MEETING_SQL = "COALESCE(lower(meeting.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_SUBJECT_CHARS = 300
const MAX_DESCRIPTION_CHARS = 50_000
const MAX_LOCATION_CHARS = 1_000
const MAX_ATTENDEES = 100
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const MEETING_REFERENCE_PATTERN = globalIdPattern('gm')
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const MANAGED_DESCRIPTION_BOUNDARY = '\n\n---\nClawPilot meeting:'
const MANAGED_DESCRIPTION_ONLY_PATTERN = new RegExp(
  `^ClawPilot meeting:\\s*https:\\/\\/[^\\n]+\\nClawPilot ID:\\s*${globalIdFragment('gm')}\\s*$`,
  'i',
)

type JsonObject = Record<string, unknown>
type TimestampValue = string | Date
type CalendarEventStatus = 'cancelled' | 'confirmed' | 'tentative'
type MeetingFields = StageMeetingInput['fields']

type SelectedCalendar = {
  owner_email: string
  connection_id: string
}

type CursorRow = {
  cursor_value: string | null
  last_polled_at: TimestampValue | null
}

type PollCursor = {
  updatedMin: string
  pollStartedAt: string
  pageToken?: string
}

type RecordedPollCursor = { afterMeetingId: string }
type RecordedCommunication = Awaited<ReturnType<typeof resolveRecordedCrmMeetingCalendarCommunication>>

type MeetingRow = {
  id: string
  pipeline_id: string
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
  source_payload: JsonObject | null
  organization_suitecrm_id: string | null
  contact_suitecrm_id: string | null
  lead_suitecrm_id: string | null
  opportunity_suitecrm_id: string | null
}

type ReconciliationResult = {
  matched: boolean
  staged: boolean
  deferred?: boolean
}

export type CalendarIngestionCounts = {
  activeCalendars: number
  calendarsPolled: number
  pendingCalendars: number
  eventsListed: number
  cancelledEvents: number
  meetingsMatched: number
  meetingsStaged: number
  unchangedMeetings: number
  unmatchedEvents: number
  errors: number
  recordedCalendars: number
  recordedMeetingsPolled: number
  pendingRecordedCalendars: number
  deferredMeetings: number
}

class SafeCalendarIngestionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeCalendarIngestionError'
  }
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function cleanString(value: unknown, maxLength: number, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new SafeCalendarIngestionError(`Google Calendar returned an invalid ${label}`)
  }
  return normalized
}

function cleanMultiline(value: unknown, maxLength: number, label: string): string {
  const normalized = typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim()
    : ''
  if (normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new SafeCalendarIngestionError(`Google Calendar returned an invalid ${label}`)
  }
  return normalized
}

function validDate(value: unknown): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function safeHttpsUrl(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function cursorKey(connectionId: string): string {
  const digest = crypto.createHash('sha256').update(connectionId).digest('hex')
  return `reconcile:${digest}`
}

function parsePollCursor(value: string | null): PollCursor | null {
  if (!value) return null
  try {
    const parsed = asRecord(JSON.parse(value))
    const updatedMin = validDate(parsed?.updatedMin)
    const pollStartedAt = validDate(parsed?.pollStartedAt)
    const pageToken = typeof parsed?.pageToken === 'string' ? parsed.pageToken : undefined
    if (!updatedMin || !pollStartedAt) return null
    if (pageToken && (pageToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(pageToken))) return null
    return {
      updatedMin: updatedMin.toISOString(),
      pollStartedAt: pollStartedAt.toISOString(),
      ...(pageToken ? { pageToken } : {}),
    }
  } catch {
    return null
  }
}

async function readCursor(ownerEmail: string, key: string): Promise<CursorRow | null> {
  const result = await query<CursorRow>(
    `SELECT cursor_value, last_polled_at
     FROM crm_integration_cursors
     WHERE owner_email = $1 AND app = $2 AND cursor_key = $3`,
    [ownerEmail, CALENDAR_APP, key],
  )
  return result.rows[0] || null
}

async function writeCursor(input: {
  ownerEmail: string
  key: string
  state: PollCursor | RecordedPollCursor | null
  lastPolledAt: string
  error: string | null
}): Promise<void> {
  await query(
    `INSERT INTO crm_integration_cursors (
       owner_email, app, cursor_key, cursor_value, last_polled_at, last_error, updated_at
     )
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, now())
     ON CONFLICT (owner_email, app, cursor_key) DO UPDATE SET
       cursor_value = EXCLUDED.cursor_value,
       last_polled_at = EXCLUDED.last_polled_at,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      input.ownerEmail,
      CALENDAR_APP,
      input.key,
      input.state ? JSON.stringify(input.state) : null,
      input.lastPolledAt,
      input.error,
    ],
  )
}

async function selectedCalendars(): Promise<SelectedCalendar[]> {
  const result = await query<SelectedCalendar>(
    `SELECT app_user.email AS owner_email, connection.connection_id
     FROM app_users app_user
     JOIN user_maton_connections connection ON connection.owner_email = app_user.email
     WHERE app_user.status = 'active'
       AND connection.app = $1
       AND connection.status = 'ACTIVE'
       AND connection.source = 'maton'
       AND connection.is_selected
       AND EXISTS (
         SELECT 1 FROM crm_meetings meeting
         JOIN pipeline_spaces pipeline ON pipeline.id = meeting.pipeline_id
         WHERE lower(COALESCE(NULLIF(meeting.source_payload->>'calendarOwnerEmail', ''), pipeline.owner_email)) = app_user.email
           AND ${ACTIVE_MEETING_SQL}
           AND ${LEGACY_MEETING_SELECTION}
       )
     ORDER BY app_user.email ASC`,
    [CALENDAR_APP],
  )
  return result.rows
}

async function calendarJson(
  calendar: SelectedCalendar,
  pathname: string,
): Promise<JsonObject> {
  let response: Response
  try {
    response = await matonFetch(pathname, { method: 'GET' }, {
      ownerEmail: calendar.owner_email,
      app: CALENDAR_APP,
      boundConnectionId: calendar.connection_id,
    })
  } catch {
    throw new SafeCalendarIngestionError('Google Calendar gateway request failed')
  }
  if (!response.ok) {
    throw new SafeCalendarIngestionError(`Google Calendar request failed with status ${response.status}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid response')
  }
  const record = asRecord(payload)
  if (!record) throw new SafeCalendarIngestionError('Google Calendar returned an invalid response')
  return record
}

function listedEvents(payload: JsonObject): JsonObject[] {
  if (payload.items === undefined || payload.items === null) return []
  if (!Array.isArray(payload.items)) {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid event list')
  }
  return payload.items.map((value) => {
    const event = asRecord(value)
    if (!event) throw new SafeCalendarIngestionError('Google Calendar returned an invalid event')
    return event
  })
}

function nextPageToken(payload: JsonObject): string | null {
  if (payload.nextPageToken === undefined || payload.nextPageToken === null || payload.nextPageToken === '') return null
  const token = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : ''
  if (!token || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid page token')
  }
  return token
}

async function listCalendarPage(calendar: SelectedCalendar, state: PollCursor) {
  const parameters = new URLSearchParams({
    maxResults: String(CALENDAR_PAGE_SIZE),
    showDeleted: 'true',
    singleEvents: 'true',
    updatedMin: state.updatedMin,
  })
  if (state.pageToken) parameters.set('pageToken', state.pageToken)
  const payload = await calendarJson(calendar, `${CALENDAR_EVENTS_PATH}?${parameters}`)
  return {
    events: listedEvents(payload),
    nextPageToken: nextPageToken(payload),
  }
}

function calendarEventId(event: JsonObject): string {
  const id = cleanString(event.id, 1000, 'event identifier')
  if (!id || !/^[\x21-\x7e]+$/.test(id)) {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid event identifier')
  }
  return id
}

function calendarEventStatus(event: JsonObject): CalendarEventStatus {
  const status = cleanString(event.status, 64, 'event status').toLowerCase()
  if (status !== 'cancelled' && status !== 'confirmed' && status !== 'tentative') {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid event status')
  }
  return status
}

function calendarMeetingReference(event: JsonObject): string | null {
  const extendedProperties = asRecord(event.extendedProperties)
  const privateProperties = asRecord(extendedProperties?.private)
  const value = typeof privateProperties?.clawpilotMeetingReference === 'string'
    ? privateProperties.clawpilotMeetingReference.trim().toLowerCase()
    : ''
  return MEETING_REFERENCE_PATTERN.test(value) ? value : null
}

const MEETING_SELECT = `SELECT
       meeting.id::text,
       meeting.pipeline_id::text,
       meeting.organization_id::text,
       meeting.contact_id::text,
       meeting.lead_id::text,
       meeting.opportunity_id::text,
       meeting.source_key,
       meeting.source_hash,
       meeting.reference_code,
       meeting.subject,
       meeting.description,
       meeting.starts_at,
       meeting.ends_at,
       meeting.timezone,
       meeting.location,
       meeting.attendee_emails,
       meeting.status,
       meeting.provider,
       meeting.external_event_id,
       meeting.external_event_url,
       meeting.join_url,
       meeting.source_payload,
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
       ON opportunity.pipeline_id = meeting.pipeline_id AND opportunity.id = meeting.opportunity_id`

// Owner-only metadata predates calendar selection. Partial/new selection metadata
// must never fall back to whichever calendar happens to be selected today.
const LEGACY_MEETING_SELECTION = `NOT (COALESCE(meeting.source_payload, '{}'::jsonb)
  ?| ARRAY['calendarConnectionId', 'calendarId', 'calendarOrganizerEmail', 'communicationOrganizationId'])`

function hasRecordedSelection(meeting: MeetingRow): boolean {
  const source = asRecord(meeting.source_payload) || {}
  return ['calendarConnectionId', 'calendarId', 'calendarOrganizerEmail', 'communicationOrganizationId']
    .some((key) => Object.prototype.hasOwnProperty.call(source, key))
}

async function ownedMeetingForEvent(input: {
  ownerEmail: string
  eventId: string
  referenceCode: string | null
}): Promise<MeetingRow | null> {
  const result = await query<MeetingRow>(
    `${MEETING_SELECT}
     WHERE lower(COALESCE(
         NULLIF(meeting.source_payload->>'calendarOwnerEmail', ''),
         pipeline.owner_email
       )) = $1
       AND ${ACTIVE_MEETING_SQL}
       AND ${LEGACY_MEETING_SELECTION}
       AND (
         meeting.external_event_id = $2
         OR ($3::text IS NOT NULL AND meeting.reference_code = $3)
       )
     ORDER BY meeting.id ASC`,
    [input.ownerEmail, input.eventId, input.referenceCode],
  )

  const externalMatches = result.rows.filter((meeting) => meeting.external_event_id === input.eventId)
  const referenceMatches = input.referenceCode
    ? result.rows.filter((meeting) => meeting.reference_code === input.referenceCode)
    : []
  if (externalMatches.length > 1 || referenceMatches.length > 1) {
    throw new SafeCalendarIngestionError('Google Calendar event matched multiple owned CRM meetings')
  }
  if (
    externalMatches[0]
    && referenceMatches[0]
    && externalMatches[0].id !== referenceMatches[0].id
  ) {
    throw new SafeCalendarIngestionError('Google Calendar event identifiers resolved inconsistently')
  }
  return externalMatches[0] || referenceMatches[0] || null
}

async function lockedMeeting(client: PoolClient, meeting: MeetingRow): Promise<MeetingRow | null> {
  const result = await client.query<MeetingRow>(
    `${MEETING_SELECT}
     WHERE meeting.id = $1::uuid AND meeting.pipeline_id = $2::uuid
       AND ${ACTIVE_MEETING_SQL}
     FOR UPDATE OF meeting`,
    [meeting.id, meeting.pipeline_id],
  )
  const current = result.rows[0]
  return current && isActiveMeeting(current) ? current : null
}

function isActiveMeeting(meeting: MeetingRow): boolean {
  return !['true', '1', 'yes'].includes(String(asRecord(meeting.source_payload)?.archived ?? 'false').toLowerCase())
}

function sameRecordedIdentity(previous: MeetingRow, current: MeetingRow): boolean {
  const before = asRecord(previous.source_payload) || {}
  const after = asRecord(current.source_payload) || {}
  return previous.id === current.id
    && previous.pipeline_id === current.pipeline_id
    && previous.source_key === current.source_key
    && previous.source_hash === current.source_hash
    && previous.reference_code === current.reference_code
    && previous.external_event_id === current.external_event_id
    && ['calendarOwnerEmail', 'calendarConnectionId', 'calendarId', 'calendarOrganizerEmail',
      'communicationOrganizationId', 'actionId'].every((key) => before[key] === after[key])
}

function assertEventIdentity(event: JsonObject, meeting: MeetingRow): void {
  const marker = asRecord(asRecord(event.extendedProperties)?.private)?.clawpilotMeetingReference
  if (marker !== undefined && marker !== null && marker !== '') {
    if (calendarMeetingReference(event) !== meeting.reference_code.toLowerCase()) {
      throw new SafeCalendarIngestionError('Google Calendar event meeting reference does not match')
    }
  }
  if (meeting.external_event_id && calendarEventId(event) !== meeting.external_event_id) {
    throw new SafeCalendarIngestionError('Google Calendar event identifier does not match')
  }
}

function recordedAuthority(meeting: MeetingRow): Promise<RecordedCommunication> {
  return resolveRecordedCrmMeetingCalendarCommunication({
    pipelineId: meeting.pipeline_id,
    meetingId: meeting.id,
    referenceCode: meeting.reference_code,
    externalEventId: meeting.external_event_id,
    sourcePayload: meeting.source_payload,
  })
}

async function hasUnresolvedCalendarAction(
  meeting: MeetingRow,
  client?: PoolClient,
): Promise<boolean> {
  const source = asRecord(meeting.source_payload) || {}
  const identity = ['calendarOwnerEmail', 'calendarConnectionId', 'calendarId', 'calendarOrganizerEmail']
    .map((key) => typeof source[key] === 'string' ? source[key].trim() : '')
  if (identity.some((value) => !value) || !meeting.external_event_id) return false
  // Failed/dead actions still represent unsent local intent. Do not silently
  // discard it because a retry is delayed or needs operator review. Only an
  // explicit terminal success/cancellation releases that action's hold.
  const sql = `SELECT 1 FROM crm_integration_actions action
    WHERE action.pipeline_id = $1::uuid
      AND action.aggregate_type = 'crm_meeting' AND action.aggregate_id = $2
      AND action.reference_code = $3
      AND action.app = 'google-calendar' AND action.action_type = 'create_calendar_event'
      AND action.status IN ('queued', 'processing', 'failed', 'dead')
      AND (
        (
          action.payload #>> '{previousCalendar,credentialOwnerEmail}' = $4
          AND action.payload #>> '{previousCalendar,connectionId}' = $5
          AND action.payload #>> '{previousCalendar,calendarId}' = $6
          AND action.payload #>> '{previousCalendar,organizerEmail}' = $7
          AND action.payload #>> '{previousCalendar,eventId}' = $8
        ) OR (
          action.communication_credential_owner_email = $4
          AND action.communication_connection_id = $5
          AND action.communication_calendar_id = $6
          AND action.communication_identity_email = $7
          AND (action.external_id = $8 OR action.payload #>> '{previousCalendar,eventId}' = $8)
        )
      )
    LIMIT 1`
  const values = [meeting.pipeline_id, meeting.id, meeting.reference_code,
    identity[0].toLowerCase(), identity[1], identity[2], identity[3].toLowerCase(), meeting.external_event_id]
  // No action-row locks: enqueue owns the meeting lock first, while dispatch
  // may hold an action row before it materializes the meeting.
  const result = client ? await client.query(sql, values) : await query(sql, values)
  return result.rows.length > 0
}

async function recordedCalendars(): Promise<SelectedCalendar[]> {
  const result = await query<SelectedCalendar>(
    `SELECT DISTINCT connection.owner_email, connection.connection_id
     FROM crm_meetings meeting
     JOIN user_maton_connections connection
       ON connection.owner_email = lower(meeting.source_payload->>'calendarOwnerEmail')
      AND connection.connection_id = meeting.source_payload->>'calendarConnectionId'
     JOIN app_users app_user ON app_user.email = connection.owner_email
     WHERE connection.app = $1 AND connection.status = 'ACTIVE' AND connection.source = 'maton'
       AND ${ACTIVE_MEETING_SQL}
       AND app_user.status = 'active'
       AND NULLIF(meeting.source_payload->>'calendarId', '') IS NOT NULL
       AND NULLIF(meeting.external_event_id, '') IS NOT NULL
     ORDER BY connection.owner_email, connection.connection_id`,
    [CALENDAR_APP],
  )
  return result.rows
}

function parseRecordedCursor(value: string | null): string | null {
  if (!value) return null
  try {
    const id = asRecord(JSON.parse(value))?.afterMeetingId
    return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null
  } catch {
    return null
  }
}

async function recordedMeetingPage(calendar: SelectedCalendar, afterMeetingId: string | null): Promise<MeetingRow[]> {
  const result = await query<MeetingRow>(
    `${MEETING_SELECT}
     WHERE lower(meeting.source_payload->>'calendarOwnerEmail') = $1
       AND ${ACTIVE_MEETING_SQL}
       AND meeting.source_payload->>'calendarConnectionId' = $2
       AND NULLIF(meeting.source_payload->>'calendarId', '') IS NOT NULL
       AND NULLIF(meeting.external_event_id, '') IS NOT NULL
       AND ($3::uuid IS NULL OR meeting.id > $3::uuid)
     ORDER BY meeting.id ASC
     LIMIT $4`,
    [calendar.owner_email, calendar.connection_id, afterMeetingId, MAX_RECORDED_MEETINGS_PER_CALENDAR + 1],
  )
  return result.rows
}

function normalizedTimezone(value: unknown, fallback: string): string {
  const candidate = cleanString(value, 100, 'event timezone') || fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format()
    return candidate
  } catch {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid event timezone')
  }
}

function eventTimezone(event: JsonObject, meeting: MeetingRow): string {
  const start = asRecord(event.start)
  const end = asRecord(event.end)
  const explicit = start?.timeZone ?? end?.timeZone
  return normalizedTimezone(explicit, meeting.timezone || 'America/New_York')
}

function eventTimestamp(value: unknown, timezone: string, label: string): string {
  const boundary = asRecord(value)
  const dateTime = cleanString(boundary?.dateTime, 100, `${label} time`)
  const date = cleanString(boundary?.date, 10, `${label} date`)
  const normalized = dateTime
    ? zonedDateTimeToIso(dateTime, timezone)
    : /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? zonedDateTimeToIso(`${date}T00:00:00`, timezone)
      : null
  if (!normalized) throw new SafeCalendarIngestionError(`Google Calendar returned an invalid event ${label}`)
  return normalized
}

function attendeeEmails(event: JsonObject): string[] {
  if (event.attendees === undefined || event.attendees === null) return []
  if (!Array.isArray(event.attendees) || event.attendees.length > MAX_ATTENDEES) {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid attendee list')
  }
  const emails = event.attendees.flatMap((value) => {
    const attendee = asRecord(value)
    const email = typeof attendee?.email === 'string' ? attendee.email.trim().toLowerCase() : ''
    if (!email) return []
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      throw new SafeCalendarIngestionError('Google Calendar returned an invalid attendee email')
    }
    return [email]
  })
  return Array.from(new Set(emails)).sort()
}

function operatorDescription(value: unknown): string {
  const description = cleanMultiline(value, MAX_DESCRIPTION_CHARS, 'event description')
  const boundary = description.indexOf(MANAGED_DESCRIPTION_BOUNDARY)
  if (boundary >= 0) return description.slice(0, boundary).trim()
  if (MANAGED_DESCRIPTION_ONLY_PATTERN.test(description)) return ''
  return description
}

function conferenceJoinUrl(event: JsonObject): string | null {
  const hangoutLink = safeHttpsUrl(event.hangoutLink)
  if (hangoutLink) return hangoutLink
  const conferenceData = asRecord(event.conferenceData)
  if (!Array.isArray(conferenceData?.entryPoints)) return null
  for (const value of conferenceData.entryPoints) {
    const entryPoint = asRecord(value)
    if (entryPoint?.entryPointType !== 'video') continue
    const url = safeHttpsUrl(entryPoint.uri)
    if (url) return url
  }
  return null
}

function existingTimestamp(value: TimestampValue, label: string): string {
  const parsed = validDate(value)
  if (!parsed) throw new SafeCalendarIngestionError(`CRM meeting ${label} is invalid`)
  return parsed.toISOString()
}

function normalizedStoredAttendees(value: string[] | null): string[] {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((email) => String(email || '').trim().toLowerCase())
    .filter(Boolean)))
    .sort()
}

function reconciledStatus(
  eventStatus: CalendarEventStatus,
  currentStatus: CrmMeeting['status'],
): CrmMeeting['status'] {
  if (eventStatus === 'cancelled') return 'cancelled'
  return currentStatus === 'completed' ? 'completed' : 'scheduled'
}

function eventMeetingFields(
  event: JsonObject,
  eventId: string,
  eventStatus: CalendarEventStatus,
  meeting: MeetingRow,
): MeetingFields {
  const common = {
    subject: meeting.subject.trim(),
    description: cleanMultiline(meeting.description, MAX_DESCRIPTION_CHARS, 'stored meeting description'),
    startsAt: existingTimestamp(meeting.starts_at, 'start'),
    endsAt: existingTimestamp(meeting.ends_at, 'end'),
    timezone: normalizedTimezone(undefined, meeting.timezone || 'America/New_York'),
    location: cleanMultiline(meeting.location, MAX_LOCATION_CHARS, 'stored meeting location'),
    attendeeEmails: normalizedStoredAttendees(meeting.attendee_emails),
    status: reconciledStatus(eventStatus, meeting.status),
    provider: meeting.provider?.trim() || 'maton',
    externalEventId: eventId,
    externalEventUrl: safeHttpsUrl(event.htmlLink) || meeting.external_event_url,
    joinUrl: conferenceJoinUrl(event) || meeting.join_url,
  } satisfies MeetingFields

  if (eventStatus === 'cancelled') return common

  const timezone = eventTimezone(event, meeting)
  const startsAt = eventTimestamp(event.start, timezone, 'start')
  const endsAt = eventTimestamp(event.end, timezone, 'end')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw new SafeCalendarIngestionError('Google Calendar returned an invalid event time range')
  }
  return {
    ...common,
    subject: cleanString(event.summary, MAX_SUBJECT_CHARS, 'event subject') || common.subject,
    description: operatorDescription(event.description),
    startsAt,
    endsAt,
    timezone,
    location: cleanMultiline(event.location, MAX_LOCATION_CHARS, 'event location'),
    attendeeEmails: attendeeEmails(event),
  }
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function meetingHasMeaningfulChanges(meeting: MeetingRow, fields: MeetingFields): boolean {
  const currentStart = validDate(meeting.starts_at)?.getTime()
  const currentEnd = validDate(meeting.ends_at)?.getTime()
  const nextStart = validDate(fields.startsAt)?.getTime()
  const nextEnd = validDate(fields.endsAt)?.getTime()
  return (
    meeting.subject.trim() !== fields.subject.trim()
    || cleanMultiline(meeting.description, MAX_DESCRIPTION_CHARS, 'stored meeting description') !== fields.description
    || currentStart !== nextStart
    || currentEnd !== nextEnd
    || meeting.timezone.trim() !== String(fields.timezone || '').trim()
    || cleanMultiline(meeting.location, MAX_LOCATION_CHARS, 'stored meeting location') !== fields.location
    || !sameStringList(normalizedStoredAttendees(meeting.attendee_emails), fields.attendeeEmails || [])
    || meeting.status !== fields.status
    || String(meeting.external_event_id || '') !== String(fields.externalEventId || '')
    || String(meeting.external_event_url || '').trim() !== String(fields.externalEventUrl || '').trim()
    || String(meeting.join_url || '').trim() !== String(fields.joinUrl || '').trim()
  )
}

function suiteCrmRelationships(meeting: MeetingRow): Pick<
  MeetingFields,
  'organizationSuiteCrmId' | 'parentSuiteCrmId' | 'parentSuiteCrmType'
> {
  let parentSuiteCrmId: string | null = null
  let parentSuiteCrmType: MeetingFields['parentSuiteCrmType']
  if (meeting.opportunity_id) {
    parentSuiteCrmId = meeting.opportunity_suitecrm_id
    if (parentSuiteCrmId) parentSuiteCrmType = 'Opportunities'
  } else if (meeting.contact_id) {
    parentSuiteCrmId = meeting.contact_suitecrm_id
    if (parentSuiteCrmId) parentSuiteCrmType = 'Contacts'
  } else if (meeting.lead_id) {
    parentSuiteCrmId = meeting.lead_suitecrm_id
    if (parentSuiteCrmId) parentSuiteCrmType = 'Leads'
  } else if (meeting.organization_suitecrm_id) {
    parentSuiteCrmId = meeting.organization_suitecrm_id
    parentSuiteCrmType = 'Accounts'
  }
  return {
    organizationSuiteCrmId: meeting.organization_suitecrm_id,
    parentSuiteCrmId,
    parentSuiteCrmType,
  }
}

async function stageReconciledMeeting(
  client: PoolClient,
  meeting: MeetingRow,
  event: JsonObject,
  eventStatus: CalendarEventStatus,
  actorEmail: string,
  ownerEmail: string,
): Promise<ReconciliationResult> {
  assertEventIdentity(event, meeting)
  const fields = eventMeetingFields(event, calendarEventId(event), eventStatus, meeting)
  if (!meetingHasMeaningfulChanges(meeting, fields)) return { matched: true, staged: false }

  await stageCrmRecordWithClient(client, {
    entity: 'meetings',
    pipelineId: meeting.pipeline_id,
    localId: meeting.id,
    sourceKey: meeting.source_key,
    sourcePayload: {
      ...(asRecord(meeting.source_payload) || {}),
      calendarOwnerEmail: ownerEmail,
    },
    actorEmail,
    fields: {
      organizationId: meeting.organization_id,
      contactId: meeting.contact_id,
      leadId: meeting.lead_id,
      opportunityId: meeting.opportunity_id,
      ...suiteCrmRelationships(meeting),
      ...fields,
    },
  })
  return { matched: true, staged: true }
}

async function reconcileEvent(input: {
  calendar: SelectedCalendar
  event: JsonObject
  eventStatus: CalendarEventStatus
}): Promise<ReconciliationResult> {
  const meeting = await ownedMeetingForEvent({
    ownerEmail: input.calendar.owner_email,
    eventId: calendarEventId(input.event),
    referenceCode: calendarMeetingReference(input.event),
  })
  if (!meeting || hasRecordedSelection(meeting)) return { matched: false, staged: false }
  return withTransaction(async (client) => {
    const current = await lockedMeeting(client, meeting)
    if (!current || hasRecordedSelection(current) || !sameRecordedIdentity(meeting, current)) {
      return { matched: false, staged: false }
    }
    // Legacy rows have no reviewed action snapshot. Keep their existing primary
    // scope, but do not reconcile after access or the selected connection changes.
    const access = await client.query(
      `SELECT 1 FROM crm_meetings meeting
       JOIN pipeline_spaces pipeline ON pipeline.id = meeting.pipeline_id
       JOIN app_users actor ON actor.email = $2 AND actor.status = 'active'
       JOIN app_user_organization_memberships membership
         ON membership.user_email = actor.email
        AND membership.organization_id = pipeline.workspace_organization_id AND membership.status = 'active'
       JOIN user_maton_connections connection ON connection.owner_email = actor.email
         AND connection.connection_id = $3 AND connection.app = $4
         AND connection.status = 'ACTIVE' AND connection.source = 'maton' AND connection.is_selected
       WHERE meeting.id = $1::uuid
         AND pipeline.reference_access_disabled = false
         AND lower(COALESCE(NULLIF(meeting.source_payload->>'calendarOwnerEmail', ''), pipeline.owner_email)) = $2
         AND (pipeline.owner_email = $2 OR EXISTS (
           SELECT 1 FROM pipeline_space_members member
           WHERE member.pipeline_id = pipeline.id AND member.user_email = $2 AND member.access_role = 'editor'
         ))`,
      [current.id, input.calendar.owner_email, input.calendar.connection_id, CALENDAR_APP],
    )
    if (!access.rows.length) return { matched: false, staged: false }
    return stageReconciledMeeting(client, current, input.event, input.eventStatus,
      input.calendar.owner_email, input.calendar.owner_email)
  })
}

async function reconcileRecordedEvent(meeting: MeetingRow, event: JsonObject): Promise<ReconciliationResult> {
  assertEventIdentity(event, meeting)
  const status = calendarEventStatus(event)
  return withTransaction(async (client) => {
    const current = await lockedMeeting(client, meeting)
    if (!current || !sameRecordedIdentity(meeting, current)) return { matched: false, staged: false }
    // Re-read authority after the row lock: an in-flight provider response must
    // not overwrite a moved meeting or survive revoked organization access.
    if (await hasUnresolvedCalendarAction(current, client)) {
      return { matched: true, staged: false, deferred: true }
    }
    const authority = await recordedAuthority(current)
    return stageReconciledMeeting(client, current, event, status,
      authority.actorEmail, authority.communication.credentialOwnerEmail)
  })
}

export function sanitizeCalendarIngestionError(error: unknown): string {
  return error instanceof SafeCalendarIngestionError
    ? cleanString(error.message, 500, 'ingestion error')
    : 'Google Calendar ingestion failed'
}

function newCounts(activeCalendars: number): CalendarIngestionCounts {
  return {
    activeCalendars,
    calendarsPolled: 0,
    pendingCalendars: 0,
    eventsListed: 0,
    cancelledEvents: 0,
    meetingsMatched: 0,
    meetingsStaged: 0,
    unchangedMeetings: 0,
    unmatchedEvents: 0,
    errors: 0,
    recordedCalendars: 0,
    recordedMeetingsPolled: 0,
    pendingRecordedCalendars: 0,
    deferredMeetings: 0,
  }
}

async function pollCalendar(
  calendar: SelectedCalendar,
  counts: CalendarIngestionCounts,
): Promise<void> {
  const key = cursorKey(calendar.connection_id)
  const existingCursor = await readCursor(calendar.owner_email, key)
  const now = new Date()
  const previousPoll = validDate(existingCursor?.last_polled_at)
  let state = parsePollCursor(existingCursor?.cursor_value || null) || {
    updatedMin: new Date(
      previousPoll
        ? previousPoll.getTime() - POLL_OVERLAP_MS
        : now.getTime() - INITIAL_LOOKBACK_MS,
    ).toISOString(),
    pollStartedAt: now.toISOString(),
  }

  try {
    await writeCursor({
      ownerEmail: calendar.owner_email,
      key,
      state,
      lastPolledAt: now.toISOString(),
      error: null,
    })

    for (let page = 0; page < MAX_PAGES_PER_CALENDAR; page += 1) {
      const listed = await listCalendarPage(calendar, state)
      counts.eventsListed += listed.events.length

      for (const event of listed.events) {
        const eventStatus = calendarEventStatus(event)
        if (eventStatus === 'cancelled') counts.cancelledEvents += 1
        const result = await reconcileEvent({
          calendar,
          event,
          eventStatus,
        })
        if (!result.matched) counts.unmatchedEvents += 1
        else {
          counts.meetingsMatched += 1
          if (result.staged) counts.meetingsStaged += 1
          else counts.unchangedMeetings += 1
        }
      }

      if (!listed.nextPageToken) {
        await writeCursor({
          ownerEmail: calendar.owner_email,
          key,
          state: null,
          lastPolledAt: state.pollStartedAt,
          error: null,
        })
        counts.calendarsPolled += 1
        return
      }

      state = { ...state, pageToken: listed.nextPageToken }
      await writeCursor({
        ownerEmail: calendar.owner_email,
        key,
        state,
        lastPolledAt: new Date().toISOString(),
        error: null,
      })
    }

    counts.calendarsPolled += 1
    counts.pendingCalendars += 1
  } catch (error) {
    counts.errors += 1
    await writeCursor({
      ownerEmail: calendar.owner_email,
      key,
      state,
      lastPolledAt: new Date().toISOString(),
      error: sanitizeCalendarIngestionError(error),
    })
  }
}

async function pollRecordedCalendar(calendar: SelectedCalendar, counts: CalendarIngestionCounts): Promise<void> {
  const key = `recorded-${cursorKey(calendar.connection_id)}`
  let afterMeetingId = parseRecordedCursor((await readCursor(calendar.owner_email, key))?.cursor_value || null)
  let meetings = await recordedMeetingPage(calendar, afterMeetingId)
  // A deleted tail must not prevent wrapping to earlier existing meetings.
  if (!meetings.length && afterMeetingId) {
    afterMeetingId = null
    meetings = await recordedMeetingPage(calendar, null)
  }
  const hasMore = meetings.length > MAX_RECORDED_MEETINGS_PER_CALENDAR
  let lastError: string | null = null
  for (const meeting of meetings.slice(0, MAX_RECORDED_MEETINGS_PER_CALENDAR)) {
    try {
      // A pending move may already store the destination selection but still
      // have the original event ID. Defer before requiring a delivered snapshot
      // for that destination; no provider access or CRM writes occur on this path.
      if (await hasUnresolvedCalendarAction(meeting)) {
        counts.deferredMeetings += 1
      } else {
        const authority = await recordedAuthority(meeting)
        const selection = authority.previousCalendar
        // Exact event reads only. Never enumerate another personal calendar,
        // infer an event ID from a subject, or turn a 404/410 into cancellation.
        if (selection.credentialOwnerEmail !== calendar.owner_email || selection.connectionId !== calendar.connection_id) {
          throw new SafeCalendarIngestionError('The recorded Google Calendar connection does not match')
        }
        const event = await calendarJson(calendar,
          `/google-calendar/calendar/v3/calendars/${encodeURIComponent(selection.calendarId)}/events/${encodeURIComponent(selection.eventId)}`)
        counts.recordedMeetingsPolled += 1
        const result = await reconcileRecordedEvent(meeting, event)
        if (calendarEventStatus(event) === 'cancelled') counts.cancelledEvents += 1
        if (result.deferred) counts.deferredMeetings += 1
        else if (!result.matched) counts.unmatchedEvents += 1
        else {
          counts.meetingsMatched += 1
          if (result.staged) counts.meetingsStaged += 1
          else counts.unchangedMeetings += 1
        }
      }
    } catch (error) {
      counts.errors += 1
      lastError = sanitizeCalendarIngestionError(error)
    }
    // Advance even on a denied/missing event, so one bad record cannot starve
    // the rest. The next sweep retries it; only confirmed event data is staged.
    afterMeetingId = meeting.id
    await writeCursor({ ownerEmail: calendar.owner_email, key,
      state: { afterMeetingId }, lastPolledAt: new Date().toISOString(), error: lastError })
  }
  await writeCursor({ ownerEmail: calendar.owner_email, key,
    state: hasMore && afterMeetingId ? { afterMeetingId } : null,
    lastPolledAt: new Date().toISOString(), error: lastError })
  if (hasMore) counts.pendingRecordedCalendars += 1
}

export async function processCalendarIngestion(): Promise<CalendarIngestionCounts> {
  const calendars = await selectedCalendars()
  const recorded = await recordedCalendars()
  const activeConnections = new Set([...calendars, ...recorded]
    .map((calendar) => JSON.stringify([calendar.owner_email, calendar.connection_id])))
  const counts = newCounts(activeConnections.size)
  for (const calendar of calendars) await pollCalendar(calendar, counts)
  counts.recordedCalendars = recorded.length
  for (const calendar of recorded) await pollRecordedCalendar(calendar, counts)
  return counts
}
