#!/usr/bin/env node
// Pure source/provenance contract acceptance. No DB/API/native grants or
// production proof. The runtime must collect and fence these inputs itself.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
function load(path,deps){const module={exports:{}}
  const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('module','exports','require',code)(module,module.exports,name=>{
    assert.ok(Object.hasOwn(deps,name),`Unexpected dependency ${name}`);return deps[name]})
  return module.exports}
const protocol=load('app_src/lib/crm/nativeEmailPublication.ts',{'node:crypto':crypto})
const {deriveRootEmployeeCrmReadScope:derive,planRootEmployeeCrmReadEdges:plan}=load(
  'app_src/lib/crm/rootEmployeeCrmAccess.ts',{'./nativeEmailPublication':protocol})
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,copy=v=>JSON.parse(JSON.stringify(v))
const owner='owner@example.invalid',employee='employee@example.invalid',anchor=id(1),grant=id(2),root=id(3)
const member=(workspaceId,userEmail,role='member')=>({workspaceId,userEmail,role,status:'active',trashed:false,viewCrm:true})
const source=()=>({version:1,anchor:{id:anchor,rootWorkspaceId:root,ownerEmail:owner,enabled:true},
 rootWorkspace:{id:root,parentId:null,organizationType:'root',isDemo:false},operator:{email:owner,status:'active',membership:member(root,owner,'owner')},
 grant:{id:grant,anchorId:anchor,userEmail:employee,sourceWorkspaceId:root,enabled:true},
 user:{email:employee,status:'active',suiteCrmUserId:'existing-native-employee',nativeIdentityCount:1},sourceMembership:member(root,employee),
 targets:[3,4].map(n=>({anchorId:anchor,workspaceId:id(n),isDemo:false,ownerMembership:member(id(n),owner,'owner'),
  employeeMembership:n===3?member(root,employee):null,pipelines:[{id:id(n+10),referenceAccessDisabled:false}],
  boards:[{id:id(n+20),kind:'crm_projection',pipelineId:id(n+10)},{id:id(n+30),kind:'private',pipelineId:null}]}))})
