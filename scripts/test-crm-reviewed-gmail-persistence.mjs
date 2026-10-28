#!/usr/bin/env node
// One guarded disposable PostgreSQL fixture: Docker by default, or an explicit
// private native socket. No app env files, credentials or provider calls.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { runStorageGuard } from './local-storage-guard.mjs'
import { loadInteractionCompanyReader } from './lib/crm-interaction-company-fixture.mjs'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

const require = createRequire(import.meta.url)
const appRequire = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = appRequire('typescript')
const { Pool } = appRequire('pg')
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1, 'Only one optional private native socket is supported')
const socket = args[0]?.slice('--native-socket='.length)
if (socket !== undefined) {
  assert.match(args[0], /^--native-socket=\/tmp\/clawpilot-bpo-crm-pg\.[A-Za-z0-9]+$/)
  const directory = lstatSync(socket)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink())
  assert.equal(directory.uid, process.getuid())
  assert.equal(directory.mode & 0o077, 0)
  assert.equal(realpathSync(socket), `${realpathSync('/tmp')}/${socket.split('/').at(-1)}`)
  assert.ok(process.env.USER)
  assert.equal(runStorageGuard({ argv: ['--preflight'] }), 0)
}

function declarations(path, names) {
  const parsed = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const declaration = parsed.statements.find(statement => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body
    ) || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => item.name.getText(parsed) === name)))
    assert.ok(declaration, `Actual declaration ${name} must exist`)
    return declaration.getText(parsed).replace(/^export\s+/u, '')
  }).join('\n')
}

// Reuse the existing fixture schema/actual-production declaration loader, not
// its runner. Importing this test never starts a second server or Docker task.
const fixtureContext = { ts, read, assert, vm, Buffer, TextDecoder, URL, URLSearchParams, Response, AbortSignal,
  nodeRequire: require, unexpected: name => { throw new Error(`Unexpected external dependency ${name}`) } }
vm.runInNewContext(ts.transpileModule(declarations('scripts/test-crm-email-routing-postgres.mjs',
  ['loadModule', 'loadCrmPersistence', 'fixtureSchema']), {
  compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
}).outputText + '\nglobalThis.fixture = { loadCrmPersistence, fixtureSchema };', fixtureContext)

