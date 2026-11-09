#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const copy = value => JSON.parse(JSON.stringify(value))
const workspaceId='c6c49765-9bf6-4223-9261-7553499f5d92', pipelineId='587c8746-ecf6-40ae-8c50-e456f99ad555'
const localId='11111111-1111-4111-8111-111111111111', suiteCrmId='22222222-2222-4222-8222-222222222222'
const outboxId='33333333-3333-4333-8333-333333333333', globalId='gi123456789abc'
const sourceRevision='a'.repeat(64), snapshotFingerprint='b'.repeat(64)
const env = { CLAWPILOT_SUITECRM_SHARED_EMAIL_WORKSPACE_ID:workspaceId, CLAWPILOT_SUITECRM_SHARED_EMAIL_PIPELINE_ID:pipelineId }
const accounts=['customer','supplier'], contacts=['customer-contact','supplier-contact']
const contactAccounts=[{contactId:contacts[0],accountId:accounts[0]}, {contactId:contacts[1],accountId:accounts[1]}]

function transport(config=env) {
  const exports = {}
  vm.runInNewContext(compile(read('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')),
    { exports, require: module => { assert.equal(module,'node:crypto'); return crypto }, process: {env: config}, AbortSignal, Buffer, URLSearchParams })
  return exports
}

function job() {
  const payload = {entity:'interactions',pipelineId,localId,suiteCrmId,suiteCrmModule:'Emails',attributes:{
    global_id_c:globalId,name:'Customer and supplier',date_sent_received:'2026-11-09 20:00:00',type:'archived',status:'read',
    parent_type:'Accounts',parent_id:accounts[0],description:'Private synthetic text',description_html:'',
    assigned_user_id:'approved-native-agent',from_addr_name:'sender@example.test',
  }, sharedEmailProjection:{version:1,workspaceId,sourceRevision,accounts,contacts,contactAccounts,
    previousManaged:{accounts:[],contacts:[]},expectedBeforeFingerprint:null}, relationships:[
    ...accounts.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
    ...contacts.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId})),
  ]}
  return copy({ id:outboxId,aggregateType:'crm_interactions',aggregateId:localId,operation:'upsert_record',lockToken:'lease',attempts:1,
    idempotencyKey:`crm:interactions:v4:${localId}:Emails:${sourceRevision}`,payload })
}

function nativeReadback() { return copy({version:1,suiteCrmId,globalId,snapshotFingerprint,accounts,contacts,contactAccounts}) }

test('shared worker makes a single bounded native call with both companies and their own contacts, no role data', async () => {
  const item=job(), calls=[]
  const proof=await transport().projectSuiteCrmSharedEmail(item.payload, async (path,init) => {
    calls.push({path,method:init.method,body:JSON.parse(init.body)})
    assert.ok(init.signal instanceof AbortSignal)
    return nativeReadback()
  })
  assert.deepEqual(calls,[{path:'/Api/V8/custom/clawpilot-email-shared',method:'POST',body:{
    version:1,workspaceId,pipelineId,localId,sourceRevision,projection:{suiteCrmId,attributes:item.payload.attributes,
      accounts,contacts,contactAccounts,previousManaged:{accounts:[],contacts:[]},expectedBeforeFingerprint:null},
  }}])
  assert.equal(proof.version,2)
  assert.equal(proof.globalId,globalId)
  assert.equal(proof.snapshotFingerprint,snapshotFingerprint)
  assert.equal(proof.sharedPublication.sourceRevision,sourceRevision)
  assert.equal(Object.hasOwn(proof,'audience'),false)
  assert.equal(Object.hasOwn(proof,'attributes'),false)
})

