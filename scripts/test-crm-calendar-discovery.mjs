#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(path, mocks = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, URL, URLSearchParams, Response, Date, Intl,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name) }, { filename: path })
  return module.exports
}
const dateTime = load('app_src/lib/zonedDateTime.ts')
const api = load('app_src/lib/crm/calendarDiscovery.ts', {
  '@/lib/maton': { matonFetch: () => { throw new Error('Real provider access is forbidden in this test') } },
  '@/lib/zonedDateTime': dateTime,
})
const source = {
  id: '10000000-0000-4000-8000-000000000001', pipelineId: '20000000-0000-4000-8000-000000000001',
  workspaceOrganizationId: '30000000-0000-4000-8000-000000000001',
  credentialOwnerEmail: 'owner@workspace.example', connectionId: 'reviewed-work-connection',
  calendarId: 'work/operations+team@group.calendar.google.com', accountEmail: 'work@workspace.example',
  timeZone: 'America/New_York',
}
const now = new Date('2026-10-20T12:00:00.000Z')
const copy = (value) => JSON.parse(JSON.stringify(value))
function event(overrides = {}) {
  return { id: 'provider-event/one+two', status: 'confirmed', summary: 'Customer discussion', description: 'Agenda',
    start: { dateTime: '2026-10-21T10:00:00-04:00' }, end: { dateTime: '2026-10-21T10:30:00-04:00' },
    organizer: { email: 'work@workspace.example' }, attendees: [{ email: 'contact@customer.example' }],
    htmlLink: 'https://calendar.google.com/event?eid=public', hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
    ...overrides }
}
function fixture(options = {}) {
  const state = { cursor: options.cursor ? copy(options.cursor) : null, writes: [], gets: [], events: [],
    authorized: true, results: [], authorities: 0 }
  const store = {
    async isAuthorized() { state.authorities += 1; return state.authorized },
    async readCursor() { return copy(state.cursor) },
    async writeCursor(actualSource, cursor, error) {
      assert.equal(actualSource, source)
      assert.equal(state.authorized, true)
      state.cursor = copy(cursor)
      state.writes.push({ cursor: copy(cursor), error })
    },
    async reconcileEvent(actualSource, parsed) {
      assert.equal(actualSource, source)
      assert.equal(state.authorized, true)
      state.events.push(copy(parsed))
      if (options.onEvent) await options.onEvent(state, parsed)
      return state.results.shift() || { status: 'created' }
    },
  }
  const responses = [...(options.responses || [{ items: [event()], nextSyncToken: 'sync-one' }])]
  const fetch = async (path, init, context) => {
    assert.equal(init.method, 'GET', 'discovery never writes to provider or sends invitations')
    assert.equal(context.ownerEmail, source.credentialOwnerEmail)
    assert.equal(context.boundConnectionId, source.connectionId)
    assert.equal(context.app, 'google-calendar')
    const url = new URL(path, 'https://gateway.example')
    assert.equal(url.pathname, `/google-calendar/calendar/v3/calendars/${encodeURIComponent(source.calendarId)}/events`)
    state.gets.push(url)
    if (options.onGet) await options.onGet(state)
    const response = responses.shift()
    if (response instanceof Error) throw response
    if (response instanceof Response) return response
    assert.ok(response, 'unexpected extra provider request')
    return Response.json(response)
  }
  return { state, store, run: (sources = [source], clock = now) => api.processCalendarDiscovery({ sources, store, fetch, now: clock }) }
}

