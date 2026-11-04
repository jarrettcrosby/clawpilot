// Actual normal user library, real workspace-user runtime disabled/native-ID
// decision and full SQL guards. Initial native evidence is synthetic; no provider.
import assert from 'node:assert/strict'

export async function runRootAppOnlyLifecycleAcceptance({users,query,inspect,owner,employee,root,peer,grant,check,enrollInitial}){
 assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[employee])).rows[0].suitecrm_user_id,null)
 await query('UPDATE crm_root_employee_access_grants SET enabled=true,revision=revision+1 WHERE id=$1',[grant])
 const actor={...await users.requireActiveAppUser(owner),organizationId:root,organizationRole:'owner',organizationPermissions:users.OWNER_PERMISSIONS}
 await enrollInitial()
  await check('normal app-only root employee module edits work under idle native policy and preserve explicit target denial',async()=>{
   const original=(await query('SELECT generation::text FROM crm_native_email_publication_control')).rows[0].generation
   await users.updateAppUserAccess({actorEmail:actor,email:employee,organizationId:root,role:'member',permissions:{...users.MEMBER_PERMISSIONS,viewCrm:false}})
   assert.equal((await inspect()).scope.enabled,false)
   await users.updateAppUserAccess({actorEmail:actor,email:employee,organizationId:root,role:'member',permissions:{...users.MEMBER_PERMISSIONS,viewCrm:true}})
   const source=await inspect();assert.equal(source.scope.enabled,true)
   assert.ok(!source.scope.edges.some(row=>row.workspaceId===peer),'An existing denied target must remain denied')
   assert.equal((await query('SELECT generation::text FROM crm_native_email_publication_control')).rows[0].generation,original,
    'No native principal or native policy changed')
  })
  await check('normal app-only root employee disable/restore changes the selected source, not independent membership access',async()=>{
   const independent=(await query('SELECT status,permissions FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])).rows
   await users.setAppUserStatus({actorEmail:actor,email:employee,organizationId:root,status:'disabled'})
   assert.equal((await inspect()).scope.enabled,false)
   await users.setAppUserStatus({actorEmail:actor,email:employee,organizationId:root,status:'active'})
   assert.equal((await inspect()).scope.enabled,true)
   assert.deepEqual((await query('SELECT status,permissions FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[employee,peer])).rows,independent)
  })
  await check('normal app-only root employee trash/restore preserves registry history and restores its source eligibility',async()=>{
   await users.setAppUserTrashed({actorEmail:actor,email:employee,organizationId:root,trashed:true})
   assert.equal((await inspect()).scope.enabled,false)
   await users.setAppUserTrashed({actorEmail:actor,email:employee,organizationId:root,trashed:false})
   assert.equal((await inspect()).scope.enabled,true)
   assert.equal((await query('SELECT enabled FROM crm_root_employee_access_grants WHERE id=$1',[grant])).rows[0].enabled,true)
  })
  await check('app-only exception never permits operator demotion or an absent/rebound source image',async()=>{
   const ownerRows=(await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m WHERE user_email=$1 ORDER BY organization_id',[owner])).rows
   for(const sql of [
    "UPDATE app_user_organization_memberships SET role='member' WHERE user_email=$1 AND organization_id=$2",
    "UPDATE app_user_organization_memberships SET status='disabled' WHERE user_email=$1 AND organization_id=$2",
    "UPDATE app_user_organization_memberships SET trashed_at=now(),trashed_by=$1,pre_trash_status='active' WHERE user_email=$1 AND organization_id=$2",
    'DELETE FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',
   ])for(const workspace of [root,peer])await assert.rejects(query(sql,[owner,workspace]),e=>e.code==='55000')
   assert.deepEqual((await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m WHERE user_email=$1 ORDER BY organization_id',[owner])).rows,ownerRows)
   await query("UPDATE app_user_organization_memberships SET permissions=permissions||'{\"viewProjects\":false}',updated_at=clock_timestamp() WHERE user_email=$1 AND organization_id=$2",[owner,root])
   assert.equal((await query('SELECT permissions FROM app_user_organization_memberships WHERE user_email=$1 AND organization_id=$2',[owner,root])).rows[0].permissions.viewProjects,false)
   const image=(await query('SELECT to_jsonb(m) AS row FROM app_user_organization_memberships m WHERE user_email=$1 AND organization_id=$2',[employee,root])).rows[0].row
   for(const before of [null,{...image,user_email:owner},{...image,organization_id:peer}])assert.equal((await query(
    'SELECT clawpilot_crm_root_app_only_membership_is_independent($1::jsonb,$2::jsonb) AS allowed',[JSON.stringify(before),JSON.stringify(image)])).rows[0].allowed,false)
  })
 // The owned database clone retains committed evidence until disposal. The
 // app-only employee never acquires a native identity during these workflows.
 assert.equal((await query('SELECT suitecrm_user_id FROM app_users WHERE email=$1',[employee])).rows[0].suitecrm_user_id,null)
 assert.equal((await query('SELECT enabled FROM crm_native_email_publication_control')).rows[0].enabled,true)
}
