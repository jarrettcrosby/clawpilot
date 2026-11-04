#!/usr/bin/env node
// Actual server contract/RSA signer with a synthetic durable-store port only.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript'),cache=new Map()
function load(path){if(cache.has(path))return cache.get(path);const m={exports:{}}
 const code=ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','module','exports',code)(name=>name==='server-only'?{}:name==='node:crypto'?crypto:load('app_src/lib/crm/'+name.slice(2)+'.ts'),m,m.exports)
 cache.set(path,m.exports);return m.exports}
const base=load('app_src/lib/crm/nativeEmailPublication.ts'),api=load('app_src/lib/crm/nativeEmailInitialEnrollmentApproval.ts')
const clone=x=>JSON.parse(JSON.stringify(x)),hash=base.nativeEmailDigest,id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const matrix=ids=>Object.fromEntries(['view','list','export','edit','delete'].map(k=>[k,[...ids]]))
function fixture(){const principals=['admin','unroled'],pipelineId=id(1),workspaceId=id(2),readers=['admin']
 const audience={policy:'pipeline-internal',ownerSuiteCrmId:'admin',allowedSuiteCrmUserIds:readers,workspaceId,pipelineId}
 const policy={version:2,pipelineId,workspaceId,ownerSuiteCrmId:'admin',audienceFingerprint:crypto.createHash('sha256').update(JSON.stringify(audience)).digest('hex'),principalSuiteCrmUserIds:principals,futureCreate:matrix(readers),historical:[]}
 const before={localId:id(3),nativeId:id(4),globalId:'gi1000000',pipelineId,workspaceId,archived:true,recordFingerprint:hash('record'),capabilities:matrix(principals)}
 const after={...clone(before),capabilities:matrix(readers)},defaults=['delete','edit','export','list','view'].map((action,i)=>({before:{id:id(10+i),action,aclAccess:90},after:{id:id(10+i),action,aclAccess:['edit','delete'].includes(action)?75:80}}))
 const revocations=['delete','edit','export','list','view'].map(surface=>({nativeId:before.nativeId,surface,principalId:'unroled'}))
 const plan={version:1,kind:'initial_enrollment_plan_v1',operationId:hash('operation'),nativeInstanceId:'test-native',appGeneration:1,appSourceFingerprint:hash('app'),nativePolicyBeforeFingerprint:hash('before-policy'),nativeRuntimeBeforeFingerprint:hash('source'),nativePolicyAfterFingerprint:hash('after-policy'),nativeRuntimeAfterFingerprint:hash('after-runtime'),principalSuiteCrmUserIds:principals,defaults,emails:[{before,after}],pipelines:[{groupId:id(5),policy}],reviewedRevocations:revocations,rootEmployeeGrants:[]}
 const evidence={complete:{appEmails:true,nativeEmails:true,nativePrincipals:true,pipelineAuthority:true,nativeDefaults:true},nativeInstanceId:plan.nativeInstanceId,appGeneration:1,appSourceFingerprint:plan.appSourceFingerprint,nativePolicyFingerprint:plan.nativePolicyBeforeFingerprint,nativeRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,principalSuiteCrmUserIds:principals,emails:[clone(before)],defaults:defaults.map(d=>clone(d.before)),approvedPipelines:clone(plan.pipelines),reviewedRevocations:clone(revocations)}
 const preparedAt='2026-11-03 12:00:00',planHash=hash(plan),installed=hash('installed'),future={...policy};delete future.historical
 const result={generation:1,appSourceFingerprint:plan.appSourceFingerprint,beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,installedRuntimeFingerprint:installed,runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,identityFingerprint:hash('identities'),capabilitiesFingerprint:hash('capabilities'),bindingsFingerprint:hash('bindings'),defaultsFingerprint:hash('defaults'),emailCount:1,principalCount:2}
 const nativeDelta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId:plan.operationId,planHash,preparedAt,changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies:[{pipelineId,generation:1,policy,fingerprint:hash(future)}]}
 return {state:'reserved',publicationEnabled:false,barrierOperationId:plan.operationId,plan,evidence,planHash,preparedAt,nativeDelta,deltaFingerprint:hash(nativeDelta),sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,installedRuntimeFingerprint:installed,installationJournalFingerprint:hash('journal')}
}
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({format:'pem',type:'spki'})
const config={privateKey:keys.privateKey,keyId:'test-initial-key',nativeInstanceId:'test-native',serviceUserId:'admin',oauthClientId:id(20),ttlSeconds:120}
assert.ok(process.argv.slice(2).length<=1&&process.argv.slice(2).every(arg=>arg==='--emit-fixture'),'Only the explicit synthetic fixture output is supported')
let current=Date.now(),checks=0
const clock=()=>current
function store(record=fixture()){let saved=null,callbacks=0;return {record,get saved(){return saved},get callbacks(){return callbacks},async issueApproval(operationId,create){assert.equal(operationId,record.plan.operationId);if(!saved){callbacks++;saved=clone(create(clone(record)))}return clone(saved)}}}
async function check(name,fn){await fn();checks++;console.log('PASS '+name)}
let emitted
await check('actual RSA3072 fixed-purpose signature is issued once and retained unchanged after expiry',async()=>{
 const s=store(),issuer=api.createNativeEmailInitialApprovalIssuer(s,config,clock),p=await issuer.issue(s.record.plan.operationId,s.record.planHash)
 assert.equal(s.callbacks,1);assert.equal(p.proof.preparedAt,s.record.preparedAt);assert.equal(p.proof.expiresAt-p.proof.issuedAt,120)
 assert.equal(p.proof.purpose,'clawpilot-native-email-initial-enrollment-approval')
 assert.equal(crypto.verify('sha256',Buffer.from(base.nativeEmailCanonicalJson(p.proof),'ascii'),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(p.signature,'base64')),true)
 current+=400000;assert.deepEqual(await issuer.issue(s.record.plan.operationId,s.record.planHash),p);assert.equal(s.callbacks,1)
 current-=400000;emitted={syntheticOnly:true,publicKey,envelope:p}
})
await check('unreserved enabled missing-barrier and reviewed-plan drift reject before returning any signature',async()=>{
 for(const mutate of [r=>{r.state='committed'},r=>{r.publicationEnabled=true},r=>{r.barrierOperationId=hash('other')},r=>{r.planHash=hash('other')},r=>{r.evidence.complete.nativeEmails=false},r=>{r.evidence.emails[0].recordFingerprint=hash('drift')}]){
  const s=store();mutate(s.record);const issuer=api.createNativeEmailInitialApprovalIssuer(s,config,clock)
  await assert.rejects(issuer.issue(s.record.plan.operationId,hash(fixture().plan)));assert.equal(s.saved,null)
 }
})
await check('forecast journal native destination policy and immutable-source bindings are checked',async()=>{
 for(const mutate of [r=>{r.preparedAt='2026-02-30 12:00:00'},r=>{r.installationJournalFingerprint='bad'},r=>{r.sourceRuntimeFingerprint=hash('other')},r=>{r.nativeDelta.result.emailCount=2},r=>{r.nativeDelta.policies[0].generation=2},r=>{r.nativeDelta.sql='UPDATE anything'},r=>{r.plan.nativeInstanceId='other'}]){
  const s=store();mutate(s.record);if(s.record.nativeDelta)s.record.deltaFingerprint=hash(s.record.nativeDelta)
  const issuer=api.createNativeEmailInitialApprovalIssuer(s,config,clock);await assert.rejects(issuer.issue(s.record.plan.operationId,s.record.planHash));assert.equal(s.saved,null)
 }
})
await check('retained proof tampering wrong-purpose substitution and unknown keys cannot be returned as approvals',async()=>{
 for(const mutate of [e=>{e.proof.purpose='clawpilot-native-email-authority-approval'},e=>{e.proof.nativeInstanceId='other'},e=>{e.proof.deltaFingerprint=hash('other')},e=>{e.signature='A'.repeat(512)},e=>{e.proof.sql='UPDATE anything'},e=>{e.proof.expiresAt=e.proof.issuedAt+301}]){
  const r=fixture(),envelope=clone(emitted.envelope);mutate(envelope)
  const issuer=api.createNativeEmailInitialApprovalIssuer({issueApproval:async()=>envelope},config,clock)
  await assert.rejects(issuer.issue(r.plan.operationId,r.planHash))
 }
})
await check('key identity expiry and commit-failure trust boundaries do not expose a retained approval',async()=>{
 const weak=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey
 for(const changed of [{privateKey:weak},{ttlSeconds:301},{ttlSeconds:0},{serviceUserId:'../admin'},{oauthClientId:'bad\n'}])
  assert.throws(()=>api.createNativeEmailInitialApprovalIssuer(store(),{...config,...changed},clock))
 let candidate=null;const r=fixture(),issuer=api.createNativeEmailInitialApprovalIssuer({issueApproval:async(_,create)=>{candidate=create(r);throw Error('synthetic commit rollback')}},config,clock)
 await assert.rejects(issuer.issue(r.plan.operationId,r.planHash),/commit rollback/);assert.ok(candidate)
})
if(process.argv.includes('--emit-fixture'))console.log('CLAWPILOT_NATIVE_INITIAL_APPROVAL_FIXTURE='+JSON.stringify(emitted))
console.log(`PASS ${checks} actual initial-approval contract/RSA groups; synthetic store/forecast, no PG native execution or activation proof`)
