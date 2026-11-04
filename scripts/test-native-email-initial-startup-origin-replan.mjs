#!/usr/bin/env node
// Pure source/RSA contract test with SYNTHETIC SQL facts. No database, remote
// transport, protected-file capability or startup readiness is proved here.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,resolve} from 'node:path'
const appRequire=createRequire(resolve('app_src/package.json')),ts=appRequire('typescript'),cache=new Map()
const sourceRoot=resolve('app_src/lib/crm'),opsPath=resolve('app_src/ops/native-email-initial.ts')
function load(path){if(cache.has(path))return cache.get(path);const module={exports:{}};cache.set(path,module.exports)
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const require=name=>{if(name==='server-only')return{};if(name.startsWith('node:'))return appRequire(name)
    if(name==='pg')return {Pool:class{constructor(){throw Error('Database access forbidden in pure origin fixture')}}}
    const target=resolve(dirname(path),name+'.ts')
    if(path===opsPath&&!['nativeEmailPublication.ts','nativeEmailInitialEnrollmentApproval.ts','nativeEmailInitialStartupOrigin.ts'].some(file=>target===resolve(sourceRoot,file)))return{}
    assert.ok(name.startsWith('.'),'Unexpected pure fixture dependency '+name);return load(target)}
  new Function('require','module','exports',code)(require,module,module.exports);cache.set(path,module.exports);return module.exports}
