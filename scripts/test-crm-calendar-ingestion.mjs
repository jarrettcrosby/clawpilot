#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as globalIds from '../app_src/lib/globalIds.mjs'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const sourcePath = 'app_src/lib/crm/calendarIngestion.ts'
const source = readFileSync(sourcePath, 'utf8')

function load(path, mocks = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(output, {
    module, exports: module.exports, URL, URLSearchParams, Response, Date, Intl,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
  }, { filename: path })
  return module.exports
}

const OWNER = 'owner@example.com'
const ACTOR = 'editor@example.com'
const CONNECTION = 'alternate-unselected-connection'
const PIPELINE = '10000000-0000-4000-8000-000000000001'
const ORGANIZATION = '20000000-0000-4000-8000-000000000001'
const CALENDAR = 'secondary/warehouse+team@group.calendar.google.com'
const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const copy = (value) => JSON.parse(JSON.stringify(value))
function meeting(n = 1, overrides = {}) {
  return {
    id: id(n), pipeline_id: PIPELINE, organization_id: null, contact_id: null, lead_id: null,
    opportunity_id: null, source_key: `meeting:${n}`, source_hash: `hash-${n}`,
    reference_code: `gm${String(n).padStart(7, '0')}`, subject: 'Original subject', description: 'Agenda',
    starts_at: '2026-09-03T14:00:00.000Z', ends_at: '2026-09-03T14:30:00.000Z', timezone: 'UTC',
    location: 'Office', attendee_emails: ['guest@example.com'], status: 'scheduled', provider: 'maton',
    external_event_id: `event-${n}`, external_event_url: `https://calendar.google.com/event?eid=${n}`,
    join_url: 'https://meet.google.com/aaa-bbbb-ccc',
    source_payload: {
      calendarOwnerEmail: OWNER, calendarConnectionId: CONNECTION, calendarId: CALENDAR,
      calendarOrganizerEmail: CALENDAR, communicationOrganizationId: ORGANIZATION,
      actionId: '40000000-0000-4000-8000-000000000001', preserved: 'keep original metadata',
    },
    organization_suitecrm_id: null, contact_suitecrm_id: null, lead_suitecrm_id: null,
    opportunity_suitecrm_id: null, ...overrides,
  }
}
function event(row, overrides = {}) {
  return {
    id: row.external_event_id, status: 'confirmed', summary: 'Changed by provider', description: row.description,
    start: { dateTime: row.starts_at, timeZone: row.timezone }, end: { dateTime: row.ends_at, timeZone: row.timezone },
    location: row.location, attendees: row.attendee_emails.map((email) => ({ email })),
    htmlLink: row.external_event_url, hangoutLink: row.join_url,
    extendedProperties: { private: { clawpilotMeetingReference: row.reference_code } }, ...overrides,
  }
}
const selectionKeys = ['calendarConnectionId', 'calendarId', 'calendarOrganizerEmail', 'communicationOrganizationId']
const hasSelection = (row) => selectionKeys.some((key) => Object.hasOwn(row.source_payload || {}, key))
const active = (row) => !['true', '1', 'yes'].includes(String(row.source_payload?.archived ?? 'false').toLowerCase())

