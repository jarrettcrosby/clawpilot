#!/usr/bin/env node
// One guarded synthetic database. No application DATABASE_URL/env files, native
// CRM calls, mailbox calls, migration of real data, or production authority.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
import { assertExternalRollbackOutput, canonicalJson, committedRollbackIdentity, LEGACY_WRITER_COMMIT,
  REQUIRED_ROLLING_CHECKS, ROLLBACK_ACCEPTANCE_FORMAT, rollbackReceiptSource, sha256 } from './lib/crm-compatible-rollback-artifact.mjs'

const repository = process.cwd()
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const requireNode = createRequire(import.meta.url)
const ts = requireApp('typescript')
const { Pool } = requireApp('pg')
const args = process.argv.slice(2)
const sourceCheckOnly = args.length === 1 && args[0] === '--check-source'
const transitionCheckOnly = args.length === 1 && args[0] === '--check-transition'
assert.ok(sourceCheckOnly || transitionCheckOnly || (args.length === 4 && args[0] === '--commit' && args[2] === '--receipt'),
  'Use --check-source, --check-transition (no receipt), or --commit SHA40 --receipt NEW_FILE; no database URL override is supported')
const gitSource = (commit, path) => execFileSync('git', ['show', `${commit}:${path}`],
  { cwd: repository, encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
const read = path => sourceCheckOnly || transitionCheckOnly ? readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') : gitSource(args[1], path)

function declarations(source, filename, names) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  return names.map(name => {
    const declaration = parsed.statements.find(statement => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body
    ) || (ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(item => item.name.getText(parsed) === name)))
    assert.ok(declaration, `Actual production declaration ${name} must exist in ${filename}`)
    return declaration.getText(parsed).replace(/^export\s+/u, '')
  }).join('\n')
}
function evaluate(source, context, exports) {
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText + `\nglobalThis.loaded = { ${exports.join(', ')} };`, context)
  return context.loaded
}
const currentSource = read('app_src/lib/persistence/crm.ts')
const oldSource = gitSource(LEGACY_WRITER_COMMIT, 'app_src/lib/persistence/crm.ts')
const oldDeclarations = declarations(oldSource, 'legacy-crm.ts', [
  'clean', 'nullable', 'isoTimestamp', 'normalizedInteractionType', 'interactionSuiteCrmModule',
  'interactionActivityStatus', 'interactionDurationMinutes', 'uniqueUuidList', 'stageInteraction',
])
const legacy = evaluate(oldDeclarations, { Error }, ['stageInteraction'])
const fixtureSource = read('scripts/test-crm-email-routing-postgres.mjs')
const fixtureContext = { ts, read, assert, vm, Buffer, TextDecoder, URL, URLSearchParams, Response, AbortSignal,
  nodeRequire: requireNode, unexpected: name => { throw new Error(`Unexpected external dependency: ${name}`) } }
const fixture = evaluate(declarations(fixtureSource, 'fixture.ts', ['loadModule', 'loadCrmPersistence', 'fixtureSchema']),
  fixtureContext, ['loadCrmPersistence', 'fixtureSchema'])
const producerDeclarations = declarations(currentSource, 'crm.ts', [
  'clean', 'normalizedInteractionType', 'interactionSuiteCrmModule', 'suiteCrmRelationships',
])
const migration = read('db/migrations/0374_crm_interaction_organizations.sql')
for (const fragment of ['clawpilot.crm_shared_write_v1', 'crm_shared_email_write_guard',
  'crm_shared_email_contact_guard', 'crm_shared_email_company_guard', 'crm_single_company_compatibility_bridge']) {
  assert.ok(migration.includes(fragment), `Rolling compatibility migration lacks ${fragment}`)
}
assert.ok(currentSource.includes("set_config('clawpilot.crm_shared_write_v1', 'on', true)"),
  'Compatible production writer must set transaction-local capability itself')
if (sourceCheckOnly) {
  console.log('PASS rolling rollback source contract; pinned actual legacy writer and current production loaders; no database launched')
  process.exit(0)
}