{
  const f = fixture()
  const counts = await f.run()
  assert.equal(counts.created, 1)
  assert.equal(counts.sourcesPolled, 1)
  const params = f.state.gets[0].searchParams
  assert.equal(params.get('timeMin'), '2026-09-20T12:00:00.000Z')
  assert.equal(params.get('timeMax'), '2027-01-18T12:00:00.000Z')
  assert.equal(params.get('singleEvents'), 'true', 'recurrence instances have provider identities')
  assert.equal(params.get('showDeleted'), 'true')
  assert.equal(params.has('syncToken'), false)
  assert.equal(f.state.cursor.mode, 'incremental')
  assert.equal(f.state.cursor.syncToken, 'sync-one')
  assert.equal(f.state.cursor.pageToken, undefined)
  assert.equal(f.state.events[0].startsAt, '2026-10-21T14:00:00.000Z')
  assert.equal(f.state.events[0].allowCreate, true)
  assert.equal(f.state.events[0].joinUrl, 'https://meet.google.com/aaa-bbbb-ccc')
}
const bootstrapCursor = {
  version: 1, sourceFingerprint: api.calendarDiscoverySourceFingerprint(source), mode: 'bootstrap',
  windowStart: '2026-09-20T12:00:00.000Z', windowEnd: '2027-01-18T12:00:00.000Z',
}
const incrementalCursor = { ...bootstrapCursor, mode: 'incremental', syncToken: 'stable-sync-token' }
{
  const realNow = Date.now
  let networkClock = Date.parse('2026-10-25T09:00:00.000Z')
  const requestStarts = []
  Date.now = () => networkClock
  try {
    const f = fixture({ responses: [
      { items: [event({ id: 'same-page-one' }), event({ id: 'same-page-two' })], nextPageToken: 'next-page' },
      { items: [event({ id: 'second-page' })], nextSyncToken: 'observed-sync' },
    ], onGet: () => {
      requestStarts.push(new Date(networkClock).toISOString())
      networkClock += 5_000 // A local edit may complete while the provider responds.
    } })
    await f.run()
    assert.deepEqual(f.state.events.map(row => row.observedAt),
      [requestStarts[0], requestStarts[0], requestStarts[1]],
      'every event carries its own page request start, never the later response/parse time')
    assert.equal(f.state.gets[0].searchParams.get('timeMin'), bootstrapCursor.windowStart,
      'the injected horizon clock is separate from the wall-clock concurrency snapshot')
  } finally { Date.now = realNow }
}
{
  const f = fixture({ cursor: incrementalCursor })
  await f.run()
  const params = f.state.gets[0].searchParams
  assert.equal(params.get('syncToken'), 'stable-sync-token')
  for (const name of ['timeMin', 'timeMax', 'updatedMin', 'orderBy']) assert.equal(params.has(name), false)
}
{
  const f = fixture({ cursor: incrementalCursor })
  await f.run(undefined, new Date('2026-10-21T11:59:59.999Z'))
  assert.equal(f.state.gets[0].searchParams.get('syncToken'), incrementalCursor.syncToken,
    'a completed window stays incremental until the daily boundary')
}
{
  const future = event({ id: 'unchanged-future-event',
    start: { dateTime: '2027-01-19T14:00:00Z' }, end: { dateTime: '2027-01-19T14:30:00Z' } })
  assert.equal(api.parseCalendarDiscoveryEvent(source, future, source.timeZone, now).allowCreate, false)
  const f = fixture({ cursor: incrementalCursor, responses: [{ items: [future], nextSyncToken: 'rolled-sync' }] })
  await f.run(undefined, new Date('2026-10-22T12:00:00.000Z'))
  const params = f.state.gets[0].searchParams
  assert.equal(params.has('syncToken'), false, 'daily rescan does not rely on the future event changing')
  assert.equal(params.get('timeMin'), '2026-09-22T12:00:00.000Z')
  assert.equal(params.get('timeMax'), '2027-01-20T12:00:00.000Z')
  assert.equal(f.state.events[0].externalEventId, future.id, 'the same provider identity reaches idempotent persistence')
  assert.equal(f.state.events[0].allowCreate, true, 'unchanged future event now falls inside the rolling horizon')
  assert.equal(f.state.cursor.syncToken, 'rolled-sync')
}
{
  const f = fixture({ responses: [
    { items: [event({ id: 'one' })], nextPageToken: 'page-two' },
    { items: [], nextPageToken: 'page-three' },
  ] })
  const counts = await f.run()
  assert.equal(counts.pages, 2)
  assert.equal(counts.pendingSources, 1)
  assert.equal(f.state.cursor.pageToken, 'page-three')
  assert.equal(f.state.gets[0].searchParams.get('timeMin'), f.state.gets[1].searchParams.get('timeMin'))
  const resumed = fixture({ cursor: f.state.cursor, responses: [{ items: [], nextSyncToken: 'finished-sync' }] })
  await resumed.run(undefined, new Date('2026-10-21T12:00:00Z'))
  assert.equal(resumed.state.gets[0].searchParams.get('pageToken'), 'page-three')
  assert.equal(resumed.state.gets[0].searchParams.get('timeMin'), bootstrapCursor.windowStart, 'resume freezes full query')
}
{
  const f = fixture({ cursor: { ...bootstrapCursor, pageToken: 'old-bootstrap-page' } })
  await f.run(undefined, new Date('2026-11-20T12:00:00.000Z'))
  assert.equal(f.state.gets[0].searchParams.get('pageToken'), 'old-bootstrap-page')
  assert.equal(f.state.gets[0].searchParams.get('timeMin'), bootstrapCursor.windowStart,
    'even an old pending bootstrap page retains its exact reviewed query')
  assert.equal(f.state.gets[0].searchParams.get('timeMax'), bootstrapCursor.windowEnd)
}
{
  const f = fixture({ cursor: { ...incrementalCursor, pageToken: 'incremental-page-two' } })
  await f.run(undefined, new Date('2026-11-20T12:00:00.000Z'))
  assert.equal(f.state.gets[0].searchParams.get('syncToken'), incrementalCursor.syncToken)
  assert.equal(f.state.gets[0].searchParams.get('pageToken'), 'incremental-page-two')
  assert.equal(f.state.gets[0].searchParams.has('timeMin'), false)
}
{
  const f = fixture({ cursor: incrementalCursor, responses: [new Response('private provider body', { status: 410 })] })
  const counts = await f.run()
  assert.equal(counts.syncResets, 1)
  assert.equal(counts.pendingSources, 1)
  assert.equal(counts.errors, 0)
  assert.equal(f.state.cursor.mode, 'bootstrap')
  assert.equal(f.state.cursor.syncToken, undefined)
  assert.equal(f.state.events.length, 0)
}
{
  const f = fixture({ cursor: { ...incrementalCursor, sourceFingerprint: 'some-other-source' } })
  await f.run()
  assert.equal(f.state.gets[0].searchParams.has('syncToken'), false, 'connection/source rotation never reuses tokens')
}
{
  const f = fixture()
  f.state.authorized = false
  assert.equal((await f.run()).unauthorizedSources, 1)
  assert.equal(f.state.gets.length, 0)
  assert.equal(f.state.writes.length, 0)
}
{
  const f = fixture({ onGet: (state) => { state.authorized = false } })
  assert.equal((await f.run()).unauthorizedSources, 1)
  assert.equal(f.state.events.length, 0, 'revocation while request is in flight prevents imports')
  assert.equal(f.state.writes.length, 1, 'revocation prevents cursor advancement')
}
{
  const f = fixture({ onEvent: (state) => { state.authorized = false } })
  assert.equal((await f.run()).unauthorizedSources, 1)
  assert.equal(f.state.cursor.mode, 'bootstrap', 'post-import authorization gates token acknowledgement')
}
{
  const f = fixture({ cursor: { ...bootstrapCursor, pageToken: 'retry-this-page' } })
  f.state.results.push({ status: 'deferred' })
  const counts = await f.run()
  assert.equal(counts.deferred, 1)
  assert.equal(counts.pendingSources, 1)
  assert.equal(f.state.cursor.pageToken, 'retry-this-page', 'deferred event must replay the unacknowledged page')
}
{
  const f = fixture({ cursor: incrementalCursor, responses: [new Response('private access_token=do-not-log', { status: 403 })] })
  assert.equal((await f.run()).errors, 1)
  assert.equal(f.state.cursor.syncToken, incrementalCursor.syncToken)
  assert.equal(f.state.writes.at(-1).error, 'Calendar discovery provider request failed with status 403')
  assert.equal(JSON.stringify(f.state.writes).includes('do-not-log'), false)
}
{
  const f = fixture({ responses: [new Error('private credential do-not-log')] })
  assert.equal((await f.run()).errors, 1)
  assert.equal(f.state.writes.at(-1).error, 'Calendar discovery provider request failed')
}
{
  const f = fixture({ responses: [{ items: [event()], nextSyncToken: 'next-sync' }],
    onEvent: () => { throw new Error('sensitive database details') } })
  assert.equal((await f.run()).errors, 1)
  assert.equal(f.state.cursor.mode, 'bootstrap')
  assert.equal(f.state.writes.at(-1).error, 'Calendar discovery processing failed')
}
{
  const f = fixture({ responses: [{ items: [event()], nextPageToken: 'next', nextSyncToken: 'wrong' }] })
  assert.equal((await f.run()).errors, 1)
  assert.equal(f.state.events.length, 0)
}
{
  const f = fixture({ responses: [{ nextSyncToken: 'empty-valid-sync' }] })
  assert.equal((await f.run()).sourcesPolled, 1, 'empty omitted items is a valid Google page')
}
{
  const f = fixture()
  const invalid = { ...source, calendarId: 'primary' }
  assert.equal((await f.run([invalid])).errors, 1)
  assert.equal(f.state.gets.length, 0, 'discovery cannot silently switch to the current primary calendar')
}

