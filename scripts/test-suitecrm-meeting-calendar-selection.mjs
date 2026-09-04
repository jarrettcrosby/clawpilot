#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import * as globalIds from '../app_src/lib/globalIds.mjs'

const require = createRequire(import.meta.url)
const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
function load(path, mocks, extraExports = '') {
  const source = (process.argv.includes('--baseline')
    ? execFileSync('git', ['show', `ab0f61c51335ec3d59925ee6c63f376cdf0ed902:${path}`], { encoding: 'utf8' })
    : readFileSync(path, 'utf8')) + extraExports
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module, exports: module.exports, console, process, Buffer, URL, URLSearchParams,
    Response, Headers, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
  }, { filename: path })
  return module.exports
}
const PIPELINE = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'
const MEETING = '33333333-3333-4333-8333-333333333333'
const ORIGINAL = '44444444-4444-4444-8444-444444444444'
const NEXT = '55555555-5555-4555-8555-555555555555'
const REFERENCE = 'gm1234567'
const ACTOR = 'operator@example.com'
const OWNER = 'calendar-owner@example.com'
const CALENDAR = 'independent-team@example.com'
const CONNECTION = 'nondefault-calendar-connection'
const EVENT = 'recorded-event'
const CUSTOM = 'https://video.example.com/customer-room'
const normalizeUserEmail = (value) => String(value || '').trim().toLowerCase()
const archived = (row) => ['true', '1', 'yes'].includes(String(row.source_payload?.archived).toLowerCase())
let meeting, prior, staged, queued, requests, scopeFailure, bindingFailure, credentialFailure
let scopeOrganization, activeBinding, credentialAccount, racedHash, insertFailure, cursorWrites
let pipelineRole, onMeetingRead
const snapshot = (source = 'organization') => ({
  organizationId: ORGANIZATION, credentialOwnerEmail: source === 'organization' ? OWNER : ACTOR,
  connectionId: CONNECTION, accountEmail: source === 'organization' ? OWNER : ACTOR,
  identityEmail: CALENDAR, calendarId: CALENDAR, source,
})
function reset(mode = 'in_person', source = 'organization') {
  const communication = snapshot(source)
  meeting = {
    id: MEETING, pipeline_id: PIPELINE, owner_email: 'pipeline-owner@example.com',
    source_key: 'crm-action:original:meeting', source_hash: 'original-source-hash', reference_code: REFERENCE,
    subject: 'Original meeting', description: 'Original description',
    starts_at: '2026-09-04T14:00:00.000Z', ends_at: '2026-09-04T14:45:00.000Z',
    timezone: 'UTC', location: mode === 'in_person' ? '100 Example Avenue' : '',
    attendee_emails: ['attendee@example.com'], status: 'scheduled', provider: 'maton',
    external_event_id: EVENT, external_event_url: 'https://calendar.google.com/event?fixture',
    join_url: mode === 'custom_link' ? CUSTOM : mode === 'google_meet' ? 'https://meet.google.com/old' : null,
    source_payload: {
      actionId: ORIGINAL, calendarOwnerEmail: communication.credentialOwnerEmail,
      calendarConnectionId: CONNECTION, calendarId: CALENDAR, calendarOrganizerEmail: CALENDAR,
      communicationOrganizationId: ORGANIZATION, meetingMode: mode,
      customJoinUrl: mode === 'custom_link' ? CUSTOM : null, retainedMetadata: 'preserve-me',
    },
  }
  prior = {
    id: ORIGINAL, pipeline_id: PIPELINE, actor_email: ACTOR, provider: 'maton', app: 'google-calendar',
    action_type: 'create_calendar_event', aggregate_type: 'crm_meeting', aggregate_id: MEETING,
    reference_code: REFERENCE, status: 'succeeded', external_id: EVENT, attempts: 1,
    payload: {}, response_summary: { meetingReferenceCode: REFERENCE },
    workspace_organization_id: ORGANIZATION,
    communication_credential_owner_email: communication.credentialOwnerEmail,
    communication_connection_id: CONNECTION, communication_account_email: communication.accountEmail,
    communication_identity_email: CALENDAR, communication_calendar_id: CALENDAR,
    communication_binding_source: source,
    available_at: '2026-09-03T12:00:00Z', created_at: '2026-09-03T12:00:00Z',
    updated_at: '2026-09-03T12:00:00Z', processed_at: '2026-09-03T12:00:00Z',
  }
  staged = []; queued = null; requests = []; cursorWrites = []
  scopeFailure = false; bindingFailure = false; credentialFailure = false; insertFailure = false
  scopeOrganization = ORGANIZATION; activeBinding = communication
  credentialAccount = communication.accountEmail; racedHash = null
  pipelineRole = 'editor'
  onMeetingRead = null
}
function inboundSnapshot(changed = true) {
  return { id: 'suitecrm-fixture', attributes: {
    name: changed ? 'Subject edited in SuiteCRM' : meeting.subject,
    description: meeting.description, date_start: meeting.starts_at,
    duration_hours: 0, duration_minutes: changed ? 75 : 45,
    location: meeting.location, status: 'Planned', date_modified: '2026-09-03T19:00:00.000Z',
  } }
}
function target() {
  return { entity: 'meetings', id: MEETING, referenceCode: REFERENCE,
    externalEventId: meeting.external_event_id, sourcePayload: meeting.source_payload,
    shortUrl: 'https://clawpilot.example/m/gm1234567' }
}
function stage(input) {
  assert.equal(input.localId, MEETING)
  assert.equal(input.sourceKey, meeting.source_key)
  staged.push(structuredClone(input))
  meeting.source_payload = structuredClone(input.sourcePayload)
  return { id: MEETING, referenceCode: REFERENCE, sourceHash: 'staged-source-hash',
    shortUrl: 'https://clawpilot.example/m/gm1234567' }
}
async function query(sql, parameters = []) {
  if (sql.includes('FROM crm_meetings meeting')) {
    const read = structuredClone(meeting)
    const active = !sql.includes("NOT IN ('true', '1', 'yes')") || !archived(read)
    if (onMeetingRead) { const callback = onMeetingRead; onMeetingRead = null; callback() }
    return { rows: active ? [read] : [] }
  }
  if (sql.includes('SELECT value FROM app_settings')) return { rows: [] }
  if (sql.includes('INSERT INTO app_settings')) {
    cursorWrites.push(JSON.parse(parameters[1])); return { rows: [], rowCount: 1 }
  }
  if (sql.includes('WHERE actor_email = $1 AND idempotency_key = $2')) return { rows: [] }
  if (sql.includes("AND status = 'succeeded' AND external_id = $2")) {
    assert.match(sql, /pipeline_id = \$1::uuid/)
    assert.match(sql, /communication_connection_id = \$4/)
    assert.match(sql, /communication_calendar_id = \$5/)
    assert.match(sql, /aggregate_id = \$8::uuid AND reference_code = \$9/)
    const matches = prior && prior.status === 'succeeded' && prior.pipeline_id === parameters[0]
      && prior.external_id === parameters[1] && prior.communication_credential_owner_email === parameters[2]
      && prior.communication_connection_id === parameters[3] && prior.communication_calendar_id === parameters[4]
      && prior.communication_identity_email === parameters[5] && (!parameters[6] || prior.id === parameters[6])
      && (prior.aggregate_id === parameters[7] && prior.reference_code === parameters[8]
        || prior.response_summary.meetingReferenceCode === parameters[8])
    return { rows: matches ? [structuredClone(prior)] : [] }
  }
  if (sql.includes('SELECT external_event_id, external_event_url, join_url')) return { rows: [meeting] }
  if (sql.includes('SELECT organization_id::text, contact_id::text')) return { rows: [meeting] }
  if (sql.includes('SET join_url = NULL')) { meeting.join_url = null; return { rows: [], rowCount: 1 } }
  if (sql.includes('UPDATE crm_integration_action_attempts attempt')) return { rows: [], rowCount: 1 }
  throw new Error(`Unexpected query: ${sql.slice(0, 140)}`)
}
const client = { query: async (sql, parameters = []) => {
  if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
  if (sql.includes('SELECT * FROM crm_integration_actions') && sql.includes('FOR UPDATE')) return { rows: [] }
  if (sql.includes('SELECT source_hash FROM crm_meetings')) {
    assert.match(sql, /FOR UPDATE/); assert.deepEqual(Array.from(parameters), [PIPELINE, MEETING])
    if (sql.includes("NOT IN ('true', '1', 'yes')") && archived(meeting)) return { rows: [] }
    return { rows: [{ source_hash: racedHash || meeting.source_hash }] }
  }
  if (sql.includes('WITH inserted AS')) {
    if (insertFailure) throw new Error('simulated enqueue failure')
    queued = { ...prior, id: NEXT, actor_email: parameters[1], aggregate_type: parameters[5],
      aggregate_id: parameters[6], reference_code: parameters[7], payload: JSON.parse(parameters[8]),
      idempotency_key: parameters[9], workspace_organization_id: parameters[10],
      communication_credential_owner_email: parameters[11], communication_connection_id: parameters[12],
      communication_account_email: parameters[13], communication_identity_email: parameters[14],
      communication_calendar_id: parameters[15], communication_binding_source: parameters[16],
      external_id: null, status: 'queued', response_summary: {}, created: true, matches_intent: true }
    return { rows: [queued] }
  }
  if (sql.includes('INSERT INTO audit_events') || sql.includes('UPDATE crm_integration_actions')
    || sql.includes('UPDATE crm_integration_action_attempts')) return { rows: [], rowCount: 1 }
  throw new Error(`Unexpected transaction query: ${sql.slice(0, 140)}`)
} }
const integration = load('app_src/lib/crm/integrationActions.ts', {
  '@/lib/globalIds.mjs': globalIds,
  '@/lib/users': { normalizeUserEmail },
  '@/lib/tenancy': {
    listPipelineSpaces: async (actor, options) => {
      assert.equal(actor.email, ACTOR); assert.equal(actor.organizationId, ORGANIZATION)
      assert.equal(options.ensureDefaults, false)
      return pipelineRole ? [{ id: PIPELINE, accessRole: pipelineRole }] : []
    },
    requireResourceEditor: (pipeline) => { if (pipeline.accessRole === 'viewer') throw new Error('This resource is view-only') },
  },
  '@/lib/zonedDateTime': { zonedDateTimeToIso: (value) => new Date(value).toISOString() },
  '@/lib/integrations/matonGatewayCredentials': { resolveUserMatonGatewayCredential: async (input) => {
    if (credentialFailure) throw new Error('revoked connection')
    assert.equal(input.boundConnectionId, CONNECTION)
    assert.equal(input.ownerEmail, prior.communication_credential_owner_email)
    return { connectionId: CONNECTION, accountEmail: credentialAccount }
  } },
  '@/lib/persistence/organizationCommunications': {
    OrganizationCommunicationPersistenceError: class extends Error {},
    resolvePipelineCommunicationScopeInPostgres: async (input) => {
      assert.equal(input.actorEmail, ACTOR, 'Check original reviewed actor, not pipeline/credential owner')
      if (scopeFailure) throw new Error('revoked membership')
      return { organizationId: scopeOrganization }
    },
    resolvePipelineCommunicationSnapshotInPostgres: async () => {
      if (bindingFailure) throw new Error('revoked organization binding')
      return activeBinding
    },
  },
  '@/lib/persistence/crm': {
    readCrmRecordByReference: async () => target(), resolveCrmReferenceCode: async (value) => value,
    stageCrmRecordWithClient: async (_client, input) => stage(input),
    stageCrmRecordInPostgres: async (input) => stage(input),
  },
  '@/lib/persistence/postgres': { query, withTransaction: async (work) => {
    const before = structuredClone(meeting); const beforeStages = staged.length
    try { return await work(client) } catch (error) { meeting = before; staged.length = beforeStages; throw error }
  } },
  '@/lib/maton': { matonFetch: async (pathname, init = {}, context) => {
    requests.push({ pathname, method: init.method || 'GET', context, body: init.body && JSON.parse(init.body) })
    assert.equal(context.boundConnectionId, CONNECTION)
    if (pathname.includes('/calendarList?')) return Response.json({ items: [
      { id: prior.communication_account_email, primary: true, accessRole: 'owner' },
      { id: CALENDAR, summary: 'Independent team', accessRole: 'writer' },
    ] })
    assert.equal(init.method, 'PATCH', 'A CRM edit must not create/move/delete its recorded event')
    assert.ok(pathname.includes(`/calendars/${encodeURIComponent(CALENDAR)}/events/${EVENT}?`))
    return Response.json({ id: EVENT, htmlLink: meeting.external_event_url, hangoutLink: 'https://meet.google.com/fixture' })
  } },
}, '\nexport { createCalendarEventAction, leasedAction };\n')
const inbound = load('app_src/lib/crm/suiteCrmMeetingIngestion.ts', {
  '@/lib/crm/integrationActions': integration,
  '@/lib/htmlEntities.mjs': { decodeHtmlEntities: (value) => String(value || '') },
  '@/lib/crm/suiteCrmClient': { listSuiteCrmMeetingsUpdatedSince: async () => ({ meetings: [inboundSnapshot()], totalPages: 1 }) },
  '@/lib/persistence/crm': {
    stageCrmRecordInPostgres: async (input) => stage(input),
    stageCrmRecordWithClient: async (_client, input) => stage(input),
  },
  '@/lib/persistence/postgres': { query, withTransaction: async (work) => {
    const before = structuredClone(meeting); const beforeStages = staged.length
    try { return await work(client) } catch (error) { meeting = before; staged.length = beforeStages; throw error }
  } },
  '@/lib/users': { normalizeUserEmail },
}, '\nexport { reconcileMeeting };\n')

