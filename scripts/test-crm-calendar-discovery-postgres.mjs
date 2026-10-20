#!/usr/bin/env node
// Disposable local fixture only. No .env loading or real provider access.
// CI defaults to one guarded loopback-only Docker fixture; an explicit owned
// native fixture remains available when Docker is unavailable on the Mac.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
import { applyMigrationSqlForTest } from './lib/postgres-test-migrations.mjs'
import { runStorageGuard } from './local-storage-guard.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 1 && args[0].startsWith('--native-socket=')),
  'Only --native-socket=/tmp/clawpilot-bpo-crm-pg.<id> is supported')
const socket = args[0]?.slice('--native-socket='.length)
if (socket !== undefined) {
  assert.match(socket, /^\/tmp\/clawpilot-bpo-crm-pg\.[A-Za-z0-9]+$/u,
    'Native socket must be an explicit disposable fixture path')
  const directory = lstatSync(socket)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), 'Native fixture must be a real directory')
  assert.equal(directory.uid, process.getuid(), 'Native fixture must belong to the current user')
  assert.equal(directory.mode & 0o077, 0, 'Native fixture must be private to the current user')
  assert.equal(realpathSync(socket), `${realpathSync('/tmp')}/${socket.split('/').at(-1)}`,
    'Native fixture may not traverse a symlink')
  assert.ok(process.env.USER, 'Native fixture requires the current local USER')
  assert.equal(runStorageGuard({ argv: ['--preflight'] }), 0, 'local disk guard must pass')
}
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript'), { Pool } = require('pg')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function load(path, deps = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(path), { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { module, exports: module.exports, Buffer, Date, Intl, URL, URLSearchParams, Response,
    process: { env: {} }, require(name) {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (name === 'node:crypto') return require(name)
      return new Proxy({ __esModule: true }, { get: (target, key) => key === '__esModule' ? true
        : () => { throw new Error(`Unmocked integration ${name}:${String(key)}`) } })
    } }, { filename: path })
  return module.exports
}
const container = `clawpilot-calendar-discovery-test-${process.pid}-${randomUUID().slice(0, 8)}`
let started = false
let pool
let checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
try {
  if (socket) {
    pool = new Pool({ host: socket, port: 55473, user: process.env.USER, password: '',
      database: 'calendar_discovery_test', ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 15000 })
  } else {
    execFileSync('docker', disposablePostgresDockerArgs([
      'run', '--rm', '-d', '--name', container, '--pull', 'never',
      '-e', 'POSTGRES_PASSWORD=calendar_discovery_test', '-e', 'POSTGRES_DB=calendar_discovery_test',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ], { environment: { ...process.env, CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
      CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '256m', CLAWPILOT_TEST_POSTGRES_CPUS: '1' } }),
    { timeout: 60_000, stdio: 'pipe' })
    started = true
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 })
      .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
    assert.ok(port, 'Disposable PostgreSQL must only bind to loopback')
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'calendar_discovery_test',
      database: 'calendar_discovery_test', ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 15000 })
    const deadline = Date.now() + 30_000
    while (true) {
      try { await pool.query('SELECT 1'); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  const migrationClient = await pool.connect()
  try {
    check((await migrationClient.query('SELECT count(*) FROM pg_tables WHERE schemaname=$1', ['public'])).rows[0].count === '0', 'fixture must be empty')
    for (const file of readdirSync(new URL('../db/migrations/', import.meta.url)).filter(file => /^\d+_.+\.sql$/.test(file)).sort()) {
      await applyMigrationSqlForTest(migrationClient, file, read(`db/migrations/${file}`))
    }
  } finally { migrationClient.release() }
  const query = (sql, params) => pool.query(sql, params)
  const withTransaction = async fn => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const postgres = { query, withTransaction, getPostgresPool: () => pool }
  const crm = load('app_src/lib/persistence/crm.ts', {
    '@/lib/persistence/postgres': postgres,
    '@/lib/crm/stableId': load('app_src/lib/crm/stableId.ts'),
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/publicUrl': { appPublicUrl: () => 'https://app.example.invalid' },
    '@/lib/shortlinks': { shortLinkUrl: code => `https://app.example.invalid/s/${code}` },
    '@/lib/auditWriter': { recordAuditEvent: async () => undefined },
    '@/lib/zonedDateTime': load('app_src/lib/zonedDateTime.ts'),
  })
  const owner = 'calendar.fixture@example.invalid', org = randomUUID(), pipeline = randomUUID(), otherOrg = randomUUID(), otherPipeline = randomUUID()
  const connection = 'reviewed-bpo-calendar', personal = 'unselected-personal-calendar', calendar = 'business@example.invalid'
  await query("INSERT INTO app_users(email,role,status,activated_at) VALUES ($1,'owner','active',now())", [owner])
  await query('INSERT INTO user_maton_credentials(owner_email) VALUES ($1)', [owner])
  for (const [organization, id, name] of [[org, pipeline, 'Business'], [otherOrg, otherPipeline, 'Other workspace']]) {
    await query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,$2,'root',$3,$3)", [organization, name, owner])
    await query("INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,created_by,updated_by) VALUES($1,$2,'owner','active',$1,$1)", [owner, organization])
    await query('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)', [id, name, owner, organization])
  }
  for (const [id, email] of [[connection, calendar], [personal, 'personal@gmail.com']]) {
    await query(`INSERT INTO user_maton_connections(owner_email,connection_id,app,name,account_email,status,source,is_selected)
      VALUES($1,$2,'google-calendar',$3,$3,'ACTIVE','maton',false)`, [owner, id, email])
  }
  const stage = input => withTransaction(client => crm.stageCrmRecordWithClient(client, { ...input, actorEmail: owner }))
  const account = await stage({ entity: 'organizations', pipelineId: pipeline, sourceKey: 'account:globus', sourcePayload: { source: 'clawpilot' }, fields: { name: 'Globus fixture' } })
  const secondAccount = await stage({ entity: 'organizations', pipelineId: pipeline, sourceKey: 'account:other', sourcePayload: { source: 'clawpilot' }, fields: { name: 'Other fixture' } })
  const contact = async (name, email, parent = account) => stage({ entity: 'contacts', pipelineId: pipeline,
    sourceKey: `contact:${name}`, sourcePayload: { source: 'clawpilot' },
    fields: { organizationId: parent.id, organizationSuiteCrmId: parent.suiteCrmId, fullName: name, email } })
  const adrian = await contact('Adrian fixture', 'adrian@client.example.invalid')
  const joe = await contact('Joe fixture', 'joe@client.example.invalid')
  await contact('Other fixture', 'other@client.example.invalid', secondAccount)
  const foreignAccount = await stage({ entity: 'organizations', pipelineId: otherPipeline,
    sourceKey: 'account:foreign', sourcePayload: { source: 'clawpilot' }, fields: { name: 'Foreign fixture' } })
  await stage({ entity: 'contacts', pipelineId: otherPipeline, sourceKey: 'contact:foreign-adrian',
    sourcePayload: { source: 'clawpilot' }, fields: { organizationId: foreignAccount.id,
      organizationSuiteCrmId: foreignAccount.suiteCrmId, fullName: 'Foreign Adrian', email: 'adrian@client.example.invalid' } })
  const providerCalls = []
  const discovery = load('app_src/lib/crm/calendarDiscovery.ts', { '@/lib/maton': {}, '@/lib/zonedDateTime': load('app_src/lib/zonedDateTime.ts') })
  const adapter = load('app_src/lib/crm/calendarDiscoveryPersistence.ts', {
    '@/lib/crm/calendarDiscovery': discovery,
    '@/lib/crm/participantEligibility': load('app_src/lib/crm/participantEligibility.ts'),
    '@/lib/persistence/postgres': postgres, '@/lib/persistence/crm': crm,
    '@/lib/integrations/organizationCommunications': { resolveVerifiedPipelineCalendarSelection: async input => ({
      organizationId: org, credentialOwnerEmail: owner, connectionId: input.connectionId,
      accountEmail: calendar, identityEmail: calendar, calendarId: calendar, source: 'meeting-override',
    }) },
    '@/lib/maton': { matonFetch: async (url, init, context) => {
      providerCalls.push({ url, method: init.method, context })
      assert.equal(init.method, 'GET')
      return Response.json({ id: calendar, timeZone: 'America/New_York' })
    } },
  })
  const input = { pipelineId: pipeline, organizationId: org, actorEmail: owner, connectionId: connection, calendarId: calendar, enabled: true }
  let sources = await adapter.configureCalendarDiscoverySource(input)
  check(sources.length === 1 && sources[0].enabled, 'opt-in source persists after verification')
  check(sources[0].connectionId === connection && !sources.some(row => row.connectionId === personal), 'only approved business connection enabled')
  const source = { ...sources[0], timeZone: 'America/New_York' }, store = adapter.calendarDiscoveryStore
  const reconcile = (selectedSource, event) => store.reconcileEvent(selectedSource, {
    observedAt: new Date().toISOString(), ...event,
  })
  await assert.rejects(adapter.configureCalendarDiscoverySource({ ...input, organizationId: otherOrg }), /owner/); checks++
  check(await store.isAuthorized(source), 'owner scope is currently authorized')
  check(!await store.isAuthorized({ ...source, connectionId: personal }), 'forged connection snapshot cannot authorize')
  check(!await store.isAuthorized({ ...source, pipelineId: otherPipeline, workspaceOrganizationId: otherOrg }), 'forged workspace snapshot cannot authorize')
  const event = { externalEventId: 'external-business-event', status: 'confirmed', subject: 'Client discussion', description: 'Fixture agenda',
    startsAt: '2026-10-21T14:00:00.000Z', endsAt: '2026-10-21T14:30:00.000Z', timeZone: 'America/New_York',
    location: '', attendeeEmails: [calendar, 'adrian@client.example.invalid', 'joe@client.example.invalid'],
    matchingAttendeeEmails: ['adrian@client.example.invalid', 'joe@client.example.invalid'], organizerEmail: calendar,
    externalEventUrl: 'https://calendar.google.com/event?eid=fixture', joinUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    recurringEventId: null, originalStartTime: null, clawpilotMeetingReference: null, allowCreate: true }
  check((await reconcile(source, event)).status === 'created', 'matching attendees create native CRM meeting')
  const meeting = (await query('SELECT * FROM crm_meetings WHERE pipeline_id=$1 AND external_event_id=$2', [pipeline, event.externalEventId])).rows[0]
  check(meeting.organization_id === account.id, 'meeting maps to the matched customer account')
  check((await query('SELECT count(*) FROM crm_meetings WHERE pipeline_id=$1', [otherPipeline])).rows[0].count === '0', 'same-email foreign CRM contact never receives the imported meeting')
  const relations = (await query('SELECT contact_id::text FROM crm_meeting_contacts WHERE meeting_id=$1 ORDER BY contact_id', [meeting.id])).rows
  assert.deepEqual(relations.map(row => row.contact_id), [adrian.id, joe.id].sort()); checks++
  const outbox = (await query("SELECT payload FROM sync_outbox WHERE aggregate_id=$1 AND target_system='suitecrm' ORDER BY created_at DESC", [meeting.id])).rows[0].payload
  check(outbox.entity === 'meetings', 'native SuiteCRM Meetings entity receives the imported meeting')
  check(outbox.relationships.filter(row => row.relatedModuleName === 'Contacts').length === 2, 'CRM outbox includes every matched contact')
  check((await query('SELECT count(*) FROM crm_integration_actions')).rows[0].count === '0', 'import queues no Calendar invitation/actions')
  check((await reconcile(source, event)).status === 'unchanged', 'repeat import is idempotent')
  check((await reconcile(source, { ...event, subject: 'Updated agenda' })).status === 'updated', 'Google event edit updates original CRM identity')
  check((await query('SELECT count(*) FROM crm_meetings')).rows[0].count === '1', 'updates never duplicate meeting')
  const pendingAction = (await query(`INSERT INTO crm_integration_actions
    (pipeline_id, actor_email, provider, app, action_type, aggregate_type, aggregate_id, reference_code,
      payload, status, idempotency_key)
    VALUES ($1,$2,'maton','google-calendar','create_calendar_event','crm_meeting',$3,$4,'{}','queued',$5)
    RETURNING id`, [pipeline, owner, meeting.id, meeting.reference_code, `fixture:${meeting.id}`])).rows[0].id
  for (const status of ['queued', 'processing', 'failed', 'dead']) {
    await query('UPDATE crm_integration_actions SET status=$1 WHERE id=$2', [status, pendingAction])
    check((await reconcile(source, { ...event, subject: `Stale provider ${status}` })).status === 'deferred', `${status} outbound intent prevents stale Calendar overwrite`)
    check((await query('SELECT subject FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0].subject === 'Updated agenda', `${status} outbound intent preserves CRM meeting content`)
  }
  await query("UPDATE crm_integration_actions SET status='succeeded' WHERE id=$1", [pendingAction])
  check((await reconcile(source, { ...event, subject: 'Provider after dispatch' })).status === 'updated', 'completed outbound intent releases Calendar reconciliation fence')
  check((await query('SELECT count(*) FROM crm_integration_actions')).rows[0].count === '1', 'discovery never adds an outbound Calendar action')
  const observedAt = new Date(Number((await query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms')).rows[0].now_ms) - 1000).toISOString()
  await query("UPDATE crm_meetings SET subject='Newer local intent', status='scheduled', updated_at=clock_timestamp() WHERE id=$1", [meeting.id])
  check((await reconcile(source, { ...event, observedAt, subject: 'Stale confirmed event' })).status === 'deferred', 'stale snapshot cannot overwrite a completed local edit without a pending action')
  check((await reconcile(source, { ...event, observedAt, status: 'cancelled', startsAt: null, endsAt: null,
    matchingAttendeeEmails: [], attendeeEmails: [], allowCreate: false })).status === 'deferred', 'stale cancellation cannot cancel newer local intent')
  const localIntent = (await query('SELECT subject,status FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0]
  check(localIntent.subject === 'Newer local intent' && localIntent.status === 'scheduled', 'newer local meeting content and status survive stale snapshots')
  await query("UPDATE crm_meetings SET status='cancelled', updated_at=clock_timestamp() WHERE id=$1", [meeting.id])
  check((await reconcile(source, { ...event, observedAt })).status === 'deferred', 'stale confirmed event cannot resurrect a newer local cancellation')
  check((await query('SELECT status FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0].status === 'cancelled', 'local cancellation remains retained')
  check((await reconcile(source, { ...event, joinUrl: null, location: 'Client office' })).status === 'updated', 'fresh provider location edit replaces previous Meet details')
  const physical = (await query('SELECT join_url,source_payload FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0]
  check(physical.join_url === null && physical.source_payload.meetingMode === 'in_person'
    && physical.source_payload.customJoinUrl === null, 'removing Meet clears its link and updates meeting mode')
  const customJoinUrl = 'https://video.example.invalid/client-meeting'
  check((await reconcile(source, { ...event, joinUrl: customJoinUrl, location: '' })).status === 'updated', 'fresh custom video link updates existing imported meeting')
  const virtual = (await query('SELECT join_url,source_payload FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0]
  check(virtual.join_url === customJoinUrl && virtual.source_payload.meetingMode === 'custom_link'
    && virtual.source_payload.customJoinUrl === customJoinUrl, 'custom-link mode and URL match provider snapshot')
  check((await reconcile(source, { ...event, joinUrl: null, location: '' })).status === 'updated', 'fresh no-location snapshot can remove a custom meeting link')
  const unspecified = (await query('SELECT join_url,source_payload FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0]
  check(unspecified.join_url === null && unspecified.source_payload.meetingMode === 'unspecified'
    && unspecified.source_payload.customJoinUrl === null, 'no-location snapshot clears old custom link without creating Meet')
  check((await reconcile(source, { ...event, matchingAttendeeEmails: ['adrian@client.example.invalid', 'other@client.example.invalid'] })).status === 'ambiguous', 'multi-account meeting stays fail-closed')
  check((await reconcile(source, { ...event, externalEventId: 'unmatched', matchingAttendeeEmails: ['unknown@example.invalid'] })).status === 'unmatched', 'unmatched event is not copied')
  check((await reconcile(source, { ...event, externalEventId: 'untrusted-marker', clawpilotMeetingReference: 'gm1234567' })).status === 'skipped', 'unrecognized marker cannot duplicate or rebind CRM records')
  check((await reconcile(source, { ...event, status: 'cancelled', startsAt: null, endsAt: null,
    matchingAttendeeEmails: [], attendeeEmails: [], allowCreate: false })).status === 'updated', 'minimal cancellation updates known meeting')
  check((await query('SELECT status FROM crm_meetings WHERE id=$1', [meeting.id])).rows[0].status === 'cancelled', 'cancellation retained in CRM')
  check((await query('SELECT count(*) FROM crm_meeting_contacts WHERE meeting_id=$1', [meeting.id])).rows[0].count === '2', 'cancellation preserves contact associations')
  await query("UPDATE crm_meetings SET source_payload=source_payload || '{\"archived\":true}'::jsonb WHERE id=$1", [meeting.id])
  check((await reconcile(source, event)).status === 'skipped', 'archived meeting is never resurrected')
  await adapter.configureCalendarDiscoverySource({ ...input, enabled: false })
  check(!await store.isAuthorized(source), 'paused source revokes discovery authority')
  check((await reconcile(source, { ...event, externalEventId: 'after-pause' })).status === 'deferred', 'revalidation prevents mutation after pause')
  check(providerCalls.every(call => call.method === 'GET'), 'all provider verification is read-only')
  console.log(`CRM calendar discovery Postgres passed: ${checks} checks; complete migration chain, real staging/outbox/relationships, scoped source and cancellation lifecycle.`)
} finally {
  try { if (pool) await pool.end() } finally {
    if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' })
  }
}