test('config, scope, collisions, prior snapshot or response drift never produce a shared receipt', async () => {
  for (const [configure, mutate] of [
    [{}, _=>{}], [{...env,CLAWPILOT_SUITECRM_SHARED_EMAIL_WORKSPACE_ID:'incorrect'}, _=>{}],
    [env, p=>{p.pipelineId=suiteCrmId}], [env,p=>{p.sharedEmailProjection.workspaceId=localId}],
    [env,p=>{p.sharedEmailProjection.accounts.push('CUSTOMER')}], [env,p=>{p.emailProjection={}}],
    [env,p=>{p.previousSuiteCrmModule='Notes'}], [env,p=>{p.sharedEmailProjection.previousManaged.accounts=['old']}],
  ]) {
    const {payload}=job(); mutate(payload)
    await assert.rejects(transport(configure).projectSuiteCrmSharedEmail(payload,()=>assert.fail('must not send native request')),/held/)
  }
  for (const mutate of [r=>{r.globalId='gi123456789abd'},r=>{r.contacts.pop()},r=>{r.contactAccounts[1].accountId='customer'},
    r=>{r.snapshotFingerprint='short'},r=>{r.audience={}}]) {
    const reply=nativeReadback(); mutate(reply)
    let count=0
    await assert.rejects(transport().projectSuiteCrmSharedEmail(job().payload,async()=>{count++; return reply}),/held/)
    assert.equal(count,1,'Never retry or fall back inside the native dispatch')
  }
})

function persistence(state = {}, databaseClient) {
  const script=ts.createSourceFile('crm.ts',read('app_src/lib/persistence/crm.ts'),ts.ScriptTarget.Latest,true)
  const wanted=['activeCrmRecordSql','sharedSuiteCrmEmailScopeWithClient','sameSharedSuiteCrmEmailLinks',
    'withVerifiedSuiteCrmEmailPublication','verifySharedSuiteCrmEmailDispatch','reviewedEmailAudienceModeUnderControlWithClient','reviewedEmailAudienceWithClient',
    'completeSuiteCrmOutboxInPostgres','lockNativeEmailPublicationModeWithClient','nativeEmailOutboxTouchesEmail','nativeEmailOutboxUnresolvedGuardSql','tableForAggregate']
  const declarations=wanted.map(name=>{
    const fn=script.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text===name&&statement.body)
    assert.ok(fn,name); return fn.getText(script)
  }).join('\n')
  const exports={},queries=[]
  const client=databaseClient || {async query(sql,args=[]){
    queries.push({sql,args})
    if(sql==='SELECT enabled FROM crm_native_email_publication_control WHERE singleton') return {rows:[{enabled:state.mode==='native'}]}
    if(sql.includes('SELECT 1 FROM crm_native_email_publication_control')) return {rows:state.mode==='busy'?[]:[{}]}
    if(sql.includes('SELECT enabled, active_operation_id')) return {rows:[{enabled:state.mode==='native',active_operation_id:null,active_transition_id:null}]}
    if(sql.includes('p.id=$1::uuid AND w.id=$2::uuid')) return {rows:state.badWorkspace?[]:[{}]}
    if(sql.includes('pg_advisory_xact_lock')||sql.includes('set_config(')) return {rows:[]}
    if(sql.includes('WITH selected AS MATERIALIZED')) return {rows:state.badLease?[]:[{
      source_hash:state.staleRevision?'0'.repeat(64):sourceRevision,primary_id:state.wrongPrimary?'supplier':'customer',
      accounts,contacts:state.staleLinks?contactAccounts.slice(1):contactAccounts,
    }]}
    if(sql.includes('SELECT source_hash FROM crm_interactions')) return {rows:[{source_hash:state.staleRevision?'0'.repeat(64):sourceRevision}]}
    if(sql.includes("UPDATE sync_outbox SET status = 'succeeded'")) return {rows:state.badLease?[]:[{aggregate_type:'crm_interactions',aggregate_id:localId}]}
    if(sql.includes('UPDATE crm_interactions')||sql.includes('UPDATE pipeline_spaces')) return {rows:[]}
    assert.fail(`unexpected App query ${sql}`)
  }}
  vm.runInNewContext(compile(`${declarations}\nexports.mode=reviewedEmailAudienceModeUnderControlWithClient;exports.audience=reviewedEmailAudienceWithClient;`),{
    exports,process:{env},sharedSuiteCrmEmailScope:transport().sharedSuiteCrmEmailScope,
    withTransaction:async callback=>{
      if(!databaseClient) return callback(client)
      await client.query('BEGIN')
      try { const value=await callback(client); await client.query('COMMIT'); return value }
      catch(error) { await client.query('ROLLBACK'); throw error }
    },crmSourceHash:value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    ENTITY_TABLE:{interactions:'crm_interactions'}, legacyReviewedEmailAudienceWithClient:()=>assert.fail('must not query legacy readers'),
  })
  return {exports,queries,client}
}

