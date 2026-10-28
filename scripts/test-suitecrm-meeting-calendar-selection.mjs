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
const PROJECTION = '88888888-8888-4888-8888-888888888888'
const SOURCE_HASH = 'a'.repeat(64)
const normalizeUserEmail = (value) => String(value || '').trim().toLowerCase()
const archived = (row) => ['true', '1', 'yes'].includes(String(row.source_payload?.archived).toLowerCase())
let meeting, prior, staged, queued, requests, scopeFailure, bindingFailure, credentialFailure
let scopeOrganization, activeBinding, credentialAccount, racedHash, insertFailure, cursorWrites
let pipelineRole, onMeetingRead, importedAuthority
let projectionRow, pendingProjection, liveSnapshotOverride, lastPolledSnapshot, nativeReads, onProjectionRead
const clientSource = ts.createSourceFile('suiteCrmClient.ts', readFileSync('app_src/lib/crm/suiteCrmClient.ts', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const normalizerNode = clientSource.statements.find((node) => ts.isFunctionDeclaration(node)
  && node.name?.text === 'normalizeSuiteCrmMeetingProjectionAttributes')
assert.ok(normalizerNode)
const normalizerModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(normalizerNode.getText(clientSource), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: normalizerModule, exports: normalizerModule.exports })
const normalizeProjectionAttributes = normalizerModule.exports.normalizeSuiteCrmMeetingProjectionAttributes
const snapshot = (source = 'organization') => ({
  organizationId: ORGANIZATION, credentialOwnerEmail: source === 'organization' ? OWNER : ACTOR,
  connectionId: CONNECTION, accountEmail: source === 'organization' ? OWNER : ACTOR,
  identityEmail: CALENDAR, calendarId: CALENDAR, source,
})
function reset(mode = 'in_person', source = 'organization') {
  const communication = snapshot(source)
  meeting = {
    id: MEETING, pipeline_id: PIPELINE, owner_email: 'pipeline-owner@example.com',
    source_key: 'crm-action:original:meeting', source_hash: SOURCE_HASH, suitecrm_id: 'suitecrm-fixture', reference_code: REFERENCE,
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
  importedAuthority = null
  pendingProjection = false; liveSnapshotOverride = null; lastPolledSnapshot = null; nativeReads = 0; onProjectionRead = null
  projectionRow = { id: PROJECTION, receipt: { version: 1, outboxId: PROJECTION,
    suiteCrmId: meeting.suitecrm_id, sourceHash: meeting.source_hash, capturedAt: '2026-09-03T18:00:00.000Z',
    attributes: normalizeProjectionAttributes(inboundSnapshot(false).attributes) } }
}
function inboundSnapshot(changed = true) {
  return { id: 'suitecrm-fixture', attributes: {
    name: changed ? 'Subject edited in SuiteCRM' : meeting.subject,
    description: meeting.description, date_start: meeting.starts_at, date_end: '',
    duration_hours: changed ? 1 : 0, duration_minutes: changed ? 15 : 45,
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
  if (sql.includes('FROM sync_outbox projection')) {
    assert.ok(sql.includes("projection.aggregate_type = 'crm_meetings'"))
    assert.ok(sql.includes("projection.status = 'succeeded'"))
    assert.ok(sql.includes("pending.status IN ('queued', 'processing', 'failed', 'dead')"))
    assert.deepEqual(Array.from(parameters).slice(0, 3), [MEETING, PIPELINE, meeting.suitecrm_id])
    assert.match(parameters[3], new RegExp(`^crm:meetings:v4:${MEETING}:default:[a-f0-9]{64}$`))
    const rows = pendingProjection || !projectionRow ? [] : [structuredClone(projectionRow)]
    if (onProjectionRead) { const callback = onProjectionRead; onProjectionRead = null; callback() }
    return { rows }
  }
  if (sql.includes('FROM crm_calendar_discovery_events mapping')) {
    for (const guard of [
      'source.pipeline_id = mapping.pipeline_id AND source.id = mapping.source_id',
      'source.calendar_id = mapping.calendar_id',
      'source.enabled AND source.verified_at IS NOT NULL',
      'meeting.pipeline_id = mapping.pipeline_id AND meeting.id = mapping.meeting_id',
      "meeting.provider = 'google-calendar'",
      'meeting.external_event_id = mapping.external_event_id',
      "NOT IN ('true', '1', 'yes')",
      'pipeline.workspace_organization_id = source.workspace_organization_id',
      'lower(pipeline.owner_email) = source.credential_owner_email',
      'NOT pipeline.reference_access_disabled',
      "owner_user.status = 'active'",
      "membership.organization_id = source.workspace_organization_id AND membership.status = 'active'",
      "connection.app = 'google-calendar' AND connection.status = 'ACTIVE' AND connection.source = 'maton'",
      'lower(connection.account_email) = source.account_email',
      'mapping.pipeline_id = $1::uuid AND mapping.meeting_id = $2::uuid',
      'meeting.reference_code = $3 AND mapping.external_event_id = $4',
      'source.credential_owner_email = $5 AND source.connection_id = $6',
      'mapping.calendar_id = $7 AND source.calendar_id = $8',
    ]) assert.ok(sql.includes(guard), `Imported Calendar authority must retain ${guard}`)
    const row = importedAuthority
    const matches = row && row.authorized && row.pipeline_id === parameters[0]
      && row.meeting_id === parameters[1] && row.reference_code === parameters[2]
      && row.external_event_id === parameters[3] && row.credential_owner_email === parameters[4]
      && row.connection_id === parameters[5] && row.calendar_id === parameters[6]
      && row.calendar_id === parameters[7]
    return { rows: matches ? [structuredClone(row)] : [] }
  }
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
    assert.match(sql, /aggregate_id = \$8::text AND reference_code = \$9/)
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
  if (sql.includes('SELECT source_hash') && sql.includes('FROM crm_meetings')) {
    assert.match(sql, /FOR UPDATE/); assert.deepEqual(Array.from(parameters), [PIPELINE, MEETING])
    if (sql.includes("NOT IN ('true', '1', 'yes')") && archived(meeting)) return { rows: [] }
    return { rows: [{ source_hash: racedHash || meeting.source_hash, suitecrm_id: meeting.suitecrm_id }] }
  }
  if (sql.includes('FROM sync_outbox projection')) {
    for (const guard of ["projection.status = 'succeeded'", 'projection.idempotency_key = $5',
      "projection.payload->'suiteCrmMeetingProjection' = $6::jsonb", 'FOR SHARE OF projection',
      "pending.status IN ('queued', 'processing', 'failed', 'dead')"]) assert.ok(sql.includes(guard))
    const same = projectionRow && !pendingProjection && projectionRow.id === parameters[0]
      && parameters[1] === MEETING && parameters[2] === PIPELINE && parameters[3] === meeting.suitecrm_id
      && parameters[4] === `crm:meetings:v4:${MEETING}:default:${meeting.source_hash}`
      && parameters[6] === meeting.source_hash
      && JSON.stringify(JSON.parse(parameters[5])) === JSON.stringify(projectionRow.receipt)
    return { rows: same ? [{ id: PROJECTION }] : [] }
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
    assert.equal(input.ownerEmail, importedAuthority?.credential_owner_email || prior.communication_credential_owner_email)
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
    if (init.method === 'DELETE') {
      assert.ok(pathname.includes(`/calendars/${encodeURIComponent(CALENDAR)}/events/${EVENT}?`))
      return new Response(null, { status: 204 })
    }
    assert.equal(init.method, 'PATCH', 'A CRM edit must not create/move/delete its recorded event')
    assert.ok(pathname.includes(`/calendars/${encodeURIComponent(CALENDAR)}/events/${EVENT}?`))
    return Response.json({ id: EVENT, htmlLink: meeting.external_event_url, hangoutLink: 'https://meet.google.com/fixture' })
  } },
}, '\nexport { createCalendarEventAction, leasedAction };\n')
const inbound = load('app_src/lib/crm/suiteCrmMeetingIngestion.ts', {
  '@/lib/crm/integrationActions': integration,
  '@/lib/htmlEntities.mjs': { decodeHtmlEntities: (value) => String(value || '') },
  '@/lib/crm/suiteCrmClient': {
    normalizeSuiteCrmMeetingProjectionAttributes: normalizeProjectionAttributes,
    readSuiteCrmMeetingSnapshot: async (id) => {
      assert.equal(id, meeting.suitecrm_id); nativeReads += 1
      return structuredClone(liveSnapshotOverride || lastPolledSnapshot || inboundSnapshot())
    },
    listSuiteCrmMeetingsUpdatedSince: async () => {
      lastPolledSnapshot = inboundSnapshot()
      return { meetings: [lastPolledSnapshot], totalPages: 1 }
    },
  },
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
const reconcileMeeting = inbound.reconcileMeeting
inbound.reconcileMeeting = async (snapshot) => {
  lastPolledSnapshot = structuredClone(snapshot)
  return reconcileMeeting(snapshot)
}

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
function lossyNativeProjection() {
  reset()
  meeting.subject = 'Customer meeting title longer than the native boundary'.padEnd(53, '!')
  meeting.description = '<p>' + 'Retained HTML &amp; proposal. '.repeat(285) + '</p>'
  meeting.starts_at = '2026-09-04T14:00:00.123Z'
  meeting.ends_at = '2026-09-04T14:45:00.987Z'
  const attributes = normalizeProjectionAttributes({ ...inboundSnapshot(false).attributes,
    name: meeting.subject.slice(0, 50), description: 'Native plain-text projection',
    date_start: '2026-09-04T14:00:00.000Z' })
  projectionRow.receipt.attributes = attributes
  return { id: meeting.suitecrm_id, attributes: structuredClone(attributes) }
}
{
  const snapshot = lossyNativeProjection()
  assert.equal((await inbound.reconcileMeeting(snapshot)).staged, false,
    'Exact native projection echo cannot truncate title, strip HTML, round dates or send customer updates')
  assert.equal(staged.length, 0); assert.equal(queued, null); assert.equal(requests.length, 0)
  assert.equal(nativeReads, 0, 'No meaningful native field change needs an extra GET')
}
{
  const snapshot = lossyNativeProjection()
  const canonical = structuredClone(meeting)
  snapshot.attributes.location = 'Actual native CRM address edit'
  assert.equal((await inbound.reconcileMeeting(snapshot)).calendarActionQueued, true)
  assert.equal(nativeReads, 1, 'Real native edits require exact fresh GET confirmation')
  assert.equal(queued.payload.subject, canonical.subject)
  assert.equal(queued.payload.description, canonical.description)
  assert.equal(queued.payload.startsAt, canonical.starts_at)
  assert.equal(queued.payload.endsAt, canonical.ends_at)
  assert.equal(queued.payload.location, snapshot.attributes.location)
  assert.equal(staged[0].fields.subject, canonical.subject)
  assert.equal(staged[0].fields.description, canonical.description)
}
{
  const snapshot = lossyNativeProjection()
  snapshot.attributes.name = 'Genuine same-timestamp native title edit'
  snapshot.attributes.description = '<p>Genuine native description edit</p>'
  assert.equal((await inbound.reconcileMeeting(snapshot)).calendarActionQueued, true)
  assert.equal(queued.payload.subject, snapshot.attributes.name)
  assert.equal(queued.payload.description, snapshot.attributes.description)
  assert.equal(snapshot.attributes.date_modified, projectionRow.receipt.attributes.date_modified,
    'Changed content is accepted even when provider modification timestamps are identical')
}
{
  reset()
  const edited = inboundSnapshot()
  await inbound.reconcileMeeting(edited)
  const firstKey = queued.idempotency_key
  reset()
  const nextEdit = { ...edited, attributes: { ...edited.attributes, name: 'Second edit within the same timestamp' } }
  await inbound.reconcileMeeting(nextEdit)
  assert.notEqual(queued.idempotency_key, firstKey, 'Same-timestamp edits hash their native content')
  reset()
  meeting.source_hash = 'b'.repeat(64)
  meeting.subject = 'Canonical intermediate edit before reverting'
  projectionRow.receipt.sourceHash = meeting.source_hash
  projectionRow.receipt.attributes.name = meeting.subject
  await inbound.reconcileMeeting(edited)
  assert.notEqual(queued.idempotency_key, firstKey,
    'A→B→A native reverts with the same timestamp use their distinct canonical preimage')
}
for (const [name, mutate] of [
  ['legacy missing projection receipt', () => { projectionRow = null }],
  ['queued projection', () => { pendingProjection = true }],
  ['wrong projection format', () => { projectionRow.receipt.version = 2 }],
  ['wrong projection outbox identity', () => { projectionRow.receipt.outboxId = NEXT }],
  ['wrong projection source hash', () => { projectionRow.receipt.sourceHash = 'b'.repeat(64) }],
  ['wrong native projection identity', () => { projectionRow.receipt.suiteCrmId = 'different-native-meeting' }],
  ['invalid projection capture', () => { projectionRow.receipt.capturedAt = 'invalid' }],
  ['incomplete native projection attributes', () => { delete projectionRow.receipt.attributes.description }],
]) {
  reset(); mutate()
  await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), /projection/i, name)
  assert.equal(staged.length, 0, `${name}: retain canonical data`)
  assert.equal(queued, null, `${name}: never enqueue a Calendar update`)
  assert.equal(requests.length, 0)
}
{
  reset(); projectionRow = null
  assert.equal((await inbound.reconcileMeeting(inboundSnapshot(false))).staged, false,
    'An unchanged legacy record is safe to ignore without synthesizing projection proof')
}
{
  reset()
  liveSnapshotOverride = inboundSnapshot()
  liveSnapshotOverride.attributes.location = 'Newer native edit after the list response'
  await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), /changed after polling/)
  assert.equal(queued, null); assert.equal(staged.length, 0)
}
for (const [name, mutate] of [
  ['projection became queued after review', () => { pendingProjection = true }],
  ['same outbox received a different exact receipt', () => { projectionRow.receipt.attributes.description = 'Different projection after review' }],
]) {
  reset(); onProjectionRead = mutate
  await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), /projection.*unproven/i, name)
  assert.equal(queued, null, `${name}: atomic proof precondition prevents dispatch`)
  assert.equal(staged.length, 0)
}
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

