#!/usr/bin/env node
// Real DAL, SQL guards and RSA issuer. Native forecast/resolver, protected
// evidence collection and induced transport faults are explicitly SYNTHETIC.
// No native execution, native authentication or production activation proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {readFileSync,readdirSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {disposablePostgresDockerArgs,createDisposablePostgresRuntime} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use the supported bundled Node24 runtime')
const args=process.argv.slice(2)
assert.ok(args.length===0||args.length===1&&/^--postgres-major=(16|18)$/.test(args[0]))
const major=args[0]?.split('=')[1]??'16',require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg'),ts=require('typescript')
const loaded=new Map(),sourceHashes=new Map()
sourceHashes.set(resolve('scripts/test-native-email-initial-enrollment-dal-postgres.mjs'),crypto.createHash('sha256')
 .update(readFileSync('scripts/test-native-email-initial-enrollment-dal-postgres.mjs')).digest('hex'))
function load(path){path=resolve(path);if(loaded.has(path))return loaded.get(path).exports
 const module={exports:{}};loaded.set(path,module);const bytes=readFileSync(path,'utf8');sourceHashes.set(path,crypto.createHash('sha256').update(bytes).digest('hex'))
 const code=ts.transpileModule(bytes,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('module','exports','require',code)(module,module.exports,name=>name==='server-only'?{}:name.startsWith('node:')?require(name):load(resolve(dirname(path),name+'.ts')))
 return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts'),issuerModule=load('app_src/lib/crm/nativeEmailInitialEnrollmentApproval.ts')
const dal=load('app_src/lib/crm/nativeEmailInitialEnrollmentPostgres.ts'),projection=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const lineageProtocol=load('app_src/lib/crm/nativeEmailInitialInstallationLineage.ts')
const {NativeEmailInitialEnrollmentCoordinator:Coordinator}=load('app_src/lib/crm/nativeEmailInitialEnrollmentCoordinator.ts')
const {createNativeEmailInitialStartupOriginIssuer:createOriginIssuer}=load('app_src/lib/crm/nativeEmailInitialStartupOrigin.ts')
const json=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest,copy=v=>JSON.parse(json(v)),id=()=>crypto.randomUUID()
const matrix=(readers,writers=readers)=>({view:[...readers],list:[...readers],export:[...readers],edit:[...writers],delete:[...writers]})
const emails={owner:'initial.dal.owner@example.invalid',editor:'initial.dal.editor@example.invalid',viewer:'initial.dal.viewer@example.invalid',
 denied:'initial.dal.denied@example.invalid',trash:'initial.dal.trash@example.invalid',appOnly:'initial.dal.app-only@example.invalid',outsider:'initial.dal.outsider@example.invalid'}
const mappings={owner:'1',editor:'native-editor',viewer:'native-viewer',denied:'native-denied',trash:'native-trash',outsider:'native-outsider'}
const principals=Object.values(mappings).sort(),readers=['1','native-editor','native-viewer'],writers=['1','native-editor']
const root=id(),account=id(),pipelines=[id(),id()].sort(),nativeInstanceId='initial-dal-synthetic-native'
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({type:'spki',format:'pem'})
const identity={keyId:'initial-dal-test',nativeInstanceId,serviceUserId:'1',oauthClientId:id()}
const verification={publicKey,keyId:identity.keyId,serviceUserId:identity.serviceUserId,oauthClientId:identity.oauthClientId}
const selection={actorEmail:emails.owner,operatorAccountId:account,rootWorkspaceId:root,nativeInstanceId}
const container='clawpilot-initial-dal-pg'+major+'-'+process.pid+'-'+id().slice(0,8)
const runtime=createDisposablePostgresRuntime()
let pool,started=false,checks=0,activeTransactions=0,failBeforeCommit=false,loseAfterCommit=false
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name)}
const held=e=>e?.code?.startsWith('initial_')||['55000','23514'].includes(e?.code)
try{
 const launch=disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never','-e','POSTGRES_PASSWORD=initial_dal_fixture',
  '-e','POSTGRES_DB=initial_dal_fixture','-p','127.0.0.1::5432',`pgvector/pgvector:pg${major}`],{runtime})
 started=true;execFileSync('docker',launch,{stdio:'pipe',timeout:60000})
 const endpoint=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1];assert.ok(endpoint)
 pool=new Pool({host:'127.0.0.1',port:Number(endpoint),database:'initial_dal_fixture',user:'postgres',password:'initial_dal_fixture',ssl:false,max:4,statement_timeout:10000})
 const until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,100))}}
 const query=(sql,values=[])=>pool.query(sql,values)
 const transaction=async fn=>{const c=await pool.connect();let committed=false,admissionWrite=false,terminalWrite=false;activeTransactions++
  const observed={query(sql,values=[]){if(/INSERT INTO crm_native_email_initial_enrollments\(/.test(sql))admissionWrite=true
   if(/UPDATE crm_native_email_initial_enrollments SET state=\$2/.test(sql)&&['activated','cancelled'].includes(values[1]))terminalWrite=true
   return c.query(sql,values)}}
  try{await c.query('BEGIN');const value=await fn(observed);if(failBeforeCommit&&(admissionWrite||terminalWrite)){failBeforeCommit=false;throw Error('synthetic application commit failure')}
   await c.query('COMMIT');committed=true;if(loseAfterCommit&&terminalWrite){loseAfterCommit=false;throw Error('synthetic PG commit response lost')}return value}
  catch(e){if(!committed)await c.query('ROLLBACK');throw e}finally{activeTransactions--;c.release()}}
 const migrate=await pool.connect();try{for(const name of readdirSync('db/migrations').filter(n=>/^\d+_.+\.sql$/.test(n)).sort()){
  const path=resolve('db/migrations',name),bytes=readFileSync(path,'utf8');sourceHashes.set(path,crypto.createHash('sha256').update(bytes).digest('hex'))
  await applyMigrationSqlForTest(migrate,name,bytes)}}finally{migrate.release()}
 for(const [key,email]of Object.entries(emails)){
  const native=mappings[key]??null
  await query(`WITH reference AS(SELECT allocate_crm_reference('gu') AS code)
   INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
   SELECT $1,$2,'active',$3,CASE WHEN $3::text IS NULL THEN NULL ELSE code END,code,$4 FROM reference`,
  [email,key==='owner'?'owner':'member',native,native!==null])
 }
 await query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Actual initial DAL fixture','root',$2,$2)",[root,emails.owner])
 for(const [key,email]of Object.entries(emails))await query(`INSERT INTO app_user_organization_memberships
  (user_email,organization_id,role,status,permissions,created_by,updated_by) VALUES($1,$2,$3,'active',$4,$5,$5)`,
 [email,root,key==='owner'?'owner':'member',{viewCrm:key!=='denied'},emails.owner])
 await query(`UPDATE app_user_organization_memberships SET status='disabled',trashed_at=now(),trashed_by=$2,pre_trash_status='active'
  WHERE organization_id=$1 AND user_email=$3`,[root,emails.owner,emails.trash])
 await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,[account,root,emails.owner])
 await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
  VALUES($1,$2,$3,true,$3,$3)`,[account,root,emails.owner])
 for(const [index,pipeline]of pipelines.entries()){
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)",[pipeline,'DAL pipeline '+index,emails.owner,root])
  for(const key of ['editor','viewer','denied','trash','appOnly'])await query(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role)
   VALUES($1,$2,$3)`,[pipeline,emails[key],key==='viewer'?'viewer':'editor'])
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
   VALUES($1,$2,$3,'Explicitly synthetic native Email',$4,$5,'Emails',now(),allocate_crm_reference('gi'),$6)`,
  [id(),pipeline,'initial-dal-'+index,hash(['source',index]),id(),{archived:index===0}])
 }
 const snapshot=async()=>{const q=await query(`SELECT s,encode(digest(s::text,'sha256'),'hex') AS fingerprint
  FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS s) q`);return q.rows[0]}
 function materialFor(source,operationId,mutate=()=>{}){
  const generation=Number(source.s.generation),planned=pipelines.map(pipelineId=>({groupId:id(),policy:{version:2,pipelineId,workspaceId:root,ownerSuiteCrmId:'1',
   audienceFingerprint:projection.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:'1',allowedSuiteCrmUserIds:readers,
    workspaceId:root,pipelineId,fingerprint:''}),principalSuiteCrmUserIds:principals,futureCreate:matrix(readers,writers),historical:[]}}))
  const plan={version:1,kind:'initial_enrollment_plan_v1',operationId,nativeInstanceId,appGeneration:generation,appSourceFingerprint:source.fingerprint,
   nativePolicyBeforeFingerprint:hash('synthetic-native-before-policy'),nativeRuntimeBeforeFingerprint:hash('synthetic-native-source-runtime'),
   nativePolicyAfterFingerprint:hash('synthetic-native-after-policy'),nativeRuntimeAfterFingerprint:hash('synthetic-native-after-runtime'),
   principalSuiteCrmUserIds:principals,defaults:['delete','edit','export','list','view'].map(action=>{const row={id:id(),action,aclAccess:90};return {before:row,after:{...row,aclAccess:['delete','edit'].includes(action)?75:80}}}),
   emails:source.s.emails.map(row=>{const before={...row,recordFingerprint:hash(['synthetic-native-content',row.nativeId]),capabilities:matrix(principals)};
    return {before,after:{...copy(before),capabilities:matrix(readers,writers)}}}),pipelines:planned,reviewedRevocations:[],rootEmployeeGrants:[]}
  mutate(plan)
  plan.reviewedRevocations=plan.emails.flatMap(({before,after})=>['view','list','export','edit','delete'].flatMap(surface=>before.capabilities[surface]
   .filter(principalId=>!after.capabilities[surface].includes(principalId)).map(principalId=>({nativeId:before.nativeId,surface,principalId}))))
   .sort((a,b)=>[a.nativeId,a.surface,a.principalId].join(':')<[b.nativeId,b.surface,b.principalId].join(':')?-1:1)
  const planHash=hash(plan),preparedAt=new Date().toISOString().slice(0,19).replace('T',' ')
  const result={generation,appSourceFingerprint:source.fingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,
   afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
   installedRuntimeFingerprint:hash('synthetic-installed-runtime'),runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,
   identityFingerprint:hash(plan.emails.map(({after})=>{const {capabilities,...rest}=after;void capabilities;return rest})),
   capabilitiesFingerprint:hash(plan.emails.map(({after})=>({emailId:after.nativeId,globalId:after.globalId,pipelineId:after.pipelineId,capabilities:after.capabilities}))),
   bindingsFingerprint:hash('synthetic-native-bindings'),defaultsFingerprint:hash(plan.defaults.map(x=>x.after)),emailCount:plan.emails.length,principalCount:principals.length}
  const policies=planned.map(({policy})=>{const future={...policy};delete future.historical;return {pipelineId:policy.pipelineId,generation,policy,fingerprint:hash(future)}})
  const nativeDelta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId,planHash,preparedAt,
   changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies}
  return {plan,evidence:{complete:{appEmails:true,nativeEmails:true,nativePrincipals:true,pipelineAuthority:true,nativeDefaults:true},nativeInstanceId,appGeneration:generation,
   appSourceFingerprint:source.fingerprint,nativePolicyFingerprint:plan.nativePolicyBeforeFingerprint,nativeRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
   principalSuiteCrmUserIds:principals,emails:plan.emails.map(x=>x.before),defaults:plan.defaults.map(x=>x.before),approvedPipelines:copy(planned),reviewedRevocations:copy(plan.reviewedRevocations)},
   planHash,preparedAt,nativeDelta,deltaFingerprint:hash(nativeDelta),sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
   installedRuntimeFingerprint:result.installedRuntimeFingerprint,installationJournalFingerprint:hash('synthetic-offline-journal')}
 }
 const makeStore=(material,tx=transaction,selected=selection)=>new dal.PostgresNativeEmailInitialEnrollmentStore(tx,selected,
  material?{expectedPlanHash:material.planHash,read:async()=>copy(material)}:undefined,verification)
 const makeIssuer=(store,ttlSeconds=120)=>issuerModule.createNativeEmailInitialApprovalIssuer(store,{...identity,privateKey:keys.privateKey,ttlSeconds})
 const state=async operationId=>({control:(await query('SELECT * FROM crm_native_email_publication_control')).rows[0],
  enrollment:(await query('SELECT * FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[operationId])).rows[0]??null,
  policies:(await query('SELECT * FROM crm_native_email_capability_policies ORDER BY pipeline_id')).rows})
 const receiptFor=(material,approval,state='committed')=>({version:1,purpose:'clawpilot-native-email-initial-enrollment-receipt',operationId:material.plan.operationId,
  planHash:material.planHash,approvalHash:hash(approval),state,result:state==='committed'?copy(material.nativeDelta.result):null})
 function applyReplan(material,context,runtime){
  const operationId=material.plan.operationId
  material.plan.kind='initial_enrollment_replan_v1';material.plan.nativeRuntimeBeforeFingerprint=runtime
  material.plan.installationLineage=lineageProtocol.finalizeNativeEmailInitialInstallationLineage(context,operationId,hash(['synthetic-fresh-capture',operationId]),runtime)
  material.planHash=hash(material.plan);material.evidence.nativeRuntimeFingerprint=runtime;material.sourceRuntimeFingerprint=runtime;material.installedRuntimeFingerprint=runtime
  material.nativeDelta.planHash=material.planHash;material.nativeDelta.result.sourceRuntimeFingerprint=runtime;material.nativeDelta.result.installedRuntimeFingerprint=runtime
  material.deltaFingerprint=hash(material.nativeDelta)
  material.installationJournalFingerprint=lineageProtocol.effectiveNativeEmailInitialInstallationJournalFingerprint(material.plan.installationLineage,operationId)
 }
 // Deliberately bypass the DAL with a locally signed, self-consistent proposal
 // so the real SQL admission trigger, not a JavaScript mock, must refuse it.
 async function rawAdmission(material){
  const operationId=material.plan.operationId,memory={async issueApproval(_,create){
   return create({...copy(material),state:'reserved',publicationEnabled:false,barrierOperationId:operationId})}}
  const approval=await makeIssuer(memory).issue(operationId,material.planHash),current=await snapshot()
  return query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,native_delta_canonical,
   delta_fingerprint,approval_envelope,approval_canonical,approval_hash,actor_email,operator_account_id,root_workspace_id,native_instance_id,
   generation,source_snapshot,source_fingerprint) VALUES($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
  [operationId,json(material.plan),json(material.plan),material.planHash,json(material.nativeDelta),json(material.nativeDelta),material.deltaFingerprint,
   json(approval),json(approval),hash(approval),selection.actorEmail,selection.operatorAccountId,selection.rootWorkspaceId,selection.nativeInstanceId,
   material.plan.appGeneration,JSON.stringify(current.s),current.fingerprint])
 }
 await check('actual DAL authorizes only exact operator owner and rejects stale SQL-owned reservation pins',async()=>{
  await assert.rejects(makeStore(undefined,transaction,{...selection,actorEmail:emails.outsider}).preview(),held)
  const preview=await makeStore().preview();await query("UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email=$1 AND organization_id=$2",[emails.viewer,root])
  await assert.rejects(makeStore().reserve(hash('stale-op'),preview.sourceFingerprint),held)
  await query("UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":true}' WHERE user_email=$1 AND organization_id=$2",[emails.viewer,root])
 })
 const source=await snapshot(),operationId=hash(id()),material=materialFor(source,operationId),store=makeStore(material),issuer=makeIssuer(store,3)
 const originConfig={...identity,privateKey:keys.privateKey}
 await check('real reservation retains disabled source barrier before any plan, forecast or signature admission',async()=>{
  const reserved=await store.reserve(operationId,source.fingerprint);assert.equal(reserved.state,'reserved')
  assert.deepEqual(await store.reserve(operationId,source.fingerprint),reserved)
  const s=await state(operationId);assert.equal(s.control.enabled,false);assert.equal(s.control.active_initial_enrollment_id,operationId);assert.equal(s.enrollment,null)
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=NULL'),held)
  await assert.rejects(createOriginIssuer(transaction,selection,originConfig).issue(operationId,material.planHash),
   e=>e.code==='initial_startup_origin_activation_not_committed')
 })
 await check('rehashed reviewed native proposals cannot add denied/trashed readers, elevate viewers or forget explicit editors',async()=>{
  for(const kind of ['denied-reader','trash-reader','viewer-writer','forgot-editor']){
   const forged=materialFor(source,operationId,plan=>{for(const p of plan.pipelines){let read=[...readers],write=[...writers]
    if(kind==='denied-reader')read.push('native-denied');if(kind==='trash-reader')read.push('native-trash');if(kind==='viewer-writer')write.push('native-viewer');if(kind==='forgot-editor')write=write.filter(x=>x!=='native-editor')
    read.sort();write.sort();p.policy.futureCreate=matrix(read,write);p.policy.audienceFingerprint=projection.suiteCrmEmailAudienceFingerprint({policy:'pipeline-internal',ownerSuiteCrmId:'1',
     allowedSuiteCrmUserIds:read,workspaceId:root,pipelineId:p.policy.pipelineId,fingerprint:''})}
    for(const pair of plan.emails)pair.after.capabilities=copy(plan.pipelines.find(x=>x.policy.pipelineId===pair.after.pipelineId).policy.futureCreate)})
   await assert.rejects(makeIssuer(makeStore(forged)).issue(operationId,forged.planHash),e=>e.code==='initial_pg_future_authority_changed')
  }
  assert.equal((await state(operationId)).enrollment,null)
 })
 await check('untrusted create callback cannot persist a forged cryptographic approval',async()=>{
  const memory={async issueApproval(_,create){return create({...copy(material),state:'reserved',publicationEnabled:false,barrierOperationId:operationId})}}
  const authentic=await makeIssuer(memory).issue(operationId,material.planHash),forged=copy(authentic);forged.signature='A'.repeat(512)
  await assert.rejects(store.issueApproval(operationId,()=>forged),e=>e.code==='initial_pg_approval_signature')
  assert.equal((await state(operationId)).enrollment,null)
 })
 let envelope
 await check('actual RSA approval is persisted once; failed admission commit leaves no envelope and preserves reservation',async()=>{
  failBeforeCommit=true;await assert.rejects(issuer.issue(operationId,material.planHash),/synthetic application commit failure/)
  assert.equal((await state(operationId)).enrollment,null)
  envelope=await issuer.issue(operationId,material.planHash);assert.deepEqual(await issuer.issue(operationId,material.planHash),envelope)
  const row=(await state(operationId)).enrollment;assert.equal(row.approval_hash,hash(envelope));assert.deepEqual(row.approval_envelope,envelope)
  assert.equal(crypto.verify('sha256',Buffer.from(json(envelope.proof),'ascii'),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')),true)
  for(const p of row.native_delta.policies){assert.deepEqual(p.policy.futureCreate,matrix(readers,writers));assert.ok(!json(p).includes('app-only'))}
 })
 await check('dispatch and unknown are retained; neither retry nor lost response can redispatch',async()=>{
  const status=await store.readExecution(operationId)
  assert.equal(status.state,'admitted');assert.equal(status.receiptHash,null);assert.deepEqual(status.execution.approval,envelope)
  assert.ok(Number.isSafeInteger(status.nowEpoch)&&Math.abs(status.nowEpoch-Math.floor(Date.now()/1000))<=1)
  const execution=await store.markDispatched(operationId);assert.deepEqual(execution.approval,envelope)
  await store.markUnknown(operationId);await store.markUnknown(operationId)
  await assert.rejects(store.markDispatched(operationId),e=>e.code==='initial_pg_dispatch_requires_unattempted_admission')
  assert.equal((await state(operationId)).enrollment.state,'unknown')
 })
 await check('fresh resolver runs outside PG locks; wrong evidence and transport failure leave barrier untouched',async()=>{
  let calls=0
  await assert.rejects(store.resolveAndSettle(operationId,{async resolve(){calls++;assert.equal(activeTransactions,0)
   await query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE NOWAIT');throw Error('synthetic native response unavailable')}}),/synthetic native response unavailable/)
  const wrong=receiptFor(material,envelope);wrong.approvalHash=hash('not-this-approval')
  await assert.rejects(store.resolveAndSettle(operationId,{async resolve(){calls++;assert.equal(activeTransactions,0);return wrong}}),e=>e.code==='initial_pg_native_receipt_binding')
  assert.equal(calls,2);const s=await state(operationId);assert.equal(s.control.active_initial_enrollment_id,operationId);assert.equal(s.enrollment.state,'unknown');assert.equal(s.policies.length,0)
 })
 await check('expiry alone never clears; explicit resolved cancellation settles disabled baseline atomically and is idempotent',async()=>{
  const wait=envelope.proof.expiresAt*1000-Date.now()+50;if(wait>0)await new Promise(r=>setTimeout(r,wait))
  assert.equal((await state(operationId)).control.active_initial_enrollment_id,operationId)
  const cancelled=receiptFor(material,envelope,'cancelled'),native={async resolve(){assert.equal(activeTransactions,0);return copy(cancelled)}}
  failBeforeCommit=true;await assert.rejects(store.resolveAndSettle(operationId,native),/synthetic application commit failure/)
  assert.equal((await state(operationId)).enrollment.state,'unknown')
  const terminal=await store.resolveAndSettle(operationId,native);assert.equal(terminal.state,'cancelled');assert.deepEqual(await store.resolveAndSettle(operationId,native),terminal)
  const s=await state(operationId);assert.equal(s.control.enabled,false);assert.equal(s.control.active_initial_enrollment_id,null);assert.equal(s.policies.length,0)
  assert.equal((await snapshot()).fingerprint,source.fingerprint)
 })
 const secondSource=await snapshot(),rootSourcePin=hash('independently supplied synthetic root capture')
 let nextId=hash(id()),next=materialFor(secondSource,nextId)
 const directNextStore=makeStore(next)
 await directNextStore.reserve(nextId,secondSource.fingerprint)
 await check('cancelled A requires explicit B lineage; the DAL derives historical pins without an old native matrix replay',async()=>{
  await assert.rejects(makeIssuer(directNextStore).issue(nextId,next.planHash),e=>e.code==='initial_pg_direct_plan_after_cancelled_history')
  const context=await directNextStore.readReplanContext(nextId,operationId,rootSourcePin)
  assert.equal(context.rootOperationId,operationId);assert.equal(context.predecessorOperationId,operationId)
  assert.equal(context.rootInstallationJournalFingerprint,envelope.proof.installationJournalFingerprint)
  assert.equal(context.rootStockRuntimeFingerprint,envelope.proof.sourceRuntimeFingerprint)
  assert.equal(context.rootSourceArtifactDigest,rootSourcePin);assert.equal(context.previousLineageHash,null);assert.equal(context.depth,1)
  assert.equal(Object.hasOwn(context,'freshSourceArtifactDigest'),false)
  assert.equal(context.cancelledHistoryFingerprint,hash([{operationId,planHash:material.planHash,deltaFingerprint:material.deltaFingerprint,
   approvalHash:hash(envelope),cancellationReceiptHash:(await state(operationId)).enrollment.receipt_hash}]))
  await assert.rejects(directNextStore.readReplanContext(nextId,hash('missing predecessor'),rootSourcePin),held)
  await assert.rejects(makeStore(undefined,transaction,{...selection,actorEmail:emails.outsider})
   .readReplanContext(nextId,operationId,rootSourcePin),e=>e.code==='initial_pg_operator_denied')
  applyReplan(next,context,hash('synthetic-current-installed-runtime'))
  const forged=copy(next);forged.plan.installationLineage.predecessorCancellationReceiptHash=hash('wrong terminal receipt')
  forged.planHash=hash(forged.plan);forged.nativeDelta.planHash=forged.planHash;forged.deltaFingerprint=hash(forged.nativeDelta)
  forged.installationJournalFingerprint=lineageProtocol.effectiveNativeEmailInitialInstallationJournalFingerprint(forged.plan.installationLineage,nextId)
  await assert.rejects(makeIssuer(makeStore(forged)).issue(nextId,forged.planHash),e=>e.code==='initial_pg_replan_review_changed')
  assert.equal((await state(nextId)).enrollment,null)
 })
 let nextStore=makeStore(next),nextIssuer=makeIssuer(nextStore,3),nextEnvelope=await nextIssuer.issue(nextId,next.planHash)
 await check('cancelled B permits only complete A to B to C lineage, preserving the immutable root and both tombstones',async()=>{
  const predecessor={operationId:nextId,material:copy(next),approval:copy(nextEnvelope)}
  const wait=nextEnvelope.proof.expiresAt*1000-Date.now()+50;if(wait>0)await new Promise(r=>setTimeout(r,wait))
  const cancelled=receiptFor(next,nextEnvelope,'cancelled')
  await nextStore.resolveAndSettle(nextId,{async resolve(){assert.equal(activeTransactions,0);return copy(cancelled)}})
  assert.equal((await state(nextId)).enrollment.state,'cancelled')
  const thirdSource=await snapshot();assert.equal(thirdSource.fingerprint,source.fingerprint)
  nextId=hash(id());next=materialFor(thirdSource,nextId);nextStore=makeStore(next)
  await nextStore.reserve(nextId,thirdSource.fingerprint)
  await assert.rejects(makeIssuer(nextStore).issue(nextId,next.planHash),e=>e.code==='initial_pg_direct_plan_after_cancelled_history')
  await assert.rejects(nextStore.readReplanContext(nextId,operationId,rootSourcePin),e=>e.code==='initial_pg_replan_history_branch')
  await assert.rejects(nextStore.readReplanContext(nextId,predecessor.operationId,hash('different root source pin')),
   e=>e.code==='initial_pg_replan_historical_lineage_changed')
  const context=await nextStore.readReplanContext(nextId,predecessor.operationId,rootSourcePin)
  assert.equal(context.depth,2);assert.equal(context.rootOperationId,operationId);assert.equal(context.predecessorOperationId,predecessor.operationId)
  assert.equal(context.rootInstallationJournalFingerprint,envelope.proof.installationJournalFingerprint)
  assert.equal(context.rootStockRuntimeFingerprint,envelope.proof.sourceRuntimeFingerprint);assert.equal(context.rootSourceArtifactDigest,rootSourcePin)
  assert.equal(context.previousLineageHash,hash(predecessor.material.plan.installationLineage))
  assert.equal(context.predecessorApprovalHash,hash(predecessor.approval));assert.equal(context.predecessorCancellationReceiptHash,hash(cancelled))
  const history=(await query(`SELECT operation_id AS "operationId",plan_hash AS "planHash",delta_fingerprint AS "deltaFingerprint",
   approval_hash AS "approvalHash",receipt_hash AS "cancellationReceiptHash" FROM crm_native_email_initial_enrollments ORDER BY operation_id COLLATE "C"`)).rows
  assert.equal(context.cancelledHistoryFingerprint,hash(history));assert.equal(history.length,2)
  applyReplan(next,context,hash('synthetic-second-current-installed-runtime'))
  for(const field of ['previousLineageHash','cancelledHistoryFingerprint','rootSourceArtifactDigest','predecessorOperationId','effectiveJournal']){
   const forged=copy(next)
   if(field==='effectiveJournal')forged.installationJournalFingerprint=hash('wrong effective installation')
   else{
    forged.plan.installationLineage[field]=hash('wrong repeated '+field)
    forged.planHash=hash(forged.plan);forged.nativeDelta.planHash=forged.planHash;forged.deltaFingerprint=hash(forged.nativeDelta)
    forged.installationJournalFingerprint=lineageProtocol.effectiveNativeEmailInitialInstallationJournalFingerprint(forged.plan.installationLineage,nextId)
   }
   await assert.rejects(rawAdmission(forged),e=>e.code==='55000'&&/Replan requires exact|Historical replan lineage differs|Missing exact cancelled predecessor/.test(e.message),
    'Actual SQL must reject self-consistently signed but wrong '+field)
   assert.equal((await state(nextId)).enrollment,null)
  }
  nextStore=makeStore(next);nextIssuer=makeIssuer(nextStore);nextEnvelope=await nextIssuer.issue(nextId,next.planHash)
  assert.equal((await nextStore.readExecution(nextId)).state,'admitted')
  assert.equal((await state(operationId)).enrollment.state,'cancelled');assert.equal((await state(predecessor.operationId)).enrollment.state,'cancelled')
 })
 await check('actual coordinator dispatches once, then atomic PG rollback and committed-response loss recover through resume',async()=>{
  const committed=receiptFor(next,nextEnvelope);let executions=0,resolutions=0
  const native={async execute(execution){assert.equal(activeTransactions,0);assert.deepEqual(execution.approval,nextEnvelope)
    assert.equal((await state(nextId)).enrollment.state,'dispatched');executions++;throw Error('synthetic native COMMIT response lost')},
   async cancelExpired(){throw Error('Committed operation must never be cancelled')},
   async resolve(){assert.equal(activeTransactions,0);assert.equal(executions,1);resolutions++;return copy(committed)}}
  const coordinator=new Coordinator(nextStore,nextIssuer,native)
  failBeforeCommit=true;await assert.rejects(coordinator.execute(nextId,next.planHash),e=>e.code==='initial_operator_outcome_held')
  let s=await state(nextId);assert.equal(s.control.enabled,false);assert.equal(s.enrollment.state,'unknown');assert.equal(s.policies.length,0)
  await assert.rejects(coordinator.execute(nextId,next.planHash),e=>e.code==='initial_operator_resolve_existing_attempt');assert.equal(executions,1)
  loseAfterCommit=true;await assert.rejects(coordinator.resume(nextId),e=>e.code==='initial_operator_outcome_held')
  s=await state(nextId);assert.equal(s.control.enabled,true);assert.equal(s.control.active_initial_enrollment_id,null);assert.equal(s.enrollment.state,'activated');assert.equal(s.policies.length,2)
  const before=resolutions,retained=await coordinator.resume(nextId);assert.equal(retained.state,'activated');assert.equal(retained.receiptHash,hash(committed))
  assert.deepEqual(await coordinator.execute(nextId,next.planHash),retained)
  assert.deepEqual(await coordinator.cancelExpired(nextId),retained);assert.equal(executions,1);assert.equal(resolutions,before,'Retained terminal status must not replay old native inventory')
  assert.deepEqual(await nextStore.resolveAndSettle(nextId,native),retained)
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_enrollments')).rows[0].count,'3')
 })
 await check('startup origin is signed only after committed actual SQL read and contains immutable anchors, not readiness',async()=>{
  let clockCalls=0
  const lostRead=async fn=>{await transaction(fn);throw Error('synthetic committed read response lost')}
  await assert.rejects(createOriginIssuer(lostRead,selection,originConfig,()=>{clockCalls++;return Date.now()}).issue(nextId,next.planHash),
   /synthetic committed read response lost/)
  assert.equal(clockCalls,0,'No signing/approval validation clock may run before successful transaction return')
  const factory=createOriginIssuer(transaction,selection,originConfig),envelope=await factory.issue(nextId,next.planHash)
  const proof=envelope.proof,row=(await state(nextId)).enrollment
  assert.equal(proof.purpose,'clawpilot-native-email-initial-activation-origin');assert.equal(proof.audience,'clawpilot-suitecrm-startup')
  assert.equal(proof.initialReceiptHash,row.receipt_hash);assert.equal(proof.approvalHash,row.approval_hash)
  assert.equal(proof.installationJournalFingerprint,nextEnvelope.proof.installationJournalFingerprint)
  assert.equal(proof.originGeneration,next.plan.appGeneration);assert.equal(proof.identities.length,2);assert.equal(proof.pipelines.length,2)
  assert.deepEqual(Object.keys(proof.identities[0]).sort(),['globalId','localId','nativeId','pipelineId','workspaceId'])
  assert.deepEqual(Object.keys(proof.pipelines[0]).sort(),['groupId','pipelineId','workspaceId'])
  for(const name of ['expiresAt','ready','currentGeneration','currentPolicyFingerprint','capabilities','content','description'])assert.equal(Object.hasOwn(proof,name),false)
  assert.equal(crypto.verify('sha256',Buffer.from(json(proof),'ascii'),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')),true)
  await assert.rejects(factory.issue(nextId,hash('different independently reviewed plan')),held)
  await assert.rejects(createOriginIssuer(transaction,{...selection,actorEmail:emails.outsider},originConfig).issue(nextId,next.planHash),
   e=>e.code==='initial_startup_origin_operator_denied')
  await assert.rejects(createOriginIssuer(transaction,selection,{...originConfig,keyId:'wrong-current-issuer'}).issue(nextId,next.planHash),held)
  // The fact remains valid after the original execution approval expires;
  // this does not assert that any later authority phase or native boot passed.
  const historical=await createOriginIssuer(transaction,selection,originConfig,()=>Date.now()+600000).issue(nextId,next.planHash)
  assert.equal(historical.proof.initialReceiptHash,proof.initialReceiptHash);assert.equal(historical.proof.originGeneration,proof.originGeneration)
 })
 for(const [path,pin]of sourceHashes)assert.equal(crypto.createHash('sha256').update(readFileSync(path)).digest('hex'),pin,'Consumed DAL source changed during test: '+path)
 console.log(JSON.stringify({kind:'actual-initial-enrollment-dal-postgres-component',postgresMajor:major,checks,sourceHashes:Object.fromEntries(sourceHashes),
  actualSql:true,actualDal:true,actualRsaIssuer:true,actualOperatorCoordinator:true,actualCommittedOriginIssuer:true,syntheticNativeForecast:true,syntheticNativeResolver:true,nativeExecutionProven:false,productionTouched:false}))
 console.log(`PASS ${checks} actual PostgreSQL ${major} initial DAL/RSA groups; synthetic native forecast/receipt boundary, no production proof`)
}catch(error){console.error(JSON.stringify({kind:'failed-initial-enrollment-dal-postgres-component',postgresMajor:major,passedGroups:checks,
 sourceHashes:Object.fromEntries(sourceHashes),error:String(error.stack??error),code:error.code??null,constraint:error.constraint??null,
 syntheticNativeForecast:true,syntheticNativeResolver:true,nativeExecutionProven:false,productionTouched:false}));throw error}
finally{try{if(pool)await pool.end()}finally{if(started)assert.equal(runtime.cleanup(),true,'Exact owner-checked DB/container/lease cleanup must complete')}}