test('shared App admission uses the current workspace and control first; stale job or links never reach native', async () => {
  const h=persistence()
  const mode=await h.exports.mode(h.client,pipelineId)
  assert.equal(mode,'shared')
  assert.deepEqual(copy(await h.exports.audience(h.client,pipelineId,mode)),{policy:'suitecrm-shared-login',workspaceId,pipelineId})
  h.queries.length=0
  const item=job()
  let writes=0
  await h.exports.withVerifiedSuiteCrmEmailPublication(item,async()=>{writes++})
  assert.equal(writes,1)
  assert.match(h.queries[0].sql,/active_initial_enrollment_id IS NULL FOR SHARE/)
  const dispatch=h.queries.at(-1)
  assert.equal(dispatch.args[3],item.lockToken)
  assert.equal(dispatch.args[6],suiteCrmId)
  assert.equal(dispatch.args[7],globalId)
  for(const state of [{mode:'busy'},{badWorkspace:true},{badLease:true},{staleRevision:true},{staleLinks:true},{wrongPrimary:true}]) {
    await assert.rejects(persistence(state).exports.withVerifiedSuiteCrmEmailPublication(item,()=>assert.fail('must not publish stale App state')),
      /not idle|binding changed|lease or revision changed/)
  }
})

test('completion preserves the provider receipt only for the current revision and exact outbox lease', async () => {
  const item=job()
  const proof=await transport().projectSuiteCrmSharedEmail(item.payload,async()=>nativeReadback())
  const h=persistence()
  await h.exports.completeSuiteCrmOutboxInPostgres(item,{emailProjection:proof})
  assert.ok(h.queries.some(query=>query.sql.includes("jsonb_build_object('suiteCrmEmailProjection'")))
  assert.equal(h.queries.find(query=>query.sql.includes("UPDATE sync_outbox SET status = 'succeeded'")).args[2],true)
  const stale=persistence({staleRevision:true})
  await stale.exports.completeSuiteCrmOutboxInPostgres(item,{emailProjection:proof})
  assert.ok(stale.queries.every(query=>!query.sql.includes('UPDATE crm_interactions')))
  await assert.rejects(persistence({badLease:true}).exports.completeSuiteCrmOutboxInPostgres(item,{emailProjection:proof}),/lease/)
  await assert.rejects(persistence().exports.completeSuiteCrmOutboxInPostgres(item,{emailProjection:{...proof,contacts:[]}}),/proof is missing or changed/)
})

