import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { observeBpoFailedEmailAppReadback } from './lib/bpo-failed-email-app-readback.mjs'
import { describeBpoFailedEmailRepairInventory, planBpoFailedEmailRepair } from './lib/bpo-failed-email-repair-plan.mjs'

const workspaceId = 'c6c49765-9bf6-4223-9261-7553499f5d92', pipelineId = '587c8746-ecf6-40ae-8c50-e456f99ad555'
const uuid = n => `9477544f-22f4-44db-81ba-${String(n).padStart(12,'0')}`
const sha = value => createHash('sha256').update(value).digest('hex')
const slots = Array.from({length:19},(_,i)=>({
  interactionId:uuid(i+1),jobId:uuid(i+30),nativeId:uuid(i+60),globalId:`gi${String(i+1).padStart(7,'0')}`,
  providerMessageId:i===18 ? null : `test-${i}`,
  interactionFingerprint:sha(`interaction-${i}`),jobFingerprint:sha(`job-${i}`),preimageFingerprint:sha(`preimage-${i}`),
  projectionFingerprint:sha(`independent synthetic expected projection ${i}`),
}))
const app = {originFingerprint:sha('app origin'),deploymentFingerprint:sha('observed release')}
const suiteCrm = {originFingerprint:sha('CRM origin'),deploymentFingerprint:sha('CRM release')}
const review = {workspaceId,pipelineId,app,suiteCrm,original11:slots.slice(0,11),later8:slots.slice(11)}
const sidecars = {emailText:0,emailCustom:0,relationships:0,addressLinks:0,reverseLinks:0,notes:0,folderLinks:0,securityGroupLinks:0,scopedGrants:0}
const nativeReadback = { ...suiteCrm,readOnly:true,rows:slots.map(({interactionId,nativeId,globalId})=>({
  interactionId,nativeId,globalId,coverage:'exact-id-collated-global-aliases-deleted-and-sidecars',byNativeId:[],byGlobalId:[],
  sidecars,receipt:{state:'absent',fingerprint:null,projectionFingerprint:null},
}))}
const providerBodyFixture = 'mail-body-that-must-not-be-returned'
function fixture() {
  const calls = [], rows = slots.map(({projectionFingerprint,...row})=>({...row,pipelineId,workspaceId,syncStatus:'failed',
    terminalLatestJob:true,unclaimed:true,uniqueIdentity:true}))
  const meta = {originFingerprint:app.originFingerprint,snapshotProtected:true}
  const client = new EventEmitter()
  client.query = async (sql,params) => {
    calls.push(sql)
    if (sql.includes('pg_control_system')) return {rows:[meta]}
    if (sql.startsWith('WITH slots')) {
      const expected = slots.map(({interactionId,jobId,nativeId,globalId,providerMessageId})=>({interactionId,jobId,nativeId,globalId,providerMessageId}))
      assert.deepEqual(params,[JSON.stringify(expected),workspaceId,pipelineId])
      return {rows}
    }
    return {rows:[]}
  }
  const args = {client,review,expectedInventoryFingerprint:describeBpoFailedEmailRepairInventory(review),
    observedDeploymentFingerprint:app.deploymentFingerprint}
  return {args,calls,meta,rows}
}

test('keeps exact read-only 11+8 snapshot and returns no raw payload or made-up projection hash',async()=>{
  const {args,calls,rows} = fixture()
  Object.assign(rows[0],{description:providerBodyFixture,payload:{body:providerBodyFixture},projectionFingerprint:sha('untrusted')})
  const appReadback = await observeBpoFailedEmailAppReadback(args)
  assert.ok(!JSON.stringify(appReadback).includes(providerBodyFixture))
  assert.equal(appReadback.rows[0].projectionFingerprint,slots[0].projectionFingerprint)
  assert.equal(appReadback.rows.length,19)
  assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(calls.at(-1),'ROLLBACK')
  assert.equal(calls.filter(sql=>sql.includes('pg_control_system')).length,2)
  assert.match(calls[4],/pg_catalog\.to_jsonb\(i\)::text/u)
  assert.match(calls[4],/pg_catalog\.to_jsonb\(j\)::text/u)
  assert.doesNotMatch(calls.join('\n'),/FOR UPDATE|FOR SHARE|\bCOMMIT\b/u)
  const plan = planBpoFailedEmailRepair({...args,appReadback,nativeReadback})
  assert.ok(plan.records.every(row=>row.disposition==='create-candidate-proven-absent'))
  assert.equal(plan.writeAuthorized,false)
})

