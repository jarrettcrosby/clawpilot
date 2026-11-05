// Called by the guarded full-migration root-access PostgreSQL runner. All
// changes here are owned fixture setup or rollback-only adversarial probes.
// The preview client itself rejects any SQL write, including temp tables.
import assert from 'node:assert/strict'

export async function testRootRegistryPreview(context, stage){
 const {load,protocol,collector,authority,query,tx,id,root,peer,foreign,demo,account,grant,owner,employee,admin,check,effects}=context
 const contract=load('app_src/lib/crm/rootEmployeeCrmRegistryChange.ts',{'./nativeEmailPublication':protocol})
 const previewModule=load('app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts',{
  '../crm/nativeEmailPublication':protocol,'../crm/rootEmployeeCrmRegistryChange':contract,
  './crmNativeEmailAuthority':authority,'./crmRootEmployeeAccess':collector})
 const collect=previewModule.collectRootEmployeeCrmRegistryPreviewWithClient,json=protocol.nativeEmailCanonicalJson
 const accountRow={id:account,root_workspace_id:root,owner_email:owner,enabled:true,revision:'1'}
 const binding=workspace=>({operator_account_id:account,workspace_id:workspace,owner_email:owner,enabled:true,revision:'1'})
 const grantRow={id:grant,operator_account_id:account,user_email:employee,source_workspace_id:root,enabled:true,revision:'1'}
 const delta=(table,row)=>({table,beforeJson:null,afterJson:json(row)})
 const initial={kind:'root_registry_v1',workspaceId:root,operatorAccountId:account,ownerEmail:owner,
  actorScope:{workspaceId:root,ancestryJson:json([{id:root,parent_id:null,is_demo:false}])},contextFingerprint:'a'.repeat(64),
  changes:[delta('account',accountRow),delta('binding',binding(root)),delta('binding',binding(peer)),delta('grant',grantRow)]}
 const copy=value=>JSON.parse(JSON.stringify(value)),args=change=>({actorEmail:owner,actorWorkspaceId:root,change,
  pipelineIds:[id(20),id(21)],current:'before'})
 const readOnly=c=>({query(sql,values){assert.match(sql.trim(),/^(SELECT|WITH)\b/iu,'Preview cannot issue a write');return c.query(sql,values)}})
 const preview=input=>tx(c=>collect(readOnly(c),input))
 const state=async()=>({effects:await effects(),control:(await query('SELECT to_jsonb(c) AS row FROM crm_native_email_publication_control c')).rows,
  accounts:(await query('SELECT to_jsonb(a) AS row FROM crm_operator_accounts a ORDER BY id')).rows,
  bindings:(await query('SELECT to_jsonb(b) AS row FROM crm_operator_workspace_bindings b ORDER BY operator_account_id,workspace_id')).rows,
  grants:(await query('SELECT to_jsonb(g) AS row FROM crm_root_employee_access_grants g ORDER BY id')).rows})
 if(stage==='empty'){
  await check('registry preview derives new account/bindings/employee from real sources with no temporary permission writes',async()=>{
   const before=await state(),result=await preview(args(initial))
   assert.equal(result.before.length,1);assert.equal(result.after.length,1)
   assert.deepEqual(result.before[0].source.targets,[])
   assert.equal(result.before[0].source.anchor.enabled,false);assert.equal(result.before[0].source.grant.enabled,false)
   assert.equal(result.after[0].source.anchor.enabled,true);assert.equal(result.after[0].source.grant.enabled,true)
   assert.deepEqual(result.after[0].source.targets.map(t=>t.workspaceId),[root,peer])
   assert.equal(result.after[0].source.targets[1].employeeMembership,null,'No invented business membership')
   assert.match(result.contextFingerprint,/^[a-f0-9]{64}$/u)
   assert.deepEqual(await state(),before)
   assert.equal((await query('SELECT count(*)::int AS n FROM clawpilot_crm_root_read_workspaces($1)',[employee])).rows[0].n,0)
  })
  await check('registry preview refuses wrong actor, default workspace, missing pipeline coverage, stale phase and foreign/demo targets',async()=>{
   const before=await state()
   for(const altered of [{...args(initial),actorEmail:admin},{...args(initial),actorWorkspaceId:peer},
    {...args(initial),pipelineIds:[id(20)]},{...args(initial),current:'after'}])await assert.rejects(preview(altered))
   for(const workspace of [foreign,demo]){
    const change=copy(initial);change.changes.splice(3,0,delta('binding',binding(workspace)))
    await assert.rejects(preview(args(change)),e=>e.code==='root_registry_target_not_owned')
   }
   const missing=copy(initial),row=JSON.parse(missing.changes[3].afterJson)
   row.user_email='not.a.root.employee@example.invalid';missing.changes[3].afterJson=json(row)
   await assert.rejects(preview(args(missing)),e=>e.code==='root_employee_grant_missing')
   assert.deepEqual(await state(),before)
  })
  await check('registry preview retains real employee denial and owner authority in its source evidence',async()=>{
   const baseline=await preview(args(initial))
   await assert.rejects(tx(async c=>{
    await c.query("UPDATE app_user_organization_memberships SET permissions='{\"viewCrm\":false}' WHERE user_email=$1 AND organization_id=$2",[employee,root])
    const result=await collect(readOnly(c),args(initial))
    assert.equal(result.after[0].source.sourceMembership.viewCrm,false)
    assert.notEqual(result.contextFingerprint,baseline.contextFingerprint)
    throw Error('rollback-root-denial')
   }),/rollback-root-denial/u)
   await assert.rejects(tx(async c=>{
    await c.query("UPDATE app_user_organization_memberships SET role='admin' WHERE user_email=$1 AND organization_id=$2",[owner,root])
    await collect(readOnly(c),args(initial))
   }),e=>e.code==='root_registry_actor_denied')
   assert.equal((await preview(args(initial))).contextFingerprint,baseline.contextFingerprint)
  })
 }else{
  await check('existing registry proposal matches the ordinary locked source, and after-stage replay preserves its exact context',async()=>{
   const change=copy(initial);change.changes=[{table:'binding',beforeJson:json(binding(peer)),
    afterJson:json({...binding(peer),enabled:false,revision:'2'})}]
   const result=await preview(args(change)),ordinary=await tx(c=>collector.collectRootEmployeeCrmAccessWithClient(c,{actorEmail:owner,grantId:grant,nativePipelineIds:[id(20),id(21)]}))
   assert.deepEqual(result.before[0],{source:ordinary.source,registryHash:ordinary.registryHash})
   assert.deepEqual(result.after[0].source.targets.map(t=>t.workspaceId),[root])
   const baseline=await state()
   await assert.rejects(tx(async c=>{
    await c.query('UPDATE crm_operator_workspace_bindings SET enabled=false,revision=revision+1 WHERE operator_account_id=$1 AND workspace_id=$2',[account,peer])
    const resumed=await collect(readOnly(c),{...args(change),current:'after'})
    assert.deepEqual(resumed,result,'A native phase/generation advance does not alter this immutable before/after source')
    await assert.rejects(collect(readOnly(c),args(change)),e=>e.code==='root_registry_preimage_changed')
    throw Error('rollback-registry-after')
   }),/rollback-registry-after/u)
   assert.deepEqual(await state(),baseline)
  })
  await check('adding a second root employee retains all existing intent and denies default-organization inference',async()=>{
   const next={...grantRow,id:id(12),user_email:admin},change=copy(initial)
   change.changes=[delta('grant',next)]
   const before=await state(),result=await preview(args(change))
   assert.deepEqual(result.before.map(r=>r.source.user.email),[employee,admin])
   assert.equal(result.before[0].source.grant.enabled,true);assert.equal(result.before[1].source.grant.enabled,false)
   assert.equal(result.after[1].source.grant.enabled,true)
   assert.deepEqual(result.after[1].source.targets.map(t=>t.workspaceId),[root,peer])
   assert.deepEqual(await state(),before)
   await assert.rejects(tx(async c=>{
    await c.query('UPDATE app_users SET organization_id=$2 WHERE email=$1',[admin,foreign])
    assert.deepEqual(await collect(readOnly(c),args(change)),result,'A mutable default organization cannot change the immutable operator anchor')
    throw Error('rollback-default-org')
   }),/rollback-default-org/u)
  })
  await check('case-folded native identity collisions hold both current and proposed root source collection',async()=>{
   const change=copy(initial);change.changes=[{table:'grant',beforeJson:json(grantRow),afterJson:json({...grantRow,enabled:false,revision:'2'})}]
   await assert.rejects(tx(async c=>{
    await c.query("UPDATE app_users SET reference_code=allocate_crm_reference('gu'),crm_user_enabled=true WHERE email=ANY($1::text[])",[[employee,admin]])
    await c.query('UPDATE app_users SET suitecrm_user_id=$2,suitecrm_username=reference_code WHERE email=$1',[employee,'Fixture-Shared-Root-Id'])
    await c.query('UPDATE app_users SET suitecrm_user_id=$2,suitecrm_username=reference_code WHERE email=$1',[admin,'fixture-shared-root-id'])
    await assert.rejects(collector.collectRootEmployeeCrmAccessWithClient(c,{actorEmail:owner,grantId:grant}),
     e=>e.code==='root_employee_native_identity_ambiguous')
    await assert.rejects(collect(readOnly(c),args(change)),e=>e.code==='root_employee_native_identity_ambiguous')
    throw Error('rollback-native-alias')
   }),/rollback-native-alias/u)
  })
  await check('registry preview rejects a stale preimage or duplicate grant user rather than widening the enrolled scope',async()=>{
   const stale=copy(initial);stale.changes=[{table:'grant',beforeJson:json({...grantRow,revision:'2'}),afterJson:json({...grantRow,enabled:false,revision:'3'})}]
   await assert.rejects(preview(args(stale)),e=>e.code==='root_registry_preimage_changed')
   const duplicate=copy(initial);duplicate.changes=[delta('grant',{...grantRow,id:id(12)})]
   await assert.rejects(preview(args(duplicate)),e=>e.code==='root_registry_inventory_bound_or_duplicate')
  })
 }
}
