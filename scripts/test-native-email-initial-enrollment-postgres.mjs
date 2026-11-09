#!/usr/bin/env node
// Actual guarded disposable PostgreSQL only. Native rows, signatures, approval,
// forecasts and receipts are deliberately SYNTHETIC; this proves SQL fences,
// not native execution, cryptographic authentication or production activation.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,readdirSync} from 'node:fs'
import {posix as path} from 'node:path'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {startDisposableNativePostgres} from './lib/disposable-native-postgres.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'
import {loadNativeJointLegacyEmailRecoveryApp} from './lib/native-joint-legacy-email-recovery.mjs'

const args=process.argv.slice(2)
assert.ok(new Set(args).size===args.length&&args.every(arg=>arg==='--native-postgres'||/^--postgres-major=(16|18)$/u.test(arg))
 &&args.filter(arg=>arg.startsWith('--postgres-major')).length<=1,'Only --postgres-major=16|18 and --native-postgres are supported')
const major=args.find(arg=>arg.startsWith('--postgres-major'))?.split('=')[1]??'16'
const nativePostgres=args.includes('--native-postgres'),require=createRequire(new URL('../app_src/package.json',import.meta.url))
const {Pool}=require('pg'),ts=require('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path);const module={exports:{}}
 const source=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','module','exports',source)(name=>name==='server-only'?{}:name.startsWith('node:')?require(name):
  loadLocal(path,name),module,module.exports);cache.set(path,module.exports);return module.exports}
