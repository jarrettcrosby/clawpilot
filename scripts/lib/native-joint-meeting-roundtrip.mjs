// Local acceptance helper only. Real PostgreSQL and actual SuiteCRM OAuth/V8;
// Calendar is deliberately one controlled synthetic invitation on two calendars.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../app_src/package.json', import.meta.url))
const ts = require('typescript')
const ENTRIES = [
  'app_src/lib/persistence/crm.ts',
  'app_src/lib/crm/integrationActions.ts',
  'app_src/lib/crm/calendarDiscovery.ts',
  'app_src/lib/crm/calendarDiscoveryPersistence.ts',
  'app_src/lib/crm/suiteCrmMeetingIngestion.ts',
  'app_src/lib/crm/suiteCrmClient.ts',
  'app_src/lib/persistence/matonCredentials.ts',
  'app_src/lib/integrations/matonCredentialCrypto.ts',
  'app_src/lib/users.ts',
]
const EXTERNAL = new Set(['crypto', 'fs', 'next/headers', 'node:crypto', 'node:net', 'pg', 'server-only', 'sharp'])
const POSTGRES = 'app_src/lib/persistence/postgres.ts'
const compiled = new Map()

function resolveLocal(parent, name) {
  const base = name.startsWith('@/') ? `app_src/${name.slice(2)}` : path.posix.join(path.posix.dirname(parent), name)
  assert.ok(base.startsWith('app_src/'), 'Meeting helper import escaped app_src')
  const found = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]
    .find(candidate => existsSync(path.join(ROOT, candidate)) && statSync(path.join(ROOT, candidate)).isFile())
  assert.ok(found, `Unresolved meeting helper source: ${base}`)
  return found
}

