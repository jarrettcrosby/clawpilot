import crypto from 'node:crypto'
import { matonFetch } from '@/lib/maton'
import { zonedDateTimeToIso } from '@/lib/zonedDateTime'

const DAY_MS = 86_400_000
const PAGE_SIZE = 100
const MAX_PAGES_PER_SOURCE = 2
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** A reviewed organization source, not a user's current/default calendar. */
export type CalendarDiscoverySource = {
  id: string
  pipelineId: string
  workspaceOrganizationId: string
  credentialOwnerEmail: string
  connectionId: string
  calendarId: string
  accountEmail: string
  timeZone?: string
}

/** Tokens belong to this exact source tuple and never appear in error messages. */
export type CalendarDiscoveryCursor = {
  version: 1
  sourceFingerprint: string
  mode: 'bootstrap' | 'incremental'
  windowStart: string
  windowEnd: string
  syncToken?: string
  pageToken?: string
}

export type CalendarDiscoveryEvent = {
  externalEventId: string
  /** Provider page request start, used to reject snapshots older than local edits. */
  observedAt: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  subject: string
  description: string
  startsAt: string | null
  endsAt: string | null
  timeZone: string
  location: string
  attendeeEmails: string[]
  /** Only these addresses may drive new CRM associations. */
  matchingAttendeeEmails: string[]
  organizerEmail: string | null
  externalEventUrl: string | null
  joinUrl: string | null
  recurringEventId: string | null
  originalStartTime: string | null
  clawpilotMeetingReference: string | null
  /** Outside the bounded window, only an already recorded event may update. */
  allowCreate: boolean
}

export type CalendarDiscoveryResult = {
  status: 'created' | 'updated' | 'unchanged' | 'unmatched' | 'ambiguous' | 'skipped' | 'deferred'
}

export type CalendarDiscoveryStore = {
  isAuthorized(source: CalendarDiscoverySource): Promise<boolean>
  readCursor(source: CalendarDiscoverySource): Promise<CalendarDiscoveryCursor | null>
  writeCursor(source: CalendarDiscoverySource, cursor: CalendarDiscoveryCursor, error?: string | null): Promise<void>
  /** Must recheck authorization, match attendees and stage atomically/idempotently. */
  reconcileEvent(source: CalendarDiscoverySource, event: CalendarDiscoveryEvent): Promise<CalendarDiscoveryResult>
}

export type CalendarDiscoveryCounts = {
  sources: number
  sourcesPolled: number
  pendingSources: number
  pages: number
  eventsListed: number
  created: number
  updated: number
  unchanged: number
  unmatched: number
  ambiguous: number
  skipped: number
  deferred: number
  errors: number
  syncResets: number
  unauthorizedSources: number
}

type JsonObject = Record<string, unknown>
type DiscoveryFetch = typeof matonFetch

class SafeCalendarDiscoveryError extends Error {}
class CalendarDiscoveryRevoked extends Error {}

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function text(value: unknown, max: number, label: string): string {
  const result = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  if (result.length > max || CONTROL.test(result)) throw new SafeCalendarDiscoveryError(`Calendar discovery returned invalid ${label}`)
  return result
}

function identifier(value: unknown, max: number, label: string): string {
  const result = text(value, max, label)
  if (!result || !/^[\x21-\x7e]+$/.test(result)) throw new SafeCalendarDiscoveryError(`Calendar discovery returned invalid ${label}`)
  return result
}

function email(value: unknown): string | null {
  const result = text(value, 254, 'email').toLowerCase()
  if (!result) return null
  if (!EMAIL.test(result)) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid email')
  return result
}

function timezone(value: unknown, fallback = 'UTC'): string {
  const result = text(value, 100, 'timezone') || fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result }).format()
  } catch {
    throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid timezone')
  }
  return result
}

