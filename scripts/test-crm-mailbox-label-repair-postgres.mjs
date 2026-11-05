#!/usr/bin/env node
// Actual PostgreSQL, all migrations, production mailbox DAL/audit and initial
// reservation store. Google identity/profile observations are SYNTHETIC trusted-
// boundary inputs: no Google signature, Gmail delivery or native execution proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync,readdirSync} from 'node:fs'
import {builtinModules,createRequire} from 'node:module'
import {dirname,resolve} from 'node:path'
import {createDisposablePostgresRuntime,disposablePostgresDockerArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'

assert.equal(process.versions.node.split('.')[0],'24','Use supported Node24')
assert.ok(process.argv.length===3&&/^--postgres-major=(16|18)$/.test(process.argv[2]),'Explicit --postgres-major=16|18 required')
const major=process.argv[2].split('=')[1],require=createRequire(new URL('../app_src/package.json',import.meta.url))
const {Pool}=require('pg'),ts=require('typescript'),loaded=new Map(),sourceHashes=new Map()
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),id=()=>crypto.randomUUID()
const builtin=new Set(builtinModules.flatMap(name=>[name,`node:${name}`]))
function load(path){
 path=resolve(path);if(loaded.has(path))return loaded.get(path).exports
 const module={exports:{}};loaded.set(path,module)
 const bytes=readFileSync(path,'utf8');sourceHashes.set(path,hash(bytes))
 const code=ts.transpileModule(bytes,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 new Function('module','exports','require','process','globalThis','fetch',code)(module,module.exports,name=>{
  if(name==='server-only')return require('next/dist/compiled/server-only/empty.js')
  if(builtin.has(name)||name==='pg'||name==='next/headers')return require(name)
  const target=name.startsWith('@/')?resolve('app_src',name.slice(2)):name.startsWith('.')?resolve(dirname(path),name):null
  assert.ok(target,`Unexpected dependency ${name} from ${path}`)
  return load(/\.(?:ts|mjs|js)$/.test(target)?target:target+'.ts')
 },fixtureProcess,fixtureGlobals,denyFetch)
 return module.exports
}
const OWNER='repair.owner@example.invalid',OTHER='repair.other@example.invalid',OLD='old.mailbox@example.invalid'
const NEW='new.mailbox@example.invalid',NEXT='next.mailbox@example.invalid',SUBJECT='synthetic-google-stable-subject'
const root=id(),pipeline=id(),operator=id(),connection='synthetic-label-repair-connection',instance='mailbox-repair-synthetic-native'
const scope={ownerEmail:OWNER,connectionId:connection,pipelineId:pipeline,workspaceOrganizationId:root}
const runtime=createDisposablePostgresRuntime(),container=`clawpilot-mailbox-repair-pg${major}-${process.pid}-${id().slice(0,8)}`
const fixtureEnv={APP_SESSION_SECRET:'synthetic-mailbox-repair-session-secret-only-'+id(),
 AGENT_CREDENTIAL_ENCRYPTION_KEY:'synthetic-mailbox-repair-encryption-key-only-'+id(),CLAWPILOT_STORAGE:'postgres',
 DATABASE_URL:'postgresql://postgres:mailbox_repair_fixture@127.0.0.1:1/mailbox_repair_fixture',CLAWPILOT_DB_FALLBACK_TO_FILE:'false'}
const fixtureProcess={env:fixtureEnv,cwd:()=>process.cwd()},fixtureGlobals={}
const denyFetch=async()=>{throw Error('Network access is forbidden in the mailbox repair PG fixture')}
let pool,started=false,checks=0
const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name)}
const held=error=>/unavailable or changed|pins all reviewed sources/.test(String(error?.message))
sourceHashes.set(resolve('scripts/test-crm-mailbox-label-repair-postgres.mjs'),hash(readFileSync('scripts/test-crm-mailbox-label-repair-postgres.mjs')))
try{
 const launch=disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
  '-e','POSTGRES_PASSWORD=mailbox_repair_fixture','-e','POSTGRES_DB=mailbox_repair_fixture',
  '-p','127.0.0.1::5432',`pgvector/pgvector:pg${major}`],{runtime})
 started=true;execFileSync('docker',launch,{stdio:'pipe',timeout:60000})
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8',timeout:10000}).match(/^127\.0\.0\.1:(\d+)\s*$/)?.[1]
 assert.ok(port,'Exact owned fixture binds loopback only')
 pool=new Pool({host:'127.0.0.1',port:Number(port),database:'mailbox_repair_fixture',user:'postgres',password:'mailbox_repair_fixture',ssl:false,max:5,statement_timeout:10000})
 const deadline=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,100))}}
 fixtureEnv.DATABASE_URL=`postgresql://postgres:mailbox_repair_fixture@127.0.0.1:${port}/mailbox_repair_fixture`
 fixtureGlobals.__clawpilotPgPool=pool
 const pg=load('app_src/lib/persistence/postgres.ts'),query=pg.query,transaction=pg.withTransaction
 assert.equal(pg.getPostgresPool(),pool,'Actual production PG accessors use the owned real Pool')
 const migrations=[];const migrate=await pool.connect()
 try{for(const name of readdirSync('db/migrations').filter(name=>/^\d+_.+\.sql$/.test(name)).sort()){
  const path=resolve('db/migrations',name),bytes=readFileSync(path,'utf8');sourceHashes.set(path,hash(bytes));migrations.push(name)
  await applyMigrationSqlForTest(migrate,name,bytes)
 }}finally{migrate.release()}
 const api=load('app_src/lib/persistence/crmEmailIdentity.ts'),identityApi=load('app_src/lib/crm/emailIdentity.ts')
 for(const [email,role,native]of [[OWNER,'owner','1'],[OTHER,'member','synthetic-other-native']])await query(`
  WITH reference AS(SELECT allocate_crm_reference('gu') AS code)
  INSERT INTO app_users(email,role,status,suitecrm_user_id,suitecrm_username,reference_code,crm_user_enabled)
  SELECT $1,$2,'active',$3,code,code,true FROM reference`,[email,role,native])
 await query(`INSERT INTO workspace_organizations(id,name,organization_type,created_by,updated_by)
  VALUES($1,'Synthetic mailbox label repair','root',$2,$2)`,[root,OWNER])
 for(const [email,role]of [[OWNER,'owner'],[OTHER,'member']])await query(`INSERT INTO app_user_organization_memberships
  (user_email,organization_id,role,status,permissions,created_by,updated_by) VALUES($1,$2,$3,'active','{"viewCrm":true}',$4,$4)`,[email,root,role,OWNER])
 await query('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',[pipeline,'Synthetic repair pipeline',OWNER,root])
 // Real encrypted synthetic row, using production's owner-bound AES-GCM format;
 // this fixture does not claim to exercise a provider credential/decryption flow.
 const key='synthetic-maton-key-only-'+id(),iv=crypto.randomBytes(12)
 const cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(fixtureEnv.AGENT_CREDENTIAL_ENCRYPTION_KEY).digest(),iv)
 cipher.setAAD(Buffer.from(`clawpilot:maton:${OWNER}:api-key:v1`))
 const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]),tag=cipher.getAuthTag()
 await query(`INSERT INTO user_maton_credentials(owner_email,login_email,api_key_ciphertext,api_key_iv,api_key_tag,
  api_key_last_four,api_key_version,key_rotated_at,updated_at) VALUES($1,$1,$2,$3,$4,$5,0,'2026-01-01 00:00:00.123456+00','2026-01-01 00:00:00.123456+00')`,[OWNER,ciphertext,iv,tag,key.slice(-4)])
 await query('INSERT INTO user_maton_credentials(owner_email) VALUES($1)',[OTHER])
 await query(`INSERT INTO user_maton_connections(owner_email,connection_id,name,app,status,account_email,is_selected,source,
  remote_created_at,remote_updated_at,last_refreshed_at,updated_at)
  VALUES($1,$2,'Synthetic mailbox','google-mail','ACTIVE',$3,true,'maton',
   '2026-01-01 00:00:00.123456+00','2026-01-01 00:00:00.123456+00','2026-01-01 00:00:00.123456+00','2026-01-01 00:00:00.123456+00')`,[OWNER,connection,OLD])
 const bound=await api.bindVerifiedGmailMailboxInPostgres({ownerEmail:OWNER,connectionId:connection,
  identity:{subject:SUBJECT,email:OLD,displayName:null},observedAccountEmail:OLD})
 const verified=accountEmail=>api.readVerifiedGmailMailboxIdentityInPostgres({ownerEmail:OWNER,connectionId:connection,accountEmail})
 const evidence=message=>identityApi.normalizeGmailMessageEvidence({externalMessageId:message,externalThreadId:'synthetic-thread',
  senderEmail:'sender@example.invalid',recipientEmails:[OLD],subject:'Synthetic retained historical message',receivedAt:'2026-01-01T00:00:00.123Z',
  snippet:'Synthetic snippet',bodyText:'Synthetic full body',markerReferences:[],emailAddressHeaders:{version:1,
   from:[{address:'sender@example.invalid'}],to:[{address:OLD}]}})
 const intake=async(message,accountEmail)=>api.recordGmailMessageIntakeInPostgres({ownerEmail:OWNER,connectionId:connection,intakePipelineId:pipeline,
  mailboxIdentity:await verified(accountEmail),observedAccountEmail:accountEmail,observedAt:new Date().toISOString(),messageEvidence:evidence(message),rawMetadata:{synthetic:true}})
 const first=await intake('a001',OLD);assert.equal(first.identityStatus,'verified')
 const retained=(await query('SELECT * FROM crm_email_sources WHERE id=$1',[first.sourceId])).rows[0]
 const originalCredential=(await query('SELECT * FROM user_maton_credentials WHERE owner_email=$1',[OWNER])).rows[0]
 const credentialTimes=(await query('SELECT key_rotated_at::text,updated_at::text FROM user_maton_credentials WHERE owner_email=$1',[OWNER])).rows[0]
 const originalPermissions=(await query('SELECT permissions FROM app_users WHERE email=$1',[OWNER])).rows[0].permissions
 const attempt=async(target=NEXT)=>{
  const snapshot=await api.readGmailMailboxLabelRepairSnapshotInPostgres(scope)
  const observation={snapshot,accountEmail:target,observedAt:new Date().toISOString()},identity={subject:SUBJECT,email:target,displayName:null}
  return {observation,identity,...api.prepareGmailMailboxLabelRepairPreview({observation,identity})}
 }
 const state=async()=>((await query(`SELECT jsonb_build_object(
  'connection',(SELECT to_jsonb(c) FROM user_maton_connections c WHERE connection_id=$1),
  'credential',(SELECT to_jsonb(c) FROM user_maton_credentials c WHERE owner_email=$2),
  'mailboxes',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM crm_email_mailboxes m),
  'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY owner_email,connection_id) FROM crm_email_mailbox_bindings b),
  'auditCount',(SELECT count(*) FROM audit_events),'sourceCount',(SELECT count(*) FROM crm_email_sources)) AS state`,[connection,OWNER])).rows[0].state)
 const restoreCredential=()=>query(`UPDATE user_maton_credentials SET api_key_ciphertext=$2,api_key_iv=$3,api_key_tag=$4,
  api_key_last_four=$5,api_key_version=$6,key_rotated_at=$7,key_revoked_at=$8,updated_at=$9 WHERE owner_email=$1`,
 [OWNER,originalCredential.api_key_ciphertext,originalCredential.api_key_iv,originalCredential.api_key_tag,originalCredential.api_key_last_four,
  originalCredential.api_key_version,credentialTimes.key_rotated_at,originalCredential.key_revoked_at,credentialTimes.updated_at])
 await check('version-zero key repairs labels atomically while canonical ID, key and historical source remain unchanged',async()=>{
  const command=await attempt(NEW);assert.equal(command.required,true);assert.equal(command.observation.snapshot.keyVersion,0)
  assert.match(command.observation.snapshot.connectionUpdatedAt,/\.123456/)
  assert.match(command.observation.snapshot.credentialUpdatedAt,/\.123456/)
  const result=await api.applyGmailMailboxLabelRepairInPostgres(command)
  assert.equal(result.mailboxId,bound.mailboxId);assert.equal(result.connectionLabelUpdated,true)
  assert.equal((await verified(NEW)).mailboxId,bound.mailboxId)
  assert.deepEqual((await query('SELECT * FROM user_maton_credentials WHERE owner_email=$1',[OWNER])).rows[0],originalCredential)
  assert.deepEqual((await query('SELECT * FROM crm_email_sources WHERE id=$1',[first.sourceId])).rows[0],retained)
  assert.equal((await intake('a002',NEW)).identityStatus,'verified')
  assert.equal((await query('SELECT count(*) FROM crm_email_mailboxes')).rows[0].count,'1')
 })
 const maton=load('app_src/lib/persistence/matonCredentials.ts')
 const connectionBaseline=(await query(`SELECT *,remote_created_at::text AS exact_created,remote_updated_at::text AS exact_remote_updated,
  last_refreshed_at::text AS exact_refreshed,updated_at::text AS exact_updated,created_at::text AS exact_row_created
  FROM user_maton_connections WHERE owner_email=$1 AND connection_id=$2`,[OWNER,connection])).rows[0]
 const restoreConnection=()=>query(`UPDATE user_maton_connections SET name=$3,app=$4,status=$5,method=$6,account_email=$7,
  is_selected=$8,source=$9,remote_created_at=$10::timestamptz,remote_updated_at=$11::timestamptz,
  last_refreshed_at=$12::timestamptz,updated_at=$13::timestamptz,created_at=$14::timestamptz
  WHERE owner_email=$1 AND connection_id=$2`,[OWNER,connection,connectionBaseline.name,connectionBaseline.app,connectionBaseline.status,
  connectionBaseline.method,connectionBaseline.account_email,connectionBaseline.is_selected,connectionBaseline.source,
  connectionBaseline.exact_created,connectionBaseline.exact_remote_updated,connectionBaseline.exact_refreshed,
  connectionBaseline.exact_updated,connectionBaseline.exact_row_created])
 const incoming={connectionId:connection,name:'Synthetic mailbox',app:'google-mail',status:'ACTIVE',method:connectionBaseline.method,
  accountEmail:OLD,source:'maton',remoteCreatedAt:connectionBaseline.exact_created,remoteUpdatedAt:connectionBaseline.exact_remote_updated}
 const refresh=patch=>maton.syncMatonConnectionsInPostgres({ownerEmail:OWNER,connections:[{...incoming,...patch}],
  eventType:'maton.connections.refreshed',replaceRemote:true})
 const assertHistoryUnchanged=async()=>{
  assert.deepEqual((await query('SELECT * FROM crm_email_sources WHERE id=$1',[first.sourceId])).rows[0],retained)
  assert.equal((await query('SELECT count(*) FROM crm_email_mailboxes')).rows[0].count,'1')
 }
 await check('actual remote refresh at the same known grant revision preserves the independently verified new label',async()=>{
  await refresh({})
  assert.equal((await query('SELECT account_email FROM user_maton_connections WHERE connection_id=$1',[connection])).rows[0].account_email,NEW)
  assert.equal((await verified(NEW)).mailboxId,bound.mailboxId)
  assert.deepEqual((await query('SELECT * FROM user_maton_credentials WHERE owner_email=$1',[OWNER])).rows[0],originalCredential)
  await assertHistoryUnchanged();await restoreConnection()
 })
 for(const [name,patch]of [['changed revision',{remoteUpdatedAt:'2026-01-01 00:00:01.123456+00'}],
  ['unknown revision',{remoteUpdatedAt:null}],['changed creation',{remoteCreatedAt:'2026-01-01 00:00:00.123457+00'}],
  ['unknown creation',{remoteCreatedAt:null}],['changed method',{method:connectionBaseline.method===null?'OAUTH2':null}],
  ['inactive status',{status:'INACTIVE'}],['changed app',{app:'google-calendar'}]]){
  await check(`actual refresh ${name} falls back to remote metadata and cannot retain the old binding`,async()=>{
   try{await refresh(patch)
    assert.equal((await query('SELECT account_email FROM user_maton_connections WHERE connection_id=$1',[connection])).rows[0].account_email,OLD)
    assert.equal(await verified(NEW),null);await assertHistoryUnchanged()
   }finally{await restoreConnection()}
  })
 }
 await check('a changed current source does not borrow a canonical Maton label on refresh',async()=>{
  try{await query("UPDATE user_maton_connections SET source='manual' WHERE connection_id=$1",[connection]);await refresh({})
   assert.equal((await query('SELECT account_email FROM user_maton_connections WHERE connection_id=$1',[connection])).rows[0].account_email,OLD)
   assert.equal(await verified(NEW),null);await assertHistoryUnchanged()
  }finally{await restoreConnection()}
 })
 await check('post-verification credential metadata change cannot preserve the previous verified label',async()=>{
  try{await query('UPDATE user_maton_credentials SET updated_at=clock_timestamp() WHERE owner_email=$1',[OWNER]);await refresh({})
   assert.equal((await query('SELECT account_email FROM user_maton_connections WHERE connection_id=$1',[connection])).rows[0].account_email,OLD)
   assert.equal(await verified(NEW),null);await assertHistoryUnchanged()
  }finally{await restoreCredential();await restoreConnection()}
 })
 await check('actual key rotation deletes/recreates connections and forces remote-label fallback without rewriting history',async()=>{
  try{await maton.updateMatonCredentialInPostgres({ownerEmail:OWNER,setLoginEmail:false,loginEmail:null,
    apiKey:{ciphertext,iv,tag,lastFour:key.slice(-4)},refreshedConnections:[incoming],connectionUpserts:[],connectionRemovals:[]})
   const current=(await query('SELECT api_key_version FROM user_maton_credentials WHERE owner_email=$1',[OWNER])).rows[0]
   assert.equal(current.api_key_version,1)
   assert.equal((await query('SELECT account_email FROM user_maton_connections WHERE connection_id=$1',[connection])).rows[0].account_email,OLD)
   assert.equal(await verified(NEW),null);await assertHistoryUnchanged()
  }finally{await restoreCredential();await restoreConnection()}
 })
 await check('different canonical subject, signed-preview substitution and expired observation fail before writes',async()=>{
  const command=await attempt(),before=await state()
  assert.throws(()=>api.prepareGmailMailboxLabelRepairPreview({...command,identity:{...command.identity,subject:'different-google-subject'}}),held)
  await assert.rejects(api.applyGmailMailboxLabelRepairInPostgres({...command,identity:{...command.identity,subject:'different-google-subject'}}),held)
  await assert.rejects(api.bindVerifiedGmailMailboxInPostgres({ownerEmail:OWNER,connectionId:connection,
   identity:{subject:'different-google-subject',email:NEW,displayName:null},observedAccountEmail:NEW}),held)
  for(const patch of [{expectedDigest:'0'.repeat(64)},{expiresAt:'2000-01-01T00:00:00.000Z'},
   {observation:{...command.observation,observedAt:new Date(Date.now()-31000).toISOString()}}])await assert.rejects(api.applyGmailMailboxLabelRepairInPostgres({...command,...patch}),held)
  assert.deepEqual(await state(),before)
 })
 const race=async(name,mutate,restore)=>check(name,async()=>{
  const command=await attempt();await mutate()
  try{const changed=await state();await assert.rejects(api.applyGmailMailboxLabelRepairInPostgres(command),held);assert.deepEqual(await state(),changed)}finally{await restore()}
 })
 for(const [column,value]of [['account_email','raced.mailbox@example.invalid'],['status','INACTIVE'],['app','google-calendar'],['source','manual'],['is_selected',false],['owner_email',OTHER]]){
  const previous=(await query(`SELECT ${column} AS value FROM user_maton_connections WHERE connection_id=$1`,[connection])).rows[0].value
  await race(`connection ${column} drift is held without repair writes`,()=>query(`UPDATE user_maton_connections SET ${column}=$2 WHERE connection_id=$1`,[connection,value]),
   ()=>query(`UPDATE user_maton_connections SET ${column}=$2 WHERE connection_id=$1`,[connection,previous]))
 }
 for(const column of ['updated_at','remote_created_at','remote_updated_at','last_refreshed_at']){
  const previous=(await query(`SELECT ${column}::text AS value FROM user_maton_connections WHERE connection_id=$1`,[connection])).rows[0].value
  await race(`connection ${column} full-precision CAS rejects one-microsecond drift`,()=>query(`UPDATE user_maton_connections SET ${column}=${column}+interval '1 microsecond' WHERE connection_id=$1`,[connection]),
   ()=>query(`UPDATE user_maton_connections SET ${column}=$2::timestamptz WHERE connection_id=$1`,[connection,previous]))
 }
 for(const [name,sql]of [['version','api_key_version=api_key_version+1'],['material',"api_key_ciphertext=decode(repeat('ab',32),'hex')"],
  ['iv',"api_key_iv=decode(repeat('bc',12),'hex')"],['tag',"api_key_tag=decode(repeat('cd',16),'hex')"],
  ['updated timestamp',"updated_at=updated_at+interval '1 microsecond'"],['rotation timestamp',"key_rotated_at=key_rotated_at+interval '1 microsecond'"],
  ['revocation','api_key_ciphertext=NULL,api_key_iv=NULL,api_key_tag=NULL,api_key_last_four=NULL,key_rotated_at=NULL,key_revoked_at=clock_timestamp()']]){
  await race(`credential ${name} drift cannot reuse the approved observation`,()=>query(`UPDATE user_maton_credentials SET ${sql} WHERE owner_email=$1`,[OWNER]),restoreCredential)
 }
 for(const [column,changed]of [['account_email',"'raced.binding@example.invalid'"],['verified_at',"verified_at+interval '1 microsecond'"]]){
  const previous=(await query(`SELECT ${column}::text AS value FROM crm_email_mailbox_bindings WHERE owner_email=$1 AND connection_id=$2`,[OWNER,connection])).rows[0].value
  await race(`binding ${column} drift invalidates review`,()=>query(`UPDATE crm_email_mailbox_bindings SET ${column}=${changed} WHERE owner_email=$1 AND connection_id=$2`,[OWNER,connection]),
   ()=>query(`UPDATE crm_email_mailbox_bindings SET ${column}=$3 WHERE owner_email=$1 AND connection_id=$2`,[OWNER,connection,previous]))
 }
 for(const [name,change,restore]of [
  ['owner disabled',"UPDATE app_users SET status='disabled' WHERE email=$1","UPDATE app_users SET status='active' WHERE email=$1"],
  ['membership disabled',"UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1","UPDATE app_user_organization_memberships SET status='active' WHERE user_email=$1"],
  ['membership trashed',"UPDATE app_user_organization_memberships SET status='disabled',trashed_at=clock_timestamp(),trashed_by=$1,pre_trash_status='active' WHERE user_email=$1",
   "UPDATE app_user_organization_memberships SET status='active',trashed_at=NULL,trashed_by=NULL,pre_trash_status=NULL WHERE user_email=$1"],
 ])await race(name,()=>query(change,[OWNER]),()=>query(restore,[OWNER]))
 await race('owner permission authority hash drift is held',()=>query("UPDATE app_users SET permissions='{\"viewCrm\":false}' WHERE email=$1",[OWNER]),
  ()=>query('UPDATE app_users SET permissions=$2::jsonb WHERE email=$1',[OWNER,JSON.stringify(originalPermissions)]))
 await race('pipeline owner drift is reauthorized',()=>query('UPDATE pipeline_spaces SET owner_email=$2 WHERE id=$1',[pipeline,OTHER]),()=>query('UPDATE pipeline_spaces SET owner_email=$2 WHERE id=$1',[pipeline,OWNER]))
 await race('disabled pipeline is reauthorized',()=>query('UPDATE pipeline_spaces SET reference_access_disabled=true WHERE id=$1',[pipeline]),()=>query('UPDATE pipeline_spaces SET reference_access_disabled=false WHERE id=$1',[pipeline]))
 await check('binding rejection after connection-label UPDATE rolls back connection, canonical labels and audit atomically',async()=>{
  const command=await attempt(),before=await state()
  await query(`CREATE FUNCTION test_deny_mailbox_label_repair_binding() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF NOT EXISTS(SELECT 1 FROM user_maton_connections WHERE connection_id='synthetic-label-repair-connection' AND account_email='next.mailbox@example.invalid')
    THEN RAISE EXCEPTION 'Test did not observe the repaired connection label';END IF;
   RAISE EXCEPTION 'Test denied binding after repaired connection label';END $$;
   CREATE TRIGGER test_deny_mailbox_label_repair_binding BEFORE UPDATE ON crm_email_mailbox_bindings
    FOR EACH ROW EXECUTE FUNCTION test_deny_mailbox_label_repair_binding()`)
  try{await assert.rejects(api.applyGmailMailboxLabelRepairInPostgres(command),/Test denied binding after repaired connection label/);assert.deepEqual(await state(),before)}
  finally{await query('DROP TRIGGER test_deny_mailbox_label_repair_binding ON crm_email_mailbox_bindings;DROP FUNCTION test_deny_mailbox_label_repair_binding()')}
 })
 await check('concurrent applies admit one exact repair and reject the stale competitor',async()=>{
  const command=await attempt(),results=await Promise.allSettled([api.applyGmailMailboxLabelRepairInPostgres(command),api.applyGmailMailboxLabelRepairInPostgres(command)])
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected'&&held(row.reason)).length,1)
  assert.equal((await verified(NEXT)).mailboxId,bound.mailboxId)
  assert.equal((await query('SELECT count(*) FROM crm_email_mailboxes')).rows[0].count,'1')
  assert.deepEqual((await query('SELECT * FROM crm_email_sources WHERE id=$1',[first.sourceId])).rows[0],retained)
 })
 await check('real initial Store preview/reserve pins sources; repair and ordinary binder both fail without partial writes',async()=>{
  const command=await attempt(OLD)
  await query(`INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,[operator,root,OWNER])
  await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)`,[operator,root,OWNER])
  const {PostgresNativeEmailInitialEnrollmentStore:Store}=load('app_src/lib/crm/nativeEmailInitialEnrollmentPostgres.ts')
  const store=new Store(transaction,{actorEmail:OWNER,operatorAccountId:operator,rootWorkspaceId:root,nativeInstanceId:instance})
  const preview=await store.preview(),operationId=hash('synthetic-mailbox-repair-initial-reservation-'+id())
  assert.equal(preview.publicationEnabled,false);assert.equal(preview.activeOperationId,null)
  assert.equal((await store.reserve(operationId,preview.sourceFingerprint)).state,'reserved')
  const before=await state()
  await assert.rejects(api.applyGmailMailboxLabelRepairInPostgres(command),held)
  await assert.rejects(api.bindVerifiedGmailMailboxInPostgres({ownerEmail:OWNER,connectionId:connection,
   identity:{subject:SUBJECT,email:NEXT,displayName:null},observedAccountEmail:NEXT}),held)
  assert.deepEqual(await state(),before)
  assert.equal((await query('SELECT active_initial_enrollment_id FROM crm_native_email_publication_control WHERE singleton')).rows[0].active_initial_enrollment_id,operationId)
  assert.equal((await query('SELECT count(*) FROM crm_native_email_initial_reservations')).rows[0].count,'1')
 })
 for(const [path,pin]of sourceHashes)assert.equal(hash(readFileSync(path)),pin,`Consumed source changed during fixture: ${path}`)
 console.log(JSON.stringify({kind:'mailbox-label-repair-postgres',postgresMajor:major,checks,migrations,sourceHashes:Object.fromEntries(sourceHashes),
  actualSql:true,actualMailboxDal:true,actualAuditWriter:true,actualInitialReservationStore:true,syntheticVerifiedGoogleIdentity:true,
  syntheticGmailProfile:true,googleAuthenticationProven:false,providerTouched:false,nativeExecutionProven:false,productionTouched:false}))
}finally{
 try{if(pool)await pool.end()}finally{if(started)assert.equal(runtime.cleanup(),true,'Exact owner-checked container, volumes and lease cleanup required')}
}
