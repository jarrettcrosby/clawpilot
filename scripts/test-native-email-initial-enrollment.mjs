#!/usr/bin/env node
// Pure preparatory contract only. No SQL, native execution, approval or activation.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
assert.equal(process.versions.node.split('.')[0], '24', 'Use the supported bundled Node24 runtime')
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path)
 const module={exports:{}},code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','module','exports',code)(name=>name==='server-only'?{}:name==='node:crypto'?crypto:
  load('app_src/lib/crm/'+name.slice(2)+'.ts'),module,module.exports);cache.set(path,module.exports);return module.exports}
const base=load('app_src/lib/crm/nativeEmailPublication.ts'),contract=load('app_src/lib/crm/nativeEmailInitialEnrollment.ts')
const lineageContract=load('app_src/lib/crm/nativeEmailInitialInstallationLineage.ts')
const copy=value=>JSON.parse(JSON.stringify(value)),hash=value=>base.nativeEmailDigest(value)
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const caps=readers=>Object.fromEntries(['view','list','export','edit','delete'].map(key=>[key,[...readers]]))
function fixture(count=329){
 const principals=['admin','denied-a','denied-b','olivia']
 const pipelines=[0,1].map(index=>{const readers=index?['admin']:['admin','olivia'],pipelineId=id(10+index),workspaceId=id(20+index)
  const audience={policy:'pipeline-internal',ownerSuiteCrmId:'admin',allowedSuiteCrmUserIds:readers,workspaceId,pipelineId}
  return {groupId:id(30+index),policy:{version:2,pipelineId,workspaceId,ownerSuiteCrmId:'admin',
   audienceFingerprint:crypto.createHash('sha256').update(JSON.stringify(audience)).digest('hex'),
   principalSuiteCrmUserIds:principals,futureCreate:caps(readers),historical:[]}}})
 const emails=Array.from({length:count},(_,index)=>{const p=pipelines[index<27?0:1].policy
  const before={localId:id(1000+index),nativeId:id(2000+index),globalId:'gi'+String(1000000+index),pipelineId:p.pipelineId,
   workspaceId:p.workspaceId,archived:index<6,recordFingerprint:hash(['content',index]),capabilities:caps(['admin','olivia'])}
  return {before,after:{...copy(before),capabilities:caps(p.futureCreate.view)}}})
 const reviewedRevocations=emails.flatMap(({before,after})=>['view','list','export','edit','delete'].flatMap(surface=>
  before.capabilities[surface].filter(principalId=>!after.capabilities[surface].includes(principalId)).map(principalId=>({nativeId:before.nativeId,surface,principalId}))))
 reviewedRevocations.sort((a,b)=>[a.nativeId,a.surface,a.principalId].join(':')<[b.nativeId,b.surface,b.principalId].join(':')?-1:1)
 const defaults=['delete','edit','export','list','view'].map((action,index)=>({before:{id:id(3000+index),action,aclAccess:90},
  after:{id:id(3000+index),action,aclAccess:['edit','delete'].includes(action)?75:80}}))
 const input={version:1,kind:'initial_enrollment_plan_v1',operationId:hash('operation'),nativeInstanceId:'reviewed-native',appGeneration:7,
  appSourceFingerprint:hash('app'),nativePolicyBeforeFingerprint:hash('before-policy'),nativeRuntimeBeforeFingerprint:hash('before-runtime'),
  nativePolicyAfterFingerprint:hash('after-policy'),nativeRuntimeAfterFingerprint:hash('after-runtime'),principalSuiteCrmUserIds:principals,
  defaults,emails,pipelines,reviewedRevocations,rootEmployeeGrants:[]}
 const evidence={complete:{appEmails:true,nativeEmails:true,nativePrincipals:true,pipelineAuthority:true,nativeDefaults:true},
  nativeInstanceId:input.nativeInstanceId,appGeneration:input.appGeneration,appSourceFingerprint:input.appSourceFingerprint,
  nativePolicyFingerprint:input.nativePolicyBeforeFingerprint,nativeRuntimeFingerprint:input.nativeRuntimeBeforeFingerprint,
  principalSuiteCrmUserIds:principals,emails:emails.map(row=>copy(row.before)),defaults:defaults.map(row=>copy(row.before)),
  approvedPipelines:copy(pipelines),reviewedRevocations:copy(reviewedRevocations)}
 return {input,evidence}
}
function replanFixture(depth=1){
 const f=fixture(),root=hash('installation-root'),predecessor=depth===1?root:hash('cancelled-prior-replan')
 const context={version:1,purpose:'clawpilot-native-email-initial-replan-context',rootOperationId:root,
  rootInstallationJournalFingerprint:hash('root-journal'),rootSourceArtifactDigest:hash('original-stock-source'),
  rootStockRuntimeFingerprint:hash('original-stock-runtime'),predecessorOperationId:predecessor,
  predecessorPlanHash:hash('cancelled-plan'),predecessorApprovalHash:hash('cancelled-approval'),
  predecessorCancellationReceiptHash:hash('cancelled-receipt'),previousLineageHash:depth===1?null:hash('previous-lineage'),
  depth,cancelledHistoryFingerprint:hash('complete-cancelled-history')}
 f.input.kind='initial_enrollment_replan_v1'
 f.input.installationLineage=lineageContract.finalizeNativeEmailInitialInstallationLineage(context,f.input.operationId,
  hash('fresh-source-captured-before-plan'),f.input.nativeRuntimeBeforeFingerprint)
 return f
}
let checks=0
function check(label,run){run();checks++;console.log('PASS '+label)}
function accepted(f=fixture()){return contract.prepareNativeEmailInitialEnrollment(f.input,f.evidence)}
function rejected(mutate,pattern){const f=fixture();mutate(f);assert.throws(()=>accepted(f),pattern)}
check('329 exact historical identities retain six archives and 27 legitimate editor scopes; result is frozen and non-executable',()=>{
 const f=fixture(),before=copy(f),p=accepted(f);assert.deepEqual(f,before)
 assert.equal(p.plan.emails.length,329);assert.equal(p.plan.emails.filter(row=>row.after.archived).length,6)
 assert.equal(p.plan.emails.filter(row=>row.after.capabilities.edit.includes('olivia')).length,27)
 assert.equal(p.plan.reviewedRevocations.length,302*5);assert.equal(p.executable,false);assert.equal(p.activationReceipt,null)
 assert.ok(!Object.hasOwn(p,'state')&&!Object.hasOwn(p,'receiptHash')&&!Object.hasOwn(p,'signature'))
 assert.ok(Object.isFrozen(p.plan.emails[0].after.capabilities.edit));assert.equal(p.planHash,hash(f.input))
 assert.equal(contract.verifyNativeEmailInitialEnrollmentFingerprint(f.input,f.evidence,p.planHash).planHash,p.planHash)
 assert.throws(()=>contract.verifyNativeEmailInitialEnrollmentFingerprint(f.input,f.evidence,'f'.repeat(64)),/reviewed_plan_changed/)
})
check('source completeness, app/native generation/runtime/policy and principal drift hold without a safe subset',()=>{
 for(const key of ['appEmails','nativeEmails','nativePrincipals','pipelineAuthority','nativeDefaults'])rejected(f=>{f.evidence.complete[key]=false},/incomplete_source/)
 for(const key of ['appGeneration','appSourceFingerprint','nativeInstanceId','nativePolicyFingerprint','nativeRuntimeFingerprint'])
  rejected(f=>{f.evidence[key]=typeof f.evidence[key]==='number'?8:hash('drift')},/source_drift/)
 rejected(f=>{f.evidence.principalSuiteCrmUserIds=['admin']},/principal_drift/)
 rejected(f=>{f.evidence.emails[0].recordFingerprint=hash('new-body')},/email_source_drift/)
})
check('duplicate native/local/global mappings, content/identity/archive changes and incomplete inventories are refused',()=>{
 for(const key of ['nativeId','localId','globalId'])rejected(f=>{f.input.emails[1].before[key]=f.input.emails[0].before[key]},/duplicate_identity/)
 for(const key of ['localId','nativeId','globalId','pipelineId','workspaceId','recordFingerprint','archived'])
  rejected(f=>{f.input.emails[0].after[key]=key==='archived'?false:key==='globalId'?'gi9999999':key==='recordFingerprint'?hash('changed'):id(9999)},/historical_content_or_identity_changed/)
 rejected(f=>{f.input.emails.pop()},/email_inventory/)
})
check('only exact independently reviewed historical revocations are accepted, never inferred reader or editor grants',()=>{
 rejected(f=>{f.input.reviewedRevocations.pop()},/revocations_not_reviewed/)
 rejected(f=>{f.input.emails[0].after.capabilities.edit=['admin']},/unreviewed_capability_change/)
 rejected(f=>{f.input.emails[30].after.capabilities.edit=['admin','olivia']},/write_without_read/)
 rejected(f=>{f.input.emails[0].after.capabilities.view=['admin','denied-a','olivia']},/historical_grant_forbidden/)
 rejected(f=>{f.input.emails[0].after.capabilities.view.push('outsider')},/principals|unknown_principal/)
 rejected(f=>{f.input.rootEmployeeGrants=[{user:'implicit-root'}]},/bound/)
})
check('future policy requires separate approval and exact five-row GROUP-read OWNER-write defaults',()=>{
 rejected(f=>{f.input.pipelines[0].policy.futureCreate.edit=['admin']},/future_policy_not_reviewed/)
 for(const change of [d=>{d.after.id=id(9999)},d=>{d.after.aclAccess=90},d=>{d.before.aclAccess=80},d=>{d.after.action='view'}])
  rejected(f=>{change(f.input.defaults[0])},/defaults/)
 rejected(f=>{f.input.defaults.pop()},/defaults/)
 rejected(f=>{f.evidence.defaults[0].id=id(9999)},/default_source_drift/)
})
check('fixed schema rejects activation/receipt/secret/SQL additions and preserves the 500-history maximum',()=>{
 for(const [key,value]of [['enabled',true],['state','committed'],['activationReceiptHash',hash('fake')],['privateKey','secret'],['sql','UPDATE anything']])
  rejected(f=>{f.input[key]=value},/shape/)
 assert.equal(accepted(fixture(500)).plan.emails.length,500)
 assert.throws(()=>accepted(fixture(501)),/bound/)
 rejected(f=>{f.input.principalSuiteCrmUserIds.push('admin')},/principals/)
 rejected(f=>{f.input.emails[0].before.nativeId+='\n'},/email_identity/)
})
check('direct v1 stays exact and forbids lineage or silently substituted replan kinds',()=>{
 const f=fixture(),p=accepted(f)
 assert.equal(p.plan.kind,'initial_enrollment_plan_v1');assert.equal(Object.hasOwn(p.plan,'installationLineage'),false)
 assert.equal(p.planHash,hash(f.input))
 f.input.installationLineage=replanFixture().input.installationLineage
 assert.throws(()=>accepted(f),/initial_enrollment_shape/)
 for(const kind of ['initial_enrollment_replan_v2','initial_enrollment_plan_v2','initial_enrollment_replan_v1\n']){
  const changed=fixture();changed.input.kind=kind;assert.throws(()=>accepted(changed),/initial_enrollment_identity/)
 }
 const missing=replanFixture();delete missing.input.installationLineage;assert.throws(()=>accepted(missing),/initial_enrollment_shape/)
})
check('first and repeated replans retain all historical checks and bind the full lineage in the reviewed plan hash',()=>{
 for(const depth of [1,2,500]){
  const f=replanFixture(depth),p=accepted(f)
  assert.equal(p.executable,false);assert.equal(p.activationReceipt,null);assert.equal(p.plan.kind,'initial_enrollment_replan_v1')
  assert.equal(p.plan.emails.length,329);assert.equal(p.plan.reviewedRevocations.length,302*5)
  assert.equal(Object.isFrozen(p.plan.installationLineage),true);assert.equal(p.planHash,hash(f.input))
  assert.equal(p.sourceFingerprint,hash(f.evidence));assert.equal(Object.hasOwn(f.evidence,'installationLineage'),false)
  assert.equal(contract.verifyNativeEmailInitialEnrollmentFingerprint(f.input,f.evidence,p.planHash).planHash,p.planHash)
  const changed=copy(f);changed.input.installationLineage.freshSourceArtifactDigest=hash('different-captured-source')
  assert.throws(()=>contract.verifyNativeEmailInitialEnrollmentFingerprint(changed.input,changed.evidence,p.planHash),/reviewed_plan_changed/)
 }
})
check('replans reject malformed lineage, self ancestry, depth forms and fresh runtime/source mismatches',()=>{
 for(const mutate of [f=>{f.input.installationLineage=null},f=>{f.input.installationLineage={...f.input.installationLineage,alias:true}},
  f=>{f.input.installationLineage={...f.input.installationLineage,freshSourceArtifactDigest:'invalid'}},
  f=>{f.input.installationLineage={...f.input.installationLineage,rootOperationId:f.input.operationId}},
  f=>{f.input.installationLineage={...f.input.installationLineage,predecessorOperationId:f.input.operationId}},
  f=>{f.input.installationLineage={...f.input.installationLineage,depth:501}},
  f=>{f.input.installationLineage={...f.input.installationLineage,depth:2}},
  f=>{f.input.installationLineage={...f.input.installationLineage,freshInstalledRuntimeFingerprint:hash('not-the-current-runtime')}}]){
  const f=replanFixture();mutate(f);assert.throws(()=>accepted(f),/initial_installation_lineage_|initial_enrollment_replan_runtime_mismatch/)
 }
 const repeated=replanFixture(2);repeated.input.installationLineage={...repeated.input.installationLineage,previousLineageHash:null}
 assert.throws(()=>accepted(repeated),/initial_installation_lineage_predecessor/)
 const source=replanFixture();source.evidence.nativeRuntimeFingerprint=hash('not-the-independent-runtime')
 assert.throws(()=>accepted(source),/source_drift/)
 const extra=replanFixture();extra.evidence.complete.cancelled=true;assert.throws(()=>accepted(extra),/shape/)
})
check('replans cannot bypass independent historical content, no-grant, default, future policy or revocation rules',()=>{
 for(const mutate of [f=>{f.input.emails[0].after.recordFingerprint=hash('changed-body')},
  f=>{f.input.emails[0].after.archived=false},f=>{f.input.emails[0].after.capabilities.view=['admin','denied-a','olivia']},
  f=>{f.input.rootEmployeeGrants=[{user:'implicit-root'}]},f=>{f.input.defaults[0].after.aclAccess=90},
  f=>{f.input.pipelines[0].policy.futureCreate.edit=['admin']},f=>{f.input.reviewedRevocations.pop()},
  f=>{f.evidence.emails[0].recordFingerprint=hash('different-independent-content')}]){
  const f=replanFixture();mutate(f);assert.throws(()=>accepted(f),/historical_content_or_identity_changed|historical_grant_forbidden|bound|defaults|future_policy_not_reviewed|revocations_not_reviewed|email_source_drift/)
 }
})
console.log(`PASS ${checks} initial-enrollment preparatory contract groups; no installer, ledger, native execution, receipt or activation proof`)