function https(value: unknown): string | null {
  const candidate = text(value, 4000, 'URL')
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function eventTime(value: unknown, fallbackZone: string): string | null {
  const part = record(value)
  if (!part) return null
  const zone = timezone(part.timeZone, fallbackZone)
  const dateTime = text(part.dateTime, 100, 'event time')
  if (dateTime) {
    const result = zonedDateTimeToIso(dateTime, zone)
    if (!result) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid event time')
    return result
  }
  const date = text(part.date, 10, 'event date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const result = zonedDateTimeToIso(`${date}T00:00:00`, zone)
  if (!result) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid event date')
  return result
}

function validateSource(source: CalendarDiscoverySource): void {
  if (![source.id, source.pipelineId, source.workspaceOrganizationId].every((value) => UUID.test(value))) {
    throw new SafeCalendarDiscoveryError('Calendar discovery source is invalid')
  }
  identifier(source.connectionId, 512, 'source connection')
  if (identifier(source.calendarId, 1024, 'source calendar').toLowerCase() === 'primary') {
    throw new SafeCalendarDiscoveryError('Calendar discovery requires an exact calendar ID')
  }
  if (!email(source.credentialOwnerEmail) || !email(source.accountEmail)) {
    throw new SafeCalendarDiscoveryError('Calendar discovery source identity is invalid')
  }
  timezone(source.timeZone)
}

export function calendarDiscoverySourceFingerprint(source: CalendarDiscoverySource): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    source.id, source.pipelineId, source.workspaceOrganizationId,
    source.credentialOwnerEmail.toLowerCase(), source.connectionId,
    source.calendarId, source.accountEmail.toLowerCase(), source.timeZone || 'UTC',
  ])).digest('hex')
}

function bootstrap(source: CalendarDiscoverySource, now: Date): CalendarDiscoveryCursor {
  return {
    version: 1,
    sourceFingerprint: calendarDiscoverySourceFingerprint(source),
    mode: 'bootstrap',
    windowStart: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    windowEnd: new Date(now.getTime() + 90 * DAY_MS).toISOString(),
  }
}

function safeToken(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return identifier(value, 8192, label)
}

function validCursor(value: CalendarDiscoveryCursor | null, source: CalendarDiscoverySource): CalendarDiscoveryCursor | null {
  if (!value || value.version !== 1 || value.sourceFingerprint !== calendarDiscoverySourceFingerprint(source)) return null
  if (value.mode !== 'bootstrap' && value.mode !== 'incremental') return null
  const windowStart = isoDate(value.windowStart)
  const windowEnd = isoDate(value.windowEnd)
  if (!windowStart || !windowEnd || windowStart >= windowEnd) return null
  const syncToken = safeToken(value.syncToken, 'sync token')
  const pageToken = safeToken(value.pageToken, 'page token')
  if (value.mode === 'incremental' && !syncToken) return null
  if (value.mode === 'bootstrap' && syncToken) return null
  return { version: 1, sourceFingerprint: value.sourceFingerprint, mode: value.mode,
    windowStart, windowEnd, ...(syncToken ? { syncToken } : {}), ...(pageToken ? { pageToken } : {}) }
}

function conferenceJoinUrl(event: JsonObject): string | null {
  const direct = https(event.hangoutLink)
  if (direct) return direct
  const entries = record(event.conferenceData)?.entryPoints
  if (!Array.isArray(entries)) return null
  for (const value of entries) {
    const entry = record(value)
    if (entry?.entryPointType === 'video') {
      const uri = https(entry.uri)
      if (uri) return uri
    }
  }
  return null
}