function loadLocal(importer,name){
 const target=path.normalize(path.join(path.dirname(importer),name+'.ts'))
 assert.ok(name.startsWith('.')&&/^app_src\/lib\/(?:crm|persistence)\/[A-Za-z0-9]+\.ts$/u.test(target),'Fixture source boundary')
 return load(target)
}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts'),capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts')
const lineageProtocol=load('app_src/lib/crm/nativeEmailInitialInstallationLineage.ts')
const canonical=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest,copy=value=>JSON.parse(JSON.stringify(value))
const owner='initial.owner@example.invalid',outsider='initial.outsider@example.invalid',root=randomUUID(),account=randomUUID()
const authorityInstance=randomUUID()
const pipelines=[randomUUID(),randomUUID()].sort(),container=`clawpilot-native-initial-pg${major}-${process.pid}-${randomUUID().slice(0,8)}`
let pool,started=false,checks=0,nativeFixture
const check=async(label,run)=>{await run();checks++;console.log('PASS '+label)}
try{
 let connection
 if(nativePostgres){
  nativeFixture=await startDisposableNativePostgres({major,fixturePrefix:'clawpilot-initial-pg-'})
  connection=nativeFixture.connection
 }else{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
   '-e','POSTGRES_PASSWORD=initial_fixture','-e','POSTGRES_DB=initial_fixture','-p','127.0.0.1::5432',`pgvector/pgvector:pg${major}`]),{stdio:'pipe',timeout:60000});started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port,'Fixture must bind loopback only')
  connection={host:'127.0.0.1',port:Number(port),database:'initial_fixture',user:'postgres',password:'initial_fixture',
   ssl:false,options:'-c timezone=UTC'}
 }
 const localPoolOptions={...connection,max:4,connectionTimeoutMillis:1000,statement_timeout:20000}
 pool=new Pool(localPoolOptions)
 const until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>until)throw error;await new Promise(r=>setTimeout(r,100))}}
 if(nativeFixture)await nativeFixture.assertOwned(pool)
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
 const demo='10000000-0000-4000-8000-000000000001'
 await query("INSERT INTO workspace_organizations(id,name,organization_type,is_demo,created_by,updated_by) VALUES($1,'Seeded demo','root',true,$2,$2)",[demo,owner])
 for(let index=0;index<2;index++){
  const pipeline=randomUUID()
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,reference_access_disabled) VALUES($1,$2,$3,$4,true)",[pipeline,'Demo '+index,owner,demo])
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,
   reference_code,source_payload) VALUES($1,$2,$3,'Seeded demo history',$4,'demo-suitecrm-interaction-1','Emails',now(),allocate_crm_reference('gi'),
   '{"source":"demo","synthetic":true}')`,[randomUUID(),pipeline,'demo-'+index,hash(['demo',index])])
 }
 const queuedId=randomUUID()
 await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload)
  VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record','{"body":"PRIVATE_EMAIL_BODY_SENTINEL","amount":123}')`,[queuedId,randomUUID()])
 const snapshot=async(queryable=pool)=>{const {rows}=await queryable.query(`SELECT s,encode(digest(s::text,'sha256'),'hex') AS fingerprint
  FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS s) q`);return rows[0]}
 const reservation=async(queryable=pool)=>{const live=await snapshot(queryable);return {live,generation:Number(live.s.generation),operationId:hash(randomUUID()),nativeInstanceId:authorityInstance}}
 const reserve=async(f,actor=owner,queryable=pool)=>queryable.query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,root_workspace_id,
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
 const insert=async(f,actor=owner,queryable=pool)=>queryable.query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,native_delta_canonical,
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
 const quarantineWorkspace=demo,quarantineOwner='demo-system@clawpilot.example'
 const quarantinePipeline=randomUUID(),quarantineProduct=randomUUID(),quarantineInteraction=randomUUID()
 const quarantineIds=[randomUUID(),randomUUID()].sort()
 const quarantineMarker='Demo pipeline quarantined; immutable CRM identity evidence preserved'
 await query("INSERT INTO app_users(email,role,status,crm_user_enabled) VALUES($1,'member','active',false)",[quarantineOwner])
 await query('UPDATE app_users SET organization_id=$1 WHERE email=$2',[quarantineWorkspace,quarantineOwner])
 await query(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id,sync_enabled,reference_access_disabled)
  VALUES($1,'Immutable demo identity evidence',$2,$3,false,true)`,[quarantinePipeline,quarantineOwner,quarantineWorkspace])
 await query(`INSERT INTO crm_products(id,pipeline_id,source_key,name,source_hash,suitecrm_id,source_payload)
  VALUES($1,$2,'quickbooks:item:quarantine-fixture','Synthetic retained product',$3,'demo-suitecrm-product-1',
  '{"provider":"quickbooks","synthetic":true}')`,[quarantineProduct,quarantinePipeline,hash('quarantine-product')])
 await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,source_payload)
  VALUES($1,$2,'demo-quarantine-email','Synthetic retained interaction',$3,'demo-suitecrm-interaction-1','Emails',
  '{"source":"demo","synthetic":true}')`,[quarantineInteraction,quarantinePipeline,hash('quarantine-interaction')])
 for(const [index,entity,aggregateId,nativeId,operation]of [
  [0,'products',quarantineProduct,'demo-suitecrm-product-1','upsert_record'],
  [1,'interactions',quarantineInteraction,'demo-suitecrm-interaction-1','reproject_record'],
 ])await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,
   last_error,available_at,processed_at,locked_at,lock_token)
   VALUES($1,'suitecrm',$2,$3,$4,$5,'dead',$6,$7,'infinity',now(),NULL,NULL)`,
  [quarantineIds[index],'crm_'+entity,aggregateId,operation,{entity,pipelineId:quarantinePipeline,localId:aggregateId,suiteCrmId:nativeId,
   attributes:{name:'Synthetic retained quarantine'},...(entity==='interactions'?{suiteCrmModule:'Emails',previousSuiteCrmModule:'Notes'}:{})},index===0?1:4,quarantineMarker])
 const quarantineRows=async(queryable=pool)=>(await queryable.query(`SELECT s.id::text,to_jsonb(s)::text AS retained,
   encode(digest(to_jsonb(s)::text,'sha256'),'hex') AS fingerprint FROM sync_outbox s WHERE id=ANY($1::uuid[]) ORDER BY id`,[quarantineIds])).rows
 const quarantineBefore=await quarantineRows()
 const classifyQuarantine=async(queryable,outboxId,expectedHash=undefined)=>{
  const fingerprint=expectedHash??(await quarantineRows(queryable)).find(row=>row.id===outboxId)?.fingerprint
  return (await queryable.query('SELECT clawpilot_crm_native_initial_demo_quarantine($1::uuid,$2::text) AS verified',[outboxId,fingerprint])).rows[0].verified
 }
 await check('only the exact terminal synthetic quarantine is recognized and all original outbox evidence stays in the snapshot',async()=>{
  for(const row of quarantineBefore){assert.equal(await classifyQuarantine(pool,row.id),true)
   assert.equal(await classifyQuarantine(pool,row.id,hash('wrong-retained-full-row')),false)}
  const s=await snapshot();assert.equal(s.s.pendingOutbox.length,3)
  for(const row of quarantineBefore)assert.equal(s.s.pendingOutbox.find(p=>p.id===row.id)?.rowFingerprint,row.fingerprint)
  assert.deepEqual(await quarantineRows(),quarantineBefore)
 })
 await check('quarantine marker, scope, identity, payload, synthetic status and lease near-misses still block reservation',async()=>{
  const productJob=quarantineIds[0],interactionJob=quarantineIds[1]
  const negatives=[
   ['marker',"UPDATE sync_outbox SET last_error='ordinary provider outcome unknown' WHERE id=$1",[productJob],productJob],
   ['finite availability',"UPDATE sync_outbox SET available_at=now() WHERE id=$1",[productJob],productJob],
   ['missing terminal receipt','UPDATE sync_outbox SET processed_at=NULL WHERE id=$1',[productJob],productJob],
   ['lock timestamp','UPDATE sync_outbox SET locked_at=now() WHERE id=$1',[productJob],productJob],
   ['lock token',"UPDATE sync_outbox SET lock_token='unknown-lease' WHERE id=$1",[productJob],productJob],
   ['failed status',"UPDATE sync_outbox SET status='failed' WHERE id=$1",[productJob],productJob],
   ['processing status',"UPDATE sync_outbox SET status='processing' WHERE id=$1",[productJob],productJob],
   ['queued retry',"UPDATE sync_outbox SET status='queued' WHERE id=$1",[productJob],productJob],
   ['identity operation',"UPDATE sync_outbox SET operation='upsert_user_identity' WHERE id=$1",[productJob],productJob],
   ['delete operation',"UPDATE sync_outbox SET operation='delete_record' WHERE id=$1",[productJob],productJob],
   ['local binding',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{localId}',to_jsonb($2::text)) WHERE id=$1`,[productJob,randomUUID()],productJob],
   ['pipeline binding',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{pipelineId}',to_jsonb($2::text)) WHERE id=$1`,[productJob,pipelines[0]],productJob],
   ['native binding',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{suiteCrmId}','"foreign-native-id"') WHERE id=$1`,[productJob],productJob],
   ['missing aggregate','UPDATE sync_outbox SET aggregate_id=$2 WHERE id=$1',[productJob,randomUUID()],productJob],
   ['wrong entity',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{entity}','"organizations"') WHERE id=$1`,[productJob],productJob],
   ['non-object attributes',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{attributes}','[]') WHERE id=$1`,[productJob],productJob],
   ['product module',`UPDATE sync_outbox SET payload=payload||'{"suiteCrmModule":"Emails"}' WHERE id=$1`,[productJob],productJob],
   ['product prior module',`UPDATE sync_outbox SET payload=payload||'{"previousSuiteCrmModule":"Notes"}' WHERE id=$1`,[productJob],productJob],
   ['interaction module',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{suiteCrmModule}','"Calls"') WHERE id=$1`,[interactionJob],interactionJob],
   ['interaction previous module',`UPDATE sync_outbox SET payload=jsonb_set(payload,'{previousSuiteCrmModule}','"Calls"') WHERE id=$1`,[interactionJob],interactionJob],
   ['current product pipeline','UPDATE crm_products SET pipeline_id=$2 WHERE id=$1',[quarantineProduct,pipelines[0]],productJob],
   ['current interaction pipeline','UPDATE crm_interactions SET pipeline_id=$2 WHERE id=$1',[quarantineInteraction,pipelines[0]],interactionJob],
   ['current product native identity',"UPDATE crm_products SET suitecrm_id='changed-native-product' WHERE id=$1",[quarantineProduct],productJob],
   ['current interaction native identity',"UPDATE crm_interactions SET suitecrm_id='changed-native-interaction' WHERE id=$1",[quarantineInteraction],interactionJob],
   ['current interaction module',"UPDATE crm_interactions SET suitecrm_module='Notes' WHERE id=$1",[quarantineInteraction],interactionJob],
   ['synthetic product',`UPDATE crm_products SET source_payload='{"provider":"quickbooks","synthetic":false}' WHERE id=$1`,[quarantineProduct],productJob],
   ['synthetic interaction',`UPDATE crm_interactions SET source_payload='{"source":"demo","synthetic":false}' WHERE id=$1`,[quarantineInteraction],interactionJob],
   ['string synthetic product',`UPDATE crm_products SET source_payload='{"provider":"quickbooks","synthetic":"true"}' WHERE id=$1`,[quarantineProduct],productJob],
   ['string synthetic interaction',`UPDATE crm_interactions SET source_payload='{"source":"demo","synthetic":"true"}' WHERE id=$1`,[quarantineInteraction],interactionJob],
   ['product provider',`UPDATE crm_products SET source_payload='{"provider":"unknown","synthetic":true}' WHERE id=$1`,[quarantineProduct],productJob],
   ['interaction source',`UPDATE crm_interactions SET source_payload='{"source":"unknown","synthetic":true}' WHERE id=$1`,[quarantineInteraction],interactionJob],
   ['pipeline owner','UPDATE pipeline_spaces SET owner_email=$2 WHERE id=$1',[quarantinePipeline,owner],productJob],
   ['pipeline enabled','UPDATE pipeline_spaces SET reference_access_disabled=false WHERE id=$1',[quarantinePipeline],productJob],
   ['workspace real','UPDATE workspace_organizations SET is_demo=false WHERE id=$1',[quarantineWorkspace],productJob],
   ['wrong workspace','UPDATE pipeline_spaces SET workspace_organization_id=$2 WHERE id=$1',[quarantinePipeline,root],productJob],
  ]
  for(const [label,sql,params,job]of negatives){const c=await pool.connect();try{
   await c.query('BEGIN');await c.query(sql,params)
   assert.equal(await classifyQuarantine(c,job),false,label)
   await assert.rejects(reserve(await reservation(c),owner,c),refusal,label+' must not be called drained')
  }finally{await c.query('ROLLBACK');c.release()}}
  assert.deepEqual(await quarantineRows(),quarantineBefore,'All negative cases roll back without altering retained quarantine evidence')
 })
 await check('signed fixture retirement consumes approval with eleven retained originals and resolves lost acknowledgement read-only',async()=>{
  await query(readFileSync(new URL('./fixtures/native-email-legacy-retirement.sql',import.meta.url),'utf8'))
  const lost=new Error('synthetic acknowledgement loss after PostgreSQL commit')
  const crypto=require('node:crypto')
  const approvalApi=load('app_src/lib/crm/legacyEmailRetirementApproval.ts')
  const fenceKey=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  const operatorKey=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  const wrap=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(canonical(proof),'ascii'),
   {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
  let pins
  await assert.rejects(async()=>{
   await tx(async c=>{
   const ids=[],batch=randomUUID(),epoch=randomUUID()
   const sourceRows=async()=> (await c.query('SELECT to_jsonb(i) AS r FROM crm_interactions i WHERE source_key LIKE \'legacy-retirement-fixture-%\' ORDER BY id')).rows
   const body='SYNTHETIC_RETAINED_ORIGINAL'
   for(let index=0;index<11;index++){
    const local=randomUUID(),native=randomUUID(),outbox=randomUUID(),pipeline=pipelines[index%2],sourceHash=hash(['legacy',index])
    const created=await c.query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,
     reference_code,source_payload,sync_status) VALUES($1,$2,$3,'Synthetic terminal legacy email',$4,$5,'Emails',allocate_crm_reference('gi'),'{}','failed')
     RETURNING reference_code`,[local,pipeline,'legacy-retirement-fixture-'+index,sourceHash,native])
    const global=created.rows[0].reference_code
    await c.query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,
     status,attempts,last_error,processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,
     'dead',8,'synthetic legacy result unknown',now(),$4)`,[outbox,local,{entity:'interactions',localId:local,
      pipelineId:pipeline,suiteCrmId:native,suiteCrmModule:'Emails',attributes:{global_id_c:global,description:body}},
      `crm:interactions:v4:${local}:Emails:${sourceHash}`])
    ids.push(outbox)
   }
   const old=async()=> (await c.query('SELECT to_jsonb(o) AS original FROM sync_outbox o WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows
   const original=await old(),sources=await sourceRows()
   const attempt=async(action,expected)=>{
    await c.query('SAVEPOINT refusal')
    await assert.rejects(action,e=>e.code===expected)
    await c.query('ROLLBACK TO SAVEPOINT refusal')
    await c.query('RELEASE SAVEPOINT refusal')
   }
   const blocked=await reservation(c)
   await attempt(()=>reserve(blocked,owner,c),'55000')
   const evidence=(await c.query(`SELECT o.id,i.id AS local_id,i.pipeline_id,i.suitecrm_id AS native_id,i.reference_code AS global_id,
    p.workspace_organization_id AS workspace_id,encode(digest(to_jsonb(o)::text,'sha256'),'hex') AS job_hash,
    encode(digest(to_jsonb(i)::text,'sha256'),'hex') AS source_hash,
    encode(digest(o.payload::text,'sha256'),'hex') AS payload_hash,
    encode(digest(o.idempotency_key,'sha256'),'hex') AS key_hash
    FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id JOIN pipeline_spaces p ON p.id=i.pipeline_id
    WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`,[ids])).rows
   const expectedManifest={version:1,action:'archive_exact_legacy_terminal_rows_only',operationId:batch,publicationDisposition:'archive_only',
    scope:{projectId:randomUUID(),environmentId:randomUUID(),postgresDatabaseFingerprint:hash('synthetic database'),appCommit:'a'.repeat(40),
     nativeDeploymentId:randomUUID(),nativeReplicaId:randomUUID(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('synthetic native')},
    actorEmail:owner,operatorAccountId:account,rootWorkspaceId:root,appGeneration:blocked.generation,
    gateFingerprint:hash('unchanged fixture gate'),appSourceFingerprint:blocked.live.fingerprint,fenceEpoch:epoch,
    fenceEvidenceFingerprint:hash('synthetic fence'),nativeAbsenceFingerprint:hash('synthetic absence'),historicalProviderOutcome:'unknown',
    rows:evidence.map(r=>({outboxId:r.id,localId:r.local_id,pipelineId:r.pipeline_id,workspaceId:r.workspace_id,
     nativeId:r.native_id,globalId:r.global_id,attempts:8,rowFingerprint:r.job_hash,sourceFingerprint:r.source_hash,
     payloadFingerprint:r.payload_hash,keyFingerprint:r.key_hash}))}
   const nowSeconds=Number((await c.query('SELECT floor(extract(epoch FROM clock_timestamp())) AS n')).rows[0].n)
   const manifestDigest=approvalApi.legacyEmailRetirementManifestDigest(expectedManifest)
   const common={version:1,audience:'clawpilot-private-legacy-email-retirement-controller',operationId:batch,manifestDigest,
    issuedAt:nowSeconds,expiresAt:nowSeconds+90}
   const fenceEnvelope=wrap({...common,keyId:'fixture-fence',issuer:'clawpilot-crm-fence-attestor',
    purpose:'clawpilot-legacy-email-fenced-absence-v1'},fenceKey.privateKey)
   const operatorEnvelope=wrap({...common,keyId:'fixture-operator',issuer:'clawpilot-crm-retirement-operator',
    purpose:'clawpilot-legacy-email-retirement-review-v1',fenceEnvelopeDigest:hash(fenceEnvelope)},operatorKey.privateKey)
   const verified=approvalApi.verifyLegacyEmailRetirementApproval({expectedManifest,nowSeconds,fenceEnvelope,operatorEnvelope,
    fenceAnchor:{keyId:'fixture-fence',key:fenceKey.publicKey},operatorAnchor:{keyId:'fixture-operator',key:operatorKey.publicKey}})
   assert.equal(verified.liveFenceProven,false);assert.equal(verified.consumed,false)
   pins=[batch,verified.manifestDigest,verified.approvalEnvelopeDigest]
   const retire=(list=ids,approval=verified.approvalEnvelopeDigest)=>c.query('SELECT crm_retirement_fixture.retire($1,$2,$3) AS n',[batch,list,approval])
   await c.query('SET LOCAL ROLE crm_fixture_retirement_attestor')
   await c.query(`INSERT INTO crm_retirement_fixture.verified_batch VALUES($1,$2,$3,to_timestamp($4),$5,$6,$7,$8)`,
    [batch,blocked.generation,epoch,verified.expiresAt,ids.length,verified.manifestDigest,verified.fenceEnvelopeDigest,verified.approvalEnvelopeDigest])
   for(const row of evidence)await c.query(`INSERT INTO crm_retirement_fixture.review
    VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),'synthetic_fenced_absence_only')`,
    [batch,row.id,blocked.generation,row.job_hash,row.source_hash,epoch,verified.expiresAt])
   await attempt(()=>retire(),'42501')
   await c.query('RESET ROLE')
   await c.query('SET LOCAL ROLE crm_fixture_ordinary_writer')
   await attempt(()=>c.query('SELECT original FROM crm_retirement_fixture.retained'),'42501')
   await attempt(()=>retire(),'42501')
   await attempt(()=>c.query('SELECT crm_retirement_fixture.resolve($1,$2,$3)',pins),'42501')
   await c.query('RESET ROLE')
   await c.query('SAVEPOINT drift')
   await c.query("UPDATE sync_outbox SET last_error='source changed after review' WHERE id=$1",[ids[0]])
   await c.query('SET LOCAL ROLE crm_fixture_retirement_controller')
   await attempt(()=>retire(),'55000')
   await c.query('ROLLBACK TO SAVEPOINT drift')
   await c.query('RELEASE SAVEPOINT drift')
   assert.deepEqual(await old(),original)
   await c.query('SET LOCAL ROLE crm_fixture_retirement_controller')
   await attempt(()=>retire(null),'55000')
   await attempt(()=>retire(ids.slice(1)),'55000')
   await attempt(()=>retire(ids,hash('different approval')),'55000')
   const retained=(await retire()).rows[0].n
   assert.equal(retained,11)
   await attempt(()=>retire(),'55000')
   await attempt(()=>c.query('DELETE FROM crm_retirement_fixture.retained'),'42501')
   await c.query('RESET ROLE')
   assert.deepEqual(await old(),[])
   assert.deepEqual((await c.query('SELECT original FROM crm_retirement_fixture.retained ORDER BY outbox_id')).rows,original)
   assert.deepEqual(await sourceRows(),sources)
   assert.equal((await c.query("SELECT count(*) FROM crm_retirement_fixture.retained WHERE historical_provider_outcome='unknown'")).rows[0].count,'11')
   await c.query('SET LOCAL ROLE crm_fixture_ordinary_writer')
   const raw=original[0].original
   await attempt(()=>c.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES('suitecrm','crm_interactions',$1,'delete_record',$2)`,[raw.aggregate_id,raw.payload]),'55000')
   await attempt(()=>c.query('UPDATE sync_outbox SET payload=$2 WHERE id=$1',[queuedId,raw.payload]),'55000')
   await c.query('RESET ROLE')
   await c.query('SAVEPOINT before_reservation')
   const valid=await reservation(c)
   await reserve(valid,owner,c)
   assert.equal((await c.query('SELECT active_initial_enrollment_id AS op FROM crm_native_email_publication_control')).rows[0].op,valid.operationId)
   await c.query('ROLLBACK TO SAVEPOINT before_reservation')
   await c.query('RELEASE SAVEPOINT before_reservation')
   // A different connection cannot infer non-dispatch from an absent
   // receipt while the controller's transaction is still in flight.
   const beforeCommit=(await query('SELECT crm_retirement_fixture.resolve($1,$2,$3) AS result',pins)).rows[0].result
   assert.deepEqual(beforeCommit,{state:'unknown'})
   })
   throw lost
  },e=>e===lost)
  const resolverPool=new Pool({...localPoolOptions,max:1})
  try{
   const c=await resolverPool.connect()
   try{
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')
    await c.query('SET LOCAL ROLE crm_fixture_retirement_resolver')
    const resolve=async args=>(await c.query('SELECT crm_retirement_fixture.resolve($1,$2,$3) AS result',args)).rows[0].result
    assert.deepEqual(await resolve(pins),{state:'committed',operationId:pins[0],manifestDigest:pins[1],
     approvalDigest:pins[2],rows:11,historicalProviderOutcome:'unknown'})
    assert.deepEqual(await resolve([pins[0],pins[1],hash('wrong approval')]),{state:'unknown'})
    assert.deepEqual(await resolve([randomUUID(),pins[1],pins[2]]),{state:'unknown'})
   }finally{try{await c.query('ROLLBACK')}finally{c.release()}}
  }finally{await resolverPool.end()}
  assert.equal((await query('SELECT count(*) FROM crm_retirement_fixture.retained')).rows[0].count,'11')
  assert.equal((await query('SELECT count(*) FROM crm_retirement_fixture.consumed')).rows[0].count,'1')
 })
 await check('legacy retirement serial fence rejects queue writes using a pre-retirement snapshot',async()=>{
  const stale=await pool.connect()
  try{
   await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
   await stale.query('SET LOCAL ROLE crm_fixture_ordinary_writer')
   await stale.query('SELECT id FROM sync_outbox WHERE id=$1',[queuedId])
   await tx(async c=>{
    await c.query('SELECT 1 FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    await c.query('UPDATE crm_retirement_fixture.serial SET epoch=epoch+1 WHERE singleton')
   })
   await assert.rejects(stale.query('UPDATE sync_outbox SET available_at=now() WHERE id=$1',[queuedId]),e=>e.code==='40001')
  }finally{try{await stale.query('ROLLBACK')}finally{stale.release()}}
 })
 const holdSchema='crm_legacy_email_terminal_hold'
 const heldOutbox=randomUUID(),heldInteraction=randomUUID(),heldNative=randomUUID(),heldSourceHash=hash('synthetic initial hold source')
 const heldAccounts=Array.from({length:2},()=>({local:randomUUID(),native:randomUUID(),contact:randomUUID(),nativeContact:randomUUID()}))
 const heldPrimary=heldAccounts[0],heldAccountIds=heldAccounts.map(a=>a.native).sort(),heldContactIds=heldAccounts.map(a=>a.nativeContact).sort()
 const heldContactAccounts=heldContactIds.map(contactId=>({contactId,accountId:heldAccounts.find(a=>a.nativeContact===contactId).native}))
 const heldRows=async(queryable=pool)=>(await queryable.query(`SELECT o.id,to_jsonb(o)::text AS retained,to_jsonb(i)::text AS source,
   encode(digest(to_jsonb(o)::text,'sha256'),'hex') AS fingerprint
   FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1`,[heldOutbox])).rows
 let heldBefore,heldReceipt,heldManifestRow
 await check('an independently attested live terminal hold joins the existing demo evidence without changing either',async()=>{
  const pipeline=pipelines[0]
  for(const [index,a] of heldAccounts.entries()){
   await query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,
      relationship_type,source_hash,sync_status,suitecrm_synced_at,reference_code)
     VALUES($1,$2,$3,$4,$4,$4,$5,'customer',$6,'synced',now(),allocate_crm_reference('ga'))`,
    [a.local,pipeline,a.native,`synthetic held account ${index}`,index===0?'Customer':'Supplier',hash(a.native)])
   await query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,last_name,
      source_hash,sync_status,suitecrm_synced_at,reference_code)
     VALUES($1,$2,$3,$4,$5,$5,$5,'Contact',$6,'synced',now(),allocate_crm_reference('gc'))`,
    [a.contact,pipeline,a.local,a.nativeContact,`synthetic held contact ${index}`,hash(a.nativeContact)])
  }
  const global=await tx(async c=>{
   await c.query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)")
   const record=(await c.query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,
     reference_code,source_payload,sync_status,provider_message_id,organization_id,contact_id) VALUES($1,$2,'fixture-live-hold','Synthetic held Email',$3,$4,
     'Emails',allocate_crm_reference('gi'),'{}','failed',$5,$6,$7) RETURNING reference_code`,
   [heldInteraction,pipeline,heldSourceHash,heldNative,'ac'+randomUUID().replaceAll('-',''),heldPrimary.local,heldPrimary.contact])).rows[0]
   for(const [index,a] of heldAccounts.entries()){
    await c.query('INSERT INTO crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order) VALUES($1,$2,$3,$4,$5)',
     [pipeline,heldInteraction,a.local,index===0,index])
    await c.query('INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary,sort_order) VALUES($1,$2,$3,$4,$5)',
     [pipeline,heldInteraction,a.contact,index===0,index])
   }
   return record.reference_code
  })
  await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,last_error,processed_at,idempotency_key)
    VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,'native_projection_proof_unavailable',now(),$4)`,
  [heldOutbox,heldInteraction,{entity:'interactions',localId:heldInteraction,pipelineId:pipeline,suiteCrmId:heldNative,
    suiteCrmModule:'Emails',attributes:{global_id_c:global,name:'Synthetic held Email',date_sent_received:'2026-10-30 13:00:00',
     type:'archived',status:'read',description:'SYNTHETIC_BODY_NOT_IN_ENROLLMENT_PROOF',description_html:'',
     parent_type:'Accounts',parent_id:heldPrimary.native,assigned_user_id:'1'},
    relationships:[...heldAccountIds.map(relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})),
     ...heldContactIds.map(relatedBeanId=>({linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId}))],
    emailProjection:{version:1,accounts:heldAccountIds,contacts:heldContactIds,contactAccounts:heldContactAccounts,
     previousManaged:{accounts:[],contacts:[]},audience:{policy:'legacy-fixture-not-approved'}}},
   `crm:interactions:v4:${heldInteraction}:Emails:${heldSourceHash}`])
  heldBefore=await heldRows();assert.equal(heldBefore.length,1)
  const blocked=await reservation()
  await assert.rejects(reserve(blocked),error=>error?.code==='55000'&&/unresolved writers/u.test(error.message))
  const pin=(await query(`SELECT ${holdSchema}.gate_fingerprint() AS gate,
    encode(digest(to_jsonb(i)::text,'sha256'),'hex') AS source,encode(digest(o.payload::text,'sha256'),'hex') AS payload,
    encode(digest(o.idempotency_key,'sha256'),'hex') AS key,${holdSchema}.relationship_fingerprint(i.id) AS relationships,
    ${holdSchema}.provider_identity_fingerprint(i.id) AS provider
    FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=$1`,[heldOutbox])).rows[0]
  const operationId=randomUUID(),expectedManifest={version:1,action:'hold_exact_legacy_terminal_rows_in_place',
    publicationDisposition:'hold_without_publication',operationId,scope:{projectId:randomUUID(),environmentId:randomUUID(),
      postgresDatabaseFingerprint:hash('synthetic initial database'),appCommit:'a'.repeat(40),nativeDeploymentId:randomUUID(),
      nativeReplicaId:randomUUID(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('synthetic initial native database'),
      nativeAuthorityInstanceId:authorityInstance},actorEmail:owner,operatorAccountId:account,rootWorkspaceId:root,
    appGeneration:blocked.generation,gateFingerprint:pin.gate,appSourceFingerprint:blocked.live.fingerprint,fenceEpoch:randomUUID(),
    fenceEvidenceFingerprint:hash('synthetic initial writer fence'),nativeAbsenceFingerprint:hash('synthetic initial native absence'),
    historicalProviderOutcome:'unknown',rows:[{outboxId:heldOutbox,localId:heldInteraction,pipelineId:pipeline,workspaceId:root,
      nativeId:heldNative,globalId:global,attempts:8,rowFingerprint:heldBefore[0].fingerprint,sourceFingerprint:pin.source,
      payloadFingerprint:pin.payload,keyFingerprint:pin.key,relationshipFingerprint:pin.relationships,providerIdentityFingerprint:pin.provider}]}
  heldManifestRow=expectedManifest.rows[0]
  const physical=(await query(`SELECT current_database() AS database,d.oid::text AS "databaseOid",
    system_identifier::text AS "systemIdentifier",SESSION_USER::text AS "observerRole"
    FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() WHERE d.datname=current_database()`)).rows[0]
  const {createLegacyEmailTerminalHoldAppObserver}=load('app_src/lib/persistence/crmLegacyEmailTerminalHoldAppObserver.ts')
  const appObserver=createLegacyEmailTerminalHoldAppObserver(physical,async(_signal,run)=>{
   const observer=await pool.connect()
   try {
    await observer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await observer.query("SET LOCAL TIME ZONE 'UTC'")
    return await run(observer.query.bind(observer))
   } finally {try{await observer.query('ROLLBACK')}finally{observer.release()}}
  })
  const appRequest={phase:'appBefore',observationId:randomUUID(),candidateFingerprint:hash('fixture candidate'),
   target:{...expectedManifest,scope:{...expectedManifest.scope,postgresDatabaseFingerprint:appObserver.storeFingerprint},
    outboxIds:[heldOutbox],postgresObserverFingerprint:appObserver.observerFingerprint}}
  const signal=new AbortController().signal
  const observed=await appObserver.observeApp(appRequest,signal)
  assert.deepEqual(observed.rows,[heldManifestRow],'Read-only application observer pins the same complete row as the SQL hold')
  assert.equal(observed.appGeneration,expectedManifest.appGeneration)
  assert.equal(observed.gateFingerprint,expectedManifest.gateFingerprint)
  assert.equal(observed.appSourceFingerprint,expectedManifest.appSourceFingerprint)
  await assert.rejects(appObserver.observeApp({...appRequest,target:{...appRequest.target,outboxIds:[randomUUID()]}},signal),
   error=>error?.code==='legacy_terminal_hold_app_observer_reviewed_set')
  assert.deepEqual(await heldRows(),heldBefore,'Read-only preview does not modify the original queue or interaction')
  const crypto=require('node:crypto'),approvalApi=load('app_src/lib/crm/legacyEmailRetirementApproval.ts')
  const fenceKey=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),operatorKey=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  const wrap=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(canonical(proof),'ascii'),
   {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
  const nowSeconds=Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())) AS n')).rows[0].n)
  const manifestDigest=approvalApi.legacyEmailTerminalHoldManifestDigest(expectedManifest)
  const common={version:1,audience:'clawpilot-private-legacy-email-hold-controller',operationId,manifestDigest,
   issuedAt:nowSeconds,expiresAt:nowSeconds+110}
  const fenceEnvelope=wrap({...common,keyId:'fixture-fence',issuer:'clawpilot-crm-hold-fence-attestor',
   purpose:'clawpilot-legacy-email-hold-fenced-absence-v1'},fenceKey.privateKey)
  const operatorEnvelope=wrap({...common,keyId:'fixture-operator',issuer:'clawpilot-crm-hold-operator',
   purpose:'clawpilot-legacy-email-hold-review-v1',fenceEnvelopeDigest:hash(fenceEnvelope)},operatorKey.privateKey)
  const permit=approvalApi.verifyLegacyEmailTerminalHoldApproval({expectedManifest,nowSeconds,fenceEnvelope,operatorEnvelope,
   fenceAnchor:{keyId:'fixture-fence',key:fenceKey.publicKey},operatorAnchor:{keyId:'fixture-operator',key:operatorKey.publicKey}})
  assert.equal(permit.liveFenceProven,false)
  const fixtureLogins=[]
  try{
   for(const role of ['crm_fixture_initial_hold_attestor','crm_fixture_initial_hold_controller']){
    const password=randomBytes(32).toString('hex')
    await query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`)
    await query(`GRANT USAGE ON SCHEMA ${holdSchema} TO ${role}`)
    fixtureLogins.push(new Pool({...localPoolOptions,user:role,password,max:1}))
   }
   const [attest,hold]=fixtureLogins
   await query(`GRANT INSERT ON ${holdSchema}.verified_batch TO crm_fixture_initial_hold_attestor;
     GRANT EXECUTE ON FUNCTION ${holdSchema}.hold(uuid,uuid[],text) TO crm_fixture_initial_hold_controller`)
   await attest.query(`INSERT INTO ${holdSchema}.verified_batch(batch,manifest,manifest_canonical,manifest_hash,fence_hash,approval_hash,valid_until)
     VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))`,[operationId,expectedManifest,canonical(expectedManifest),manifestDigest,
    permit.fenceEnvelopeDigest,permit.approvalEnvelopeDigest,permit.expiresAt])
   const exact=(await hold.query(`SELECT ${holdSchema}.hold($1::uuid,$2::uuid[],$3::text) AS n`,
    [operationId,[heldOutbox],permit.approvalEnvelopeDigest])).rows[0]
   assert.equal(exact.n,1)
  }finally{await Promise.all(fixtureLogins.map(db=>db.end()))}
  heldReceipt=(await query(`SELECT ${holdSchema}.resolve($1::uuid,$2::text,$3::text) AS receipt`,
    [operationId,manifestDigest,permit.approvalEnvelopeDigest])).rows[0].receipt
  assert.equal(heldReceipt.state,'committed');assert.equal(heldReceipt.rows,1)
  assert.deepEqual(await heldRows(),heldBefore)
  assert.deepEqual(await quarantineRows(),quarantineBefore)
  assert.deepEqual((await snapshot()).s,blocked.live.s,'Holding must not change the enrollment inventory')
 })
 await check('unrelated terminal jobs and competing held identities still block; a different native scope cannot reserve',async()=>{
  const mismatch=await reservation();mismatch.nativeInstanceId=randomUUID()
  const unresolved=error=>error?.code==='55000'&&/unresolved writers/u.test(error.message)
  await assert.rejects(tx(async c=>{
   await reserve(mismatch,owner,c);throw new Error('Wrong authority instance unexpectedly reserved')
  }),unresolved)
  await assert.rejects(tx(async c=>{
   await c.query("UPDATE sync_outbox SET status='dead',attempts=8,last_error='synthetic unheld job',processed_at=now() WHERE id=$1",[queuedId])
   await reserve(await reservation(c),owner,c);throw new Error('Unheld terminal job unexpectedly permitted reservation')
  }),unresolved)
  await assert.rejects(query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES('suitecrm','crm_interactions',$1,'upsert_record','{}')`,[heldInteraction]),
  error=>error?.code==='55000'&&/Terminal Email hold/u.test(error.message))
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
  for(const [sql,params]of [
   ['UPDATE crm_products SET pipeline_id=pipeline_id WHERE id=$1',[quarantineProduct]],
   ['UPDATE crm_products SET suitecrm_id=suitecrm_id WHERE id=$1',[quarantineProduct]],
   ['UPDATE crm_products SET source_payload=source_payload WHERE id=$1',[quarantineProduct]],
   ['DELETE FROM crm_products WHERE id=$1',[quarantineProduct]],
   ['TRUNCATE crm_products CASCADE',[]],
  ])await assert.rejects(query(sql,params),refusal)
  await assert.rejects(query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
   VALUES($1,$2,'{}',$3)`,[pipelines[0],reserved.generation,hash('unbound-policy')]),refusal)
 })
 await check('admission independently requires the exact consumed hold even with an unchanged reserved source',async()=>{
  const candidate=await fixture(reserved)
  await assert.rejects(tx(async c=>{
   // Simulate private evidence loss only inside an always-rolled-back
   // synthetic transaction; do not change the enrolled source or gate.
   await c.query(`ALTER TABLE ${holdSchema}.consumed DISABLE TRIGGER crm_terminal_hold_immutable`)
   assert.equal((await c.query(`DELETE FROM ${holdSchema}.consumed WHERE batch=$1`,[heldReceipt.operationId])).rowCount,1)
   assert.deepEqual(await snapshot(c),reserved.live)
   await insert(candidate,owner,c)
   throw new Error('Admission unexpectedly accepted a missing consumed hold receipt')
  }),error=>error?.code==='55000'&&/unresolved writers/u.test(error.message))
  assert.equal((await query(`SELECT count(*)::int AS n FROM ${holdSchema}.consumed WHERE batch=$1`,[heldReceipt.operationId])).rows[0].n,1)
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_initial_enrollments')).rows[0].n,0)
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
  assert.equal(e.source_snapshot.pendingOutbox.length,4)
  assert.equal(e.source_snapshot.pendingOutbox.find(row=>row.id===heldOutbox)?.rowFingerprint,heldBefore[0].fingerprint)
  assert.ok(!e.source_snapshot.emails.some(row=>row.localId===heldInteraction),'Unpublished held Email must stay outside the native published inventory')
  assert.deepEqual(await heldRows(),heldBefore,'Initial admission leaves the live terminal row untouched')
  assert.deepEqual(await quarantineRows(),quarantineBefore,'Initial admission retains the original demo jobs instead of replaying or discarding them')
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
  assert.deepEqual(await heldRows(),heldBefore,'Activation must not change the original held row or mark it synced')
  assert.deepEqual(await quarantineRows(),quarantineBefore,'Replan and activation preserve every terminal demo quarantine row byte-for-byte')
  const retainedSources=(await query('SELECT source_snapshot FROM crm_native_email_initial_reservations ORDER BY operation_id')).rows
  for(const source of retainedSources)for(const row of [...quarantineBefore,...heldBefore])
   assert.equal(source.source_snapshot.pendingOutbox.find(p=>p.id===row.id)?.rowFingerprint,row.fingerprint)
  await assert.rejects(query("UPDATE sync_outbox SET status='queued',attempts=0 WHERE id=$1",[heldOutbox]),
    error=>error?.code==='55000'&&/Terminal Email hold/u.test(error.message))
  assert.deepEqual((await query('SELECT public.clawpilot_crm_legacy_email_stage_source($1::uuid,$2::text) AS value',
    [heldOutbox,heldReceipt.receiptHash])).rows[0].value,{state:'unknown'},'Activation is not permission to stage or publish a held source')
  assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work')).rows[0].n,0)
  await assert.rejects(query("UPDATE crm_native_email_initial_enrollments SET state='unknown',native_receipt=NULL,receipt_canonical=NULL,receipt_hash=NULL,settling_xid=NULL"),refusal)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET enabled=false'),refusal)
  await query('UPDATE crm_native_email_publication_control SET updated_at=clock_timestamp()')
  await assert.rejects(query("UPDATE app_users SET suitecrm_user_id='rebound' WHERE email=$1",[owner]),refusal)
 })
 const recoveryAttestor='crm_fixture_held_recovery_attestor',recoveryController='crm_fixture_held_recovery_controller'
 const recoveryRolePools=[]
 try{
  await check('held recovery stage and exact resolution are private; enrollment alone cannot create a staged claim',async()=>{
   await query('CREATE ROLE crm_fixture_unprivileged_recovery NOLOGIN')
   const privileges=(await query(`SELECT has_schema_privilege('crm_fixture_unprivileged_recovery',$1,'USAGE') AS schema,
     has_table_privilege('crm_fixture_unprivileged_recovery',$2,'INSERT') AS attest,
     has_function_privilege('crm_fixture_unprivileged_recovery',$3,'EXECUTE') AS stage,
     has_function_privilege('crm_fixture_unprivileged_recovery',$4,'EXECUTE') AS resolve`,[holdSchema,
    `${holdSchema}.verified_recovery`,`${holdSchema}.stage_recovery(uuid,text,jsonb)`,`${holdSchema}.resolve_recovery(uuid,text,text)`])).rows[0]
   assert.deepEqual(privileges,{schema:false,attest:false,stage:false,resolve:false})
   assert.deepEqual((await query(`SELECT ${holdSchema}.resolve_recovery($1::uuid,$2,$3) AS value`,
    [heldOutbox,hash('unstaged intent'),hash('unstaged approval')])).rows[0].value,{state:'unknown'})
   assert.deepEqual(await heldRows(),heldBefore)
  })
  for(const role of [recoveryAttestor,recoveryController]){
   const password=randomBytes(32).toString('hex')
   await query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`)
   await query(`GRANT USAGE ON SCHEMA ${holdSchema} TO ${role}`)
   recoveryRolePools.push(new Pool({...localPoolOptions,user:role,password,max:1}))
  }
  const [attest,stage]=recoveryRolePools
  await query(`GRANT INSERT ON ${holdSchema}.verified_recovery TO ${recoveryAttestor};
    GRANT EXECUTE ON FUNCTION ${holdSchema}.stage_recovery(uuid,text,jsonb),
      ${holdSchema}.resolve_recovery(uuid,text,text) TO ${recoveryController}`)
  const {heldStage,heldApproval:recoveryApproval}=loadNativeJointLegacyEmailRecoveryApp({query,withTransaction:tx,getPostgresPool:()=>pool})
  // Disposable fixture reads the actual source, mappings and current audience
  // through separate direct logins. These grants are not a production role.
  await query(`GRANT SELECT (outbox_id,batch,local_id,pipeline_id,workspace_id,native_id,global_id,row_fingerprint,original)
      ON ${holdSchema}.held TO ${recoveryController};
    GRANT SELECT (batch,manifest,valid_until) ON ${holdSchema}.verified_batch TO ${recoveryController};
    GRANT SELECT (batch,consumed_at,held_rows,receipt_hash) ON ${holdSchema}.consumed TO ${recoveryController};
    GRANT SELECT ON crm_interactions,sync_outbox,crm_native_email_publication_control,crm_native_email_publication_admissions TO ${recoveryController};
    GRANT UPDATE (updated_at) ON crm_interactions,crm_native_email_publication_control TO ${recoveryController};
    GRANT SELECT (id,workspace_organization_id,owner_email,reference_access_disabled) ON pipeline_spaces TO ${recoveryController};
    GRANT SELECT (id,parent_id,organization_type,is_demo) ON workspace_organizations TO ${recoveryController};
    GRANT SELECT (email,role,status,suitecrm_user_id) ON app_users TO ${recoveryController};
    GRANT SELECT (user_email,organization_id,role,status,permissions,trashed_at) ON app_user_organization_memberships TO ${recoveryController};
    GRANT SELECT (pipeline_id,user_email,access_role) ON pipeline_space_members TO ${recoveryController};
    GRANT SELECT (id,root_workspace_id,owner_email,enabled) ON crm_operator_accounts TO ${recoveryController};
    GRANT SELECT (operator_account_id,workspace_id,owner_email,enabled) ON crm_operator_workspace_bindings TO ${recoveryController};
    GRANT SELECT (id,operator_account_id) ON crm_root_employee_access_grants TO ${recoveryController};
    GRANT SELECT (pipeline_id,generation,policy,fingerprint) ON crm_native_email_capability_policies TO ${recoveryController};
    GRANT SELECT (pipeline_id,id,suitecrm_id,source_payload) ON crm_organizations TO ${recoveryController};
    GRANT SELECT (pipeline_id,id,suitecrm_id,organization_id,source_payload) ON crm_contacts TO ${recoveryController};
    GRANT SELECT ON crm_interaction_organizations,crm_interaction_contacts TO ${recoveryController};
    GRANT EXECUTE ON FUNCTION ${holdSchema}.relationship_fingerprint(uuid),${holdSchema}.provider_identity_fingerprint(uuid),
      public.clawpilot_crm_legacy_email_live_relationships(uuid,uuid),
      public.clawpilot_crm_legacy_email_provider_identity_unambiguous(uuid,uuid) TO ${recoveryController}`)
  const roleTransaction=db=>async action=>{
   const client=await db.connect()
   try{
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const result=await action(client)
    await client.query('COMMIT');return result
   }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  const controllerTransaction=roleTransaction(stage),attestTransaction=roleTransaction(attest)
  const crypto=require('node:crypto')
  const operatorKey=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),keyId='fixture-recovery-operator'
  const dbTime=async()=>Number((await query('SELECT floor(extract(epoch FROM clock_timestamp())) AS n')).rows[0].n)
  const control=(await query(`SELECT generation,activation_receipt_hash,native_policy_fingerprint
    FROM crm_native_email_publication_control WHERE singleton`)).rows[0]
  const expected=(await query(`SELECT payload,encode(digest(payload::text,'sha256'),'hex') AS payload_hash,
    idempotency_key,policy,fingerprint AS policy_fingerprint FROM (
    SELECT jsonb_set(o.payload,'{emailProjection,audience}',jsonb_build_object('policy','pipeline-internal',
     'pipelineId',p.pipeline_id,'workspaceId',p.policy->>'workspaceId','ownerSuiteCrmId',p.policy->>'ownerSuiteCrmId',
     'allowedSuiteCrmUserIds',p.policy#>'{futureCreate,view}','fingerprint',p.policy->>'audienceFingerprint'),true) AS payload,
     o.idempotency_key,p.policy,p.fingerprint
    FROM sync_outbox o JOIN crm_native_email_capability_policies p ON p.pipeline_id::text=o.payload->>'pipelineId'
    WHERE o.id=$1) q`,[heldOutbox])).rows[0]
  assert.ok(expected?.payload?.emailProjection?.audience)
  // The worker hashes parsed JSONB (JSON.stringify), while the stage pins
  // SQL's jsonb::text bytes. Both must be exact, and the hashes differ.
  const workerPayloadHash=crypto.createHash('sha256').update(JSON.stringify(expected.payload)).digest('hex')
  const workContext={kind:'outbox',outboxId:heldOutbox,idempotencyKey:expected.idempotency_key,
   sourceHash:heldSourceHash,payloadHash:workerPayloadHash,attempt:1}
  const exactRequest=lockToken=>{
   const generation=Number(control.generation),projection=expected.payload.emailProjection
   const operationId=hash({outboxId:heldOutbox,idempotencyKey:expected.idempotency_key,payloadHash:workerPayloadHash,
    attempt:1,claim:lockToken,generation})
   return protocol.prepareNativeEmailPublication({command:{version:2,mode:'publish',operationId,workspaceId:root,
    pipelineId:pipelines[0],generation,audienceFingerprint:projection.audience.fingerprint,suiteCrmId:heldNative,
    globalId:heldManifestRow.globalId,localId:heldInteraction,expectedRecordFingerprint:null,
    projection:{attributes:expected.payload.attributes,accounts:projection.accounts,contacts:projection.contacts,
     contactAccounts:projection.contactAccounts,previousManaged:projection.previousManaged},
    capabilityPolicyFingerprint:expected.policy_fingerprint,principalSuiteCrmUserIds:expected.policy.principalSuiteCrmUserIds,
    expectedCapabilities:expected.policy.futureCreate},nativePolicyFingerprint:control.native_policy_fingerprint,
    allowedReaderSuiteCrmUserIds:projection.audience.allowedSuiteCrmUserIds})
  }
  const baselineOther=(await query('SELECT to_jsonb(o)::text AS row FROM sync_outbox o WHERE id<>$1 ORDER BY id',[heldOutbox])).rows
  const proofFor=async (overrides={},now)=>{
   const verifiedAt=now??await dbTime(),lockToken=overrides.lockToken??randomUUID(),request=exactRequest(lockToken)
   const proof={version:1,purpose:'clawpilot-private-legacy-held-email-recovery-v1',keyId,
    issuedAt:verifiedAt,expiresAt:verifiedAt+110,holdBatchId:heldReceipt.operationId,outboxId:heldOutbox,
    localId:heldInteraction,nativeId:heldNative,pipelineId:pipelines[0],workspaceId:root,nativeAuthorityInstanceId:authorityInstance,
    lockToken,holdReceiptHash:heldReceipt.receiptHash,originalFingerprint:heldManifestRow.rowFingerprint,
    sourceFingerprint:heldManifestRow.sourceFingerprint,relationshipFingerprint:heldManifestRow.relationshipFingerprint,
    providerIdentityFingerprint:heldManifestRow.providerIdentityFingerprint,activationReceiptHash:control.activation_receipt_hash,
    stagedPayloadFingerprint:expected.payload_hash,requestFingerprint:request.requestFingerprint,
    nativeOperationId:request.command.operationId,globalId:heldManifestRow.globalId,
    generation:Number(control.generation),primaryAccountId:heldPrimary.native,accountIds:heldAccountIds,...overrides}
   const proofText=canonical(proof)
   const envelope={proof,signature:crypto.sign('sha256',Buffer.from(proofText,'ascii'),
    {key:operatorKey.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')}
   const verified=recoveryApproval.verifyLegacyHeldEmailRecoveryApproval({envelope,nowSeconds:verifiedAt,
    operatorAnchor:{keyId,key:operatorKey.publicKey}})
   recoveryApproval.assertVerifiedLegacyHeldEmailRecoveryApproval(verified)
   return {proof,proofText,verified,request}
  }
  const register=({proof,proofText,verified},queryable=attest,approvalHash=verified.approvalHash)=>queryable.query(`INSERT INTO ${holdSchema}.verified_recovery
   (outbox_id,proof,proof_canonical,proof_hash,intent_hash,approval_hash,valid_until) VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))`,
  [proof.outboxId,proof,proofText,hash(proof),verified.intentHash,approvalHash,proof.expiresAt])
  const stageWith=async (approvalHash,payload=expected.payload,queryable=stage,id=heldOutbox)=>(await queryable.query(
   `SELECT ${holdSchema}.stage_recovery($1::uuid,$2,$3::jsonb) AS value`,[id,approvalHash,payload])).rows[0].value
  const resolveWith=async (intentHash,approvalHash)=>(await stage.query(
   `SELECT ${holdSchema}.resolve_recovery($1::uuid,$2,$3) AS value`,[heldOutbox,intentHash,approvalHash])).rows[0].value
  const stageRefused=error=>error?.code==='55000'
  let valid=await proofFor(),{verified}=valid
  let stageReceipt
  await check('stage refuses a missing, same-login, expired or substituted approval without changing the terminal row',async()=>{
   await assert.rejects(stageWith(verified.approvalHash),stageRefused)
   await assert.rejects(register(valid,stage),error=>error?.code==='42501')
   await assert.rejects(stageWith(verified.approvalHash,expected.payload,attest),error=>error?.code==='42501')
   await assert.rejects(tx(async c=>{
    await c.query(`SET LOCAL ROLE ${recoveryAttestor}`);await register(valid,c)
   }),stageRefused)
   await register(valid)
   await assert.rejects(tx(async c=>{
    await c.query(`SET LOCAL ROLE ${recoveryController}`);await stageWith(verified.approvalHash,expected.payload,c)
   }),stageRefused)
   await query(`GRANT EXECUTE ON FUNCTION ${holdSchema}.stage_recovery(uuid,text,jsonb) TO ${recoveryAttestor}`)
   await assert.rejects(stageWith(verified.approvalHash,expected.payload,attest),stageRefused)
   await query(`REVOKE EXECUTE ON FUNCTION ${holdSchema}.stage_recovery(uuid,text,jsonb) FROM ${recoveryAttestor}`)
   await assert.rejects(stageWith(verified.approvalHash,expected.payload,stage,queuedId),stageRefused)
   const expired=await proofFor({},await dbTime()-150);await register(expired)
   await assert.rejects(stageWith(expired.verified.approvalHash),stageRefused)
   for(const changed of [{nativeAuthorityInstanceId:randomUUID()},{activationReceiptHash:hash('stale activation')},
    {generation:verified.generation+1},{holdReceiptHash:hash('unrelated hold')},{originalFingerprint:hash('other original')},
    {sourceFingerprint:hash('other source')},{relationshipFingerprint:hash('other relationship')},
    {providerIdentityFingerprint:hash('other provider identity')},{primaryAccountId:heldAccounts[1].native},
    {accountIds:[heldPrimary.native]}]){
    const candidate=await proofFor(changed);await register(candidate)
    await assert.rejects(stageWith(candidate.verified.approvalHash),stageRefused)
   }
   const altered=copy(expected.payload);altered.attributes.description='not reviewed'
   await assert.rejects(stageWith(verified.approvalHash,altered),stageRefused)
   const alteredHash=(await query("SELECT encode(digest($1::jsonb::text,'sha256'),'hex') AS digest",[altered])).rows[0].digest
   const signedWrongPayload=await proofFor({stagedPayloadFingerprint:alteredHash});await register(signedWrongPayload)
   await assert.rejects(stageWith(signedWrongPayload.verified.approvalHash,altered),stageRefused)
   // Native authority 0397 rejects a direct binding edit after activation.
   // Do not disable that fence merely to manufacture a stale stage fixture.
   await assert.rejects(query(`UPDATE crm_operator_workspace_bindings SET enabled=false,revision=revision+1
     WHERE operator_account_id=$1 AND workspace_id=$2`,[account,root]),stageRefused)
   assert.equal((await query('SELECT enabled FROM crm_operator_workspace_bindings WHERE operator_account_id=$1 AND workspace_id=$2',
    [account,root])).rows[0].enabled,true)
   const contact=heldAccounts[1]
   await query('UPDATE crm_contacts SET suitecrm_id=$2 WHERE id=$1',[contact.contact,randomUUID()])
   try{await assert.rejects(stageWith(verified.approvalHash),stageRefused)}
   finally{await query('UPDATE crm_contacts SET suitecrm_id=$2 WHERE id=$1',[contact.contact,contact.nativeContact])}
   assert.deepEqual(await heldRows(),heldBefore)
   assert.deepEqual(await resolveWith(verified.intentHash,verified.approvalHash),{state:'unknown'})
  })
  await check('actual held preview and signed stage match the independent SQL pins, park the same job and write no native work',async()=>{
   // Keep the already-registered raw SQL negative fixture separate from the
   // actual adapter's independent approval registration and stage transaction.
   valid=await proofFor();verified=valid.verified
   const target={holdId:heldReceipt.operationId,outboxId:heldOutbox,holdReceiptHash:heldReceipt.receiptHash,lockToken:verified.lockToken}
   const {version,purpose,keyId:reviewKey,issuedAt,expiresAt,...expectedPins}=valid.proof
   const preview=await heldStage.previewHeldOriginalRecovery(controllerTransaction,target)
   assert.deepEqual(preview,{pins:expectedPins})
   assert.ok(!JSON.stringify(preview).includes('SYNTHETIC_BODY_NOT_IN_ENROLLMENT_PROOF'))
   assert.deepEqual(await heldRows(),heldBefore,'Actual preview must not park the outbox')
   const receipt=await heldStage.stageHeldOriginalRecovery({transaction:controllerTransaction,attestTransaction,
    attestorUser:recoveryAttestor,target,approval:verified})
   stageReceipt=receipt.receiptHash
   assert.deepEqual(receipt,{state:'staged',holdBatchId:heldReceipt.operationId,outboxId:heldOutbox,intentHash:verified.intentHash,
    approvalHash:verified.approvalHash,receiptHash:receipt?.receiptHash})
   assert.match(receipt.receiptHash,/^[a-f0-9]{64}$/u)
   assert.deepEqual(await resolveWith(verified.intentHash,verified.approvalHash),receipt)
   assert.deepEqual(await heldStage.inspectHeldOriginalRecovery(controllerTransaction,{
    outboxId:heldOutbox,intentHash:verified.intentHash,approvalHash:verified.approvalHash}),receipt)
   assert.deepEqual(await resolveWith(hash('other intent'),verified.approvalHash),{state:'unknown'})
   assert.deepEqual(await resolveWith(verified.intentHash,hash('other approval')),{state:'unknown'})
   assert.deepEqual((await query(`SELECT ${holdSchema}.resolve($1::uuid,$2,$3) AS value`,
    [heldReceipt.operationId,heldReceipt.manifestDigest,heldReceipt.approvalDigest])).rows[0].value,{state:'unknown'},
   'The live terminal-byte receipt does not claim the source is still terminal after stage')
   const retained=(await query(`SELECT original::text AS row FROM ${holdSchema}.held WHERE outbox_id=$1`,[heldOutbox])).rows[0].row
   assert.equal(retained,heldBefore[0].retained,'Retain the original terminal row independently and byte-for-byte')
   const [parked]=await heldRows(),old=JSON.parse(retained),post=JSON.parse(parked.retained)
   assert.equal(parked.source,heldBefore[0].source)
   for(const key of ['id','idempotency_key','created_at','target_system','operation','aggregate_type','aggregate_id'])
    assert.equal(post[key],old[key],`${key} must remain unchanged`)
   assert.equal(post.status,'processing');assert.equal(post.attempts,1);assert.equal(post.available_at,'infinity')
   assert.equal(post.lock_token,verified.lockToken);assert.ok(post.locked_at);assert.deepEqual(post.payload,expected.payload)
   assert.deepEqual((await query('SELECT to_jsonb(o)::text AS row FROM sync_outbox o WHERE id<>$1 ORDER BY id',[heldOutbox])).rows,baselineOther)
   assert.deepEqual(await quarantineRows(),quarantineBefore)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work')).rows[0].n,0)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_admissions')).rows[0].n,0)
   await assert.rejects(query("UPDATE sync_outbox SET status='queued',available_at=now() WHERE id=$1",[heldOutbox]),stageRefused)
   await assert.rejects(query("DELETE FROM sync_outbox WHERE id=$1",[heldOutbox]),stageRefused)
   const another=await proofFor();await register(another)
   await assert.rejects(stageWith(another.verified.approvalHash),stageRefused)
   assert.deepEqual(await heldRows(),[parked]);assert.deepEqual(await resolveWith(verified.intentHash,verified.approvalHash),receipt)
  })
  const releaseName=`${holdSchema}.register_release`
  const releaseReadName=`${holdSchema}.resolve_release`
  const request=valid.request,command=request.command,operationId=command.operationId,leaseOwner=randomUUID()
  const registerRelease=(db,approvalHash=verified.approvalHash,id=heldOutbox)=>db.query(
   `SELECT ${releaseName}($1::uuid,$2::text)`,[id,approvalHash])
  const readRelease=async ({id=heldOutbox,receipt=stageReceipt,operation=operationId,fingerprint=request.requestFingerprint}={},db=stage)=>
   (await db.query(`SELECT ${releaseReadName}($1::uuid,$2::text,$3::text,$4::text) AS value`,[id,receipt,operation,fingerprint])).rows[0].value
  const assertUnreadableRelease=async()=>{
   for(const wrong of [{id:randomUUID()},{receipt:hash('wrong stage receipt')},{operation:hash('wrong native operation')},
    {fingerprint:hash('wrong request fingerprint')}])assert.deepEqual(await readRelease(wrong),{state:'unknown'})
  }
  const addWork=(db,context=workContext)=>db.query(`INSERT INTO crm_native_email_publication_work
   (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
   VALUES($1,$2,'outbox',$3::jsonb,$4,$5,1,clock_timestamp()+interval '120 seconds')`,
  [operationId,request.requestFingerprint,canonical(context),hash(context),leaseOwner])
  const addAdmission=(db,projected=command)=>db.query(`INSERT INTO crm_native_email_publication_admissions
   (operation_id,pipeline_id,local_id,native_id,global_id,generation,native_policy_fingerprint,command_hash,
    audience_fingerprint,command,allowed_reader_ids,request_fingerprint)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,[operationId,command.pipelineId,
   command.localId,command.suiteCrmId,command.globalId,command.generation,request.nativePolicyFingerprint,
   hash(projected),command.audienceFingerprint,canonical(projected),canonical(request.allowedReaderSuiteCrmUserIds),request.requestFingerprint])
  const directControllerTx=async action=>{
   const c=await stage.connect();try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const value=await action(c)
    await c.query('COMMIT');return value}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
  }
  const makeActive=(db)=>db.query(`UPDATE crm_native_email_publication_control SET active_operation_id=$1,updated_at=clock_timestamp()
   WHERE singleton AND active_operation_id IS NULL RETURNING active_operation_id`,[operationId])
  const dispatch=(db)=>db.query(`UPDATE crm_native_email_publication_admissions SET state='dispatched',updated_at=clock_timestamp()
   WHERE operation_id=$1 AND state='admitted' RETURNING operation_id`,[operationId])
  const assertNoRelease=async parked=>{
   assert.equal((await query('SELECT active_operation_id FROM crm_native_email_publication_control WHERE singleton')).rows[0].active_operation_id,null)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work')).rows[0].n,0)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_admissions')).rows[0].n,0)
   assert.deepEqual(await heldRows(),parked)
  }
  await check('private held release requires complete exact same-transaction work, admission and first-dispatch CAS',async()=>{
   assert.deepEqual((await query(`SELECT has_function_privilege('crm_fixture_unprivileged_recovery',$1,'EXECUTE') AS register,
     has_function_privilege('crm_fixture_unprivileged_recovery',$2,'EXECUTE') AS resolve`,
    [`${releaseName}(uuid,text)`,`${releaseReadName}(uuid,text,text,text)`])).rows[0],{register:false,resolve:false})
   await query(`GRANT EXECUTE ON FUNCTION ${releaseName}(uuid,text),${releaseReadName}(uuid,text,text,text) TO ${recoveryController};
    GRANT SELECT ON crm_native_email_publication_control,crm_native_email_publication_work,crm_native_email_publication_admissions TO ${recoveryController};
    GRANT INSERT (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
     ON crm_native_email_publication_work TO ${recoveryController};
    GRANT INSERT (operation_id,pipeline_id,local_id,native_id,global_id,generation,native_policy_fingerprint,command_hash,
     audience_fingerprint,command,allowed_reader_ids,request_fingerprint)
     ON crm_native_email_publication_admissions TO ${recoveryController};
    GRANT UPDATE (active_operation_id,updated_at) ON crm_native_email_publication_control TO ${recoveryController};
    GRANT UPDATE (state,updated_at) ON crm_native_email_publication_admissions TO ${recoveryController}`)
   const parked=await heldRows()
   await assert.rejects(registerRelease(attest),error=>error?.code==='42501')
   await assert.rejects(readRelease({},attest),error=>error?.code==='42501')
   assert.deepEqual(await readRelease(),{state:'staged'})
   await assertUnreadableRelease()
   await assert.rejects(tx(async c=>{await c.query(`SET LOCAL ROLE ${recoveryController}`);await registerRelease(c)}),stageRefused)
   await assert.rejects(registerRelease(stage,hash('unknown release approval')),stageRefused)
   await assert.rejects(registerRelease(stage,verified.approvalHash,queuedId),stageRefused)
   await assert.rejects(addWork(stage),stageRefused)
   await assert.rejects(addAdmission(stage),stageRefused)
   await assert.rejects(directControllerTx(c=>registerRelease(c)),error=>stageRefused(error)||error?.code==='23503')
   await assert.rejects(directControllerTx(async c=>{
    await registerRelease(c);await addWork(c);await addAdmission(c);await makeActive(c)
   }),stageRefused,'A transaction leaving the admission only admitted must roll back')
   for(const alteredContext of [{...workContext,outboxId:queuedId},{...workContext,payloadHash:hash('wrong work payload')}])
    await assert.rejects(directControllerTx(async c=>{
     await registerRelease(c);await addWork(c,alteredContext);await addAdmission(c);await makeActive(c);await dispatch(c)
    }),stageRefused)
   const altered=copy(command);altered.projection.attributes.description='not staged'
   await assert.rejects(directControllerTx(async c=>{
    await registerRelease(c);await addWork(c);await addAdmission(c,altered);await makeActive(c);await dispatch(c)
   }),stageRefused)
   await assertNoRelease(parked)
   assert.deepEqual(await readRelease(),{state:'staged'})
  })
  await check('exact private release commits one work/admission on the original UUID and fences selected relationship mappings',async()=>{
   const parked=await heldRows()
   await directControllerTx(async c=>{
    await registerRelease(c);assert.equal((await addWork(c)).rowCount,1);assert.equal((await addAdmission(c)).rowCount,1)
    assert.equal((await makeActive(c)).rows[0].active_operation_id,operationId)
    assert.equal((await dispatch(c)).rows[0].operation_id,operationId)
   })
   const r=(await query(`SELECT c.active_operation_id,a.state,a.native_receipt,a.command,a.request_fingerprint,w.context,w.context_hash,
     w.lease_owner,w.lease_fence FROM crm_native_email_publication_control c JOIN crm_native_email_publication_admissions a
     ON a.operation_id=c.active_operation_id JOIN crm_native_email_publication_work w USING(operation_id) WHERE c.singleton`)).rows[0]
   assert.equal(r.active_operation_id,operationId);assert.equal(r.state,'dispatched');assert.equal(r.native_receipt,null)
   assert.deepEqual(r.command,command);assert.equal(r.request_fingerprint,request.requestFingerprint)
   assert.deepEqual(r.context,workContext);assert.equal(r.context_hash,hash(workContext));assert.equal(r.lease_owner,leaseOwner)
   assert.equal(Number(r.lease_fence),1)
   assert.deepEqual(await heldRows(),parked)
   assert.deepEqual(await readRelease(),{state:'dispatched'})
   await assertUnreadableRelease()
   assert.deepEqual((await query('SELECT to_jsonb(o)::text AS row FROM sync_outbox o WHERE id<>$1 ORDER BY id',[heldOutbox])).rows,baselineOther)
   await assert.rejects(registerRelease(stage),stageRefused)
   await assert.rejects(query('UPDATE crm_contacts SET suitecrm_id=$2 WHERE id=$1',[heldPrimary.contact,randomUUID()]),stageRefused)
   await assert.rejects(query('UPDATE crm_organizations SET suitecrm_id=$2 WHERE id=$1',[heldPrimary.local,randomUUID()]),stageRefused)
   await assert.rejects(query("UPDATE crm_native_email_publication_control SET active_operation_id=NULL WHERE singleton"),stageRefused)
   assert.deepEqual(await heldRows(),parked)
  })
  const settlementName=`${holdSchema}.settle_release`
  const claimName=`${holdSchema}.claim_resolution`
  const receiptTable=`${holdSchema}.verified_receipts`
  const transport=load('app_src/lib/crm/nativeEmailPublicationTransport.ts')
  const recordFingerprint=hash('synthetic native record fingerprint; not provider evidence')
  const receipt={version:2,operationId,commandHash:request.commandHash,state:'committed',replayed:false,result:{
   version:2,mode:'publish',suiteCrmId:heldNative,globalId:command.globalId,pipelineId:command.pipelineId,generation:command.generation,
   audienceFingerprint:command.audienceFingerprint,recordFingerprint,readerSuiteCrmUserIds:request.allowedReaderSuiteCrmUserIds,
   capabilityPolicyFingerprint:command.capabilityPolicyFingerprint,principalSuiteCrmUserIds:command.principalSuiteCrmUserIds,
   expectedCapabilities:command.expectedCapabilities,projection:{version:2,suiteCrmId:heldNative,
    sourceAttributes:command.projection.attributes,attributes:{...command.projection.attributes,created_by:'1',deleted:'0',
     description_html:'<p>SYNTHETIC_BODY_NOT_IN_ENROLLMENT_PROOF</p>',from_addr_name:'',to_addrs_names:'',cc_addrs_names:'',bcc_addrs_names:'',reply_to_addrs_names:''},
    accounts:command.projection.accounts,contacts:command.projection.contacts,contactAccounts:command.projection.contactAccounts,
    snapshotFingerprint:recordFingerprint,dateSentReceivedUtc:'2026-10-30T13:00:00Z'}}}
  assert.deepEqual(transport.verifyNativeEmailPublicationReceipt(request,receipt),receipt)
  const settleWith=async ({id=heldOutbox,operation=operationId,owner=leaseOwner,fence=1,native=receipt}={},db=stage)=>
   (await db.query(`SELECT ${settlementName}($1::uuid,$2::text,$3::uuid,$4::bigint,$5::jsonb) AS value`,
    [id,operation,owner,fence,canonical(native)])).rows[0].value
  const receiptDigest=async native=>(await query("SELECT encode(digest($1::jsonb::text,'sha256'),'hex') AS value",[canonical(native)])).rows[0].value
  const attestReceipt=async (native=receipt,db=attest)=>db.query(`INSERT INTO ${receiptTable}(native_operation_id,receipt_hash,lease_fence)
    VALUES($1,$2,1)`,[operationId,await receiptDigest(native)])
  const claimResolution=async ({id=heldOutbox,operation=operationId,owner=leaseOwner}={},db=stage)=>(await db.query(
   `SELECT ${claimName}($1::uuid,$2::text,$3::uuid) AS value`,[id,operation,owner])).rows[0].value
  const heldAdmission=async()=>(await query(`SELECT a.state,a.native_receipt,c.active_operation_id,w.lease_owner,w.lease_fence
   FROM crm_native_email_publication_admissions a JOIN crm_native_email_publication_work w USING(operation_id)
   CROSS JOIN crm_native_email_publication_control c WHERE a.operation_id=$1 AND c.singleton`,[operationId])).rows[0]
  await check('the exact private resolver reads its live lease without extending it; wrong owners and roles cannot claim it',async()=>{
   assert.equal((await query(`SELECT has_function_privilege('crm_fixture_unprivileged_recovery',$1,'EXECUTE') AS allowed`,
    [`${claimName}(uuid,text,uuid)`])).rows[0].allowed,false)
   await query(`GRANT EXECUTE ON FUNCTION ${claimName}(uuid,text,uuid) TO ${recoveryController}`)
   await assert.rejects(claimResolution({},attest),error=>error?.code==='42501')
   for(const wrong of [{owner:randomUUID()},{id:queuedId},{operation:hash('wrong resolution operation')}])
    await assert.rejects(claimResolution(wrong),stageRefused)
   const exact=await claimResolution()
   assert.deepEqual(exact,{owner:leaseOwner,fence:1,expiresAt:exact?.expiresAt});assert.ok(Number.isFinite(Date.parse(exact.expiresAt)))
   assert.deepEqual(await claimResolution(),exact);assert.deepEqual(await readRelease(),{state:'dispatched'})
  })
  await check('private settlement refuses wrong roles, lease and forged receipt without releasing the held original',async()=>{
   const before=await heldRows(),admitted=await heldAdmission()
   assert.deepEqual((await query(`SELECT has_function_privilege('crm_fixture_unprivileged_recovery',$1,'EXECUTE') AS settle,
     has_table_privilege('crm_fixture_unprivileged_recovery',$2,'INSERT') AS attest`,
    [`${settlementName}(uuid,text,uuid,bigint,jsonb)`,receiptTable])).rows[0],{settle:false,attest:false})
   await query(`GRANT EXECUTE ON FUNCTION ${settlementName}(uuid,text,uuid,bigint,jsonb) TO ${recoveryController};
    GRANT INSERT (native_operation_id,receipt_hash,lease_fence) ON ${receiptTable} TO ${recoveryAttestor}`)
   await assert.rejects(settleWith({},attest),error=>error?.code==='42501')
   await assert.rejects(tx(async c=>{await c.query(`SET LOCAL ROLE ${recoveryController}`);await settleWith({},c)}),stageRefused)
   await assert.rejects(attestReceipt(receipt,stage),error=>error?.code==='42501')
   await assert.rejects(tx(async c=>{await c.query(`SET LOCAL ROLE ${recoveryAttestor}`);await attestReceipt(receipt,c)}),stageRefused)
   await assert.rejects(settleWith(),stageRefused,'A valid synthetic receipt without independent attestation is not authority')
   assert.equal((await attestReceipt()).rowCount,1)
   for(const wrong of [{id:queuedId},{operation:hash('wrong settlement operation')},{owner:randomUUID()},{fence:2}])
    await assert.rejects(settleWith(wrong),stageRefused)
   for(const alter of [r=>{r.commandHash=hash('forged command hash')},r=>{r.operationId=hash('forged receipt operation')},
    r=>{r.result.readerSuiteCrmUserIds=['native-outsider']},r=>{r.result.projection.accounts=[heldPrimary.native]},
    r=>{r.result.projection.sourceAttributes.parent_id=heldAccounts[1].native}]){
    const forged=copy(receipt);alter(forged)
    assert.throws(()=>transport.verifyNativeEmailPublicationReceipt(request,forged))
    await assert.rejects(settleWith({native:forged}),stageRefused)
   }
   await assert.rejects(query(`UPDATE crm_native_email_publication_admissions SET state='committed',native_receipt=$2::jsonb
    WHERE operation_id=$1`,[operationId,canonical(receipt)]),stageRefused)
   const abort=new Error('synthetic rollback after exact settlement')
   await assert.rejects(directControllerTx(async c=>{assert.equal(await settleWith({},c),'committed');throw abort}),err=>err===abort)
   assert.deepEqual(await heldRows(),before);assert.deepEqual(await heldAdmission(),admitted)
   assert.deepEqual(await readRelease(),{state:'dispatched'})
  })
  await check('independently attested cancellation leaves the interaction failed and can be rolled back in the fixture',async()=>{
   const cancelled={version:2,operationId,commandHash:request.commandHash,state:'cancelled',replayed:false,result:null}
   assert.deepEqual(transport.verifyNativeEmailPublicationReceipt(request,cancelled),cancelled)
   assert.equal((await attestReceipt(cancelled)).rowCount,1)
   const [before]=await heldRows(),source=JSON.parse(before.source),beforeAdmission=await heldAdmission()
   await query(`GRANT SELECT (id,sync_status,sync_error,suitecrm_synced_at,metadata) ON crm_interactions TO ${recoveryController};
    GRANT SELECT (id,status,last_error,locked_at,lock_token,available_at,idempotency_key) ON sync_outbox TO ${recoveryController}`)
   const abort=new Error('synthetic rollback after cancelled settlement')
   await assert.rejects(directControllerTx(async c=>{
    assert.equal(await settleWith({native:cancelled},c),'cancelled')
    assert.deepEqual(await readRelease({},c),{state:'cancelled'})
    const i=(await c.query('SELECT sync_status,sync_error,suitecrm_synced_at,metadata FROM crm_interactions WHERE id=$1',[heldInteraction])).rows[0]
    assert.deepEqual(i,{sync_status:source.sync_status,sync_error:source.sync_error,suitecrm_synced_at:null,metadata:source.metadata})
    const o=(await c.query('SELECT status,last_error,locked_at,lock_token,available_at::text,idempotency_key FROM sync_outbox WHERE id=$1',[heldOutbox])).rows[0]
    assert.deepEqual(o,{status:'dead',last_error:'Native Email cancelled before write',locked_at:null,lock_token:null,
     available_at:'infinity',idempotency_key:expected.idempotency_key})
    throw abort
   }),err=>err===abort)
   assert.deepEqual(await heldRows(),[before]);assert.deepEqual(await heldAdmission(),beforeAdmission)
   assert.deepEqual(await readRelease(),{state:'dispatched'})
  })
  await check('one exact native receipt settles the original job once without replacing its identity or disturbing other jobs',async()=>{
   const [parked]=await heldRows()
   assert.equal(await settleWith(),'committed')
   const terminal=await heldAdmission()
   assert.equal(terminal.state,'committed');assert.equal(terminal.active_operation_id,null);assert.deepEqual(terminal.native_receipt,receipt)
   assert.equal(terminal.lease_owner,leaseOwner);assert.equal(Number(terminal.lease_fence),1)
   assert.deepEqual(await readRelease(),{state:'committed'});await assertUnreadableRelease()
   assert.deepEqual(await resolveWith(verified.intentHash,verified.approvalHash),{state:'unknown'})
   const [finished]=await heldRows(),oldOutbox=JSON.parse(parked.retained),outbox=JSON.parse(finished.retained)
   const oldSource=JSON.parse(parked.source),source=JSON.parse(finished.source)
   for(const key of Object.keys(oldOutbox).filter(key=>!['status','last_error','locked_at','lock_token','processed_at','updated_at'].includes(key)))
    assert.deepEqual(outbox[key],oldOutbox[key],`${key} remains the original staged job`)
   assert.equal(outbox.status,'succeeded');assert.equal(outbox.available_at,'infinity');assert.ok(outbox.processed_at)
   assert.equal(outbox.lock_token,null);assert.equal(outbox.locked_at,null);assert.equal(outbox.last_error,null)
   for(const key of Object.keys(oldSource).filter(key=>!['sync_status','sync_error','suitecrm_synced_at','updated_at','metadata'].includes(key)))
    assert.deepEqual(source[key],oldSource[key],`${key} remains the original CRM interaction`)
   assert.equal(source.sync_status,'synced');assert.equal(source.sync_error,null);assert.ok(source.suitecrm_synced_at)
   assert.equal(source.metadata.suiteCrmEmailProjection.operationId,operationId)
   assert.deepEqual(source.metadata.suiteCrmEmailProjection.accounts,heldAccountIds)
   assert.deepEqual(source.metadata.suiteCrmEmailProjection.contactAccounts,heldContactAccounts)
   assert.equal((await query(`SELECT original::text AS row FROM ${holdSchema}.held WHERE outbox_id=$1`,[heldOutbox])).rows[0].row,heldBefore[0].retained)
   assert.deepEqual((await query('SELECT to_jsonb(o)::text AS row FROM sync_outbox o WHERE id<>$1 ORDER BY id',[heldOutbox])).rows,baselineOther)
   assert.deepEqual(await quarantineRows(),quarantineBefore)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_admissions')).rows[0].n,1)
   assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work')).rows[0].n,1)
   await assert.rejects(settleWith(),stageRefused)
   await assert.rejects(claimResolution(),stageRefused)
   await assert.rejects(registerRelease(stage),stageRefused)
   await assert.rejects(query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES('suitecrm','crm_interactions',$1,'upsert_record','{}')`,[heldInteraction]),stageRefused)
   await assert.rejects(addAdmission(stage),stageRefused)
   assert.deepEqual(await heldRows(),[finished]);assert.deepEqual(await readRelease(),{state:'committed'})
  })
 }finally{await Promise.all(recoveryRolePools.map(db=>db.end()))}
 console.log(`PASS ${checks} actual PostgreSQL ${major} initial-enrollment groups; synthetic native approval/forecast/receipt only, no native execution or production proof`)
}finally{try{if(pool)await pool.end()}finally{
 if(nativeFixture)nativeFixture.cleanup()
 else if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})
}}