test('rejects unpinned or unprotected sessions, and does not query target rows',async()=>{
  for (const [mutate,expected,rollsBack] of [
    [f=>{f.args.expectedInventoryFingerprint=sha('wrong')},/independent_inventory_pin/u,false],
    [f=>{f.args.observedDeploymentFingerprint=sha('wrong')},/deployment_pin/u,false],
    [f=>{f.meta.originFingerprint=sha('wrong')},/database_origin_pin/u,true],
    [f=>{f.meta.snapshotProtected=false},/read_only_snapshot_unproven/u,true],
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(observeBpoFailedEmailAppReadback(f.args),expected)
    assert.ok(!f.calls.some(sql=>sql.startsWith('WITH slots')))
    assert.equal(f.calls.at(-1)==='ROLLBACK',rollsBack)
  }
  const {args,calls}=fixture(), run=args.client.query
  args.client.query=(...query)=>{
    if (query[0].startsWith('BEGIN')) args.client.emit('notice',{code:'25001'})
    return run(...query)
  }
  await assert.rejects(observeBpoFailedEmailAppReadback(args),/exclusive_idle_client_required/u)
  assert.equal(calls.length,1)
})

test('holds body/job fingerprint, identity, latest job and claim drift independently; invalid readbacks are discarded',async()=>{
  const f = fixture()
  f.rows[0].interactionFingerprint=sha('body changed')
  f.rows[1].jobFingerprint=sha('job changed')
  f.rows[2].providerMessageId='different'
  f.rows[3].terminalLatestJob=false
  f.rows[4].unclaimed=false
  f.rows[5].uniqueIdentity=false
  const appReadback=await observeBpoFailedEmailAppReadback(f.args)
  const plan=planBpoFailedEmailRepair({...f.args,appReadback,nativeReadback})
  assert.deepEqual(plan.records.slice(0,6).map(row=>row.reason),Array(6).fill('app_preimage_or_job_changed'))
  assert.equal(plan.records.filter(row=>row.disposition==='hold').length,6)
  f.rows[0]=f.rows[1]
  await assert.rejects(observeBpoFailedEmailAppReadback(f.args),/readback_identity_set/u)
  assert.equal(f.calls.at(-1),'ROLLBACK')
  const g=fixture(), query=g.args.client.query
  g.args.client.query=(sql,params)=>sql==='ROLLBACK' ? Promise.reject(new Error(providerBodyFixture)) : query(sql,params)
  await assert.rejects(observeBpoFailedEmailAppReadback(g.args),error=>error.message.endsWith('snapshot_rollback_unproven')
    && !error.message.includes(providerBodyFixture))
})

// Optional native SQL proof: a fresh loopback-disabled local PostgreSQL cluster.
// Neither a DATABASE_URL nor a live connection can be passed to this fixture.
const pgBin=process.env.CLAWPILOT_TEST_LOCAL_PG_BIN, pgModule=process.env.CLAWPILOT_TEST_PG_MODULE
test('Postgres executes the query and holds exact body drift, newer jobs, claims, and aliases',{
  skip: !pgBin || !pgModule,
},async()=>{
  const {Client}=createRequire(import.meta.url)(pgModule)
  const dir=mkdtempSync('/tmp/clawpilot-bpo-readback-'), data=join(dir,'pg')
  const run=(program,...args)=>execFileSync(join(pgBin,program),args,{stdio:'pipe',timeout:25000})
  let client, started=false
  try {
    run('initdb','-D',data,'-A','trust','--no-locale','-E','UTF8')
    run('pg_ctl','-D',data,'-l',join(dir,'postgres.log'),'-o',`-h '' -k ${dir} -p 55432`,'-w','start')
    started=true
    client = new Client({host:dir,port:55432,database:'postgres',user:process.env.USER})
    await client.connect()
    await client.query(`SET TIME ZONE 'UTC';
      CREATE TABLE app_settings(key text PRIMARY KEY,value jsonb NOT NULL);
      CREATE TABLE workspace_organizations(id uuid PRIMARY KEY,is_demo boolean NOT NULL DEFAULT false);
      CREATE TABLE pipeline_spaces(id uuid PRIMARY KEY,workspace_organization_id uuid,reference_access_disabled boolean NOT NULL DEFAULT false);
      CREATE TABLE crm_interactions(id uuid PRIMARY KEY,pipeline_id uuid,suitecrm_id text,reference_code text,provider_message_id text,
        sync_status text,suitecrm_module text,suitecrm_synced_at timestamptz,source_key text,source_hash text,description text,
        metadata jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}');
      CREATE TABLE sync_outbox(id uuid PRIMARY KEY,aggregate_type text,aggregate_id text,target_system text,operation text,
        status text,attempts int,last_error text,processed_at timestamptz,created_at timestamptz,locked_at timestamptz,lock_token uuid,
        payload jsonb,idempotency_key text);
      CREATE TABLE crm_native_email_publication_admissions(local_id uuid,native_id text,global_id text,state text);
      CREATE TABLE crm_legacy_email_recovery_holds(outbox_id uuid,retired_outbox_id uuid,local_id uuid,native_id text,global_id text);
      CREATE SCHEMA crm_legacy_email_terminal_hold;
      CREATE TABLE crm_legacy_email_terminal_hold.held(outbox_id uuid,local_id uuid,native_id text,global_id text);
      CREATE SCHEMA crm_legacy_email_retirement;
      CREATE TABLE crm_legacy_email_retirement.retained(outbox_id uuid,local_id uuid,native_id text,global_id text)`)
    const marker=uuid(999)
    await client.query("INSERT INTO app_settings VALUES('deployment.database.identity',jsonb_build_object('id',$1::text))",[marker])
    await client.query('INSERT INTO workspace_organizations(id) VALUES($1)',[workspaceId])
    await client.query('INSERT INTO pipeline_spaces(id,workspace_organization_id) VALUES($1,$2)',[pipelineId,workspaceId])
    const {rows:[origin]}=await client.query(`SELECT d.datname,d.oid::text,c.system_identifier::text FROM pg_database d
      CROSS JOIN pg_control_system() c WHERE d.datname=current_database()`)
    const current={...structuredClone(review),app:{...app,originFingerprint:sha('["clawpilot-bpo-failed-email-postgres-v1", '
      + [origin.datname,origin.oid,origin.system_identifier,marker].map(x=>JSON.stringify(x)).join(', ')+']')}}
    for (const [i,slot] of [...current.original11,...current.later8].entries()) {
      await client.query(`INSERT INTO crm_interactions(id,pipeline_id,suitecrm_id,reference_code,provider_message_id,sync_status,
        suitecrm_module,source_key,source_hash,description) VALUES($1,$2,$3,$4,$5,'failed','Emails',$6,$7,$8)`,
      [slot.interactionId,pipelineId,slot.nativeId,slot.globalId,slot.providerMessageId,`fixture-${i}`,sha(`source-${i}`),providerBodyFixture])
      const payload={entity:'interactions',localId:slot.interactionId,pipelineId,suiteCrmModule:'Emails',suiteCrmId:slot.nativeId,
        attributes:{global_id_c:slot.globalId,description:providerBodyFixture}}
      await client.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,target_system,operation,status,attempts,last_error,
        processed_at,created_at,payload,idempotency_key)
        VALUES($1,'crm_interactions',$2,'suitecrm','upsert_record','dead',8,$3,'2026-11-09','2026-11-09',$4,$5)`,
      [slot.jobId,slot.interactionId,i<11?'native_projection_proof_unavailable':
        'Native Email projection held: exact identity, relationships, or audience proof is unavailable',
      JSON.stringify(payload),`crm:interactions:v4:${slot.interactionId}:Emails:${sha(`source-${i}`)}`])
      const {rows:[hashes]}=await client.query(`SELECT to_jsonb(i)::text AS i,to_jsonb(o)::text AS o,jsonb_build_array(to_jsonb(i),to_jsonb(o))::text AS combined
        FROM crm_interactions i CROSS JOIN sync_outbox o WHERE i.id=$1 AND o.id=$2`,[slot.interactionId,slot.jobId])
      Object.assign(slot,{interactionFingerprint:sha(hashes.i),jobFingerprint:sha(hashes.o),preimageFingerprint:sha(hashes.combined)})
    }
    const args={review:current,client,expectedInventoryFingerprint:describeBpoFailedEmailRepairInventory(current),
      observedDeploymentFingerprint:app.deploymentFingerprint}
    const plan=async()=>planBpoFailedEmailRepair({...args,nativeReadback,appReadback:await observeBpoFailedEmailAppReadback(args)})
    assert.ok((await plan()).records.every(row=>row.disposition==='create-candidate-proven-absent'))
    await client.query("UPDATE crm_interactions SET description='changed body' WHERE id=$1",[slots[0].interactionId])
    await client.query(`INSERT INTO sync_outbox(id,aggregate_type,aggregate_id,target_system,operation,status,attempts,created_at)
      VALUES($1,'crm_interactions',$2,'suitecrm','upsert_record','queued',0,'2026-11-10')`,[uuid(900),slots[1].interactionId])
    await client.query("INSERT INTO crm_native_email_publication_admissions(local_id,state) VALUES($1,'dispatched')",[slots[2].interactionId])
    await client.query("INSERT INTO crm_interactions(id,pipeline_id,provider_message_id) VALUES($1,$2,$3)",
      [uuid(901),pipelineId,' '+slots[3].providerMessageId.toUpperCase()+' '])
    assert.deepEqual((await plan()).records.filter(r=>r.disposition==='hold').map(r=>r.interactionId),slots.slice(0,4).map(r=>r.interactionId))
  } finally {
    if (client) await client.end()
    if (started) run('pg_ctl','-D',data,'-m','fast','-w','stop')
    rmSync(dir,{recursive:true})
  }
})