const pgBin=process.env.CLAWPILOT_TEST_LOCAL_PG_BIN
test('shared App dispatch and completion execute against an isolated PostgreSQL database', {skip:!pgBin}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'cp-shared-worker-pg.')), data=join(dir,'data')
  const run=(binary,...args)=>execFileSync(join(pgBin,binary),args,{stdio:['ignore','pipe','pipe']})
  const {Client}=createRequire(new URL('../app_src/package.json',import.meta.url))('pg')
  let client, started=false
  try {
    run('initdb','-D',data,'--no-locale','--encoding=UTF8','--auth=trust')
    run('pg_ctl','-D',data,'-l',join(dir,'postgres.log'),'-o',`-h '' -k ${dir} -p 55432`,'-w','start'); started=true
    client=new Client({host:dir,port:55432,database:'postgres',user:process.env.USER})
    await client.connect()
    await client.query(`CREATE TABLE crm_native_email_publication_control (singleton bool,enabled bool,active_operation_id text,
        active_transition_id text,active_initial_enrollment_id text);
      INSERT INTO crm_native_email_publication_control VALUES (true,false,null,null,null);
      CREATE TABLE workspace_organizations (id uuid PRIMARY KEY,is_demo bool);
      CREATE TABLE pipeline_spaces (id uuid PRIMARY KEY,workspace_organization_id uuid,reference_access_disabled bool,crm_last_synced_at timestamptz,updated_at timestamptz);
      CREATE TABLE crm_interactions (id uuid PRIMARY KEY,pipeline_id uuid,source_hash text,organization_id uuid,suitecrm_id text,reference_code text,
        suitecrm_module text,source_payload jsonb,metadata jsonb,sync_status text,sync_error text,suitecrm_synced_at timestamptz,updated_at timestamptz);
      CREATE TABLE crm_interaction_organizations (pipeline_id uuid,interaction_id uuid,organization_id uuid);
      CREATE TABLE crm_interaction_contacts (pipeline_id uuid,interaction_id uuid,contact_id uuid);
      CREATE TABLE crm_organizations (id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,source_payload jsonb);
      CREATE TABLE crm_contacts (id uuid PRIMARY KEY,pipeline_id uuid,organization_id uuid,suitecrm_id text,source_payload jsonb);
      CREATE TABLE sync_outbox (id uuid PRIMARY KEY,aggregate_id text,aggregate_type text,target_system text,operation text,status text,
        lock_token text,payload jsonb,idempotency_key text,available_at timestamptz,processed_at timestamptz,last_error text,locked_at timestamptz,updated_at timestamptz);
      CREATE TABLE crm_native_email_publication_work (operation_id text,work_kind text,context jsonb);
      CREATE TABLE crm_native_email_publication_admissions (operation_id text,state text);`)
    const localOrgIds=['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555']
    const localContactIds=['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777']
    const item=job()
    await client.query('INSERT INTO workspace_organizations VALUES ($1,false)',[workspaceId])
    await client.query('INSERT INTO pipeline_spaces (id,workspace_organization_id,reference_access_disabled) VALUES ($1,$2,false)',[pipelineId,workspaceId])
    await client.query(`INSERT INTO crm_interactions (id,pipeline_id,source_hash,organization_id,suitecrm_id,reference_code,suitecrm_module,source_payload,metadata,sync_status)
      VALUES ($1,$2,$3,$4,$5,$6,'Emails','{}','{}','syncing')`,[localId,pipelineId,sourceRevision,localOrgIds[0],suiteCrmId,globalId])
    for(let i=0;i<accounts.length;i++) {
      await client.query("INSERT INTO crm_organizations VALUES ($1,$2,$3,'{}')",[localOrgIds[i],pipelineId,accounts[i]])
      await client.query("INSERT INTO crm_contacts VALUES ($1,$2,$3,$4,'{}')",[localContactIds[i],pipelineId,localOrgIds[i],contacts[i]])
      await client.query('INSERT INTO crm_interaction_organizations VALUES ($1,$2,$3)',[pipelineId,localId,localOrgIds[i]])
      await client.query('INSERT INTO crm_interaction_contacts VALUES ($1,$2,$3)',[pipelineId,localId,localContactIds[i]])
    }
    await client.query(`INSERT INTO sync_outbox (id,aggregate_id,aggregate_type,target_system,operation,status,lock_token,payload,idempotency_key,available_at)
      VALUES ($1,$2,'crm_interactions','suitecrm','upsert_record','processing',$3,$4,$5,now())`,[item.id,localId,item.lockToken,item.payload,item.idempotencyKey])
    const h=persistence({},client)
    const published=()=>transport().projectSuiteCrmSharedEmail(item.payload,async()=>nativeReadback())
    const proof=await h.exports.withVerifiedSuiteCrmEmailPublication(item,published)
    await client.query('UPDATE crm_contacts SET organization_id=$1 WHERE id=$2',[localOrgIds[0],localContactIds[1]])
    await assert.rejects(h.exports.withVerifiedSuiteCrmEmailPublication(item,()=>assert.fail('wrong company must not publish')),/relationships/)
    await client.query('UPDATE crm_contacts SET organization_id=$1 WHERE id=$2',[localOrgIds[1],localContactIds[1]])
    await h.exports.completeSuiteCrmOutboxInPostgres(item,{emailProjection:proof})
    const {rows:[saved]}=await client.query(`SELECT j.status,i.sync_status,i.metadata->'suiteCrmEmailProjection' AS receipt
      FROM sync_outbox j JOIN crm_interactions i ON i.id::text=j.aggregate_id WHERE j.id=$1`,[item.id])
    assert.equal(saved.status,'succeeded')
    assert.equal(saved.sync_status,'synced')
    assert.deepEqual(saved.receipt,copy(proof))
    await assert.rejects(h.exports.withVerifiedSuiteCrmEmailPublication(item,()=>assert.fail('settled job is not a new write')),/lease/)
  } finally {
    await client?.end()
    if(started) run('pg_ctl','-D',data,'-m','immediate','-w','stop')
    rmSync(dir,{recursive:true,force:true})
  }
})
