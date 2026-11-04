#!/usr/bin/env node
// Default: pure/fake-SQL checks. --postgres: one guarded disposable database.
// No live database/native/provider credentials or production authorization.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { disposablePostgresDockerArgs, disposablePostgresDockerCleanupArgs } from './lib/disposable-postgres-docker.mjs'
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const args=process.argv.slice(2)
assert.ok(args.length===0 || args.length===1 && args[0]==='--postgres','Use no arguments or --postgres')
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
const protocol = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
const work = load('app_src/lib/crm/nativeEmailPublicationWorkContext.ts', { './nativeEmailPublication': protocol })
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = char => char.repeat(64)
function request(mode = 'publish') {
  return protocol.prepareNativeEmailPublication({ command: { version:1,operationId:hash('a'),mode,
    workspaceId:id(1),pipelineId:id(2),generation:1,audienceFingerprint:hash('b'),suiteCrmId:id(3),
    globalId:'gi1234567',localId:id(4),expectedRecordFingerprint:mode==='repair'?hash('c'):null,
    projection:mode==='repair'?null:{attributes:{name:'Synthetic only'}} },
  nativePolicyFingerprint:hash('d'),allowedReaderSuiteCrmUserIds:['admin'] })
}
function context(mode = 'publish') {
  return mode==='repair'?{kind:'repair',manifestHash:hash('e'),itemId:'reviewed-item-1'}:
    {kind:'outbox',outboxId:id(5),idempotencyKey:`crm:interactions:v4:${id(4)}:Emails:${hash('f')}`,
      sourceHash:hash('f'),payloadHash:hash('e'),attempt:1}
}
const held = code => error => error?.name==='NativeEmailPublicationHeld' && (!code||error.code===code)
const clone = value => JSON.parse(JSON.stringify(value))
const checks = []
async function check(name, callback) { await callback(); checks.push(name); console.log(`PASS ${name}`) }
class FakeTx {
  queries=[]; state='unknown'; active=true; enabled=true; live=true; row=null
  constructor(req=request(),ctx=context()) {
    this.req=req
    this.row={operation_id:req.command.operationId,request_fingerprint:req.requestFingerprint,
      work_kind:ctx.kind,context:clone(ctx),context_hash:protocol.nativeEmailDigest(ctx),
      lease_owner:id(7),lease_fence:'1',lease_until:'2026-10-30T18:00:00Z'}
  }
  async query(sql, values=[]) {
    this.queries.push({sql,values})
    if (sql.startsWith('SELECT * FROM crm_native_email_publication_control')) return {rows:[{
      enabled:this.enabled,generation:1,verified_generation:1,native_policy_fingerprint:this.req.nativePolicyFingerprint,
      activation_receipt_hash:hash('c'),active_operation_id:this.active?this.req.command.operationId:null,
    }]}
    if (sql.startsWith('SELECT request_fingerprint,state')) return {rows:[{request_fingerprint:this.req.requestFingerprint,state:this.state}]}
    if (sql.startsWith('SELECT *,lease_until')) return {rows:this.row?[{...this.row,lease_live:this.live}]:[]}
    if (sql.startsWith('INSERT INTO crm_native_email_publication_work')) {
      assert.equal(values.length,7)
      this.row={operation_id:values[0],request_fingerprint:values[1],work_kind:values[2],context:JSON.parse(values[3]),
        context_hash:values[4],lease_owner:values[5],lease_fence:1,lease_until:'2026-10-30T18:00:00Z'}
      return {rows:[this.row]}
    }
    if (sql.startsWith('UPDATE crm_native_email_publication_work')) {
      assert.equal(values[0],this.row.operation_id);assert.equal(values[3],Number(this.row.lease_fence))
      this.row={...this.row,lease_owner:values[1],lease_fence:Number(this.row.lease_fence)+1}
      return {rows:[this.row]}
    }
    assert.fail(`Unexpected SQL; this helper cannot change admission/control/outbox: ${sql}`)
  }
}
const authorize=async()=>{}
await check('outbox and repair contexts bind exact mode/source identity and return immutable clones',()=>{
  for(const mode of ['publish','repair']) {
    const value=context(mode),result=work.prepareNativeEmailWorkContext(request(mode),value)
    assert.deepEqual(result,value);value.kind='changed';assert.notEqual(result.kind,'changed')
  }
  assert.throws(()=>work.prepareNativeEmailWorkContext(request(),context('repair')),held('invalid_repair_work_context'))
  assert.throws(()=>work.prepareNativeEmailWorkContext(request('repair'),context()),held('invalid_outbox_work_context'))
})
await check('context validation refuses unknown fields coercions trailing characters and foreign revision keys',()=>{
  for(const mutate of [x=>x.extra=true,x=>x.outboxId=[id(5)],x=>x.sourceHash+='\n',x=>x.payloadHash=true,
    x=>x.attempt=0,x=>x.attempt=21,x=>x.attempt=1.5,x=>x.idempotencyKey=`crm:interactions:v4:${id(6)}:Emails:${hash('f')}`]) {
    const value=context();mutate(value);assert.throws(()=>work.prepareNativeEmailWorkContext(request(),value),held())
  }
  for(const mutate of [x=>x.manifestHash+='\n',x=>x.itemId='../all',x=>x.itemId='x'.repeat(129),x=>x.itemId=['item'],x=>x.approved=true]) {
    const value=context('repair');mutate(value);assert.throws(()=>work.prepareNativeEmailWorkContext(request('repair'),value),held())
  }
  const req=request();req.requestFingerprint=hash('e')
  assert.throws(()=>work.prepareNativeEmailWorkContext(req,context()),held('work_request_fingerprint_changed'))
})
await check('registration authorizes inside supplied transaction before inserting exact deferred-FK context',async()=>{
  const tx=new FakeTx();tx.active=false;let calls=0
  const lease=await work.registerNativeEmailPublicationWork(tx,request(),context(),id(7),async(given,req,ctx,action,owner)=>{
    assert.equal(given,tx);assert.equal(req.requestFingerprint,request().requestFingerprint);assert.deepEqual(ctx,context())
    assert.equal(action,'register');assert.equal(owner,id(7));assert.equal(tx.queries.length,1);calls++
  })
  assert.equal(calls,1);assert.equal(lease.fence,1);assert.equal(lease.owner,id(7));assert.deepEqual(lease.context,context())
  assert.match(tx.queries[1].sql,/clock_timestamp\(\)/);assert.equal(tx.queries[1].values[6],120)
})
await check('registration cannot omit authorization activate disabled mode or write after authorization failure',async()=>{
  const noAuth=new FakeTx();noAuth.active=false
  await assert.rejects(()=>work.registerNativeEmailPublicationWork(noAuth,request(),context(),id(7),null),held('work_authorizer_required'))
  assert.equal(noAuth.queries.length,0)
  const disabled=new FakeTx();disabled.active=false;disabled.enabled=false
  await assert.rejects(()=>work.registerNativeEmailPublicationWork(disabled,request(),context(),id(7),authorize),held('work_control_not_active'))
  const denied=new FakeTx();denied.active=false
  await assert.rejects(()=>work.registerNativeEmailPublicationWork(denied,request(),context(),id(7),async()=>{throw Error('not authorized')}),/not authorized/)
  assert.equal(denied.queries.length,1)
  for(const seconds of [0,59,301,Infinity,'120']) {
    const tx=new FakeTx();tx.active=false
    await assert.rejects(()=>work.registerNativeEmailPublicationWork(tx,request(),context(),id(7),authorize,seconds),held('invalid_work_lease_duration'))
    assert.equal(tx.queries.length,0)
  }
})
await check('live leases cannot be stolen and same-owner retries do not extend expiry',async()=>{
  const tx=new FakeTx()
  await assert.rejects(()=>work.claimNativeEmailPublicationResolution(tx,request(),id(8),authorize),held('work_lease_busy'))
  const lease=await work.claimNativeEmailPublicationResolution(tx,request(),id(7),authorize)
  assert.equal(lease.fence,1);assert.equal(lease.expiresAt,'2026-10-30T18:00:00Z')
  assert.ok(tx.queries.every(q=>q.sql.startsWith('SELECT')))
})
await check('expired lease reassigns only after authorization with a monotonic fencing token and immutable context',async()=>{
  const tx=new FakeTx();tx.live=false;let authorized=0
  const before=clone(tx.row.context)
  const lease=await work.claimNativeEmailPublicationResolution(tx,request(),id(8),async(given,req,ctx,action)=>{
    assert.equal(given,tx);assert.equal(action,'resolve');assert.deepEqual(ctx,before);assert.equal(tx.queries.length,3);authorized++
  })
  assert.equal(authorized,1);assert.equal(lease.owner,id(8));assert.equal(lease.fence,2);assert.deepEqual(lease.context,before)
  assert.match(tx.queries[0].sql,/control.*FOR UPDATE/);assert.match(tx.queries[1].sql,/admissions.*FOR UPDATE/)
  assert.match(tx.queries[2].sql,/work .*FOR UPDATE/);assert.match(tx.queries[3].sql,/lease_fence=lease_fence\+1/)
  assert.equal(tx.state,'unknown');assert.equal(tx.active,true)
})
await check('resolver refuses terminal admissions missing context tampered identity and fence exhaustion',async()=>{
  const terminal=new FakeTx();terminal.state='committed'
  await assert.rejects(()=>work.claimNativeEmailPublicationResolution(terminal,request(),id(8),authorize),held('work_admission_not_unresolved'))
  const missing=new FakeTx();missing.row=null
  await assert.rejects(()=>work.claimNativeEmailPublicationResolution(missing,request(),id(8),authorize),held('work_context_missing'))
  const changed=new FakeTx();changed.row.context.payloadHash=hash('c')
  await assert.rejects(()=>work.claimNativeEmailPublicationResolution(changed,request(),id(8),authorize),held('stored_work_context_changed'))
  const exhausted=new FakeTx();exhausted.live=false;exhausted.row.lease_fence=String(Number.MAX_SAFE_INTEGER)
  await assert.rejects(()=>work.claimNativeEmailPublicationResolution(exhausted,request(),id(8),authorize),held('work_lease_fence_exhausted'))
})
await check('settlement requires exact live owner fence and immutable context without updating any state',async()=>{
  const tx=new FakeTx(),lease=await work.claimNativeEmailPublicationResolution(tx,request(),id(7),authorize)
  assert.deepEqual(await work.assertNativeEmailPublicationWorkLease(tx,request(),lease),context())
  for(const mutate of [x=>x.owner=id(8),x=>x.fence=2,x=>x.operationId=hash('e'),x=>x.context.payloadHash=hash('c')]) {
    const wrong=clone(lease);mutate(wrong)
    await assert.rejects(()=>work.assertNativeEmailPublicationWorkLease(tx,request(),wrong),held())
  }
  tx.live=false
  await assert.rejects(()=>work.assertNativeEmailPublicationWorkLease(tx,request(),lease),held('work_lease_not_owned'))
  assert.ok(tx.queries.every(q=>q.sql.startsWith('SELECT')))
})
await check('migration contains deferred binding immutable evidence bounded leases and no timeout-unlock operation',()=>{
  const sql=readFileSync(new URL('../db/migrations/0376_crm_native_email_publication_work_context.sql',import.meta.url),'utf8')
  assert.match(sql,/ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED/)
  assert.match(sql,/CREATE CONSTRAINT TRIGGER[\s\S]*DEFERRABLE INITIALLY DEFERRED/)
  assert.match(sql,/Native Email work evidence cannot be removed/)
  assert.match(sql,/NEW\.lease_fence<>OLD\.lease_fence\+1/)
  assert.match(sql,/clock_timestamp\(\)\+interval '301 seconds'/)
  assert.doesNotMatch(sql,/UPDATE\s+(?:public\.)?crm_native_email_publication_(?:control|admissions)/i)
  assert.doesNotMatch(sql,/UPDATE\s+(?:public\.)?sync_outbox/i)
})
if(!args.length) {
  console.log(`PASS ${checks.length} pure/fake-SQL checks only; no PostgreSQL, race, native, production or deployment proof`)
  process.exit(0)
}