const current=(edge,patch={})=>({...edge,userEmail:employee,manualRole:null,inherited:[{anchorId:anchor,grantId:grant}],...patch})
let groups=0,cases=0
function check(name,fn){fn();groups++;console.log('PASS '+name)}
function refuse(fn){assert.throws(fn);cases++}
check('explicit operator grant covers peer business CRM scopes and managed cards, never private boards',()=>{
 const input=source(),before=copy(input),result=derive(input)
 assert.equal(result.enabled,true);assert.equal(result.edges.length,6);assert.equal(result.suiteCrmUserId,input.user.suiteCrmUserId)
 assert.deepEqual(new Set(result.edges.map(v=>v.workspaceId)),new Set([root,id(4)]))
 assert.equal(result.edges.some(v=>[id(33),id(34)].includes(v.resourceId)),false)
 assert.deepEqual(input,before);assert.deepEqual(derive(copy(input)),result)
 assert.equal(plan(input,[]).changes.every(v=>v.action==='attach'&&v.changesEffectiveRead),true);cases++
})
check('app-only users receive the same app scope without inventing a native identity',()=>{
 const input=source();input.user.suiteCrmUserId=null;input.user.nativeIdentityCount=0
 assert.equal(derive(input).suiteCrmUserId,null);assert.equal(derive(input).edges.length,6)
 for(const count of [1,2,-1,'0']){const changed=copy(input);changed.user.nativeIdentityCount=count;refuse(()=>derive(changed))}
 for(const nativeId of ['', 'ambiguous\n', 'x'.repeat(37)]){const changed=source();changed.user.suiteCrmUserId=nativeId;refuse(()=>derive(changed))}
})
check('source disable, module denial, trash, owner suspension and revoked grant remove all inherited scope',()=>{
 const edits=[v=>v.anchor.enabled=false,v=>v.grant.enabled=false,v=>v.operator.status='disabled',
  v=>v.operator.membership.status='disabled',v=>v.operator.membership.role='admin',v=>v.operator.membership.trashed=true,v=>v.user.status='disabled',
  v=>v.user.status='invited',v=>v.sourceMembership.status='disabled',v=>v.sourceMembership.trashed=true,v=>v.sourceMembership.viewCrm=false]
 const before=derive(source()).edges.map(edge=>current(edge))
 for(const edit of edits){const changed=source();edit(changed)
  if(changed.targets[0].workspaceId===root){changed.targets[0].employeeMembership=copy(changed.sourceMembership);changed.targets[0].ownerMembership=copy(changed.operator.membership)}
  const result=plan(changed,before);assert.deepEqual(result.scope.edges,[])
  assert.equal(result.changes.length,6);assert.equal(result.changes.every(v=>v.action==='detach'&&v.changesEffectiveRead),true);cases++}
})
check('foreign anchor, demo, target suspension, trash and explicit CRM denial cannot inherit',()=>{
 for(const edit of [v=>v.anchorId=id(99),v=>v.isDemo=true,v=>v.ownerMembership.status='disabled',v=>v.ownerMembership.role='admin',
  v=>v.employeeMembership={...member(v.workspaceId,employee),status:'disabled'},
  v=>v.employeeMembership={...member(v.workspaceId,employee),trashed:true},
  v=>v.employeeMembership={...member(v.workspaceId,employee),viewCrm:false}]){
  const changed=source();edit(changed.targets[1]);const result=derive(changed)
  assert.equal(result.edges.some(edge=>edge.workspaceId===id(4)),false);assert.equal(result.edges.length,3);cases++}
})
check('inactive pipelines and their projected boards are excluded without creating replacement resources',()=>{
 const changed=source();changed.targets[1].pipelines[0].referenceAccessDisabled=true
 const result=derive(changed);assert.deepEqual(result.edges.filter(edge=>edge.workspaceId===id(4)),[
  {kind:'workspace',resourceId:id(4),workspaceId:id(4)}]);cases++
 const orphan=source();orphan.targets[1].boards[0].pipelineId=id(13);refuse(()=>derive(orphan))
})
check('current same-source edges are idempotent, and a new business scope attaches only new readers',()=>{
 const input=source(),before=derive(input).edges.map(edge=>current(edge))
 assert.deepEqual(plan(input,before).changes,[])
 input.targets.push({anchorId:anchor,workspaceId:id(50),isDemo:false,ownerMembership:member(id(50),owner,'owner'),
  employeeMembership:null,pipelines:[{id:id(51),referenceAccessDisabled:false}],boards:[]})
 assert.deepEqual(plan(input,before).changes.map(v=>[v.kind,v.resourceId,v.action]),[
  ['pipeline',id(51),'attach'],['workspace',id(50),'attach']]);cases++
})
check('revocation detaches only its own provenance and preserves independent manual/other-reader grants',()=>{
 const input=source(),edges=derive(input).edges
 const before=edges.map((edge,index)=>current(edge,index===0?{manualRole:'editor'}:
  index===1?{inherited:[{anchorId:anchor,grantId:grant},{anchorId:id(97),grantId:id(98)}]}:{}))
 input.grant.enabled=false;const result=plan(input,before)
 assert.equal(result.changes.length,6);assert.equal(result.changes.filter(v=>!v.changesEffectiveRead).length,2)
 assert.equal(before[0].manualRole,'editor');assert.equal(before[1].inherited.length,2);cases++
 const unrelated=edges.map(edge=>current(edge,{manualRole:'owner',inherited:[{anchorId:id(97),grantId:id(98)}]}))
 assert.deepEqual(plan(input,unrelated).changes,[])
 input.grant.enabled=true;assert.equal(plan(input,unrelated).changes.every(v=>v.action==='attach'&&!v.changesEffectiveRead),true);cases++
})
check('source shape never accepts a default workspace or CRM identity as an implicit root-access grant',()=>{
 const edits=[v=>v.defaultWorkspaceId=root,v=>v.crmUserEnabled=true,v=>delete v.grant,
  v=>v.grant.sourceWorkspaceId=id(90),v=>v.grant.anchorId=id(90),v=>v.grant.userEmail=owner,
  v=>v.rootWorkspace.parentId=id(90),v=>v.rootWorkspace.isDemo=true,v=>v.rootWorkspace.organizationType='member',
  v=>v.operator.membership.role='unknown',v=>v.sourceMembership.workspaceId=id(90),v=>v.sourceMembership.userEmail=owner,
  v=>v.targets[0].employeeMembership.viewCrm=false,v=>v.targets[1].ownerMembership.userEmail='other@example.invalid',
  v=>v.anchor.id+='\n',v=>v.user.email+='\n',v=>v.anchor.enabled='true',v=>v.user.status=['active']]
 for(const edit of edits){const changed=source();edit(changed);refuse(()=>derive(changed))}
})
check('duplicate/oversized scope, malformed membership and arbitrary private-board provenance are refused',()=>{
 const edits=[v=>v.targets.push(copy(v.targets[0])),v=>v.targets[1].pipelines[0].id=v.targets[0].pipelines[0].id,
  v=>v.targets[1].boards[0].id=v.targets[0].boards[0].id,v=>v.targets[1].pipelines[0].referenceAccessDisabled=null,
  v=>v.sourceMembership.role=['member'],v=>v.targets=Array.from({length:101},()=>copy(v.targets[0]))]
 for(const edit of edits){const changed=source();edit(changed);refuse(()=>derive(changed))}
 const input=source(),edge=derive(input).edges[0]
 for(const changed of [current(edge,{kind:'private_board'}),current(edge,{userEmail:owner}),
  current(edge,{inherited:[{anchorId:anchor,grantId:grant},{anchorId:anchor,grantId:grant}]}),
  current(edge,{manualRole:'admin'}),current(edge,{resourceId:id(9)+'\n'})])refuse(()=>plan(input,[changed]))
 refuse(()=>plan(input,[current(edge),current(edge)]))
})
console.log(`PASS ${groups} root-employee CRM source/provenance contract groups (${cases} cases); no persistence, native permission, runtime or production proof`)
