#!/usr/bin/env node
// Actual guarded disposable PostgreSQL only. Native rows, signatures, approval,
// forecasts and receipts are deliberately SYNTHETIC; this proves SQL fences,
// not native execution, cryptographic authentication or production activation.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,readdirSync} from 'node:fs'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

const args=process.argv.slice(2)
assert.ok(args.length===0||(args.length===1&&/^--postgres-major=(16|18)$/.test(args[0])),'Only --postgres-major=16|18 is supported')
const major=args[0]?.split('=')[1]??'16',require=createRequire(new URL('../app_src/package.json',import.meta.url))
const {Pool}=require('pg'),ts=require('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path);const module={exports:{}}
 const source=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','module','exports',source)(name=>name==='server-only'?{}:name.startsWith('node:')?require(name):
  load('app_src/lib/crm/'+name.slice(2)+'.ts'),module,module.exports);cache.set(path,module.exports);return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts'),capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts')
const lineageProtocol=load('app_src/lib/crm/nativeEmailInitialInstallationLineage.ts')
const canonical=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest,copy=value=>JSON.parse(JSON.stringify(value))
const owner='initial.owner@example.invalid',outsider='initial.outsider@example.invalid',root=randomUUID(),account=randomUUID()
const pipelines=[randomUUID(),randomUUID()].sort(),container=`clawpilot-native-initial-pg${major}-${process.pid}-${randomUUID().slice(0,8)}`
let pool,started=false,checks=0
const check=async(label,run)=>{await run();checks++;console.log('PASS '+label)}
try{
 execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
  '-e','POSTGRES_PASSWORD=initial_fixture','-e','POSTGRES_DB=initial_fixture','-p','127.0.0.1::5432',`pgvector/pgvector:pg${major}`]),{stdio:'pipe',timeout:60000});started=true
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
 assert.ok(port,'Fixture must bind loopback only')
 pool=new Pool({host:'127.0.0.1',port:Number(port),database:'initial_fixture',user:'postgres',password:'initial_fixture',ssl:false,max:4,statement_timeout:20000})
 const until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>until)throw error;await new Promise(r=>setTimeout(r,100))}}
 const query=(sql,params)=>pool.query(sql,params)
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}
  catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}}
 const migrate=await pool.connect();try{for(const name of readdirSync(new URL('../db/migrations/',import.meta.url)).filter(x=>/^\d+_.+\.sql$/.test(x)).sort())
  await applyMigrationSqlForTest(migrate,name,readFileSync(new URL('../db/migrations/'+name,import.meta.url),'utf8'))}finally{migrate.release()}
 await check('migration is inert and closes arbitrary first enable without an initial native receipt',async()=>{
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(c.enabled,false);assert.equal(c.active_initial_enrollment_id,null)
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'0')
  await assert.rejects(query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
   native_policy_fingerprint=$1,activation_receipt_hash=$2`,[hash('invented-policy'),hash('invented-snapshot')]),e=>e.code==='55000')
 })
 for(const [email,role,native] of [[owner,'owner','1'],[outsider,'member','native-outsider']])await query(
  `WITH employee AS(SELECT allocate_crm_reference('gu') AS code)
   INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
   SELECT $1,$2,'active',$3,code,code,true FROM employee`,[email,role,native])
 await query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Initial fixture','root',$2,$2)",[root,owner])
 for(const [email,role] of [[owner,'owner'],[outsider,'member']])await query(`INSERT INTO app_user_organization_memberships
  (user_email,organization_id,role,status,permissions,created_by,updated_by) VALUES($1,$2,$3,'active','{"viewCrm":true}',$4,$4)`,[email,root,role,owner])
 await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by)
  VALUES($1,$2,$3,true,$3,$3)`,[account,root,owner])
 await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
  VALUES($1,$2,$3,true,$3,$3)`,[account,root,owner])
 for(const [index,pipeline]of pipelines.entries()){
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)",[pipeline,'Initial '+index,owner,root])
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,
   reference_code,source_payload) VALUES($1,$2,$3,'Synthetic native history',$4,$5,'Emails',now(),allocate_crm_reference('gi'),$6)`,
  [randomUUID(),pipeline,'initial-'+index,hash(['history',index]),randomUUID(),{archived:index===0}])
 }
 const demo=randomUUID()
 await query("INSERT INTO workspace_organizations(id,name,organization_type,is_demo,created_by,updated_by) VALUES($1,'Seeded demo','root',true,$2,$2)",[demo,owner])
 for(let index=0;index<2;index++){
  const pipeline=randomUUID()
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)",[pipeline,'Demo '+index,owner,demo])
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,
   reference_code,source_payload) VALUES($1,$2,$3,'Seeded demo history',$4,'demo-suitecrm-interaction-1','Emails',now(),allocate_crm_reference('gi'),
   '{"source":"demo","synthetic":true}')`,[randomUUID(),pipeline,'demo-'+index,hash(['demo',index])])
 }
 const queuedId=randomUUID()
 await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload)
  VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record','{"body":"PRIVATE_EMAIL_BODY_SENTINEL","amount":123}')`,[queuedId,randomUUID()])
 const snapshot=async()=>{const {rows}=await query(`SELECT s,encode(digest(s::text,'sha256'),'hex') AS fingerprint
  FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS s) q`);return rows[0]}
 const reservation=async()=>{const live=await snapshot();return {live,generation:Number(live.s.generation),operationId:hash(randomUUID()),nativeInstanceId:'synthetic-native-fixture'}}
 const reserve=async(f,actor=owner)=>query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,root_workspace_id,
  native_instance_id,generation,source_snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [f.operationId,actor,account,root,f.nativeInstanceId,f.generation,f.live.s,f.live.fingerprint])
 async function fixture(selected=undefined,ttl=120){
  const reserved=selected??await reservation(),{live,generation}=reserved,principals=['1','native-outsider'],readers=['1']
  const matrix=ids=>Object.fromEntries(['view','list','export','edit','delete'].map(k=>[k,[...ids]]))
  const plannedPipelines=pipelines.map(pipelineId=>{
   const audience=hash({policy:'pipeline-internal',ownerSuiteCrmId:'1',allowedSuiteCrmUserIds:readers,workspaceId:root,pipelineId})
   // Existing audience fingerprint uses this key order, not recursive sorting.
   const orderedAudience=require('node:crypto').createHash('sha256').update(JSON.stringify({policy:'pipeline-internal',ownerSuiteCrmId:'1',
    allowedSuiteCrmUserIds:readers,workspaceId:root,pipelineId})).digest('hex')
   void audience
   return {groupId:randomUUID(),policy:{version:2,pipelineId,workspaceId:root,ownerSuiteCrmId:'1',audienceFingerprint:orderedAudience,
    principalSuiteCrmUserIds:principals,futureCreate:matrix(readers),historical:[]}}
  })
  const plan={version:1,kind:'initial_enrollment_plan_v1',operationId:reserved.operationId,nativeInstanceId:reserved.nativeInstanceId,appGeneration:generation,
   appSourceFingerprint:live.fingerprint,nativePolicyBeforeFingerprint:hash('synthetic-before'),nativePolicyAfterFingerprint:hash('synthetic-after'),
   nativeRuntimeBeforeFingerprint:hash('synthetic-runtime-before'),nativeRuntimeAfterFingerprint:hash('synthetic-runtime-after'),principalSuiteCrmUserIds:principals,
   defaults:['delete','edit','export','list','view'].map(action=>{const id=randomUUID();return {before:{id,action,aclAccess:90},after:{id,action,aclAccess:['edit','delete'].includes(action)?75:80}}}),
   emails:live.s.emails.map(row=>{const {recordFingerprint,...identity}=row;const before={...identity,recordFingerprint,capabilities:matrix(principals)}
    return {before,after:{...copy(before),capabilities:matrix(readers)}}}),pipelines:plannedPipelines,rootEmployeeGrants:[]}
  plan.reviewedRevocations=plan.emails.flatMap(pair=>['view','list','export','edit','delete'].map(surface=>({nativeId:pair.before.nativeId,surface,principalId:'native-outsider'})))
   .sort((a,b)=>[a.nativeId,a.surface,a.principalId].join(':')<[b.nativeId,b.surface,b.principalId].join(':')?-1:1)
  const policies=plannedPipelines.map(({policy})=>({pipelineId:policy.pipelineId,generation,policy,
   fingerprint:capability.prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:policy.pipelineId,workspaceId:root,ownerSuiteCrmId:'1',
    audienceFingerprint:policy.audienceFingerprint,allowedReaderSuiteCrmUserIds:readers},livePrincipalSuiteCrmUserIds:principals,
    approvedFutureCreate:policy.futureCreate,liveHistorical:[]}).futurePolicyFingerprint}))
  const planHash=hash(plan),preparedAt=new Date().toISOString().slice(0,19).replace('T',' ')
  const result={generation,appSourceFingerprint:live.fingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,
   afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
   installedRuntimeFingerprint:hash('synthetic-installed-runtime'),runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,
   identityFingerprint:hash(plan.emails.map(({after})=>{const {capabilities,...identity}=after;void capabilities;return identity})),
   capabilitiesFingerprint:hash(plan.emails.map(({after})=>({emailId:after.nativeId,globalId:after.globalId,pipelineId:after.pipelineId,capabilities:after.capabilities}))),
   bindingsFingerprint:hash('synthetic-full-native-bindings'),defaultsFingerprint:hash(plan.defaults.map(row=>row.after)),emailCount:plan.emails.length,principalCount:principals.length}
  const delta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId:plan.operationId,planHash,preparedAt,
   changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies}
  const issuedAt=Math.floor(Date.now()/1000),approval={proof:{version:1,purpose:'clawpilot-native-email-initial-enrollment-approval',
   issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-initial-enrollment',keyId:'synthetic-pg-test',nativeInstanceId:plan.nativeInstanceId,
   serviceUserId:'1',oauthClientId:randomUUID(),issuedAt,expiresAt:issuedAt+ttl,operationId:plan.operationId,planHash,appGeneration:generation,
   appSourceFingerprint:live.fingerprint,preparedAt,deltaFingerprint:hash(delta),sourceRuntimeFingerprint:result.sourceRuntimeFingerprint,
   installedRuntimeFingerprint:result.installedRuntimeFingerprint,installationJournalFingerprint:hash('synthetic-journal')},signature:'A'.repeat(512)}
  return {plan,delta,approval,live,planHash,operationId:plan.operationId,generation}
 }
 const insert=async(f,actor=owner)=>query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,native_delta_canonical,
  delta_fingerprint,approval_envelope,approval_canonical,approval_hash,actor_email,operator_account_id,root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[f.operationId,f.plan,canonical(f.plan),hash(f.plan),f.delta,canonical(f.delta),hash(f.delta),
   f.approval,canonical(f.approval),hash(f.approval),actor,account,root,f.plan.nativeInstanceId,f.generation,f.live.s,f.live.fingerprint])
 const refusal=error=>['55000','23514'].includes(error.code)
 await check('non-demo inventory excludes repeated seeded IDs; queued payloads are bound without copying private contents',async()=>{
  const s=await snapshot()
  assert.equal((await query("SELECT count(*) FROM crm_interactions WHERE suitecrm_module='Emails'")).rows[0].count,'4')
  assert.equal(s.s.emails.length,2);assert.ok(s.s.emails.every(row=>row.nativeId!=='demo-suitecrm-interaction-1'))
  assert.ok(s.s.workspaces.some(row=>row.id===demo&&row.is_demo===true))
  assert.equal(s.s.pendingOutbox.length,1);assert.ok(s.s.pendingOutbox[0].rowFingerprint)
  assert.ok(!canonical(s.s).includes('PRIVATE_EMAIL_BODY_SENTINEL'));assert.ok(!Object.hasOwn(s.s.pendingOutbox[0],'payload'))
  const before=s.fingerprint
  await query("UPDATE sync_outbox SET payload=payload||'{\"amount\":456}'::jsonb WHERE id=$1",[queuedId])
  assert.notEqual((await snapshot()).fingerprint,before,'full-row hash must bind changes to hidden payload fields')
 })
 await check('only current exact operator root owner and unchanged complete SQL snapshot may reserve',async()=>{
  await assert.rejects(reserve(await reservation(),outsider),refusal)
  const stale=await reservation();await query("UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email=$1 AND organization_id=$2",[outsider,root])
  await assert.rejects(reserve(stale),refusal)
  await assert.rejects(insert(await fixture()),refusal)
 })
 await check('queued retries, failed/dead/processing and unresolved identity jobs cannot be called drained',async()=>{
  for(const patch of ["attempts=1","status='failed'","status='dead'","status='processing',locked_at=now(),lock_token='unknown'","operation='upsert_user_identity'"]){
   await query('UPDATE sync_outbox SET '+patch+' WHERE id=$1',[queuedId]);await assert.rejects(reserve(await reservation()),refusal)
   await query("UPDATE sync_outbox SET status='queued',operation='upsert_record',attempts=0,locked_at=NULL,lock_token=NULL,last_error=NULL,processed_at=NULL WHERE id=$1",[queuedId])
  }
 })
 const reserved=await reservation()
 await check('reservation installs the disabled durable fence before any final plan, native forecast or signature exists',async()=>{
  await reserve(reserved)
  assert.equal((await query('SELECT * FROM crm_native_email_initial_reservations')).rows[0].state,'reserved')
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'0')
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(c.enabled,false);assert.equal(c.active_initial_enrollment_id,reserved.operationId)
  await assert.rejects(reserve(await reservation()),refusal)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL'),refusal)
  await assert.rejects(query('UPDATE workspace_organizations SET is_demo=false WHERE id=$1',[demo]),refusal)
  await assert.rejects(query("UPDATE sync_outbox SET status='processing',attempts=1 WHERE id=$1",[queuedId]),refusal)
  await assert.rejects(query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
   VALUES($1,$2,'{}',$3)`,[pipelines[0],reserved.generation,hash('unbound-policy')]),refusal)
 })
 // Native installation/project/signing belong AFTER the committed reservation.
 // This fixture only constructs synthetic data and does not run those steps.
 const selected=await fixture(reserved,2)
 await check('failed final signing/binding preserves reservation; only exact fixed-RSA shape and source bind once',async()=>{
  for(const mutate of [f=>{f.approval.signature='A'.repeat(511)},f=>{f.approval.signature='-'.repeat(512)},
   f=>{f.approval.proof.keyId='has.dot'},f=>{f.approval.proof.oauthClientId='x'.repeat(37)},
   f=>{f.approval.proof.purpose='ordinary-authority-approval'},f=>{f.delta.result.emailCount=1}]){
   const f=copy(selected);mutate(f);await assert.rejects(insert(f),refusal)
  }
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'0')
  assert.equal((await query('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control')).rows[0].active_initial_enrollment_id,reserved.operationId)
  await insert(selected)
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(c.enabled,false);assert.equal(c.active_initial_enrollment_id,selected.operationId)
  const e=(await query('SELECT * FROM crm_native_email_initial_enrollments')).rows[0]
  assert.equal(e.plan_hash,selected.planHash);assert.deepEqual(e.native_delta,selected.delta);assert.equal(e.native_receipt,null)
  await assert.rejects(insert(selected),e=>e.code==='23505')
 })
 await check('pending barrier fences sources, identity/publication jobs, all authority ledgers and native policies even while disabled',async()=>{
  for(const [sql,params]of [
   ["UPDATE app_users SET permissions='{\"viewCrm\":false}' WHERE email=$1",[owner]],
   ["UPDATE app_user_organization_memberships SET permissions='{}' WHERE user_email=$1 AND organization_id=$2",[outsider,root]],
   ["UPDATE workspace_organizations SET is_demo=true WHERE id=$1",[root]],
   ["UPDATE pipeline_spaces SET owner_email=$2 WHERE id=$1",[pipelines[0],outsider]],
   ["UPDATE crm_operator_accounts SET enabled=false,revision=revision+1 WHERE id=$1",[account]],
   ["UPDATE crm_interactions SET subject='changed' WHERE pipeline_id=$1",[pipelines[0]]],
   ['DELETE FROM crm_interactions WHERE pipeline_id=$1',[pipelines[0]]],
   ['TRUNCATE crm_native_email_publication_work',[]],
   ['INSERT INTO crm_native_email_authority_transitions(transition_id) VALUES($1)',[hash('wrong-transition')]],
   ['INSERT INTO crm_native_email_publication_admissions(operation_id) VALUES($1)',[hash('wrong-admission')]],
   ["UPDATE sync_outbox SET status='processing',attempts=1 WHERE id=$1",[queuedId]],
   ["INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload) VALUES('suitecrm','app_users',$1,'upsert_user_identity','{}')",[owner]],
   ['TRUNCATE sync_outbox CASCADE',[]],
   ['DELETE FROM crm_native_email_initial_enrollments',[]],
   ['TRUNCATE crm_native_email_initial_enrollments CASCADE',[]],
   ['DELETE FROM crm_native_email_initial_reservations',[]],
   ['TRUNCATE crm_native_email_initial_reservations CASCADE',[]],
   ["UPDATE crm_native_email_initial_reservations SET source_fingerprint=$1",[hash('replacement-source')]],
   ["UPDATE crm_native_email_initial_enrollments SET plan_hash=$1",[hash('replacement')]],
   ['UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL',[]],
  ])await assert.rejects(query(sql,params),refusal)
  await assert.rejects(tx(async c=>{await c.query("SELECT set_config('clawpilot.crm_native_initial_bypass','on',true)");
   await c.query("UPDATE crm_interactions SET subject='GUC bypass'")}),refusal)
  await query("INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload) VALUES('unrelated-provider','other','other','other','{}')")
  await query("UPDATE app_users SET display_name='Harmless profile edit',updated_at=now() WHERE email=$1",[owner])
  await query("UPDATE pipeline_spaces SET name='Harmless pipeline label',updated_at=now() WHERE id=$1",[pipelines[0]])
  await query("UPDATE workspace_organizations SET name='Harmless workspace label',updated_at=now() WHERE id=$1",[root])
  assert.equal((await query('SELECT enabled FROM crm_native_email_publication_control')).rows[0].enabled,false)
  assert.deepEqual((await snapshot()).s,selected.live.s)
 })
 await check('unknown outcome remains held with no clock or caller escape',async()=>{
  await query("UPDATE crm_native_email_initial_enrollments SET state='dispatched'")
  await query("UPDATE crm_native_email_initial_enrollments SET state='unknown'")
  await assert.rejects(query("UPDATE crm_native_email_initial_enrollments SET state='admitted'"),refusal)
  await assert.rejects(query("UPDATE crm_native_email_initial_enrollments SET created_at=created_at-interval '1 year'"),refusal)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET generation=generation+1'),refusal)
 })
 const receiptFor=f=>({version:1,purpose:'clawpilot-native-email-initial-enrollment-receipt',operationId:f.operationId,planHash:f.planHash,
  approvalHash:hash(f.approval),state:'committed',result:f.delta.result})
 const receipt=receiptFor(selected)
 const settle=async(f,{native=receiptFor(f),policyCount=f.delta.policies.length,clearControl=true,settleReservation=true}={})=>tx(async c=>{
  const terminal=native.state==='cancelled'?'cancelled':'activated'
  await c.query(`UPDATE crm_native_email_initial_enrollments SET state=$5,native_receipt=$1,receipt_canonical=$2,receipt_hash=$3,
   settling_xid=txid_current(),updated_at=clock_timestamp() WHERE operation_id=$4`,[native,canonical(native),hash(native),f.operationId,terminal])
  if(settleReservation)await c.query(`UPDATE crm_native_email_initial_reservations SET state=$2,settling_xid=txid_current(),updated_at=clock_timestamp()
   WHERE operation_id=$1`,[f.operationId,terminal])
  for(const p of (terminal==='activated'?f.delta.policies.slice(0,policyCount):[]))await c.query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
   VALUES($1,$2,$3,$4)`,[p.pipelineId,p.generation,p.policy,p.fingerprint])
  if(clearControl){if(terminal==='activated')await c.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
   native_policy_fingerprint=$1,activation_receipt_hash=$2,active_initial_enrollment_id=NULL`,[f.plan.nativePolicyAfterFingerprint,hash(native)])
   else await c.query('UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL')}
 })
 await check('forged/partial receipts and receipt-only or partial-policy activation roll back completely',async()=>{
  for(const patch of [r=>{r.approvalHash=hash('wrong')},r=>{r.result.emailCount++},r=>{r.purpose='snapshot'},r=>{r.result.runtimeFingerprint=hash('wrong-runtime')}]){
   const r=copy(receipt);patch(r);await assert.rejects(settle(selected,{native:r}),refusal)
  }
  await assert.rejects(settle(selected,{clearControl:false}),refusal)
  await assert.rejects(settle(selected,{settleReservation:false}),refusal)
  await assert.rejects(settle(selected,{policyCount:1}),refusal)
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(c.enabled,false);assert.equal(c.active_initial_enrollment_id,selected.operationId)
  assert.equal((await query('SELECT state FROM crm_native_email_initial_enrollments')).rows[0].state,'unknown')
  assert.equal((await query('SELECT count(*) FROM crm_native_email_capability_policies')).rows[0].count,'0')
 })
 await check('expiry alone cannot release; explicit exact expired native cancellation clears only disabled unchanged baseline',async()=>{
  const cancelled={...receipt,state:'cancelled',result:null}
  while(Date.now()<selected.approval.proof.expiresAt*1000-200)await new Promise(resolve=>setTimeout(resolve,25))
  await assert.rejects(settle(selected,{native:cancelled}),refusal,'an integer cast must not round current time into premature expiry')
  while(Date.now()<selected.approval.proof.expiresAt*1000+50)await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal((await query('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control')).rows[0].active_initial_enrollment_id,selected.operationId)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL'),refusal)
  await assert.rejects(settle(selected,{native:cancelled,clearControl:false}),refusal)
  await settle(selected,{native:cancelled})
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0]
  assert.equal(c.enabled,false);assert.equal(c.active_initial_enrollment_id,null)
  assert.equal(c.activation_receipt_hash,null);assert.equal(c.native_policy_fingerprint,null)
  assert.deepEqual((await snapshot()).s,selected.live.s)
  assert.equal((await query('SELECT state FROM crm_native_email_initial_reservations WHERE operation_id=$1',[selected.operationId])).rows[0].state,'cancelled')
  assert.equal((await query('SELECT native_receipt FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[selected.operationId])).rows[0].native_receipt.state,'cancelled')
  await assert.rejects(query("UPDATE crm_native_email_initial_reservations SET state='reserved',settling_xid=NULL WHERE operation_id=$1",[selected.operationId]),refusal)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,activation_receipt_hash=$2',
   [selected.plan.nativePolicyAfterFingerprint,hash(cancelled)]),refusal)
 })
 const retryReservation=await reservation()
 await reserve(retryReservation)
 const retry=await fixture(retryReservation)
 await check('retained cancellation rejects a fresh direct-v1 retry and SQL derives exact first-replan anchors',async()=>{
  await assert.rejects(insert(retry),error=>error.code==='55000'&&/Direct initial plan cannot bypass retained cancellation history/.test(error.message))
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'1')
  const rootSourcePin=hash('independently supplied synthetic root source artifact')
  const context=(await query('SELECT clawpilot_crm_native_initial_replan_context($1,$2,$3) AS context',
   [retry.operationId,selected.operationId,rootSourcePin])).rows[0].context
  const retained=(await query('SELECT receipt_hash FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[selected.operationId])).rows[0]
  assert.deepEqual(context,{version:1,purpose:'clawpilot-native-email-initial-replan-context',rootOperationId:selected.operationId,
   rootInstallationJournalFingerprint:selected.approval.proof.installationJournalFingerprint,rootSourceArtifactDigest:rootSourcePin,
   rootStockRuntimeFingerprint:selected.approval.proof.sourceRuntimeFingerprint,predecessorOperationId:selected.operationId,
   predecessorPlanHash:selected.planHash,predecessorApprovalHash:hash(selected.approval),predecessorCancellationReceiptHash:retained.receipt_hash,
   previousLineageHash:null,depth:1,cancelledHistoryFingerprint:hash([{operationId:selected.operationId,planHash:selected.planHash,
    deltaFingerprint:hash(selected.delta),approvalHash:hash(selected.approval),cancellationReceiptHash:retained.receipt_hash}])})
  // SQL cannot authenticate the independent root source pin or a real capture.
  // Both fresh installed source and signer remain synthetic in this fixture.
  const runtime=hash('synthetic-fresh-installed-replan-runtime')
  retry.plan.kind='initial_enrollment_replan_v1';retry.plan.nativeRuntimeBeforeFingerprint=runtime
  retry.plan.installationLineage=lineageProtocol.finalizeNativeEmailInitialInstallationLineage(context,retry.operationId,
   hash('synthetic-fresh-installed-source-artifact'),runtime)
  retry.planHash=hash(retry.plan);retry.delta.planHash=retry.planHash
  retry.delta.result.sourceRuntimeFingerprint=runtime;retry.delta.result.installedRuntimeFingerprint=runtime
  Object.assign(retry.approval.proof,{planHash:retry.planHash,deltaFingerprint:hash(retry.delta),sourceRuntimeFingerprint:runtime,
   installedRuntimeFingerprint:runtime,installationJournalFingerprint:lineageProtocol.effectiveNativeEmailInitialInstallationJournalFingerprint(
    retry.plan.installationLineage,retry.operationId)})
  assert.equal((await query('SELECT clawpilot_crm_native_initial_lineage_digest($1::jsonb) AS digest',
   [canonical(retry.plan.installationLineage)])).rows[0].digest,hash(retry.plan.installationLineage))
 })
 await check('SQL replan admission rejects rehashed predecessor, history, root, runtime and effective-journal substitutions',async()=>{
  for(const mutate of [lineage=>{lineage.predecessorPlanHash=hash('other predecessor plan')},
   lineage=>{lineage.predecessorApprovalHash=hash('other predecessor approval')},
   lineage=>{lineage.predecessorCancellationReceiptHash=hash('other cancellation receipt')},
   lineage=>{lineage.cancelledHistoryFingerprint=hash('incomplete cancelled history')},
   lineage=>{lineage.rootInstallationJournalFingerprint=hash('other root journal')},
   lineage=>{lineage.rootStockRuntimeFingerprint=hash('other root stock runtime')},
   lineage=>{lineage.predecessorOperationId=hash('missing predecessor');lineage.rootOperationId=lineage.predecessorOperationId},
   lineage=>{lineage.freshInstalledRuntimeFingerprint=hash('other fresh installed runtime')}]){
   const forged=copy(retry);mutate(forged.plan.installationLineage)
   forged.planHash=hash(forged.plan);forged.delta.planHash=forged.planHash
   Object.assign(forged.approval.proof,{planHash:forged.planHash,deltaFingerprint:hash(forged.delta),
    installationJournalFingerprint:lineageProtocol.effectiveNativeEmailInitialInstallationJournalFingerprint(forged.plan.installationLineage,forged.operationId)})
   await assert.rejects(insert(forged),refusal)
  }
  const wrongJournal=copy(retry);wrongJournal.approval.proof.installationJournalFingerprint=hash('unbound effective installation')
  await assert.rejects(insert(wrongJournal),refusal)
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'1')
  assert.equal((await query('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control')).rows[0].active_initial_enrollment_id,retry.operationId)
 })
 await insert(retry)
 await check('explicit lineage replan and exact committed receipt activate complete policies atomically; both terminal histories persist',async()=>{
  const committed=receiptFor(retry)
  await settle(retry)
  const c=(await query('SELECT * FROM crm_native_email_publication_control')).rows[0],e=(await query('SELECT * FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[retry.operationId])).rows[0]
  assert.equal(c.enabled,true);assert.equal(c.active_initial_enrollment_id,null);assert.equal(c.activation_receipt_hash,e.receipt_hash)
  assert.equal(e.state,'activated');assert.deepEqual(e.native_receipt,committed)
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_reservations')).rows[0].count,'2')
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'2')
  assert.equal((await query('SELECT count(*) FROM crm_native_email_capability_policies')).rows[0].count,'2')
  await assert.rejects(query("UPDATE crm_native_email_initial_enrollments SET state='unknown',native_receipt=NULL,receipt_canonical=NULL,receipt_hash=NULL,settling_xid=NULL"),refusal)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET enabled=false'),refusal)
  await query('UPDATE crm_native_email_publication_control SET updated_at=clock_timestamp()')
  await assert.rejects(query("UPDATE app_users SET suitecrm_user_id='rebound' WHERE email=$1",[owner]),refusal)
 })
 console.log(`PASS ${checks} actual PostgreSQL ${major} initial-enrollment groups; synthetic native approval/forecast/receipt only, no native execution or production proof`)
}finally{try{if(pool)await pool.end()}finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})}}