const { PostgresNativeEmailPublicationStore }=load('app_src/lib/crm/nativeEmailPublicationPostgres.ts',{'./nativeEmailPublication':protocol})
const migration375=readFileSync(new URL('../db/migrations/0375_crm_native_email_publication_admission.sql',import.meta.url),'utf8')
const migration376=readFileSync(new URL('../db/migrations/0376_crm_native_email_publication_work_context.sql',import.meta.url),'utf8')
const { Pool }=require('pg')
const container=`clawpilot-native-work-context-${process.pid}-${crypto.randomUUID().slice(0,8)}`
const image=process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16'
assert.match(image,/^pgvector\/pgvector:pg(?:16|18)$/u,'Use an already cached approved image')
let pool,started=false
try {
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=native_work_fixture','-e','POSTGRES_DB=native_work_fixture','-p','127.0.0.1::5432',image]),
  {timeout:60000,stdio:'pipe'});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port)
  pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'native_work_fixture',database:'native_work_fixture',
    ssl:false,max:3,connectionTimeoutMillis:1000,statement_timeout:5000})
  const readyDeadline=Date.now()+30000
  while(true) {try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>=readyDeadline)throw error;await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count,'0')
  const query=(sql,values)=>pool.query(sql,values)
  const transaction=async callback=>{
    const tx=await pool.connect()
    try{await tx.query('BEGIN');const result=await callback(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  await query(`CREATE TABLE app_users(email text PRIMARY KEY,status text,suitecrm_user_id text,role text,permissions jsonb,organization_id uuid);
    CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,owner_email text,workspace_organization_id uuid,reference_access_disabled boolean DEFAULT false);
    CREATE TABLE pipeline_space_members(pipeline_id uuid,user_email text,access_role text,PRIMARY KEY(pipeline_id,user_email));
    CREATE TABLE app_user_organization_memberships(user_email text,organization_id uuid,status text,role text,permissions jsonb,trashed_at timestamptz,PRIMARY KEY(user_email,organization_id));
    CREATE TABLE synthetic_finalizations(operation_id text PRIMARY KEY,state text);
    INSERT INTO pipeline_spaces VALUES('${id(2)}','owner@example.test','${id(1)}',false);`)
  await transaction(tx=>tx.query(migration375))
  await transaction(tx=>tx.query(migration376))
  const store=new PostgresNativeEmailPublicationStore(transaction)
  const req=request(),ctx=context()
  const admissionInput=({command,nativePolicyFingerprint,allowedReaderSuiteCrmUserIds})=>({command,nativePolicyFingerprint,allowedReaderSuiteCrmUserIds})
  const control=async()=>(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  const workRow=async()=>(await query('SELECT * FROM crm_native_email_publication_work WHERE operation_id=$1',[req.command.operationId])).rows[0]
  const emptyEvidence=async()=>{
    assert.equal((await query('SELECT count(*) AS n FROM crm_native_email_publication_work')).rows[0].n,'0')
    assert.equal((await query('SELECT count(*) AS n FROM crm_native_email_publication_admissions')).rows[0].n,'0')
    assert.equal((await control()).active_operation_id,null)
  }
  // Explicitly synthetic callback: checks invocation/context only. Application
  // source/actor/manifest authorization remains an integration acceptance gate.
  const fixtureAuthorize=async(tx,r,c,action,owner)=>{
    assert.ok(tx && typeof tx.query==='function');assert.equal(r.requestFingerprint,req.requestFingerprint)
    assert.deepEqual(c,ctx);assert.ok(['register','resolve'].includes(action));assert.ok([id(7),id(8),id(9)].includes(owner))
  }
  await check('real work migrations remain disabled and registration cannot activate publication',async()=>{
    assert.equal((await control()).enabled,false)
    await assert.rejects(()=>transaction(tx=>work.registerNativeEmailPublicationWork(tx,req,ctx,id(7),fixtureAuthorize)),held('work_control_not_active'))
    await emptyEvidence()
    // Disposable fixture activation only, never an actual operator approval.
    await query('UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2',
      [req.nativePolicyFingerprint,hash('e')])
  })
  await check('real deferred FK and binding reject orphan or wrong-request work and roll back registration failures',async()=>{
    await assert.rejects(()=>transaction(tx=>work.registerNativeEmailPublicationWork(tx,req,ctx,id(7),fixtureAuthorize)),
      error=>['23503','55000'].includes(error.code))
    await emptyEvidence()
    await assert.rejects(()=>store.admit(admissionInput(req),async(tx,r)=>{
      await work.registerNativeEmailPublicationWork(tx,r,ctx,id(7),fixtureAuthorize)
      throw Error('after work registration failure')
    }),/after work registration failure/)
    await emptyEvidence()
    // Direct synthetic insert specifically exercises commit-time request binding.
    await assert.rejects(()=>store.admit(admissionInput(req),async tx=>{
      await tx.query(`INSERT INTO crm_native_email_publication_work
        (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
        VALUES($1,$2,'outbox',$3::jsonb,$4,$5::uuid,1,clock_timestamp()+interval '60 seconds')`,
      [req.command.operationId,hash('e'),JSON.stringify(ctx),protocol.nativeEmailDigest(ctx),id(7)])
    }),error=>error.code==='55000')
    await emptyEvidence()
  })
  let initialLease
  await check('real registration commits with admission and exact immutable outbox context in one transaction',async()=>{
    const admission=await store.admit(admissionInput(req),async(tx,r)=>{
      initialLease=await work.registerNativeEmailPublicationWork(tx,r,ctx,id(7),fixtureAuthorize,60)
      assert.equal((await tx.query('SELECT count(*) AS n FROM crm_native_email_publication_admissions')).rows[0].n,'0')
      assert.equal((await tx.query('SELECT count(*) AS n FROM crm_native_email_publication_work')).rows[0].n,'1')
    })
    assert.equal(admission.state,'admitted');assert.equal(initialLease.fence,1)
    assert.equal((await control()).active_operation_id,req.command.operationId)
    const row=await workRow();assert.deepEqual(row.context,ctx);assert.equal(row.context_hash,protocol.nativeEmailDigest(ctx))
    await store.markDispatched(req.command.operationId);await store.markUnknown(req.command.operationId)
  })
  await check('real SQL guards refuse live takeover evidence changes deletes truncates and invalid inserted contexts',async()=>{
    const unchanged=await workRow()
    for(const sql of [
      "UPDATE crm_native_email_publication_work SET context_hash=repeat('f',64)",
      'UPDATE crm_native_email_publication_work SET lease_fence=lease_fence+1,lease_until=clock_timestamp()+interval \'60 seconds\'',
      'DELETE FROM crm_native_email_publication_work','TRUNCATE crm_native_email_publication_work',
    ])await assert.rejects(()=>query(sql),error=>error.code==='55000')
    const badContexts=[{...ctx,extra:true},{...ctx,kind:'repair'},{...ctx,attempt:0},{...ctx,attempt:1.5},
      {...ctx,payloadHash:null},{...ctx,outboxId:'not-uuid'},{...ctx,idempotencyKey:[]},
      {kind:'repair',manifestHash:hash('e'),itemId:'../all'}]
    for(const bad of badContexts)await assert.rejects(()=>transaction(tx=>tx.query(`INSERT INTO crm_native_email_publication_work
      (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
      VALUES($1,$2,$3,$4::jsonb,$5,$6::uuid,1,clock_timestamp()+interval '60 seconds')`,
    [hash('b'),req.requestFingerprint,bad.kind,JSON.stringify(bad),hash('c'),id(7)])),error=>error.code==='23514')
    for(const [fence,until,code] of [[2,"clock_timestamp()+interval '60 seconds'",'55000'],
      [1,"clock_timestamp()+interval '5 seconds'",'55000'],[1,"clock_timestamp()+interval '500 seconds'",'55000'],
      [1,"'infinity'::timestamptz",'55000']]) {
      await assert.rejects(()=>transaction(tx=>tx.query(`INSERT INTO crm_native_email_publication_work
        (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
        VALUES($1,$2,'outbox',$3::jsonb,$4,$5::uuid,$6,${until})`,
      [hash('b'),req.requestFingerprint,JSON.stringify(ctx),protocol.nativeEmailDigest(ctx),id(7),fence])),error=>error.code===code)
    }
    assert.deepEqual(await workRow(),unchanged)
  })
  await check('real live lease conflict and control-row serialization prevent a second owner',async()=>{
    await assert.rejects(()=>transaction(tx=>work.claimNativeEmailPublicationResolution(tx,req,id(8),fixtureAuthorize)),held('work_lease_busy'))
    const same=await transaction(tx=>work.claimNativeEmailPublicationResolution(tx,req,id(7),fixtureAuthorize))
    assert.equal(same.fence,1);assert.equal(same.expiresAt,initialLease.expiresAt)
    const a=await pool.connect(),b=await pool.connect()
    try {
      await a.query('BEGIN');await a.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
      await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='150ms'")
      await assert.rejects(()=>work.claimNativeEmailPublicationResolution(b,req,id(8),fixtureAuthorize),error=>error.code==='55P03')
    } finally{await b.query('ROLLBACK');await a.query('ROLLBACK');a.release();b.release()}
    assert.equal((await workRow()).lease_owner,id(7));assert.equal((await store.get(req.command.operationId)).state,'unknown')
  })
  let resolverLease
  await check('real expiry leaves admission held and concurrent authorized takeover produces one fenced owner',async()=>{
    console.log('Waiting for the real 60-second database lease to expire; no guard or clock override.')
    const deadline=Date.now()+65000
    while((await query('SELECT lease_until>clock_timestamp() AS live FROM crm_native_email_publication_work WHERE operation_id=$1',[req.command.operationId])).rows[0].live) {
      assert.ok(Date.now()<deadline,'Database lease must expire within its bounded duration')
      await new Promise(r=>setTimeout(r,500))
    }
    assert.equal((await control()).active_operation_id,req.command.operationId)
    assert.equal((await store.get(req.command.operationId)).state,'unknown')
    const before=await workRow()
    await assert.rejects(()=>transaction(tx=>work.claimNativeEmailPublicationResolution(tx,req,id(8),async()=>{throw Error('resolver not authorized')})),/resolver not authorized/)
    assert.deepEqual(await workRow(),before)
    // Immutable evidence still holds when expiry no longer masks that branch.
    await assert.rejects(()=>query(`UPDATE crm_native_email_publication_work SET context_hash=repeat('f',64),
      lease_fence=lease_fence+1,lease_until=clock_timestamp()+interval '60 seconds'`),error=>error.code==='55000')
    const outcomes=await Promise.allSettled([id(8),id(9)].map(owner=>transaction(tx=>work.claimNativeEmailPublicationResolution(tx,req,owner,fixtureAuthorize))))
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1)
    assert.ok(outcomes.filter(o=>o.status==='rejected').every(o=>held('work_lease_busy')(o.reason)))
    resolverLease=outcomes.find(o=>o.status==='fulfilled').value
    assert.equal(resolverLease.fence,2);assert.deepEqual(resolverLease.context,ctx)
    assert.equal((await control()).active_operation_id,req.command.operationId)
    await assert.rejects(()=>transaction(tx=>work.assertNativeEmailPublicationWorkLease(tx,req,initialLease)),held('work_lease_not_owned'))
  })
  const cancelled={version:1,operationId:req.command.operationId,commandHash:req.commandHash,state:'cancelled',replayed:false,result:null}
  await check('real failed finalization rolls back local evidence and retains admission and current resolver ownership',async()=>{
    await assert.rejects(()=>store.settle(req.command.operationId,cancelled,async(tx,r)=>{
      await work.assertNativeEmailPublicationWorkLease(tx,r,resolverLease)
      await tx.query('INSERT INTO synthetic_finalizations VALUES($1,$2)',[r.command.operationId,'must-rollback'])
      throw Error('finalization failed')
    }),/finalization failed/)
    assert.equal((await query('SELECT count(*) AS n FROM synthetic_finalizations')).rows[0].n,'0')
    assert.equal((await store.get(req.command.operationId)).state,'unknown')
    assert.equal((await control()).active_operation_id,req.command.operationId)
    assert.equal((await workRow()).lease_owner,resolverLease.owner)
  })
  await check('real terminal settlement is atomic prevents later resolver claims and retains immutable work evidence',async()=>{
    await store.settle(req.command.operationId,cancelled,async(tx,r)=>{
      assert.deepEqual(await work.assertNativeEmailPublicationWorkLease(tx,r,resolverLease),ctx)
      await tx.query('INSERT INTO synthetic_finalizations VALUES($1,$2)',[r.command.operationId,'cancelled'])
    })
    assert.equal((await control()).active_operation_id,null)
    assert.equal((await store.get(req.command.operationId)).state,'cancelled')
    assert.equal((await query('SELECT count(*) AS n FROM synthetic_finalizations')).rows[0].n,'1')
    await assert.rejects(()=>transaction(tx=>work.claimNativeEmailPublicationResolution(tx,req,id(8),fixtureAuthorize)),held('work_control_not_active'))
    await assert.rejects(()=>transaction(tx=>work.assertNativeEmailPublicationWorkLease(tx,req,resolverLease)),held('work_control_not_active'))
    await store.settle(req.command.operationId,{...cancelled,replayed:true},async()=>{throw Error('must not repeat')})
    assert.deepEqual((await workRow()).context,ctx)
  })
  await check('real repair work stores a separate exact reviewed manifest identity without inventing approval',async()=>{
    const repairReq=request('repair');repairReq.command.operationId=hash('c')
    const prepared=protocol.prepareNativeEmailPublication(admissionInput(repairReq)),repairCtx=context('repair')
    let repairLease
    await store.admit(admissionInput(prepared),async(tx,r)=>{
      repairLease=await work.registerNativeEmailPublicationWork(tx,r,repairCtx,id(7),async(given,asked,stored,action)=>{
        assert.equal(given,tx);assert.equal(asked.requestFingerprint,prepared.requestFingerprint)
        assert.deepEqual(stored,repairCtx);assert.equal(action,'register')
      })
    })
    const r=(await query('SELECT * FROM crm_native_email_publication_work WHERE operation_id=$1',[prepared.command.operationId])).rows[0]
    assert.equal(r.work_kind,'repair');assert.deepEqual(r.context,repairCtx)
    await store.settle(prepared.command.operationId,{...cancelled,operationId:prepared.command.operationId,commandHash:prepared.commandHash},
      async(tx,current)=>{await work.assertNativeEmailPublicationWorkLease(tx,current,repairLease)})
  })
  console.log(`PASS ${checks.length} pure/fake-SQL + actual guarded PostgreSQL checks; callbacks are synthetic, not app authorization/native/deployment proof`)
} finally {
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{timeout:30000,stdio:'pipe'})}
}