for (const mode of ['in_person', 'custom_link', 'google_meet']) {
  for (const source of ['organization', 'meeting-override', 'user-default']) {
    reset(mode, source)
    const result = await inbound.reconcileMeeting(inboundSnapshot())
    assert.equal(result.calendarActionQueued, true)
    assert.equal(queued.payload.meetingMode, mode)
    assert.equal(queued.actor_email, ACTOR)
    assert.equal(queued.communication_connection_id, CONNECTION)
    assert.equal(queued.communication_calendar_id, CALENDAR)
    assert.equal(queued.communication_binding_source, source)
    assert.equal(queued.payload.customJoinUrl, mode === 'custom_link' ? CUSTOM : null)
    assert.equal(queued.payload.endsAt, '2026-09-04T15:15:00.000Z')
    assert.equal(queued.payload.previousCalendar.eventId, EVENT)
    assert.equal(staged[0].sourcePayload.retainedMetadata, 'preserve-me')
    assert.equal(staged[0].sourcePayload.meetingMode, mode)
    assert.equal(requests.length, 0, 'Inbound reconciliation only queues; it does not call the provider')
    await integration.createCalendarEventAction(integration.leasedAction({ ...queued,
      status: 'processing', attempts: 1, lock_token: 'fixture-lease' }), target())
    const write = requests.find((request) => request.method === 'PATCH')
    assert.equal(write.body.summary, 'Subject edited in SuiteCRM')
    assert.equal(write.body.end.dateTime, '2026-09-04T15:15:00.000Z')
    assert.equal(Object.hasOwn(write.body, 'organizer'), false)
    if (mode === 'google_meet') assert.ok(write.body.conferenceData.createRequest)
    else assert.equal(write.body.conferenceData, null)
    assert.equal(write.body.location, mode === 'in_person' ? '100 Example Avenue' : mode === 'custom_link' ? CUSTOM : null)
    assert.equal(staged.at(-1).fields.joinUrl, mode === 'custom_link' ? CUSTOM : mode === 'in_person' ? null : 'https://meet.google.com/fixture')
  }
}
reset()
assert.equal((await inbound.reconcileMeeting(inboundSnapshot(false))).staged, false)
assert.equal(staged.length, 0); assert.equal(queued, null)
for (const role of [null, 'viewer']) {
  reset()
  await inbound.reconcileMeeting(inboundSnapshot())
  pipelineRole = role
  await assert.rejects(() => integration.createCalendarEventAction(integration.leasedAction({ ...queued,
    status: 'processing', attempts: 1, lock_token: 'fixture-lease' }), target()), /no longer authorized to edit this pipeline/)
  assert.equal(requests.length, 0, 'Pipeline access revoked after queuing must block provider writes')
}
reset(); prior.aggregate_type = 'crm_contact'
prior.aggregate_id = '77777777-7777-4777-8777-777777777777'; prior.reference_code = 'gc1234567'
assert.equal((await inbound.reconcileMeeting(inboundSnapshot())).calendarActionQueued, true,
  'An action launched from a contact must correlate through its successful meeting response')