// Discover runtime imports from the actual emitted CommonJS, not type-only
// imports. The parent pins these original bytes before starting its fixture.
function collectSource(file) {
  if (compiled.has(file)) return
  const source = readFileSync(path.join(ROOT, file), 'utf8')
  const code = ts.transpileModule(source, { fileName: file.endsWith('.mjs') ? `${file}.ts` : file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  compiled.set(file, code)
  const syntax = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'Dynamic require is not admitted')
      const name = node.arguments[0].text
      if (name.startsWith('@/') || name.startsWith('.')) collectSource(resolveLocal(file, name))
      else assert.ok(EXTERNAL.has(name) && (isBuiltin(name) || ['next/headers', 'pg', 'server-only', 'sharp'].includes(name)),
        `Unreviewed meeting helper dependency: ${name}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(syntax)
}
ENTRIES.forEach(collectSource)
export const MEETING_ROUNDTRIP_SOURCE_PATHS = Object.freeze([
  ...compiled.keys(), 'scripts/lib/native-joint-meeting-roundtrip.mjs',
].sort())

function loadProduction({ environment, fetch, query, withTransaction, getPostgresPool }) {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    assert.ok(compiled.has(file), 'Unpinned production source requested')
    const module = { exports: {} }
    cache.set(file, module) // Preserve the real production import cycles.
    const context = {
      module, exports: module.exports, Buffer, Date, Intl, URL, URLSearchParams, Response, Request, Headers,
      AbortController, AbortSignal, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, fetch,
      process: { env: environment, cwd: () => ROOT },
      require(name) {
        if (name.startsWith('@/') || name.startsWith('.')) return load(resolveLocal(file, name))
        assert.ok(EXTERNAL.has(name), 'Unexpected production dependency')
        // The installed Next marker's server implementation is intentionally
        // empty; use that actual package leaf, not an authority substitute.
        return name === 'server-only' ? require('next/dist/compiled/server-only/empty.js') : require(name)
      },
    }
    vm.runInNewContext(compiled.get(file), context, { filename: path.join(ROOT, file), timeout: 5000 })
    if (file === POSTGRES) {
      // These supplied functions execute against the same real guarded pool
      // and retain the parent's transaction/deadline accounting. Every other
      // export (including advisory locks/error handling) is production code.
      module.exports = { ...module.exports, query, withTransaction, getPostgresPool }
    }
    return module.exports
  }
  return load
}

function syntheticEnvironment(owner) {
  return { NODE_ENV: 'test', TZ: 'UTC', APP_LOGIN_EMAIL: owner, CLAWPILOT_STORAGE: 'postgres',
    DATABASE_URL: 'postgresql://synthetic.invalid/joint-fixture-never-connected',
    CLAWPILOT_DB_FALLBACK_TO_FILE: 'false', CLAWPILOT_PUBLIC_URL: 'https://clawpilot-joint.example.invalid',
    SHORTLINK_PUBLIC_ORIGIN: 'https://links-joint.example.invalid' }
}

// Normal configured-owner initialization is part of app startup/user reads.
// Perform the genuine normalization BEFORE RootA captures its immutable
// authority source. It is not a post-enrollment policy bypass or fake scope.
export async function prepareNativeJointMeetingFixture({ query, withTransaction, getPostgresPool, authority, deadline }) {
  const expires = Math.min(deadline, Date.now() + 30_000)
  const guard = () => assert.ok(Number.isFinite(expires) && Date.now() < expires, 'Owner fixture preparation deadline exceeded')
  guard()
  assert.equal(process.env.TZ, 'UTC', 'The joined meeting fixture must be launched with TZ=UTC')
  assert.match(authority.actorEmail, /^[^@]+@[^@]+\.invalid$/u)
  const owner = authority.actorEmail.toLowerCase()
  assert.equal(owner, authority.actorEmail)
  const controlSql = 'SELECT enabled,active_operation_id,active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton'
  const beforeControl = (await query(controlSql)).rows
  assert.equal(beforeControl.length, 1)
  assert.equal(beforeControl[0].enabled, false)
  assert.equal(beforeControl[0].active_operation_id, null)
  assert.equal(beforeControl[0].active_initial_enrollment_id, null)
  const ownerSql = `SELECT email,reference_code,contact_reference_code,suitecrm_user_id,suitecrm_username,
    crm_user_enabled,role,status,permissions,activated_at FROM app_users WHERE email=$1`
  const before = (await query(ownerSql, [owner])).rows
  assert.equal(before.length, 1, 'The real mapped owner must already be seeded')
  assert.equal(before[0].role, 'owner'); assert.equal(before[0].status, 'active'); assert.equal(before[0].crm_user_enabled, true)
  let networkCalls = 0
  const load = loadProduction({ environment: Object.freeze(syntheticEnvironment(owner)),
    fetch: async () => { networkCalls++; throw new Error('Owner fixture preparation forbids every network request') },
    query, withTransaction, getPostgresPool })
  const users = load(ENTRIES[8])
  const prepared = await users.ensureOwnerUser()
  assert.equal(prepared.email, owner); assert.equal(prepared.role, 'owner'); assert.equal(prepared.status, 'active')
  const after = (await query(ownerSql, [owner])).rows
  assert.equal(after.length, 1)
  for (const key of ['email','reference_code','contact_reference_code','suitecrm_user_id','suitecrm_username','crm_user_enabled','role','status']) {
    assert.equal(after[0][key], before[0][key], `Actual owner normalization changed mapped identity field ${key}`)
  }
  assert.deepEqual((await query(controlSql)).rows, beforeControl)
  assert.equal(networkCalls, 0)
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  guard()
  return { passed: true, configuredOwnerEmail: owner, actualEnsureOwnerUser: true, networkCalls,
    permissionsBeforeSha256: digest(before[0].permissions), permissionsAfterSha256: digest(after[0].permissions),
    activationTimeInitialized: before[0].activated_at === null && after[0].activated_at !== null,
    phase: 'before-RootA-source-reservation' }
}

/**
 * Prerequisites are explicit synthetic fixture rows, created before RootA:
 * an active real owner/pipeline/workspace and one already-mapped Account /
 * Contact with the exact native/global identities below. Account adoption is
 * not claimed by this meeting acceptance. No PG/native authority is stubbed.
 */
export async function runNativeJointMeetingRoundtrip({ query, withTransaction, getPostgresPool,
  nativeFetch, fixture, authority, deadline }) {
  assert.equal(process.env.TZ, 'UTC', 'The joined meeting fixture must be launched with TZ=UTC')
  const expires = Math.min(deadline, Date.now() + 120_000)
  assert.ok(Number.isFinite(expires) && expires > Date.now(), 'Meeting helper deadline is invalid')
  const guard = () => assert.ok(Date.now() < expires, 'Meeting helper exceeded its 120-second bound')
  assert.equal(fixture.suiteCrmBaseUrl, 'https://suitecrm-joint.example.invalid/legacy')
  assert.match(authority.actorEmail, /^[^@]+@[^@]+\.invalid$/u)
  assert.match(fixture.contactEmail, /^[^@]+@[^@]+\.invalid$/u)
  for (const name of ['clientId', 'clientSecret', 'accessToken', 'nativeAccountId', 'nativeContactId']) {
    assert.ok(typeof fixture[name] === 'string' && fixture[name].length > 0, `Missing private fixture field: ${name}`)
  }
  const owner = authority.actorEmail.toLowerCase()
  const connectionId = 'joint-meeting-calendar-connection'
  const calendarId = owner
  const copyCalendarId = 'joint-attendee-calendar@fixture.invalid'
  const eventId = 'jointmeetingevent01'
  const copyEventId = 'jointmeetingcopy01'
  const key = `joint-synthetic-${randomBytes(24).toString('hex')}`
  const counters = { nativeRequests: 0, nativeBytes: 0, nativePolls: 0, oauthGrants: 0,
    nativeMeetingCreates: 0, nativeMeetingUpdates: 0, calendarRequests: 0,
    calendarPolls: 0, calendarPatches: 0, outboxCompletions: 0 }
  const start = new Date(Date.now() + 86_400_000)
  start.setUTCSeconds(0, 0)
  let event = { id: eventId, iCalUID: 'joint-meeting-invite@fixture.invalid', status: 'confirmed', summary: 'Joint imported meeting',
    description: 'Initial Calendar fixture agenda', location: 'Original fixture room',
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString(), timeZone: 'UTC' },
    attendees: [{ email: fixture.contactEmail }], organizer: { email: owner, self: true },
    htmlLink: 'https://calendar.google.com/event?eid=jointmeetingevent01' }
  let selectedNativeMeetingId = null

  async function boundedFetch(input, init = {}) {
    guard()
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
    const method = String(init.method || 'GET').toUpperCase()
    if (url.origin === 'https://suitecrm-joint.example.invalid') {
      assert.ok(url.pathname.startsWith('/legacy/Api/'), 'Native path escaped actual API transport')
      assert.ok(++counters.nativeRequests <= 60, 'Native meeting request bound exceeded')
      if (url.pathname.endsWith('/Api/access_token')) {
        assert.equal(method, 'POST'); assert.equal(++counters.oauthGrants, 1, 'Unexpected extra OAuth grant')
      } else {
        assert.ok(url.pathname.startsWith('/legacy/Api/V8/'), 'Unexpected native API version')
        if (url.pathname === '/legacy/Api/V8/module' && ['POST', 'PATCH'].includes(method)) {
          const write = JSON.parse(String(init.body))
          assert.equal(write.data?.type, 'Meetings', 'Meeting helper cannot write another native module')
          assert.equal(write.data.id, selectedNativeMeetingId, 'Meeting helper cannot write another meeting')
          if (method === 'POST') counters.nativeMeetingCreates++
          else counters.nativeMeetingUpdates++
        } else if (url.pathname.includes('/relationships/')) {
          const relation = url.pathname.match(/^\/legacy\/Api\/V8\/module\/Meetings\/([^/]+)\/relationships\/(accounts|contact|contacts)$/u)
          assert.ok(relation && relation[1] === selectedNativeMeetingId, 'Unexpected native relationship target')
          assert.ok(['GET', 'POST'].includes(method), 'Unexpected native relationship method')
          if (method === 'POST') {
            const related = JSON.parse(String(init.body)).data
            const account = relation[2] === 'accounts'
            assert.equal(related?.type, account ? 'Accounts' : 'Contacts')
            assert.equal(related?.id, account ? fixture.nativeAccountId : fixture.nativeContactId)
          }
        } else {
          assert.equal(method, 'GET', 'Unexpected native method')
          assert.ok(url.pathname === '/legacy/Api/V8/module/Meetings'
            || url.pathname === `/legacy/Api/V8/module/Meetings/${selectedNativeMeetingId}`,
          'Unexpected native read target')
        }
        if (method === 'GET' && url.pathname === '/legacy/Api/V8/module/Meetings') {
          assert.ok(++counters.nativePolls <= 3, 'Native meeting polling bound exceeded')
        }
      }
      const response = await nativeFetch(url.toString(), { ...init,
        signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, expires - Date.now()))) })
      const body = await response.clone().arrayBuffer()
      counters.nativeBytes += body.byteLength
      assert.ok(counters.nativeBytes <= 2 * 1024 * 1024, 'Native response byte bound exceeded')
      guard()
      return response
    }
    assert.equal(url.origin, 'https://gateway.maton.ai', 'Unexpected external network dependency')
    assert.ok(++counters.calendarRequests <= 30, 'Calendar request bound exceeded')
    const headers = new Headers(init.headers)
    // Do not put key material in assertion actual/expected diagnostics.
    assert.ok(headers.get('Authorization') === `Bearer ${key}`, 'Actual stored credential was not decrypted')
    assert.equal(headers.get('Maton-Connection'), connectionId, 'Actual connection binding changed')
    const prefix = '/google-calendar/calendar/v3/'
    assert.ok(url.pathname.startsWith(prefix), 'Only the Calendar adapter is admitted')
    const route = url.pathname.slice(prefix.length)
    if (method === 'GET' && route === 'users/me/calendarList') {
      return Response.json({ items: [
        { id: calendarId, summary: 'Joint fixture calendar', accessRole: 'owner', primary: true },
        { id: copyCalendarId, summary: 'Joint attendee copy calendar', accessRole: 'writer' },
      ] })
    }
    if (method === 'GET' && route === `calendars/${encodeURIComponent(calendarId)}`) {
      return Response.json({ id: calendarId, summary: 'Joint fixture calendar', timeZone: 'UTC' })
    }
    if (method === 'GET' && route === `calendars/${encodeURIComponent(copyCalendarId)}`) {
      return Response.json({ id: copyCalendarId, summary: 'Joint attendee copy calendar', timeZone: 'UTC' })
    }
    if (method === 'GET' && route === `calendars/${encodeURIComponent(calendarId)}/events`) {
      assert.ok(++counters.calendarPolls <= 3, 'Calendar polling bound exceeded')
      return Response.json({ timeZone: 'UTC', items: [structuredClone(event)], nextSyncToken: `joint-v${counters.calendarPolls}` })
    }
    if (method === 'GET' && route === `calendars/${encodeURIComponent(copyCalendarId)}/events`) {
      assert.ok(++counters.calendarPolls <= 3, 'Calendar polling bound exceeded')
      const copy = { ...event, id: copyEventId, summary: 'Non-authoritative attendee copy',
        organizer: { email: owner, self: false }, extendedProperties: undefined }
      return Response.json({ timeZone: 'UTC', items: [structuredClone(copy)], nextSyncToken: 'joint-copy-v1' })
    }
    if (method === 'PATCH' && route === `calendars/${encodeURIComponent(calendarId)}/events/${eventId}`) {
      assert.ok(++counters.calendarPatches <= 3, 'Calendar PATCH bound exceeded')
      const patch = JSON.parse(String(init.body))
      assert.ok(!Object.hasOwn(patch, 'id'), 'An update may not recreate or rename the event')
      assert.equal(patch.extendedProperties?.private?.clawpilotPipelineId, authority.pipelineId)
      event = { ...event, ...patch, id: eventId, organizer: { email: owner, self: true },
        htmlLink: 'https://calendar.google.com/event?eid=jointmeetingevent01' }
      return Response.json(structuredClone(event))
    }
    throw new Error('Unexpected Calendar operation; create/delete/send are forbidden in this fixture')
  }

  const environment = Object.freeze({ ...syntheticEnvironment(owner),
    AGENT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SUITECRM_BASE_URL: fixture.suiteCrmBaseUrl, SUITECRM_CLIENT_ID: fixture.clientId,
    SUITECRM_CLIENT_SECRET: fixture.clientSecret })
  const load = loadProduction({ environment, fetch: boundedFetch, query, withTransaction, getPostgresPool })
  const crm = load(ENTRIES[0]), actions = load(ENTRIES[1]), discovery = load(ENTRIES[2]), adapter = load(ENTRIES[3])
  const ingestion = load(ENTRIES[4]), native = load(ENTRIES[5]), credentials = load(ENTRIES[6]), crypto = load(ENTRIES[7])

  const empty = await query(`SELECT
    (SELECT count(*)::int FROM sync_outbox WHERE target_system='suitecrm' AND status IN ('queued','processing','failed','dead')) AS outbox,
    (SELECT count(*)::int FROM crm_meetings) AS meetings,
    (SELECT count(*)::int FROM crm_integration_actions) AS actions,
    (SELECT count(*)::int FROM user_maton_credentials WHERE owner_email=$1) AS credentials,
    (SELECT count(*)::int FROM user_maton_connections WHERE owner_email=$1) AS connections`, [owner])
  for (const count of Object.values(empty.rows[0])) assert.equal(count, 0, 'Meeting acceptance requires empty synthetic competing work')
  const contacts = await query(`SELECT contact.id::text, contact.organization_id::text,
    contact.suitecrm_id AS contact_native_id, contact.reference_code AS contact_reference,
    organization.suitecrm_id AS account_native_id, organization.reference_code AS account_reference
    FROM crm_contacts contact JOIN crm_organizations organization ON organization.id=contact.organization_id
    WHERE contact.pipeline_id=$1::uuid AND organization.pipeline_id=$1::uuid
      AND lower(contact.email)=$2 AND contact.suitecrm_id=$3 AND organization.suitecrm_id=$4`,
  [authority.pipelineId, fixture.contactEmail.toLowerCase(), fixture.nativeContactId, fixture.nativeAccountId])
  assert.equal(contacts.rows.length, 1, 'Exact pre-existing real PG/native Account/Contact mapping is required')
  const contact = contacts.rows[0]
  assert.equal(contact.contact_reference, fixture.contactReferenceCode)
  assert.equal(contact.account_reference, fixture.accountReferenceCode)

  const encrypted = crypto.encryptMatonApiKey(key, owner)
  const stored = await credentials.updateMatonCredentialInPostgres({ ownerEmail: owner, setLoginEmail: true, loginEmail: owner,
    apiKey: { ...encrypted, lastFour: key.slice(-4) }, refreshedConnections: [{ connectionId, name: 'Joint synthetic calendar',
      app: 'google-calendar', status: 'ACTIVE', method: null, accountEmail: owner,
      source: 'maton', remoteCreatedAt: null, remoteUpdatedAt: null }], connectionUpserts: [], connectionRemovals: [] })
  assert.equal(stored.configured, true)
  const sources = await adapter.configureCalendarDiscoverySource({ pipelineId: authority.pipelineId,
    organizationId: authority.workspaceOrganizationId, actorEmail: owner, connectionId, calendarId, enabled: true })
  assert.equal(sources.length, 1); assert.equal(sources[0].enabled, true)
  const source = sources[0]
  assert.equal(source.pipelineId, authority.pipelineId)
  assert.equal(source.workspaceOrganizationId, authority.workspaceOrganizationId)
  assert.equal(source.credentialOwnerEmail, owner)
  assert.equal(source.accountEmail, owner)
  assert.equal(source.connectionId, connectionId)
  assert.equal(source.calendarId, calendarId)
  assert.equal(source.timeZone, 'UTC')
  const imported = await discovery.processCalendarDiscovery({ sources: [source], store: adapter.calendarDiscoveryStore })
  assert.equal(imported.errors, 0, 'Actual Calendar discovery/store failed')
  assert.equal(imported.created, 1, 'One real PG meeting must be imported')
  assert.equal(imported.eventsListed, 1)

  async function meeting() {
    guard()
    const result = await query('SELECT * FROM crm_meetings WHERE pipeline_id=$1::uuid AND external_event_id=$2',
      [authority.pipelineId, eventId])
    assert.equal(result.rows.length, 1, 'Calendar event must retain exactly one PG meeting')
    const value = result.rows[0]
    assert.equal(value.organization_id, contact.organization_id)
    assert.equal(value.contact_id, contact.id)
    return value
  }
  let row = await meeting()
  selectedNativeMeetingId = row.suitecrm_id
  const identity = { localId: row.id, referenceCode: row.reference_code,
    suiteCrmId: row.suitecrm_id, calendarId, eventId }
  const associations = await query('SELECT contact_id::text FROM crm_meeting_contacts WHERE meeting_id=$1::uuid', [row.id])
  assert.equal(associations.rows.length, 1); assert.equal(associations.rows[0].contact_id, contact.id)
  assert.equal((await query('SELECT count(*)::int AS count FROM crm_integration_actions')).rows[0].count, 0,
    'Import must not send or create a Calendar event')
  const overlapping = await adapter.configureCalendarDiscoverySource({ pipelineId: authority.pipelineId,
    organizationId: authority.workspaceOrganizationId, actorEmail: owner, connectionId, calendarId: copyCalendarId, enabled: true })
  const copySource = overlapping.find(item => item.calendarId === copyCalendarId)
  assert.equal(overlapping.length, 2); assert.ok(copySource?.enabled)
  const beforeCopy = await query(`SELECT (SELECT count(*)::int FROM crm_meetings) AS meetings,
    (SELECT count(*)::int FROM sync_outbox) AS outbox, (SELECT count(*)::int FROM crm_integration_actions) AS actions`)
  const overlap = await discovery.processCalendarDiscovery({ sources: [copySource], store: adapter.calendarDiscoveryStore })
  assert.equal(overlap.errors, 0); assert.equal(overlap.eventsListed, 1); assert.equal(overlap.created, 0); assert.equal(overlap.updated, 0)
  assert.deepEqual((await query(`SELECT (SELECT count(*)::int FROM crm_meetings) AS meetings,
    (SELECT count(*)::int FROM sync_outbox) AS outbox, (SELECT count(*)::int FROM crm_integration_actions) AS actions`)).rows, beforeCopy.rows)
  assert.deepEqual(await meeting(), row, 'Attendee copy cannot alter the canonical meeting or Calendar authority')

  async function flushMeetingOutbox() {
    for (let iteration = 0; iteration < 12; iteration++) {
      guard()
      const items = await crm.claimSuiteCrmOutboxInPostgres({ limit: 1 })
      if (!items.length) return
      const item = items[0]
      assert.equal(item.aggregateType, 'crm_meetings'); assert.equal(item.aggregateId, identity.localId)
      assert.equal(item.operation, 'upsert_record'); assert.equal(item.payload.suiteCrmId, identity.suiteCrmId)
      const result = await crm.withVerifiedSuiteCrmRecordLifecycle(item,
        () => native.upsertSuiteCrmRecordWithResult(item.payload))
      assert.equal(result.suiteCrmId, identity.suiteCrmId)
      assert.ok(result.meetingProjection, 'Actual native V8 write response must produce the receipt')
      await crm.completeSuiteCrmOutboxInPostgres(item, { meetingProjection: result.meetingProjection })
      assert.ok(++counters.outboxCompletions <= 12, 'Meeting projection revision bound exceeded')
    }
    throw new Error('Meeting outbox did not drain within its bounded revision count')
  }
  await flushMeetingOutbox()
  const initialNative = await native.readSuiteCrmMeetingSnapshot(identity.suiteCrmId)
  assert.equal(initialNative.id, identity.suiteCrmId)
  assert.equal(initialNative.attributes.name, event.summary)

  row = await meeting()
  const recorded = await actions.resolveRecordedCrmMeetingCalendarCommunication({ pipelineId: authority.pipelineId,
    meetingId: row.id, referenceCode: row.reference_code, externalEventId: row.external_event_id, sourcePayload: row.source_payload })
  assert.equal(recorded.actorEmail, owner)
  const forward = { subject: 'ClawPilot edited joint meeting', description: 'ClawPilot forward scalar edit',
    startsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
    endsAt: new Date(start.getTime() + 105 * 60_000).toISOString(), timezone: 'UTC',
    location: 'ClawPilot fixture room', attendeeEmails: [fixture.contactEmail], meetingStatus: 'scheduled', meetingMode: 'in_person' }
  const saveInput = { stageInput: { entity: 'meetings', pipelineId: authority.pipelineId, localId: row.id,
    sourceKey: row.source_key, sourcePayload: { ...row.source_payload, meetingMode: 'in_person' }, actorEmail: owner,
    fields: { organizationId: row.organization_id, organizationSuiteCrmId: fixture.nativeAccountId,
      contactId: row.contact_id, contactIds: [contact.id], parentSuiteCrmId: fixture.nativeContactId,
      parentSuiteCrmType: 'Contacts', subject: forward.subject, description: forward.description,
      startsAt: forward.startsAt, endsAt: forward.endsAt, timezone: 'UTC', location: forward.location,
      attendeeEmails: forward.attendeeEmails, status: 'scheduled', provider: row.provider,
      externalEventId: eventId, externalEventUrl: row.external_event_url, joinUrl: row.join_url } },
    payload: forward, idempotencyKey: `joint-meeting-forward:${row.id}`, communication: recorded.communication,
    previousCalendar: recorded.previousCalendar, expectedMeetingSourceHash: row.source_hash }
  const saved = await actions.stageCrmMeetingAndEnqueueCalendarAction(saveInput)
  assert.equal(saved.created, true)
  const delivered = await actions.processCrmIntegrationActionNow({ actionId: saved.action.id,
    pipelineId: authority.pipelineId, actorEmail: owner })
  assert.equal(delivered.status, 'succeeded', 'Actual forward Calendar action failed')
  assert.equal(event.summary, forward.subject); assert.equal(event.id, eventId)
  assert.equal(event.start.dateTime, forward.startsAt)
  assert.equal(counters.calendarPatches, 1)
  await flushMeetingOutbox()
  const forwardNative = await native.readSuiteCrmMeetingSnapshot(identity.suiteCrmId)
  assert.equal(forwardNative.attributes.name, forward.subject)
  assert.equal(forwardNative.attributes.description, forward.description)
  assert.equal(forwardNative.attributes.location, forward.location)
  const forwardNativeStart = new Date(forwardNative.attributes.date_start).toISOString()
  const forwardNativeDurationMinutes = Number(forwardNative.attributes.duration_hours) * 60
    + Number(forwardNative.attributes.duration_minutes)
  const forwardNativeEnd = forwardNative.attributes.date_end
    ? new Date(forwardNative.attributes.date_end).toISOString()
    : new Date(Date.parse(forwardNativeStart) + forwardNativeDurationMinutes * 60_000).toISOString()
  assert.equal(forwardNativeStart, forward.startsAt, 'Actual native forward start changed')
  assert.equal(forwardNativeDurationMinutes, 45, 'Actual native forward duration changed')
  assert.equal(forwardNativeEnd, forward.endsAt, 'Actual native forward end changed')

  const nativeStart = new Date(start.getTime() + 2 * 60 * 60_000).toISOString()
  const nativeEnd = new Date(start.getTime() + 165 * 60_000).toISOString()
  const scalar = { name: 'Native edited joint meeting', description: 'Actual native V8 scalar edit',
    location: 'Native fixture room', date_start: nativeStart.slice(0, 19).replace('T', ' '),
    date_end: nativeEnd.slice(0, 19).replace('T', ' '), duration_hours: '0', duration_minutes: '45' }
  const independent = await boundedFetch(`${fixture.suiteCrmBaseUrl}/Api/V8/module`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${fixture.accessToken}`, 'Content-Type': 'application/vnd.api+json' },
    body: JSON.stringify({ data: { type: 'Meetings', id: identity.suiteCrmId, attributes: scalar } }) })
  assert.equal(independent.ok, true, 'Independent actual native V8 edit failed')
  const editedNative = await native.readSuiteCrmMeetingSnapshot(identity.suiteCrmId)
  assert.equal(editedNative.attributes.name, scalar.name)
  const reverse = await ingestion.processSuiteCrmMeetingIngestion()
  assert.equal(reverse.errors, 0, 'Actual native list/fresh-read reconciliation failed')
  assert.equal(reverse.pending, false); assert.equal(reverse.meetingsStaged, 1); assert.equal(reverse.calendarActionsQueued, 1)
  row = await meeting()
  assert.equal(row.subject, scalar.name); assert.equal(row.description, scalar.description); assert.equal(row.location, scalar.location)
  assert.equal(new Date(row.starts_at).toISOString(), nativeStart)
  const pending = await query(`SELECT id::text, actor_email FROM crm_integration_actions
    WHERE pipeline_id=$1::uuid AND aggregate_id=$2 AND status='queued' AND action_type='create_calendar_event'`,
  [authority.pipelineId, identity.localId])
  assert.equal(pending.rows.length, 1, 'Exactly one native-edit Calendar action must be queued')
  const reversed = await actions.processCrmIntegrationActionNow({ actionId: pending.rows[0].id,
    pipelineId: authority.pipelineId, actorEmail: pending.rows[0].actor_email })
  assert.equal(reversed.status, 'succeeded', 'Actual reverse Calendar PATCH failed')
  assert.equal(event.id, eventId); assert.equal(event.summary, scalar.name)
  assert.equal(event.location, scalar.location); assert.equal(event.start.dateTime, nativeStart)
  assert.equal(event.end.dateTime, nativeEnd); assert.equal(counters.calendarPatches, 2)
  await flushMeetingOutbox()

  const beforeReplay = await query(`SELECT
    (SELECT count(*)::int FROM crm_meetings) AS meetings,
    (SELECT count(*)::int FROM crm_integration_actions) AS actions,
    (SELECT count(*)::int FROM sync_outbox) AS outbox`)
  const replayNative = await ingestion.processSuiteCrmMeetingIngestion()
  assert.equal(replayNative.errors, 0); assert.equal(replayNative.pending, false)
  assert.equal(replayNative.meetingsStaged, 0); assert.equal(replayNative.calendarActionsQueued, 0)
  const replayCalendar = await discovery.processCalendarDiscovery({ sources: [source], store: adapter.calendarDiscoveryStore })
  assert.equal(replayCalendar.errors, 0); assert.equal(replayCalendar.created, 0)
  // The actual Calendar echo can update retained provider observation metadata;
  // it must not queue provider work or allocate another local/native identity.
  const afterReplay = await query(`SELECT
    (SELECT count(*)::int FROM crm_meetings) AS meetings,
    (SELECT count(*)::int FROM crm_integration_actions) AS actions`)
  assert.equal(afterReplay.rows[0].meetings, beforeReplay.rows[0].meetings)
  assert.equal(afterReplay.rows[0].actions, beforeReplay.rows[0].actions)
  await flushMeetingOutbox()
  row = await meeting()
  assert.equal(row.id, identity.localId); assert.equal(row.reference_code, identity.referenceCode)
  assert.equal(row.suitecrm_id, identity.suiteCrmId); assert.equal(row.external_event_id, eventId)
  assert.equal(counters.nativeMeetingCreates, 1, 'Only one actual native Meeting may be created')
  assert.equal(counters.calendarPatches, 2, 'Replays must not issue another Calendar PATCH')
  const fresh = await native.readSuiteCrmMeetingSnapshot(identity.suiteCrmId)
  assert.equal(fresh.id, identity.suiteCrmId); assert.equal(fresh.attributes.name, scalar.name)
  const receipts = await query(`SELECT count(*)::int AS count FROM sync_outbox WHERE aggregate_type='crm_meetings'
    AND aggregate_id=$1 AND status='succeeded' AND payload ? 'suiteCrmMeetingProjection'`, [identity.localId])
  assert.ok(receipts.rows[0].count >= 3, 'Each edit must retain a real native projection receipt')
  guard()
  return { passed: true, version: 1, proof: 'actual-postgres-and-suitecrm-oauth-v8-controlled-one-event-calendar',
    identity, accountReferenceCode: contact.account_reference, contactReferenceCode: contact.contact_reference,
    counters, receipts: receipts.rows[0].count, imported: { created: imported.created, eventsListed: imported.eventsListed },
    reverse: { meetingsStaged: reverse.meetingsStaged, calendarActionsQueued: reverse.calendarActionsQueued },
    overlappingCalendar: { eventsListed: overlap.eventsListed, created: overlap.created, updated: overlap.updated, sameCanonicalTuple: true },
    replay: { nativeMeetingsStaged: replayNative.meetingsStaged, calendarCreated: replayCalendar.created },
    limitations: ['Synthetic local fixture only', 'Calendar adapter is controlled, not live Google Calendar',
      'Scalar meeting edits only; not recurrence, attendees, or signed-in UI acceptance'] }
}
