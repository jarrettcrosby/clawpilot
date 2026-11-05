#!/usr/bin/env node
// Default: pure protocol checks. --postgres: one guarded synthetic database;
// no DATABASE_URL, native CRM, real identities, actual delivery or deployment.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--postgres', 'Use no arguments or --postgres')
function load(path, dependencies) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const module = { exports: {} }
  const output = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  new Function('module','exports','require',output)(module,module.exports,name => {
    assert.ok(Object.hasOwn(dependencies,name), `Unexpected dependency ${name}`); return dependencies[name]
  })
  return module.exports
}
const api = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
const { PostgresNativeEmailPublicationStore } = load('app_src/lib/crm/nativeEmailPublicationPostgres.ts', {
  './nativeEmailPublication': api,
})
const clone = value => JSON.parse(JSON.stringify(value))
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const policy = 'b'.repeat(64)
function input(number = 1, generation = 1) {
  return { command: { version: 1, operationId: hash(`operation-${number}`), mode: 'publish', workspaceId: id(1),
    pipelineId: id(2), generation, audienceFingerprint: 'a'.repeat(64), suiteCrmId: `native-email-${number}`,
    globalId: `gi${String(number).padStart(7, '0')}`, localId: id(100 + number), expectedRecordFingerprint: null,
    projection: { attributes: { name: 'Synthetic message', description: 'No real customer data.' },
      accounts: [], contacts: [], contactAccounts: [], previousManaged: { accounts: [], contacts: [] } } },
  nativePolicyFingerprint: policy, allowedReaderSuiteCrmUserIds: ['viewer', 'admin'] }
}
function terminal(request, state = 'committed') {
  const c = request.command
  return { version: 1, operationId: c.operationId, commandHash: request.commandHash, state, replayed: false,
    result: state === 'cancelled' ? null : { version: 1, mode: c.mode, suiteCrmId: c.suiteCrmId, globalId: c.globalId,
      pipelineId: c.pipelineId, generation: c.generation, audienceFingerprint: c.audienceFingerprint,
      recordFingerprint: c.expectedRecordFingerprint || 'c'.repeat(64), readerSuiteCrmUserIds: ['admin', 'viewer'],
      projection: c.mode === 'repair' ? null : { version: 2, sourceAttributes: c.projection.attributes } } }
}
const checks = []
async function check(name, callback) { await callback(); checks.push(name); console.log(`PASS ${name}`) }
const isHeld = code => error => error?.name === 'NativeEmailPublicationHeld' && (!code || error.code === code)