const base=load(resolve(sourceRoot,'nativeEmailPublication.ts')),lineageApi=load(resolve(sourceRoot,'nativeEmailInitialInstallationLineage.ts'))
const {createNativeEmailInitialStartupOriginIssuer:issuer}=load(resolve(sourceRoot,'nativeEmailInitialStartupOrigin.ts'))
const {reuseVerifiedNativeEmailInitialOrigin:reuse}=load(opsPath),json=base.nativeEmailCanonicalJson,hash=base.nativeEmailDigest
const clone=value=>JSON.parse(JSON.stringify(value)),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072}),publicKey=keys.publicKey.export({format:'pem',type:'spki'}),now=Math.floor(Date.now()/1000)
const config={privateKey:keys.privateKey,keyId:'pure-origin-key',nativeInstanceId:'pure-origin-instance',serviceUserId:'service',oauthClientId:'client'}
const selection={actorEmail:'owner@example.invalid',operatorAccountId:id(1),rootWorkspaceId:id(2),nativeInstanceId:config.nativeInstanceId}
const sign=proof=>({proof,signature:crypto.sign('sha256',Buffer.from(json(proof),'ascii'),{key:keys.privateKey,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
function fixture(replan=false){
  const operationId=hash(replan?'B':'A'),fresh=hash('fresh-installed'),root=hash('A'),workspaceId=id(3),pipelineId=id(4)
  const lineage={version:1,purpose:'clawpilot-native-email-initial-installation-lineage',rootOperationId:root,
    rootInstallationJournalFingerprint:hash('root-journal'),rootSourceArtifactDigest:hash('root-source'),rootStockRuntimeFingerprint:hash('root-stock'),
    predecessorOperationId:root,predecessorPlanHash:hash('root-plan'),predecessorApprovalHash:hash('root-approval'),
    predecessorCancellationReceiptHash:hash('root-cancellation'),previousLineageHash:null,depth:1,cancelledHistoryFingerprint:hash('all-cancelled'),
    freshSourceArtifactDigest:hash('fresh-source'),freshInstalledRuntimeFingerprint:fresh}
  const email={nativeId:'email',globalId:'gi1234567',localId:id(5),pipelineId,workspaceId}
  const plan={version:1,kind:replan?'initial_enrollment_replan_v1':'initial_enrollment_plan_v1',operationId,nativeInstanceId:config.nativeInstanceId,
    appGeneration:7,appSourceFingerprint:hash('sql-source'),nativePolicyBeforeFingerprint:hash('policy-before'),nativePolicyAfterFingerprint:hash('policy-after'),
    nativeRuntimeBeforeFingerprint:replan?fresh:hash('stock'),nativeRuntimeAfterFingerprint:hash('enrolled-runtime'),
    emails:[{before:email,after:email}],pipelines:[{groupId:id(6),policy:{pipelineId,workspaceId}}],...(replan?{installationLineage:lineage}:{})}
  const proof={version:1,purpose:'clawpilot-native-email-initial-enrollment-approval',issuer:'clawpilot-pg-initial-enrollment',audience:'clawpilot-suitecrm-initial-enrollment',
    keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,serviceUserId:config.serviceUserId,oauthClientId:config.oauthClientId,
    issuedAt:now-3600,expiresAt:now-3480,operationId,appGeneration:7,appSourceFingerprint:plan.appSourceFingerprint,
    preparedAt:new Date((now-3600)*1000).toISOString().slice(0,19).replace('T',' '),sourceRuntimeFingerprint:plan.nativeRuntimeBeforeFingerprint,
    installedRuntimeFingerprint:replan?fresh:hash('installed'),installationJournalFingerprint:replan
      ?lineageApi.effectiveNativeEmailInitialInstallationJournalFingerprint(lineage,operationId):hash('journal')}
  const f={plan,proof,commitFailure:false,clockCalls:0,inside:false,queries:[],control:{enabled:true,active_initial_enrollment_id:null,generation:7}}
  f.rebind=()=>{const planHash=hash(f.plan),result={generation:7,appSourceFingerprint:plan.appSourceFingerprint,
      beforePolicyFingerprint:plan.nativePolicyBeforeFingerprint,afterPolicyFingerprint:plan.nativePolicyAfterFingerprint,
      sourceRuntimeFingerprint:f.proof.sourceRuntimeFingerprint,installedRuntimeFingerprint:f.proof.installedRuntimeFingerprint,runtimeFingerprint:plan.nativeRuntimeAfterFingerprint,
      identityFingerprint:hash('identities'),capabilitiesFingerprint:hash('caps'),bindingsFingerprint:hash('bindings'),defaultsFingerprint:hash('defaults'),emailCount:1,principalCount:2}
    const delta={version:1,purpose:'clawpilot-native-email-initial-policy-delta',operationId,planHash,preparedAt:proof.preparedAt,
      changes:{acl_actions:[],securitygroups:[],securitygroups_users:[],securitygroups_records:[]},result,policies:[]}
    f.proof.planHash=planHash;f.proof.deltaFingerprint=hash(delta);const approval=sign(clone(f.proof))
    const receipt={version:1,purpose:'clawpilot-native-email-initial-enrollment-receipt',operationId,planHash,approvalHash:hash(approval),state:'committed',result}
    const identity={state:'activated',actor_email:selection.actorEmail,operator_account_id:selection.operatorAccountId,root_workspace_id:selection.rootWorkspaceId,
      native_instance_id:selection.nativeInstanceId,generation:7,source_fingerprint:plan.appSourceFingerprint,settling_xid:'synthetic-committed-xid'}
    f.row={enrollment:{...identity,plan:f.plan,plan_hash:planHash,plan_canonical:json(f.plan),native_delta:delta,native_delta_canonical:json(delta),delta_fingerprint:hash(delta),
      approval_envelope:approval,approval_canonical:json(approval),approval_hash:hash(approval),native_receipt:receipt,receipt_canonical:json(receipt),receipt_hash:hash(receipt)},
      reservation:{...identity},actual_source_fingerprint:plan.appSourceFingerprint};return f}
  f.transaction=async run=>{f.inside=true;try{const value=await run({query:async sql=>{f.queries.push(sql)
      if(sql.startsWith('SELECT * FROM crm_native_email_publication_control'))return{rows:[clone(f.control)]}
      if(sql.includes('SELECT a.id FROM crm_operator_accounts'))return{rows:[{id:selection.operatorAccountId}]}
      if(sql.includes('to_jsonb(e) AS enrollment'))return{rows:[clone(f.row)]};throw Error('Unexpected SQL in synthetic facts port')}})
      if(f.commitFailure)throw Error('Synthetic COMMIT outcome lost');return value}finally{f.inside=false}}
  f.clock=()=>{assert.equal(f.inside,false,'Origin validation/signing clock ran before transaction returned');f.clockCalls++;return now*1000}
  f.issue=()=>issuer(f.transaction,selection,config,f.clock).issue(operationId,f.row.enrollment.plan_hash)
  return f.rebind()
}
let checks=0;const check=async(name,run)=>{await run();checks++;console.log('PASS '+name)}
await check('direct v1 origin keeps exact original proof fields and real RSA signature after committed fact return',async()=>{
  const f=fixture(),envelope=await f.issue();assert.equal(envelope.proof.version,1)
  assert.deepEqual(Object.keys(envelope.proof).sort(),['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId','issuedAt','operationId','planHash',
    'approvalHash','deltaFingerprint','initialReceiptHash','originGeneration','appSourceFingerprint','installationJournalFingerprint','sourceRuntimeFingerprint','installedRuntimeFingerprint',
    'runtimeFingerprint','identities','pipelines'].sort())
  assert.equal(crypto.verify('sha256',Buffer.from(json(envelope.proof),'ascii'),publicKey,Buffer.from(envelope.signature,'base64')),true);assert.ok(f.clockCalls>0)
})
await check('replan v2 derives only stored B plan lineage, fresh source and effective journal while retaining RootA separately',async()=>{
  const f=fixture(true);f.row.enrollment.installation_root_operation_id=hash('caller-flag');f.row.enrollment.origin_version=1
  const {proof}=await f.issue();assert.equal(proof.version,2);assert.equal(proof.operationId,f.plan.operationId)
  assert.equal(proof.installationRootOperationId,f.plan.installationLineage.rootOperationId)
  assert.equal(proof.installationLineageHash,hash(f.plan.installationLineage));assert.equal(proof.sourceRuntimeFingerprint,f.plan.nativeRuntimeBeforeFingerprint)
  assert.notEqual(proof.sourceRuntimeFingerprint,f.plan.installationLineage.rootStockRuntimeFingerprint)
  assert.equal(proof.installationJournalFingerprint,lineageApi.effectiveNativeEmailInitialInstallationJournalFingerprint(f.plan.installationLineage,f.plan.operationId))
})
await check('retained byte drift and nonactivated SQL facts refuse before origin issuance',async()=>{
  for(const mutate of [f=>{f.control.enabled=false},f=>{f.row.enrollment.state='committed'},f=>{f.row.enrollment.plan_canonical+=' '},
    f=>{f.row.enrollment.approval_canonical+=' '},f=>{f.row.enrollment.receipt_hash=hash('other')},f=>{f.row.actual_source_fingerprint=hash('other')}]){
    const f=fixture(true);mutate(f);await assert.rejects(f.issue());assert.equal(f.clockCalls,0)}
})
await check('signed retained source/root/effective journal substitution cannot turn RootA stock pins into B fresh pins',async()=>{
  for(const mutate of [f=>{f.proof.sourceRuntimeFingerprint=f.plan.installationLineage.rootStockRuntimeFingerprint},
    f=>{f.proof.installationJournalFingerprint=f.plan.installationLineage.rootInstallationJournalFingerprint},
    f=>{f.proof.installedRuntimeFingerprint=hash('other')},f=>{f.plan.installationLineage.rootOperationId=f.plan.operationId}]){
    const f=fixture(true);mutate(f);f.rebind();await assert.rejects(f.issue())}
  const direct=fixture();direct.plan.installationLineage=fixture(true).plan.installationLineage;direct.rebind();await assert.rejects(direct.issue())
})
await check('unknown COMMIT return cannot mint an origin or invoke the post-transaction signing clock',async()=>{
  const f=fixture(true);f.commitFailure=true;await assert.rejects(f.issue(),/COMMIT outcome lost/);assert.equal(f.clockCalls,0)
})
await check('real existing retry verifier preserves exact v1/v2 signed bytes and rejects changed root lineage or version',async()=>{
  for(const replan of [false,true]){const f=fixture(replan),original=await f.issue(),bytes=json(original),fresh=clone(original);fresh.proof.issuedAt++
    assert.equal(json(reuse(fresh,original,publicKey,now*1000)),bytes)
    const changed=clone(original);changed.proof.planHash=hash('changed');assert.throws(()=>reuse(fresh,changed,publicKey,now*1000))
    if(replan)for(const field of ['installationRootOperationId','installationLineageHash','version']){const changed=clone(original)
      changed.proof[field]=field==='version'?1:hash('changed');assert.throws(()=>reuse(fresh,changed,publicKey,now*1000))}}
})
console.log('PASS '+checks+' startup-origin v1/v2 source/RSA groups; SYNTHETIC SQL port, no actual PG/native/startup/deployment proof')
