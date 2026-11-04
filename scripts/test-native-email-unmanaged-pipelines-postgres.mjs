// Called only inside the normal guarded root-access runner's owned DB clone.
// Real SQL/DAL/terminal guards; native initial evidence is explicitly synthetic.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {enrollRootCrmSyntheticInitial} from './lib/root-crm-synthetic-initial-enrollment.mjs'

export async function runUnmanagedPipelineAcceptance(c){
 const {query,tx,load,users,protocol,authority,eligibility,nativeAdapter,transition,capability,
   rootRegistry,rootRegistryPreview,owner,employee,admin,root,peer,account,id,check}=c
 const personal='personal.app-only@example.invalid',personalIds=[id(600),id(601)],mapped=id(903),nativeOwner=id(901)
 const json=protocol.nativeEmailCanonicalJson,hash=protocol.nativeEmailDigest
 const rollback=async fn=>{const marker=Error('OWNED_ROLLBACK_PROBE');await assert.rejects(tx(async client=>{await fn(client);throw marker}),e=>e===marker)}
 await query(`UPDATE app_users SET reference_code=COALESCE(reference_code,allocate_crm_reference('gu')),
   crm_user_enabled=true WHERE email=ANY($1::text[])`,[[owner,admin]])
 await query(`UPDATE app_users SET suitecrm_user_id=CASE WHEN email=$1 THEN $3 ELSE $4 END,
   suitecrm_username=reference_code,organization_id=$5 WHERE email=ANY($2::text[])`,[owner,[owner,admin],nativeOwner,mapped,root])
 // Real authenticated DAL calls normalize the configured owner's profile.
 // Do that before initial source capture, never after native activation.
 await users.requireActiveAppUser(owner)
 await query(`INSERT INTO app_users(email,role,status,permissions,organization_id,crm_user_enabled)
   VALUES($1,'member','active',$2,$3,false)`,[personal,users.MEMBER_PERMISSIONS,root])
 for(const [workspace,pipeline]of[[root,personalIds[0]],[peer,personalIds[1]]]){
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'member','active',$3,$4,$4)`,[personal,workspace,users.MEMBER_PERMISSIONS,owner])
  await query('INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,$2,$3,$4)',
   [pipeline,'Existing app-only personal pipeline',personal,workspace])
 }
 // Existing Accounts/Contacts can have ordinary native projections without
 // enrolling this explicitly app-only owner's pipeline in native Email ACLs.
 // Match the full-DDL initial-joint seed: permanent identity and source keys,
 // registry-allocated references, and Contact's required same-pipeline Account.
 await query(`INSERT INTO crm_organizations(id,pipeline_id,suitecrm_id,source_key,identity_key,name,account_type,
   relationship_type,source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code,created_by,updated_by)
   VALUES($1,$2,$3,$4,$4,'Personal ordinary account','Customer','customer','{"synthetic":true}',$5,
     'synced',now(),allocate_crm_reference('ga'),$6,$6)`,
 [id(610),personalIds[0],id(1610),'customer:name:personal ordinary account',hash('organizations'),personal])
 await query(`INSERT INTO crm_contacts(id,pipeline_id,organization_id,suitecrm_id,source_key,identity_key,full_name,last_name,email,
   source_payload,source_hash,sync_status,suitecrm_synced_at,reference_code,created_by,updated_by)
   VALUES($1,$2,$3,$4,$5,$5,'Personal ordinary contact','Ordinary','personal.ordinary@example.invalid','{"synthetic":true}',$6,
     'synced',now(),allocate_crm_reference('gc'),$7,$7)`,
 [id(611),personalIds[0],id(610),id(1611),'email:personal.ordinary@example.invalid',hash('contacts'),personal])
 for(const [entity,n]of[['organizations',610],['contacts',611]]){
  for(const status of['queued','succeeded'])await query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
    VALUES('suitecrm',$1,$2,'upsert_record',$3,$4)`,['crm_'+entity,id(n),{
   entity,pipelineId:personalIds[0],localId:id(n),suiteCrmId:id(n+1000),attributes:{}},status])
 }
 await query('INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)',[account,root,owner])
 for(const workspace of[root,peer])await query(`INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by)
   VALUES($1,$2,$3,true,$3,$3)`,[account,workspace,owner])
 // One known synthetic managed Email supplies the OTHER pipeline's current
 // scope; a completed orphan deletion is not added to this Email inventory.
 await query(`INSERT INTO crm_interactions(id,pipeline_id,source_key,subject,interaction_type,source_hash,
   suitecrm_id,suitecrm_module,suitecrm_synced_at,reference_code,source_payload)
   VALUES($1,$2,'unmanaged-managed-history','Synthetic managed Email','email',$3,$4,'Emails',now(),allocate_crm_reference('gi'),'{"synthetic":true}')`,
 [id(612),id(20),hash('unmanaged-managed-history'),id(1612)])
 const foreignDeleteId=id(613),foreignDeletePayload={entity:'interactions',pipelineId:id(20),localId:id(614),suiteCrmId:id(1614),attributes:{}}
 await query(`INSERT INTO sync_outbox(id,target_system,aggregate_type,aggregate_id,operation,payload,status,attempts,processed_at)
   VALUES($1,'suitecrm','crm_interactions',$2,'delete_record',$3,'succeeded',1,now())`,[foreignDeleteId,id(614),foreignDeletePayload])
 const proof=async(p,client={query})=>(await client.query(`SELECT clawpilot_crm_native_unmanaged_pipeline_footprint($1::uuid) AS footprint,
   clawpilot_crm_native_unmanaged_pipeline_retained($1::uuid) AS retained`,[p])).rows[0]
 await check('unmanaged classification is source-only before a real retained SQL terminal enrollment; raw enable stays forbidden',async()=>{
  for(const p of personalIds)assert.deepEqual(await proof(p),{footprint:true,retained:false})
  await assert.rejects(query('UPDATE crm_native_email_publication_control SET enabled=true'),e=>e.code==='55000')
 })
 await check('case-insensitive ambiguous native member identity includes disabled retained claimants and prevents unmanaged classification',()=>rollback(async client=>{
  const emails=['unmanaged.case.active@example.invalid','unmanaged.case.disabled@example.invalid']
  await client.query(`INSERT INTO app_users(email,role,status,crm_user_enabled,reference_code)
    VALUES($1,'member','active',true,allocate_crm_reference('gu')),($2,'member','disabled',true,allocate_crm_reference('gu'))`,emails)
  await client.query(`UPDATE app_users SET suitecrm_user_id=CASE WHEN email=$1 THEN $3 ELSE $4 END,
    suitecrm_username=reference_code WHERE email=ANY($2::text[])`,
  [emails[0],emails,'00000000-0000-4000-8000-0000000009ab','00000000-0000-4000-8000-0000000009AB'])
  assert.equal((await client.query(`SELECT count(*)::int AS n FROM app_users WHERE lower(suitecrm_user_id)=lower($1)`,
   ['00000000-0000-4000-8000-0000000009ab'])).rows[0].n,2)
  await client.query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$3,'member','active','{"viewCrm":true}',$4,$4),($2,$3,'member','disabled','{"viewCrm":true}',$4,$4)`,
  [...emails,root,owner])
  await client.query(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,'viewer',$3)`,
   [personalIds[0],emails[0],personal])
  assert.equal((await proof(personalIds[0],client)).footprint,false)
 }))
 const initial=await enrollRootCrmSyntheticInitial({query,tx,protocol,capability,owner,root,readers:[nativeOwner,mapped]})
 const terminal=(await query('SELECT to_jsonb(e) AS row FROM crm_native_email_initial_enrollments e WHERE operation_id=$1',[initial.operationId])).rows[0].row
 const protectedState=async()=>({control:(await query('SELECT to_jsonb(c) AS row FROM crm_native_email_publication_control c')).rows,
  policies:(await query('SELECT to_jsonb(p) AS row FROM crm_native_email_capability_policies p ORDER BY pipeline_id')).rows,
  enrollments:(await query('SELECT to_jsonb(e) AS row FROM crm_native_email_initial_enrollments e ORDER BY operation_id')).rows,
  reservations:(await query('SELECT to_jsonb(r) AS row FROM crm_native_email_initial_reservations r ORDER BY operation_id')).rows,
  transitions:(await query('SELECT to_jsonb(t) AS row FROM crm_native_email_authority_transitions t ORDER BY transition_id')).rows})
 const protectedBefore=await protectedState()
 await check('activated origin deliberately excludes personal scopes while complete source, identities and native policies stay retained',async()=>{
  assert.equal(terminal.state,'activated');assert.equal(terminal.receipt_hash,hash(terminal.native_receipt))
  assert.equal((await query(`SELECT receipt_hash<>encode(digest(native_receipt::text,'sha256'),'hex') AS differs
    FROM crm_native_email_initial_enrollments WHERE operation_id=$1`,[initial.operationId])).rows[0].differs,true,
   'Native canonical wire bytes are not interchangeable with JSONB text')
  for(const p of personalIds){assert.deepEqual(await proof(p),{footprint:true,retained:true})
   assert.ok(terminal.source_snapshot.pipelines.some(row=>row.id===p))
   assert.ok(!terminal.plan.pipelines.some(row=>row.policy.pipelineId===p))}
  assert.equal(terminal.plan.emails.length,terminal.source_snapshot.emails.length)
  assert.equal(terminal.plan.emails.length,1)
  assert.ok(!terminal.plan.emails.some(row=>row.after.nativeId===foreignDeletePayload.suiteCrmId),
   'Foreign completed deletion is not adopted as immutable Email history')
  assert.ok(terminal.plan.pipelines.every(row=>row.policy.ownerSuiteCrmId===nativeOwner))
 })
 const member=async(email,p=personalIds[0])=>(await query('SELECT to_jsonb(m) AS row FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',[p,email])).rows[0]?.row??null
 await check('raw SQL allows exact app-only add role change unique mapped target and stale inactive removal without native effects',async()=>{
  await query(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,'viewer',$3)`,[personalIds[0],employee,personal])
  await query(`UPDATE pipeline_space_members SET access_role='editor' WHERE pipeline_id=$1 AND user_email=$2`,[personalIds[0],employee])
  await query(`INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,'editor',$3)`,[personalIds[0],admin,personal])
  await query("UPDATE app_users SET status='disabled' WHERE email=$1",[employee])
  await query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[personalIds[0],employee])
  assert.equal(await member(employee),null);assert.equal((await member(admin)).access_role,'editor')
  await query("UPDATE app_users SET status='active' WHERE email=$1",[employee])
  await query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[personalIds[0],admin])
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 await query('CREATE TABLE unmanaged_fixture_effects(kind text NOT NULL,payload jsonb NOT NULL)')
 const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
 const pipelineSource=ts.createSourceFile('pipeline.ts',readFileSync(new URL('../app_src/lib/persistence/pipeline.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
 const required=['cleanString','requirePipelineId','hashPayload','enqueuePipelinePermissionSyncWithClient']
 const functions=required.map(name=>{const node=pipelineSource.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)
  assert.ok(node,'Actual permission-sync source function must remain available: '+name);return node.getText(pipelineSource)})
 const uuid=pipelineSource.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(pipelineSource)==='UUID_PATTERN'))
 assert.ok(uuid)
 const permissionSync={}
 new Function('exports','crypto',ts.transpileModule([uuid.getText(pipelineSource),...functions].join('\n'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(permissionSync,crypto)
 const unavailable=new Proxy({},{get:()=>()=>{throw Error('Unmanaged scope must never call native transport/configuration')}})
 const runtime=load('app_src/lib/crm/nativeEmailAuthorityRuntime.ts',{'node:crypto':crypto,
  '../persistence/postgres':{withTransaction:tx},'../persistence/crmNativeEmailAuthority':authority,
  '../persistence/pipeline':permissionSync,
  '../auditWriter':{recordAuditEvent:(payload,client)=>client.query("INSERT INTO unmanaged_fixture_effects VALUES('audit',$1)",[payload])},
  './nativeEmailPublication':protocol,'./nativeEmailAuthorityTransitionPostgres':nativeAdapter,
  './nativeEmailAuthorityApproval':unavailable,'./nativeEmailAuthorityTransport':unavailable,
  './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityPlan':unavailable,'./nativeEmailEligibility':eligibility})
 await check('actual sharing runtime uses one independently authorized transaction and audit/sync intent, never native fallback',async()=>{
  for(const role of['viewer','editor',null])assert.equal(await runtime.changePipelineMemberWithNativeAuthority({actorEmail:personal,
   workspaceId:root,pipelineId:personalIds[0],userEmail:admin,accessRole:role}),true)
  assert.equal(await member(admin),null)
  assert.equal((await query('SELECT count(*)::int AS n FROM unmanaged_fixture_effects')).rows[0].n,3)
  assert.equal((await query("SELECT count(*)::int AS n FROM sync_outbox WHERE aggregate_id=$1 AND target_system='google_workspace' AND operation='sync_pipeline_permissions'",[personalIds[0]])).rows[0].n,3)
  assert.equal((await query("SELECT count(*)::int AS n FROM audit_events WHERE aggregate_id=$1 AND event_type='pipeline.permissions.queued'",[personalIds[0]])).rows[0].n,3)
  await assert.rejects(runtime.changePipelineMemberWithNativeAuthority({actorEmail:owner,workspaceId:root,pipelineId:personalIds[0],userEmail:employee,accessRole:'viewer'}))
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 const actor={...await users.requireActiveAppUser(owner),organizationId:root,organizationRole:'owner',organizationPermissions:users.OWNER_PERMISSIONS}
 await check('actual user DAL owner module disable/restore status and Trash work across every owned scope with identity and native evidence unchanged',async()=>{
  for(const enabled of[false,true])await users.updateAppUserAccess({actorEmail:actor,email:personal,organizationId:root,role:'member',
   permissions:{...users.MEMBER_PERMISSIONS,viewCrm:enabled,viewProjects:enabled}})
  for(const status of['disabled','active'])await users.setAppUserStatus({actorEmail:actor,email:personal,organizationId:root,status})
  for(const trashed of[true,false])await users.setAppUserTrashed({actorEmail:actor,email:personal,organizationId:root,trashed})
  assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[personal])).rows[0].suitecrm_user_id,null)
  for(const p of personalIds)assert.deepEqual(await proof(p),{footprint:true,retained:true})
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 await check('root native preview accepts only proven unmanaged omissions and still reads/fingerprints the complete app pipeline inventory',async()=>{
  const grant={id:id(700),operator_account_id:account,user_email:employee,source_workspace_id:root,enabled:true,revision:'1'}
  const change=rootRegistry.prepareRootEmployeeCrmRegistryChange({kind:'root_registry_v1',workspaceId:root,operatorAccountId:account,ownerEmail:owner,
   actorScope:{workspaceId:root,ancestryJson:json([{id:root,parent_id:null,is_demo:false}])},contextFingerprint:'a'.repeat(64),
   changes:[{table:'grant',beforeJson:null,afterJson:json(grant)}]})
  const captures=[],call=()=>tx(client=>rootRegistryPreview.collectRootEmployeeCrmRegistryPreviewWithClient({query:async(sql,args)=>{
   assert.match(sql.trim(),/^(SELECT|WITH)\b/);const result=await client.query(sql,args)
   if(sql.includes('FROM pipeline_spaces WHERE workspace_organization_id'))captures.push(result.rows.map(row=>row.id))
   return result}},{actorEmail:owner,actorWorkspaceId:root,change,pipelineIds:[id(20),id(21)],current:'before'}))
  const first=await call(),second=await call();assert.equal(first.contextFingerprint,second.contextFingerprint)
  assert.ok(captures.every(ids=>personalIds.every(p=>ids.includes(p))))
  assert.ok(first.after[0].source.targets.every(t=>t.pipelines.every(p=>!personalIds.includes(p.id))))
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 const footprintFalse=async(client)=>assert.equal((await proof(personalIds[0],client)).footprint,false)
 await check('dead non-Email history is independent after activation but never bypasses initial non-demo dead-writer safeguards',()=>rollback(async client=>{
  for(const [entity,n]of[['organizations',610],['contacts',611]])await client.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
    VALUES('suitecrm',$1,$2,'upsert_record',$3,'dead')`,['crm_'+entity,id(n),{
   entity,pipelineId:personalIds[0],localId:id(n),suiteCrmId:id(n+1000),attributes:{}}])
  assert.deepEqual(await proof(personalIds[0],client),{footprint:true,retained:true})
 }))
 await check('strict terminal foreign deletion is noninterfering only, never historical adoption or a native authority receipt',async()=>{
  assert.equal((await query('SELECT clawpilot_crm_native_outbox_is_foreign_terminal_delete(o,$2::uuid) AS allowed FROM sync_outbox o WHERE id=$1',
   [foreignDeleteId,personalIds[0]])).rows[0].allowed,true)
  for(const [column,value]of[['status','processing'],['processed_at',null],['last_error','uncertain'],['locked_at',new Date().toISOString()],
   ['lock_token',id(999)],['attempts',0]])await rollback(async client=>{
   await client.query(`UPDATE sync_outbox SET ${column}=$2 WHERE id=$1`,[foreignDeleteId,value]);await footprintFalse(client)
  })
  for(const payload of[{...foreignDeletePayload,entity:'contacts'},{...foreignDeletePayload,localId:id(999)},
   {...foreignDeletePayload,pipelineId:personalIds[0]},{...foreignDeletePayload,pipelineId:id(999)},
   {...foreignDeletePayload,suiteCrmId:'malformed native identity'}, {...foreignDeletePayload,suiteCrmModule:'Accounts'},
   {...foreignDeletePayload,attributes:{pipelineId:personalIds[0]}},{...foreignDeletePayload,extra:true}])await rollback(async client=>{
   await client.query('UPDATE sync_outbox SET payload=$2 WHERE id=$1',[foreignDeleteId,payload]);await footprintFalse(client)
  })
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 for(const status of['queued','succeeded','dead','cancelled'])await check('any retained integration email intent is native-footprint hold: '+status,()=>rollback(async client=>{
  await client.query(`INSERT INTO crm_integration_actions(pipeline_id,actor_email,app,action_type,aggregate_type,aggregate_id,payload,status,idempotency_key)
    VALUES($1,$2,'google-mail','send_email','crm_contacts',$3,'{}',$4,$5)`,[personalIds[0],personal,id(800),status,'unmanaged-action-'+status])
  await footprintFalse(client)
 }))
 for(const status of['queued','succeeded','dead'])await check('personal or orphaned native outbox intent holds in every state: '+status,()=>rollback(async client=>{
  await client.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
    VALUES('suitecrm','crm_interactions',$1,'upsert_record',$2,$3)`,[id(801),{pipelineId:personalIds[0]},status])
  await footprintFalse(client)
 }))
 await check('unknown non-interaction orphan and JSON-null intent fail closed instead of passing SQL three-valued logic',()=>rollback(async client=>{
  await client.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
    VALUES('suitecrm','unknown_unmanaged_fixture',$1,'upsert_record',$2,'queued')`,[id(802),{pipelineId:id(20)}])
  await footprintFalse(client)
 }))
 await check('known non-Email projection requires coherent entity module local identity binding and no Email relationship',async()=>{
  const ordinary={entity:'organizations',pipelineId:personalIds[0],localId:id(610),suiteCrmId:id(1610),attributes:{}}
  const classify=async payload=>(await query('SELECT clawpilot_crm_native_outbox_is_non_email($1,$2,$3,$4) AS allowed',
   ['crm_organizations',id(610),'upsert_record',payload])).rows[0].allowed
  assert.equal(await classify(ordinary),true)
  for(const payload of[{...ordinary,entity:'interactions'},{...ordinary,localId:id(999)},
   {...ordinary,pipelineId:id(20)},{...ordinary,suiteCrmModule:'Emails'},
   {...ordinary,previousSuiteCrmModule:'Emails'},{...ordinary,attributes:null},
   {...ordinary,relationships:[{relatedModuleName:'Emails',relatedBeanId:id(999),linkFieldName:'contact'}]}]){
   assert.equal(await classify(payload),false)
   await rollback(async client=>{await client.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
     VALUES('suitecrm','crm_organizations',$1,'upsert_record',$2,'succeeded')`,[id(610),payload]);await footprintFalse(client)})
  }
  assert.deepEqual(await proof(personalIds[0]),{footprint:true,retained:true})
 })
 await check('known untouched unrelated ordinary product work does not falsely enroll or freeze a personal app pipeline',()=>rollback(async client=>{
  await client.query(`INSERT INTO crm_products(id,pipeline_id,source_key,name,source_hash)
    VALUES($1,$2,'unmanaged-other-product','Unrelated owned fixture',$3)`,[id(803),id(20),hash('unmanaged-other-product')])
  await client.query(`INSERT INTO sync_outbox(target_system,aggregate_type,aggregate_id,operation,payload,status)
    VALUES('suitecrm','crm_products',$1,'upsert_record',$2,'queued')`,[id(803),{pipelineId:id(20)}])
  assert.deepEqual(await proof(personalIds[0],client),{footprint:true,retained:true})
 }))
 await check('private membership proof rejects JSON-null/missing/extra role and immutable scope changes',async()=>{
  const proposed={pipeline_id:personalIds[0],user_email:admin,access_role:'viewer',shared_by:personal,
   created_at:'2026-11-04T12:00:00+00:00',updated_at:'2026-11-04T12:00:00+00:00'}
  for(const altered of[{...proposed,access_role:null},{...proposed,access_role:'owner'}, {...proposed,extra:true},
   {...proposed,pipeline_id:id(20)},{...proposed,shared_by:owner}])assert.equal((await query(
    "SELECT clawpilot_crm_native_unmanaged_app_change('pipeline_space_members',NULL,$1::jsonb) AS allowed",[altered])).rows[0].allowed,false)
  for(const [sql,args]of[
   ['UPDATE pipeline_spaces SET owner_email=$2 WHERE id=$1',[personalIds[0],owner]],
   ['UPDATE pipeline_spaces SET workspace_organization_id=$2 WHERE id=$1',[personalIds[0],peer]],
   ['UPDATE app_users SET suitecrm_user_id=$2 WHERE email=$1',[personal,id(904)]],
   ['UPDATE crm_native_email_publication_control SET active_initial_enrollment_id=$1',[hash('forbidden-initial')]],
   ['UPDATE crm_native_email_publication_control SET active_operation_id=$1',[hash('forbidden-operation')]],
   ['UPDATE crm_native_email_publication_control SET active_transition_id=$1',[hash('forbidden-transition')]],
  ])await assert.rejects(query(sql,args),e=>['55000','23503','23514'].includes(e.code))
  assert.deepEqual(await protectedState(),protectedBefore)
 })
 await check('retained native evidence on a second owned pipeline blocks actual owner lifecycle atomically',async()=>{
  await query(`INSERT INTO audit_events(event_type,aggregate_type,aggregate_id,payload)
    VALUES('crm.record.staged','crm_interactions',$1,$2)`,[id(805),{pipelineId:personalIds[1]}])
  assert.equal((await proof(personalIds[1])).footprint,false)
  const before=(await query('SELECT status,permissions FROM app_user_organization_memberships WHERE user_email=$1 ORDER BY organization_id',[personal])).rows
  await assert.rejects(users.setAppUserStatus({actorEmail:actor,email:personal,organizationId:root,status:'disabled'}),e=>e.code==='55000')
  assert.deepEqual((await query('SELECT status,permissions FROM app_user_organization_memberships WHERE user_email=$1 ORDER BY organization_id',[personal])).rows,before)
  assert.deepEqual(await protectedState(),protectedBefore)
 })
}