export function parseCalendarDiscoveryEvent(
  source: CalendarDiscoverySource,
  input: unknown,
  responseTimeZone: unknown,
  now: Date,
  observedAt = now.toISOString(),
): CalendarDiscoveryEvent | null {
  const snapshotTime = isoDate(observedAt)
  if (!snapshotTime) throw new SafeCalendarDiscoveryError('Calendar discovery snapshot time is invalid')
  const event = record(input)
  if (!event) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid event')
  const eventType = text(event.eventType, 50, 'event type')
  if (eventType && !['default', 'fromGmail'].includes(eventType)) return null
  const externalEventId = identifier(event.id, 1000, 'event ID')
  const status = text(event.status, 30, 'event status')
  if (!['confirmed', 'tentative', 'cancelled'].includes(status)) {
    throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid event status')
  }
  const timeZone = timezone(record(event.start)?.timeZone, timezone(responseTimeZone, source.timeZone || 'UTC'))
  const startsAt = eventTime(event.start, timeZone)
  const endsAt = eventTime(event.end, timeZone)
  if (status !== 'cancelled' && (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt))) {
    throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid meeting interval')
  }
  if (event.attendees !== undefined && (!Array.isArray(event.attendees) || event.attendees.length > 1000)) {
    throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid attendees')
  }
  if (event.attendeesOmitted === true && status !== 'cancelled') {
    throw new SafeCalendarDiscoveryError('Calendar discovery returned incomplete attendees')
  }
  const organizer = record(event.organizer)
  const organizerEmail = email(organizer?.email)
  const excluded = new Set([email(source.accountEmail), email(source.credentialOwnerEmail),
    organizer?.self === true ? organizerEmail : null].filter(Boolean))
  const all = new Set<string>()
  const matching = new Set<string>()
  for (const item of Array.isArray(event.attendees) ? event.attendees : []) {
    const attendee = record(item)
    if (!attendee) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid attendee')
    const address = email(attendee.email)
    if (!address) continue
    all.add(address)
    if (attendee.self === true || attendee.resource === true) excluded.add(address)
    if (!excluded.has(address)) {
      matching.add(address)
    }
  }
  // A customer's invitation is still a customer meeting. Google may omit the
  // organizer from attendees, so include an external organizer explicitly; an
  // account/self alias or room resource must never become CRM matching proof.
  if (organizerEmail && !excluded.has(organizerEmail)) matching.add(organizerEmail)
  for (const address of excluded) if (address) matching.delete(address)
  const privateReference = text(record(record(event.extendedProperties)?.private)?.clawpilotMeetingReference, 50, 'meeting reference').toLowerCase()
  const allowCreate = status !== 'cancelled' && Boolean(startsAt && endsAt
    && Date.parse(endsAt) > now.getTime() - 30 * DAY_MS
    && Date.parse(startsAt) < now.getTime() + 90 * DAY_MS)
  return {
    externalEventId, observedAt: snapshotTime, status: status as CalendarDiscoveryEvent['status'],
    subject: text(event.summary, 300, 'subject') || 'Calendar meeting',
    description: text(event.description, 50_000, 'description'),
    startsAt, endsAt, timeZone,
    location: text(event.location, 1000, 'location'),
    attendeeEmails: [...all].sort(), matchingAttendeeEmails: [...matching].sort(), organizerEmail,
    externalEventUrl: https(event.htmlLink), joinUrl: conferenceJoinUrl(event),
    recurringEventId: event.recurringEventId ? identifier(event.recurringEventId, 1000, 'recurring event ID') : null,
    originalStartTime: eventTime(event.originalStartTime, timeZone),
    clawpilotMeetingReference: /^gm(?:[0-9]{7}|[0-9a-v]{12})$/.test(privateReference) ? privateReference : null,
    allowCreate,
  }
}

export function sanitizeCalendarDiscoveryError(error: unknown): string {
  return error instanceof SafeCalendarDiscoveryError ? error.message : 'Calendar discovery processing failed'
}