const parse = (value, zone = 'America/New_York', clock = now) => copy(api.parseCalendarDiscoveryEvent(source, value, zone, clock))
assert.equal(parse(event()).observedAt, now.toISOString(), 'direct parser callers default to their supplied clock')
assert.equal(api.parseCalendarDiscoveryEvent(source, event(), source.timeZone, now,
  '2026-10-20T13:00:00Z').observedAt, '2026-10-20T13:00:00.000Z')
assert.throws(() => api.parseCalendarDiscoveryEvent(source, event(), source.timeZone, now, 'invalid'), /snapshot time/)
{
  const parsed = parse(event({ attendees: [
    { email: 'CONTACT@CUSTOMER.EXAMPLE' }, { email: 'contact@customer.example' },
    { email: source.accountEmail }, { email: source.credentialOwnerEmail },
    { email: 'organizer@customer.example', organizer: true },
    { email: 'alias@workspace.example', self: true }, { email: 'room@customer.example', resource: true },
    { email: 'second@customer.example' },
  ] }))
  assert.deepEqual(parsed.matchingAttendeeEmails, ['contact@customer.example', 'organizer@customer.example', 'second@customer.example'])
  assert.equal(parsed.attendeeEmails.includes('alias@workspace.example'), true, 'retain actual attendee list separately')
}
{
  for (const attendees of [
    [{ email: 'adrian@customer.example', organizer: true }, { email: source.accountEmail, self: true }],
    [{ email: source.accountEmail, self: true }],
  ]) {
    const parsed = parse(event({ organizer: { email: 'adrian@customer.example' }, attendees }))
    assert.deepEqual(parsed.matchingAttendeeEmails, ['adrian@customer.example'],
      'an external customer organizer matches even if Google omits them from attendees')
  }
  for (const overrides of [
    { organizer: { email: source.accountEmail } },
    { organizer: { email: source.credentialOwnerEmail } },
    { organizer: { email: 'self-alias@workspace.example', self: true } },
    { organizer: { email: 'room@customer.example' }, attendees: [{ email: 'room@customer.example', resource: true }] },
    { organizer: { email: 'self-alias@workspace.example' }, attendees: [{ email: 'self-alias@workspace.example', self: true }] },
  ]) {
    assert.deepEqual(parse(event({ attendees: [], ...overrides })).matchingAttendeeEmails, [],
      'private/self events and resources cannot supply a customer match')
  }
}
{
  const parsed = parse({ id: 'cancelled-known-event', status: 'cancelled' })
  assert.equal(parsed.startsAt, null)
  assert.equal(parsed.endsAt, null)
  assert.equal(parsed.allowCreate, false, 'tombstones never create new meetings without attendee proof')
  assert.deepEqual(parsed.matchingAttendeeEmails, [])
}
{
  const parsed = parse(event({ start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }))
  assert.equal(parsed.startsAt, '2026-11-01T04:00:00.000Z')
  assert.equal(parsed.endsAt, '2026-11-02T05:00:00.000Z', 'all-day DST fall boundary is not assumed 24 hours')
}
{
  const parsed = parse(event({ start: { dateTime: '2026-10-21T10:00:00' }, end: { dateTime: '2026-10-21T10:30:00' } }))
  assert.equal(parsed.startsAt, '2026-10-21T14:00:00.000Z', 'optional event timezone falls back to verified calendar zone')
}
{
  const providerFixedOffsetEvent = event({ id: 'provider-fixed-offset',
    start: { dateTime: '2026-10-21T11:00:00-04:00', timeZone: 'GMT-04:00' },
    end: { dateTime: '2026-10-21T12:00:00-04:00', timeZone: 'GMT-04:00' },
    originalStartTime: { dateTime: '2026-10-21T10:00:00-04:00', timeZone: 'GMT-04:00' } })
  const parsed = parse(providerFixedOffsetEvent)
  assert.equal(parsed.startsAt, '2026-10-21T15:00:00.000Z', 'provider fixed label preserves explicit timestamp instant')
  assert.equal(parsed.endsAt, '2026-10-21T16:00:00.000Z')
  assert.equal(parsed.originalStartTime, '2026-10-21T14:00:00.000Z')
  assert.equal(parsed.timeZone, source.timeZone, 'fixed label is not persisted as the display/edit timezone')
  const f = fixture({ responses: [{ items: [providerFixedOffsetEvent, event({ id: 'following-valid-event' })], nextSyncToken: 'fixed-offset-page-complete' }] })
  const counts = await f.run()
  assert.equal(counts.errors, 0)
  assert.equal(counts.created, 2, 'a verified fixed-offset item does not block later page items')
  assert.equal(counts.sourcesPolled, 1)
  assert.deepEqual(f.state.events.map(row => row.externalEventId), ['provider-fixed-offset', 'following-valid-event'])
  assert.equal(f.state.cursor.syncToken, 'fixed-offset-page-complete')
}
{
  for (const [label, offset, startsAt] of [
    ['UTC+05:30', '+05:30', '2026-10-21T05:30:00.000Z'],
    ['GMT-03:30', '-03:30', '2026-10-21T14:30:00.000Z'],
    ['UTC+00:00', 'Z', '2026-10-21T11:00:00.000Z'],
    ['GMT+00:00', '+00:00', '2026-10-21T11:00:00.000Z'],
    ['UTC+14:00', '+14:00', '2026-10-20T21:00:00.000Z'],
  ]) {
    const parsed = parse(event({
      start: { dateTime: `2026-10-21T11:00:00${offset}`, timeZone: label },
      end: { dateTime: `2026-10-21T12:00:00${offset}`, timeZone: label },
      originalStartTime: { dateTime: `2026-10-21T11:00:00${offset}`, timeZone: label },
    }))
    assert.equal(parsed.startsAt, startsAt, label)
    assert.equal(parsed.originalStartTime, startsAt, `${label} original occurrence uses identical validation`)
    assert.equal(parsed.timeZone, source.timeZone)
  }
}
{
  const invalidParts = [
    { dateTime: '2026-10-21T11:00:00-05:00', timeZone: 'GMT-04:00' },
    { dateTime: '2026-10-21T11:00:00', timeZone: 'GMT-04:00' },
    { date: '2026-10-21', timeZone: 'GMT-04:00' },
    { dateTime: '2026-10-21T11:00:00Z', timeZone: 'GMT-04:00' },
    { dateTime: '2026-10-21T11:00:00+24:00', timeZone: 'UTC+24:00' },
    { dateTime: '2026-10-21T11:00:00+14:01', timeZone: 'UTC+14:01' },
    { dateTime: '2026-10-21T11:00:00+04:60', timeZone: 'GMT+04:60' },
    { dateTime: '2026-10-21T25:00:00-04:00', timeZone: 'GMT-04:00' },
    { dateTime: '2026-02-30T11:00:00-04:00', timeZone: 'GMT-04:00' },
    { dateTime: '2026-10-21T11:00:00-04:00', timeZone: 'Unknown/Timezone' },
    { dateTime: '2026-10-21T11:00:00-04:00', timeZone: 'GMT-4:00' },
  ]
  for (const partName of ['start', 'end', 'originalStartTime']) {
    for (const part of invalidParts) {
      assert.throws(() => parse(event({ [partName]: part })), /invalid (?:timezone|event time)/,
        `${partName} rejects unproven or invalid fixed-offset time ${JSON.stringify(part)}`)
    }
  }
  assert.throws(() => parse(event(), 'GMT-04:00'), /invalid timezone/,
    'provider response timezone must remain a usable calendar zone')
  const f = fixture()
  assert.equal((await f.run([{ ...source, timeZone: 'GMT-04:00' }])).errors, 1)
  assert.equal(f.state.gets.length, 0, 'fixed labels do not relax configured source timezone identity')
  const badPage = fixture({ responses: [{ items: [event({
    start: { dateTime: '2026-10-21T11:00:00-05:00', timeZone: 'GMT-04:00' },
  }), event({ id: 'must-not-skip-invalid-event' })], nextSyncToken: 'must-not-acknowledge' }] })
  assert.equal((await badPage.run()).errors, 1)
  assert.equal(badPage.state.events.length, 0)
  assert.equal(badPage.state.cursor.mode, 'bootstrap', 'conflicting offsets retain the failed page instead of skipping it')
}
{
  const parsed = parse(event({ start: { dateTime: '2020-01-01T10:00:00Z' }, end: { dateTime: '2020-01-01T11:00:00Z' } }))
  assert.equal(parsed.allowCreate, false, 'delta imports cannot broaden initial time scope')
}
{
  const parsed = parse(event({ recurringEventId: 'series-one', originalStartTime: { dateTime: '2026-10-21T09:00:00-04:00' },
    extendedProperties: { private: { clawpilotMeetingReference: 'GM1234567' } },
    hangoutLink: null, conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1234567890' },
      { entryPointType: 'video', uri: 'https://meet.google.com/ddd-eeee-fff' }] } }))
  assert.equal(parsed.recurringEventId, 'series-one')
  assert.equal(parsed.originalStartTime, '2026-10-21T13:00:00.000Z')
  assert.equal(parsed.externalEventId, 'provider-event/one+two', 'instance identity is never replaced with shared series/iCal ID')
  assert.equal(parsed.clawpilotMeetingReference, 'gm1234567')
  assert.equal(parsed.joinUrl, 'https://meet.google.com/ddd-eeee-fff')
}
{
  for (const eventType of ['birthday', 'outOfOffice', 'workingLocation', 'focusTime']) {
    assert.equal(parse(event({ eventType })), null)
  }
  assert.equal(parse(event({ attendees: [] })).matchingAttendeeEmails.length, 0)
  assert.throws(() => parse(event({ attendeesOmitted: true })), /incomplete attendees/)
  assert.throws(() => parse(event({ end: { dateTime: '2026-10-21T09:00:00-04:00' } })), /interval/)
  assert.throws(() => parse(event({ attendees: [{ email: 'invalid email' }] })), /invalid email/)
  assert.equal(parse(event({ hangoutLink: 'javascript:alert(1)', htmlLink: 'http://insecure.example' })).joinUrl, null)
}
assert.notEqual(api.calendarDiscoverySourceFingerprint(source), api.calendarDiscoverySourceFingerprint({ ...source, pipelineId: '20000000-0000-4000-8000-000000000002' }))
assert.equal(api.sanitizeCalendarDiscoveryError(new Error('private details')), 'Calendar discovery processing failed')
console.log('CRM calendar discovery tests passed (scoped GET-only sources, bounded bootstrap, incremental/resume/reset, attendee exclusions, cancellations and dates).')