function fixture(rows = [meeting()], options = {}) {
  const state = {
    rows: copy(rows), staged: [], gets: [], queries: [], authority: [], cursors: new Map(),
    transaction: false, locked: false, activeConnection: true, access: true, pipelineAccessDisabled: false,
    legacyEvents: options.legacyEvents || [],
  }
  const selected = { owner_email: OWNER, connection_id: options.selectedConnection || 'legacy-primary-connection' }
  async function db(sql, params = [], client = false) {
    state.queries.push({ sql, params, client })
    if (sql.includes('SELECT cursor_value')) return { rows: [state.cursors.get(params[2])].filter(Boolean) }
    if (sql.includes('INSERT INTO crm_integration_cursors')) {
      state.cursors.set(params[2], { cursor_value: params[3], last_polled_at: params[4], last_error: params[5] })
      return { rows: [] }
    }
    if (sql.includes('SELECT app_user.email AS owner_email')) {
      assert.ok(sql.includes('AND EXISTS') && sql.includes('?| ARRAY'), 'primary enumeration is legacy-only')
      assert.ok(sql.includes("NOT IN ('true', '1', 'yes')"))
      return { rows: state.rows.some((row) => active(row) && !hasSelection(row)) ? [selected] : [] }
    }
    if (sql.includes('SELECT DISTINCT connection.owner_email')) {
      assert.ok(!sql.includes('connection.is_selected'), 'recorded connections need not be defaults')
      assert.ok(sql.includes("connection.status = 'ACTIVE'") && sql.includes("app_user.status = 'active'"))
      assert.ok(sql.includes("NOT IN ('true', '1', 'yes')"))
      const eligible = state.rows.filter((row) => active(row) && row.source_payload?.calendarOwnerEmail === OWNER
        && row.source_payload?.calendarConnectionId && row.source_payload?.calendarId && row.external_event_id)
      return { rows: state.activeConnection ? [...new Set(eligible.map((row) => row.source_payload.calendarConnectionId))]
        .map((connection_id) => ({ owner_email: OWNER, connection_id })) : [] }
    }
    if (sql.includes('FOR UPDATE OF meeting')) {
      assert.equal(client, true)
      assert.equal(state.transaction, true)
      state.locked = true
      options.onLock?.(state)
      assert.ok(sql.includes("NOT IN ('true', '1', 'yes')"))
      return { rows: copy(state.rows.filter((row) => active(row) && row.id === params[0] && row.pipeline_id === params[1])) }
    }
    if (sql.includes('SELECT 1 FROM crm_meetings meeting')) {
      assert.equal(state.locked, true)
      assert.ok(sql.includes("membership.status = 'active'") && sql.includes("member.access_role = 'editor'"))
      assert.ok(sql.includes('pipeline.reference_access_disabled = false'))
      return { rows: state.access && state.activeConnection && !state.pipelineAccessDisabled ? [{}] : [] }
    }
    if (sql.includes('meeting.id > $3::uuid')) {
      assert.ok(sql.includes("NOT IN ('true', '1', 'yes')"))
      return { rows: copy(state.rows.filter((row) => active(row) && row.source_payload?.calendarOwnerEmail === params[0]
        && row.source_payload?.calendarConnectionId === params[1] && row.source_payload?.calendarId
        && row.external_event_id && (!params[2] || row.id > params[2])).sort((a, b) => a.id.localeCompare(b.id)).slice(0, params[3])) }
    }
    if (sql.includes('meeting.external_event_id = $2')) {
      assert.ok(sql.includes('?| ARRAY'), 'primary matching excludes explicit selections')
      assert.ok(sql.includes("NOT IN ('true', '1', 'yes')"))
      return { rows: copy(state.rows.filter((row) => active(row) && !hasSelection(row)
        && (row.external_event_id === params[1] || row.reference_code === params[2]))) }
    }
    throw new Error(`Unexpected mocked SQL: ${sql.slice(0, 80)}`)
  }
  const client = { query: (sql, params) => db(sql, params, true) }
  const module = load(sourcePath, {
    '@/lib/globalIds.mjs': globalIds,
    '@/lib/zonedDateTime': load('app_src/lib/zonedDateTime.ts'),
    '@/lib/persistence/postgres': {
      query: (sql, params) => db(sql, params),
      withTransaction: async (fn) => {
        assert.equal(state.transaction, false)
        state.transaction = true
        try { return await fn(client) } finally { state.transaction = false; state.locked = false }
      },
    },
    '@/lib/persistence/crm': {
      stageCrmRecordWithClient: async (actualClient, input) => {
        assert.equal(actualClient, client)
        assert.equal(state.transaction && state.locked, true, 'stage only while meeting lock held')
        state.staged.push(copy(input))
      },
    },
    '@/lib/crm/integrationActions': {
      resolveRecordedCrmMeetingCalendarCommunication: async (input) => {
        state.authority.push({ input: copy(input), locked: state.locked })
        options.onAuthority?.(state, input)
        if (!state.access || !state.activeConnection) throw new Error('Access revoked; private provider details must not leak')
        const source = input.sourcePayload
        if (!source?.calendarOwnerEmail || !source.calendarConnectionId || !source.calendarId || !source.calendarOrganizerEmail || !input.externalEventId) {
          throw new Error('No complete recorded identity')
        }
        return { actorEmail: ACTOR, communication: {
          credentialOwnerEmail: source.calendarOwnerEmail, connectionId: source.calendarConnectionId,
          calendarId: source.calendarId, organizationId: ORGANIZATION,
        }, previousCalendar: {
          credentialOwnerEmail: source.calendarOwnerEmail, connectionId: source.calendarConnectionId,
          calendarId: source.calendarId, eventId: input.externalEventId, organizerEmail: source.calendarOrganizerEmail,
        } }
      },
    },
    '@/lib/maton': {
      matonFetch: async (path, init, context) => {
        assert.equal(init.method, 'GET', 'no provider writes')
        state.gets.push({ path, context: copy(context) })
        options.onGet?.(state)
        if (path.includes('/primary/events?')) return Response.json({ items: state.legacyEvents })
        assert.ok(!path.includes('?'), 'recorded reads are exact events, not calendar lists')
        const original = rows.find((row) => path.endsWith(`/events/${encodeURIComponent(row.external_event_id)}`))
        assert.ok(original, 'only a recorded event may be fetched')
        if (options.httpStatus) return Response.json({ private: 'never expose provider error' }, { status: options.httpStatus })
        return Response.json(options.event ? options.event(original) : event(original))
      },
    },
  })
  return { state, run: module.processCalendarIngestion }
}

