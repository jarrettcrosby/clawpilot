#!/usr/bin/env node
// Actual complete migrations, source collection, session and resource reads.
// Native enablement below is a disposable synthetic flag, not an ACL proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync,readdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import {disposablePostgresDockerArgs,disposablePostgresDockerCleanupArgs} from './lib/disposable-postgres-docker.mjs'
import {applyMigrationSqlForTest} from './lib/postgres-test-migrations.mjs'
if(process.argv.length!==3||!['--postgres','--postgres=18'].includes(process.argv[2]))throw Error('Explicit --postgres or --postgres=18 required')
const postgresMajor=process.argv[2]==='--postgres=18'?18:16
const require=createRequire(new URL('../app_src/package.json',import.meta.url)),{Pool}=require('pg'),ts=require('typescript')
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(path,deps){const module={exports:{}}
 new Function('module','exports','require','process',ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)(
  module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name]},
  {env:{APP_LOGIN_EMAIL:'root.owner@example.invalid',APP_SESSION_SECRET:'root_crm_disposable_session_secret_minimum_32_characters',NODE_ENV:'test'}});return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const source=load('app_src/lib/crm/rootEmployeeCrmAccess.ts',{'./nativeEmailPublication':protocol})
const authority=load('app_src/lib/persistence/crmNativeEmailAuthority.ts',{})
const collector=load('app_src/lib/persistence/crmRootEmployeeAccess.ts',{'./crmNativeEmailAuthority':authority,
 '../crm/rootEmployeeCrmAccess':source,'../crm/nativeEmailPublication':protocol})
const rootRegistry=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
const rootRegistryPreview=load('app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts',{
 '../crm/nativeEmailPublication':protocol,'../crm/rootEmployeeCrmRegistryChange':rootRegistry,
 './crmNativeEmailAuthority':authority,'./crmRootEmployeeAccess':collector})
const eligibility=load('app_src/lib/crm/nativeEmailEligibility.ts',{'./nativeEmailPublication':protocol})
const rootReaders=load('app_src/lib/crm/nativeEmailRootReaders.ts',{'../persistence/crmRootEmployeeAccess':collector,
 '../persistence/crmRootEmployeeRegistryPreview':rootRegistryPreview,'./rootEmployeeCrmRegistryChange':rootRegistry,
 '../persistence/crmNativeEmailAuthority':authority,'./rootEmployeeCrmAccess':source,'./nativeEmailPublication':protocol})
const userEligibility=load('app_src/lib/crm/nativeEmailWorkspaceUserEligibility.ts',{'./nativeEmailPublication':protocol})
const identityLink=load('app_src/lib/crm/nativeEmailIdentityLinkChange.ts',{'./nativeEmailPublication':protocol,'./nativeEmailWorkspaceUserEligibility':userEligibility})
const nativeProjection=load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts',{'node:crypto':crypto})
const capability=load('app_src/lib/crm/nativeEmailCapabilityContract.ts',{'node:crypto':crypto,'./nativeEmailPublication':protocol})
const transition=load('app_src/lib/crm/nativeEmailAuthorityTransition.ts',{'./nativeEmailPublication':protocol,
 './suiteCrmNativeEmailProjection':nativeProjection,'./nativeEmailCapabilityContract':capability})
const nativeTransport=load('app_src/lib/crm/nativeEmailAuthorityTransport.ts',{'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransition':transition})
const nativeAdapter=load('app_src/lib/crm/nativeEmailAuthorityTransitionPostgres.ts',{'./nativeEmailPublication':protocol,
 './nativeEmailIdentityLinkChange':identityLink,
 './nativeEmailEligibility':eligibility,'./nativeEmailRootReaders':rootReaders,'./nativeEmailWorkspaceUserEligibility':userEligibility,
 './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityTransport':nativeTransport,'./nativeEmailCapabilityContract':capability})
