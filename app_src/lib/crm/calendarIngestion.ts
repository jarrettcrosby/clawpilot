import crypto from 'node:crypto'
import type { CrmMeeting } from '@/lib/crm/types'
import { matonFetch } from '@/lib/maton'
import {
  stageCrmRecordInPostgres,
  type StageMeetingInput,
} from '@/lib/persistence/crm'
import { query } from '@/lib/persistence/postgres'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

const CALENDAR_APP = 'google-calendar'
const CALENDAR_EVENTS_PATH = '/google-calendar/calendar/v3/calendars/primary/events'
const CALENDAR_PAGE_SIZE = 250
const MAX_PAGES_PER_CALENDAR = 10
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_SUBJECT_CHARS = 300
const MAX_DESCRIPTION_CHARS = 50_000
const MAX_LOCATION_CHARS = 1_000
const MAX_ATTENDEES = 100
const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const MEETING_REFERENCE_PATTERN = /^gm[0-9]{7}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const MANAGED_DESCRIPTION_BOUNDARY = '\n\n---\nClawPilot meeting:'
const MANAGED_DESCRIPTION_ONLY_PATTERN = /^ClawPilot meeting:\s*https:\/\/[^\n]+\nClawPilot ID:\s*gm[0-9]{7}\s*$/i

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

type MeetingRow = {
  id: string
  pipeline_id: string
  organization_id: string | null
  contact_id: string | null
  lead_id: string | null
  opportunity_id: string | null
  source_key: string
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
  state: PollCursor | null
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

async function ownedMeetingForEvent(input: {
  ownerEmail: string
  eventId: string
  referenceCode: string | null
}): Promise<MeetingRow | null> {
  const result = await query<MeetingRow>(
    `SELECT
       meeting.id::text,
       meeting.pipeline_id::text,
       meeting.organization_id::text,
       meeting.contact_id::text,
       meeting.lead_id::text,
       meeting.opportunity_id::text,
       meeting.source_key,
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
       ON opportunity.pipeline_id = meeting.pipeline_id AND opportunity.id = meeting.opportunity_id
     WHERE lower(COALESCE(
         NULLIF(meeting.source_payload->>'calendarOwnerEmail', ''),
         pipeline.owner_email
       )) = $1
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

async function reconcileEvent(input: {
  ownerEmail: string
  event: JsonObject
  eventStatus: CalendarEventStatus
}): Promise<ReconciliationResult> {
  const eventId = calendarEventId(input.event)
  const meeting = await ownedMeetingForEvent({
    ownerEmail: input.ownerEmail,
    eventId,
    referenceCode: calendarMeetingReference(input.event),
  })
  if (!meeting) return { matched: false, staged: false }

  const fields = eventMeetingFields(input.event, eventId, input.eventStatus, meeting)
  if (!meetingHasMeaningfulChanges(meeting, fields)) return { matched: true, staged: false }

  await stageCrmRecordInPostgres({
    entity: 'meetings',
    pipelineId: meeting.pipeline_id,
    localId: meeting.id,
    sourceKey: meeting.source_key,
    sourcePayload: {
      ...(asRecord(meeting.source_payload) || {}),
      calendarOwnerEmail: input.ownerEmail,
    },
    actorEmail: input.ownerEmail,
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
          ownerEmail: calendar.owner_email,
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

export async function processCalendarIngestion(): Promise<CalendarIngestionCounts> {
  const calendars = await selectedCalendars()
  const counts = newCounts(calendars.length)
  for (const calendar of calendars) await pollCalendar(calendar, counts)
  return counts
}