await check('canonical command binds Unicode, key order, exact reader set and immutable clone', () => {
  const original = input(), prepared = api.prepareNativeEmailPublication(original)
  original.command.projection.attributes.name = 'Mutated after admission'
  assert.equal(prepared.command.projection.attributes.name, 'Synthetic message')
  assert.deepEqual(prepared.allowedReaderSuiteCrmUserIds, ['admin', 'viewer'])
  assert.equal(api.nativeEmailDigest({ b: ['a'], a: 'é\u2028/\u2029' }),
    hash('{"a":"é\\u2028/\\u2029","b":["a"]}'))
  assert.equal(api.nativeEmailDigest({ b: 2, a: 1 }), api.nativeEmailDigest({ a: 1, b: 2 }))
})
await check('canonical protocol refuses lone UTF-16 surrogates in strings and keys before admission', () => {
  for (const malformed of ['\ud800','\udfff','before\ud800after','before\udc00after','\ud800\ud800','\udc00\ud800']) {
    assert.throws(() => api.nativeEmailCanonicalJson({ text: malformed }), isHeld('invalid_json_unicode'))
    assert.throws(() => api.nativeEmailCanonicalJson({ [`key${malformed}`]: 'value' }), isHeld('invalid_json_unicode'))
    const x = input(); x.command.projection.attributes.name = malformed
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_json_unicode'))
  }
  const pair = '\ud83d\ude80'
  assert.equal(api.nativeEmailCanonicalJson({ text: pair }), '{"text":"🚀"}')
  const x = input(); x.command.projection.attributes.name = `Valid ${pair}`
  assert.equal(api.prepareNativeEmailPublication(x).command.projection.attributes.name, 'Valid 🚀')
})
await check('canonical protocol rejects PHP-ambiguous objects keys and numeric forms while admitting wire shapes', () => {
  for (const value of [{}, { nested: {} }, { 0: 'zero' }, { 10: 'ten', 2: 'two' },
    { 'é': 'value' }, { 'a-b': 'value' }, { '_hidden': 'value' }])
    assert.throws(() => api.nativeEmailCanonicalJson(value), isHeld())
  for (const value of [0.1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN]) {
    assert.throws(() => api.nativeEmailCanonicalJson({ value }), isHeld('invalid_json_number'))
    const x = input(); x.command.projection.attributes.extra = value
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_json_number'))
  }
  assert.equal(api.nativeEmailCanonicalJson({ version: 2, generation: Number.MAX_SAFE_INTEGER, description_html: '',
    accounts: [], previousManaged: { accounts: [], contacts: [] }, nullable: null }),
  '{"accounts":[],"description_html":"","generation":9007199254740991,"nullable":null,"previousManaged":{"accounts":[],"contacts":[]},"version":2}')
  const request = api.prepareNativeEmailPublication(input())
  api.verifyNativeEmailTerminalReceipt(request, terminal(request))
  api.verifyNativeEmailTerminalReceipt(request, terminal(request, 'cancelled'))
})
await check('pre-admission nesting remains below the native JSON parser depth cap', () => {
  let nested = 'leaf'
  for (let index = 0; index < 33; index++) nested = { nested }
  assert.throws(() => api.nativeEmailCanonicalJson(nested), isHeld('invalid_json_depth'))
  const x = input(); x.command.projection.attributes.extra = nested
  assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_json_depth'))
  assert.equal(api.prepareNativeEmailPublication(input()).command.projection.attributes.name, 'Synthetic message')
})
await check('native Email identity fits the fixed-width receipt and cancellation columns before admission', () => {
  const valid = input(); valid.command.suiteCrmId = 'a'.repeat(36)
  assert.equal(api.prepareNativeEmailPublication(valid).command.suiteCrmId.length, 36)
  for (const length of [37,64]) {
    const x = input(); x.command.suiteCrmId = 'a'.repeat(length)
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_record_identity'))
  }
})
await check('rejects malformed request, ambiguous readers, undefined and oversized projection', () => {
  for (const mutate of [x => { x.command.operationId = id(1) }, x => { x.command.generation = 0 },
    x => { x.allowedReaderSuiteCrmUserIds.push('viewer') }, x => { x.command.extra = true },
    x => { x.command.projection.attributes.name = undefined }, x => { x.command.projection.attributes.name = 'x'.repeat(600001) }]) {
    const x = input(); mutate(x); assert.throws(() => api.prepareNativeEmailPublication(x), isHeld())
  }
})
await check('command identities and fingerprints cannot pass regex validation by type coercion', () => {
  for (const key of ['operationId','audienceFingerprint','pipelineId','localId','workspaceId','suiteCrmId','globalId','expectedRecordFingerprint']) {
    for (const value of [true,123,[key === 'expectedRecordFingerprint' ? policy : input().command[key]]]) {
      const x = input(); x.command[key] = value
      assert.throws(() => api.prepareNativeEmailPublication(x), isHeld(), `${key} must be a native string`)
    }
  }
  for (const value of [true,123,[policy]]) {
    const x = input(); x.nativePolicyFingerprint = value
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_command_identity'))
  }
  for (const ending of ['\n','\r','\r\n','\u2028','\u2029']) {
    for (const key of ['operationId','audienceFingerprint','pipelineId','localId','workspaceId','suiteCrmId','globalId','expectedRecordFingerprint']) {
      const x = input(); x.command[key] = (key === 'expectedRecordFingerprint' ? policy : x.command[key]) + ending
      assert.throws(() => api.prepareNativeEmailPublication(x), isHeld(), `${key} must use native true-end semantics`)
    }
    const x = input(); x.nativePolicyFingerprint += ending
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('invalid_command_identity'))
    const reader = input(); reader.allowedReaderSuiteCrmUserIds = [`admin${ending}`]
    assert.throws(() => api.prepareNativeEmailPublication(reader), isHeld('invalid_readers'))
    assert.throws(() => api.nativeEmailCanonicalJson({ [`name${ending}`]: 'value' }), isHeld('invalid_json_key'))
  }
})
await check('pre-admission limit matches native escaped JSON for Unicode slash separators and emoji', () => {
  // Each command is below the unescaped UTF-8 cap but above PHP's escaped cap;
  // admitting any would strand cancellation behind native validateCommand.
  for (const text of ['é'.repeat(100000), '/'.repeat(300000), '🚀'.repeat(50000)]) {
    const x = input(); x.command.projection.attributes.description = text
    assert.ok(Buffer.byteLength(api.nativeEmailCanonicalJson(x.command),'utf8') < 600000)
    assert.throws(() => api.prepareNativeEmailPublication(x), isHeld('native_command_too_large'))
  }
  const separators = input(); separators.command.projection.attributes.description = '\u2028'.repeat(100000)
  assert.throws(() => api.prepareNativeEmailPublication(separators), isHeld('command_too_large'))
  const valid = input(); valid.command.projection.attributes.description = 'é / \u2028 \u2029 🚀'.repeat(1000)
  assert.equal(api.prepareNativeEmailPublication(valid).command.projection.attributes.description, valid.command.projection.attributes.description)
})
await check('receipt rejects foreign operation, stale generation, wrong audience/readers, malformed cancellation and 404', () => {
  const request = api.prepareNativeEmailPublication(input())
  api.verifyNativeEmailTerminalReceipt(request, terminal(request))
  api.verifyNativeEmailTerminalReceipt(request, terminal(request, 'cancelled'))
  for (const mutate of [r => { r.operationId = hash('other') }, r => { r.commandHash = policy },
    r => { r.result.generation++ }, r => { r.result.readerSuiteCrmUserIds.push('foreign') },
    r => { r.result.readerSuiteCrmUserIds.reverse() }, r => { r.result.globalId = 'gi7654321' },
    r => { r.result.projection = null }, r => { r.state = 'cancelled' }]) {
    const receipt = terminal(request); mutate(receipt)
    assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, receipt), isHeld())
  }
  assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, { status: 404 }), isHeld())
})
await check('historical repair receipt must preserve original native record fingerprint', () => {
  const x = input(); x.command.mode = 'repair'; x.command.projection = null; x.command.expectedRecordFingerprint = policy
  const request = api.prepareNativeEmailPublication(x), receipt = terminal(request)
  api.verifyNativeEmailTerminalReceipt(request, receipt)
  receipt.result.recordFingerprint = 'd'.repeat(64)
  assert.throws(() => api.verifyNativeEmailTerminalReceipt(request, receipt), isHeld('native_projection_missing'))
})

