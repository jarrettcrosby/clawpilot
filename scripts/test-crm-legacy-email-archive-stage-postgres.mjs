#!/usr/bin/env node
// Real, isolated PostgreSQL archive and staging acceptance. The original jobs,
// writer-fence attestation, native baseline and activation receipt are synthetic.
// This does not acquire a production fence or call a native/provider endpoint.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import {readFileSync,readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

const args=process.argv.slice(2)
assert.ok(args.length===0||(args.length===1&&/^--postgres-major=(16|18)$/.test(args[0])),
  'Only --postgres-major=16|18 is supported')
const major=args[0]?.split('=')[1]??'16'
const require=createRequire(new URL('../app_src/package.json',import.meta.url))
const {Pool}=require('pg'),ts=require('typescript'),modules=new Map()
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function run(input,loadDependency){
  const module={exports:{}}
  const js=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('require','module','exports',js)(loadDependency,module,module.exports)
  return module.exports
}
function load(name){
  if(!modules.has(name))modules.set(name,run(source('app_src/lib/crm/'+name+'.ts'),dependency=>{
    if(dependency==='server-only')return {}
    if(dependency.startsWith('node:'))return require(dependency)
    assert.match(dependency,/^\.\/[a-zA-Z0-9]+$/u)
    return load(dependency.slice(2))
  }))
  return modules.get(name)
}
function ordinaryClaim(withTransaction){
  const path='app_src/lib/persistence/crm.ts'
  const ast=ts.createSourceFile(path,source(path),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
  const functions=['nativeEmailOutboxUnresolvedGuardSql','lockNativeEmailPublicationModeWithClient',
    'nativeEmailOutboxTouchesEmail','claimSuiteCrmOutboxInPostgres'].map(name=>{
    const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)
    assert.ok(node,'Expected production worker function '+name)
    return node.getText(ast)
  })
  return run("import {withTransaction} from 'fixture'; import * as crypto from 'node:crypto'; const ENTITY_TABLE={interactions:'crm_interactions'};\n"
    +functions.join('\n'),name=>{
    if(name==='fixture')return {withTransaction}
    assert.equal(name,'node:crypto');return crypto
  }).claimSuiteCrmOutboxInPostgres
}
const {nativeEmailCanonicalJson:canonical,nativeEmailDigest:hash}=load('nativeEmailPublication')
const {prepareNativeEmailCapabilityContract}=load('nativeEmailCapabilityContract')
const {legacyEmailRetirementManifestDigest,verifyLegacyEmailRetirementApproval}=load('legacyEmailRetirementApproval')
const {verifyLegacyEmailRecoveryReleaseApproval}=load('legacyEmailRecoveryReleaseApproval')
const id=crypto.randomUUID
const owner='archive.owner@example.invalid',workspace=id(),account=id(),pipelines=[id(),id()].sort()
const container=`clawpilot-legacy-archive-pg${major}-${process.pid}-${id().slice(0,8)}`
const refusal=code=>error=>error?.code===code
const single=result=>{assert.equal(result.rows.length,1);return result.rows[0]}
const clock=async db=>Number(single(await db.query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now')).now)
const audience=(pipelineId,allowedSuiteCrmUserIds=['1'])=>{
  const fields={policy:'pipeline-internal',ownerSuiteCrmId:'1',allowedSuiteCrmUserIds,workspaceId:workspace,pipelineId}
  return {...fields,fingerprint:crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')}
}
const sign=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(canonical(proof),'ascii'),
  {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
let pool,started=false,checks=0
const check=async(label,runCase)=>{await runCase();checks++;console.log('PASS '+label)}

// Pass the actual SQL lifecycle, including reservation, exact policy inventory
// and atomic settlement. Only the native approval/forecast/receipt are simulated.
async function activateSyntheticInitial(tx){
  const current=single(await tx.query(`SELECT value,encode(public.digest(value::text,'sha256'),'hex') AS fingerprint
    FROM (SELECT clawpilot_crm_native_initial_source_snapshot() AS value) captured`))
  const generation=Number(current.value.generation),operationId=hash(id()),nativeInstanceId='synthetic-archive-stage-instance'
  await tx.query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,
    root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [operationId,owner,account,workspace,nativeInstanceId,generation,current.value,current.fingerprint])
  const principals=['1'],actions=['delete','edit','export','list','view']
  const capabilities=Object.fromEntries(actions.map(action=>[action,principals]))
  const plan={version:1,kind:'initial_enrollment_plan_v1',operationId,nativeInstanceId,appGeneration:generation,
    appSourceFingerprint:current.fingerprint,nativePolicyBeforeFingerprint:hash('fixture policy before'),
    nativePolicyAfterFingerprint:hash('fixture policy after'),nativeRuntimeBeforeFingerprint:hash('fixture runtime before'),
    nativeRuntimeAfterFingerprint:hash('fixture runtime after'),principalSuiteCrmUserIds:principals,
    defaults:actions.map(action=>{const aclId=id();return {before:{id:aclId,action,aclAccess:90},
      after:{id:aclId,action,aclAccess:['edit','delete'].includes(action)?75:80}}}),
    emails:current.value.emails.map(identity=>{const entry={...identity,capabilities};return {before:entry,after:entry}}),
    pipelines:pipelines.map(pipelineId=>({groupId:id(),policy:{version:2,pipelineId,workspaceId:workspace,ownerSuiteCrmId:'1',
      audienceFingerprint:audience(pipelineId).fingerprint,principalSuiteCrmUserIds:principals,futureCreate:capabilities,historical:[]}})),
    reviewedRevocations:[],rootEmployeeGrants:[]}
  assert.equal(plan.emails.length,1,'Only the fixture native baseline is known published; retired source rows are still unknown')
  const policies=plan.pipelines.map(({policy})=>({pipelineId:policy.pipelineId,generation,policy,
    fingerprint:prepareNativeEmailCapabilityContract(policy,{binding:{pipelineId:policy.pipelineId,workspaceId:workspace,
      ownerSuiteCrmId:'1',audienceFingerprint:policy.audienceFingerprint,allowedReaderSuiteCrmUserIds:principals},
      livePrincipalSuiteCrmUserIds:principals,approvedFutureCreate:capabilities,liveHistorical:[]}).futurePolicyFingerprint}))
  const preparedAt=new Date().toISOString().slice(0,19).replace('T',' '),planHash=hash(plan)
  const result={generation,appSourceFingerprint:current.fingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,
    afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
    installedRuntimeFingerprint:hash('fixture installed runtime'),runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,
    identityFingerprint:hash('fixture identities'),capabilitiesFingerprint:hash('fixture capabilities'),
    bindingsFingerprint:hash('fixture bindings'),defaultsFingerprint:hash('fixture defaults'),emailCount:plan.emails.length,
    principalCount:principals.length}
  const delta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId,planHash,preparedAt,
    changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies}
  const issuedAt=await clock(tx),approval={proof:{version:1,purpose:'clawpilot-native-email-initial-enrollment-approval',
    issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-initial-enrollment',keyId:'fixture-archive-stage',nativeInstanceId,
    serviceUserId:'1',oauthClientId:id(),issuedAt,expiresAt:issuedAt+120,operationId,planHash,appGeneration:generation,
    appSourceFingerprint:current.fingerprint,preparedAt,deltaFingerprint:hash(delta),sourceRuntimeFingerprint:result.sourceRuntimeFingerprint,
    installedRuntimeFingerprint:result.installedRuntimeFingerprint,installationJournalFingerprint:hash('fixture installation journal')},
    signature:'A'.repeat(512)}
  await tx.query(`INSERT INTO crm_native_email_initial_enrollments(operation_id,plan,plan_canonical,plan_hash,native_delta,
    native_delta_canonical,delta_fingerprint,approval_envelope,approval_canonical,approval_hash,actor_email,operator_account_id,
    root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [operationId,plan,canonical(plan),planHash,delta,canonical(delta),hash(delta),approval,canonical(approval),hash(approval),
    owner,account,workspace,nativeInstanceId,generation,current.value,current.fingerprint])
  await tx.query("UPDATE crm_native_email_initial_enrollments SET state='dispatched' WHERE operation_id=$1",[operationId])
  const receipt={version:1,purpose:'clawpilot-native-email-initial-enrollment-receipt',operationId,planHash,
    approvalHash:hash(approval),state:'committed',result},activationHash=hash(receipt)
  await tx.query(`UPDATE crm_native_email_initial_enrollments SET state='activated',native_receipt=$1,receipt_canonical=$2,
    receipt_hash=$3,settling_xid=txid_current(),updated_at=clock_timestamp() WHERE operation_id=$4`,
  [receipt,canonical(receipt),activationHash,operationId])
  await tx.query(`UPDATE crm_native_email_initial_reservations SET state='activated',settling_xid=txid_current(),
    updated_at=clock_timestamp() WHERE operation_id=$1`,[operationId])
  for(const p of policies)await tx.query(`INSERT INTO crm_native_email_capability_policies(pipeline_id,generation,policy,fingerprint)
    VALUES($1,$2,$3,$4)`,[p.pipelineId,p.generation,p.policy,p.fingerprint])
  await tx.query(`UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,
    native_policy_fingerprint=$1,activation_receipt_hash=$2,active_initial_enrollment_id=NULL`,
  [plan.nativePolicyAfterFingerprint,activationHash])
  return {activationHash,generation}
}

try{
  execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
    '-e','POSTGRES_PASSWORD=archive_stage_fixture','-e','POSTGRES_DB=archive_stage_fixture','-p','127.0.0.1::5432',
    `pgvector/pgvector:pg${major}`]),{stdio:'pipe',timeout:60000})
  started=true
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
  assert.ok(port,'Fixture must bind loopback only')
  pool=new Pool({host:'127.0.0.1',port:Number(port),database:'archive_stage_fixture',user:'postgres',password:'archive_stage_fixture',
    ssl:false,max:4,connectionTimeoutMillis:1000,statement_timeout:20000,options:'-c timezone=UTC'})
  const readyBy=Date.now()+30000
  for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>readyBy)throw error;await new Promise(r=>setTimeout(r,100))}}
  const query=(sql,params)=>pool.query(sql,params)
  async function transaction(fn,begin='BEGIN'){
    const tx=await pool.connect()
    try{await tx.query(begin);const result=await fn(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  const asRole=(role,fn,{readOnly=false}={})=>transaction(async tx=>{
    assert.match(role,/^fixture_[a-z_]+$/u)
    await tx.query(`SET LOCAL ROLE ${role}`);return fn(tx)
  },readOnly?'BEGIN READ ONLY':'BEGIN')
  const migrate=await pool.connect()
  try{
    assert.equal(single(await migrate.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).count,'0')
    const migrations=readdirSync(new URL('../db/migrations/',import.meta.url)).filter(name=>/^\d+_.+\.sql$/u.test(name)).sort()
    assert.ok(['0406_','0407_','0410_','0411_'].every(prefix=>migrations.some(name=>name.startsWith(prefix))))
    for(const name of migrations)await applyMigrationSqlForTest(migrate,name,source('db/migrations/'+name))
  }finally{migrate.release()}

  const retireSQL='SELECT crm_legacy_email_retirement.retire($1::uuid,$2::uuid[],$3::text) AS count'
  const resolveSQL='SELECT crm_legacy_email_retirement.resolve($1::uuid,$2::text,$3::text) AS receipt'
  const stageSQL='SELECT public.clawpilot_crm_legacy_email_stage($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text,$9::bigint,$10::bigint,$11::jsonb) AS receipt'
  const stageReadSQL='SELECT public.clawpilot_crm_legacy_email_stage_read($1::uuid,$2::text) AS receipt'
  const stageSourceSQL='SELECT public.clawpilot_crm_legacy_email_stage_source($1::uuid,$2::text) AS source'
  const receipt=async(tx,sql,params)=>single(await tx.query(sql,params)).receipt
  const attestRole='fixture_archive_attestor',retireRole='fixture_archive_retire',stageRole='fixture_archive_stage'
  const resolveRole='fixture_archive_resolve',ordinaryRole='fixture_ordinary_worker'
  const claim=ordinaryClaim(fn=>asRole(ordinaryRole,fn))
  for(const role of [attestRole,retireRole,stageRole,resolveRole,ordinaryRole])await query(`CREATE ROLE ${role} NOLOGIN`)
  await check('production migrations grant no application role authority, create no work, and leave publication disabled',async()=>{
    assert.deepEqual(single(await query(`SELECT enabled,active_initial_enrollment_id,active_operation_id,active_transition_id
      FROM crm_native_email_publication_control`)),{enabled:false,active_initial_enrollment_id:null,active_operation_id:null,active_transition_id:null})
    for(const table of ['crm_legacy_email_retirement.retained','crm_legacy_email_retirement.consumed',
      'crm_legacy_email_recovery_holds','crm_legacy_email_recovery_stages','sync_outbox']){
      assert.equal(single(await query(`SELECT count(*) FROM ${table}`)).count,'0')
    }
    assert.equal(single(await query(`SELECT has_schema_privilege($1,'crm_legacy_email_retirement','USAGE') AS allowed`,[ordinaryRole])).allowed,false)
    assert.equal(single(await query(`SELECT has_function_privilege($1,'public.clawpilot_crm_legacy_email_stage(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb)','EXECUTE') AS allowed`,[ordinaryRole])).allowed,false)
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query('SELECT * FROM crm_legacy_email_recovery_stages')),refusal('42501'))
  })
  // Fixture-only grants deliberately split evidence insertion, archival, staging,
  // and resolution. No LOGIN, runtime role changes or production grant script.
  await query(`GRANT USAGE ON SCHEMA crm_legacy_email_retirement TO ${attestRole},${retireRole},${resolveRole};
    GRANT INSERT ON crm_legacy_email_retirement.verified_batch,crm_legacy_email_retirement.review TO ${attestRole};
    GRANT EXECUTE ON FUNCTION crm_legacy_email_retirement.retire(uuid,uuid[],text) TO ${retireRole};
    GRANT EXECUTE ON FUNCTION crm_legacy_email_retirement.resolve(uuid,text,text) TO ${resolveRole};
    GRANT EXECUTE ON FUNCTION public.clawpilot_crm_legacy_email_stage(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) TO ${stageRole};
    GRANT EXECUTE ON FUNCTION public.clawpilot_crm_legacy_email_stage_read(uuid,text) TO ${resolveRole};
    GRANT EXECUTE ON FUNCTION public.clawpilot_crm_legacy_email_stage_source(uuid,text) TO ${resolveRole};
    GRANT SELECT,INSERT,UPDATE ON sync_outbox TO ${ordinaryRole};
    GRANT SELECT,UPDATE ON crm_interactions TO ${ordinaryRole};
    GRANT SELECT ON crm_native_email_publication_control TO ${ordinaryRole};
    GRANT UPDATE(updated_at) ON crm_native_email_publication_control TO ${ordinaryRole};
    GRANT SELECT ON crm_native_email_publication_work TO ${ordinaryRole};
    GRANT SELECT,INSERT ON crm_native_email_publication_admissions TO ${ordinaryRole}`)

  await query(`WITH ref AS(SELECT allocate_crm_reference('gu') AS code)
    INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
    SELECT $1,'owner','active','1',code,code,true FROM ref`,[owner])
  await query("INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by) VALUES($1,'Archive fixture','root',$2,$2)",[workspace,owner])
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'owner','active','{"viewCrm":true}',$1,$1)`,[owner,workspace])
  await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by)
    VALUES($1,$2,$3,true,$3,$3)`,[account,workspace,owner])
  await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
    VALUES($1,$2,$3,true,$3,$3)`,[account,workspace,owner])
  for(const [index,pipeline] of pipelines.entries())await query(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id)
    VALUES($1,$2,$3,$4)`,[pipeline,'Archive pipeline '+index,owner,workspace])
  await check('separately authorized account repair preserves one terminal Email, its provider evidence and same job',async()=>{
    const schema='crm_legacy_email_retirement'
    const previewSql=`SELECT ${schema}.preview_account_repair($1::jsonb) AS result`
    const repairSql=`SELECT ${schema}.repair_account_links($1::uuid,$2::jsonb,$3::text) AS result`
    const readSql=`SELECT ${schema}.read_account_repair($1::uuid,$2::text) AS result`
    const signature=['preview_account_repair(jsonb)','repair_account_links(uuid,jsonb,text)','read_account_repair(uuid,text)']
    const roles=['fixture_repair_preview','fixture_repair_attestor','fixture_repair_execute','fixture_repair_read']
    const [previewRole,approvalRole,repairRole,readRole]=roles
    const [operationId,outboxId,localId,nativeId,oldPrimaryId,newPrimaryId,oldPrimaryNativeId,newPrimaryNativeId,mailboxId,canonicalSourceId,
      contactId,contactNativeId]=Array.from({length:12},()=>id())
    const cleanup=new Error('roll back only the synthetic account repair and its receipts')
    const approvalDigest=hash(['synthetic account repair approval',operationId]),pipelineId=pipelines[0]
    await assert.rejects(transaction(async tx=>{
      for(const role of roles)await tx.query(`CREATE ROLE ${role} NOLOGIN`)
      assert.deepEqual((await tx.query(`SELECT has_function_privilege($1,name,'EXECUTE') AS allowed
        FROM unnest($2::text[]) name`,[ordinaryRole,signature.map(name=>schema+'.'+name)])).rows,signature.map(()=>({allowed:false})))
      await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO ${roles.join(',')};
        GRANT EXECUTE ON FUNCTION ${schema}.${signature[0]} TO ${previewRole};
        GRANT INSERT ON ${schema}.account_repair_approvals TO ${approvalRole};
        GRANT EXECUTE ON FUNCTION ${schema}.${signature[1]} TO ${repairRole};
        GRANT EXECUTE ON FUNCTION ${schema}.${signature[2]} TO ${readRole}`)
      const controlled=async(role,sql,params)=>{
        await tx.query(`SET LOCAL ROLE ${role}`)
        const result=await tx.query(sql,params)
        await tx.query('RESET ROLE')
        return result
      }
      const reject=async(role,sql,params,code)=>{
        await tx.query('SAVEPOINT reject_repair')
        try {
          await tx.query(`SET LOCAL ROLE ${role}`)
          await assert.rejects(tx.query(sql,params),refusal(code))
        } finally {
          await tx.query('ROLLBACK TO SAVEPOINT reject_repair')
          await tx.query('RELEASE SAVEPOINT reject_repair')
        }
      }
      const {generation}=single(await tx.query('SELECT generation FROM crm_native_email_publication_control WHERE singleton'))
      for(const [org,native,type] of [[oldPrimaryId,oldPrimaryNativeId,'Supplier'],[newPrimaryId,newPrimaryNativeId,'Customer']])
        await tx.query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,
          relationship_type,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
          VALUES($1,$2,$3,$4,$4,$5,$6,'customer','{}',$7,'synced',now(),allocate_crm_reference('ga'))`,
        [org,pipelineId,native,'account-repair-fixture:'+org,'Synthetic repair '+type,type,hash(org)])
      await tx.query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,
        last_name,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
        VALUES($1,$2,$3,$4,$5,$5,'Synthetic Supplier Contact','Contact','{}',$6,'synced',now(),allocate_crm_reference('gc'))`,
      [contactId,pipelineId,oldPrimaryId,contactNativeId,'account-repair-fixture:'+contactId,hash(contactId)])
      const globalId=single(await tx.query("SELECT allocate_crm_reference('gi') AS id")).id
      const messageId='ab'+id().replaceAll('-',''),threadId='cd'+id().replaceAll('-','')
      const evidence={fixtureOnly:true,messageId,threadId,body:'REPAIR_BODY_NOT_FOR_REVIEW_OR_RECEIPT'}
      const sourceHash=hash(evidence),connectionId='repair-connection-'+id()
      await tx.query(`INSERT INTO crm_email_mailboxes(id,owner_email,provider,provider_account_id,account_email,verified_at)
        VALUES($1,$2,'gmail',$3,$2,clock_timestamp())`,[mailboxId,owner,'repair-fixture:'+mailboxId])
      await tx.query(`INSERT INTO crm_email_sources(id,mailbox_id,owner_email,provider_message_id,provider_thread_id,intake_pipeline_id,
        intake_workspace_id,observed_connection_id,observed_account_email,evidence,evidence_hash,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$3,$9,$10,'{"fixtureOnly":true}')`,
      [canonicalSourceId,mailboxId,owner,messageId,threadId,pipelineId,workspace,connectionId,evidence,sourceHash])
      await tx.query(`INSERT INTO crm_interactions(id,pipeline_id,organization_id,canonical_source_id,provider_message_id,provider_thread_id,contact_id,
        source_key,subject,description,source_hash,suitecrm_id,suitecrm_module,reference_code,source_payload,sync_status,sync_error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic failed Supplier-only Email',$9,$10,$11,'Emails',$12,'{}','failed','legacy sync failed')`,
      [localId,pipelineId,oldPrimaryId,canonicalSourceId,messageId,threadId,contactId,'repair-fixture:'+messageId,evidence.body,sourceHash,nativeId,globalId])
      await tx.query('INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary) VALUES($1,$2,$3,true)',
        [pipelineId,localId,contactId])
      const link=relatedBeanId=>({linkFieldName:'accounts',relatedModuleName:'Accounts',relatedBeanId})
      const contactLink={linkFieldName:'contacts',relatedModuleName:'Contacts',relatedBeanId:contactNativeId}
      const originalPayload={entity:'interactions',localId,pipelineId,suiteCrmId:nativeId,suiteCrmModule:'Emails',
        attributes:{global_id_c:globalId,assigned_user_id:'1',description:evidence.body,parent_type:'Accounts',parent_id:oldPrimaryNativeId},
        relationships:[link(oldPrimaryNativeId),contactLink],emailProjection:{version:1,accounts:[oldPrimaryNativeId],contacts:[contactNativeId],
          contactAccounts:[{contactId:contactNativeId,accountId:oldPrimaryNativeId}],
          previousManaged:{accounts:[],contacts:[]},audience:audience(pipelineId,['1','2'])}}
      await tx.query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,last_error,
        processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,
        'native_projection_proof_unavailable',now(),$4)`,[outboxId,localId,originalPayload,`crm:interactions:v4:${localId}:Emails:${sourceHash}`])
      const exact={outboxId,localId,pipelineId,workspaceId:workspace,globalId,nativeId,oldPrimaryId,newPrimaryId,oldPrimaryNativeId,newPrimaryNativeId}
      const snapshot=async()=>single(await tx.query(`SELECT (SELECT to_jsonb(i) FROM crm_interactions i WHERE id=$1) AS interaction,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sync_outbox o WHERE aggregate_id=$1::uuid::text) AS jobs,
        (SELECT jsonb_agg(to_jsonb(edge) ORDER BY organization_id) FROM crm_interaction_organizations edge WHERE interaction_id=$1) AS edges,
        (SELECT jsonb_agg(to_jsonb(edge) ORDER BY contact_id) FROM crm_interaction_contacts edge WHERE interaction_id=$1) AS contacts,
        (SELECT to_jsonb(source) FROM crm_email_sources source WHERE id=$2) AS evidence`,[localId,canonicalSourceId]))
      const before=await snapshot()
      assert.equal(before.edges.length,1)
      assert.equal(before.edges[0].organization_id,oldPrimaryId)
      assert.equal(before.edges[0].is_primary,true)
      await reject(approvalRole,repairSql,[operationId,exact,approvalDigest],'42501')
      await reject(previewRole,repairSql,[operationId,exact,approvalDigest],'42501')
      await reject(readRole,previewSql,[exact],'42501')
      await reject(repairRole,`SELECT * FROM ${schema}.account_repair_approvals`,[],'42501')
      await reject(repairRole,'UPDATE crm_interactions SET organization_id=$2 WHERE id=$1',[localId,newPrimaryId],'42501')
      const preview=single(await controlled(previewRole,previewSql,[exact])).result
      assert.deepEqual(preview.review.target,exact)
      assert.match(preview.reviewDigest,/^[a-f0-9]{64}$/u)
      for(const key of ['sourceDigest','outboxDigest','edgeDigest','nextPayloadDigest'])assert.match(preview.review[key],/^[a-f0-9]{64}$/u)
      assert.ok(!JSON.stringify(preview).includes(evidence.body))
      assert.deepEqual(await snapshot(),before,'Preview did not change the Email, terminal job, edges or provider evidence')
      const repairArgs=[operationId,exact,approvalDigest]
      await reject(repairRole,repairSql,repairArgs,'55000')
      assert.deepEqual(single(await controlled(readRole,readSql,[operationId,approvalDigest])).result,{state:'unknown'})
      await controlled(approvalRole,`INSERT INTO ${schema}.account_repair_approvals
        (operation_id,generation,review_digest,approval_digest,fence_epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '90 seconds')`,
      [operationId,generation,preview.reviewDigest,approvalDigest,id()])
      await tx.query('SAVEPOINT stale_repair')
      await tx.query("UPDATE sync_outbox SET last_error='synthetic stale terminal bytes' WHERE id=$1",[outboxId])
      const drifted=await snapshot()
      await reject(repairRole,repairSql,repairArgs,'55000')
      assert.deepEqual(await snapshot(),drifted,'Stale compare wrote no interaction, edge, source or queue data')
      await tx.query('ROLLBACK TO SAVEPOINT stale_repair')
      await tx.query('RELEASE SAVEPOINT stale_repair')
      assert.deepEqual(await snapshot(),before)
      await reject(repairRole,repairSql,[operationId,exact,hash('not the signed approval')],'55000')
      const committed=single(await controlled(repairRole,repairSql,repairArgs)).result
      assert.deepEqual(committed,{state:'committed',operationId,reviewDigest:preview.reviewDigest,receiptHash:committed.receiptHash})
      assert.match(committed.receiptHash,/^[a-f0-9]{64}$/u)
      assert.ok(!JSON.stringify(committed).includes(evidence.body))
      const after=await snapshot()
      assert.equal(after.interaction.organization_id,newPrimaryId)
      assert.notEqual(after.interaction.source_hash,before.interaction.source_hash,'Corrected placement must receive a fresh exact source hash')
      for(const key of ['id','pipeline_id','reference_code','suitecrm_id','suitecrm_module','suitecrm_synced_at',
        'provider_message_id','provider_thread_id','canonical_source_id','source_key','description','sync_status','sync_error','contact_id'])
        assert.deepEqual(after.interaction[key],before.interaction[key],key+' was preserved')
      assert.deepEqual(after.evidence,before.evidence)
      assert.deepEqual(after.contacts,before.contacts)
      assert.deepEqual(after.edges.map(edge=>[edge.organization_id,edge.is_primary]).sort(),
        [[oldPrimaryId,false],[newPrimaryId,true]].sort())
      assert.equal(after.jobs.length,1)
      const [updatedJob]=after.jobs,[originalJob]=before.jobs
      for(const key of ['id','aggregate_id','target_system','aggregate_type','operation','status','attempts',
        'available_at','processed_at','locked_at','lock_token','last_error','created_at'])
        assert.deepEqual(updatedJob[key],originalJob[key],key+' was preserved; no requeue')
      assert.equal(updatedJob.idempotency_key,`crm:interactions:v4:${localId}:Emails:${after.interaction.source_hash}`)
      assert.deepEqual(updatedJob.payload.attributes,{...originalPayload.attributes,parent_id:newPrimaryNativeId})
      assert.deepEqual(updatedJob.payload.emailProjection,{...originalPayload.emailProjection,
        accounts:[oldPrimaryNativeId,newPrimaryNativeId].sort()})
      assert.deepEqual(updatedJob.payload.relationships,[...originalPayload.relationships,link(newPrimaryNativeId)])
      const original=single(await tx.query(`SELECT original_source,original_outbox,original_edges,reviewed_plan
        FROM ${schema}.account_repairs WHERE operation_id=$1`,[operationId]))
      assert.deepEqual(original,{original_source:before.interaction,original_outbox:originalJob,
        original_edges:before.edges,reviewed_plan:preview.review})
      assert.deepEqual(single(await controlled(readRole,readSql,[operationId,approvalDigest])).result,committed)
      assert.deepEqual(single(await controlled(readRole,readSql,[operationId,hash('wrong approval digest')])).result,{state:'unknown'})
      await reject(repairRole,repairSql,repairArgs,'55000')
      assert.deepEqual(await snapshot(),after,'Exact receipt read did not touch the replacement')
      assert.deepEqual(single(await tx.query(`SELECT
        EXISTS(SELECT 1 FROM ${schema}.retained WHERE local_id=$1) AS archived,
        EXISTS(SELECT 1 FROM crm_legacy_email_recovery_holds WHERE local_id=$1) AS held,
        EXISTS(SELECT 1 FROM crm_native_email_publication_admissions WHERE local_id=$1) AS admitted`,[localId])),
      {archived:false,held:false,admitted:false})
      throw cleanup
    }),error=>error===cleanup)
    assert.deepEqual(single(await query(`SELECT EXISTS(SELECT 1 FROM crm_interactions WHERE id=$1) AS source,
      EXISTS(SELECT 1 FROM sync_outbox WHERE id=$2) AS job,
      EXISTS(SELECT 1 FROM ${schema}.account_repair_approvals WHERE operation_id=$3) AS approval`,[localId,outboxId,operationId])),
    {source:false,job:false,approval:false})
  })
  await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,suitecrm_synced_at,
    reference_code,source_payload,sync_status) VALUES($1,$2,'known-history','Synthetic known native history',$3,$4,'Emails',now(),
    allocate_crm_reference('gi'),'{}','synced')`,[id(),pipelines[0],hash('known history'),id()])
  const unrelated=id()
  await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES($1,'suitecrm','fixture_unrelated',$2,'upsert_record','{}')`,[unrelated,id()])
  const body='SYNTHETIC_ARCHIVED_BODY_NOT_FOR_RECEIPTS'
  const jobs=[],providerMessageIds=new Map()
  for(const [index,pipelineId] of pipelines.entries()){
    const outboxId=id(),localId=id(),nativeId=id(),sourceHash=hash(['archive fixture source',index])
    const providerMessageId=(160+index).toString(16)
    const globalId=single(await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,
      suitecrm_module,reference_code,source_payload,sync_status,provider_message_id) VALUES($1,$2,$3,'Synthetic terminal legacy Email',$4,$5,'Emails',
      allocate_crm_reference('gi'),'{}','failed',$6) RETURNING reference_code`,[localId,pipelineId,'legacy-archive-stage-'+index,sourceHash,nativeId,providerMessageId])).reference_code
    const payload={entity:'interactions',localId,pipelineId,suiteCrmId:nativeId,suiteCrmModule:'Emails',
      attributes:{global_id_c:globalId,assigned_user_id:'1',description:body},emailProjection:{version:1,accounts:[],contacts:[],contactAccounts:[],
        previousManaged:{accounts:[],contacts:[]},audience:audience(pipelineId,['1','2'])}}
    await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,last_error,
      processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,'Synthetic provider outcome unknown',
      now(),$4)`,[outboxId,localId,payload,`crm:interactions:v4:${localId}:Emails:${sourceHash}`])
    jobs.push({outboxId,localId,pipelineId,workspaceId:workspace,nativeId,globalId,attempts:8})
    providerMessageIds.set(outboxId,providerMessageId)
  }
  jobs.sort((a,b)=>a.outboxId.localeCompare(b.outboxId))
  const ids=jobs.map(job=>job.outboxId)
  const queue=async()=> (await query('SELECT to_jsonb(o) AS value FROM sync_outbox o ORDER BY id')).rows.map(row=>row.value)
  const sources=async()=> (await query('SELECT to_jsonb(i) AS value FROM crm_interactions i WHERE id=ANY($1::uuid[]) ORDER BY id',
    [jobs.map(job=>job.localId)])).rows.map(row=>row.value)
  const before=await queue(),originals=before.filter(row=>ids.includes(row.id)),sourceBefore=await sources()
  const reviewRowsSql=`SELECT o.id AS outbox_id,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS outbox_hash,
    encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS source_hash,
    encode(public.digest(o.payload::text,'sha256'),'hex') AS payload_hash,
    encode(public.digest(o.idempotency_key,'sha256'),'hex') AS key_hash
    FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`
  const reviewed=await query(reviewRowsSql,[ids])
  const operationId=id(),fenceEpoch=id(),generation=Number(single(await query('SELECT generation FROM crm_native_email_publication_control')).generation)
  const rows=jobs.map((job,index)=>{
    const pin=reviewed.rows[index];assert.equal(pin.outbox_id,job.outboxId)
    return {...job,rowFingerprint:pin.outbox_hash,sourceFingerprint:pin.source_hash,payloadFingerprint:pin.payload_hash,keyFingerprint:pin.key_hash}
  })
  const manifest={version:1,action:'archive_exact_legacy_terminal_rows_only',publicationDisposition:'reviewed_recovery',operationId,
    scope:{projectId:id(),environmentId:id(),postgresDatabaseFingerprint:hash('fixture db'),appCommit:'a'.repeat(40),
      nativeDeploymentId:id(),nativeReplicaId:id(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('fixture native db')},
    actorEmail:owner,operatorAccountId:account,rootWorkspaceId:workspace,appGeneration:generation,gateFingerprint:hash('fixture gate'),
    appSourceFingerprint:hash('fixture app source'),fenceEpoch,fenceEvidenceFingerprint:hash('fixture fence evidence'),
    nativeAbsenceFingerprint:hash('fixture native absence'),historicalProviderOutcome:'unknown',rows}
  const fenceKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  const operatorKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
  function approveFixture(expectedManifest,issuedAt){
    const expiresAt=issuedAt+120,manifestDigest=legacyEmailRetirementManifestDigest(expectedManifest)
    const common={version:1,audience:'clawpilot-private-legacy-email-retirement-controller',
      operationId:expectedManifest.operationId,manifestDigest,issuedAt,expiresAt}
    const fenceEnvelope=sign({...common,purpose:'clawpilot-legacy-email-fenced-absence-v1',
      issuer:'clawpilot-crm-fence-attestor',keyId:'fixture-fence'},fenceKeys.privateKey)
    const operatorEnvelope=sign({...common,purpose:'clawpilot-legacy-email-retirement-review-v1',
      issuer:'clawpilot-crm-retirement-operator',keyId:'fixture-operator',fenceEnvelopeDigest:hash(fenceEnvelope)},operatorKeys.privateKey)
    const approved=verifyLegacyEmailRetirementApproval({expectedManifest,fenceEnvelope,operatorEnvelope,
      fenceAnchor:{keyId:'fixture-fence',key:fenceKeys.publicKey},operatorAnchor:{keyId:'fixture-operator',key:operatorKeys.publicKey},
      nowSeconds:issuedAt})
    assert.equal(approved.liveFenceProven,false,'A real signature over synthetic evidence is not a real writer fence')
    return approved
  }
  const approval=approveFixture(manifest,await clock(pool)),{manifestDigest}=approval
  const retireArgs=[operationId,ids,approval.approvalEnvelopeDigest],resolveArgs=[operationId,manifestDigest,approval.approvalEnvelopeDigest]
  async function recordFixtureReview(tx,reviewedManifest,approved,useDatabaseDefault=false){
    const {operationId:batch,appGeneration,fenceEpoch:epoch,rows:reviewRows,publicationDisposition}=reviewedManifest
    const {expiresAt,manifestDigest,fenceEnvelopeDigest,approvalEnvelopeDigest}=approved
    await tx.query(`INSERT INTO crm_legacy_email_retirement.verified_batch(batch,generation,fence_epoch,valid_until,expected_rows,
      manifest_hash,fence_hash,approval_hash,publication_disposition) VALUES($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,${useDatabaseDefault?'DEFAULT':'$9'})`,
    [batch,appGeneration,epoch,expiresAt,reviewRows.length,manifestDigest,fenceEnvelopeDigest,approvalEnvelopeDigest,
      ...(useDatabaseDefault?[]:[publicationDisposition])])
    for(const row of reviewRows)await tx.query(`INSERT INTO crm_legacy_email_retirement.review(batch,outbox_id,generation,outbox_hash,source_hash,
      fence_epoch,valid_until,attestation,local_id,pipeline_id,workspace_id,native_id,global_id,payload_hash,key_hash)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7),'verified_fenced_absence',$8,$9,$10,$11,$12,$13,$14)`,
    [batch,row.outboxId,appGeneration,row.rowFingerprint,row.sourceFingerprint,epoch,expiresAt,row.localId,row.pipelineId,
      row.workspaceId,row.nativeId,row.globalId,row.payloadFingerprint,row.keyFingerprint])
  }
  await asRole(attestRole,tx=>recordFixtureReview(tx,manifest,approval))

  await check('archive roles are split; subset, changed hashes, and stale source or queue bytes fail with no partial retirement',async()=>{
    await assert.rejects(asRole(attestRole,tx=>tx.query(retireSQL,retireArgs)),refusal('42501'))
    await assert.rejects(asRole(retireRole,tx=>tx.query('UPDATE crm_legacy_email_retirement.review SET outbox_hash=outbox_hash')),refusal('42501'))
    await assert.rejects(asRole(retireRole,tx=>tx.query(retireSQL,[operationId,ids.slice(1),retireArgs[2]])),refusal('55000'))
    await assert.rejects(asRole(retireRole,tx=>tx.query(retireSQL,[operationId,ids,hash('wrong approval')])),refusal('55000'))
    for(const [sql,param] of [["UPDATE sync_outbox SET last_error='drift' WHERE id=$1",ids[1]],
      ["UPDATE crm_interactions SET subject='drift' WHERE id=$1",rows[1].localId]]){
      await assert.rejects(transaction(async tx=>{
        await tx.query(sql,[param]);await tx.query(`SET LOCAL ROLE ${retireRole}`);await tx.query(retireSQL,retireArgs)
      }),refusal('55000'))
      assert.deepEqual(await queue(),before);assert.deepEqual(await sources(),sourceBefore)
      assert.equal(single(await query('SELECT count(*) FROM crm_legacy_email_retirement.retained')).count,'0')
    }
  })

  await check('six jobs block enrollment until separately archived; archive-only keeps receipts but cannot stage',async()=>{
    const discard=new Error('discard synthetic outside-batch scenario')
    await assert.rejects(transaction(async tx=>{
      const outside=[]
      for(let n=0;n<6;n++){
        const job=id(),local=id(),native=id(),sourceHash=hash(['outside retirement approval',n])
        const {global_id}=single(await tx.query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,
          suitecrm_id,suitecrm_module,reference_code,source_payload,sync_status)
          VALUES($1,$2,$3,'Unreviewed synthetic interaction',$4,$5,'Emails',allocate_crm_reference('gi'),'{}','failed')
          RETURNING reference_code AS global_id`,[local,pipelines[0],'outside-retirement-'+n,sourceHash,native]))
        const payload={entity:'interactions',localId:local,pipelineId:pipelines[0],suiteCrmId:native,suiteCrmModule:'Emails',
          attributes:{global_id_c:global_id,assigned_user_id:'1'},emailProjection:{version:1,accounts:[],contacts:[],contactAccounts:[],
            previousManaged:{accounts:[],contacts:[]},audience:audience(pipelines[0])}}
        await tx.query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,
          last_error,processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,
          'Synthetic outside-batch failure',now(),$4)`,[job,local,payload,`crm:interactions:v4:${local}:Emails:${sourceHash}`])
        outside.push({outboxId:job,localId:local,pipelineId:pipelines[0],workspaceId:workspace,nativeId:native,globalId:global_id,attempts:8})
      }
      const outsideIds=outside.map(row=>row.outboxId).sort()
      const snapshotOutside=async()=>(await tx.query(`SELECT to_jsonb(o) AS value FROM sync_outbox o
        WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`,[outsideIds])).rows
      const exactOutsideBefore=await snapshotOutside()
      assert.equal(exactOutsideBefore.length,6)
      await tx.query('SAVEPOINT reject_outside_archive')
      await tx.query(`SET LOCAL ROLE ${retireRole}`)
      await assert.rejects(tx.query(retireSQL,[operationId,[...ids,outsideIds[0]].sort(),retireArgs[2]]),refusal('55000'))
      await tx.query('ROLLBACK TO SAVEPOINT reject_outside_archive')
      await tx.query(`SET LOCAL ROLE ${retireRole}`)
      assert.equal(single(await tx.query(retireSQL,retireArgs)).count,ids.length)
      await tx.query('RESET ROLE')
      assert.deepEqual(await snapshotOutside(),exactOutsideBefore)
      assert.equal(single(await tx.query('SELECT count(*)::int AS n FROM sync_outbox WHERE id=ANY($1::uuid[])',[ids])).n,0)
      assert.equal(single(await tx.query('SELECT count(*)::int AS n FROM crm_legacy_email_retirement.retained')).n,ids.length)
      assert.equal((await tx.query("UPDATE crm_interactions SET subject='Unreviewed record is still editable' WHERE id=$1",[outside[0].localId])).rowCount,1)
      await tx.query('SAVEPOINT reject_activation_with_six')
      await assert.rejects(activateSyntheticInitial(tx),error=>error.code==='55000'&&/requires unresolved writers/.test(error.message))
      await tx.query('ROLLBACK TO SAVEPOINT reject_activation_with_six')
      assert.deepEqual(single(await tx.query(`SELECT enabled,active_initial_enrollment_id
        FROM crm_native_email_publication_control`)),{enabled:false,active_initial_enrollment_id:null})
      assert.deepEqual(await snapshotOutside(),exactOutsideBefore)

      const archiveOnlyRows=(await tx.query(reviewRowsSql,[outsideIds])).rows.map(pin=>({
        ...outside.find(row=>row.outboxId===pin.outbox_id),rowFingerprint:pin.outbox_hash,sourceFingerprint:pin.source_hash,
        payloadFingerprint:pin.payload_hash,keyFingerprint:pin.key_hash,
      }))
      const archiveOnlyManifest={...manifest,publicationDisposition:'archive_only',operationId:id(),fenceEpoch:id(),rows:archiveOnlyRows}
      const archiveOnlyApproval=approveFixture(archiveOnlyManifest,await clock(tx))
      await tx.query(`SET LOCAL ROLE ${attestRole}`)
      await recordFixtureReview(tx,archiveOnlyManifest,archiveOnlyApproval,true)
      await tx.query('RESET ROLE')
      assert.equal(single(await tx.query(`SELECT publication_disposition FROM crm_legacy_email_retirement.verified_batch WHERE batch=$1`,
        [archiveOnlyManifest.operationId])).publication_disposition,'archive_only')
      await tx.query('SAVEPOINT reject_disposition_update')
      await assert.rejects(tx.query(`UPDATE crm_legacy_email_retirement.verified_batch SET publication_disposition='reviewed_recovery'
        WHERE batch=$1`,[archiveOnlyManifest.operationId]),refusal('55000'))
      await tx.query('ROLLBACK TO SAVEPOINT reject_disposition_update')
      await tx.query(`SET LOCAL ROLE ${retireRole}`)
      assert.equal(single(await tx.query(retireSQL,[archiveOnlyManifest.operationId,outsideIds,archiveOnlyApproval.approvalEnvelopeDigest])).count,6)
      await tx.query('RESET ROLE')
      assert.deepEqual(await snapshotOutside(),[])
      const exactStored=(await tx.query(`SELECT original AS value FROM crm_legacy_email_retirement.retained
        WHERE batch=$1 ORDER BY outbox_id`,[archiveOnlyManifest.operationId])).rows
      assert.deepEqual(exactStored,exactOutsideBefore)
      const archiveOnlyResolve=[archiveOnlyManifest.operationId,archiveOnlyApproval.manifestDigest,archiveOnlyApproval.approvalEnvelopeDigest]
      await tx.query(`SET LOCAL ROLE ${resolveRole}`)
      const archiveOnlyReceipt=await receipt(tx,resolveSQL,archiveOnlyResolve)
      assert.equal(archiveOnlyReceipt.state,'committed')
      assert.equal(archiveOnlyReceipt.rows,6)
      assert.match(archiveOnlyReceipt.receiptHash,/^[a-f0-9]{64}$/u)
      const archivedOnly=archiveOnlyRows[0]
      assert.deepEqual(single(await tx.query(stageSourceSQL,[archivedOnly.outboxId,archiveOnlyReceipt.receiptHash])).source,{state:'unknown'})
      await tx.query('RESET ROLE')

      const activation=await activateSyntheticInitial(tx)
      const preAttemptQueue=(await tx.query('SELECT to_jsonb(o) AS value FROM sync_outbox o ORDER BY id')).rows
      const preAttemptSource=single(await tx.query('SELECT to_jsonb(i) AS value FROM crm_interactions i WHERE id=$1',[archivedOnly.localId])).value
      const [forgedHold,forgedOutbox,forgedLock]=[id(),id(),id()],now=await clock(tx),intent=hash('archive-only-stage-attempt')
      await tx.query('SAVEPOINT reject_archive_only_stage')
      await tx.query(`SET LOCAL ROLE ${stageRole}`)
      await assert.rejects(tx.query(stageSQL,[forgedHold,forgedOutbox,archivedOnly.outboxId,forgedLock,archiveOnlyReceipt.receiptHash,
        activation.activationHash,intent,hash('synthetic fresh stage approval'),now,now+120,audience(archivedOnly.pipelineId)]),
      error=>error?.code==='55000'&&/disposition does not permit staging/u.test(error.message))
      await tx.query('ROLLBACK TO SAVEPOINT reject_archive_only_stage')
      assert.deepEqual((await tx.query('SELECT to_jsonb(o) AS value FROM sync_outbox o ORDER BY id')).rows,preAttemptQueue)
      assert.deepEqual(single(await tx.query('SELECT to_jsonb(i) AS value FROM crm_interactions i WHERE id=$1',[archivedOnly.localId])).value,preAttemptSource)
      assert.equal(single(await tx.query('SELECT count(*)::int AS n FROM crm_legacy_email_recovery_stages')).n,0)
      assert.equal(single(await tx.query('SELECT count(*)::int AS n FROM crm_legacy_email_recovery_holds')).n,0)
      await tx.query(`SET LOCAL ROLE ${resolveRole}`)
      assert.deepEqual(await receipt(tx,stageReadSQL,[forgedHold,intent]),{state:'unknown'})
      assert.deepEqual(await receipt(tx,resolveSQL,archiveOnlyResolve),archiveOnlyReceipt)
      await tx.query('RESET ROLE')
      throw discard
    }),error=>error===discard)
    assert.deepEqual(await queue(),before);assert.deepEqual(await sources(),sourceBefore)
    assert.equal(single(await query('SELECT count(*) FROM crm_legacy_email_retirement.retained')).count,'0')
  })

  const stale=await pool.connect(),lostArchive=new Error('synthetic lost archive acknowledgement')
  try{
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await stale.query('SELECT id FROM sync_outbox WHERE id=$1',[unrelated])
    await check('atomic exact retirement preserves complete originals, does not change source, and resolves only after commit',async()=>{
      await assert.rejects(async()=>{
        await asRole(retireRole,async tx=>{
          assert.equal(single(await tx.query(retireSQL,retireArgs)).count,ids.length)
          assert.deepEqual(await asRole(resolveRole,reader=>receipt(reader,resolveSQL,resolveArgs),{readOnly:true}),{state:'unknown'})
        });throw lostArchive
      },error=>error===lostArchive)
      assert.deepEqual(await queue(),before.filter(row=>!ids.includes(row.id)))
      assert.deepEqual(await sources(),sourceBefore)
      const retained=(await query('SELECT original,historical_provider_outcome FROM crm_legacy_email_retirement.retained ORDER BY outbox_id')).rows
      assert.deepEqual(retained,originals.map(original=>({original,historical_provider_outcome:'unknown'})))
      assert.equal(single(await query('SELECT count(*) FROM crm_legacy_email_retirement.consumed')).count,'1')
    })
    await check('pre-retirement REPEATABLE READ writer must serialize rather than see an empty tombstone registry',async()=>{
      await assert.rejects(stale.query('UPDATE sync_outbox SET available_at=now() WHERE id=$1',[unrelated]),refusal('40001'))
    })
  }finally{try{await stale.query('ROLLBACK')}finally{stale.release()}}

  const readArchive=params=>asRole(resolveRole,tx=>receipt(tx,resolveSQL,params),{readOnly:true})
  let archived
  await check('exact archived receipt readback is stable, hash-bound, and does not expose archived body',async()=>{
    archived=await readArchive(resolveArgs)
    assert.equal(archived.state,'committed');assert.equal(archived.operationId,operationId);assert.equal(archived.rows,ids.length)
    assert.equal(archived.historicalProviderOutcome,'unknown');assert.match(archived.receiptHash,/^[a-f0-9]{64}$/u)
    assert.ok(!JSON.stringify(archived).includes(body))
    assert.deepEqual(await readArchive(resolveArgs),archived)
    assert.deepEqual(await readArchive([operationId,manifestDigest,hash('unrelated approval')]),{state:'unknown'})
    await assert.rejects(asRole(retireRole,tx=>tx.query(retireSQL,retireArgs)),refusal('55000'))
    await assert.rejects(query('UPDATE crm_legacy_email_retirement.retained SET original=original'),refusal('55000'))
    await assert.rejects(query('DELETE FROM crm_legacy_email_retirement.consumed'),refusal('55000'))
  })
  const first=rows[0],replacement=id(),hold=id(),lock=id()
  const aliasPayload={...originals[0].payload,localId:id(),suiteCrmId:first.nativeId.toUpperCase(),
    attributes:{...originals[0].payload.attributes,global_id_c:'gi0000001'}}
  const rawInsert=`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES($1,$2,'fixture_unrelated',$3,'upsert_record',$4)`
  async function assertTombstones(){
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(rawInsert,[first.outboxId,'not-suitecrm',id(),{}])),refusal('55000'))
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(rawInsert,[id(),'suitecrm',id(),aliasPayload])),refusal('55000'))
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(rawInsert,[id(),'suitecrm',id(),{...aliasPayload,suiteCrmId:id(),
      attributes:{...aliasPayload.attributes,global_id_c:first.globalId.toUpperCase()}}])),refusal('55000'))
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(`UPDATE crm_interactions SET subject='ordinary update' WHERE id=$1`,[first.localId])),refusal('55000'))
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(`INSERT INTO crm_native_email_publication_admissions(operation_id,pipeline_id,
      local_id,native_id,global_id,generation,native_policy_fingerprint,command_hash,audience_fingerprint,command,allowed_reader_ids,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,1,$1,$1,$1,'{}','[]',$1)`,[hash('ordinary forged admission'),first.pipelineId,first.localId,
      first.nativeId,first.globalId])),refusal('55000'))
  }
  await check('retired UUID, source and aliases cannot return while native authority remains disabled',assertTombstones)
  const activation=await transaction(activateSyntheticInitial)
  await check('real SQL enrollment gates activate only after the original terminal jobs are absent from the live queue',async()=>{
    const control=single(await query(`SELECT enabled,active_initial_enrollment_id,activation_receipt_hash FROM crm_native_email_publication_control`))
    assert.deepEqual(control,{enabled:true,active_initial_enrollment_id:null,activation_receipt_hash:activation.activationHash})
    assert.deepEqual(await sources(),sourceBefore)
  })
  const releasedAt=await clock(pool),releaseProof={version:1,purpose:'clawpilot-private-legacy-email-release-v1',keyId:'fixture-operator',
    holdId:hold,outboxId:replacement,retiredOutboxId:first.outboxId,localId:first.localId,nativeId:first.nativeId,globalId:first.globalId,
    pipelineId:first.pipelineId,workspaceId:workspace,sourceFingerprint:first.sourceFingerprint,retirementReceiptHash:archived.receiptHash,
    activationReceiptHash:activation.activationHash,requestFingerprint:hash('fixture exact native request'),nativeOperationId:hash('fixture native operation'),
    issuedAt:releasedAt,expiresAt:releasedAt+120}
  const releaseApproval=verifyLegacyEmailRecoveryReleaseApproval({envelope:sign(releaseProof,operatorKeys.privateKey),
    operatorAnchor:{keyId:'fixture-operator',key:operatorKeys.publicKey},nowSeconds:releasedAt})
  const stageArgs=[hold,replacement,first.outboxId,lock,archived.receiptHash,activation.activationHash,releaseApproval.intentHash,
    releaseApproval.approvalHash,releasedAt,releasedAt+120,audience(first.pipelineId)]
  const stageReadArgs=[hold,releaseApproval.intentHash]
  const callStage=params=>asRole(stageRole,tx=>receipt(tx,stageSQL,params))
  const readStage=params=>asRole(resolveRole,tx=>receipt(tx,stageReadSQL,params),{readOnly:true})
  const stageSource=async params=>asRole(resolveRole,async tx=>single(await tx.query(stageSourceSQL,params)).source,{readOnly:true})
  const rejectStage=async(index,value)=>{
    const args=[...stageArgs];args[index]=value
    await assert.rejects(callStage(args),refusal('55000'))
  }
  await check('exact archive source lookup is private and binds immutable original, source and canonical idempotency key',async()=>{
    const exact=await stageSource([first.outboxId,archived.receiptHash])
    assert.equal(exact.retiredOutboxId,first.outboxId);assert.equal(exact.localId,first.localId);assert.equal(exact.nativeId,first.nativeId)
    assert.equal(exact.retirementReceiptHash,archived.receiptHash);assert.equal(exact.sourceFingerprint,first.sourceFingerprint)
    assert.equal(exact.originalFingerprint,first.rowFingerprint);assert.deepEqual(exact.payload,originals[0].payload)
    assert.equal(exact.idempotencyKey,originals[0].idempotency_key)
    assert.deepEqual(await stageSource([first.outboxId,hash('wrong archive receipt')]),{state:'unknown'})
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(stageSourceSQL,[first.outboxId,archived.receiptHash])),refusal('42501'))
  })
  const preStage=await queue(),rollbackStage=new Error('rollback after exact stage SQL before commit')
  await check('direct SQL stage refuses another same-pipeline provider placement even with different native and global IDs',async()=>{
    const discard=new Error('discard synthetic provider collision scenario')
    const providerMessageId=providerMessageIds.get(first.outboxId)
    const alias=(tx,pipelineId,rawProviderMessageId)=>tx.query(`INSERT INTO crm_interactions
      (id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,reference_code,provider_message_id)
      VALUES($1,$2,$3,'Synthetic legacy Email placement',$4,$5,'Emails',allocate_crm_reference('gi'),$6)`,
    [id(),pipelineId,id(),hash('synthetic provider alias'),id(),rawProviderMessageId])
    await assert.rejects(transaction(async tx=>{
      await alias(tx,first.pipelineId,` ${providerMessageId.toUpperCase()} `)
      await tx.query(`SET LOCAL ROLE ${stageRole}`)
      return tx.query(stageSQL,stageArgs)
    }),error=>error?.code==='55000'&&/another publication/u.test(error.message))
    // The reviewed hold binds top-level transaction row identities. Test the
    // unrelated rows in a fresh transaction instead of staging in a savepoint.
    await assert.rejects(transaction(async tx=>{
      await alias(tx,pipelines.find(pipeline=>pipeline!==first.pipelineId),providerMessageId)
      await alias(tx,first.pipelineId,'  ')
      await tx.query(`SET LOCAL ROLE ${stageRole}`)
      assert.equal((await receipt(tx,stageSQL,stageArgs)).state,'staged')
      throw discard
    }),error=>error===discard)
    assert.deepEqual(await readStage(stageReadArgs),{state:'unknown'})
    assert.deepEqual(await queue(),preStage)
    await assert.rejects(transaction(async tx=>{
      await tx.query(`SET LOCAL ROLE ${stageRole}`)
      return tx.query(stageSQL,stageArgs)
    },'BEGIN ISOLATION LEVEL REPEATABLE READ'),error=>error?.code==='55000'&&/requires READ COMMITTED/u.test(error.message))
  })
  await check('bad receipt, activation, audience, approval window or ordinary role fails; rollback removes both replacement and hold',async()=>{
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query(stageSQL,stageArgs)),refusal('42501'))
    await rejectStage(4,hash('other retirement receipt'));await rejectStage(5,hash('other activation'))
    await rejectStage(10,originals[0].payload.emailProjection.audience)
    await rejectStage(9,releasedAt-1)
    await assert.rejects(asRole(stageRole,async tx=>{
      const r=await receipt(tx,stageSQL,stageArgs);assert.equal(r.state,'staged')
      assert.deepEqual(await readStage(stageReadArgs),{state:'unknown'});throw rollbackStage
    }),error=>error===rollbackStage)
    assert.deepEqual(await readStage(stageReadArgs),{state:'unknown'})
    assert.deepEqual(await queue(),preStage);assert.deepEqual(await sources(),sourceBefore)
    for(const table of ['crm_legacy_email_recovery_holds','crm_legacy_email_recovery_stages'])
      assert.equal(single(await query(`SELECT count(*) FROM ${table}`)).count,'0')
  })
  let staged
  const lostStage=new Error('synthetic lost stage acknowledgement')
  const preStageWriter=await pool.connect()
  try{
    await preStageWriter.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await preStageWriter.query('SELECT id FROM sync_outbox WHERE id=$1',[unrelated])
    await check('archive-to-stage is atomic, keeps original and source unchanged, and reconciles a lost stage acknowledgement',async()=>{
      await assert.rejects(async()=>{staged=await callStage(stageArgs);throw lostStage},error=>error===lostStage)
      assert.deepEqual(staged,{state:'staged',holdId:hold,outboxId:replacement,retiredOutboxId:first.outboxId,
        intentHash:releaseApproval.intentHash,receiptHash:staged.receiptHash})
      assert.match(staged.receiptHash,/^[a-f0-9]{64}$/u);assert.ok(!JSON.stringify(staged).includes(body))
      assert.deepEqual(await readStage(stageReadArgs),staged)
      assert.deepEqual(await readStage([hold,hash('other intent')]),{state:'unknown'})
      assert.deepEqual(await callStage(stageArgs),staged)
      await rejectStage(3,id())
      await assert.rejects(callStage([id(),id(),...stageArgs.slice(2)]),refusal('55000'))
      const current=single(await query('SELECT to_jsonb(o) AS value FROM sync_outbox o WHERE id=$1',[replacement])).value
      assert.equal(current.status,'processing');assert.equal(current.attempts,1);assert.equal(current.available_at,'infinity')
      assert.equal(current.lock_token,lock);assert.equal(current.idempotency_key,originals[0].idempotency_key)
      assert.deepEqual(current.payload,{...originals[0].payload,emailProjection:{...originals[0].payload.emailProjection,audience:audience(first.pipelineId)}})
      const pin=single(await query('SELECT * FROM crm_legacy_email_recovery_holds WHERE operation_id=$1',[hold]))
      assert.equal(pin.retired_outbox_id,first.outboxId);assert.equal(pin.outbox_id,replacement)
      assert.equal(pin.release_intent_hash,releaseApproval.intentHash);assert.equal(pin.retirement_receipt_hash,archived.receiptHash)
      assert.deepEqual(await sources(),sourceBefore)
      assert.deepEqual((await query('SELECT original FROM crm_legacy_email_retirement.retained ORDER BY outbox_id')).rows.map(row=>row.original),originals)
      assert.deepEqual((await queue()).filter(row=>row.id!==replacement),preStage)
    })
    await check('pre-stage REPEATABLE READ writer cannot continue with a stale protection snapshot',async()=>{
      await assert.rejects(preStageWriter.query('UPDATE sync_outbox SET available_at=now() WHERE id=$1',[unrelated]),refusal('40001'))
    })
  }finally{try{await preStageWriter.query('ROLLBACK')}finally{preStageWriter.release()}}
  await check('ordinary worker claims unrelated work only and cannot revive an original or mutate the private staged replacement',async()=>{
    await assertTombstones()
    await assert.rejects(asRole(ordinaryRole,tx=>tx.query("UPDATE sync_outbox SET status='queued' WHERE id=$1",[replacement])),refusal('55000'))
    const protectedBefore=single(await query('SELECT to_jsonb(o) AS value FROM sync_outbox o WHERE id=$1',[replacement])).value
    const claimed=await claim({limit:50,leaseSeconds:60,maxAttempts:20})
    assert.deepEqual(claimed.map(job=>job.id),[unrelated])
    assert.deepEqual(single(await query('SELECT to_jsonb(o) AS value FROM sync_outbox o WHERE id=$1',[replacement])).value,protectedBefore)
    assert.equal(single(await query('SELECT count(*) FROM crm_native_email_publication_admissions')).count,'0')
    assert.equal(single(await query('SELECT count(*) FROM crm_legacy_email_recovery_releases')).count,'0')
    assert.deepEqual(await readStage(stageReadArgs),staged)
  })
  console.log(`PASS ${checks} real PostgreSQL ${major} archive-to-stage groups; synthetic authority, no native/provider calls or production proof`)
}finally{
  try{if(pool)await pool.end()}
  finally{if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})}
}