function importMeeting(mode = 'in_person') {
  reset(mode, 'meeting-override')
  delete meeting.source_payload.actionId
  meeting.source_payload.source = 'google_calendar_discovery'
  meeting.provider = 'google-calendar'
  prior.status = 'failed'
  importedAuthority = {
    authorized: true, pipeline_id: PIPELINE, meeting_id: MEETING,
    reference_code: REFERENCE, external_event_id: EVENT,
    workspace_organization_id: ORGANIZATION, credential_owner_email: ACTOR,
    connection_id: CONNECTION, account_email: ACTOR, calendar_id: CALENDAR,
  }
}
for (const mode of ['in_person', 'custom_link', 'google_meet', 'unspecified']) {
  importMeeting(mode)
  assert.equal((await inbound.reconcileMeeting(inboundSnapshot())).calendarActionQueued, true,
    'An imported meeting edit must queue against its authoritative discovery source')
  assert.equal(queued.communication_binding_source, 'meeting-override')
  assert.equal(queued.communication_calendar_id, CALENDAR)
  assert.equal(queued.communication_connection_id, CONNECTION)
  assert.equal(queued.actor_email, ACTOR)
  assert.equal(queued.payload.previousCalendar.eventId, EVENT)
  assert.equal(requests.length, 0, 'Import reconciliation must only queue a provider update')
  await integration.createCalendarEventAction(integration.leasedAction({ ...queued,
    status: 'processing', attempts: 1, lock_token: 'fixture-import-lease' }), target())
  const write = requests.find((request) => request.method === 'PATCH')
  assert.equal(write.body.summary, 'Subject edited in SuiteCRM')
  assert.equal(write.body.end.dateTime, '2026-09-04T15:15:00.000Z')
  if (mode === 'unspecified') {
    assert.equal(queued.payload.meetingMode, 'unspecified')
    assert.equal(write.body.location, null, 'A location-free import does not invent an address')
    assert.equal(write.body.conferenceData, null, 'A location-free import does not create Google Meet')
    assert.equal(staged.at(-1).fields.joinUrl, null)
  }
}
for (const [priorMode, nextLocation, expectedMode] of [
  ['unspecified', 'Owner-only validation location', 'in_person'],
  ['in_person', '', 'unspecified'],
  ['unspecified', '', 'unspecified'],
  ['google_meet', 'Hybrid meeting location', 'google_meet'],
  ['custom_link', 'Hybrid custom-link location', 'custom_link'],
]) {
  importMeeting(priorMode)
  const nativeEdit = inboundSnapshot()
  nativeEdit.attributes.location = nextLocation
  assert.equal((await inbound.reconcileMeeting(nativeEdit)).calendarActionQueued, true)
  assert.equal(staged[0].sourcePayload.meetingMode, expectedMode,
    'Native CRM location edit must stage the same mode that its Calendar action uses')
  assert.equal(queued.payload.meetingMode, expectedMode)
  assert.equal(staged[0].fields.location, nextLocation)
  assert.equal(queued.payload.location, nextLocation)
  await integration.createCalendarEventAction(integration.leasedAction({ ...queued,
    status: 'processing', attempts: 1, lock_token: 'fixture-location-mode-lease' }), target())
  const write = requests.find((request) => request.method === 'PATCH')
  assert.ok(write.pathname.includes(`/events/${EVENT}?`), 'Location mode edits reuse the same provider event')
  assert.equal(write.body.location, nextLocation || null)
  if (expectedMode === 'google_meet') assert.ok(write.body.conferenceData.createRequest)
  else assert.equal(write.body.conferenceData, null)
  assert.equal(staged.at(-1).sourcePayload.meetingMode, expectedMode)
}
for (const retainedConference of ['join_url', 'customJoinUrl']) {
  importMeeting('unspecified')
  if (retainedConference === 'join_url') meeting.join_url = CUSTOM
  else meeting.source_payload.customJoinUrl = CUSTOM
  const nativeEdit = inboundSnapshot()
  nativeEdit.attributes.location = 'Must not reinterpret an existing conference'
  await inbound.reconcileMeeting(nativeEdit)
  assert.equal(queued.payload.meetingMode, 'unspecified',
    'Location inference must not override an existing conference identity')
  assert.equal(staged[0].sourcePayload.meetingMode, 'unspecified')
}
importMeeting('unknown-provider-mode')
const unknownModeEdit = inboundSnapshot()
unknownModeEdit.attributes.location = 'Do not infer unknown mode'
await assert.rejects(() => inbound.reconcileMeeting(unknownModeEdit), /Meeting mode/)
assert.equal(staged.length, 0, 'Unknown meeting mode remains fail-closed before staging')
assert.equal(queued, null)

