// Test-only retained initial protocol. Native snapshots/receipts are synthetic;
// real PostgreSQL reservation, admission, source and terminal guards stay on.
import assert from 'node:assert/strict'
import {constants,createHash,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto'

/** Independent committed clients cannot observe an outer rollback fixture.
 * Clone only the caller's already guarded disposable DB, never a live URL or
 * another owner's connection. No sessions are killed to make TEMPLATE work. */
export async function withRootCrmSyntheticDatabase({Pool,getPool,setPool},run){
 const baseline=getPool(),options={...baseline.options,password:baseline.options.password},name=options.database
 assert.equal(options.host,'127.0.0.1');assert.equal(name,'root_registry_fixture')
 assert.equal(options.user,'postgres');assert.equal(options.password,'root_registry_fixture')
 const fingerprint=async pool=>{
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
  const rows=[]
  for(const {tablename} of tables){assert.match(tablename,/^[a-z][a-z0-9_]*$/u)
   rows.push([tablename,(await pool.query(`SELECT encode(digest(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]'::jsonb)::text,'sha256'),'hex') AS hash FROM public."${tablename}" t`)).rows[0].hash])}
  return rows
 }
 const before=await fingerprint(baseline)
 const clone=`root_registry_native_${process.pid}_${randomUUID().replaceAll('-','')}`
 assert.match(clone,/^root_registry_native_[0-9]+_[a-f0-9]{32}$/u)
 assert.equal(baseline.waitingCount,0);assert.equal(baseline.totalCount,baseline.idleCount,'All baseline clients must be returned before cloning')
 await baseline.end()
 const admin=new Pool({...options,database:'postgres',max:1})
 const disconnected=async database=>{
  const deadline=Date.now()+3000
  for(;;){
   const count=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n
   if(count===0)return
   assert.ok(Date.now()<deadline,'Owned pool disconnect must finish before TEMPLATE or DROP; never kill another session')
   await new Promise(resolve=>setTimeout(resolve,20))
  }
 }
 let created=false,active,runError
 try{
  await disconnected(name)
  await admin.query(`CREATE DATABASE "${clone}" TEMPLATE "${name}"`);created=true
  active=new Pool({...options,database:clone});setPool(active)
  return await run()
 }catch(error){runError=error;throw error
 }finally{
  let cleanupError
  try{
   if(active){assert.equal(active.waitingCount,0);assert.equal(active.totalCount,active.idleCount,'All native fixture clients must be returned');await active.end()}
   if(created){
    await disconnected(clone)
    await admin.query(`DROP DATABASE "${clone}"`)
   }
  }catch(error){cleanupError=error
  }finally{
   await admin.end();const restored=new Pool(options);setPool(restored)
   assert.deepEqual(await fingerprint(restored),before,'Owned native clone cannot change any retained baseline table')
  }
  if(cleanupError)throw runError?new AggregateError([runError,cleanupError],'Native fixture and owned clone cleanup both failed'):cleanupError
 }
}

/** Follow the same retained SQL contract exercised by the dedicated initial
 * enrollment gate. A real disposable RSA issuer signs the synthetic forecast;
 * no native installation/receipt authentication or production proof is implied. */
export async function enrollRootCrmSyntheticInitial({query,tx,protocol,capability,owner,root,inspection=null,readers=null}){
 const json=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest
 const guards=async c=>(await c.query(`SELECT tgname,tgenabled FROM pg_trigger
  WHERE tgrelid='crm_native_email_publication_control'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows
 const beforeGuards=await guards({query})
 assert.ok(beforeGuards.some(row=>row.tgname==='crm_native_initial_control_guard'))
 assert.ok(beforeGuards.every(row=>row.tgenabled==='O'))
 const control=(await query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows[0]
 assert.equal(control.enabled,false);assert.equal(control.active_operation_id,null)
 assert.equal(control.active_transition_id,null);assert.equal(control.active_initial_enrollment_id,null)
 assert.equal((await query('SELECT count(*)::int AS n FROM crm_native_email_capability_policies')).rows[0].n,0)
 const account=(await query('SELECT id::text FROM crm_operator_accounts WHERE root_workspace_id=$1 AND owner_email=$2 AND enabled',[root,owner])).rows
 assert.equal(account.length,1)
 const candidates=(await query(`SELECT p.id::text,p.workspace_organization_id::text AS workspace_id,u.suitecrm_user_id AS owner_id
  FROM pipeline_spaces p JOIN crm_operator_workspace_bindings b ON b.workspace_id=p.workspace_organization_id
  JOIN app_users u ON u.email=p.owner_email WHERE b.operator_account_id=$1 AND b.enabled AND NOT p.reference_access_disabled ORDER BY p.id`,[account[0].id])).rows
 assert.ok(candidates.length>0&&candidates.length<=100)
 const pipelines=[]
 for(const candidate of candidates){
  if(candidate.owner_id===null){
   assert.equal((await query('SELECT public.clawpilot_crm_native_unmanaged_pipeline_footprint($1::uuid) AS unmanaged',[candidate.id])).rows[0].unmanaged,true,
    'Synthetic native fixture may omit only an independently SQL-proven unmanaged app-only pipeline')
  }else pipelines.push(candidate)
 }
 assert.ok(pipelines.length>0)
 assert.ok(pipelines.every(row=>typeof row.owner_id==='string'))
 // The source-fence-only cases have no history yet. Seed one explicit fake
 // Email in this owned clone, rather than relaxing the protocol's inventory.
 if((await query("SELECT count(*)::int AS n FROM crm_interactions WHERE suitecrm_module='Emails' AND suitecrm_synced_at IS NOT NULL")).rows[0].n===0){
  const id=randomUUID()
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
   VALUES($1,$2,$3,'Synthetic initial source-fence Email',$4,$5,'Emails',now(),allocate_crm_reference('gi'),'{"synthetic":true}')`,
  [id,pipelines[0].id,'synthetic-root-initial-'+id,hash(['synthetic-root-history',id]),randomUUID()])
 }
 const live=(await query(`SELECT s,encode(digest(s::text,'sha256'),'hex') AS fingerprint
  FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS s) q`)).rows[0]
 const generation=Number(live.s.generation),operationId=hash(['synthetic-root-initial',randomUUID()]),nativeInstanceId='root-crm-synthetic-native'
 const matrix=ids=>Object.fromEntries(['view','list','export','edit','delete'].map(key=>[key,[...ids]]))
 const principals=inspection?.principalSuiteCrmUserIds??[...new Set(pipelines.flatMap(p=>readers??[p.owner_id]))].sort()
 const planned=inspection?inspection.bindings.map(b=>({groupId:b.group_id,policy:JSON.parse(b.capability_policy_json)})):
  pipelines.map(p=>{const allowed=[...new Set(readers??[p.owner_id])].sort(),writers=[p.owner_id]
   const audience=createHash('sha256').update(JSON.stringify({policy:'pipeline-internal',ownerSuiteCrmId:p.owner_id,
    allowedSuiteCrmUserIds:allowed,workspaceId:p.workspace_id,pipelineId:p.id})).digest('hex')
   return {groupId:randomUUID(),policy:{version:2,pipelineId:p.id,workspaceId:p.workspace_id,ownerSuiteCrmId:p.owner_id,audienceFingerprint:audience,
    principalSuiteCrmUserIds:principals,futureCreate:{view:allowed,list:allowed,export:allowed,edit:writers,delete:writers},historical:[]}}})
 assert.deepEqual(planned.map(p=>p.policy.pipelineId).sort(),pipelines.map(p=>p.id))
 const plan={version:1,kind:'initial_enrollment_plan_v1',operationId,nativeInstanceId,appGeneration:generation,appSourceFingerprint:live.fingerprint,
  nativePolicyBeforeFingerprint:hash(['synthetic-before',operationId]),nativeRuntimeBeforeFingerprint:hash(['synthetic-before-runtime',operationId]),
  nativePolicyAfterFingerprint:inspection?.nativePolicyFingerprint??hash(['synthetic-after',operationId]),
  nativeRuntimeAfterFingerprint:inspection?.runtimeFingerprint??hash(['synthetic-after-runtime',operationId]),principalSuiteCrmUserIds:principals,
  defaults:['delete','edit','export','list','view'].map(action=>{const row={id:randomUUID(),action,aclAccess:90};return {before:row,after:{...row,aclAccess:['delete','edit'].includes(action)?75:80}}}),
  emails:live.s.emails.map(row=>{const before={...row,capabilities:matrix(principals)},policy=planned.find(p=>p.policy.pipelineId===row.pipelineId)?.policy
   assert.ok(policy,'Every historical fixture Email needs its exact bound policy')
   return {before,after:{...before,capabilities:policy.futureCreate}}}),pipelines:planned,reviewedRevocations:[],rootEmployeeGrants:[]}
 plan.reviewedRevocations=plan.emails.flatMap(({before,after})=>['view','list','export','edit','delete'].flatMap(surface=>before.capabilities[surface]
  .filter(principalId=>!after.capabilities[surface].includes(principalId)).map(principalId=>({nativeId:before.nativeId,surface,principalId}))))
  .sort((a,b)=>[a.nativeId,a.surface,a.principalId].join(':').localeCompare([b.nativeId,b.surface,b.principalId].join(':')))
 const planHash=hash(plan),preparedAt=new Date().toISOString().slice(0,19).replace('T',' ')
 const policies=planned.map(({policy})=>{
  const checked=capability.prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:policy.pipelineId,workspaceId:policy.workspaceId,
   ownerSuiteCrmId:policy.ownerSuiteCrmId,audienceFingerprint:policy.audienceFingerprint,allowedReaderSuiteCrmUserIds:policy.futureCreate.view},
   livePrincipalSuiteCrmUserIds:principals,approvedFutureCreate:policy.futureCreate,liveHistorical:[]})
  return {pipelineId:policy.pipelineId,generation,policy,fingerprint:checked.futurePolicyFingerprint}})
 const result={generation,appSourceFingerprint:live.fingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,
  sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,installedRuntimeFingerprint:hash(['synthetic-install',operationId]),runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,
  identityFingerprint:hash(plan.emails.map(({after})=>{const {capabilities,...identity}=after;void capabilities;return identity})),
  capabilitiesFingerprint:hash(plan.emails.map(({after})=>({emailId:after.nativeId,globalId:after.globalId,pipelineId:after.pipelineId,capabilities:after.capabilities}))),
  bindingsFingerprint:hash(inspection?.bindings??planned),defaultsFingerprint:hash(plan.defaults.map(x=>x.after)),emailCount:plan.emails.length,principalCount:principals.length}
 const delta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId,planHash,preparedAt,
  changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies}
 const issuedAt=Math.floor(Date.now()/1000),keys=generateKeyPairSync('rsa',{modulusLength:3072}),proof={version:1,purpose:'clawpilot-native-email-initial-enrollment-approval',
  issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-initial-enrollment',keyId:'synthetic-root-crm-test',nativeInstanceId,
  serviceUserId:pipelines[0].owner_id,oauthClientId:randomUUID(),issuedAt,expiresAt:issuedAt+120,operationId,planHash,appGeneration:generation,
  appSourceFingerprint:live.fingerprint,preparedAt,deltaFingerprint:hash(delta),sourceRuntimeFingerprint:result.sourceRuntimeFingerprint,
  installedRuntimeFingerprint:result.installedRuntimeFingerprint,installationJournalFingerprint:hash(['synthetic-journal',operationId])}
 const bytes=Buffer.from(json(proof),'ascii'),signature=sign('sha256',bytes,{key:keys.privateKey,padding:constants.RSA_PKCS1_PADDING}).toString('base64')
 assert.equal(verify('sha256',bytes,{key:keys.publicKey,padding:constants.RSA_PKCS1_PADDING},Buffer.from(signature,'base64')),true)
 const approval={proof,signature},receipt={version:1,purpose:'clawpilot-native-email-initial-enrollment-receipt',operationId,planHash,approvalHash:hash(approval),state:'committed',result}
 await tx(async c=>{
  await c.query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[operationId,owner,account[0].id,root,nativeInstanceId,generation,live.s,live.fingerprint])
  assert.equal((await c.query('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control')).rows[0].active_initial_enrollment_id,operationId)
  await c.query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,native_delta_canonical,delta_fingerprint,
   approval_envelope,approval_canonical,approval_hash,actor_email,operator_account_id,root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [operationId,plan,json(plan),planHash,delta,json(delta),hash(delta),approval,json(approval),hash(approval),owner,account[0].id,root,nativeInstanceId,generation,live.s,live.fingerprint])
  await c.query(`UPDATE crm_native_email_initial_enrollments SET state='activated',native_receipt=$2,receipt_canonical=$3,receipt_hash=$4,settling_xid=txid_current()
   WHERE operation_id=$1`,[operationId,receipt,json(receipt),hash(receipt)])
  await c.query("UPDATE crm_native_email_initial_reservations SET state='activated',settling_xid=txid_current() WHERE operation_id=$1",[operationId])
  for(const p of policies)await c.query('INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint) VALUES($1,$2,$3,$4)',[p.pipelineId,generation,p.policy,p.fingerprint])
  await c.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=$1,
   activation_receipt_hash=$2,active_initial_enrollment_id=NULL WHERE singleton`,[result.afterPolicyFingerprint,hash(receipt)])
  await c.query('SET CONSTRAINTS ALL IMMEDIATE')
  assert.equal((await c.query('SELECT state FROM crm_native_email_initial_reservations WHERE operation_id=$1',[operationId])).rows[0].state,'activated')
  assert.deepEqual((await c.query('SELECT native_receipt FROM crm_native_email_initial_enrollments WHERE operation_id=$1',[operationId])).rows[0].native_receipt,receipt)
  assert.deepEqual(await guards(c),beforeGuards)
 })
 const retained=(await query('SELECT enabled,active_initial_enrollment_id,activation_receipt_hash FROM crm_native_email_publication_control')).rows[0]
 assert.deepEqual(retained,{enabled:true,active_initial_enrollment_id:null,activation_receipt_hash:hash(receipt)})
 console.log('PASS synthetic root CRM initial reservation/admission/retained receipt with every activation guard enabled')
 return {operationId,receipt,generation,policies}
}