reset(); delete meeting.source_payload.actionId
assert.equal((await inbound.reconcileMeeting(inboundSnapshot())).calendarActionQueued, true,
  'Historical rows without actionId still require exact delivered event and recorded identity')

for (const [name, mutate] of [
  ['revoked actor membership', () => { scopeFailure = true }],
  ['removed pipeline share', () => { pipelineRole = null }],
  ['read-only pipeline share', () => { pipelineRole = 'viewer' }],
  ['moved pipeline organization', () => { scopeOrganization = '66666666-6666-4666-8666-666666666666' }],
  ['revoked organization binding', () => { bindingFailure = true }],
  ['changed organization selection', () => { activeBinding = { ...activeBinding, calendarId: 'other@example.com' } }],
  ['revoked bound connection', () => { credentialFailure = true }],
  ['changed provider account', () => { credentialAccount = 'other@example.com' }],
  ['missing historical snapshot', () => { prior.communication_binding_source = null }],
  ['failed original action', () => { prior.status = 'failed' }],
  ['pending original action', () => { prior.status = 'processing' }],
  ['different original event', () => { prior.external_id = 'different-event' }],
  ['different original meeting', () => { prior.aggregate_id = '77777777-7777-4777-8777-777777777777'; prior.response_summary.meetingReferenceCode = 'gm7654321' }],
  ['different recorded calendar', () => { meeting.source_payload.calendarId = 'other@example.com' }],
  ['different recorded connection', () => { meeting.source_payload.calendarConnectionId = 'other-connection' }],
  ['missing recorded organizer', () => { delete meeting.source_payload.calendarOrganizerEmail }],
  ['changed meeting while acquiring lock', () => { racedHash = 'newer-meeting-selection' }],
  ['failed queue rolls back stage', () => { insertFailure = true }],
]) {
  reset(); mutate()
  await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), undefined, name)
  assert.equal(staged.length, 0, `${name}: must not consume inbound update`)
  assert.equal(queued, null, `${name}: must not queue a default replacement`)
  assert.equal(requests.length, 0, `${name}: must not call provider`)
}
reset(); scopeFailure = true
const failedPoll = await inbound.processSuiteCrmMeetingIngestion()
assert.equal(failedPoll.errors, 1)
assert.equal(cursorWrites.at(-1).state.page, 1, 'Rejected update retains the original page for retry')
assert.ok(cursorWrites.at(-1).lastError)
reset(); meeting.external_event_id = null
meeting.source_payload = { calendarDeliveryStatus: 'not-configured', retainedMetadata: 'preserve-me' }
assert.equal((await inbound.reconcileMeeting(inboundSnapshot())).calendarActionQueued, false)
assert.equal(staged.length, 1); assert.equal(queued, null); assert.equal(requests.length, 0)
reset(); meeting.external_event_id = null
meeting.source_payload = { calendarDeliveryStatus: 'not-configured' }
onMeetingRead = () => {
  meeting.source_hash = 'newly-configured-meeting-hash'
  meeting.external_event_id = 'newly-delivered-event'
  meeting.source_payload = { calendarConnectionId: 'new-connection', calendarId: 'new@example.com' }
}
await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), /meeting changed/)
assert.equal(staged.length, 0)
assert.equal(meeting.external_event_id, 'newly-delivered-event')
assert.equal(meeting.source_payload.calendarConnectionId, 'new-connection')
for (const flag of [true, 'TRUE', 1, '1', 'yes', 'YES']) {
  for (const neverConfigured of [false, true]) {
    reset()
    if (neverConfigured) {
      meeting.external_event_id = null
      meeting.source_payload = { calendarDeliveryStatus: 'not-configured' }
    }
    meeting.source_payload.archived = flag
    assert.equal((await inbound.reconcileMeeting(inboundSnapshot())).matched, false)
    assert.equal(staged.length, 0, 'Initially archived meeting is not imported or queued')
    delete meeting.source_payload.archived
    const originalHash = meeting.source_hash
    const originalEvent = meeting.external_event_id
    onMeetingRead = () => { meeting.source_payload.archived = flag }
    await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), /meeting changed/i,
      `Archive flag ${flag} must invalidate ${neverConfigured ? 'local-only' : 'Calendar'} stage despite unchanged hash`)
    assert.equal(meeting.source_hash, originalHash)
    assert.equal(meeting.external_event_id, originalEvent)
    assert.equal(meeting.source_payload.archived, flag)
    assert.equal(staged.length, 0)
    assert.equal(queued, null)
    assert.equal(requests.length, 0)
  }
}
console.log('SuiteCRM meeting Calendar identity/mode round-trip regression checks passed')