export async function processCalendarDiscovery(input: {
  sources: CalendarDiscoverySource[]
  store: CalendarDiscoveryStore
  now?: Date
  fetch?: DiscoveryFetch
}): Promise<CalendarDiscoveryCounts> {
  const counts: CalendarDiscoveryCounts = { sources: input.sources.length, sourcesPolled: 0, pendingSources: 0,
    pages: 0, eventsListed: 0, created: 0, updated: 0, unchanged: 0, unmatched: 0,
    ambiguous: 0, skipped: 0, deferred: 0, errors: 0, syncResets: 0, unauthorizedSources: 0 }
  const store = input.store
  const fetchProvider = input.fetch || matonFetch
  const now = input.now || new Date()
  if (!Number.isFinite(now.getTime())) throw new SafeCalendarDiscoveryError('Calendar discovery clock is invalid')
  for (const source of input.sources) {
    let cursor: CalendarDiscoveryCursor | null = null
    const authorized = async () => {
      if (!await store.isAuthorized(source)) throw new CalendarDiscoveryRevoked()
    }
    const write = async (state: CalendarDiscoveryCursor, error: string | null = null) => {
      await authorized()
      await store.writeCursor(source, state, error)
    }
    try {
      validateSource(source)
      await authorized()
      cursor = validCursor(await store.readCursor(source), source)
      // Refresh a completed window daily so an unchanged future meeting becomes
      // discoverable when it enters the horizon. Never replace an unacknowledged
      // page: its query window and token must remain stable across retries.
      if (!cursor || (cursor.mode === 'incremental' && !cursor.pageToken
        && now.getTime() - (Date.parse(cursor.windowStart) + 30 * DAY_MS) >= DAY_MS)) {
        cursor = bootstrap(source, now)
      }
      // Save the initial window before issuing a page so restart uses the same query.
      await write(cursor)
      for (let page = 0; page < MAX_PAGES_PER_SOURCE; page += 1) {
        await authorized()
        const parameters = new URLSearchParams({ maxResults: String(PAGE_SIZE), showDeleted: 'true', singleEvents: 'true' })
        if (cursor.mode === 'bootstrap') {
          parameters.set('timeMin', cursor.windowStart)
          parameters.set('timeMax', cursor.windowEnd)
        } else {
          parameters.set('syncToken', cursor.syncToken!)
        }
        if (cursor.pageToken) parameters.set('pageToken', cursor.pageToken)
        let response: Response
        // Wall-clock request start is independent of the injected discovery
        // horizon clock. A local edit completed while this GET is in flight
        // must be newer than every event snapshot returned by this page.
        const pageRequestStartedAt = new Date(Date.now()).toISOString()
        try {
          response = await fetchProvider(`/google-calendar/calendar/v3/calendars/${encodeURIComponent(source.calendarId)}/events?${parameters}`,
            { method: 'GET' }, { ownerEmail: source.credentialOwnerEmail, app: 'google-calendar', boundConnectionId: source.connectionId })
        } catch {
          throw new SafeCalendarDiscoveryError('Calendar discovery provider request failed')
        }
        if (response.status === 410) {
          cursor = bootstrap(source, now)
          await write(cursor)
          counts.syncResets += 1
          counts.pendingSources += 1
          break
        }
        if (!response.ok) throw new SafeCalendarDiscoveryError(`Calendar discovery provider request failed with status ${response.status}`)
        let body: JsonObject | null
        try { body = record(await response.json()) } catch { body = null }
        if (!body || (body.items !== undefined && !Array.isArray(body.items))) throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid page')
        const items = Array.isArray(body.items) ? body.items : []
        const nextPageToken = safeToken(body.nextPageToken, 'page token')
        const nextSyncToken = safeToken(body.nextSyncToken, 'sync token')
        if ((!nextPageToken && !nextSyncToken) || (nextPageToken && nextSyncToken)) {
          throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid pagination')
        }
        counts.pages += 1
        counts.eventsListed += items.length
        let deferred = false
        for (const item of items) {
          const event = parseCalendarDiscoveryEvent(source, item, body.timeZone, now, pageRequestStartedAt)
          if (!event) { counts.skipped += 1; continue }
          await authorized()
          const result = await store.reconcileEvent(source, event)
          if (!Object.prototype.hasOwnProperty.call(counts, result.status)
            || !['created', 'updated', 'unchanged', 'unmatched', 'ambiguous', 'skipped', 'deferred'].includes(result.status)) {
            throw new SafeCalendarDiscoveryError('Calendar discovery returned invalid reconciliation status')
          }
          counts[result.status] += 1
          if (result.status === 'deferred') { deferred = true; break }
        }
        if (deferred) { counts.pendingSources += 1; break }
        if (nextPageToken) {
          if (nextPageToken === cursor.pageToken) throw new SafeCalendarDiscoveryError('Calendar discovery pagination did not advance')
          cursor = { ...cursor, pageToken: nextPageToken }
          await write(cursor)
          if (page === MAX_PAGES_PER_SOURCE - 1) counts.pendingSources += 1
        } else {
          cursor = { version: 1, sourceFingerprint: cursor.sourceFingerprint, mode: 'incremental',
            windowStart: cursor.windowStart, windowEnd: cursor.windowEnd, syncToken: nextSyncToken }
          await write(cursor)
          counts.sourcesPolled += 1
          break
        }
      }
    } catch (error) {
      if (error instanceof CalendarDiscoveryRevoked) {
        counts.unauthorizedSources += 1
        continue
      }
      counts.errors += 1
      if (cursor) {
        try { await write(cursor, sanitizeCalendarDiscoveryError(error)) } catch { /* revoked/unavailable stores must not receive further changes */ }
      }
    }
  }
  return counts
}