// In-memory state machine exercises orchestration only, never SQL acceptance.
class MemoryStore {
  admission = null
  async admit(value, validate) {
    const request = api.prepareNativeEmailPublication(value)
    if (this.admission) { assert.equal(this.admission.request.requestFingerprint, request.requestFingerprint); return this.admission }
    await validate(null, request); this.admission = { request, state: 'admitted', receipt: null }; return this.admission
  }
  async get() { return this.admission }
  async markDispatched() { if (this.admission.state !== 'admitted') return false; this.admission.state = 'dispatched'; return true }
  async markUnknown() { if (!this.admission.receipt) this.admission.state = 'unknown' }
  async settle(id, value, finalize) {
    const receipt = api.verifyNativeEmailTerminalReceipt(this.admission.request, value)
    await finalize(null, this.admission.request, receipt)
    this.admission.state = receipt.state; this.admission.receipt = receipt; return receipt
  }
}
const noop = async () => {}
await check('lost publish response remains held, no blind second send, exact cancellation resolves', async () => {
  const store = new MemoryStore(), x = input(); let sends = 0
  const bridge = { publish: async () => { sends++; throw Error('socket lost') },
    resolveOrCancel: async () => terminal(store.admission.request, 'cancelled') }
  await assert.rejects(() => api.dispatchNativeEmailPublication(store, x, bridge, noop, noop), isHeld('native_outcome_unknown'))
  assert.equal(store.admission.state, 'unknown')
  await assert.rejects(() => api.dispatchNativeEmailPublication(store, x, bridge, noop, noop), isHeld('reconciliation_required'))
  assert.equal(sends, 1)
  assert.equal((await api.reconcileNativeEmailPublication(store, x.command.operationId, bridge, noop)).state, 'cancelled')
})
await check('404 and network failure never unlock, committed receipt survives local finalize failure', async () => {
  const store = new MemoryStore(), x = input()
  const bridge = { publish: async () => terminal(store.admission.request), resolveOrCancel: async () => ({ status: 404 }) }
  await assert.rejects(() => api.dispatchNativeEmailPublication(store, x, bridge, noop, async () => { throw Error('local tx failed') }), /local tx failed/)
  assert.equal(store.admission.state, 'dispatched'); assert.equal(store.admission.receipt, null)
  await assert.rejects(() => api.reconcileNativeEmailPublication(store, x.command.operationId, bridge, noop), isHeld('native_outcome_unknown'))
  bridge.resolveOrCancel = async () => terminal(store.admission.request)
  assert.equal((await api.reconcileNativeEmailPublication(store, x.command.operationId, bridge, noop)).state, 'committed')
})