const crmAst=ts.createSourceFile('crm.ts',read('app_src/lib/persistence/crm.ts'),ts.ScriptTarget.Latest,true)
const publicationAudienceNode=crmAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='reviewedEmailAudienceUnderNativeControlWithClient')
assert.ok(publicationAudienceNode)
const publicationAudienceModule={exports:{}}
new Function('module','exports','nativeEmailPrincipalIsEligible','nativeEmailEffectivePipelinePrincipals',
 'collectNativeEmailRootSourcesWithClient','projectNativeEmailRootReaders','suiteCrmEmailAudienceFingerprint',
 ts.transpileModule(publicationAudienceNode.getText(crmAst),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
 publicationAudienceModule,publicationAudienceModule.exports,eligibility.nativeEmailPrincipalIsEligible,eligibility.nativeEmailEffectivePipelinePrincipals,
 rootReaders.collectNativeEmailRootSourcesWithClient,rootReaders.projectNativeEmailRootReaders,nativeProjection.suiteCrmEmailAudienceFingerprint)
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const root=id(1),peer=id(2),foreign=id(3),child=id(4),demo=id(5),account=id(10),grant=id(11)
const owner='root.owner@example.invalid',employee='root.employee@example.invalid',other='foreign.owner@example.invalid',admin='root.admin@example.invalid'
const container=`clawpilot-root-registry-${process.pid}-${crypto.randomUUID().slice(0,8)}`
let pool,started=false,groups=0
try{
 execFileSync('docker',disposablePostgresDockerArgs(['run','--rm','-d','--name',container,'--pull','never',
  '-e','POSTGRES_PASSWORD=root_registry_fixture','-e','POSTGRES_DB=root_registry_fixture','-p','127.0.0.1::5432',`pgvector/pgvector:pg${postgresMajor}`]),{stdio:'pipe',timeout:60000});started=true
 const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).match(/^127\.0\.0\.1:(\d+)\s*$/u)?.[1];assert.ok(port)
 pool=new Pool({host:'127.0.0.1',port:Number(port),user:'postgres',password:'root_registry_fixture',database:'root_registry_fixture',max:4,
  connectionTimeoutMillis:1000,statement_timeout:15000})
 const until=Date.now()+30000;for(;;){try{await pool.query('SELECT 1');break}catch(e){if(Date.now()>until)throw e;await new Promise(r=>setTimeout(r,100))}}
 const client=await pool.connect();try{for(const file of readdirSync(new URL('../db/migrations/',import.meta.url)).filter(f=>/^\d+_.+\.sql$/u.test(f)).sort())
  await applyMigrationSqlForTest(client,file,read(`db/migrations/${file}`))}finally{client.release()}
 const query=(sql,args)=>pool.query(sql,args)
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}
  catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
 const postgres={query,withTransaction:tx}
 const unavailable=new Proxy({},{get:(_target,key)=>()=>{throw Error(`Unexpected external integration: ${String(key)}`)}})
 const audit={recordAuditEvent:async()=>undefined}
 const demoMode=load('app_src/lib/demoMode.ts',{})
 const permissions=load('app_src/lib/crm/rootEmployeeCrmPermissions.ts',{})
 const invitationScope=load('app_src/lib/invitationWorkspaceScope.ts',{'./persistence/crmNativeEmailAuthority':authority})
 const coreRuntime=load('app_src/lib/crm/nativeEmailAuthorityRuntime.ts',{'node:crypto':crypto,
  '../persistence/postgres':postgres,'../persistence/crmNativeEmailAuthority':authority,'../persistence/pipeline':unavailable,
  '../auditWriter':audit,'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransitionPostgres':nativeAdapter,
  './nativeEmailAuthorityApproval':unavailable,'./nativeEmailAuthorityTransport':nativeTransport,
  './nativeEmailAuthorityTransition':transition,'./nativeEmailAuthorityPlan':unavailable,'./nativeEmailEligibility':eligibility})
 const userRuntime=load('app_src/lib/crm/nativeEmailWorkspaceUserRuntime.ts',{'node:crypto':crypto,
  '../persistence/postgres':postgres,'../persistence/crmNativeEmailAuthority':authority,'../auditWriter':audit,
  '../invitationWorkspaceScope':invitationScope,'./nativeEmailPublication':protocol,'./nativeEmailAuthorityTransitionPostgres':nativeAdapter,
  './nativeEmailAuthorityTransport':nativeTransport,'./nativeEmailAuthorityPlan':unavailable,'./nativeEmailAuthorityRuntime':coreRuntime,
  './nativeEmailWorkspaceUserEligibility':userEligibility,'./nativeEmailIdentityLinkChange':identityLink})
 const users=load('app_src/lib/users.ts',{'@/lib/persistence/postgres':postgres,
  '@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/nativeEmailWorkspaceUserRuntime':userRuntime,
  '@/lib/auditWriter':audit,'@/lib/invitationWorkspaceScope':invitationScope,'@/lib/crm/suiteCrmClient':unavailable,'@/lib/demoMode':demoMode})
 const memberships=load('app_src/lib/workspaceMemberships.ts',{'@/lib/persistence/postgres':postgres,'@/lib/users':users,
  '@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/rootEmployeeCrmPermissions':permissions,'@/lib/auditWriter':audit,'@/lib/demoMode':demoMode})
 const tenancy=load('app_src/lib/tenancy.ts',{'@/lib/persistence/postgres':postgres,'@/lib/users':users,'@/lib/workspaceMemberships':memberships,
  '@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/auditWriter':audit,'@/lib/demoMode':demoMode,
  '@/lib/persistence/pipeline':unavailable,'@/lib/shortlinks':unavailable,'@/lib/organizations':unavailable,'@/lib/pipeline/baseTemplate.mjs':unavailable})
 const sessions=load('app_src/lib/authSessions.ts',{'crypto':crypto,'@/lib/persistence/postgres':postgres,
  '@/lib/persistence/crmNativeEmailAuthority':authority,'@/lib/crm/rootEmployeeCrmPermissions':permissions,
  '@/lib/auditWriter':audit,'@/lib/auth':unavailable,'@/lib/authLoginIdentity':unavailable,
  '@/lib/requestIpAddress':load('app_src/lib/requestIpAddress.ts',{'node:net':require('node:net')})})
 const headers=new Headers({'user-agent':'Root CRM disposable test','x-forwarded-for':'127.0.0.1'})
 const issue=(organizationId=peer)=>sessions.createBrowserSession({email:employee,organizationId,authMethod:'magic_code',headers})
 async function check(name,fn){await fn();groups++;console.log('PASS '+name)}
 const inspect=(actorEmail=owner)=>tx(c=>collector.collectRootEmployeeCrmAccessWithClient(c,{actorEmail,grantId:grant}))
 const effects=async()=> (await query(`SELECT (SELECT count(*) FROM app_user_organization_memberships) AS memberships,
  (SELECT count(*) FROM pipeline_space_members) AS pipelines,(SELECT count(*) FROM project_board_members) AS boards,
  (SELECT count(*) FROM sync_outbox) AS outbox`)).rows[0]
 await check('migration installs an empty disabled intent registry, not access or enrollment',async()=>{
  for(const table of ['crm_operator_accounts','crm_operator_workspace_bindings','crm_root_employee_access_grants'])
   assert.equal((await query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0)
  assert.equal((await query('SELECT enabled FROM crm_native_email_publication_control')).rows[0].enabled,false)
  assert.deepEqual((await query(`SELECT c.relname FROM pg_class c CROSS JOIN LATERAL
   aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
   WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) AND acl.grantee=0`,
   [['crm_operator_accounts','crm_operator_workspace_bindings','crm_root_employee_access_grants']])).rows,[])
  assert.deepEqual((await query(`SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL
   aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
   WHERE p.pronamespace='public'::regnamespace AND p.proname='clawpilot_crm_root_registry_guard' AND acl.grantee=0`)).rows,[])
 })
 await query("INSERT INTO app_users(email,role,status) VALUES($1,'owner','active'),($2,'member','active'),($3,'owner','active'),($4,'admin','active')",[owner,employee,other,admin])
 for(const [workspace,parent,kind,isDemo,createdBy]of [[root,null,'root',false,owner],[peer,null,'root',false,owner],[foreign,null,'root',false,other],
  [child,root,'member',false,owner],[demo,null,'root',true,owner]])
  await query("INSERT INTO workspace_organizations(id,parent_id,name,organization_type,is_demo,created_by,updated_by) VALUES($1,$2,'Registry workspace fixture',$3,$4,$5,$5)",[workspace,parent,kind,isDemo,createdBy])
 for(const [email,workspace,role]of [[owner,root,'owner'],[owner,peer,'owner'],[other,foreign,'owner'],[employee,root,'member'],[owner,child,'owner'],[owner,demo,'owner'],[admin,root,'admin']])
  await query('INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by) VALUES($1,$2,$3,\'active\',\'{"viewCrm":true}\',$4,$4)',[email,workspace,role,owner])
 for(const [workspace,pipeline,board]of [[root,id(20),id(30)],[peer,id(21),id(31)]]){
  await query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,'Root CRM fixture',$2,$3)",[pipeline,owner,workspace])
  await query("INSERT INTO project_boards(id,name,owner_email,workspace_organization_id) VALUES($1,'Managed CRM fixture',$2,$3),($4,'Private fixture',$2,$3)",[board,owner,workspace,crypto.randomUUID()])
  await query('INSERT INTO crm_board_projections(board_id,pipeline_id,workspace_organization_id) VALUES($1,$2,$3)',[board,pipeline,workspace])
 }
 const initialEffects=await effects()
 const {testRootRegistryPreview}=await import('./test-root-employee-crm-registry-preview-postgres.mjs')
 const registryPreviewContext={load,protocol,collector,authority,query,tx,id,root,peer,foreign,demo,account,grant,owner,employee,admin,check,effects}
 await testRootRegistryPreview(registryPreviewContext,'empty')
 const {runRootCrmSettingsAcceptance}=await import('./test-root-employee-crm-settings-postgres.mjs')
 await runRootCrmSettingsAcceptance({load,query,tx,protocol,authority,rootRegistry,coreRuntime,
  root,peer,foreign,child,demo,owner,employee,admin,check})
 await query('INSERT INTO crm_operator_accounts(id,root_workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)',[account,root,owner])
 for(const workspace of [root,peer])await query('INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)',[account,workspace,owner])
 await query('INSERT INTO crm_root_employee_access_grants(id,operator_account_id,user_email,source_workspace_id,enabled,created_by,updated_by) VALUES($1,$2,$3,$4,true,$5,$5)',[grant,account,employee,root,owner])
 await testRootRegistryPreview(registryPreviewContext,'existing')
 await check('actual collector covers explicitly bound peer roots and managed cards without materializing any grant',async()=>{
  const result=await inspect();assert.equal(result.scope.enabled,true);assert.equal(result.scope.edges.length,6)
  assert.equal(result.scope.suiteCrmUserId,null);assert.deepEqual(result.source.targets.map(v=>v.workspaceId),[root,peer])
  assert.deepEqual(await effects(),initialEffects);assert.equal(result.scope.edges.filter(v=>v.kind==='crm_board').length,2)
 })
 await check('foreign actor, foreign owner, child-root and demo enrollments fail before access changes',async()=>{
  await assert.rejects(inspect(other),e=>e.code==='root_employee_actor_not_owner')
  await assert.rejects(inspect(admin),e=>e.code==='root_employee_actor_not_owner')
  await assert.rejects(tx(async c=>{
   await c.query("UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1 AND organization_id=$2",[owner,root])
   await collector.collectRootEmployeeCrmAccessWithClient(c,{actorEmail:owner,grantId:grant})
  }),e=>e.code==='root_employee_actor_not_owner')
  for(const workspace of [foreign,demo])await assert.rejects(query('INSERT INTO crm_operator_workspace_bindings(operator_account_id,workspace_id,owner_email,enabled,created_by,updated_by) VALUES($1,$2,$3,true,$3,$3)',[account,workspace,owner]),e=>['55000','23503'].includes(e.code))
  for(const workspace of [child,demo])await assert.rejects(query('INSERT INTO crm_operator_accounts(root_workspace_id,owner_email,created_by,updated_by) VALUES($1,$2,$2,$2)',[workspace,owner]),e=>e.code==='55000')
  assert.deepEqual(await effects(),initialEffects)
 })
 await check('identity rebinding, stale revisions, wrong source membership and removal are rejected',async()=>{
  await assert.rejects(query('UPDATE crm_operator_accounts SET owner_email=$2,revision=revision+1 WHERE id=$1',[account,other]),e=>e.code==='55000')
  await assert.rejects(query('UPDATE crm_root_employee_access_grants SET enabled=false WHERE id=$1',[grant]),e=>e.code==='55000')
  await assert.rejects(query('UPDATE crm_root_employee_access_grants SET source_workspace_id=$2,revision=revision+1 WHERE id=$1',[grant,peer]),e=>e.code==='55000')
  await assert.rejects(query('DELETE FROM crm_root_employee_access_grants WHERE id=$1',[grant]),e=>e.code==='55000')
  await assert.rejects(query('TRUNCATE crm_root_employee_access_grants'),e=>e.code==='55000')
 })
 await check('revision-only changes are independently fenced even when desired source scope is identical',async()=>{
  const before=await inspect();await query('UPDATE crm_root_employee_access_grants SET revision=revision+1 WHERE id=$1',[grant]);const after=await inspect()
  assert.equal(after.scope.sourceHash,before.scope.sourceHash);assert.notEqual(after.registryHash,before.registryHash)
  await query('UPDATE crm_operator_workspace_bindings SET enabled=false,revision=revision+1 WHERE operator_account_id=$1 AND workspace_id=$2',[account,peer])
  assert.equal((await inspect()).scope.edges.length,3)
  await query('UPDATE crm_operator_workspace_bindings SET enabled=true,revision=revision+1 WHERE operator_account_id=$1 AND workspace_id=$2',[account,peer])
 })
 await check('native counter advancement is separate from immutable registry evidence',async()=>{
  const before=await inspect()
  await query('UPDATE crm_native_email_publication_control SET generation=generation+1')
  const after=await inspect()
  assert.equal(after.registryHash,before.registryHash);assert.equal(after.scope.sourceHash,before.scope.sourceHash)
  assert.equal(BigInt(after.nativeControl.generation),BigInt(before.nativeControl.generation)+1n)
 })
 await check('runtime membership resolver exposes computed CRM-only peer access without changing actual memberships',async()=>{
  const found=await memberships.listWorkspaceMemberships(employee)
  assert.deepEqual(found.map(v=>v.organizationId).sort(),[root,peer])
  const actor=await memberships.requireWorkspaceAppUser(employee,peer)
  assert.equal(actor.organizationAccessOrigin,'root_crm');assert.equal(actor.organizationRole,'member')
  assert.deepEqual(Object.keys(actor.organizationPermissions).sort(),Object.keys(users.MEMBER_PERMISSIONS).sort())
  for(const [key,value]of Object.entries(actor.organizationPermissions))assert.equal(value,['viewCrm','viewProjects'].includes(key),key)
  await assert.rejects(memberships.requireWorkspaceAppUser(employee,foreign),/access is not available/u)
  await assert.rejects(memberships.requireWorkspaceAppUser(admin,peer),/access is not available/u)
  assert.deepEqual(await effects(),initialEffects)
 })
 await check('actual resource reads include all bound CRM pipelines and managed cards as viewer, never private boards',async()=>{
  for(const workspace of [root,peer]){
   const actor=await memberships.requireWorkspaceAppUser(employee,workspace)
   const before=await effects(),pipelines=await tenancy.listPipelineSpaces(actor),boards=await tenancy.listProjectBoards(actor)
   assert.deepEqual(pipelines.map(v=>v.id),[workspace===root?id(20):id(21)])
   assert.deepEqual(boards.map(v=>v.id),[workspace===root?id(30):id(31)])
   for(const resource of [...pipelines,...boards]){assert.equal(resource.accessRole,'viewer');assert.deepEqual(resource.members,[])
    assert.throws(()=>tenancy.requireResourceEditor(resource),/view-only/u)}
   const defaults=await tenancy.ensureDefaultResourcesForUser(actor)
   assert.equal(defaults.pipelineProvisioningRequired,false);assert.deepEqual(await effects(),before)
  }
 })
 await check('a computed workspace cannot reactivate stale private-board or editor shares; real manual grants retain their role',async()=>{
  const privateBoard=(await query('SELECT b.id::text FROM project_boards b LEFT JOIN crm_board_projections p ON p.board_id=b.id WHERE b.workspace_organization_id=$1 AND p.board_id IS NULL',[peer])).rows[0].id
  await query("INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,'editor',$3)",[id(21),employee,owner])
  await query("INSERT INTO project_board_members(board_id,user_email,access_role,shared_by) VALUES($1,$3,'editor',$4),($2,$3,'editor',$4)",[id(31),privateBoard,employee,owner])
  let actor=await memberships.requireWorkspaceAppUser(employee,peer)
  assert.equal((await tenancy.listPipelineSpaces(actor))[0].accessRole,'viewer')
  assert.deepEqual((await tenancy.listProjectBoards(actor)).map(v=>[v.id,v.accessRole]),[[id(31),'viewer']])
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'member','active','{"viewCrm":true,"viewProjects":true}',$3,$3)`,[employee,peer,owner])
  actor=await memberships.requireWorkspaceAppUser(employee,peer);assert.equal(actor.organizationAccessOrigin,'membership')
  assert.equal((await tenancy.listPipelineSpaces(actor,{ensureDefaults:false}))[0].accessRole,'editor')
  assert.equal((await tenancy.listProjectBoards(actor,{ensureDefaults:false})).find(v=>v.id===privateBoard).accessRole,'editor')
  await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])
  await query('DELETE FROM project_board_members WHERE user_email=$1 AND board_id=ANY($2::uuid[])',[employee,[id(31),privateBoard]])
  await query('DELETE FROM pipeline_space_members WHERE user_email=$1 AND pipeline_id=$2',[employee,id(21)])
  assert.deepEqual(await effects(),initialEffects)
 })
 await check('real session issuance retains the original membership FK and exposes only the separately validated CRM target',async()=>{
  const issued=await issue(),resolved=await sessions.resolveBrowserSessionToken(issued.token)
  assert.equal(resolved.activeWorkspaceOrganizationId,peer);assert.equal(resolved.activeWorkspaceRole,'member')
  for(const [key,value]of Object.entries(resolved.activeWorkspacePermissions))assert.equal(value,['viewCrm','viewProjects'].includes(key),key)
  const stored=(await query('SELECT active_workspace_organization_id::text,crm_view_workspace_organization_id::text,token_hash FROM app_sessions WHERE id=$1',[issued.session.id])).rows[0]
  assert.equal(stored.active_workspace_organization_id,root);assert.equal(stored.crm_view_workspace_organization_id,peer)
  assert.match(stored.token_hash,/^[a-f0-9]{64}$/u);assert.notEqual(stored.token_hash,issued.token)
  const originalFk=(await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='app_sessions'::regclass AND conname='app_sessions_active_workspace_membership_fkey'")).rows[0]
  assert.match(originalFk.definition,/FOREIGN KEY \(effective_user_email, active_workspace_organization_id\).*REFERENCES app_user_organization_memberships/u)
  await assert.rejects(issue(foreign),/not active/u)
  await assert.rejects(query('UPDATE app_sessions SET crm_view_workspace_organization_id=$2 WHERE id=$1',[issued.session.id,foreign]),e=>e.code==='42501')
  assert.equal((await sessions.resolveBrowserSessionToken(issued.token)).activeWorkspaceOrganizationId,peer)
 })
 await check('workspace switching rotates tokens and clears delegated context when returning to an actual membership',async()=>{
  const first=await issue(root),second=await sessions.switchBrowserSessionWorkspace({session:first.session,organizationId:peer})
  assert.equal(await sessions.resolveBrowserSessionToken(first.token),null)
  assert.equal(second.session.activeWorkspaceOrganizationId,peer)
  const third=await sessions.switchBrowserSessionWorkspace({session:second.session,organizationId:root})
  assert.equal(await sessions.resolveBrowserSessionToken(second.token),null)
  assert.equal(third.session.activeWorkspaceOrganizationId,root)
  assert.equal((await query('SELECT crm_view_workspace_organization_id FROM app_sessions WHERE id=$1',[third.session.id])).rows[0].crm_view_workspace_organization_id,null)
 })
 await check('support-mode exit clears delegated context and never transfers employee permissions into the authenticated owner session',async()=>{
  const original=await sessions.createBrowserSession({email:owner,organizationId:root,authMethod:'magic_code',headers})
  const support=await sessions.startImpersonation({session:original.session,targetEmail:employee})
  assert.equal(await sessions.resolveBrowserSessionToken(original.token),null)
  const delegated=await sessions.switchBrowserSessionWorkspace({session:support.session,organizationId:peer})
  assert.equal(delegated.session.impersonating,true);assert.equal(delegated.session.activeWorkspacePermissions.manageUserAccess,false)
  const restored=await sessions.stopImpersonation(delegated.session)
  assert.equal(restored.session.effectiveUser,owner);assert.equal(restored.session.impersonating,false)
  assert.equal(await sessions.resolveBrowserSessionToken(delegated.token),null)
  assert.equal((await query('SELECT crm_view_workspace_organization_id FROM app_sessions WHERE id=$1',[restored.session.id])).rows[0].crm_view_workspace_organization_id,null)
 })
 await check('projects module denial removes inherited cards without hiding legitimate CRM reads or creating fallback resources',async()=>{
  const issued=await issue()
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true,"viewProjects":false}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  const actor=await memberships.requireWorkspaceAppUser(employee,peer)
  assert.equal(actor.organizationPermissions.viewProjects,false);assert.equal(actor.organizationPermissions.viewCrm,true)
  assert.deepEqual(await tenancy.listProjectBoards(actor),[]);assert.equal((await tenancy.listPipelineSpaces(actor)).length,1)
  assert.equal((await sessions.resolveBrowserSessionToken(issued.token)).activeWorkspacePermissions.viewProjects,false)
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  assert.deepEqual(await effects(),initialEffects)
 })
 await check('workspace-specific sign-out revokes delegated sessions by target as well as source',async()=>{
  const issued=await issue()
  await sessions.revokeBrowserSessionsForUserWorkspace({userEmail:employee,organizationId:peer,actor:owner,reason:'fixture_target_removal'})
  assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
 })
 await check('source CRM denial immediately revokes delegated sessions; restoring permission does not resurrect tokens',async()=>{
  const issued=await issue()
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
  await assert.rejects(memberships.requireWorkspaceAppUser(employee,peer),/access is not available/u)
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
  assert.equal((await issue()).session.activeWorkspaceOrganizationId,peer)
 })
 await check('inactive pipelines remove their inherited cards and do not create a replacement pipeline or board',async()=>{
  const actor=await memberships.requireWorkspaceAppUser(employee,peer),before=await effects()
  await query('UPDATE pipeline_spaces SET reference_access_disabled=true WHERE id=$1',[id(21)])
  assert.deepEqual(await tenancy.listPipelineSpaces(actor),[]);assert.deepEqual(await tenancy.listProjectBoards(actor),[])
  assert.deepEqual(await tenancy.ensureDefaultResourcesForUser(actor),{boardId:null,pipelineId:null,crmBoardId:null,pipelineProvisioningRequired:false})
  await query('UPDATE pipeline_spaces SET reference_access_disabled=false WHERE id=$1',[id(21)])
  assert.deepEqual(await effects(),before)
 })
 await check('global suspension, source trash and operator demotion revoke delegated sessions without resurrection',async()=>{
  for(const [revoke,restore,args]of [
   ["UPDATE app_users SET status='disabled' WHERE email=$1","UPDATE app_users SET status='active' WHERE email=$1",[employee]],
   ["UPDATE app_user_organization_memberships SET status='disabled',trashed_at=now(),trashed_by=$3,pre_trash_status='active' WHERE user_email=$1 AND organization_id=$2",
    "UPDATE app_user_organization_memberships SET status='active',trashed_at=NULL,trashed_by=NULL,pre_trash_status=NULL WHERE user_email=$1 AND organization_id=$2 AND $3::text IS NOT NULL",[employee,root,owner]],
   ["UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1 AND organization_id=$2",
    "UPDATE app_user_organization_memberships SET role='owner' WHERE user_email=$1 AND organization_id=$2",[owner,root]],
  ]){
   const issued=await issue();await query(revoke,args)
   assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
   await assert.rejects(memberships.requireWorkspaceAppUser(employee,peer),/not active|access is not available/u)
   await query(restore,args);assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
   assert.equal((await issue()).session.activeWorkspaceOrganizationId,peer)
  }
 })
 await check('grant and binding revocation immediately kill existing delegated sessions and never remove independent shares',async()=>{
  for(const [sql,args]of [
   ['UPDATE crm_root_employee_access_grants SET enabled=$2,revision=revision+1 WHERE id=$1',[grant]],
   ['UPDATE crm_operator_workspace_bindings SET enabled=$2,revision=revision+1 WHERE operator_account_id=$1 AND workspace_id=$3',[account,undefined,peer]],
  ]){
   const values=args.length===1?[args[0],false]:[args[0],false,args[2]],issued=await issue()
   await query(sql,values);assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
   values[1]=true;await query(sql,values);assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
  }
  assert.deepEqual(await effects(),initialEffects)
 })
 await check('a direct session writer waits before row locks and refuses a target revoked while waiting',async()=>{
  const issued=await issue(root),holder=await pool.connect(),writer=await pool.connect()
  try{
   await holder.query('BEGIN');await holder.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
   await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='5s'")
   const pending=writer.query('UPDATE app_sessions SET crm_view_workspace_organization_id=$2 WHERE id=$1',[issued.session.id,peer]).then(()=>null,e=>e)
   let blocked=false
   for(let i=0;i<100;i++){
    if((await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[holder.processID,writer.processID])).rows[0].blocked){blocked=true;break}
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   assert.equal(blocked,true,'Statement control lock precedes any contested session row lock')
   await holder.query('UPDATE crm_root_employee_access_grants SET enabled=false,revision=revision+1 WHERE id=$1',[grant])
   await holder.query('COMMIT');assert.equal((await pending).code,'42501')
   await writer.query('ROLLBACK')
  }finally{await holder.query('ROLLBACK');await writer.query('ROLLBACK');holder.release();writer.release()}
  await query('UPDATE crm_root_employee_access_grants SET enabled=true,revision=revision+1 WHERE id=$1',[grant])
  assert.equal((await sessions.resolveBrowserSessionToken(issued.token)).activeWorkspaceOrganizationId,root)
  assert.equal((await query('SELECT crm_view_workspace_organization_id FROM app_sessions WHERE id=$1',[issued.session.id])).rows[0].crm_view_workspace_organization_id,null)
 })
 await check('credential-style revocation does not reverse the control/user lock order and cannot be undone',async()=>{
  const issued=await issue(),holder=await pool.connect(),writer=await pool.connect()
  try{
   await holder.query('BEGIN');await holder.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
   await writer.query('SELECT email FROM app_users WHERE email=$1 FOR UPDATE',[employee])
   await writer.query("UPDATE app_sessions SET revoked_at=now(),revoked_reason='fixture_credential_change' WHERE id=$1",[issued.session.id])
   await writer.query('COMMIT');await holder.query('COMMIT')
  }finally{await holder.query('ROLLBACK');await writer.query('ROLLBACK');holder.release();writer.release()}
  assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
  await assert.rejects(query('UPDATE app_sessions SET revoked_at=NULL WHERE id=$1',[issued.session.id]),e=>e.code==='42501')
  assert.equal(await sessions.resolveBrowserSessionToken(issued.token),null)
 })
 const targetDeniedSession=await issue()
 await check('an explicit target CRM denial is preserved, not overwritten by root intent',async()=>{
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
   VALUES($1,$2,'member','active','{"viewCrm":false}',$3,$3)`,[employee,peer,owner])
  const result=await inspect();assert.equal(result.scope.edges.length,3)
  assert.equal((await query('SELECT permissions FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])).rows[0].permissions.viewCrm,false)
  assert.equal(await sessions.resolveBrowserSessionToken(targetDeniedSession.token),null)
  await assert.rejects(tenancy.resolvePipelineSpaceAccess({actorEmail:{email:employee,organizationId:peer},pipelineId:id(21)}),/access|denied/u)
 })
 await check('disabled source grant derives no inherited access while preserving all manual resources',async()=>{
  const before=await effects();await query('UPDATE crm_root_employee_access_grants SET enabled=false,revision=revision+1 WHERE id=$1',[grant])
  assert.deepEqual((await inspect()).scope.edges,[]);assert.deepEqual(await effects(),before)
 })
 await check('collector source reads hold the same control fence as registry writes',async()=>{
  const c=await pool.connect();try{
   await c.query('BEGIN');await collector.collectRootEmployeeCrmAccessWithClient(c,{actorEmail:owner,grantId:grant})
   await assert.rejects(tx(async waiter=>{await waiter.query("SET LOCAL lock_timeout='100ms'");await waiter.query('UPDATE crm_operator_accounts SET revision=revision+1 WHERE id=$1',[account])}),e=>e.code==='55P03')
   await c.query('ROLLBACK')
  }finally{c.release()}
 })
 const {runRootAppOnlyLifecycleAcceptance}=await import('./test-root-app-only-lifecycle-postgres.mjs')
 await runRootAppOnlyLifecycleAcceptance({users,query,inspect,owner,employee,root,peer,grant,check})
 await check('first existing-account preview derives the complete source without linking or granting any access',async()=>{
  await query("UPDATE app_users SET reference_code=COALESCE(reference_code,allocate_crm_reference('gu')),crm_user_enabled=true WHERE email=ANY($1::text[])",[[owner,employee]])
  await query('UPDATE app_users SET suitecrm_user_id=$2,suitecrm_username=reference_code WHERE email=$1',[owner,id(901)])
  await query('UPDATE crm_root_employee_access_grants SET enabled=true,revision=revision+1 WHERE id=$1',[grant])
  const store=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,{actorEmail:owner,actorWorkspaceId:root,
   approvalIdentity:{keyId:'root-test',nativeInstanceId:'root-native',serviceUserId:id(903),oauthClientId:id(904)}})
  const gu=(await query('SELECT reference_code FROM app_users WHERE email=$1',[employee])).rows[0].reference_code
  const request={workspaceId:root,userEmail:employee,nativeIdentity:{userId:id(902),globalId:gu,username:gu}}
  const before=await effects(),usersBefore=(await query('SELECT to_jsonb(u) AS row FROM app_users u ORDER BY email')).rows
  const preview=await store.previewUserIdentityLink(request,[id(20),id(21)])
  assert.equal(preview.desiredAppChange.kind,'user_identity_link_v1')
  const beforeUser=JSON.parse(preview.desiredAppChange.appUser.beforeJson),afterUser=JSON.parse(preview.desiredAppChange.appUser.afterJson)
  assert.equal(beforeUser.suitecrm_user_id,null);assert.equal(beforeUser.suitecrm_username,null)
  assert.deepEqual(afterUser,{...beforeUser,suitecrm_user_id:id(902),suitecrm_username:gu})
  assert.notEqual(preview.appAuthorityBeforeFingerprint,preview.appAuthorityAfterFingerprint)
  for(const scope of preview.snapshots.before.pipelines){
   assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(v=>v.suitecrm_user_id),[id(901)])
   assert.equal(scope.rootReaders[0].suitecrm_user_id,null);assert.equal(scope.rootReaders[0].native_identity_count,0)
  }
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(preview.snapshots.after.pipelines[0]).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(preview.snapshots.after.pipelines[1]).map(v=>v.suitecrm_user_id),[id(901)],
   'A real target CRM denial wins over the proposed root native link')
  assert.deepEqual(await effects(),before);assert.deepEqual((await query('SELECT to_jsonb(u) AS row FROM app_users u ORDER BY email')).rows,usersBefore)
  await assert.rejects(store.previewUserIdentityLink({...request,nativeIdentity:{...request.nativeIdentity,userId:id(901)}},[id(20),id(21)]),
   e=>e.code==='authority_identity_already_claimed')
  const aliasEmail='fixture.native.alias@example.invalid'
  await query(`INSERT INTO app_users(email,status,role,reference_code,crm_user_enabled,suitecrm_user_id,suitecrm_username)
   SELECT $1,'disabled','member',gu,true,'Native-Existing',gu FROM (SELECT allocate_crm_reference('gu') AS gu) issued`,[aliasEmail])
  try{await assert.rejects(store.previewUserIdentityLink({...request,nativeIdentity:{...request.nativeIdentity,userId:'native-existing'}},[id(20),id(21)]),
   e=>e.code==='authority_identity_already_claimed')}
  finally{await query('DELETE FROM app_users WHERE email=$1',[aliasEmail])}
  await assert.rejects(store.previewUserIdentityLink({...request,nativeIdentity:{...request.nativeIdentity,globalId:'gu1234567',username:'gu1234567'}},[id(20),id(21)]),
   e=>e.code==='identity_link_delta_invalid')
  assert.deepEqual(nativeAdapter.prepareNativeEmailAppAuthorityChange(preview.desiredAppChange),preview.desiredAppChange)
 })
 await check('first native-link projection preserves inherited viewer scope and pins retained manual intent independently',async()=>{
  await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])
  const store=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,{actorEmail:owner,actorWorkspaceId:root,
   approvalIdentity:{keyId:'root-test',nativeInstanceId:'root-native',serviceUserId:id(903),oauthClientId:id(904)}})
  const gu=(await query('SELECT reference_code FROM app_users WHERE email=$1',[employee])).rows[0].reference_code
  const request={workspaceId:root,userEmail:employee,nativeIdentity:{userId:id(902),globalId:gu,username:gu}}
  const preview=await store.previewUserIdentityLink(request,[id(20),id(21)])
  for(const scope of preview.snapshots.after.pipelines){
   assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
   assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(scope).map(v=>v.suitecrm_user_id),[id(901)])
  }
  assert.equal(preview.snapshots.after.pipelines[1].principals.some(v=>v.email===employee),false,'No virtual peer membership or principal')
  await query('INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by) VALUES($1,$2,\'editor\',$3)',[id(20),employee,owner])
  const retained=await store.previewUserIdentityLink(request,[id(20),id(21)])
  assert.notEqual(retained.desiredAppChange.contextFingerprint,preview.desiredAppChange.contextFingerprint)
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(retained.snapshots.after.pipelines[0]).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(retained.snapshots.after.pipelines[1]).map(v=>v.suitecrm_user_id),[id(901)])
  await query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[id(20),employee])
  const adminStore=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,{actorEmail:admin,actorWorkspaceId:root,
   approvalIdentity:{keyId:'root-test',nativeInstanceId:'root-native',serviceUserId:id(903),oauthClientId:id(904)}})
  await assert.rejects(adminStore.previewUserIdentityLink(request,[id(20),id(21)]),e=>e.code==='authority_actor_user_access_denied')
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
   VALUES($1,$2,'member','active','{"viewCrm":false}',$3,$3)`,[employee,peer,owner])
 })
 await check('first existing-account link uses actual SQL phases and resumes an unknown grant without repeating its app change',async()=>{
  const {runExistingIdentityLinkAcceptance}=await import('./test-native-email-identity-link-postgres.mjs')
  await runExistingIdentityLinkAcceptance({load,protocol,eligibility,userEligibility,nativeProjection,capability,transition,nativeAdapter,
   nativeTransport,query,tx,id,root,peer,owner,employee,grant,
   verifyRootNativeReads:async({nativeId,pipelines,transitionId})=>{
    await check('enabled root app reads require exact retained native reader proof and preserve viewer-only session/resource scope',async()=>{
     for(const [index,pipeline]of pipelines.entries())assert.equal((await query(
      'SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipeline,index===0?root:peer,nativeId])).rows[0].allowed,true)
     assert.deepEqual((await query('SELECT workspace_id::text FROM clawpilot_crm_root_read_workspaces($1) ORDER BY workspace_id',[employee])).rows.map(r=>r.workspace_id),[root,peer])
     assert.equal((await query('SELECT count(*)::int AS n FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])).rows[0].n,0)
     const issued=await issue(root),switched=await sessions.switchBrowserSessionWorkspace({session:issued.session,organizationId:peer})
     assert.equal((await sessions.resolveBrowserSessionToken(switched.token)).activeWorkspaceOrganizationId,peer)
     const space=await tenancy.resolvePipelineSpaceAccess({actorEmail:{email:employee,organizationId:peer},pipelineId:pipelines[1]})
     assert.equal(space.accessRole,'viewer');assert.throws(()=>tenancy.requireResourceEditor(space),/view-only/u)
     assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipelines[1],foreign,nativeId])).rows[0].allowed,false)
     assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipelines[1],peer,id(999)])).rows[0].allowed,false)
    })
    await check('retained proof drift malformed policy duplicate bindings and missing historical reads fail closed without persistent writes',async()=>{
     const original=(await query("SELECT command FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[transitionId])).rows[0].command
     const changes=[
      command=>{command.generationTo++},
      command=>{command.bindings[1].after.workspace_id=foreign},
      command=>{command.bindings.push(command.bindings[1])},
      command=>{command.bindings[1].after.capability_policy_json='{malformed'},
      command=>{const policy=JSON.parse(command.bindings[1].after.capability_policy_json);policy.futureCreate.list=[];command.bindings[1].after.capability_policy_json=JSON.stringify(policy)},
      command=>{command.capabilities.find(row=>row.pipelineId===pipelines[1]).after.export=[]},
      command=>{command.capabilities.find(row=>row.pipelineId===pipelines[1]).after.view={[nativeId]:true}},
     ]
     for(const mutate of changes){const c=await pool.connect();try{
      await c.query('BEGIN');await c.query('ALTER TABLE crm_native_email_authority_phases DISABLE TRIGGER crm_native_authority_phase_immutable')
      const command=JSON.parse(JSON.stringify(original));mutate(command)
      await c.query("UPDATE crm_native_email_authority_phases SET command=$2::jsonb WHERE transition_id=$1 AND phase='grant'",[transitionId,JSON.stringify(command)])
      assert.equal((await c.query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipelines[1],peer,nativeId])).rows[0].allowed,false)
      assert.equal((await c.query('SELECT count(*)::int AS n FROM clawpilot_crm_root_read_workspaces($1) WHERE workspace_id=$2',[employee,peer])).rows[0].n,0)
     }finally{await c.query('ROLLBACK');c.release()}}
     assert.deepEqual((await query("SELECT command FROM crm_native_email_authority_phases WHERE transition_id=$1 AND phase='grant'",[transitionId])).rows[0].command,original)
     assert.equal((await query('SELECT clawpilot_crm_root_native_pipeline_read($1,$2,$3) AS allowed',[pipelines[1],peer,nativeId])).rows[0].allowed,true)
    })
   }})
 })
 await check('actual native permission snapshots include root readers without inventing a target membership or editor role',async()=>{
  await query("UPDATE app_users SET reference_code=COALESCE(reference_code,allocate_crm_reference('gu')),crm_user_enabled=true WHERE email=ANY($1::text[])",[[owner,employee]])
  await query('UPDATE app_users SET suitecrm_user_id=CASE WHEN email=$1 THEN $3 ELSE $4 END,suitecrm_username=reference_code,organization_id=$5 WHERE email=ANY($2::text[])',
   [owner,[owner,employee],id(901),id(902),root])
  await query('UPDATE crm_root_employee_access_grants SET enabled=true,revision=revision+1 WHERE id=$1',[grant])
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true}' WHERE user_email=$1 AND organization_id=$2`,[employee,peer])
  // Temporarily remove only the fixture's target membership. The real root FK
  // and grant source stay present, exactly like a computed peer workspace.
  await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])
  const store=new nativeAdapter.PostgresNativeEmailAuthorityTransitionStore(tx,{actorEmail:owner,actorWorkspaceId:root,
   approvalIdentity:{keyId:'root-test',nativeInstanceId:'root-native',serviceUserId:id(903),oauthClientId:id(904)}})
  const added={pipeline_id:id(20),user_email:employee,access_role:'editor',shared_by:owner,
   created_at:'2026-10-30T12:00:00+00:00',updated_at:'2026-10-30T12:00:00+00:00'}
  const before=await effects(),preview=await store.previewMemberChange({kind:'pipeline_members_v1',changes:[{before:null,after:added}]},[id(20),id(21)])
  for(const scope of preview.snapshots.before.pipelines){
   assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
   assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(scope).map(v=>v.suitecrm_user_id),[id(901)])
   assert.equal(scope.rootReaders.length,1);assert.equal(scope.rootReaders[0].allowed,true)
  }
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(preview.snapshots.after.pipelines[0]).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
  assert.equal(preview.snapshots.after.pipelines[1].principals.some(v=>v.email===employee),false,'No fabricated peer membership/principal')
  const publicationAudience=()=>tx(c=>publicationAudienceModule.exports.reviewedEmailAudienceUnderNativeControlWithClient(c,id(21)))
  assert.deepEqual((await publicationAudience()).allowedSuiteCrmUserIds,[id(901),id(902)])
  assert.deepEqual(await effects(),before)
  // A latent/stale manual editor intent in the unjoined target still must not
  // promote the inherited viewer, and cannot be resaved as an active share.
  await query('INSERT INTO pipeline_space_members(pipeline_id,user_email,access_role,shared_by,created_at,updated_at) VALUES($1,$2,\'editor\',$3,$4,$4)',
   [id(21),employee,owner,'2026-10-30T12:00:00Z'])
  const retained=(await query('SELECT to_jsonb(m) AS value FROM pipeline_space_members m WHERE pipeline_id=$1 AND user_email=$2',[id(21),employee])).rows[0].value
  const removal=await store.previewMemberChange({kind:'pipeline_members_v1',changes:[{before:retained,after:null}]},[id(20),id(21)])
  const peerScope=removal.snapshots.before.pipelines[1]
  assert.deepEqual(eligibility.nativeEmailManualPipelinePrincipals(peerScope).map(v=>v.suitecrm_user_id),[id(901)])
  assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(peerScope).map(v=>v.suitecrm_user_id).sort(),[id(901),id(902)])
  assert.deepEqual((await publicationAudience()).allowedSuiteCrmUserIds,[id(901),id(902)],'Stale editor intent is not needed to retain root reading')
  await assert.rejects(store.previewMemberChange({kind:'pipeline_members_v1',changes:[{before:retained,after:{...retained,access_role:'viewer',updated_at:'2026-10-30T12:01:00+00:00'}}]},[id(20),id(21)]),e=>e.code==='authority_member_workspace_missing')
  await query('DELETE FROM pipeline_space_members WHERE pipeline_id=$1 AND user_email=$2',[id(21),employee])
  await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
   VALUES($1,$2,'member','active','{"viewCrm":true}',$3,$3)`,[employee,peer,owner])
  const lifecycle=await store.previewWorkspaceUserEligibility({workspaceId:root,userEmail:employee,action:{kind:'access',role:'member',permissions:{viewCrm:false}}},[id(20),id(21)])
  assert.equal(JSON.parse(lifecycle.desiredAppChange.appUser.afterJson).status,'active','A real peer membership keeps the identity active')
  for(const scope of lifecycle.snapshots.before.pipelines)assert.equal(scope.rootReaders[0].allowed,true)
  for(const scope of lifecycle.snapshots.after.pipelines){
   assert.equal(scope.rootReaders[0].allowed,false)
   assert.deepEqual(eligibility.nativeEmailEffectivePipelinePrincipals(scope).map(v=>v.suitecrm_user_id),[id(901)])
  }
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  assert.deepEqual((await publicationAudience()).allowedSuiteCrmUserIds,[id(901)],'New Email publication uses the same source-root denial as the lifecycle snapshot')
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true}' WHERE user_email=$1 AND organization_id=$2`,[employee,root])
  await query('UPDATE crm_root_employee_access_grants SET enabled=false,revision=revision+1 WHERE id=$1',[grant])
  await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":false}' WHERE user_email=$1 AND organization_id=$2`,[employee,peer])
  // Keep the fixture's issued employee/native identities permanent too.
 })
 await check('root native source fences close unshared-target denial owner-demotion and topology bypasses without blocking independent settings',async()=>{
  await query('UPDATE crm_root_employee_access_grants SET enabled=true,revision=revision+1 WHERE id=$1',[grant])
  await query('DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])
  const setMode=async enabled=>{
   await query('ALTER TABLE crm_native_email_publication_control DISABLE TRIGGER crm_native_email_control_guard')
   try{await query(`UPDATE crm_native_email_publication_control SET enabled=$1,
    verified_generation=CASE WHEN $1 THEN generation ELSE NULL END,
    native_policy_fingerprint=CASE WHEN $1 THEN repeat('1',64) ELSE NULL END,
    activation_receipt_hash=CASE WHEN $1 THEN repeat('2',64) ELSE NULL END`,[enabled])}
   finally{await query('ALTER TABLE crm_native_email_publication_control ENABLE TRIGGER crm_native_email_control_guard')}
  }
  await setMode(true)
  try{
   // No manual share exists here. Migration 0391 alone would call this an
   // independent enrollment, despite revoking an inherited native reader.
   await assert.rejects(query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'member','active','{"viewCrm":false}',$3,$3)`,[employee,peer,owner]),e=>e.code==='55000'&&/Root CRM source/.test(e.message))
   assert.equal((await query('SELECT count(*)::int AS n FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])).rows[0].n,0)
   // Identity/reader scope is unchanged by adding a real allowed target row.
   await query(`INSERT INTO app_user_organization_memberships(user_email,organization_id,role,status,permissions,created_by,updated_by)
    VALUES($1,$2,'member','active','{"viewCrm":true}',$3,$3)`,[employee,peer,owner])
   await query(`UPDATE app_user_organization_memberships SET permissions='{"viewCrm":true,"viewProjects":false,"viewAccounting":false}'
    WHERE user_email=$1 AND organization_id=$2`,[employee,peer])
   await query(`UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1 AND organization_id=$2`,[employee,peer])
   for(const [sql,args]of[
    ["UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email=$1 AND organization_id=$2",[employee,root]],
    ["UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1 AND organization_id=$2",[owner,root]],
    ["UPDATE app_user_organization_memberships SET role='member' WHERE user_email=$1 AND organization_id=$2",[owner,peer]],
    ['DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer]],
    ["UPDATE workspace_organizations SET organization_type='member' WHERE id=$1",[root]],
    ['UPDATE workspace_organizations SET parent_id=$2 WHERE id=$1',[root,foreign]],
    ['UPDATE workspace_organizations SET is_demo=true WHERE id=$1',[peer]],
   ])await assert.rejects(query(sql,args),e=>e.code==='55000'&&/Root CRM source/.test(e.message))
   assert.deepEqual((await tx(c=>publicationAudienceModule.exports.reviewedEmailAudienceUnderNativeControlWithClient(c,id(21)))).allowedSuiteCrmUserIds,[id(901),id(902)])
   await query("UPDATE workspace_organizations SET name='Independent display update' WHERE id=$1",[root])
   const locker=await pool.connect()
   try{
    await locker.query('BEGIN');await locker.query('SELECT singleton FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    for(const [sql,args]of[
     ["UPDATE workspace_organizations SET organization_type='root' WHERE id=$1",[root]],
     ["UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email=$1 AND organization_id=$2",[employee,root]],
    ])await assert.rejects(tx(async waiter=>{await waiter.query("SET LOCAL lock_timeout='100ms'");await waiter.query(sql,args)}),
     e=>e.code==='55P03','Source statements must wait on control before acquiring source row locks')
   }finally{await locker.query('ROLLBACK');locker.release()}
  }finally{await setMode(false)}
  await query('UPDATE crm_root_employee_access_grants SET enabled=false,revision=revision+1 WHERE id=$1',[grant])
  await query(`UPDATE app_user_organization_memberships SET role='member',permissions='{"viewCrm":false}' WHERE user_email=$1 AND organization_id=$2`,[employee,peer])
 })
 await check('enabled native policy rejects every raw registry mutation without an exact native-first plan',async()=>{
  // Synthetic activation exists only in this owned throwaway database. No
  // native permission is installed or represented as accepted by this test.
  await query('ALTER TABLE crm_native_email_publication_control DISABLE TRIGGER crm_native_email_control_guard')
  try{await query("UPDATE crm_native_email_publication_control SET enabled=true,verified_generation=generation,native_policy_fingerprint=repeat('1',64),activation_receipt_hash=repeat('2',64)")}
  finally{await query('ALTER TABLE crm_native_email_publication_control ENABLE TRIGGER crm_native_email_control_guard')}
  for(const [table,key,value]of [['crm_operator_accounts','id',account],['crm_operator_workspace_bindings','operator_account_id',account],['crm_root_employee_access_grants','id',grant]])
   await assert.rejects(query(`UPDATE ${table} SET enabled=NOT enabled,revision=revision+1 WHERE ${key}=$1`,[value]),e=>e.code==='55000')
  assert.equal((await inspect()).scope.enabled,false)
  assert.deepEqual((await query('SELECT * FROM clawpilot_crm_root_read_workspaces($1)',[employee])).rows,[])
 })
 // Reset only this disposable synthetic flag before the new full-store test
 // constructs an independently pinned initial policy; no provider is touched.
 await query('ALTER TABLE crm_native_email_publication_control DISABLE TRIGGER crm_native_email_control_guard')
 try{await query('UPDATE crm_native_email_publication_control SET enabled=false,verified_generation=NULL,native_policy_fingerprint=NULL,activation_receipt_hash=NULL')}
 finally{await query('ALTER TABLE crm_native_email_publication_control ENABLE TRIGGER crm_native_email_control_guard')}
 const {runRootRegistryAcceptance}=await import('./test-native-email-root-registry-postgres.mjs')
 await runRootRegistryAcceptance({load,protocol,eligibility,userEligibility,nativeProjection,capability,transition,nativeAdapter,
  query,tx,id,root,peer,child,owner,employee,check})
 console.log(`PASS ${groups} actual PostgreSQL ${postgresMajor} root registry/session/resource groups; no native ACL/browser/production proof`)
}finally{await pool?.end();if(started)execFileSync('docker',disposablePostgresDockerCleanupArgs(container),{stdio:'pipe',timeout:30000})}