const container = `clawpilot-reviewed-email-test-${process.pid}-${randomUUID().slice(0, 8)}`
let pool, started = false
try {
  if (socket) {
    pool = new Pool({ host: socket, port: 55473, user: process.env.USER, password: '',
      database: 'reviewed_email_test', ssl: false, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
  } else {
    execFileSync('docker', disposablePostgresDockerArgs([
      'run', '--rm', '-d', '--name', container, '--pull', 'never',
      '-e', 'POSTGRES_PASSWORD=reviewed_email_test', '-e', 'POSTGRES_DB=reviewed_email_test',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ], { environment: { ...process.env, CLAWPILOT_TEST_POSTGRES_MEMORY: '512m',
      CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE: '256m', CLAWPILOT_TEST_POSTGRES_CPUS: '1' } }),
    { timeout: 60_000, stdio: 'pipe' })
    started = true
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 })
      .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
    assert.ok(port, 'Disposable PostgreSQL binds only to loopback')
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'reviewed_email_test',
      database: 'reviewed_email_test', ssl: false, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
    const deadline = Date.now() + 30_000
    while (true) {
      try { await pool.query('SELECT 1'); break }
      catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
  }
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, '0', 'Fixture must start empty')
  const query = (sql, values) => pool.query(sql, values)
  const withTransaction = async callback => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  await query(fixtureContext.fixture.fixtureSchema)
  await query(read('db/migrations/0374_crm_interaction_organizations.sql'))
  await query(`ALTER TABLE crm_contacts ADD COLUMN phone_work text, ADD COLUMN phone_mobile text, ADD COLUMN job_title text;
    ALTER TABLE crm_leads ADD COLUMN phone_work text, ADD COLUMN phone_mobile text, ADD COLUMN job_title text;
    ALTER TABLE crm_opportunities ADD COLUMN name text, ADD COLUMN reference_code text;
    ALTER TABLE crm_meetings ADD COLUMN subject text, ADD COLUMN reference_code text;
    CREATE TABLE crm_campaigns (id uuid,pipeline_id uuid,name text,reference_code text);`)
  const persistence = fixtureContext.fixture.loadCrmPersistence(query, withTransaction)
  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  const OWNER = 'operator@example.test', CONNECTION = 'reviewed-fixture-mailbox'
  const PIPELINE = id(1), CACHE_PIPELINE = id(2), FOREIGN_PIPELINE = id(3), WORKSPACE = id(4)
  const GLOBUS = id(10), AIRSPACE = id(11), OTHER = id(12), GC = id(20), AC = id(21)
  await query(`INSERT INTO app_users VALUES ($1,'active','Operator',NULL,true,'gu1234567');`, [OWNER])
  await query('INSERT INTO workspace_organizations VALUES ($1,true)', [WORKSPACE])
  for (const pipeline of [PIPELINE, CACHE_PIPELINE, FOREIGN_PIPELINE]) await query(`INSERT INTO pipeline_spaces
    (id,owner_email,workspace_organization_id,is_default) VALUES ($1,$2,$3,$4)`, [pipeline, OWNER, WORKSPACE, pipeline === CACHE_PIPELINE])
  await query(`INSERT INTO app_user_organization_memberships VALUES ($1,$2,'active')`, [WORKSPACE, OWNER])
  await query(`INSERT INTO user_maton_connections VALUES ($1,$2,'mailbox@example.test','google-mail','ACTIVE','maton',true)`, [OWNER, CONNECTION])
  for (const [organization, name, reference, native] of [[GLOBUS, 'Globus Medical', 'ga1234567', 'native-globus'], [AIRSPACE, 'Airspace', 'ga2345678', 'native-airspace'], [OTHER, 'Other', 'ga3456789', 'native-other']]) {
    await query(`INSERT INTO crm_organizations (id,pipeline_id,name,reference_code,source_key,suitecrm_id)
      VALUES ($1,$2,$3,$4,$4,$5)`, [organization, PIPELINE, name, reference, native])
  }
  for (const [contact, organization, reference, email, native] of [[GC, GLOBUS, 'gc1234567', 'joseph@globus.example.test', 'native-joseph'], [AC, AIRSPACE, 'gc2345678', 'riley@airspace.example.test', 'native-riley']]) {
    await query(`INSERT INTO crm_contacts (id,pipeline_id,organization_id,full_name,email,reference_code,source_key,suitecrm_id)
      VALUES ($1,$2,$3,$4,$5,$4,$4,$6)`, [contact, PIPELINE, organization, reference, email, native])
  }
  const contactTargets = [{ id: GC, referenceCode: 'gc1234567', email: 'joseph@globus.example.test', organizationId: GLOBUS },
    { id: AC, referenceCode: 'gc2345678', email: 'riley@airspace.example.test', organizationId: AIRSPACE }]
  const cacheMessage = async messageId => {
    const headers = { from: [{ address: contactTargets[1].email }], to: [{ address: OWNER }, { address: contactTargets[0].email }], cc: [], bcc: [] }
    await query(`INSERT INTO crm_inbound_messages (owner_email,pipeline_id,external_message_id,external_thread_id,
      sender_email,recipient_emails,subject,received_at,snippet,body_text,marker_references,raw_metadata,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,'Synthetic reviewed subject','2026-10-27T12:00:00.123Z','Synthetic snippet','Synthetic body','{}',$7::jsonb,now())`,
    [OWNER, CACHE_PIPELINE, messageId, `thread-${messageId}`, contactTargets[1].email, [OWNER, contactTargets[0].email],
      JSON.stringify({ provider: 'gmail', emailAddressHeaders: headers, labelIds: ['INBOX'] })])
  }
  const selection = messageId => ({ ownerEmail: OWNER, connectionId: CONNECTION, pipelineId: PIPELINE,
    providerMessageId: messageId, providerThreadId: `thread-${messageId}`, primaryOrganization: { id: GLOBUS, referenceCode: 'ga1234567' },
    contactTargets, participantEmails: contactTargets.map(target => target.email), interaction: {
      entity: 'interactions', pipelineId: PIPELINE, actorEmail: OWNER, sourceKey: `fixture-reviewed:${messageId}`,
      sourcePayload: { source: 'gmail-inbound', retained: true }, fields: { interactionType: 'email', subject: 'Synthetic reviewed subject',
        description: 'Synthetic body', occurredAt: '2026-10-27T12:00:00.123Z', agentEmail: OWNER, direction: 'inbound', deliveryStatus: 'received',
        providerMessageId: messageId, providerThreadId: `thread-${messageId}`, metadata: { source: 'gmail-inbound' } },
    } })
  const counts = async () => (await query(`SELECT (SELECT count(*) FROM crm_interactions)::int AS interactions,
    (SELECT count(*) FROM crm_interaction_contacts)::int AS contacts,
    (SELECT count(*) FROM crm_interaction_organizations)::int AS organizations`)).rows[0]
  let passed = 0
  const check = async (name, callback) => { await callback(); passed += 1; console.log(`PASS ${name}`) }
  await cacheMessage('d1')
  let original, firstPreview
  await check('read-only preview locks authoritative owner-default cache without cross-pipeline confusion', async () => {
    const before = await counts()
    firstPreview = await persistence.stageReviewedGmailInteractionInPostgres(selection('d1'))
    assert.equal(firstPreview.interactionId, null)
    assert.ok(firstPreview.inboundMessageId)
    assert.equal(firstPreview.applied, false)
    assert.deepEqual(await counts(), before)
  })
  await check('reviewed create stages one email, two companies and both native contact relationships atomically', async () => {
    original = await persistence.stageReviewedGmailInteractionInPostgres({ ...selection('d1'), apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: firstPreview.targetFingerprint })
    assert.equal(original.applied, true)
    assert.deepEqual(await counts(), { interactions: 1, contacts: 2, organizations: 2 })
    const row = (await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0]
    assert.equal(row.organization_id, GLOBUS)
    assert.equal(row.contact_id, GC)
    assert.equal(row.metadata.inboundMessageId, original.inboundMessageId)
    assert.equal(row.description, 'Synthetic body')
    assert.equal(row.occurred_at.toISOString(), '2026-10-27T12:00:00.123Z')
  })
  await check('repeat review retains original fingerprint and produces no record or relationship writes', async () => {
    const before = (await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0]
    const preview = await persistence.stageReviewedGmailInteractionInPostgres(selection('d1'))
    assert.equal(preview.targetFingerprint, firstPreview.targetFingerprint)
    const replay = await persistence.stageReviewedGmailInteractionInPostgres({ ...selection('d1'), apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: firstPreview.targetFingerprint })
    assert.equal(replay.applied, false)
    assert.equal(replay.interactionId, original.interactionId)
    assert.deepEqual((await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0], before)
  })
  await check('actual account history/search/list readers return the same one email and contact company labels', async () => {
    const reader = loadInteractionCompanyReader(query)
    const base = { pipelineId: PIPELINE, entity: 'interactions' }
    for (const organization of [GLOBUS, AIRSPACE]) {
      const rows = await reader.listCrmRecordsInPostgres({ ...base, relatedEntity: 'organizations', relatedId: organization })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, original.interactionId)
      assert.equal(rows[0].organizations.length, 2)
      const contacts = rows[0].contacts
      assert.equal(contacts.find(contact => contact.id === AC).organizationId, AIRSPACE)
      assert.equal(contacts.find(contact => contact.id === GC).organizationId, GLOBUS)
    }
    assert.equal((await reader.listCrmRecordsInPostgres(base)).length, 1)
    assert.equal((await reader.listCrmRecordsInPostgres({ ...base, query: 'Airspace' })).length, 1)
    assert.equal((await reader.listCrmRecordsInPostgres({ ...base, query: 'ga2345678' })).length, 1)
    assert.equal((await reader.listCrmRecordsInPostgres({ ...base, query: 'not-a-present-customer' })).length, 0)
    assert.equal((await reader.listCrmRecordsInPostgres({ ...base, pipelineId: FOREIGN_PIPELINE, relatedEntity: 'organizations', relatedId: AIRSPACE })).length, 0)
  })
  await check('actual native relationship producer emits both Accounts for one preserved Email identity', async () => {
    const path = 'app_src/lib/persistence/crm.ts'
    const context = { Error }
    const names = ['clean', 'isoTimestamp', 'suiteCrmDateTime', 'normalizedInteractionType', 'interactionSuiteCrmModule',
      'interactionActivityStatus', 'interactionDurationMinutes', 'suiteCrmAttributes', 'suiteCrmRelationships']
    vm.runInNewContext(ts.transpileModule(declarations(path, names), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
      + '\nglobalThis.native = {suiteCrmAttributes,suiteCrmRelationships}', context)
    const row = (await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0]
    const input = { entity: 'interactions', pipelineId: PIPELINE, localId: row.id, fields: {
      interactionType: 'email', subject: row.subject, description: row.description, deliveryStatus: 'received',
      occurredAt: row.occurred_at.toISOString(), organizationId: row.organization_id, parentSuiteCrmId: 'native-globus', parentSuiteCrmType: 'Accounts' } }
    const relationships = await context.native.suiteCrmRelationships({ query }, input)
    assert.deepEqual(Array.from(relationships.filter(link => link.linkFieldName === 'accounts'), link => link.relatedBeanId).sort(), ['native-airspace', 'native-globus'])
    assert.equal(relationships.filter(link => link.linkFieldName === 'contacts').length, 2)
    const payload = context.native.suiteCrmAttributes(input, row.reference_code)
    assert.equal(payload.parent_id, 'native-globus')
    assert.equal(payload.description, 'Synthetic body')
    assert.equal((await counts()).interactions, 1)
    const module = { exports: {} }
    vm.runInNewContext(ts.transpileModule(read('app_src/lib/crm/suiteCrmClient.ts'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Response, AbortSignal,
      process: { env: { SUITECRM_BASE_URL: 'https://crm.example.test', SUITECRM_CLIENT_ID: 'fixture-client', SUITECRM_CLIENT_SECRET: 'fixture-secret' } },
      require: name => name.startsWith('node:') ? require(name)
        : new Proxy({}, { get: () => () => { throw new Error(`Unexpected native transport dependency ${name}`) } }),
    })
    const accountPosts = [], emailPatches = []
    const fetchMock = async (url, init) => {
      if (url.endsWith('/Api/access_token')) return Response.json({ access_token: 'synthetic-test-token', expires_in: 3600 })
      if (init.method === 'GET' && url.includes('/relationships/')) return Response.json({ data: [] })
      if (init.method === 'GET') {
        assert.ok(url.endsWith(`/Api/V8/module/Emails/${row.suitecrm_id}`))
        return Response.json({ data: { id: row.suitecrm_id, attributes: {} } })
      }
      const body = JSON.parse(init.body)
      if (init.method === 'PATCH') {
        assert.equal(body.data.id, row.suitecrm_id)
        assert.equal(body.data.type, 'Emails')
        emailPatches.push(body)
        return Response.json({ data: { id: row.suitecrm_id } })
      }
      assert.equal(init.method, 'POST')
      assert.ok(url.includes(`/Emails/${row.suitecrm_id}/relationships/`))
      if (url.endsWith('/relationships/accounts')) accountPosts.push(body.data.id)
      else assert.ok(url.endsWith('/relationships/contacts'))
      return Response.json({ data: body.data })
    }
    const transport = await module.exports.upsertSuiteCrmRecordWithResult({ entity: 'interactions', pipelineId: PIPELINE,
      localId: row.id, suiteCrmId: row.suitecrm_id, suiteCrmModule: 'Emails', attributes: payload, relationships }, fetchMock)
    assert.equal(transport.suiteCrmId, row.suitecrm_id)
    assert.equal(emailPatches.length, 1)
    assert.deepEqual(accountPosts.sort(), ['native-airspace', 'native-globus'])
  })
  await check('generic writes cannot forge company scope, review receipt, provider identity or remove reviewed contacts', async () => {
    const current = (await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0]
    const write = fields => persistence.stageCrmRecordInPostgres({ entity: 'interactions', pipelineId: PIPELINE,
      localId: current.id, sourceKey: current.source_key, actorEmail: OWNER, sourcePayload: current.source_payload,
      fields: { subject: current.subject, ...fields } })
    for (const fields of [{ organizationIds: [GLOBUS, AIRSPACE, OTHER] }, { contactIds: [GC] }, { organizationId: AIRSPACE },
      { providerMessageId: 'forged' }, { interactionType: 'note' }, { metadata: { reviewedGmailRecovery: { forged: true } } }]) {
      await assert.rejects(write(fields))
    }
    await write({ description: 'Ordinary content edit', subject: 'Edited subject' })
    assert.deepEqual(await counts(), { interactions: 1, contacts: 2, organizations: 2 })
    assert.equal((await query('SELECT organization_id,provider_message_id FROM crm_interactions WHERE id=$1', [current.id])).rows[0].provider_message_id, 'd1')
    const edited = (await query('SELECT agent_email,agent_name,metadata,source_payload,occurred_at FROM crm_interactions WHERE id=$1', [current.id])).rows[0]
    assert.equal(edited.agent_email, current.agent_email)
    assert.equal(edited.agent_name, current.agent_name)
    assert.deepEqual(edited.metadata, current.metadata)
    assert.deepEqual(edited.source_payload, current.source_payload)
    assert.equal(edited.occurred_at.toISOString(), current.occurred_at.toISOString())
    await assert.rejects(persistence.stageReviewedGmailInteractionInPostgres({ ...selection('d1'), apply: true,
      expectedExistingInteractionId: current.id, expectedTargetFingerprint: firstPreview.targetFingerprint }))
    await query('UPDATE crm_interactions SET agent_email=NULL,agent_name=$2 WHERE id=$1', [current.id, 'Historical Author'])
    await write({ subject: 'Edited legacy subject', agentEmail: '', agentName: 'Historical Author' })
    const historic = (await query('SELECT agent_email,agent_name FROM crm_interactions WHERE id=$1', [current.id])).rows[0]
    assert.deepEqual(historic, { agent_email: null, agent_name: 'Historical Author' },
      'The API-normalized empty agent email must preserve a persisted NULL without resolving the historic name')
    await assert.rejects(write({ subject: 'Forbidden reassignment', agentEmail: 'changed@example.test', agentName: 'Historical Author' }),
      /historic agent assignment must be preserved/)
    assert.deepEqual((await query('SELECT agent_email,agent_name FROM crm_interactions WHERE id=$1', [current.id])).rows[0], historic)
  })
  await check('CAS rechecks contact email and validates the entire batch before creating its first email', async () => {
    await cacheMessage('d2'); await cacheMessage('d3')
    const messages = [selection('d2'), selection('d3')]
    const previews = await persistence.stageReviewedGmailInteractionsInPostgres({ messages })
    const applyMessages = messages.map((message, index) => ({ ...message, expectedExistingInteractionId: null, expectedTargetFingerprint: previews[index].targetFingerprint }))
    const before = await counts()
    await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages: [applyMessages[0], { ...applyMessages[1], expectedTargetFingerprint: 'stale' }], apply: true }))
    assert.deepEqual(await counts(), before)
    await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [AC, 'changed@example.test'])
    await assert.rejects(persistence.stageReviewedGmailInteractionInPostgres({ ...applyMessages[0], apply: true }))
    assert.deepEqual(await counts(), before)
    await query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [AC, contactTargets[1].email])
  })
  await check('composite foreign keys reject a related-company link crossing the pipeline boundary', async () => {
    const before = await counts()
    // This Email/Other pair is unused. Reusing its existing Airspace pair would
    // hit the pair's primary key before PostgreSQL could check pipeline scope.
    await assert.rejects(query(`INSERT INTO crm_interaction_organizations (pipeline_id,interaction_id,organization_id)
      VALUES ($1,$2,$3)`, [FOREIGN_PIPELINE, original.interactionId, OTHER]), error => error.code === '23503'
        && ['crm_interaction_organizations_pipeline_interaction_fkey', 'crm_interaction_organizations_pipeline_organization_fkey'].includes(error.constraint))
    assert.deepEqual(await counts(), before)
  })
  await check('legacy Notes or missing native modules remain unchanged and require explicit reprojection', async () => {
    await cacheMessage('d4')
    const request = selection('d4')
    const legacy = await persistence.stageCrmRecordInPostgres({ ...request.interaction,
      fields: { ...request.interaction.fields, organizationId: GLOBUS, contactIds: [GC] } })
    for (const moduleName of ['Notes', null]) {
      await query('UPDATE crm_interactions SET suitecrm_module=$2 WHERE id=$1', [legacy.id, moduleName])
      const before = (await query('SELECT * FROM crm_interactions WHERE id=$1', [legacy.id])).rows[0]
      await assert.rejects(persistence.stageReviewedGmailInteractionInPostgres(request), /conflicts with existing CRM relationships/)
      assert.deepEqual((await query('SELECT * FROM crm_interactions WHERE id=$1', [legacy.id])).rows[0], before)
      assert.equal((await query('SELECT count(*) FROM crm_interaction_organizations WHERE interaction_id=$1', [legacy.id])).rows[0].count, '1')
    }
  })
  await check('a concurrent contact writer makes bounded review fail immediately without staging', async () => {
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('LOCK TABLE crm_contacts IN ROW EXCLUSIVE MODE')
      await assert.rejects(persistence.stageReviewedGmailInteractionInPostgres(selection('d2')), /busy; retry a fresh preview/)
    } finally { await writer.query('ROLLBACK'); writer.release() }
  })
  console.log(`PASS ${passed} reviewed Gmail persistence checks; actual SQL/readers/native payload producer; no provider writes`)
} finally {
  try { if (pool) await pool.end() }
  finally { if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' }) }
}
