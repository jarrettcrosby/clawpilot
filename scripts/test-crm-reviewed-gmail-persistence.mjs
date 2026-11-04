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
}).outputText + '\nglobalThis.fixture = { loadModule, loadCrmPersistence, fixtureSchema };', fixtureContext)

const container = `clawpilot-reviewed-email-test-${process.pid}-${randomUUID().slice(0, 8)}`
let pool, started = false
try {
  if (socket) {
    pool = new Pool({ host: socket, port: 55473, user: process.env.USER, password: '',
      database: 'reviewed_email_test', ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 5000,
      application_name: container })
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
      database: 'reviewed_email_test', ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 5000,
      application_name: container })
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
  // The real member table has these full-row fields; migration 0377 fences
  // their preimages during an active authority transition as well as its IDs.
  await query(`ALTER TABLE pipeline_space_members ADD COLUMN shared_by text,
    ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now()`)
  const outboxTable = read('db/migrations/0001_initial_railway_postgres.sql')
    .match(/CREATE TABLE IF NOT EXISTS sync_outbox \([\s\S]*?\n\);/u)?.[0]
  assert.ok(outboxTable, 'Use the real outbox table definition, not a permissive mock')
  await query(outboxTable)
  await query(read('db/migrations/0002_pipeline_outbox_worker.sql'))
  await query(read('db/migrations/0374_crm_interaction_organizations.sql'))
  // Exercise the real default-off publication controls, not a missing-schema
  // fallback. These migrations do not activate native publishing or permissions.
  await query(read('db/migrations/0375_crm_native_email_publication_admission.sql'))
  await query(read('db/migrations/0376_crm_native_email_publication_work_context.sql'))
  await query(read('db/migrations/0377_crm_native_email_authority_transitions.sql'))
  await query(read('db/migrations/0378_crm_native_email_capability_policies.sql'))
  await query(read('db/migrations/0379_crm_native_email_app_only_lifecycle.sql'))
  await query(read('db/migrations/0380_crm_native_email_grant_attempts.sql'))
  await query(read('db/migrations/0381_crm_native_email_identity_quiescence.sql'))
  await query(`ALTER TABLE crm_contacts ADD COLUMN phone_work text, ADD COLUMN phone_mobile text, ADD COLUMN job_title text;
    ALTER TABLE crm_leads ADD COLUMN phone_work text, ADD COLUMN phone_mobile text, ADD COLUMN job_title text;
    ALTER TABLE crm_opportunities ADD COLUMN name text, ADD COLUMN reference_code text;
    ALTER TABLE crm_meetings ADD COLUMN subject text, ADD COLUMN reference_code text;
    CREATE TABLE crm_campaigns (id uuid,pipeline_id uuid,name text,reference_code text);
    ALTER TABLE pipeline_spaces ADD COLUMN crm_last_synced_at timestamptz, ADD COLUMN updated_at timestamptz DEFAULT now();`)
  const persistence = fixtureContext.fixture.loadCrmPersistence(query, withTransaction)
  const emailIdentity = fixtureContext.fixture.loadModule('app_src/lib/crm/emailIdentity.ts')
  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  const OWNER = 'operator@example.test', CONNECTION = 'reviewed-fixture-mailbox', MAILBOX = 'mailbox@example.test'
  const PIPELINE = id(1), CACHE_PIPELINE = id(2), FOREIGN_PIPELINE = id(3), WORKSPACE = id(4)
  const GLOBUS = id(10), AIRSPACE = id(11), OTHER = id(12), GC = id(20), AC = id(21)
  await query(`INSERT INTO app_users (email,status,display_name,suitecrm_user_id,crm_user_enabled,reference_code) VALUES ($1,'active','Operator','native-fixture-owner',true,'gu1234567');`, [OWNER])
  await query('INSERT INTO workspace_organizations VALUES ($1,true)', [WORKSPACE])
  for (const pipeline of [PIPELINE, CACHE_PIPELINE, FOREIGN_PIPELINE]) await query(`INSERT INTO pipeline_spaces
    (id,owner_email,workspace_organization_id,is_default) VALUES ($1,$2,$3,$4)`, [pipeline, OWNER, WORKSPACE, pipeline === CACHE_PIPELINE])
  await query(`INSERT INTO app_user_organization_memberships (organization_id,user_email,status) VALUES ($1,$2,'active')`, [WORKSPACE, OWNER])
  await query(`INSERT INTO user_maton_connections VALUES ($1,$2,'mailbox@example.test','google-mail','ACTIVE','maton',true)`, [OWNER, CONNECTION])
  // Synthetic already-verified subject enters only at the trusted durable
  // binder boundary. This fixture performs no JWT verification or provider call.
  await persistence.bindVerifiedGmailMailboxInPostgres({ ownerEmail: OWNER, connectionId: CONNECTION,
    identity: { subject: 'synthetic-reviewed-google-subject', email: MAILBOX }, observedAccountEmail: MAILBOX })
  const mailboxIdentity = await persistence.readVerifiedGmailMailboxIdentityInPostgres({ ownerEmail: OWNER,
    connectionId: CONNECTION, accountEmail: MAILBOX })
  assert.ok(mailboxIdentity)
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
  const evidence = messageId => emailIdentity.normalizeGmailMessageEvidence({ externalMessageId: messageId,
    externalThreadId: `thread-${messageId}`, senderEmail: contactTargets[1].email,
    recipientEmails: [OWNER, contactTargets[0].email], subject: 'Synthetic reviewed subject',
    receivedAt: '2026-10-27T12:00:00.123Z', snippet: 'Synthetic snippet', bodyText: 'Synthetic body', markerReferences: [],
    emailAddressHeaders: { version: 1, from: [{ address: contactTargets[1].email }],
      to: [{ address: OWNER }, { address: contactTargets[0].email }], cc: [], bcc: [] } })
  const cacheMessage = messageId => persistence.recordGmailMessageIntakeInPostgres({ ownerEmail: OWNER,
    connectionId: CONNECTION, intakePipelineId: CACHE_PIPELINE, mailboxIdentity,
    observedAccountEmail: MAILBOX, observedAt: new Date().toISOString(), messageEvidence: evidence(messageId),
    rawMetadata: { labelIds: ['INBOX'] } })
  const selection = messageId => ({ ownerEmail: OWNER, connectionId: CONNECTION, pipelineId: PIPELINE,
    mailboxIdentity, messageEvidence: evidence(messageId),
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
  const durableState = async () => (await query(`SELECT jsonb_build_object(
    'interactions',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM crm_interactions row),
    'contacts',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY interaction_id,contact_id),'[]') FROM crm_interaction_contacts row),
    'companies',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY interaction_id,organization_id),'[]') FROM crm_interaction_organizations row),
    'cache',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM crm_inbound_messages row),
    'links',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY inbound_message_id,reference_code),'[]') FROM crm_inbound_message_links row),
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM crm_email_sources row),
    'decisions',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM crm_email_review_decisions row),
    'outbox',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM sync_outbox row),
    'audits',(SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY id),'[]') FROM audit_events row)) AS state`)).rows[0].state
  const compatibleFixtureWrite = callback => withTransaction(async client => {
    await client.query("SET LOCAL clawpilot.crm_shared_write_v1='on'")
    return callback(client)
  })
  let passed = 0
  const check = async (name, callback) => { await callback(); passed += 1; console.log(`PASS ${name}`) }
  await check('legacy raw cache with unknown original mailbox is not silently adopted', async () => {
    const legacyEvidence = evidence('legacy-unknown')
    await query(`INSERT INTO crm_inbound_messages(owner_email,pipeline_id,external_message_id,external_thread_id,
      sender_email,recipient_emails,subject,received_at,snippet,body_text,marker_references,raw_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [OWNER, CACHE_PIPELINE, legacyEvidence.messageId,
      legacyEvidence.threadId, legacyEvidence.senderEmail, legacyEvidence.recipientEmails, legacyEvidence.subject,
      legacyEvidence.receivedAt, legacyEvidence.snippet, legacyEvidence.bodyText, legacyEvidence.markerReferences,
      JSON.stringify({ provider: 'gmail', emailAddressHeaders: legacyEvidence.emailAddressHeaders })])
    const before = await durableState()
    await assert.rejects(persistence.stageReviewedGmailInteractionInPostgres(selection('legacy-unknown')),
      /evidence changed or conflicts/)
    assert.deepEqual(await durableState(), before)
  })
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
    const before = await durableState()
    const preview = await persistence.stageReviewedGmailInteractionInPostgres(selection('d1'))
    assert.equal(preview.targetFingerprint, firstPreview.targetFingerprint)
    const replay = await persistence.stageReviewedGmailInteractionInPostgres({ ...selection('d1'), apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: firstPreview.targetFingerprint })
    assert.equal(replay.applied, false)
    assert.equal(replay.interactionId, original.interactionId)
    assert.deepEqual(await durableState(), before, 'Replay must not repeat cache, link, decision or audit writes')
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
    const nativeProjection = fixtureContext.fixture.loadModule('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
    const unavailable = new Proxy({}, { get: () => () => { throw new Error('Unexpected native transport dependency') } })
    const transport = fixtureContext.fixture.loadModule('app_src/lib/crm/suiteCrmClient.ts', {
      '@/lib/currency': unavailable, '@/lib/crm/productImagePublic': unavailable,
      '@/lib/crm/suiteCrmNativeProductImageClient': unavailable, '@/lib/publicUrl': unavailable,
      '@/lib/crm/suiteCrmNativeEmailProjection': nativeProjection,
      '@/lib/crm/nativeEmailPublicationTransport': unavailable,
    })
    let calls = 0
    await assert.rejects(transport.upsertSuiteCrmRecordWithResult({ entity: 'interactions', pipelineId: PIPELINE,
      localId: row.id, suiteCrmId: row.suitecrm_id, suiteCrmModule: 'Emails', attributes: payload, relationships },
    async () => { calls += 1; throw new Error('No transport without the exact native projection contract') }),
    error => error.code === 'SUITECRM_EMAIL_PROJECTION_HELD')
    assert.equal(calls, 0, 'Old add-only payloads cannot publish without exact relationships and audience proof')
  })
  await check('generic writes cannot forge company scope, review receipt, provider identity or remove reviewed contacts', async () => {
    const current = (await query('SELECT * FROM crm_interactions WHERE id=$1', [original.interactionId])).rows[0]
    const write = fields => persistence.stageCrmRecordInPostgres({ entity: 'interactions', pipelineId: PIPELINE,
      localId: current.id, sourceKey: current.source_key, actorEmail: OWNER, sourcePayload: current.source_payload,
      fields: { subject: current.subject, ...fields } })
    for (const fields of [{ organizationIds: [GLOBUS, AIRSPACE, OTHER] }, { contactIds: [GC] }, { organizationId: AIRSPACE },
      { providerMessageId: 'forged' }, { interactionType: 'note' }, { metadata: { reviewedGmailRecovery: { forged: true } } }]) {
      await assert.rejects(write(fields), JSON.stringify(fields))
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
    await compatibleFixtureWrite(client => client.query('UPDATE crm_interactions SET agent_email=NULL,agent_name=$2 WHERE id=$1', [current.id, 'Historical Author']))
    await write({ subject: 'Edited legacy subject', agentEmail: '', agentName: 'Historical Author' })
    const historic = (await query('SELECT agent_email,agent_name FROM crm_interactions WHERE id=$1', [current.id])).rows[0]
    assert.deepEqual(historic, { agent_email: null, agent_name: 'Historical Author' },
      'The API-normalized empty agent email must preserve a persisted NULL without resolving the historic name')
    await assert.rejects(write({ subject: 'Forbidden reassignment', agentEmail: 'changed@example.test', agentName: 'Historical Author' }),
      /historic (?:agent assignment|author, timestamp and transport status) must be preserved/)
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
    await assert.rejects(compatibleFixtureWrite(client => client.query(`INSERT INTO crm_interaction_organizations (pipeline_id,interaction_id,organization_id)
      VALUES ($1,$2,$3)`, [FOREIGN_PIPELINE, original.interactionId, OTHER])), error => error.code === '23503'
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
  await check('an audit failure rolls back staged identity, cache links and decision as one transaction', async () => {
    await query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1', [WORKSPACE])
    await cacheMessage('d5')
    const request = selection('d5')
    const preview = await persistence.stageReviewedGmailInteractionInPostgres(request)
    const before = await durableState()
    let decisionObserved = false, cacheObserved = false, outboxObserved = false
    const failingPersistence = fixtureContext.fixture.loadCrmPersistence(query, callback => withTransaction(client => callback({
      query: async (sql, values) => {
        if (sql.includes('INSERT INTO crm_email_review_decisions')) decisionObserved = true
        if (sql.includes('UPDATE crm_inbound_messages SET interaction_id=')) cacheObserved = true
        if (sql.includes('INSERT INTO sync_outbox')) outboxObserved = true
        if (sql.includes('INSERT INTO audit_events') && values?.[1] === 'crm.email_association.reviewed') {
          assert.ok(decisionObserved && cacheObserved && outboxObserved, 'Fault occurs after actual outbox, cache and decision writes')
          throw new Error('Synthetic review audit failure')
        }
        return client.query(sql, values)
      },
    })))
    await assert.rejects(failingPersistence.stageReviewedGmailInteractionInPostgres({ ...request, apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: preview.targetFingerprint }), /Synthetic review audit failure/)
    assert.ok(decisionObserved && cacheObserved && outboxObserved)
    assert.deepEqual(await durableState(), before, 'No partial interaction, cache assignment, provenance link, decision or audit remains')
    await query('UPDATE workspace_organizations SET is_demo=true WHERE id=$1', [WORKSPACE])
  })
  await check('reviewed removal appends a correction revision while preserving canonical and native Email identity', async () => {
    const request = selection('d5')
    const preview = await persistence.stageReviewedGmailInteractionInPostgres(request)
    const created = await persistence.stageReviewedGmailInteractionInPostgres({ ...request, apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: preview.targetFingerprint })
    const before = (await query('SELECT * FROM crm_interactions WHERE id=$1', [created.interactionId])).rows[0]
    const correction = { ...request, contactTargets: [contactTargets[0]], decisionKind: 'correction',
      correctionReason: 'Synthetic reviewer removes unrelated company discovery label' }
    const correctionPreview = await persistence.stageReviewedGmailInteractionInPostgres(correction)
    const corrected = await persistence.stageReviewedGmailInteractionInPostgres({ ...correction, apply: true,
      expectedExistingInteractionId: created.interactionId, expectedTargetFingerprint: correctionPreview.targetFingerprint })
    assert.equal(corrected.interactionId, created.interactionId)
    const after = (await query('SELECT * FROM crm_interactions WHERE id=$1', [created.interactionId])).rows[0]
    assert.ok(before.canonical_source_id)
    for (const field of ['id', 'canonical_source_id', 'suitecrm_id', 'suitecrm_module', 'source_key', 'reference_code',
      'provider_message_id', 'provider_thread_id', 'description', 'subject', 'occurred_at']) assert.deepEqual(after[field], before[field], field)
    assert.equal((await query('SELECT count(*) FROM crm_interaction_organizations WHERE interaction_id=$1', [after.id])).rows[0].count, '1')
    assert.equal((await query('SELECT count(*) FROM crm_interaction_contacts WHERE interaction_id=$1', [after.id])).rows[0].count, '1')
    assert.deepEqual((await query('SELECT reference_code FROM crm_inbound_message_links WHERE inbound_message_id=$1 ORDER BY reference_code',
      [corrected.inboundMessageId])).rows.map(row => row.reference_code), ['ga1234567', 'gc1234567'])
    const decisions = (await query('SELECT * FROM crm_email_review_decisions WHERE interaction_id=$1 ORDER BY revision', [after.id])).rows
    assert.equal(decisions.length, 2)
    assert.deepEqual(decisions.map(row => [row.revision, row.kind]), [[1, 'review'], [2, 'correction']])
    assert.equal(decisions[1].previous_decision_id, decisions[0].id)
    assert.equal(decisions[1].provenance.reason, correction.correctionReason)
    const stable = await durableState()
    await persistence.stageReviewedGmailInteractionInPostgres({ ...correction, apply: true,
      expectedExistingInteractionId: created.interactionId, expectedTargetFingerprint: correctionPreview.targetFingerprint })
    assert.deepEqual(await durableState(), stable, 'Correction replay does not append another revision or repeat links')
  })
  await check('concurrent apply and replay serialize to one Email, one decision and one audit', async () => {
    await cacheMessage('d6')
    const request = selection('d6')
    const preview = await persistence.stageReviewedGmailInteractionInPostgres(request)
    const apply = { ...request, apply: true, expectedExistingInteractionId: null,
      expectedTargetFingerprint: preview.targetFingerprint }
    const results = await Promise.all([persistence.stageReviewedGmailInteractionInPostgres(apply),
      persistence.stageReviewedGmailInteractionInPostgres(apply)])
    assert.equal(results.filter(result => result.applied).length, 1)
    assert.equal(results[0].interactionId, results[1].interactionId)
    const interactionId = results[0].interactionId
    assert.equal((await query('SELECT count(*) FROM crm_interactions WHERE provider_message_id=$1', ['d6'])).rows[0].count, '1')
    assert.equal((await query('SELECT count(*) FROM crm_email_review_decisions WHERE interaction_id=$1', [interactionId])).rows[0].count, '1')
    assert.equal((await query("SELECT count(*) FROM audit_events WHERE aggregate_id=$1 AND event_type='crm.email_association.reviewed'", [interactionId])).rows[0].count, '1')
    const stable = await durableState()
    await Promise.all([persistence.stageReviewedGmailInteractionInPostgres(apply), persistence.stageReviewedGmailInteractionInPostgres(apply)])
    assert.deepEqual(await durableState(), stable)
  })
  await check('single-company canonical content edits retain provider evidence and reject identity or association forgery', async () => {
    const current = (await query("SELECT * FROM crm_interactions WHERE provider_message_id='d5'", [])).rows[0]
    assert.ok(current.canonical_source_id)
    const write = fields => persistence.stageCrmRecordInPostgres({ entity: 'interactions', pipelineId: PIPELINE,
      localId: current.id, sourceKey: current.source_key, actorEmail: OWNER, fields })
    await write({ subject: 'Single-company canonical edit', description: 'Ordinary canonical content edit' })
    const edited = (await query('SELECT * FROM crm_interactions WHERE id=$1', [current.id])).rows[0]
    for (const field of ['canonical_source_id', 'provider_message_id', 'provider_thread_id', 'suitecrm_id', 'source_key',
      'organization_id', 'contact_id', 'metadata', 'agent_email', 'agent_name', 'occurred_at', 'source_payload']) {
      assert.deepEqual(edited[field], current[field], field)
    }
    const before = await durableState()
    for (const fields of [{ providerMessageId: 'forged-message' }, { providerThreadId: 'forged-thread' },
      { metadata: { canonicalSourceId: id(97) } }, { metadata: { inboundMessageId: id(98) } },
      { organizationId: AIRSPACE }, { contactIds: [GC, AC] }]) await assert.rejects(write(fields), JSON.stringify(fields))
    assert.deepEqual(await durableState(), before)
    await compatibleFixtureWrite(client => client.query('UPDATE crm_interactions SET agent_email=NULL,agent_name=$2 WHERE id=$1', [current.id, 'Operator']))
    await write({ subject: 'Preserve a historical name that also matches an active user' })
    assert.deepEqual((await query('SELECT agent_email,agent_name FROM crm_interactions WHERE id=$1', [current.id])).rows[0],
      { agent_email: null, agent_name: 'Operator' }, 'A one-company canonical Email must not re-resolve a retained historical author')
  })
  await check('identity phantom waits for the same email but leaves unrelated contact writers unblocked', async () => {
    const writer = await pool.connect()
    let pending
    try {
      await writer.query('BEGIN')
      await writer.query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,full_name,email,reference_code,source_key)
        VALUES($1,$2,$3,'Synthetic duplicate',$4,'gc3456789','fixture-phantom')`, [id(40), PIPELINE, GLOBUS, contactTargets[0].email])
      let settled = false
      pending = persistence.stageReviewedGmailInteractionInPostgres(selection('d2'))
        .then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
      const deadline = Date.now() + 2000
      while (!(await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory') AS waiting", [container])).rows[0].waiting) {
        assert.ok(Date.now() < deadline, 'Review must wait on the actual owner/email advisory fence')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(settled, false)
      await query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,full_name,email,reference_code,source_key)
        VALUES($1,$2,$3,'Unrelated writer','unrelated@example.test','gc4567890','fixture-unrelated')`, [id(41), PIPELINE, GLOBUS])
      assert.equal(settled, false, 'Unrelated identity commits without unblocking or bypassing the shared identity fence')
      const before = await counts()
      await writer.query('COMMIT')
      const result = await pending
      assert.match(result.error?.message || '', /evidence changed or conflicts/)
      assert.deepEqual(await counts(), before, 'Preview must see and refuse the committed duplicate before staging')
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      if (pending) await pending
      await query('DELETE FROM crm_contacts WHERE id=ANY($1::uuid[])', [[id(40), id(41)]])
    }
  })
  let queuedReview, queuedRequest, queuedPreview, queuedItem
  await check('non-demo review atomically queues one exact native payload with both companies, contacts and pipeline audience', async () => {
    await query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1', [WORKSPACE])
    await cacheMessage('d7')
    queuedRequest = selection('d7')
    queuedPreview = await persistence.stageReviewedGmailInteractionInPostgres(queuedRequest)
    queuedReview = await persistence.stageReviewedGmailInteractionInPostgres({ ...queuedRequest, apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: queuedPreview.targetFingerprint })
    const outbox = (await query('SELECT * FROM sync_outbox WHERE aggregate_id=$1', [queuedReview.interactionId])).rows
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0].status, 'queued')
    const payload = outbox[0].payload
    assert.equal(payload.suiteCrmModule, 'Emails')
    assert.equal(payload.localId, queuedReview.interactionId)
    assert.equal(payload.attributes.parent_id, 'native-globus')
    assert.deepEqual(payload.emailProjection.accounts, ['native-airspace', 'native-globus'])
    assert.deepEqual(payload.emailProjection.contacts, ['native-joseph', 'native-riley'])
    assert.deepEqual(payload.emailProjection.contactAccounts, [
      { contactId: 'native-joseph', accountId: 'native-globus' }, { contactId: 'native-riley', accountId: 'native-airspace' },
    ])
    assert.deepEqual(payload.emailProjection.previousManaged, { accounts: [], contacts: [] })
    const { fingerprint, ...audience } = payload.emailProjection.audience
    assert.deepEqual(audience, { policy: 'pipeline-internal', ownerSuiteCrmId: 'native-fixture-owner',
      allowedSuiteCrmUserIds: ['native-fixture-owner'], workspaceId: WORKSPACE, pipelineId: PIPELINE })
    assert.match(fingerprint, /^[a-f0-9]{64}$/u)
    assert.equal((await query('SELECT count(*) FROM crm_email_review_decisions WHERE interaction_id=$1', [queuedReview.interactionId])).rows[0].count, '1')
    assert.equal((await query("SELECT count(*) FROM audit_events WHERE aggregate_id=$1 AND event_type='crm.email_association.reviewed'", [queuedReview.interactionId])).rows[0].count, '1')
    assert.equal((await query('SELECT count(*) FROM crm_inbound_message_links WHERE inbound_message_id=$1', [queuedReview.inboundMessageId])).rows[0].count, '4')
    const cache = (await query('SELECT * FROM crm_inbound_messages WHERE id=$1', [queuedReview.inboundMessageId])).rows[0]
    assert.equal(cache.interaction_id, queuedReview.interactionId)
    assert.equal(cache.mailbox_id, mailboxIdentity.mailboxId)
    assert.ok(cache.canonical_source_id)
    const claimed = await persistence.claimSuiteCrmOutboxInPostgres({ limit: 1 })
    assert.equal(claimed.length, 1)
    queuedItem = claimed[0]
    assert.equal(queuedItem.id, outbox[0].id)
    assert.equal(queuedItem.attempts, 1)
    assert.deepEqual(queuedItem.payload, payload)
    assert.equal((await query('SELECT sync_status FROM crm_interactions WHERE id=$1', [queuedReview.interactionId])).rows[0].sync_status, 'syncing')
  })
  await check('publication rejects changed lease, payload, revision or revoked membership before the provider callback', async () => {
    let callbacks = 0
    const publish = async () => { callbacks += 1; return 'synthetic-provider-callback' }
    await assert.rejects(persistence.withVerifiedSuiteCrmEmailPublication({ ...queuedItem, lockToken: 'wrong-lease' }, publish), /lease or revision changed/)
    await assert.rejects(persistence.withVerifiedSuiteCrmEmailPublication({ ...queuedItem,
      payload: { ...queuedItem.payload, attributes: { ...queuedItem.payload.attributes, name: 'Forged queued content' } } }, publish), /lease or revision changed/)
    const currentHash = (await query('SELECT source_hash FROM crm_interactions WHERE id=$1', [queuedReview.interactionId])).rows[0].source_hash
    await compatibleFixtureWrite(client => client.query('UPDATE crm_interactions SET source_hash=$2 WHERE id=$1', [queuedReview.interactionId, 'synthetic-stale-revision']))
    await assert.rejects(persistence.withVerifiedSuiteCrmEmailPublication(queuedItem, publish), /lease or revision changed/)
    await compatibleFixtureWrite(client => client.query('UPDATE crm_interactions SET source_hash=$2 WHERE id=$1', [queuedReview.interactionId, currentHash]))
    await query("UPDATE app_user_organization_memberships SET status='disabled' WHERE organization_id=$1 AND user_email=$2", [WORKSPACE, OWNER])
    await assert.rejects(persistence.withVerifiedSuiteCrmEmailPublication(queuedItem, publish), /audience|native identities/i)
    assert.equal(callbacks, 0)
    assert.equal(await persistence.failSuiteCrmOutboxInPostgres({ item: queuedItem, error: 'Synthetic membership change held publication' }), 'failed')
    const held = (await query('SELECT status,lock_token FROM sync_outbox WHERE id=$1', [queuedItem.id])).rows[0]
    assert.deepEqual(held, { status: 'failed', lock_token: null })
    assert.equal((await query('SELECT sync_status FROM crm_interactions WHERE id=$1', [queuedReview.interactionId])).rows[0].sync_status, 'pending')
    await query("UPDATE app_user_organization_memberships SET status='active' WHERE organization_id=$1 AND user_email=$2", [WORKSPACE, OWNER])
    await query('UPDATE sync_outbox SET available_at=now() WHERE id=$1', [queuedItem.id])
    const [reclaimed] = await persistence.claimSuiteCrmOutboxInPostgres({ limit: 1 })
    assert.equal(reclaimed.id, queuedItem.id)
    assert.notEqual(reclaimed.lockToken, queuedItem.lockToken)
    queuedItem = reclaimed
  })
  await check('completion requires exact readback and active lease; valid proof stores a receipt and makes replay write-free', async () => {
    // Synthetic readback at the trusted native-client boundary. Native exact
    // readback/audience transport is tested separately, not claimed by this DB fixture.
    const proof = { version: 1, suiteCrmId: queuedItem.payload.suiteCrmId, capturedAt: new Date().toISOString(),
      attributes: queuedItem.payload.attributes, accounts: queuedItem.payload.emailProjection.accounts,
      contacts: queuedItem.payload.emailProjection.contacts, contactAccounts: queuedItem.payload.emailProjection.contactAccounts,
      audience: { fingerprint: queuedItem.payload.emailProjection.audience.fingerprint,
        readerSuiteCrmUserIds: queuedItem.payload.emailProjection.audience.allowedSuiteCrmUserIds,
        administratorSuiteCrmUserIds: ['native-fixture-owner'] } }
    const before = await durableState()
    await assert.rejects(persistence.completeSuiteCrmOutboxInPostgres(queuedItem), /readback proof is missing or changed/)
    await assert.rejects(persistence.completeSuiteCrmOutboxInPostgres(queuedItem, { emailProjection: { ...proof, accounts: ['native-globus'] } }), /readback proof is missing or changed/)
    await assert.rejects(persistence.completeSuiteCrmOutboxInPostgres({ ...queuedItem, lockToken: 'lost-lease' }, { emailProjection: proof }), /lease or projection identity was lost/)
    assert.deepEqual(await durableState(), before, 'Rejected completion cannot mark success or persist a forged receipt')
    let callbacks = 0
    assert.equal(await persistence.withVerifiedSuiteCrmEmailPublication(queuedItem, async () => {
      callbacks += 1; return 'synthetic-provider-success'
    }), 'synthetic-provider-success')
    assert.equal(callbacks, 1)
    await persistence.completeSuiteCrmOutboxInPostgres(queuedItem, { emailProjection: proof })
    const row = (await query('SELECT * FROM crm_interactions WHERE id=$1', [queuedReview.interactionId])).rows[0]
    assert.equal(row.sync_status, 'synced')
    assert.ok(row.suitecrm_synced_at)
    assert.deepEqual(row.metadata.suiteCrmEmailProjection, proof)
    assert.equal((await query('SELECT status FROM sync_outbox WHERE id=$1', [queuedItem.id])).rows[0].status, 'succeeded')
    const stable = await durableState()
    await assert.rejects(persistence.stageCrmRecordInPostgres({ entity: 'interactions', pipelineId: PIPELINE,
      localId: row.id, sourceKey: row.source_key, actorEmail: OWNER, fields: { subject: row.subject,
        metadata: { suiteCrmEmailProjection: { ...proof, accounts: ['forged-account'] } } } }), /projection receipts cannot be supplied/)
    const replay = await persistence.stageReviewedGmailInteractionInPostgres({ ...queuedRequest, apply: true,
      expectedExistingInteractionId: null, expectedTargetFingerprint: queuedPreview.targetFingerprint })
    assert.equal(replay.applied, false)
    assert.deepEqual(await durableState(), stable, 'Worker-owned receipt does not invalidate unchanged reviewed replay')
  })
  await check('actor-owned sent source needs current editor authority and publication fences reader-grant revocation', async () => {
    const EDITOR = 'shared-editor@example.test', EDITOR_MAILBOX = 'editor-mailbox@example.test'
    const editorConnection = 'synthetic-editor-mailbox', editorIntakePipeline = id(80)
    await query("INSERT INTO app_users (email,status,display_name,suitecrm_user_id,crm_user_enabled,reference_code) VALUES($1,'active','Synthetic Editor','native-fixture-editor',true,'gu2345678')", [EDITOR])
    await query("INSERT INTO app_user_organization_memberships (organization_id,user_email,status) VALUES($1,$2,'active')", [WORKSPACE, EDITOR])
    await query('INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id,is_default) VALUES($1,$2,$3,true)',
      [editorIntakePipeline, EDITOR, WORKSPACE])
    await query("INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,'editor')", [PIPELINE, EDITOR])
    await query("INSERT INTO user_maton_connections VALUES($1,$2,$3,'google-mail','ACTIVE','maton',true)", [EDITOR, editorConnection, EDITOR_MAILBOX])
    await persistence.bindVerifiedGmailMailboxInPostgres({ ownerEmail: EDITOR, connectionId: editorConnection,
      identity: { subject: 'synthetic-editor-google-subject', email: EDITOR_MAILBOX }, observedAccountEmail: EDITOR_MAILBOX })
    const identity = await persistence.readVerifiedGmailMailboxIdentityInPostgres({ ownerEmail: EDITOR,
      connectionId: editorConnection, accountEmail: EDITOR_MAILBOX })
    assert.ok(identity)
    const capture = async messageId => {
      const messageEvidence = emailIdentity.normalizeGmailMessageEvidence({ externalMessageId: messageId,
        externalThreadId: `thread-${messageId}`, senderEmail: EDITOR_MAILBOX, recipientEmails: [contactTargets[0].email, OWNER],
        subject: 'Synthetic shared-pipeline sent message', receivedAt: '2026-10-27T12:00:00.123Z',
        snippet: 'Synthetic editor source', bodyText: 'Synthetic exact shared editor body', markerReferences: [],
        emailAddressHeaders: { version: 1, from: [{ address: EDITOR_MAILBOX, displayName: 'Synthetic Editor' }],
          to: [{ address: contactTargets[0].email, displayName: 'Joseph' }], cc: [{ address: OWNER }], bcc: [] } })
      const intake = await persistence.recordGmailMessageIntakeInPostgres({ ownerEmail: EDITOR,
        connectionId: editorConnection, intakePipelineId: editorIntakePipeline, mailboxIdentity: identity,
        observedAccountEmail: EDITOR_MAILBOX, observedAt: new Date().toISOString(), messageEvidence, rawMetadata: { labelIds: ['SENT'] } })
      return { messageEvidence, intake }
    }
    const stageInput = ({ messageEvidence, intake }) => ({ entity: 'interactions', pipelineId: PIPELINE,
      sourceKey: `synthetic-shared-editor:${messageEvidence.messageId}`, actorEmail: EDITOR, sourcePayload: { source: 'app-send' },
      fields: { interactionType: 'email', organizationId: GLOBUS, contactIds: [GC], agentEmail: EDITOR,
        subject: messageEvidence.subject, description: messageEvidence.bodyText, occurredAt: messageEvidence.receivedAt,
        direction: 'outbound', deliveryStatus: 'sent', providerMessageId: messageEvidence.messageId,
        providerThreadId: messageEvidence.threadId, metadata: { source: 'app-send', canonicalSourceId: intake.sourceId, inboundMessageId: intake.id } } })
    const captured = await capture('e701'), pending = await capture('e702')
    const staged = await persistence.stageCrmRecordInPostgres(stageInput(captured))
    const row = (await query('SELECT * FROM crm_interactions WHERE id=$1', [staged.id])).rows[0]
    assert.equal(row.canonical_source_id, captured.intake.sourceId)
    const outbox = (await query('SELECT * FROM sync_outbox WHERE aggregate_id=$1', [staged.id])).rows
    assert.equal(outbox.length, 1)
    const payload = outbox[0].payload
    assert.equal(payload.attributes.from_addr_name, `Synthetic Editor <${EDITOR_MAILBOX}>`)
    assert.equal(payload.attributes.to_addrs_names, `Joseph <${contactTargets[0].email}>`)
    assert.equal(payload.attributes.cc_addrs_names, OWNER)
    assert.equal(payload.emailProjection.audience.ownerSuiteCrmId, 'native-fixture-owner')
    assert.deepEqual(payload.emailProjection.audience.allowedSuiteCrmUserIds, ['native-fixture-editor', 'native-fixture-owner'])
    for (const [change, restore] of [
      [() => query("UPDATE pipeline_space_members SET access_role='viewer' WHERE pipeline_id=$1 AND user_email=$2", [PIPELINE, EDITOR]),
        () => query("UPDATE pipeline_space_members SET access_role='editor' WHERE pipeline_id=$1 AND user_email=$2", [PIPELINE, EDITOR])],
      [() => query("UPDATE app_user_organization_memberships SET status='disabled' WHERE organization_id=$1 AND user_email=$2", [WORKSPACE, EDITOR]),
        () => query("UPDATE app_user_organization_memberships SET status='active' WHERE organization_id=$1 AND user_email=$2", [WORKSPACE, EDITOR])],
      [() => query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2', [PIPELINE, EDITOR]),
        () => query("INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,'editor')", [PIPELINE, EDITOR])],
    ]) {
      await change()
      try {
        const before = await durableState()
        await assert.rejects(persistence.stageCrmRecordInPostgres(stageInput(pending)),
          /source is unavailable|access was revoked|agent must be an active ClawPilot user with pipeline access/)
        assert.deepEqual(await durableState(), before, 'Denied attachment leaves no partial Email, outbox, audit or provenance mutation')
      } finally { await restore() }
    }
    const [item] = await persistence.claimSuiteCrmOutboxInPostgres({ limit: 1 })
    assert.equal(item.id, outbox[0].id)
    let entered, release, callbacks = 0
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const releasePromise = new Promise(resolve => { release = resolve })
    const publishing = persistence.withVerifiedSuiteCrmEmailPublication(item, async () => {
      callbacks += 1; entered(); await releasePromise; return 'synthetic-editor-publication'
    })
    const revoker = await pool.connect()
    let revoked
    try {
      await enteredPromise
      await revoker.query('BEGIN')
      const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let settled = false
      revoked = revoker.query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2', [PIPELINE, EDITOR])
        .then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
      const deadline = Date.now() + 2500
      while (!(await query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked) {
        assert.ok(Date.now() < deadline, 'Reader-grant revocation must wait on the actual publication row lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(settled, false)
      release()
      assert.equal(await publishing, 'synthetic-editor-publication')
      assert.equal((await revoked).error, undefined)
      await revoker.query('COMMIT')
      await assert.rejects(persistence.withVerifiedSuiteCrmEmailPublication(item, async () => { callbacks += 1 }), /audience, lease or revision changed/)
      assert.equal(callbacks, 1, 'Already-revoked reader grant blocks before a second provider callback')
      assert.equal(await persistence.failSuiteCrmOutboxInPostgres({ item, error: 'Synthetic reader grant revoked' }), 'failed')
    } finally {
      release()
      await publishing.catch(() => undefined)
      if (revoked) await revoked
      await revoker.query('ROLLBACK')
      revoker.release()
    }
  })
  // A SECOND, separately named admission is exercised with synthetic contents
  // and the exact reviewed two-message identity pins. It does not expand the
  // original three-message helper or establish real Google/native delivery.
  const CASEY = { owner: 'jarrett@suburbiasandwichco.com', connection: 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027',
    pipeline: '587c8746-ecf6-40ae-8c50-e456f99ad555', intake: '0ce9d945-0b71-495b-88ef-420ddd51fd9c',
    thread: '1a179e9e2743f926', workspace: id(700), globus: id(701), airspace: id(702), globusContact: id(703), airspaceContact: id(704),
    messages: [
      { message: '1a18e03ea586cd7e', cache: '756e4e17-2458-470b-b00c-129c85ee821a' },
      { message: '1a18f01749eb87a6', cache: '78a5b2cc-ba50-4a71-a17c-adaf0c1041c2' },
    ] }
  const caseyMailboxEmail = 'synthetic-casey-mailbox@example.invalid'
  const caseyReconcile = fixtureContext.fixture.loadModule('app_src/lib/crm/emailReconciliation.ts', {
    '@/lib/crm/emailIdentity': emailIdentity,
  })
  await query(`INSERT INTO app_users(email,status,display_name,suitecrm_user_id,crm_user_enabled,reference_code,role)
    VALUES($1,'active','Synthetic Casey fixture owner','native-fixture-casey-owner',true,'gu7654321','owner')`, [CASEY.owner])
  await query('INSERT INTO workspace_organizations VALUES($1,false)', [CASEY.workspace])
  for (const [pipeline, isDefault] of [[CASEY.pipeline, false], [CASEY.intake, true]]) await query(`INSERT INTO pipeline_spaces
    (id,owner_email,workspace_organization_id,is_default) VALUES($1,$2,$3,$4)`, [pipeline, CASEY.owner, CASEY.workspace, isDefault])
  for (const [email, role] of [[CASEY.owner, 'owner'], [OWNER, 'member']]) await query(`INSERT INTO app_user_organization_memberships
    (organization_id,user_email,status,role) VALUES($1,$2,'active',$3)`, [CASEY.workspace, email, role])
  await query(`INSERT INTO user_maton_connections VALUES($1,$2,$3,'google-mail','ACTIVE','maton',true)`,
    [CASEY.owner, CASEY.connection, caseyMailboxEmail])
  await persistence.bindVerifiedGmailMailboxInPostgres({ ownerEmail: CASEY.owner, connectionId: CASEY.connection,
    identity: { subject: 'synthetic-casey-google-subject', email: caseyMailboxEmail }, observedAccountEmail: caseyMailboxEmail })
  const caseyIdentity = await persistence.readVerifiedGmailMailboxIdentityInPostgres({ ownerEmail: CASEY.owner,
    connectionId: CASEY.connection, accountEmail: caseyMailboxEmail })
  assert.ok(caseyIdentity)
  const caseyCompanies = [{ id: CASEY.globus, referenceCode: 'gagmco24va588e' }, { id: CASEY.airspace, referenceCode: 'gajl1dq5i03jga' }]
  for (const [company, name, native] of [[caseyCompanies[0], 'Synthetic Globus', 'native-casey-globus'], [caseyCompanies[1], 'Synthetic Airspace', 'native-casey-airspace']]) {
    await query(`INSERT INTO crm_organizations(id,pipeline_id,name,reference_code,source_key,suitecrm_id)
      VALUES($1,$2,$3,$4,$4,$5)`, [company.id, CASEY.pipeline, name, company.referenceCode, native])
  }
  const caseyTargets = [
    { id: CASEY.globusContact, referenceCode: 'gc7654321', organizationId: CASEY.globus, email: 'adrian@globus.example.invalid' },
    { id: CASEY.airspaceContact, referenceCode: 'gc8765432', organizationId: CASEY.airspace, email: 'casey@airspace.example.invalid' },
  ]
  for (const target of caseyTargets) await query(`INSERT INTO crm_contacts
    (id,pipeline_id,organization_id,full_name,email,reference_code,source_key,suitecrm_id) VALUES($1,$2,$3,$4,$5,$4,$4,$6)`,
  [target.id, CASEY.pipeline, target.organizationId, target.referenceCode, target.email, `native-casey-contact-${target.id.slice(-1)}`])
  const caseyEvidence = message => emailIdentity.normalizeGmailMessageEvidence({ externalMessageId: message,
    externalThreadId: CASEY.thread, senderEmail: caseyTargets[1].email, recipientEmails: [CASEY.owner, caseyTargets[0].email],
    subject: `Synthetic exact-two ${message}`, receivedAt: '2026-10-27T12:00:00.123Z', snippet: 'Synthetic Casey snippet',
    bodyText: 'Synthetic exact-two retained body', markerReferences: [], emailAddressHeaders: { version: 1,
      from: [{ address: caseyTargets[1].email }], to: [{ address: CASEY.owner }, { address: caseyTargets[0].email }], cc: [], bcc: [] } })
  for (const row of CASEY.messages) {
    const current = caseyEvidence(row.message)
    await query(`INSERT INTO crm_inbound_messages(id,owner_email,pipeline_id,external_message_id,external_thread_id,
      sender_email,recipient_emails,subject,received_at,snippet,body_text,marker_references,raw_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, [row.cache, CASEY.owner, CASEY.intake, current.messageId,
      current.threadId, current.senderEmail, current.recipientEmails, current.subject, current.receivedAt, current.snippet,
      current.bodyText, current.markerReferences, JSON.stringify({ provider: 'gmail', originalMailboxProvenance: 'unknown',
        labelIds: ['INBOX'], emailAddressHeaders: current.emailAddressHeaders })])
  }
  const caseyOriginalCache = (await query('SELECT * FROM crm_inbound_messages WHERE id=ANY($1::uuid[]) ORDER BY id', [CASEY.messages.map(row => row.cache)])).rows
  const caseyMessages = CASEY.messages.map(row => {
    const current = caseyEvidence(row.message)
    const legacyAdoption = caseyReconcile.prepareCaseyGmailAdoption({ scope: {
      ownerEmail: CASEY.owner, connectionId: CASEY.connection, inboundMessageId: row.cache, intakePipelineId: CASEY.intake,
      pipelineId: CASEY.pipeline, messageIds: CASEY.messages.map(item => item.message), threadId: CASEY.thread,
      primaryOrganization: caseyCompanies[0], organizations: caseyCompanies,
    }, identity: caseyIdentity, adoptedAt: new Date().toISOString(), cached: current, current })
    return { admissionScope: 'casey-reviewed-two-v1', ownerEmail: CASEY.owner, connectionId: CASEY.connection,
      pipelineId: CASEY.pipeline, mailboxIdentity: caseyIdentity, messageEvidence: current, legacyAdoption,
      providerMessageId: current.messageId, providerThreadId: current.threadId, primaryOrganization: caseyCompanies[0],
      contactTargets: caseyTargets, participantEmails: caseyTargets.map(target => target.email), interaction: {
        entity: 'interactions', pipelineId: CASEY.pipeline, actorEmail: CASEY.owner, sourceKey: `synthetic-casey:${current.messageId}`,
        sourcePayload: { source: 'gmail-inbound', syntheticCasey: true }, fields: { interactionType: 'email',
          subject: current.subject, description: current.bodyText, occurredAt: current.receivedAt, agentEmail: CASEY.owner,
          direction: 'inbound', deliveryStatus: 'received', providerMessageId: current.messageId,
          providerThreadId: current.threadId, metadata: { source: 'gmail-inbound' } },
      } }
  })
  const caseyCopy = value => JSON.parse(JSON.stringify(value))
  const caseyRejectUnchanged = async messages => {
    const before = await durableState()
    await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages }))
    assert.deepEqual(await durableState(), before)
  }
  await check('actual Casey candidate GET executes real binding/candidate SQL and returns only the two scoped metadata rows', async () => {
    const origin = 'https://fixture.example.invalid'
    const browserSameOrigin = fixtureContext.fixture.loadModule('app_src/lib/browserSameOrigin.ts', {
      './publicOriginRouting.mjs': require('../app_src/lib/publicOriginRouting.mjs'),
    })
    const candidateRoute = fixtureContext.fixture.loadModule('app_src/app/api/crm/email-review-candidates/route.ts', {
      'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
      '@/lib/browserSameOrigin': browserSameOrigin,
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
      '@/lib/persistence/postgres': { query },
      '@/lib/persistence/crmEmailIdentity': { readVerifiedGmailMailboxIdentityInPostgres: persistence.readVerifiedGmailMailboxIdentityInPostgres },
      '@/lib/publicUrl': { appPublicUrl: () => origin },
      '@/lib/requestUser': { requestSession: async () => ({ authenticatedUser: CASEY.owner, effectiveUser: CASEY.owner,
        impersonating: false, activeWorkspaceOrganizationId: CASEY.workspace }),
      requireRequestUser: async () => ({ email: CASEY.owner, organizationId: CASEY.workspace }) },
      '@/lib/tenancy': { resolvePipelineSpaceAccess: async input => {
        assert.equal(input.pipelineId, CASEY.pipeline); assert.equal(input.actorEmail.email, CASEY.owner)
        return { id: CASEY.pipeline, ownerEmail: CASEY.owner, workspaceOrganizationId: CASEY.workspace }
      } },
    })
    const get = async admissionScope => {
      const url = new URL('/api/crm/email-review-candidates', origin)
      url.searchParams.set('pipelineId', CASEY.pipeline); url.searchParams.set('connectionId', CASEY.connection)
      if (admissionScope !== undefined) url.searchParams.set('admissionScope', admissionScope)
      const request = new Request(url, { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })
      request.nextUrl = url
      const result = await candidateRoute.GET(request)
      return { status: result.status, body: await result.json() }
    }
    const before = await durableState(), scoped = await get('casey-reviewed-two-v1')
    assert.equal(scoped.status, 200); assert.equal(scoped.body.ok, true)
    assert.equal(scoped.body.maximum, 2); assert.equal(scoped.body.admissionScope, 'casey-reviewed-two-v1')
    assert.equal(scoped.body.pipelineId, CASEY.pipeline); assert.equal(scoped.body.connectionId, CASEY.connection)
    assert.equal(scoped.body.messages.length, 2)
    assert.deepEqual(scoped.body.messages.map(row => row.messageId).sort(), CASEY.messages.map(row => row.message).sort())
    for (const row of scoped.body.messages) {
      assert.deepEqual(Object.keys(row).sort(), ['admissionScope', 'legacy', 'messageId', 'participantContactIds', 'participantEmails', 'receivedAt', 'subject', 'threadId'])
      assert.equal(row.admissionScope, 'casey-reviewed-two-v1'); assert.equal(row.legacy, true); assert.equal(row.threadId, CASEY.thread)
      assert.deepEqual(row.participantContactIds.sort(), [CASEY.globusContact, CASEY.airspaceContact].sort())
    }
    assert.ok(!JSON.stringify(scoped.body).includes('Synthetic exact-two retained body'))
    const ordinary = await get()
    assert.equal(ordinary.status, 200); assert.deepEqual(ordinary.body.messages, [])
    assert.equal(Object.hasOwn(ordinary.body, 'admissionScope'), false)
    assert.deepEqual(await durableState(), before, 'Candidate GET never acquires, adopts or rewrites retained mail')
  })
  let caseyPreviews, caseyApply
  await check('Casey exact-two is a separately named read-only admission, never a generic or three-message alias', async () => {
    const before = await durableState()
    caseyPreviews = await persistence.stageReviewedGmailInteractionsInPostgres({ messages: caseyMessages })
    assert.equal(caseyPreviews.length, 2)
    assert.ok(caseyPreviews.every(row => !row.applied && row.interactionId === null))
    assert.deepEqual(await durableState(), before)
    for (const message of caseyMessages) assert.equal(message.legacyAdoption.kind, 'reviewed-casey-two-adoption-v1')
    for (const messages of [[caseyMessages[0]], [caseyMessages[0], caseyMessages[0]], [caseyMessages[0], selection('d1')],
      caseyMessages.map(message => { const copy = caseyCopy(message); delete copy.admissionScope; return copy }),
      caseyMessages.map(message => ({ ...message, admissionScope: 'casey-reviewed-two-v1 ' })),
      caseyMessages.map(message => ({ ...message, decisionKind: 'correction', correctionReason: 'Synthetic forbidden scope expansion' })),
      caseyMessages.map(message => ({ ...message, decisionKind: 'late-contact' })),
      caseyMessages.map(message => ({ ...message, legacyAdoption: { ...message.legacyAdoption, kind: 'bounded-legacy-adoption' } }))]) {
      await caseyRejectUnchanged(messages)
    }
    caseyApply = caseyMessages.map((message, index) => ({ ...message, expectedExistingInteractionId: null,
      expectedTargetFingerprint: caseyPreviews[index].targetFingerprint }))
  })
  await check('Casey exact-two rechecks owner/cache/intake/connection pins and both CAS values before any write', async () => {
    const before = await durableState()
    await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages: [caseyApply[0],
      { ...caseyApply[1], expectedTargetFingerprint: '0'.repeat(64) }], apply: true }))
    assert.deepEqual(await durableState(), before, 'A stale second message never commits the first')
    for (const [column, value] of [['ownerEmail', OWNER], ['connectionId', CONNECTION], ['inboundMessageId', CASEY.messages[0].cache],
      ['intakePipelineId', CASEY.pipeline]]) {
      const messages = caseyCopy(caseyMessages); messages[1].legacyAdoption[column] = value
      await caseyRejectUnchanged(messages)
    }
    for (const [change, restore] of [
      [() => query('UPDATE crm_inbound_messages SET owner_email=$2 WHERE id=$1', [CASEY.messages[1].cache, OWNER]),
        () => query('UPDATE crm_inbound_messages SET owner_email=$2 WHERE id=$1', [CASEY.messages[1].cache, CASEY.owner])],
      [() => query('UPDATE crm_inbound_messages SET pipeline_id=$2 WHERE id=$1', [CASEY.messages[1].cache, CASEY.pipeline]),
        () => query('UPDATE crm_inbound_messages SET pipeline_id=$2 WHERE id=$1', [CASEY.messages[1].cache, CASEY.intake])],
      [() => query("UPDATE app_users SET status='disabled' WHERE email=$1", [CASEY.owner]),
        () => query("UPDATE app_users SET status='active' WHERE email=$1", [CASEY.owner])],
      [() => query('UPDATE user_maton_connections SET is_selected=false WHERE owner_email=$1 AND connection_id=$2', [CASEY.owner, CASEY.connection]),
        () => query('UPDATE user_maton_connections SET is_selected=true WHERE owner_email=$1 AND connection_id=$2', [CASEY.owner, CASEY.connection])],
      [() => query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CASEY.airspaceContact, 'changed@airspace.example.invalid']),
        () => query('UPDATE crm_contacts SET email=$2 WHERE id=$1', [CASEY.airspaceContact, caseyTargets[1].email])],
      [() => query("INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role) VALUES($1,$2,'viewer')", [CASEY.pipeline, OWNER]),
        () => query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2', [CASEY.pipeline, OWNER])],
    ]) {
      await change()
      try {
        const changed = await durableState()
        await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages: caseyApply, apply: true }))
        assert.deepEqual(await durableState(), changed)
      } finally { await restore() }
    }
  })
  await check('Casey second-decision SQL failure rolls both messages, sources, links, outbox and audits back', async () => {
    const before = await durableState()
    await query(`CREATE FUNCTION test_deny_casey_second_review() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.pipeline_id='587c8746-ecf6-40ae-8c50-e456f99ad555'::uuid AND
        (SELECT provider_message_id FROM crm_email_sources WHERE id=NEW.source_id)='1a18f01749eb87a6' THEN
        IF NOT EXISTS(SELECT 1 FROM crm_interactions WHERE pipeline_id=NEW.pipeline_id AND provider_message_id='1a18e03ea586cd7e')
          THEN RAISE EXCEPTION 'Casey first message was not staged before the second decision'; END IF;
        RAISE EXCEPTION 'Synthetic Casey second-decision failure after first stage';
      END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_deny_casey_second_review BEFORE INSERT ON crm_email_review_decisions
      FOR EACH ROW EXECUTE FUNCTION test_deny_casey_second_review()`)
    try {
      await assert.rejects(persistence.stageReviewedGmailInteractionsInPostgres({ messages: caseyApply, apply: true }), /Synthetic Casey second-decision failure after first stage/)
      assert.deepEqual(await durableState(), before)
    } finally { await query('DROP TRIGGER test_deny_casey_second_review ON crm_email_review_decisions;DROP FUNCTION test_deny_casey_second_review()') }
  })
  await check('Casey exact-two stages one Email per message, both companies, original-unknown proof and current audience', async () => {
    const results = await persistence.stageReviewedGmailInteractionsInPostgres({ messages: caseyApply, apply: true })
    assert.equal(results.length, 2); assert.ok(results.every(row => row.applied))
    assert.equal(new Set(results.map(row => row.interactionId)).size, 2)
    const rows = (await query('SELECT * FROM crm_interactions WHERE pipeline_id=$1 ORDER BY provider_message_id', [CASEY.pipeline])).rows
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.organization_id, CASEY.globus); assert.equal(row.provider_thread_id, CASEY.thread)
      assert.equal(row.suitecrm_module, 'Emails'); assert.ok(row.canonical_source_id)
      assert.equal((await query('SELECT count(*) FROM crm_interaction_organizations WHERE interaction_id=$1', [row.id])).rows[0].count, '2')
      assert.equal((await query('SELECT count(*) FROM crm_interaction_contacts WHERE interaction_id=$1', [row.id])).rows[0].count, '2')
      const decision = (await query('SELECT * FROM crm_email_review_decisions WHERE interaction_id=$1', [row.id])).rows[0]
      assert.equal(decision.kind, 'legacy-adoption'); assert.equal(decision.provenance.legacyAdoption.kind, 'reviewed-casey-two-adoption-v1')
      assert.equal(decision.provenance.legacyAdoption.originalMailboxProvenance, 'unknown')
      assert.deepEqual(decision.audience.allowedSuiteCrmUserIds, ['native-fixture-casey-owner'])
      assert.equal(decision.audience.ownerSuiteCrmId, 'native-fixture-casey-owner')
      const outbox = (await query("SELECT payload FROM sync_outbox WHERE aggregate_id=$1 AND target_system='suitecrm'", [row.id])).rows
      assert.equal(outbox.length, 1); assert.equal(outbox[0].payload.suiteCrmModule, 'Emails')
      assert.deepEqual(outbox[0].payload.emailProjection.accounts, ['native-casey-airspace', 'native-casey-globus'])
      assert.deepEqual(outbox[0].payload.emailProjection.audience.allowedSuiteCrmUserIds, ['native-fixture-casey-owner'])
    }
    const cache = (await query('SELECT * FROM crm_inbound_messages WHERE id=ANY($1::uuid[]) ORDER BY id', [CASEY.messages.map(row => row.cache)])).rows
    for (const row of cache) {
      const original = caseyOriginalCache.find(item => item.id === row.id)
      for (const field of ['id', 'owner_email', 'pipeline_id', 'external_message_id', 'external_thread_id', 'sender_email',
        'recipient_emails', 'subject', 'received_at', 'snippet', 'body_text', 'marker_references']) assert.deepEqual(row[field], original[field])
      assert.equal(row.raw_metadata.originalMailboxProvenance, 'unknown')
      const { legacyAdoption, ...unchangedMetadata } = row.raw_metadata
      assert.deepEqual(unchangedMetadata, original.raw_metadata); assert.equal(legacyAdoption.inboundMessageId, row.id)
      assert.equal(legacyAdoption.intakePipelineId, CASEY.intake); assert.equal(legacyAdoption.ownerEmail, CASEY.owner)
    }
    const beforeReplay = await durableState()
    const replay = await persistence.stageReviewedGmailInteractionsInPostgres({ messages: caseyApply, apply: true })
    assert.ok(replay.every(row => !row.applied))
    assert.deepEqual(replay.map(row => row.interactionId), results.map(row => row.interactionId))
    assert.deepEqual(await durableState(), beforeReplay, 'Exact-two replay is write-free, including immutable historical proof')
  })
  console.log(`PASS ${passed} reviewed Gmail persistence checks; actual SQL/readers/native payload producer; no provider writes`)
} finally {
  try { if (pool) await pool.end() }
  finally { if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' }) }
}
