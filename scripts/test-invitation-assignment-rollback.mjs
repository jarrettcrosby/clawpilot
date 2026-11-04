#!/usr/bin/env node
// Actual invitation/rollback functions with bounded mocked SQL. The equality
// model below tests call boundaries and selection; real PostgreSQL is separate.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const path='app_src/lib/users.ts',source=readFileSync(new URL('../'+path,import.meta.url),'utf8')
const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true)
const functions=['inviteAppUser','restoreInvitedUserAssignment','restoreInvitedUserAssignments']
const extracted=functions.map(name=>ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast)).join('\n')
function actual(deps){const module={exports:{}},names=Object.keys(deps)
  const code=ts.transpileModule(extracted,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports',...names,code)(module,module.exports,...names.map(name=>deps[name]));return module.exports}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,email='recipient@example.test'
const clone=value=>JSON.parse(JSON.stringify(value)),equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const producedUser={email,status:'invited',invited_by:'sender@example.test',updated_at:'2026-10-30T12:00:00Z',suitecrm_user_id:null}
const producedMember=n=>({user_email:email,organization_id:id(n),role:'member',status:'invited',permissions:{viewCrm:true},
  is_default:n===1,trashed_at:null,trashed_by:null,pre_trash_status:null,updated_at:'2026-10-30T12:00:00Z'})
const old={role:'admin',permissions:{viewCrm:false},status:'invited',isDefault:false}
function harness({user=producedUser,members=[producedMember(1)]}={}){
  const state={user:clone(user),members:new Map(members.map(row=>[row.organization_id,clone(row)]))},log=[]
  const tx={query:async(sql,values)=>{
    if(sql.startsWith('SELECT email FROM app_users')){assert.match(sql,/FOR UPDATE/);log.push('user-lock');return{rows:state.user?[{email}]:[]}}
    if(sql.startsWith('SELECT organization_id FROM app_user_organization_memberships')){
      assert.match(sql,/ORDER BY organization_id FOR UPDATE/);assert.deepEqual(values[1],[...values[1]].sort());log.push('member-lock');return{rows:[]}}
    if(sql.startsWith('UPDATE app_user_organization_memberships AS membership')){
      assert.match(sql,/to_jsonb\(membership\) = \$7::jsonb/);log.push('member-restore')
      const row=state.members.get(values[1]);if(row&&equal(row,JSON.parse(values[6])))state.members.set(values[1],{...row,
        role:values[2],permissions:JSON.parse(values[3]),status:values[4],is_default:values[5],updated_at:'rollback'})
      return{rows:[]}}
    if(sql.startsWith('DELETE FROM app_user_organization_memberships AS membership')){
      assert.match(sql,/to_jsonb\(membership\) = \$3::jsonb/);log.push('member-delete')
      const row=state.members.get(values[1]);if(row&&equal(row,JSON.parse(values[2])))state.members.delete(values[1]);return{rows:[]}}
    if(sql.startsWith('UPDATE app_users AS app_user')){
      assert.match(sql,/to_jsonb\(app_user\) = \$3::jsonb/);log.push('user-restore')
      if(state.user&&equal(state.user,JSON.parse(values[2])))state.user={...state.user,invited_by:values[1],updated_at:'rollback'}
      return{rows:[]}}
    assert.fail('Unexpected rollback SQL')
  }}
  const api=actual({normalizeUserEmail:String,withTransaction:async fn=>fn(tx),
    lockCrmNativeEmailAuthorityWithClient:async client=>{assert.equal(client,tx);log.push('control-lock')}})
  return{state,log,api}
}
const input=()=>({email,invitedBy:'old@example.test',producedUserRowJson:JSON.stringify(producedUser),memberships:[{
  organizationId:id(1),previousMembership:old,producedMembershipRowJson:JSON.stringify(producedMember(1))}]})
let count=0
async function check(name,fn){await fn();count++;console.log('PASS '+name)}
await check('unchanged invitation-produced rows restore only after control, user and sorted member locks',async()=>{
  const h=harness();await h.api.restoreInvitedUserAssignments(input())
  assert.deepEqual(h.log.slice(0,3),['control-lock','user-lock','member-lock'])
  assert.equal(h.state.members.get(id(1)).role,'admin');assert.equal(h.state.user.invited_by,'old@example.test')
})
await check('intervening trash disable access and metadata edits cannot be overwritten by delivery failure',async()=>{
  for(const edit of [{status:'disabled',trashed_at:'2026-10-30T13:00:00Z',trashed_by:'admin@example.test',pre_trash_status:'invited'},
    {status:'disabled'},{permissions:{viewCrm:false}},{updated_at:'2026-10-30T13:00:00Z'}]){
    const member={...producedMember(1),...edit},user={...producedUser,status:'disabled',updated_at:'later'}
    const h=harness({members:[member],user});await h.api.restoreInvitedUserAssignments(input())
    assert.deepEqual(h.state.members.get(id(1)),member);assert.deepEqual(h.state.user,user)
  }
})
await check('new membership compensation deletes only its exact produced version',async()=>{
  const request=input();request.memberships[0].previousMembership=null
  const unchanged=harness();await unchanged.api.restoreInvitedUserAssignments(request);assert.equal(unchanged.state.members.size,0)
  const changedMember={...producedMember(1),status:'active'},changed=harness({members:[changedMember]})
  await changed.api.restoreInvitedUserAssignments(request);assert.deepEqual(changed.state.members.get(id(1)),changedMember)
})
await check('missing rollback provenance never falls back to overwrite and wrapper preserves exact evidence',async()=>{
  const h=harness(),request=input();delete request.producedUserRowJson;request.memberships[0].producedMembershipRowJson=null
  await h.api.restoreInvitedUserAssignments(request)
  assert.deepEqual(h.log,['control-lock','user-lock','member-lock']);assert.deepEqual(h.state.user,producedUser)
  await h.api.restoreInvitedUserAssignment({email,organizationId:id(1),invitedBy:'old@example.test',previousMembership:old,
    producedUserRowJson:JSON.stringify(producedUser),producedMembershipRowJson:JSON.stringify(producedMember(1))})
  assert.equal(h.state.members.get(id(1)).role,'admin')
})
await check('multi-workspace compensation leaves changed grants and unrelated memberships intact',async()=>{
  const h=harness({members:[producedMember(1),{...producedMember(2),status:'active'},producedMember(3)]}),request=input()
  request.memberships.unshift({organizationId:id(2),previousMembership:null,producedMembershipRowJson:JSON.stringify(producedMember(2))})
  await h.api.restoreInvitedUserAssignments(request)
  assert.equal(h.state.members.get(id(1)).role,'admin');assert.equal(h.state.members.get(id(2)).status,'active')
  assert.deepEqual(h.state.members.get(id(3)),producedMember(3))
})
await check('actual invitation captures exact PostgreSQL JSON postimages instead of reconstructed DTO timestamps',async()=>{
  const log=[],userJson=JSON.stringify({...producedUser,updated_at:'2026-10-30T12:00:00.123456+00:00'}),memberJson=JSON.stringify(producedMember(1))
  const actor={email:'sender@example.test',organizationId:id(1)},tx={query:async(sql)=>{
    if(sql==='SELECT * FROM app_users WHERE email = $1 FOR UPDATE'){log.push('user-lock');return{rows:[]}}
    if(sql.includes('SELECT organization.id::text'))return{rows:[{id:id(1),name:'Test'}]}
    if(sql.includes('SELECT role, permissions, status, is_default, trashed_at')){log.push('member-lock');return{rows:[]}}
    if(sql.includes('INSERT INTO app_users')){assert.match(sql,/to_jsonb\(app_users\)::text AS produced_row_json/)
      return{rows:[{...producedUser,crm_user_enabled:false,produced_row_json:userJson}]}}
    if(sql.includes('INSERT INTO app_user_organization_memberships')){
      assert.match(sql,/to_jsonb\(app_user_organization_memberships\)::text AS produced_row_json/)
      return{rows:[{...producedMember(1),produced_row_json:memberJson}]}}
    assert.fail('Unexpected invite SQL')
  }}
  const api=actual({resolveAppUserActor:async()=>actor,canInviteUsers:()=>true,normalizeUserEmail:String,
    MEMBER_PERMISSIONS:{viewCrm:true},normalizeOrganizationIds:value=>value,withTransaction:async fn=>fn(tx),
    lockCrmNativeEmailAuthorityWithClient:async()=>log.push('control-lock'),requireInvitationOrganizationInActorScope:async()=>{},
    permissionsForRole:(_role,value)=>value,toAppUser:value=>value,recordAuditEvent:async()=>{}})
  const result=await api.inviteAppUser({actorEmail:actor,email,organizationIds:[id(1)]})
  assert.deepEqual(log,['control-lock','user-lock','member-lock'])
  assert.equal(result.producedUserRowJson,userJson);assert.equal(result.previousMemberships[0].producedMembershipRowJson,memberJson)
})
console.log(`PASS ${count} invitation compensation groups; actual functions with mocked SQL, no database/provider proof`)
