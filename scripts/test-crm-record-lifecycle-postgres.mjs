#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 1
  && ['--postgres-major=16', '--postgres-major=18'].includes(args[0])),
'Only --postgres-major=16|18 is supported; duplicate and unknown arguments are refused')
const postgresMajor = args.length ? args[0].slice('--postgres-major='.length) : '18'
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = require('pg'), ts = require('typescript')
const command = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000 })
function load(path, mocks = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(output, { Buffer, URL, Date, console, process, module, exports: module.exports, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (name.startsWith('node:')) return require(name)
    return new Proxy({}, { get: (_, method) => () => { throw new Error(`Unexpected dependency ${name}.${String(method)}`) } })
  } }, { filename: path })
  return module.exports
}
const container = `clawpilot-crm-record-lifecycle-${process.pid}-${randomUUID().slice(0,8)}`
let pool, started = false
try {
  command(disposablePostgresDockerArgs(['run','--rm','-d','--pull','never','--name',container,
    '-e','POSTGRES_PASSWORD=lifecycle_test','-e','POSTGRES_DB=lifecycle_test','-p','127.0.0.1::5432',`pgvector/pgvector:pg${postgresMajor}`]))
  started = true
  const port = Number(command(['port',container,'5432/tcp']).match(/:(\d+)\s*$/)?.[1])
  pool = new Pool({ connectionString: `postgresql://postgres:lifecycle_test@127.0.0.1:${port}/lifecycle_test`, max: 5 })
  for (let attempt=0;;attempt++) {
    try { await pool.query('SELECT 1'); break } catch (error) {
      if (attempt>100) throw error
      await new Promise(resolve => setTimeout(resolve,200))
    }
  }
  await pool.query(`
    CREATE TABLE crm_native_email_publication_control(singleton boolean PRIMARY KEY,enabled boolean DEFAULT false,active_operation_id text,active_transition_id text);
    INSERT INTO crm_native_email_publication_control(singleton) VALUES(true);
    CREATE TABLE crm_native_email_publication_work(operation_id text,work_kind text,context jsonb);
    CREATE TABLE crm_native_email_publication_admissions(operation_id text,state text);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY, workspace_organization_id uuid,owner_email text,crm_last_synced_at timestamptz,updated_at timestamptz);
    CREATE TABLE crm_organizations(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,
      source_key text,identity_key text,name text,workspace_organization_id uuid,relationship_type text DEFAULT 'customer',
      source_payload jsonb DEFAULT '{}',source_hash text DEFAULT 'hash',sync_status text DEFAULT 'pending',sync_error text,suitecrm_synced_at timestamptz,updated_by text,updated_at timestamptz DEFAULT now());
    CREATE TABLE crm_contacts(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,
      source_key text,identity_key text,full_name text,organization_id uuid,app_user_email text,pipeline_user boolean DEFAULT false,
      contact_type text,source_payload jsonb DEFAULT '{}',source_hash text DEFAULT 'hash',updated_by text,updated_at timestamptz DEFAULT now());
    CREATE TABLE crm_contact_source_aliases(pipeline_id uuid,contact_id uuid,source_key text);
    CREATE TABLE sync_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),aggregate_type text,aggregate_id text,operation text,
      target_system text,payload jsonb,status text,idempotency_key text,attempts int,created_at timestamptz,available_at timestamptz,
      updated_at timestamptz,processed_at timestamptz,last_error text,lock_token text,locked_at timestamptz);
    CREATE UNIQUE INDEX outbox_identity ON sync_outbox(target_system,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE TABLE short_links(source_app text,slug text,deleted_at timestamptz,disabled_at timestamptz,updated_at timestamptz);
    CREATE TABLE app_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz);
  `)
  const withTransaction = async callback => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='15s'")
      const result = await callback(client); await client.query('COMMIT'); return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const postgres = { withTransaction, query: (...args) => pool.query(...args) }
  const crm = load('app_src/lib/persistence/crm.ts', {
    '@/lib/persistence/postgres': postgres,
    '@/lib/persistence/crmNativeEmailAuthority': load('app_src/lib/persistence/crmNativeEmailAuthority.ts'),
    '@/lib/crm/stableId': load('app_src/lib/crm/stableId.ts'),
    '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  })
  const pipelineA=randomUUID(),pipelineB=randomUUID(),organizationA=randomUUID(),organizationB=randomUUID(),contact=randomUUID()
  await pool.query('INSERT INTO pipeline_spaces(id,workspace_organization_id,owner_email) VALUES($1,$1,$3),($2,$2,$3)',[pipelineA,pipelineB,'owner@example.test'])
  await pool.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,reference_code,source_key,identity_key,name)
    VALUES($1,$2,'native-suburbia','ga1234567','source-a','source-a','Globus'),
      ($3,$4,'native-bpo','ga7654321','source-b','source-b','Globus')`,[organizationA,pipelineA,organizationB,pipelineB])
  await pool.query(`INSERT INTO crm_contacts(id,pipeline_id,suitecrm_id,reference_code,source_key,identity_key,full_name,organization_id)
    VALUES($1,$2,'native-contact','gc1234567','source-c','source-c','Contact',$3)`,[contact,pipelineA,organizationA])
  await pool.query("INSERT INTO short_links(source_app,slug) VALUES('clawpilot-crm','ga1234567'),('clawpilot-crm','gc1234567')")
  const base={pipelineId:pipelineA,actorEmail:'owner@example.test'}
  const archiveA=()=>crm.archiveCrmRecordInPostgres({...base,entity:'organizations',id:organizationA})
  const item={id:randomUUID(),aggregateType:'crm_organizations',aggregateId:organizationA,operation:'upsert_record',
    lockToken:'lease',idempotencyKey:`crm:organizations:v4:${organizationA}:default:hash`,
    payload:{entity:'organizations',pipelineId:pipelineA,localId:organizationA,suiteCrmId:'native-suburbia',attributes:{global_id_c:'ga1234567'}}}
  await pool.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,lock_token)
    VALUES($1,$2,$3,$4,'suitecrm',$5,'processing',$6)`,[item.id,item.aggregateType,item.aggregateId,item.operation,JSON.stringify(item.payload),item.lockToken])
  let releaseProvider, providerEntered
  const entered=new Promise(resolve=>{providerEntered=resolve}), released=new Promise(resolve=>{releaseProvider=resolve})
  const publishing=crm.withVerifiedSuiteCrmRecordLifecycle(item,async()=>{providerEntered();await released;return 'published'})
  await entered
  let archiveSettled=false
  const archiving=archiveA().then(result=>{archiveSettled=true;return result})
  await new Promise(resolve=>setTimeout(resolve,120))
  assert.equal(archiveSettled,false,'archive waits for the earlier bounded provider operation')
  releaseProvider();assert.equal(await publishing,'published');assert.equal((await archiving).suiteCrmDeleteQueued,true)
  let providerCalls=0
  await assert.rejects(()=>crm.withVerifiedSuiteCrmRecordLifecycle(item,async()=>{providerCalls++}),/deleted/)
  assert.equal(providerCalls,0)
  assert.equal((await pool.query('SELECT source_payload FROM crm_organizations WHERE id=$1',[organizationB])).rows[0].source_payload.archived,undefined)
  assert.equal((await pool.query('SELECT source_payload FROM crm_contacts WHERE id=$1',[contact])).rows[0].source_payload.archived,undefined)
  assert.equal((await pool.query("SELECT count(*) FROM sync_outbox WHERE operation='delete_record'")).rows[0].count,'1')
  assert.equal((await pool.query("SELECT payload->'attributes'->>'global_id_c' AS global FROM sync_outbox WHERE operation='delete_record'")).rows[0].global,'ga1234567')
  console.log('PASS actual PostgreSQL archive/provider serialization, exact outbox and no contact/tenant cascade')
  for(const localId of [organizationA,undefined]) {
    const result=await withTransaction(client=>crm.stageCrmRecordWithClient(client,{...base,entity:'organizations',localId,
      sourceKey:'source-a',fields:{name:'Globus'},sourcePayload:{stale:true}}))
    assert.equal(result.id,organizationA);assert.equal(result.shortUrl,null)
  }
  await assert.rejects(()=>crm.archiveCrmRecordInPostgres({...base,entity:'contacts',id:contact,archiveSource:'suitecrm',
    emitSuiteCrmOutbox:false,expectedSuiteCrmIdentity:{nativeId:'wrong',globalId:'gc1234567'}}),/binding changed/)
  await crm.archiveCrmRecordInPostgres({...base,entity:'contacts',id:contact,archiveSource:'suitecrm',emitSuiteCrmOutbox:false,
    expectedSuiteCrmIdentity:{nativeId:'native-contact',globalId:'gc1234567'}})
  await pool.query('INSERT INTO crm_contact_source_aliases VALUES($1,$2,$3)',[pipelineA,contact,'old-source'])
  for(const localId of [contact,undefined]) {
    const result=await withTransaction(client=>crm.stageCrmRecordWithClient(client,{...base,entity:'contacts',localId,
      sourceKey:'old-source',fields:{fullName:'Contact',email:'changed@example.test',organizationId:organizationA},sourcePayload:{stale:true}}))
    assert.equal(result.id,contact);assert.equal(result.shortUrl,null)
  }
  assert.equal((await archiveA()).changed,false)
  console.log('PASS actual PostgreSQL stale source/local/alias imports cannot revive tombstones; exact native binding required')
  await pool.query("UPDATE crm_organizations SET suitecrm_id='NATIVE-SUBURBIA' WHERE id=$1",[organizationB])
  await assert.rejects(()=>crm.archiveCrmRecordInPostgres({...base,entity:'organizations',id:organizationA}),/ambiguous/)
  await pool.query("UPDATE crm_organizations SET suitecrm_id='native-bpo' WHERE id=$1",[organizationB])
  const newerItem={...item,id:randomUUID(),aggregateId:organizationB,idempotencyKey:`crm:organizations:v4:${organizationB}:default:hash`,
    payload:{...item.payload,pipelineId:pipelineB,localId:organizationB,suiteCrmId:'native-bpo',attributes:{global_id_c:'ga7654321'}}}
  await pool.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,lock_token,idempotency_key)
    VALUES($1,$2,$3,$4,'suitecrm',$5,'processing',$6,$7)`,[newerItem.id,newerItem.aggregateType,newerItem.aggregateId,newerItem.operation,JSON.stringify(newerItem.payload),newerItem.lockToken,newerItem.idempotencyKey])
  await pool.query("UPDATE crm_organizations SET source_hash='newer-revision' WHERE id=$1",[organizationB])
  await assert.rejects(()=>crm.completeSuiteCrmOutboxInPostgres({...newerItem,payload:{...newerItem.payload,attributes:{global_id_c:'ga1111111'}}}),/lease or projection/)
  await crm.completeSuiteCrmOutboxInPostgres(newerItem)
  assert.equal((await pool.query('SELECT status FROM sync_outbox WHERE id=$1',[newerItem.id])).rows[0].status,'succeeded')
  assert.equal((await pool.query('SELECT sync_status FROM crm_organizations WHERE id=$1',[organizationB])).rows[0].sync_status,'pending')
  console.log('PASS actual PostgreSQL completion rejects changed payload and cannot mark a newer source revision synced')
  await pool.query('UPDATE crm_organizations SET workspace_organization_id=pipeline_id WHERE id=$1',[organizationB])
  await assert.rejects(()=>crm.archiveCrmRecordInPostgres({pipelineId:pipelineB,entity:'organizations',id:organizationB,actorEmail:base.actorEmail}),/Settings/)
  await pool.query('UPDATE crm_contacts SET pipeline_user=true WHERE id=$1',[contact])
  await assert.rejects(()=>crm.archiveCrmRecordInPostgres({...base,entity:'contacts',id:contact}),/Settings/)
  await pool.query("UPDATE crm_contacts SET pipeline_user=false,contact_type='pipeline_user' WHERE id=$1",[contact])
  await assert.rejects(()=>crm.archiveCrmRecordInPostgres({...base,entity:'contacts',id:contact}),/Settings/)
  console.log('PASS actual PostgreSQL managed workspace/login records protected')
  const scan=load('app_src/lib/crm/suiteCrmAccountContactLifecycle.ts',{
    '@/lib/persistence/postgres':postgres,'@/lib/persistence/crm':crm,
    '@/lib/crm/suiteCrmRecordLifecycleClient':{inspectSuiteCrmRecordLifecycle:async records=>records.map(record=>({...record,state:'active',dateModified:'2026-10-30 12:00:00'}))},
  })
  const oldFlag=process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED
  process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED='1'
  try { const result=await scan.processSuiteCrmAccountContactLifecycle();assert.equal(result.errors,0);assert.equal(result.archived,0);assert.equal(result.protected,1)
  } finally { if(oldFlag===undefined)delete process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED;else process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=oldFlag }
  console.log(`PASS actual PostgreSQL ${postgresMajor} bounded lifecycle inventory/cursor SQL; provider evidence mocked, no production proof`)

  // Execute the actual profile transaction body against PostgreSQL, not a SQL
  // model. The existing retained identities make later staging a no-op; user
  // authorization/hierarchy initialization are outside this bounded lock test.
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()')
  const profileSource = readFileSync('app_src/lib/persistence/crm.ts', 'utf8')
  const profileTree = ts.createSourceFile('crm.ts', profileSource, ts.ScriptTarget.Latest, true)
  const declaration = name => profileTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  const profileDeclaration = declaration('syncAppUserProfileToCrm'), callbacks = []
  assert.ok(profileDeclaration)
  function findProfileTransaction(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withTransaction') callbacks.push(node.arguments[0])
    ts.forEachChild(node, findProfileTransaction)
  }
  findProfileTransaction(profileDeclaration)
  assert.equal(callbacks.length, 1)
  const profileModule = { exports: {} }
  const profileCode = `${declaration('lockCrmMutation').getText(profileTree)}\nmodule.exports = ${callbacks[0].getText(profileTree)}`
  vm.runInNewContext(ts.transpileModule(profileCode, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module: profileModule, exports: profileModule.exports,
    input: base, user: { email: base.actorEmail, contactReferenceCode: 'gc1234567', timezone: 'America/New_York', locale: 'en-US' },
    displayName: 'Profile fixture',
    workspaceOrganization: { id: pipelineA }, organization: { id: organizationA, suiteCrmId: 'native-suburbia' },
    profileSourceKey: `profile:${base.actorEmail}`, clean: value => String(value ?? '').trim(),
    lockCrmNativeEmailAuthorityWithClient: load('app_src/lib/persistence/crmNativeEmailAuthority.ts').lockCrmNativeEmailAuthorityWithClient,
    stageCrmRecordWithClient: crm.stageCrmRecordWithClient,
  }, { filename: 'actual-crm-profile-transaction.ts' })
  let releaseProfileRows, profileRowsEntered, writerPid = null, writer = null
  const profileRows = new Promise(resolve => { profileRowsEntered = resolve })
  const continueProfile = new Promise(resolve => { releaseProfileRows = resolve })
  const outcome = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
  const profile = outcome(withTransaction(async client => {
    await client.query("SET LOCAL deadlock_timeout='200ms'")
    return profileModule.exports({ async query(sql, values) {
      const result = await client.query(sql, values)
      if (sql.includes('SELECT contact.id::text, contact.organization_id::text') && sql.includes('FOR UPDATE')) {
        profileRowsEntered(); await continueProfile
      }
      return result
    } })
  }))
  try {
    let readyTimer
    try { await Promise.race([profileRows, profile.then(result => { throw result.error || new Error('Profile transaction exited before its row-lock barrier') }),
      new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Profile row-lock barrier timed out')), 4000) })])
    } finally { clearTimeout(readyTimer) }
    writer = outcome(withTransaction(async client => {
      writerPid = client.processID
      await client.query("SET LOCAL deadlock_timeout='200ms'")
      return crm.stageCrmRecordWithClient(client, { ...base, entity: 'organizations', localId: organizationA,
        sourceKey: 'source-a', fields: { name: 'Globus' }, sourcePayload: { stale: true } })
    }))
    const waitDeadline = Date.now() + 4000
    let blockedQuery = null
    while (Date.now() < waitDeadline) {
      if (writerPid) {
        const row = (await pool.query('SELECT wait_event_type, query FROM pg_stat_activity WHERE pid=$1', [writerPid])).rows[0]
        if (row?.wait_event_type === 'Lock') { blockedQuery = row.query; break }
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(blockedQuery, 'Concurrent actual staging must wait on a real PostgreSQL lock')
    releaseProfileRows()
    const results = await Promise.all([profile, writer])
    assert.ok(results.every(result => result.status === 'fulfilled'),
      `Profile/staging concurrency failed: ${results.map(result => result.error?.code || result.status).join(', ')}`)
    assert.match(blockedQuery, /crm_native_email_publication_control/, 'Writer waits for control, not profile-held CRM rows')
    assert.equal(results[0].value.id, contact)
    assert.equal(results[1].value.id, organizationA)
    console.log(`PASS actual PostgreSQL ${postgresMajor} profile transaction/control-first staging contention commits without 40P01; retained-identity fixture, not full profile workflow`)
  } finally {
    releaseProfileRows()
    await profile
    if (writer) await writer
  }
} finally {
  if(pool)await pool.end()
  if(started)command(disposablePostgresDockerCleanupArgs(container))
}