const identity = transitionCheckOnly ? null : committedRollbackIdentity(repository, args[1])
const receiptPath = transitionCheckOnly ? null : assertExternalRollbackOutput(repository, args[3])
const container = `clawpilot-crm-rolling-${process.pid}-${randomUUID().slice(0, 8)}`
const image = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image, /^pgvector\/pgvector:pg(?:16|18)$/u, 'Use an already installed approved PostgreSQL image')
const checks = []
let pool, started = false
try {
  execFileSync('docker', disposablePostgresDockerArgs([
    'run', '--rm', '-d', '--name', container, '--pull', 'never',
    '-e', 'POSTGRES_PASSWORD=crm_rolling_fixture', '-e', 'POSTGRES_DB=crm_rolling_fixture',
    '-p', '127.0.0.1::5432', image,
  ]), { timeout: 60_000, stdio: 'pipe' })
  started = true
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 10_000 })
    .match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port, 'Disposable fixture must bind only to loopback')
  pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'crm_rolling_fixture',
    database: 'crm_rolling_fixture', ssl: false, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
  const deadline = Date.now() + 30_000
  while (true) {
    try { await pool.query('SELECT 1'); break }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, '0')
  const query = (sql, values) => pool.query(sql, values)
  const transaction = async callback => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  await query(fixture.fixtureSchema)
  const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  const OWNER = 'rolling-operator@example.test', WORKSPACE = id(1), PIPELINE = id(2)
  const COMPANY_A = id(10), COMPANY_B = id(11), CONTACT_A = id(20), CONTACT_B = id(21)
  await query("INSERT INTO app_users VALUES ($1,'active','Rolling Operator','native-rolling-owner',true,'gu1234567')", [OWNER])
  await query('INSERT INTO workspace_organizations VALUES ($1,true)', [WORKSPACE])
  await query('INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id,is_default) VALUES($1,$2,$3,true)', [PIPELINE, OWNER, WORKSPACE])
  await query("INSERT INTO app_user_organization_memberships VALUES($1,$2,'active')", [WORKSPACE, OWNER])
  for (const [company, contact, suffix] of [[COMPANY_A, CONTACT_A, 'a'], [COMPANY_B, CONTACT_B, 'b']]) {
    await query('INSERT INTO crm_organizations(id,pipeline_id,name,suitecrm_id,reference_code,source_key) VALUES($1,$2,$3,$4,$5,$6)',
      [company, PIPELINE, `Synthetic Company ${suffix}`, `native-company-${suffix}`, suffix === 'a' ? 'ga1234567' : 'ga2345678', `company-${suffix}`])
    await query('INSERT INTO crm_contacts(id,pipeline_id,organization_id,full_name,email,suitecrm_id,reference_code,source_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [contact, PIPELINE, company, `Synthetic Contact ${suffix}`, `contact-${suffix}@example.test`, `native-contact-${suffix}`, suffix === 'a' ? 'gc1234567' : 'gc2345678', `contact-${suffix}`])
  }
  const input = (key, company, contact) => ({ entity: 'interactions', pipelineId: PIPELINE, sourceKey: key,
    actorEmail: OWNER, sourcePayload: { source: 'synthetic-gmail' }, fields: {
      organizationId: company, contactId: contact, contactIds: [contact], interactionType: 'email', suiteCrmModule: 'Emails',
      subject: 'Synthetic retained message', description: 'Synthetic retained correspondence.',
      agentEmail: OWNER, agentName: 'Rolling Operator', occurredAt: '2026-10-01T12:00:00.123Z',
      direction: 'inbound', deliveryStatus: 'received', providerMessageId: key, providerThreadId: 'synthetic-thread', metadata: {},
    } })
  const oldWrite = value => transaction(client => legacy.stageInteraction(client, value, `native-${value.sourceKey}`, sha256(canonicalJson(value))))
  const first = await oldWrite(input('aa1', COMPANY_A, CONTACT_A))
  await transaction(client => client.query(migration))
  const companies = interactionId => query('SELECT organization_id::text,is_primary FROM crm_interaction_organizations WHERE interaction_id=$1 ORDER BY sort_order,organization_id', [interactionId])
  assert.deepEqual((await companies(first.id)).rows, [{ organization_id: COMPANY_A, is_primary: true }], 'Migration backfills the actual old writer row')
  const second = await oldWrite(input('aa2', COMPANY_A, CONTACT_A))
  assert.deepEqual((await companies(second.id)).rows, [{ organization_id: COMPANY_A, is_primary: true }])
  checks.push('legacy_scalar_insert_after_migration')
  await oldWrite(input('aa1', COMPANY_B, CONTACT_B))
  assert.deepEqual((await companies(first.id)).rows, [{ organization_id: COMPANY_B, is_primary: true }])
  checks.push('legacy_scalar_primary_bridge')
  await assert.rejects(() => query(`INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order,created_by)
    VALUES($1,$2,$3,false,1,$4)`, [PIPELINE, first.id, COMPANY_A, OWNER]), error => error.code === '55000',
  'An old writer cannot activate a second company without the compatible transaction capability')
  await transaction(async client => {
    await client.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
    await client.query('INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order,created_by) VALUES($1,$2,$3,false,1,$4)', [PIPELINE, first.id, COMPANY_A, OWNER])
    await client.query('INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary,sort_order,created_by) VALUES($1,$2,$3,false,1,$4)', [PIPELINE, first.id, CONTACT_A, OWNER])
  })
  const snapshot = async () => (await query(`SELECT to_jsonb(interaction) AS interaction,
    (SELECT jsonb_agg(to_jsonb(link) ORDER BY sort_order,contact_id) FROM crm_interaction_contacts link WHERE link.interaction_id=interaction.id) AS contacts,
    (SELECT jsonb_agg(to_jsonb(link) ORDER BY sort_order,organization_id) FROM crm_interaction_organizations link WHERE link.interaction_id=interaction.id) AS companies
    FROM crm_interactions interaction WHERE interaction.id=$1`, [first.id])).rows[0]
  const shared = await snapshot()
  const deniedUnchanged = async action => { await assert.rejects(action, error => error.code === '55000'); assert.deepEqual(await snapshot(), shared) }
  await deniedUnchanged(() => oldWrite({ ...input('aa1', COMPANY_B, CONTACT_B), fields: {
    ...input('aa1', COMPANY_B, CONTACT_B).fields, subject: 'Must not be overwritten by old code' } }))
  await deniedUnchanged(() => query('UPDATE crm_interactions SET organization_id=$2 WHERE id=$1', [first.id, COMPANY_A]))
  checks.push('legacy_shared_interaction_denied')
  await deniedUnchanged(() => query('DELETE FROM crm_interaction_contacts WHERE interaction_id=$1 AND contact_id=$2', [first.id, CONTACT_A]))
  await deniedUnchanged(() => query('UPDATE crm_interaction_contacts SET interaction_id=$1 WHERE interaction_id=$2 AND contact_id=$3', [first.id, second.id, CONTACT_A]))
  await deniedUnchanged(() => query('UPDATE crm_interaction_contacts SET interaction_id=$1 WHERE interaction_id=$2 AND contact_id=$3', [second.id, first.id, CONTACT_B]))
  checks.push('legacy_shared_contacts_denied')
  await deniedUnchanged(() => query('DELETE FROM crm_interaction_organizations WHERE interaction_id=$1 AND organization_id=$2', [first.id, COMPANY_A]))
  await deniedUnchanged(() => query('UPDATE crm_interaction_organizations SET interaction_id=$1 WHERE interaction_id=$2 AND organization_id=$3', [first.id, second.id, COMPANY_A]))
  await deniedUnchanged(() => query('UPDATE crm_interaction_organizations SET interaction_id=$1 WHERE interaction_id=$2 AND organization_id=$3', [second.id, first.id, COMPANY_B]))
  checks.push('legacy_shared_companies_denied')

  const current = fixture.loadCrmPersistence(query, transaction)
  // The current writer acquires the real native-admission control even with
  // publication disabled. Keep the legacy-0374 checks above on their original
  // schema; then retain the actual later schema required by the current writer.
  // A fake singleton or a mocked lock would not test compatible rollback.
  await transaction(client => client.query(read('db/migrations/0375_crm_native_email_publication_admission.sql')))
  assert.equal((await query('SELECT enabled FROM crm_native_email_publication_control WHERE singleton')).rows[0].enabled, false)
  const edit = subject => ({ entity: 'interactions', pipelineId: PIPELINE, localId: first.id,
    sourceKey: shared.interaction.source_key, actorEmail: OWNER, fields: { subject } })
  await current.stageCrmRecordInPostgres(edit('Current compatible writer edit'))
  let saved = await snapshot()
  assert.equal(saved.interaction.subject, 'Current compatible writer edit')
  for (const key of ['id', 'suitecrm_id', 'reference_code', 'source_key', 'provider_message_id', 'provider_thread_id',
    'organization_id', 'contact_id', 'agent_email', 'agent_name', 'occurred_at', 'description', 'canonical_source_id']) {
    assert.deepEqual(saved.interaction[key], shared.interaction[key], `Compatible edit preserves ${key}`)
  }
  assert.deepEqual(saved.contacts.map(row => row.contact_id), shared.contacts.map(row => row.contact_id))
  assert.deepEqual(saved.companies.map(row => [row.organization_id, row.is_primary]), shared.companies.map(row => [row.organization_id, row.is_primary]))
  checks.push('compatible_shared_content_edit_preserves_identity')
  assert.notEqual((await query("SELECT current_setting('clawpilot.crm_shared_write_v1',true) AS flag")).rows[0].flag, 'on')
  checks.push('private_write_context_not_leaked')
  // Reload production declarations from the committed rollback snapshot against
  // retained schema/data. No down migration or legacy writable image is used.
  const rollbackFloor = fixture.loadCrmPersistence(query, transaction)
  await rollbackFloor.stageCrmRecordInPostgres(edit('Retained-schema rollback-floor edit'))
  saved = await snapshot()
  assert.equal(saved.interaction.subject, 'Retained-schema rollback-floor edit')
  assert.equal(saved.companies.length, 2); assert.equal(saved.contacts.length, 2)
  assert.equal(saved.interaction.suitecrm_id, shared.interaction.suitecrm_id)
  checks.push('retained_schema_compatible_rollback_write')
  const producer = evaluate(producerDeclarations, { Error }, ['suiteCrmRelationships'])
  const native = await producer.suiteCrmRelationships({ query }, { entity: 'interactions', pipelineId: PIPELINE,
    localId: first.id, fields: { interactionType: 'email', suiteCrmModule: 'Emails', organizationId: COMPANY_B } })
  assert.deepEqual(new Set(native.filter(row => row.relatedModuleName === 'Accounts').map(row => row.relatedBeanId)), new Set(['native-company-a', 'native-company-b']))
  assert.deepEqual(new Set(native.filter(row => row.relatedModuleName === 'Contacts').map(row => row.relatedBeanId)), new Set(['native-contact-a', 'native-contact-b']))
  checks.push('producer_retains_all_company_relationships')
  assert.deepEqual([...checks].sort(), [...REQUIRED_ROLLING_CHECKS].sort())
  if (transitionCheckOnly) {
    console.log(`PASS ${checks.length} working-tree rolling transition checks; NON-CERTIFYING, no receipt or rollback artifact created`)
  } else {
  assert.deepEqual(committedRollbackIdentity(repository, args[1]), identity, 'Source changed during transition acceptance')
  const postgresMajor = Math.trunc(Number((await query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000)
  const receipt = { format: ROLLBACK_ACCEPTANCE_FORMAT, status: 'passed', source: rollbackReceiptSource(identity),
    legacyWriterCommit: LEGACY_WRITER_COMMIT, postgresMajor, checks,
    boundary: 'Actual old/new persistence declarations and real synthetic local PostgreSQL only; no provider, native audience, deployment or worker-drain proof' }
  writeFileSync(receiptPath, canonicalJson(receipt), { flag: 'wx', mode: 0o444 })
  console.log(JSON.stringify({ passed: checks.length, receipt: receiptPath, receiptSha256: sha256(canonicalJson(receipt)), sourceCommit: identity.commit }))
  }
} finally {
  try { if (pool) await pool.end() }
  finally { if (started) execFileSync('docker', disposablePostgresDockerCleanupArgs(container), { timeout: 30_000, stdio: 'pipe' }) }
}