if (!args.length) { console.log(`PASS ${checks.length} pure checks only; no database/native/deployment proof`); process.exit(0) }

const migration = readFileSync(new URL('../db/migrations/0375_crm_native_email_publication_admission.sql', import.meta.url), 'utf8')
const { Pool } = require('pg')
const container = `clawpilot-native-admission-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image, /^pgvector\/pgvector:pg(?:16|18)$/u, 'Use an already cached approved image')
let pool, started = false
try {
  execFileSync('docker', disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=native_admission_fixture','-e','POSTGRES_DB=native_admission_fixture','-p','127.0.0.1::5432',image]),
  { timeout: 60000, stdio: 'pipe' }); started = true
  const port = execFileSync('docker', ['port',container,'5432/tcp'], { encoding: 'utf8', timeout: 10000 }).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'native_admission_fixture',
    database: 'native_admission_fixture', ssl: false, max: 3, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
  const deadline = Date.now() + 30000
  while (true) { try { await pool.query('SELECT 1'); break } catch (e) { if (Date.now() >= deadline) throw e; await new Promise(r => setTimeout(r,100)) } }
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count, '0')
  const query = (sql, values) => pool.query(sql, values)
  const transaction = async callback => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid,display_name text,last_login_at timestamptz);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false,name text);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,updated_at timestamptz,PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE synthetic_finalizations(operation_id text PRIMARY KEY,state text);
    INSERT INTO pipeline_spaces(id,owner_email,workspace_organization_id,name) VALUES('${id(2)}','owner@example.test','${id(1)}','Synthetic');
    INSERT INTO app_users(email,status,suitecrm_user_id,role) VALUES('owner@example.test','active','admin','owner');
    INSERT INTO app_user_organization_memberships VALUES('owner@example.test','${id(1)}','active','owner','{}',NULL,now());
    INSERT INTO pipeline_space_members VALUES('${id(2)}','owner@example.test','owner',now());`)
  await transaction(tx => tx.query(migration))
  const store = new PostgresNativeEmailPublicationStore(transaction)
  const control = async () => (await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  let generation = 1
  await check('real SQL migration stays disabled, relevant authority edits invalidate generation', async () => {
    assert.equal((await control()).enabled, false)
    await assert.rejects(() => store.admit(input(), noop), isHeld('publication_not_enabled_for_generation'))
    await query("UPDATE app_users SET display_name='Allowed cosmetic edit'")
    assert.equal(Number((await control()).generation), 1)
    await query("UPDATE app_users SET status='disabled'")
    assert.equal(Number((await control()).generation), 2)
    await query("UPDATE app_users SET status='active'")
    generation = Number((await control()).generation)
    assert.equal(generation, 3)
    // Synthetic fixture activation only; production requires reviewed evidence.
    await query('UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2', [policy,'e'.repeat(64)])
  })
  const x = input(1,generation)
  const finalize = async (tx, request, receipt) => {
    if (receipt.state === 'committed') assert.deepEqual(clone(receipt.result.projection.sourceAttributes), x.command.projection.attributes)
    await tx.query('INSERT INTO synthetic_finalizations VALUES($1,$2)', [request.command.operationId,receipt.state])
  }
  await check('real SQL admission validates under lock, persists exact command, dispatches only once', async () => {
    let validated = false
    const a = await store.admit(x, async (tx, request) => {
      validated = true; assert.equal(request.command.generation,generation)
      assert.equal((await tx.query('SELECT count(*) AS n FROM pipeline_spaces')).rows[0].n,'1')
    })
    assert.ok(validated); assert.equal(a.state,'admitted')
    assert.deepEqual(clone((await store.get(x.command.operationId)).request.command), clone(a.request.command))
    assert.equal(await store.markDispatched(x.command.operationId),true)
    assert.equal(await store.markDispatched(x.command.operationId),false)
    await assert.rejects(() => store.admit(input(2,generation),noop), isHeld('another_publication_unresolved'))
    const changed = clone(x); changed.command.projection.attributes.name = 'Changed'
    await assert.rejects(() => store.admit(changed,noop),isHeld('operation_identity_conflict'))
  })
  await check('real SQL enabled authority guard blocks all four tables, including insert phantoms and revocations', async () => {
    const commands = [
      "UPDATE app_users SET status='disabled'", "UPDATE app_users SET suitecrm_user_id='another-native-user'",
      "INSERT INTO app_users(email,status) VALUES('future@example.test','active')", "DELETE FROM app_users",
      "UPDATE pipeline_spaces SET owner_email='other@example.test'", "UPDATE pipeline_spaces SET reference_access_disabled=true",
      `UPDATE pipeline_spaces SET workspace_organization_id='${id(3)}'`,
      `INSERT INTO pipeline_space_members VALUES('${id(2)}','new@example.test','viewer',now())`,
      "DELETE FROM pipeline_space_members", "UPDATE pipeline_space_members SET access_role='editor'",
      "UPDATE app_user_organization_memberships SET status='disabled'", "UPDATE app_user_organization_memberships SET trashed_at=now()",
      "DELETE FROM app_user_organization_memberships", "TRUNCATE pipeline_space_members",
      "UPDATE crm_native_email_publication_control SET enabled=false,active_operation_id=NULL",
      "UPDATE crm_native_email_publication_control SET active_operation_id=NULL",
      "TRUNCATE crm_native_email_publication_control", "DELETE FROM crm_native_email_publication_admissions",
    ]
    for (const sql of commands) await assert.rejects(() => query(sql), e => e.code === '55000', sql)
    await query("UPDATE app_users SET last_login_at=now(),display_name='Still allowed'")
    await query("UPDATE pipeline_spaces SET name='Cosmetic pipeline name'")
    assert.equal(Number((await control()).generation),generation)
  })
  await check('real SQL statement guard serializes attempted phantom against admission control lock', async () => {
    const a = await pool.connect(), b = await pool.connect()
    try {
      await a.query('BEGIN'); await a.query('SELECT * FROM crm_native_email_publication_control FOR UPDATE')
      await b.query('BEGIN'); await b.query("SET LOCAL lock_timeout='150ms'")
      await assert.rejects(() => b.query(`INSERT INTO pipeline_space_members VALUES('${id(2)}','phantom@example.test','viewer',now())`), e => e.code === '55P03')
      await b.query('ROLLBACK'); await a.query('ROLLBACK')
      assert.equal((await query("SELECT count(*) AS n FROM pipeline_space_members WHERE user_email='phantom@example.test'")).rows[0].n,'0')
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release() }
  })
  await check('real SQL unknown outcome persists across process/store recreation; invalid receipt cannot unlock', async () => {
    await store.markUnknown(x.command.operationId)
    const recovered = new PostgresNativeEmailPublicationStore(transaction)
    assert.equal((await recovered.get(x.command.operationId)).state,'unknown')
    await assert.rejects(() => recovered.settle(x.command.operationId,{ status:404 },finalize),isHeld())
    await assert.rejects(() => query("UPDATE crm_native_email_publication_admissions SET state='cancelled',native_receipt='{}' WHERE operation_id=$1",[x.command.operationId]),e => e.code === '23514')
    assert.equal((await control()).active_operation_id,x.command.operationId)
    const request = (await recovered.get(x.command.operationId)).request
    await assert.rejects(() => recovered.settle(x.command.operationId,terminal(request),async tx => {
      await tx.query('INSERT INTO synthetic_finalizations VALUES($1,$2)',[x.command.operationId,'must-rollback'])
      throw Error('projection verification failed')
    }), /projection verification failed/)
    assert.equal((await query('SELECT count(*) AS n FROM synthetic_finalizations')).rows[0].n,'0')
    assert.equal((await recovered.get(x.command.operationId)).state,'unknown')
  })
  await check('real SQL terminal receipt plus local finalize commit atomically; replay does not duplicate local state', async () => {
    const request = (await store.get(x.command.operationId)).request
    await store.settle(x.command.operationId,terminal(request),finalize)
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await query('SELECT count(*) AS n FROM synthetic_finalizations')).rows[0].n,'1')
    await store.settle(x.command.operationId,{ ...terminal(request),replayed:true },async () => { throw Error('must not repeat') })
    await assert.rejects(() => query("UPDATE crm_native_email_publication_admissions SET state='unknown',native_receipt=NULL WHERE operation_id=$1",[x.command.operationId]),e => e.code === '55000')
    // Clearing one attempt is NOT permission to revoke while historical native
    // Emails remain readable. Authority remains frozen after successful receipt.
    await assert.rejects(() => query('DELETE FROM pipeline_space_members'),e => e.code === '55000')
    await assert.rejects(() => query('UPDATE crm_native_email_publication_control SET enabled=false'),e => e.code === '55000')
  })
  await check('real SQL exact cancellation tombstone releases next admission without marking Email synced', async () => {
    const next = input(2,generation), a = await store.admit(next,noop)
    await store.markDispatched(next.command.operationId)
    await store.markUnknown(next.command.operationId)
    await store.settle(next.command.operationId,terminal(a.request,'cancelled'),finalize)
    assert.equal((await store.get(next.command.operationId)).state,'cancelled')
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await query('SELECT state FROM synthetic_finalizations WHERE operation_id=$1',[next.command.operationId])).rows[0].state,'cancelled')
  })
  console.log(`PASS ${checks.length} pure + actual guarded PostgreSQL checks; synthetic only, not native/deployment/concurrency-across-DB proof`)
} finally {
  try { if (pool) await pool.end() }
  finally { if (started) execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{ timeout:30000,stdio:'pipe' }) }
}