{
  const row = meeting(1, { external_event_id: 'event/one+two' })
  const { state, run } = fixture([row])
  const counts = await run()
  assert.equal(counts.meetingsStaged, 1)
  assert.equal(counts.activeCalendars, 1, 'recorded non-default connection counts as active')
  assert.equal(state.gets.length, 1)
  assert.equal(state.gets[0].path, `/google-calendar/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}/events/event%2Fone%2Btwo`)
  assert.equal(state.gets[0].context.boundConnectionId, CONNECTION)
  assert.equal(state.gets[0].context.ownerEmail, OWNER)
  assert.equal(state.staged[0].actorEmail, ACTOR, 'keep original reviewed actor, not credential owner')
  assert.deepEqual(state.staged[0].sourcePayload, row.source_payload)
  assert.equal(state.staged[0].fields.externalEventId, row.external_event_id)
  assert.deepEqual(state.authority.map((check) => check.locked), [false, true])
}
for (const overrides of [
  { extendedProperties: { private: { clawpilotMeetingReference: 'gm9999999' } } },
  { extendedProperties: { private: { clawpilotMeetingReference: 'invalid-marker' } } },
  { id: 'other-event' },
]) {
  const { state, run } = fixture(undefined, { event: (row) => event(row, overrides) })
  assert.equal((await run()).errors, 1)
  assert.equal(state.staged.length, 0, 'forged marker or wrong event never stages')
}
for (const key of ['calendarOwnerEmail', 'calendarConnectionId', 'calendarId', 'calendarOrganizerEmail', 'actionId']) {
  const { state, run } = fixture(undefined, { onLock: (state) => { state.rows[0].source_payload[key] = 'moved' } })
  assert.equal((await run()).unmatchedEvents, 1)
  assert.equal(state.staged.length, 0, `changed ${key} invalidates in-flight response`)
}
{
  const { state, run } = fixture(undefined, { onLock: (state) => { state.rows[0].source_hash = 'new-local-edit' } })
  assert.equal((await run()).unmatchedEvents, 1)
  assert.equal(state.staged.length, 0, 'concurrent local content edit is not overwritten')
}
for (const revoked of ['access', 'activeConnection']) {
  for (const timing of ['before', 'after']) {
    const { state, run } = fixture(undefined, {
      onAuthority: (state) => { if (timing === 'before' || state.locked) state[revoked] = false },
    })
    assert.equal((await run()).errors, 1)
    assert.equal(state.gets.length, timing === 'before' ? 0 : 1)
    assert.equal(state.staged.length, 0, `${revoked} revoked ${timing} GET never stages`)
    assert.ok([...state.cursors.values()].every((row) => !String(row.last_error).includes('private')))
  }
}
for (const httpStatus of [403, 404, 410]) {
  const { state, run } = fixture(undefined, { httpStatus })
  const counts = await run()
  assert.equal(counts.errors, 1)
  assert.equal(counts.cancelledEvents, 0)
  assert.equal(state.staged.length, 0, `${httpStatus} is not evidence of cancellation`)
}
for (const archived of [true, 'true', 1, '1', 'yes', 'YES']) {
  for (const legacy of [false, true]) {
    const row = meeting(1, legacy ? { source_payload: { calendarOwnerEmail: OWNER } } : {})
    const archivedRow = copy(row)
    archivedRow.source_payload.archived = archived
    const before = fixture([archivedRow], { legacyEvents: [event(row)] })
    assert.equal((await before.run()).activeCalendars, 0)
    assert.equal(before.state.gets.length, 0, 'already archived meeting is not fetched')
    assert.equal(before.state.staged.length, 0)
    const during = fixture([row], {
      legacyEvents: [event(row)], onGet: (state) => { state.rows[0].source_payload.archived = archived },
    })
    await during.run()
    assert.equal(during.state.gets.length, 1)
    assert.equal(during.state.staged.length, 0, 'archive during provider GET emits no CRM upsert/outbox')
    assert.equal(during.state.rows[0].source_payload.archived, archived)
  }
}
{
  const { state, run } = fixture(undefined, { event: (row) => event(row, { summary: row.subject }) })
  assert.equal((await run()).unchangedMeetings, 1)
  assert.equal(state.staged.length, 0, 'unchanged echo does not enqueue CRM writes')
}
{
  const { state, run } = fixture(undefined, { event: (row) => ({ id: row.external_event_id, status: 'cancelled' }) })
  assert.equal((await run()).cancelledEvents, 1)
  assert.equal(state.staged[0].fields.status, 'cancelled', 'actual deleted event evidence is reconciled')
  assert.equal(state.staged[0].fields.subject, 'Original subject')
}
{
  const partial = meeting(1, { source_payload: { calendarOwnerEmail: OWNER, calendarConnectionId: CONNECTION } })
  const { state, run } = fixture([partial])
  await run()
  assert.equal(state.gets.length, 0, 'partial selection never falls back to primary')
}
{
  const legacy = meeting(1, { source_payload: { calendarOwnerEmail: OWNER } })
  const selected = meeting(2)
  const unrelated = event(meeting(3))
  const { state, run } = fixture([legacy, selected], { legacyEvents: [event(legacy), event(selected), unrelated] })
  const counts = await run()
  assert.equal(counts.meetingsStaged, 2)
  assert.equal(state.staged.filter((input) => input.localId === selected.id).length, 1, 'selected event is not matched through legacy primary marker')
  assert.equal(state.staged.some((input) => input.localId === id(3)), false, 'unrelated personal event never imported')
}
{
  const legacy = meeting(1, { source_payload: { calendarOwnerEmail: OWNER } })
  const { state, run } = fixture([legacy], {
    legacyEvents: [event(legacy)], onLock: (state) => { state.rows[0].source_payload.calendarId = 'new-selection' },
  })
  await run()
  assert.equal(state.staged.length, 0, 'legacy matching cannot race a new explicit selection')
}
{
  const legacy = meeting(1, { source_payload: { calendarOwnerEmail: OWNER } })
  const { state, run } = fixture([legacy], { legacyEvents: [event(legacy)] })
  state.pipelineAccessDisabled = true
  await run()
  assert.equal(state.staged.length, 0, 'legacy meeting on access-disabled pipeline never stages')
}
{
  const rows = Array.from({ length: 53 }, (_, index) => meeting(index + 1))
  const { state, run } = fixture(rows, {
    onAuthority: (state, input) => { state.access = input.meetingId !== id(1) },
    event: (row) => event(row, { summary: row.subject }),
  })
  const first = await run()
  assert.equal(first.pendingRecordedCalendars, 1)
  assert.equal(state.gets.length, 49, 'bounded 50 candidate batch includes denied record')
  const second = await run()
  assert.equal(second.pendingRecordedCalendars, 0)
  assert.equal(state.gets.length, 52, 'second batch reaches older tail despite first denied record')
  const third = await run()
  assert.equal(third.errors, 1, 'wrap retries a previously denied record')
  assert.equal(state.gets.length, 101)
}
{
  const { state, run } = fixture()
  const key = 'recorded-reconcile:' + require('node:crypto').createHash('sha256').update(CONNECTION).digest('hex')
  state.cursors.set(key, { cursor_value: JSON.stringify({ afterMeetingId: id(999) }), last_polled_at: null })
  await run()
  assert.equal(state.gets.length, 1, 'deleted tail wraps without starving earlier rows')
}

assert.ok(source.includes('resolveRecordedCrmMeetingCalendarCommunication'))
assert.ok(source.includes('FOR UPDATE OF meeting'))
assert.ok(!source.includes('stageCrmRecordInPostgres'), 'no separate transaction after the locked identity check')
console.log('CRM Calendar exact-selection reverse-ingestion regressions passed')
