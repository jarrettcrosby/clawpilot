// Actual settings DAL and complete migrations in the caller's disposable PG.
// Native transport is an explicit test edge; this is not native ACL/UI proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'

export async function runRootCrmSettingsAcceptance({load,query,tx,protocol,authority,rootRegistry,coreRuntime,root,peer,foreign,child,demo,owner,employee,admin,check}){
 const contract=load('app_src/lib/crm/rootEmployeeCrmSettings.ts',{})
 const audit=load('app_src/lib/auditWriter.ts',{'next/headers':{headers:async()=>new Headers()},
  '@/lib/authAttribution':{verifyAuthAttributionHeaders:()=>null},'@/lib/persistence/postgres':{query}})
 const rollback=Symbol('rollback settings fixture')
 async function isolated(fn){
  try{await tx(async client=>{
   let serial=0,failAudit=false,nativeResult=true,nativeDispatchRead=false;const calls=[]
   const settingsClient={query:async(sql,args)=>{
    const result=await client.query(sql,args)
    if(nativeDispatchRead&&sql==='SELECT enabled,active_operation_id,active_transition_id FROM crm_native_email_publication_control WHERE singleton'){
     assert.equal(result.rows.length,1);assert.equal(result.rows[0].enabled,false)
     return {...result,rows:[{...result.rows[0],enabled:true}]}
    }
    return result
   }}
   const transaction=async callback=>{const key=`settings_${++serial}`;await client.query(`SAVEPOINT ${key}`)
    try{const result=await callback(settingsClient);await client.query(`RELEASE SAVEPOINT ${key}`);return result}
    catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${key}`);throw error}}
   const dal=load('app_src/lib/persistence/crmRootEmployeeSettings.ts',{
    'node:crypto':crypto,'./postgres':{withTransaction:transaction},'./crmNativeEmailAuthority':authority,
    '../auditWriter':{recordAuditEvent:async(...args)=>{if(failAudit)throw Error('fixture audit unavailable');return audit.recordAuditEvent(...args)}},
    '../crm/nativeEmailPublication':protocol,'../crm/rootEmployeeCrmRegistryChange':rootRegistry,
    '../crm/rootEmployeeCrmSettings':contract,'../crm/nativeEmailAuthorityRuntime':coreRuntime,
    '../crm/nativeEmailRootRegistryRuntime':{
     getPendingRootEmployeeCrmRegistryChange:async()=>null,
     resumeRootEmployeeCrmRegistryChange:async(...args)=>{calls.push(['resume',...args])},
     changeRootEmployeeCrmRegistryWithNativeAuthority:async(...args)=>{calls.push(['change',...args]);return nativeResult},
    }})
   const read=()=>dal.readRootEmployeeCrmSettings(owner,root)
   const configure=async(workspaceIds=[root,peer],enabled=true)=>dal.changeRootEmployeeCrmSettings(owner,root,
    {action:'configure',enabled,workspaceIds,registryVersion:(await read()).registryVersion})
   await fn({client,dal,read,configure,calls,setFailAudit:value=>{failAudit=value},setNativeResult:value=>{nativeResult=value},
    setNativeDispatchRead:value=>{nativeDispatchRead=value}})
   throw rollback
  })}catch(error){if(error!==rollback)throw error}
 }
 await check('owner settings derive safe business choices from actual root ownership, not global role or body IDs',()=>isolated(async({dal,read,calls})=>{
  const state=await read();assert.equal(state.configured,false);assert.equal(state.enabled,false)
  assert.ok(state.workspaces.some(row=>row.id===root&&row.available));assert.ok(state.workspaces.some(row=>row.id===peer&&row.available))
  assert.ok(!state.workspaces.some(row=>[foreign,demo].includes(row.id)))
  assert.deepEqual(Object.keys(state).sort(),['configured','employees','enabled','pending','registryVersion','workspaceId','workspaceName','workspaces'])
  for(const [actor,workspace]of [[employee,root],[admin,root],[owner,foreign],[owner,child],[owner,demo]])
   await assert.rejects(dal.readRootEmployeeCrmSettings(actor,workspace),error=>error.status===403)
  assert.equal(calls.length,0)
 }))
 await check('normal settings setup, employee enrollment and soft disable retain identities and independent memberships',()=>isolated(async({client,dal,read,configure,calls})=>{
  const before=(await client.query('SELECT * FROM app_user_organization_memberships ORDER BY user_email,organization_id')).rows
  await configure();let state=await read();assert.equal(state.configured,true);assert.equal(state.enabled,true)
  assert.deepEqual(state.workspaces.filter(row=>row.selected).map(row=>row.id).sort(),[root,peer].sort())
  await dal.changeRootEmployeeCrmSettings(owner,root,{action:'employee',userEmail:employee,enabled:true,registryVersion:state.registryVersion})
  state=await read();assert.equal(state.employees.find(row=>row.email===employee).enabled,true)
  const saved=(await client.query('SELECT id,revision::text FROM crm_root_employee_access_grants WHERE user_email=$1',[employee])).rows[0]
  await dal.changeRootEmployeeCrmSettings(owner,root,{action:'employee',userEmail:employee,enabled:false,registryVersion:state.registryVersion})
  const disabled=(await client.query('SELECT id,revision::text,enabled FROM crm_root_employee_access_grants WHERE user_email=$1',[employee])).rows[0]
  assert.equal(disabled.id,saved.id);assert.equal(BigInt(disabled.revision),BigInt(saved.revision)+1n);assert.equal(disabled.enabled,false)
  await configure([root],false);state=await read();assert.equal(state.enabled,false)
  assert.equal((await client.query('SELECT count(*)::int AS n FROM crm_operator_workspace_bindings')).rows[0].n,2)
  assert.deepEqual((await client.query('SELECT * FROM app_user_organization_memberships ORDER BY user_email,organization_id')).rows,before)
  assert.equal((await client.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='crm.root_access.changed'")).rows[0].n,4)
  assert.equal(calls.length,0)
 }))
 await check('stale forms, foreign businesses, owner self grants and unknown employees cannot change the registry',()=>isolated(async({dal,read,configure,client})=>{
  const original=await read();await configure();const state=await read()
  await assert.rejects(dal.changeRootEmployeeCrmSettings(owner,root,{action:'configure',enabled:false,workspaceIds:[root],registryVersion:original.registryVersion}),e=>e.code==='ROOT_CRM_SETTINGS_STALE')
  for(const workspaceIds of [[peer],[root,foreign],[root,demo]])await assert.rejects(dal.changeRootEmployeeCrmSettings(owner,root,
   {action:'configure',enabled:true,workspaceIds,registryVersion:state.registryVersion}),e=>e.status===403)
  for(const userEmail of [owner,'absent@example.invalid'])await assert.rejects(dal.changeRootEmployeeCrmSettings(owner,root,
   {action:'employee',enabled:true,userEmail,registryVersion:state.registryVersion}),e=>e.status===403)
  assert.equal((await read()).registryVersion,state.registryVersion)
  assert.equal((await client.query('SELECT count(*)::int AS n FROM crm_root_employee_access_grants')).rows[0].n,0)
 }))
 await check('an audit failure rolls back normal settings setup and exact subsequent updates',()=>isolated(async({client,configure,read,setFailAudit})=>{
  setFailAudit(true);await assert.rejects(configure(),/audit unavailable/)
  assert.equal((await read()).configured,false)
  assert.equal((await client.query('SELECT count(*)::int AS n FROM crm_operator_workspace_bindings')).rows[0].n,0)
  setFailAudit(false);await configure();const before=await read()
  setFailAudit(true);await assert.rejects(configure([root],false),/audit unavailable/)
  assert.equal((await read()).registryVersion,before.registryVersion)
 }))
 await check('settings metadata reflects global suspension and keeps native identities and private grants out of the DTO',()=>isolated(async({client,read})=>{
  await client.query("UPDATE app_users SET status='disabled' WHERE email=$1",[employee])
  const state=await read(),row=state.employees.find(item=>item.email===employee)
  assert.equal(row.status,'disabled');assert.deepEqual(Object.keys(row).sort(),['crmAllowed','displayName','email','enabled','status'])
 }))
 await check('native-enabled settings dispatch exact server-derived intent without legacy writes or fallback',()=>isolated(async({client,read,configure,calls,setNativeResult,setNativeDispatchRead})=>{
  // Only the already-mocked coordinator dispatch is synthetic. Do not invent
  // activation evidence or turn off a database guard to select this branch.
  const before=(await client.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows
  const guards=(await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='crm_native_email_publication_control'::regclass AND NOT tgisinternal ORDER BY tgname")).rows
  assert.equal(before[0].enabled,false);assert.ok(guards.every(row=>row.tgenabled==='O'))
  for(const name of ['crm_native_email_control_guard','crm_native_initial_control_guard'])assert.ok(guards.some(row=>row.tgname===name&&row.tgenabled==='O'))
  setNativeDispatchRead(true)
  await configure();assert.equal(calls.length,1)
  const [kind,actor,workspace,change]=calls[0];assert.equal(kind,'change');assert.equal(actor,owner);assert.equal(workspace,root)
  assert.equal(change.kind,'root_registry_v1');assert.equal(change.changes.length,3)
  assert.equal((await read()).configured,false,'Mock native transport does not execute app changes')
  setNativeResult(false);await assert.rejects(configure(),error=>error instanceof coreRuntime.NativeEmailAccessPendingError)
  assert.equal((await read()).configured,false,'A policy race never falls back to an unaudited legacy write')
  assert.deepEqual((await client.query('SELECT * FROM crm_native_email_publication_control WHERE singleton')).rows,before)
  assert.deepEqual((await client.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='crm_native_email_publication_control'::regclass AND NOT tgisinternal ORDER BY tgname")).rows,guards)
 }))
 await check('normal Resume accepts only its saved transition and rechecks source ownership',()=>isolated(async({dal,calls})=>{
  const request={action:'resume',transitionId:'a'.repeat(64)}
  await dal.changeRootEmployeeCrmSettings(owner,root,request)
  assert.deepEqual(calls,[['resume',owner,root,request.transitionId]])
  await assert.rejects(dal.changeRootEmployeeCrmSettings(employee,root,request),error=>error.status===403)
  assert.equal(calls.length,1)
 }))
}
