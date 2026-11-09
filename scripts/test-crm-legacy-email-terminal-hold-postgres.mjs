#!/usr/bin/env node
// Actual isolated PostgreSQL guards. Signatures are real; custody, native
// absence, the writer fence and all records are synthetic. No native calls.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import * as crypto from 'node:crypto'
import {readFileSync,readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {startDisposableNativePostgres} from './lib/disposable-native-postgres.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

const args=process.argv.slice(2)
assert.ok(new Set(args).size===args.length&&args.every(arg=>arg==='--native-postgres'||/^--postgres-major=(16|18)$/u.test(arg))
  &&args.filter(arg=>arg.startsWith('--postgres-major')).length<=1)
const major=args.find(arg=>arg.startsWith('--postgres-major'))?.split('=')[1]??'16'
const nativePostgres=args.includes('--native-postgres')
const require=createRequire(new URL('../app_src/package.json',import.meta.url))
const {Pool}=require('pg'),ts=require('typescript'),modules=new Map()
const source=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(name){
  if(modules.has(name))return modules.get(name)
  const module={exports:{}}
  const js=ts.transpileModule(source('app_src/lib/crm/'+name+'.ts'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('require','module','exports',js)(dependency=>{
    if(dependency==='server-only')return {}
    if(dependency.startsWith('node:'))return require(dependency)
    assert.match(dependency,/^\.\/[A-Za-z0-9]+$/u)
    return load(dependency.slice(2))
  },module,module.exports)
  modules.set(name,module.exports)
  return module.exports
}
const {nativeEmailCanonicalJson:canonical,nativeEmailDigest:hash}=load('nativeEmailPublication')
const {legacyEmailTerminalHoldManifestDigest:holdDigest,verifyLegacyEmailTerminalHoldApproval:verifyHold}=load('legacyEmailRetirementApproval')
const id=crypto.randomUUID
const schema='crm_legacy_email_terminal_hold'
const container=`clawpilot-terminal-hold-pg${major}-${process.pid}-${id().slice(0,8)}`
const single=result=>{assert.equal(result.rows.length,1);return result.rows[0]}
const refusal=(...codes)=>error=>codes.includes(error?.code)
const attestor='fixture_hold_attestor',controller='fixture_hold_controller',observer='fixture_hold_observer',ordinary='fixture_hold_ordinary'
const owner='terminal.hold@example.invalid',workspace=id(),account=id(),authorityInstance=id(),pipelines=[id(),id()]
const fenceKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),operatorKeys=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const sign=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(canonical(proof),'ascii'),
  {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
const rolePools=new Map()
let pool,started=false,checks=0,nativeFixture
const check=async(label,fn)=>{await fn();checks++;console.log('PASS '+label)}

try{
  let connection
  if(nativePostgres){
    nativeFixture=await startDisposableNativePostgres({major,fixturePrefix:'clawpilot-hold-pg-'})
    connection=nativeFixture.connection
  }else{
    execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
      '-e','POSTGRES_PASSWORD=terminal_hold_fixture','-e','POSTGRES_DB=terminal_hold_fixture','-p','127.0.0.1::5432',
      `pgvector/pgvector:pg${major}`]),{stdio:'pipe',timeout:60000})
    started=true
    const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1]
    assert.ok(port,'Fixture must bind loopback only')
    connection={host:'127.0.0.1',port:Number(port),database:'terminal_hold_fixture',password:'terminal_hold_fixture',
      ssl:false,options:'-c timezone=UTC'}
  }
  const poolOptions={...connection,connectionTimeoutMillis:1000,statement_timeout:20000}
  pool=new Pool({...poolOptions,user:'postgres',max:4})
  const readyBy=Date.now()+30000
  for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>readyBy)throw error;await new Promise(r=>setTimeout(r,100))}}
  const query=(sql,params)=>pool.query(sql,params)
  if(nativeFixture)await nativeFixture.assertOwned(pool)
  async function transaction(fn,begin='BEGIN',from=pool){
    const tx=await from.connect()
    try{await tx.query(begin);const result=await fn(tx);await tx.query('COMMIT');return result}
    catch(error){await tx.query('ROLLBACK');throw error}finally{tx.release()}
  }
  const asRole=(role,fn,begin)=>transaction(async tx=>{
    assert.ok([attestor,controller,observer,ordinary].includes(role))
    assert.deepEqual(single(await tx.query('SELECT session_user AS login,current_user AS role')),{login:role,role})
    return fn(tx)
  },begin,rolePools.get(role))
  const migrate=await pool.connect()
  try{
    const migrations=readdirSync(new URL('../db/migrations/',import.meta.url)).filter(name=>/^\d+_.+\.sql$/u.test(name)).sort()
    assert.ok(migrations.includes('0413_crm_legacy_email_terminal_hold.sql'),'The actual hold migration is required')
    assert.equal(migrations.filter(name=>name.startsWith('0414_')).length,1,'The exact enrollment quarantine migration is required')
    for(const name of migrations)await applyMigrationSqlForTest(migrate,name,source('db/migrations/'+name))
  }finally{migrate.release()}
  const holdSig=`${schema}.hold(uuid,uuid[],text)`,resolveSig=`${schema}.resolve(uuid,text,text)`
  const quarantineSig='public.clawpilot_crm_native_initial_pending_quarantine(uuid,text,uuid,uuid,text,bigint)'
  const quarantineSql='SELECT public.clawpilot_crm_native_initial_pending_quarantine($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text,$6::bigint) AS allowed'
  const quarantineArgs=row=>[row.outboxId,row.rowFingerprint,account,workspace,authorityInstance,baseManifest.appGeneration]
  const holdSql=`SELECT ${schema}.hold($1::uuid,$2::uuid[],$3::text) AS count`
  const resolveSql=`SELECT ${schema}.resolve($1::uuid,$2::text,$3::text) AS receipt`
  const attestSql=`INSERT INTO ${schema}.verified_batch(batch,manifest,manifest_canonical,manifest_hash,fence_hash,approval_hash,valid_until)
    VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7))`
  const control=async()=>single(await query('SELECT to_jsonb(c) AS value FROM crm_native_email_publication_control c')).value
  const initialControl=await control()
  // Direct, distinct test logins on this disposable DB only. SET ROLE is
  // deliberately insufficient for the actual attestor trigger.
  for(const role of [attestor,controller,observer,ordinary]){
    const password=crypto.randomBytes(32).toString('hex')
    await query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`)
    rolePools.set(role,new Pool({...poolOptions,user:role,password,max:1}))
  }
  await check('migration is inert and exposes neither private schema nor entrypoints by default',async()=>{
    assert.equal(initialControl.enabled,false)
    assert.equal(initialControl.active_initial_enrollment_id,null)
    for(const table of [`${schema}.verified_batch`,`${schema}.held`,'sync_outbox','crm_native_email_publication_work']){
      assert.equal(single(await query(`SELECT count(*)::int AS n FROM ${table}`)).n,0)
    }
    for(const role of [attestor,controller,observer,ordinary]){
      const acl=single(await query(`SELECT has_schema_privilege($1,$2,'USAGE') AS usage,
        has_function_privilege($1,$3,'EXECUTE') AS hold,has_function_privilege($1,$4,'EXECUTE') AS resolve,
        has_function_privilege($1,$5,'EXECUTE') AS quarantine`,[role,schema,holdSig,resolveSig,quarantineSig]))
      assert.deepEqual(acl,{usage:false,hold:false,resolve:false,quarantine:false})
    }
    const definers=(await query(`SELECT p.proname,p.proconfig,has_function_privilege($2,p.oid,'EXECUTE') AS ordinary_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND p.prosecdef ORDER BY p.proname`,[schema,ordinary])).rows
    assert.deepEqual(definers.map(row=>row.proname),['check_release_binding','claim_resolution','hold','protect_held','register_release',
      'resolve','resolve_recovery','resolve_release','resolve_unsettled_release','settle_release','stage_recovery'])
    for(const fn of definers){
      assert.equal(fn.ordinary_execute,false,fn.proname+' must not default to ordinary execution')
      assert.ok(fn.proconfig.some(value=>value.replaceAll(' ','')==='search_path=pg_catalog,pg_temp'),
        fn.proname+' must not resolve application-controlled objects in SECURITY DEFINER search_path')
    }
  })
  await query(`GRANT USAGE ON SCHEMA ${schema} TO ${attestor},${controller},${observer};
    GRANT INSERT ON ${schema}.verified_batch TO ${attestor};
    GRANT EXECUTE ON FUNCTION ${holdSig} TO ${controller};
    GRANT EXECUTE ON FUNCTION ${resolveSig} TO ${observer};
    GRANT SELECT,INSERT,UPDATE,DELETE ON sync_outbox,crm_interactions TO ${ordinary};
    GRANT SELECT,DELETE ON crm_interaction_organizations,crm_interaction_contacts TO ${ordinary};
    GRANT SELECT ON crm_native_email_publication_control,crm_native_email_publication_work TO ${ordinary};
    GRANT UPDATE(updated_at) ON crm_native_email_publication_control TO ${ordinary}`)
  await query(`WITH ref AS(SELECT allocate_crm_reference('gu') AS code)
    INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
    SELECT $1,'owner','active','1',code,code,true FROM ref`,[owner])
  await query(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by)
    VALUES($1,'Synthetic terminal hold workspace','root',$2,$2)`,[workspace,owner])
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'owner','active','{"viewCrm":true}',$1,$1)`,[owner,workspace])
  await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by)
    VALUES($1,$2,$3,true,$3,$3)`,[account,workspace,owner])
  await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
    VALUES($1,$2,$3,true,$3,$3)`,[account,workspace,owner])
  for(const [index,pipeline] of pipelines.entries())await query(`INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id)
    VALUES($1,$2,$3,$4)`,[pipeline,'Synthetic terminal hold pipeline '+index,owner,workspace])

  const jobs=[],privateBody='SYNTHETIC_HELD_BODY_MUST_NOT_ENTER_RECEIPT'
  for(const [index,pipelineId] of pipelines.entries()){
    const outboxId=id(),localId=id(),nativeId=id(),sourceHash=hash(['terminal hold source',index])
    const providerMessageId='c'+id().replaceAll('-','')
    const organizationId=id(),contactId=id()
    await query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,
      relationship_type,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
      VALUES($1,$2,$3,$4,$4,'Synthetic hold Account','Customer','customer','{}',$5,'synced',now(),allocate_crm_reference('ga'))`,
    [organizationId,pipelineId,id(),'terminal-hold-account-'+index,hash(organizationId)])
    await query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,
      last_name,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code)
      VALUES($1,$2,$3,$4,$5,$5,'Synthetic hold Contact','Contact','{}',$6,'synced',now(),allocate_crm_reference('gc'))`,
    [contactId,pipelineId,organizationId,id(),'terminal-hold-contact-'+index,hash(contactId)])
    const globalId=single(await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,description,source_hash,
      suitecrm_id,suitecrm_module,reference_code,source_payload,sync_status,provider_message_id,organization_id,contact_id)
      VALUES($1,$2,$3,'Synthetic failed Email',$4,$5,$6,'Emails',allocate_crm_reference('gi'),'{}','failed',$7,$8,$9)
      RETURNING reference_code`,[localId,pipelineId,'terminal-hold-fixture-'+index,privateBody,sourceHash,nativeId,
      providerMessageId,organizationId,contactId])).reference_code
    await query(`INSERT INTO crm_interaction_contacts(pipeline_id,interaction_id,contact_id,is_primary)
      VALUES($1,$2,$3,true)`,[pipelineId,localId,contactId])
    const payload={entity:'interactions',localId,pipelineId,suiteCrmId:nativeId,suiteCrmModule:'Emails',
      attributes:{global_id_c:globalId,assigned_user_id:'1',description:privateBody}}
    await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,last_error,
      processed_at,idempotency_key) VALUES($1,'suitecrm','crm_interactions',$2,'upsert_record',$3,'dead',8,
      'native_projection_proof_unavailable',now(),$4)`,[outboxId,localId,payload,`crm:interactions:v4:${localId}:Emails:${sourceHash}`])
    jobs.push({outboxId,localId,pipelineId,workspaceId:workspace,nativeId,globalId,attempts:8,providerMessageId})
  }
  jobs.sort((a,b)=>a.outboxId<b.outboxId?-1:1)
  const ids=jobs.map(x=>x.outboxId),locals=jobs.map(x=>x.localId)
  const unrelated=id()
  await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload)
    VALUES($1,'suitecrm','fixture_unrelated',$2,'upsert_record','{}')`,[unrelated,id()])
  const queue=async()=> (await query('SELECT to_jsonb(o)::text AS bytes FROM sync_outbox o ORDER BY id')).rows
  const sources=async()=> (await query('SELECT to_jsonb(i)::text AS bytes FROM crm_interactions i WHERE id=ANY($1::uuid[]) ORDER BY id',[locals])).rows
  const edges=async()=>single(await query(`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.interaction_id,a.organization_id) FROM crm_interaction_organizations a
      WHERE a.interaction_id=ANY($1::uuid[])) AS accounts,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.interaction_id,c.contact_id) FROM crm_interaction_contacts c
      WHERE c.interaction_id=ANY($1::uuid[])) AS contacts`,[locals]))
  const queueBefore=await queue(),sourcesBefore=await sources(),edgesBefore=await edges(),controlBefore=await control()
  assert.equal(edgesBefore.accounts.length,locals.length)
  assert.equal(edgesBefore.contacts.length,locals.length)
  const pins=(await query(`SELECT o.id,
    encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS "rowFingerprint",
    encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS "sourceFingerprint",
    encode(public.digest(o.payload::text,'sha256'),'hex') AS "payloadFingerprint",
    encode(public.digest(o.idempotency_key,'sha256'),'hex') AS "keyFingerprint",
    ${schema}.relationship_fingerprint(i.id) AS "relationshipFingerprint",
    ${schema}.provider_identity_fingerprint(i.id) AS "providerIdentityFingerprint"
    FROM sync_outbox o JOIN crm_interactions i ON i.id::text=o.aggregate_id WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`,[ids])).rows
  const exactRows=jobs.map(({providerMessageId:_,...job},n)=>{
    const {id:pinId,...hashes}=pins[n];assert.equal(pinId,job.outboxId);return {...job,...hashes}
  })
  const snapshot=single(await query(`SELECT encode(public.digest(public.clawpilot_crm_native_initial_source_snapshot()::text,'sha256'),'hex') AS source,
    ${schema}.gate_fingerprint() AS gate`))
  const baseManifest={version:1,action:'hold_exact_legacy_terminal_rows_in_place',publicationDisposition:'hold_without_publication',
    scope:{projectId:id(),environmentId:id(),postgresDatabaseFingerprint:hash('synthetic pg'),appCommit:'a'.repeat(40),
      nativeDeploymentId:id(),nativeReplicaId:id(),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('synthetic maria'),
      nativeAuthorityInstanceId:authorityInstance},actorEmail:owner,operatorAccountId:account,rootWorkspaceId:workspace,
    appGeneration:Number(controlBefore.generation),gateFingerprint:snapshot.gate,appSourceFingerprint:snapshot.source,
    fenceEvidenceFingerprint:hash('synthetic writer fence'),nativeAbsenceFingerprint:hash('synthetic native absence'),
    historicalProviderOutcome:'unknown',rows:exactRows}
  const fixture=()=>({...structuredClone(baseManifest),operationId:id(),fenceEpoch:id()})
  async function approved(manifest,offset=0){
    const clock=Number(single(await query('SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now')).now)
    const issuedAt=clock-2+offset,expiresAt=issuedAt+110,manifestDigest=holdDigest(manifest)
    const common={version:1,audience:'clawpilot-private-legacy-email-hold-controller',operationId:manifest.operationId,
      manifestDigest,issuedAt,expiresAt}
    const fenceEnvelope=sign({...common,purpose:'clawpilot-legacy-email-hold-fenced-absence-v1',
      issuer:'clawpilot-crm-hold-fence-attestor',keyId:'fixture-fence'},fenceKeys.privateKey)
    const operatorEnvelope=sign({...common,purpose:'clawpilot-legacy-email-hold-review-v1',issuer:'clawpilot-crm-hold-operator',
      keyId:'fixture-operator',fenceEnvelopeDigest:hash(fenceEnvelope)},operatorKeys.privateKey)
    const permit=verifyHold({expectedManifest:manifest,fenceEnvelope,operatorEnvelope,
      fenceAnchor:{keyId:'fixture-fence',key:fenceKeys.publicKey},operatorAnchor:{keyId:'fixture-operator',key:operatorKeys.publicKey},
      nowSeconds:issuedAt+2})
    assert.equal(permit.liveFenceProven,false,'Signatures alone are not a real writer fence')
    const register=[manifest.operationId,manifest,canonical(manifest),manifestDigest,permit.fenceEnvelopeDigest,
      permit.approvalEnvelopeDigest,expiresAt]
    return {register,run:[manifest.operationId,ids,permit.approvalEnvelopeDigest],
      read:[manifest.operationId,manifestDigest,permit.approvalEnvelopeDigest]}
  }
  const attest=review=>asRole(attestor,tx=>tx.query(attestSql,review.register))
  const hold=review=>asRole(controller,tx=>tx.query(holdSql,review.run))
  const resolve=async(review)=>single(await asRole(observer,tx=>tx.query(resolveSql,review.read),'BEGIN READ ONLY')).receipt
  const unchanged=async()=>{
    assert.deepEqual(await queue(),queueBefore)
    assert.deepEqual(await sources(),sourcesBefore)
    assert.deepEqual(await edges(),edgesBefore)
  }
  const empty=async()=>assert.equal(single(await query(`SELECT count(*)::int AS n FROM ${schema}.held`)).n,0)
  const exact=await approved(fixture())

  await check('roles cannot substitute for each other and wrong canonical bytes do not attest a manifest',async()=>{
    await assert.rejects(asRole(ordinary,tx=>tx.query(holdSql,exact.run)),refusal('42501'))
    await assert.rejects(asRole(attestor,tx=>tx.query(holdSql,exact.run)),refusal('42501'))
    await assert.rejects(asRole(controller,tx=>tx.query(attestSql,exact.register)),refusal('42501'))
    await assert.rejects(asRole(observer,tx=>tx.query(`SELECT * FROM ${schema}.verified_batch`)),refusal('42501'))
    await assert.rejects(transaction(async tx=>{
      await tx.query(`SET LOCAL ROLE ${attestor}`);await tx.query(attestSql,exact.register)
    }),refusal('55000'))
    const other=await approved(fixture());other.register[2]=canonical({...other.register[1],fenceEpoch:id()})
    await assert.rejects(attest(other),refusal('23514','55000'))
    await unchanged();await empty()
  })
  await check('expired, stale-scope and drifted signed evidence never installs any hold',async()=>{
    const expired=await approved(fixture(),-120)
    await assert.rejects(async()=>{await attest(expired);await hold(expired)},refusal('23514','55000'))
    for(const mutate of [
      x=>{x.appGeneration++},x=>{x.rootWorkspaceId=id()},x=>{x.gateFingerprint=hash('stale gate')},
      x=>{x.appSourceFingerprint=hash('stale app snapshot')},x=>{x.rows[0].rowFingerprint=hash('stale outbox')},
      x=>{x.rows[0].sourceFingerprint=hash('stale source')},x=>{x.rows[0].payloadFingerprint=hash('stale payload')},
      x=>{x.rows[0].keyFingerprint=hash('stale key')},x=>{x.rows[0].relationshipFingerprint=hash('stale relationships')},
      x=>{x.rows[0].providerIdentityFingerprint=hash('stale provider')},
    ]){
      const candidate=fixture();mutate(candidate);const review=await approved(candidate)
      await assert.rejects(async()=>{await attest(review);await hold(review)},refusal('23514','55000'))
      await unchanged();await empty()
    }
  })
  await check('an authenticated review cannot consume an incomplete, duplicate, or different exact set',async()=>{
    await attest(exact)
    assert.deepEqual(await resolve(exact),{state:'unknown'})
    assert.equal(single(await query(quarantineSql,quarantineArgs(exactRows[0]))).allowed,false,
      'An attestation without a committed hold cannot exempt a pending writer')
    await assert.rejects(transaction(async tx=>{
      await tx.query(`SET LOCAL ROLE ${controller}`);await tx.query(holdSql,exact.run)
    }),refusal('55000'))
    await assert.rejects(asRole(controller,tx=>tx.query(holdSql,exact.run),'BEGIN ISOLATION LEVEL REPEATABLE READ'),refusal('55000'))
    for(const [set,digest] of [[ids.slice(0,1),exact.run[2]],[[ids[0],ids[0]],exact.run[2]],
      [[ids[0],unrelated].sort(),exact.run[2]],[ids,hash('other approval')]]){
      await assert.rejects(hold({...exact,run:[exact.run[0],set,digest]}),refusal('55000'))
    }
    await unchanged();await empty()
  })
  await check('exact hold preserves terminal queue bytes and reads back one committed, nonpublishing receipt',async()=>{
    const stale=await pool.connect()
    try{
      await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await stale.query('SELECT id FROM sync_outbox WHERE id=$1',[unrelated])
      assert.equal(single(await hold(exact)).count,ids.length)
      await assert.rejects(stale.query('UPDATE sync_outbox SET updated_at=clock_timestamp() WHERE id=$1',[unrelated]),refusal('40001'))
    }finally{try{await stale.query('ROLLBACK')}finally{stale.release()}}
    await unchanged()
    assert.equal(single(await query(`SELECT count(*)::int AS n FROM ${schema}.held`)).n,ids.length)
    const receipt=await resolve(exact)
    assert.deepEqual(receipt,{state:'committed',operationId:exact.read[0],manifestDigest:exact.read[1],
      approvalDigest:exact.read[2],rows:ids.length,receiptHash:receipt.receiptHash,historicalProviderOutcome:'unknown'})
    assert.match(receipt.receiptHash,/^[a-f0-9]{64}$/u)
    assert.ok(!JSON.stringify(receipt).includes(privateBody))
    assert.deepEqual(await resolve(exact),receipt)
    for(const read of [[exact.read[0],hash('other manifest'),exact.read[2]],[exact.read[0],exact.read[1],hash('other approval')]]){
      assert.deepEqual(await resolve({...exact,read}),{state:'unknown'})
    }
    await assert.rejects(hold(exact),refusal('55000'))
    await assert.rejects(query(`UPDATE ${schema}.held SET outbox_id=outbox_id`),refusal('55000'))
    assert.deepEqual(await control(),controlBefore)
  })
  await check('ordinary retries, deletion, exact/competing identities and truncation are denied; unrelated work still writes',async()=>{
    const first=jobs[0]
    const aliasGlobal=single(await query("SELECT allocate_crm_reference('gi') AS id")).id
    for(const [sql,params] of [
      ["UPDATE sync_outbox SET status='queued',attempts=0,last_error=NULL,processed_at=NULL WHERE id=$1",[first.outboxId]],
      ['DELETE FROM sync_outbox WHERE id=$1',[first.outboxId]],
      ["UPDATE crm_interactions SET subject='Unreviewed edit' WHERE id=$1",[first.localId]],
      ['DELETE FROM crm_interactions WHERE id=$1',[first.localId]],
      [`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
        VALUES('suitecrm','crm_interactions',$1,'upsert_record','{}')`,[first.localId]],
      [`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
        VALUES('suitecrm','fixture_competing',$1,'upsert_record',jsonb_build_object('suiteCrmId',$2::text))`,[id(),first.nativeId]],
      [`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload)
        VALUES('suitecrm','fixture_competing',$1,'upsert_record',jsonb_build_object('attributes',jsonb_build_object('global_id_c',$2::text)))`,[id(),first.globalId]],
      [`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,source_hash,suitecrm_id,suitecrm_module,reference_code,
        source_payload,sync_status,provider_message_id) VALUES($1,$2,$3,'Competing synthetic alias',$4,$5,'Emails',
        $7,'{}','failed',$6)`,[id(),first.pipelineId,'hold-alias-'+id(),hash('alias'),id(),first.providerMessageId.toUpperCase(),aliasGlobal]],
    ])await assert.rejects(asRole(ordinary,tx=>tx.query(sql,params)),refusal('55000'))
    for(const table of ['crm_interaction_organizations','crm_interaction_contacts']){
      await assert.rejects(asRole(ordinary,tx=>tx.query(`DELETE FROM ${table} WHERE interaction_id=$1`,[first.localId])),
        error=>error?.code==='55000'&&/Terminal Email hold/u.test(error.message))
    }
    await assert.rejects(transaction(async tx=>{
      await tx.query('TRUNCATE crm_interaction_contacts')
      // Even an unexpectedly unguarded fixture truncation must roll back.
      throw new Error('Held Contact edges unexpectedly accepted truncation')
    }),error=>error?.code==='55000'&&/Terminal Email hold prevents truncation/u.test(error.message))
    await unchanged()
    assert.equal((await asRole(ordinary,tx=>tx.query(`UPDATE sync_outbox SET payload='{"unrelated":true}' WHERE id=$1
      AND status='queued'`,[unrelated]))).rowCount,1)
    const afterHeld=(await query('SELECT to_jsonb(o)::text AS bytes FROM sync_outbox o WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows
    const beforeHeld=queueBefore.filter(({bytes})=>ids.includes(JSON.parse(bytes).id))
    assert.deepEqual(afterHeld,beforeHeld);assert.deepEqual(await sources(),sourcesBefore)
  })
  const initialSnapshot=async tx=>single(await tx.query(`SELECT value,encode(public.digest(value::text,'sha256'),'hex') AS fingerprint
    FROM (SELECT public.clawpilot_crm_native_initial_source_snapshot() AS value) observed`))
  const reserve=async(tx,instance=authorityInstance)=>{
    const observed=await initialSnapshot(tx),operationId=hash(id())
    await tx.query(`INSERT INTO crm_native_email_initial_reservations(operation_id,actor_email,operator_account_id,
      root_workspace_id,native_instance_id,generation,source_snapshot,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [operationId,owner,account,workspace,instance,Number(observed.value.generation),observed.value,observed.fingerprint])
    return {observed,operationId}
  }
  const nativeHoldStillNonPublishing=async()=>{
    assert.equal(single(await query('SELECT count(*)::int AS n FROM crm_native_email_publication_work')).n,0)
    assert.equal(single(await query('SELECT count(*)::int AS n FROM crm_native_email_publication_admissions')).n,0)
    assert.equal(single(await query('SELECT count(*)::int AS n FROM crm_legacy_email_recovery_stages')).n,0)
    const {receiptHash}=await resolve(exact)
    assert.deepEqual(single(await query(`SELECT public.clawpilot_crm_legacy_email_stage_source($1::uuid,$2::text) AS source`,
      [ids[0],receiptHash])).source,{state:'unknown'},'A committed hold is not a retired source or recovery permission')
    assert.deepEqual(await control(),controlBefore)
  }
  await check('quarantine exposes only an exact, scope-bound committed terminal hold',async()=>{
    const positive=quarantineArgs(exactRows[0])
    assert.equal(single(await query(quarantineSql,positive)).allowed,true)
    for(const [index,replacement] of [[0,id()],[0,unrelated],[1,hash('wrong exact job fingerprint')],
      [2,id()],[3,id()],[4,id()],[5,baseManifest.appGeneration+1]]){
      const changed=[...positive];changed[index]=replacement
      assert.equal(single(await query(quarantineSql,changed)).allowed,false,`scope or identity field ${index} must fail closed`)
    }
    await assert.rejects(asRole(ordinary,tx=>tx.query(quarantineSql,positive)),refusal('42501'))
    await nativeHoldStillNonPublishing()
  })
  await check('actual initial reservation accepts exact held rows without removing them, and rejects a different instance or other dead job',async()=>{
    const rollback=new Error('rollback synthetic enrollment reservation')
    const expectedPending=exactRows.map(({outboxId,rowFingerprint})=>({id:outboxId,rowFingerprint,status:'dead'}))
    await assert.rejects(transaction(async tx=>{
      const {observed,operationId}=await reserve(tx)
      const retained=single(await tx.query(`SELECT source_snapshot,source_fingerprint,state
        FROM crm_native_email_initial_reservations WHERE operation_id=$1`,[operationId]))
      assert.deepEqual(retained,{source_snapshot:observed.value,source_fingerprint:observed.fingerprint,state:'reserved'})
      const held=retained.source_snapshot.pendingOutbox.filter(row=>ids.includes(row.id))
        .map(({id,rowFingerprint,status})=>({id,rowFingerprint,status}))
      assert.deepEqual(held,expectedPending,'Exception must retain the exact dead rows in the source snapshot')
      const gate=single(await tx.query('SELECT enabled,active_initial_enrollment_id FROM crm_native_email_publication_control'))
      assert.deepEqual(gate,{enabled:false,active_initial_enrollment_id:operationId})
      assert.equal(single(await tx.query(quarantineSql,quarantineArgs(exactRows[0]))).allowed,true,
        'The app/admit paths must still verify the exact quarantine while the reservation is active')
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
      throw rollback
    }),error=>error===rollback)
    const unresolved=error=>error?.code==='55000'&&/unresolved writers/u.test(error.message)
    await assert.rejects(transaction(async tx=>{
      await reserve(tx,id())
      throw new Error('Wrong native instance unexpectedly accepted initial reservation')
    }),unresolved)
    await assert.rejects(transaction(async tx=>{
      assert.equal((await tx.query(`UPDATE sync_outbox SET status='dead',attempts=8,
        last_error='synthetic unheld terminal job',processed_at=clock_timestamp() WHERE id=$1`,[unrelated])).rowCount,1)
      await reserve(tx)
      throw new Error('Unheld terminal job unexpectedly accepted initial reservation')
    }),unresolved)
    assert.equal(single(await query('SELECT count(*)::int AS n FROM crm_native_email_initial_reservations')).n,0)
    assert.equal(single(await query('SELECT count(*)::int AS n FROM crm_native_email_initial_enrollments')).n,0)
    const beforeHeld=queueBefore.filter(({bytes})=>ids.includes(JSON.parse(bytes).id))
    assert.deepEqual((await query('SELECT to_jsonb(o)::text AS bytes FROM sync_outbox o WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,beforeHeld)
    assert.deepEqual(await sources(),sourcesBefore)
    assert.deepEqual(await edges(),edgesBefore)
    await nativeHoldStillNonPublishing()
  })
  console.log(`PASS ${checks} real PostgreSQL ${major} terminal hold groups; no native/provider calls or production proof`)
}finally{
  try{await Promise.all([...(pool?[pool]:[]),...rolePools.values()].map(db=>db.end()))}
  finally{
    if(nativeFixture)nativeFixture.cleanup()
    else if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})
  }
}