// Execute the actual editor initialization and save functions without loading
// React/MUI, so a pre-fix row with stale metadata cannot silently lose an address.
{
  const path = 'app_src/components/crm/CrmSection.tsx'
  const uiSource = readFileSync(path, 'utf8')
  const ast = ts.createSourceFile(path, uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const wanted = new Set(['textValue', 'meetingModeValue', 'meetingModeForRecord',
    'meetingCalendarChoiceKey', 'initialFields', 'saveRecord'])
  const functions = []
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) functions.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(functions.length, wanted.size)
  const submitted = []
  const errors = []
  const module = { exports: {} }
  const context = {
    module, exports: module.exports, console,
    MEETING_DURATION_PRESETS: [15, 30, 45, 60, 90],
    durationForMeetingRecord: () => 45,
    dateTimeLocalValue: (value) => String(value || ''),
    busy: false, editorRequiredFieldsReady: true, editorMeetingReady: true,
    editorEntity: 'meetings', editorRecord: { id: MEETING }, editorMeetingIdempotencyKey: 'fixture-editor-location-save',
    sharedEmailAssociations: false,
    editorMeetingCalendar: { source: 'organization-default' }, editorMeetingTimingReady: true, editorMeetingLocationReady: true,
    setBusy() {}, setError(value) { if (value) errors.push(value) }, setNotice() {},
    setEditorRecord() {}, setEditorMeetingIdempotencyKey() {}, setEditorHistory() {},
    entity: 'meetings', query: '', needsReviewOnly: false, load: async () => {},
    fetch: async (_url, init) => { submitted.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true }) } },
  }
  const output = ts.transpileModule(functions.join('\n')
    + '\nmodule.exports={initialFields,meetingModeForRecord,saveRecord};', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(output, context, { filename: path })
  const staleRecord = { meetingMode: 'unspecified', location: 'Owner-only validation location',
    startsAt: '2026-09-04T14:00', endsAt: '2026-09-04T14:45', timezone: 'UTC', subject: 'Existing reverse-sync meeting' }
  context.fields = module.exports.initialFields('meetings', staleRecord, 'UTC', 'USD')
  context.editorMeetingMode = context.fields.meetingMode
  context.editorMeetingEnd = context.fields.endsAt
  assert.equal(context.fields.meetingMode, 'in_person', 'Stale metadata exposes the existing address in the editor')
  assert.equal(context.fields.location, staleRecord.location)
  await module.exports.saveRecord()
  assert.deepEqual(errors, [])
  assert.equal(submitted[0].fields.meetingMode, 'in_person')
  assert.equal(submitted[0].fields.location, staleRecord.location,
    'An unrelated editor save must preserve the native CRM address')
  assert.equal(module.exports.meetingModeForRecord({ meetingMode: 'in_person', location: '' }), 'unspecified')
  for (const mode of ['google_meet', 'custom_link']) {
    assert.equal(module.exports.meetingModeForRecord({ ...staleRecord, meetingMode: mode }), mode)
  }
  for (const conference of [{ joinUrl: CUSTOM }, { customJoinUrl: CUSTOM }]) {
    assert.equal(module.exports.meetingModeForRecord({ ...staleRecord, ...conference }), 'unspecified')
  }
}
importMeeting('unspecified')
const cancellation = inboundSnapshot()
cancellation.attributes.status = 'Not Held'
assert.equal((await inbound.reconcileMeeting(cancellation)).calendarActionQueued, true)
await integration.createCalendarEventAction(integration.leasedAction({ ...queued,
  status: 'processing', attempts: 1, lock_token: 'fixture-import-cancel-lease' }), target())
assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1,
  'An unspecified imported meeting can still be cancelled on its exact calendar')
assert.equal(requests.filter((request) => request.method === 'PATCH').length, 0)
assert.equal(staged.at(-1).fields.status, 'cancelled')
importMeeting(); prior = null
const imported = await integration.resolveRecordedCrmMeetingCalendarCommunication({
  pipelineId: PIPELINE, meetingId: MEETING, referenceCode: REFERENCE,
  externalEventId: EVENT, sourcePayload: meeting.source_payload,
})
assert.equal(imported.communication.calendarId, CALENDAR,
  'An authoritative imported event does not require any outbound action receipt')
for (const [name, mutate] of [
  ['disabled or revoked import source', () => { importedAuthority.authorized = false }],
  ['different imported pipeline', () => { importedAuthority.pipeline_id = NEXT }],
  ['different imported meeting', () => { importedAuthority.meeting_id = NEXT }],
  ['different imported reference', () => { importedAuthority.reference_code = 'gm7654321' }],
  ['different imported event', () => { importedAuthority.external_event_id = 'another-event' }],
  ['different imported connection', () => { importedAuthority.connection_id = 'another-connection' }],
  ['different imported calendar', () => { importedAuthority.calendar_id = 'another@example.com' }],
  ['different imported owner', () => { importedAuthority.credential_owner_email = OWNER }],
  ['metadata without import mapping', () => { importedAuthority = null }],
  ['revoked imported credential', () => { credentialFailure = true }],
  ['changed imported provider account', () => { credentialAccount = 'changed@example.com' }],
  ['revoked imported membership', () => { scopeFailure = true }],
  ['revoked imported pipeline access', () => { pipelineRole = null }],
]) {
  importMeeting(); mutate()
  await assert.rejects(() => inbound.reconcileMeeting(inboundSnapshot()), undefined, name)
  assert.equal(staged.length, 0, `${name}: do not consume the inbound edit`)
  assert.equal(queued, null, `${name}: do not switch to a default calendar`)
  assert.equal(requests.length, 0, `${name}: do not write to Google`)
}

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
