#!/usr/bin/env node
// Synthetic RSA pairs only; no browser, database, network or persisted keys.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as util from 'node:util'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const modules=new Map()
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const directory=name==='crmLegacyEmailTerminalHold'?'persistence':'crm'
  const source=readFileSync(new URL('../app_src/lib/'+directory+'/'+name+'.ts',import.meta.url),'utf8')
  const emitted=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const m={exports:{}}
  new Function('require','module','exports',emitted)(dependency=>{
    if(dependency==='server-only')return {}
    if(dependency==='node:crypto')return crypto
    if(dependency==='node:util')return util
    if(dependency==='./nativeEmailPublication'||dependency==='../crm/nativeEmailPublication')return load('nativeEmailPublication')
    if(dependency==='../crm/legacyEmailRetirementApproval')return load('legacyEmailRetirementApproval')
    throw new Error('Unexpected dependency '+dependency)
  },m,m.exports)
  modules.set(name,m.exports)
  return m.exports
}
const {nativeEmailCanonicalJson:json,nativeEmailDigest:hash}=load('nativeEmailPublication')
const {legacyEmailRetirementManifestDigest:digest,verifyLegacyEmailRetirementApproval:verify,
  legacyEmailTerminalHoldManifestDigest:holdDigest,verifyLegacyEmailTerminalHoldApproval:verifyHold}=load('legacyEmailRetirementApproval')
const fence=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const operator=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const nowSeconds=1783404000
const fixture=()=>({
  version:1,action:'archive_exact_legacy_terminal_rows_only',operationId:uid(1),publicationDisposition:'reviewed_recovery',
  scope:{projectId:uid(2),environmentId:uid(3),postgresDatabaseFingerprint:hash('pg'),appCommit:'a'.repeat(40),
    nativeDeploymentId:uid(4),nativeReplicaId:uid(5),nativeCommit:'b'.repeat(40),nativeDatabaseFingerprint:hash('maria')},
  actorEmail:'owner@work.example.invalid',operatorAccountId:uid(6),rootWorkspaceId:uid(7),appGeneration:5,
  gateFingerprint:hash('gate'),appSourceFingerprint:hash('app'),fenceEpoch:uid(8),fenceEvidenceFingerprint:hash('fence'),
  nativeAbsenceFingerprint:hash('absence'),historicalProviderOutcome:'unknown',
  rows:Array.from({length:11},(_,i)=>({outboxId:uid(20+i),localId:uid(40+i),pipelineId:uid(9),workspaceId:uid(7),
    nativeId:uid(60+i),globalId:'gi'+(1000000+i),attempts:8,rowFingerprint:hash(['row',i]),
    sourceFingerprint:hash(['source',i]),payloadFingerprint:hash(['payload',i]),keyFingerprint:hash(['key',i])})),
})
const wrap=(proof,key)=>({proof,signature:crypto.sign('sha256',Buffer.from(json(proof),'ascii'),
  {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
function request() {
  const expectedManifest=fixture(),manifestDigest=digest(expectedManifest),operationId=expectedManifest.operationId
  const common={version:1,audience:'clawpilot-private-legacy-email-retirement-controller',operationId,manifestDigest,
    issuedAt:nowSeconds-10,expiresAt:nowSeconds+30}
  const fenceEnvelope=wrap({...common,keyId:'fence-rsa',issuer:'clawpilot-crm-fence-attestor',
    purpose:'clawpilot-legacy-email-fenced-absence-v1'},fence.privateKey)
  const operatorEnvelope=wrap({...common,keyId:'review-rsa',issuer:'clawpilot-crm-retirement-operator',
    purpose:'clawpilot-legacy-email-retirement-review-v1',fenceEnvelopeDigest:hash(fenceEnvelope)},operator.privateKey)
  return {expectedManifest,fenceEnvelope,operatorEnvelope,fenceAnchor:{keyId:'fence-rsa',key:fence.publicKey},
    operatorAnchor:{keyId:'review-rsa',key:operator.publicKey},nowSeconds}
}
const held=(input,code)=>assert.throws(()=>verify(input),e=>e.code==='legacy_email_retirement_'+code)

test('two distinct real signatures verify only the eleven-row exact archive manifest',()=>{
  const r=request(),v=verify(r)
  assert.deepEqual(v,{manifestDigest:digest(r.expectedManifest),operationId:r.expectedManifest.operationId,
    fenceEnvelopeDigest:hash(r.fenceEnvelope),approvalEnvelopeDigest:hash(r.operatorEnvelope),expiresAt:nowSeconds+30,
    historicalProviderOutcome:'unknown',liveFenceProven:false,consumed:false})
  assert.ok(Object.isFrozen(v))
})
test('actual scope, generation, actor, fence, or any row drift invalidates previously valid signatures',()=>{
  for(const change of [
    m=>{m.scope.environmentId=uid(99)},m=>{m.scope.nativeReplicaId=uid(99)},m=>{m.scope.nativeDatabaseFingerprint=hash('other')},
    m=>{m.operationId=uid(99)},m=>{m.actorEmail='other@work.example.invalid'},m=>{m.appGeneration++},
    m=>{m.publicationDisposition='archive_only'},
    m=>{m.fenceEpoch=uid(99)},m=>{m.nativeAbsenceFingerprint=hash('other')},m=>{m.appSourceFingerprint=hash('other')},
    m=>{m.rows[0].payloadFingerprint=hash('other')},m=>{m.rows[0].pipelineId=uid(99)},m=>{m.rows.pop()},
  ]){
    const r=request()
    change(r.expectedManifest)
    held(r,'proof_binding')
  }
})
test('duplicates, unstable ordering, data additions and false historical claims fail before crypto',()=>{
  for(const [change,code] of [
    [m=>{m.rows.reverse()},'exact_row_order'],[m=>{m.rows[1].localId=m.rows[0].localId},'duplicate_row_identity'],
    [m=>{m.rows[1].keyFingerprint=m.rows[0].keyFingerprint},'duplicate_row_identity'],
    [m=>{m.rows[0].attempts=0},'row_identity'],[m=>{m.rows[0].emailBody='not accepted'},'shape'],
    [m=>{m.historicalProviderOutcome='not_dispatched'},'manifest_domain'],
    [m=>{delete m.publicationDisposition},'shape'],[m=>{m.publicationDisposition='publish_automatically'},'manifest_domain'],
    [m=>{Object.defineProperty(m.rows[0],'globalId',{get:()=>{throw Error('must not run')}})},'shape'],
    [m=>{m.rows.extra='not accepted'},'exact_rows'],
  ]){
    const r=request()
    change(r.expectedManifest)
    held(r,code)
  }
})
test('wrong key, key reuse, altered signature and purpose swaps fail closed',()=>{
  let r=request()
  r.operatorAnchor.key=fence.publicKey
  held(r,'distinct_trust_anchors')
  r=request();r.operatorAnchor.keyId=r.fenceAnchor.keyId
  held(r,'distinct_trust_anchors')
  r=request();r.operatorAnchor.key=crypto.createPublicKey(fence.publicKey.export({format:'pem',type:'spki'}))
  held(r,'distinct_trust_anchors')
  r=request();r.operatorAnchor.key=operator.privateKey
  held(r,'trust_anchor')
  r=request();r.fenceEnvelope.signature=(r.fenceEnvelope.signature[0]==='A'?'B':'A')+r.fenceEnvelope.signature.slice(1)
  held(r,'signature')
  r=request();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,purpose:'clawpilot-native-email-initial-enrollment-approval'},operator.privateKey)
  held(r,'proof_binding')
  r=request();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,fenceEnvelopeDigest:hash('unrelated')},operator.privateKey)
  held(r,'proof_binding')
})
test('accessor and proxy inputs cannot substitute a different key after the fingerprint check',()=>{
  let r=request(),reads=0
  r.operatorEnvelope=wrap(r.operatorEnvelope.proof,fence.privateKey)
  Object.defineProperty(r.operatorAnchor,'key',{enumerable:true,get(){
    return ++reads<=4?operator.publicKey:fence.publicKey
  }})
  held(r,'shape');assert.equal(reads,0)
  r=request();r.operatorAnchor=new Proxy(r.operatorAnchor,{get(){throw Error('must not run')}})
  held(r,'shape')
  r=request();r.expectedManifest.rows=new Proxy(r.expectedManifest.rows,{get(target,key){return Reflect.get(target,key)}})
  held(r,'exact_rows')
  r=request();Object.defineProperty(r,'operatorAnchor',{enumerable:true,get(){throw Error('must not run')}})
  held(r,'shape')
})
test('stale or not-yet-valid proofs and reviews beyond the fence lifetime cannot authorize archive',()=>{
  let r=request();r.nowSeconds+=30
  held(r,'proof_expiry')
  r=request();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,issuedAt:nowSeconds+1},operator.privateKey)
  held(r,'proof_expiry')
  r=request();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,expiresAt:nowSeconds+31},operator.privateKey)
  held(r,'approval_window')
  r=request();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,issuedAt:nowSeconds-11},operator.privateKey)
  held(r,'approval_window')
  r=request();r.fenceEnvelope=wrap({...r.fenceEnvelope.proof,issuedAt:nowSeconds-91},fence.privateKey)
  held(r,'proof_expiry')
})

const holdAudience='clawpilot-private-legacy-email-hold-controller'
function holdRequest() {
  const r=request(), expectedManifest=r.expectedManifest
  expectedManifest.action='hold_exact_legacy_terminal_rows_in_place'
  expectedManifest.publicationDisposition='hold_without_publication'
  expectedManifest.scope.nativeAuthorityInstanceId=uid(10)
  expectedManifest.rows=expectedManifest.rows.map((row,i)=>({...row,
    relationshipFingerprint:hash(['relationships',i]),providerIdentityFingerprint:hash(['provider identity',i])}))
  const common={...r.fenceEnvelope.proof,audience:holdAudience,manifestDigest:holdDigest(expectedManifest)}
  r.fenceEnvelope=wrap({...common,purpose:'clawpilot-legacy-email-hold-fenced-absence-v1',
    issuer:'clawpilot-crm-hold-fence-attestor'},fence.privateKey)
  r.operatorEnvelope=wrap({...common,keyId:'review-rsa',purpose:'clawpilot-legacy-email-hold-review-v1',
    issuer:'clawpilot-crm-hold-operator',fenceEnvelopeDigest:hash(r.fenceEnvelope)},operator.privateKey)
  return r
}
const holdRefused=(r,code)=>assert.throws(()=>verifyHold(r),e=>e.code==='legacy_email_retirement_'+code)

test('the exact eleven-job approval permits only an unconsumed hold, not publication or a live fence',()=>{
  const r=holdRequest(),v=verifyHold(r)
  assert.deepEqual(v,{manifestDigest:holdDigest(r.expectedManifest),operationId:r.expectedManifest.operationId,
    fenceEnvelopeDigest:hash(r.fenceEnvelope),approvalEnvelopeDigest:hash(r.operatorEnvelope),expiresAt:nowSeconds+30,
    historicalProviderOutcome:'unknown',liveFenceProven:false,consumed:false,
    kind:'legacy_email_terminal_hold_approval_v1',publicationDisposition:'hold_without_publication'})
  assert.ok(Object.isFrozen(v))
  held(r,'manifest_domain')
  holdRefused(request(),'manifest_domain')
})

test('hold proof binds the live identities, relationship and provider fingerprints, and every queue row',()=>{
  for(const change of [
    m=>{m.scope.appCommit='c'.repeat(40)},m=>{m.scope.postgresDatabaseFingerprint=hash('other pg')},
    m=>{m.scope.nativeDeploymentId=uid(99)},m=>{m.scope.nativeAuthorityInstanceId=uid(99)},
    m=>{m.operatorAccountId=uid(99)},m=>{m.rootWorkspaceId=uid(99)},
    m=>{m.appGeneration++},m=>{m.fenceEpoch=uid(99)},m=>{m.fenceEvidenceFingerprint=hash('other fence')},
    m=>{m.rows[0].relationshipFingerprint=hash('changed links')},m=>{m.rows[0].providerIdentityFingerprint=hash('changed source')},
    m=>{m.rows[0].rowFingerprint=hash('retry state changed')},m=>{m.rows[0].workspaceId=uid(99)},m=>{m.rows.pop()},
  ]){
    const r=holdRequest();change(r.expectedManifest);holdRefused(r,'proof_binding')
  }
  const r=holdRequest()
  delete r.expectedManifest.rows[0].relationshipFingerprint
  holdRefused(r,'shape')
})

test('retirement and hold proofs cannot be swapped even if resigned with the right keys and digest',()=>{
  for(const [make,foreign,refused] of [[holdRequest,request,holdRefused],[request,holdRequest,held]]){
    for(const swap of ['fence','operator','both']){
      const r=make(),other=foreign()
      if(swap!=='operator'){
        const {purpose,issuer,audience}=other.fenceEnvelope.proof
        r.fenceEnvelope=wrap({...r.fenceEnvelope.proof,purpose,issuer,audience},fence.privateKey)
      }
      const {purpose,issuer,audience}=swap==='fence'?r.operatorEnvelope.proof:other.operatorEnvelope.proof
      r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,purpose,issuer,audience,fenceEnvelopeDigest:hash(r.fenceEnvelope)},operator.privateKey)
      refused(r,'proof_binding')
    }
  }
})

test('hold requires independent anchors, a nested fresh approval, and no archive or publication disposition',()=>{
  let r=holdRequest();r.operatorAnchor.key=fence.publicKey
  holdRefused(r,'distinct_trust_anchors')
  r=holdRequest();r.nowSeconds+=30
  holdRefused(r,'proof_expiry')
  r=holdRequest();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,expiresAt:nowSeconds+31},operator.privateKey)
  holdRefused(r,'approval_window')
  r=holdRequest();r.operatorEnvelope=wrap({...r.operatorEnvelope.proof,fenceEnvelopeDigest:hash('different attestation')},operator.privateKey)
  holdRefused(r,'proof_binding')
  for(const disposition of ['archive_only','reviewed_recovery','publish_automatically']){
    r=holdRequest();r.expectedManifest.publicationDisposition=disposition
    holdRefused(r,'manifest_domain')
  }
})

const {holdExactLegacyEmailsPrivately:installHold,resolveExactLegacyEmailTerminalHoldPrivately:resolveHold}=load('crmLegacyEmailTerminalHold')
function privateFixture() {
  const {nowSeconds:_,...review}=holdRequest(),events=[]
  const control={controllerRole:'controller',attestorRole:'attestor',lostReply:false}
  const dependencies={
    async withLiveFence(manifest,run){assert.ok(Object.isFrozen(manifest.rows[0]));events.push('fence');return run()},
    expectedRoles:{attestor:'attestor',controller:'controller'},
    async retainResolutionPins(pins){assert.ok(Object.isFrozen(pins));events.push('journal')},
    async attestTransaction(run){const result=await run({async query(sql,values){
      if(sql.startsWith('SET LOCAL'))return {}
      if(sql.startsWith('SELECT session_user'))return {rows:[{login:control.attestorRole,role:control.attestorRole,second:nowSeconds}]}
      assert.match(sql,/INSERT INTO crm_legacy_email_terminal_hold\.verified_batch/u)
      assert.match(sql,/\$2::text::jsonb,\$2::text/u)
      assert.equal(hash(JSON.parse(values[1])),values[2]);events.push('attest');return {rowCount:1}
    }});events.push('attestor commit');return result},
    async holdTransaction(run){const result=await run({async query(sql,values){
      if(sql.startsWith('SET LOCAL'))return {}
      if(sql.startsWith('SELECT session_user'))return {rows:[{login:control.controllerRole,role:control.controllerRole}]}
      assert.match(sql,/^SELECT crm_legacy_email_terminal_hold\.hold\(/u)
      assert.deepEqual(values[1],fixture().rows.map(r=>r.outboxId));events.push('hold');return {rows:[{count:values[1].length}]}
    }});events.push('hold commit');if(control.lostReply)throw new Error('commit response lost');return result},
  }
  return {review,events,control,dependencies}
}

test('private hold snapshots before awaits and journals exact approved pins before either SQL write',async()=>{
  const f=privateFixture(),before=holdDigest(f.review.expectedManifest),withFence=f.dependencies.withLiveFence
  f.dependencies.withLiveFence=async (manifest,run)=>{
    f.review.expectedManifest.rows.reverse();f.review.fenceEnvelope.proof.issuedAt=0
    f.review.operatorAnchor.key=fence.publicKey
    return withFence(manifest,run)
  }
  const pins=await installHold(f.review,f.dependencies)
  assert.equal(pins.manifestDigest,before)
  assert.deepEqual(f.events,['fence','journal','attest','attestor commit','hold','hold commit'])
})

test('private hold fails closed without a direct role and resolves an uncertain commit without rewriting',async()=>{
  let f=privateFixture();f.control.attestorRole='controller'
  await assert.rejects(installHold(f.review,f.dependencies),{code:'legacy_terminal_hold_attestor_login_changed'})
  assert.deepEqual(f.events,['fence'])
  f=privateFixture();f.control.controllerRole='attestor'
  await assert.rejects(installHold(f.review,f.dependencies),{code:'legacy_terminal_hold_controller_login_changed'})
  assert.ok(!f.events.includes('hold'))
  f=privateFixture();f.control.lostReply=true
  let pins
  f.dependencies.retainResolutionPins=async value=>{pins=value;f.events.push('journal')}
  await assert.rejects(installHold(f.review,f.dependencies),/commit response lost/u)
  const exact={...pins,state:'committed',rows:11,receiptHash:hash('held receipt'),historicalProviderOutcome:'unknown'}
  const reader=async run=>run({async query(sql,values){assert.match(sql,/^SELECT crm_legacy_email_terminal_hold\.resolve\(/u)
    assert.deepEqual(values,[pins.operationId,pins.manifestDigest,pins.approvalDigest]);return {rows:[{receipt:exact}]}}})
  assert.deepEqual(await resolveHold(reader,pins),exact)
  assert.equal(f.events.filter(event=>event==='hold').length,1)
})

const {verifyLegacyHeldEmailRecoveryApproval:verifyHeldRecovery,
  assertVerifiedLegacyHeldEmailRecoveryApproval:assertHeldRecovery}=load('legacyHeldEmailRecoveryApproval')
function recoveryFixture(){
  const hold=holdRequest(),selected=hold.expectedManifest.rows[0]
  const proof={version:1,purpose:'clawpilot-private-legacy-held-email-recovery-v1',keyId:'review-rsa',
    issuedAt:nowSeconds-5,expiresAt:nowSeconds+30,holdBatchId:hold.expectedManifest.operationId,
    outboxId:selected.outboxId,localId:selected.localId,nativeId:selected.nativeId,globalId:selected.globalId,
    pipelineId:selected.pipelineId,workspaceId:selected.workspaceId,nativeAuthorityInstanceId:hold.expectedManifest.scope.nativeAuthorityInstanceId,
    lockToken:uid(200),holdReceiptHash:hash('one committed hold receipt'),originalFingerprint:selected.rowFingerprint,
    sourceFingerprint:selected.sourceFingerprint,relationshipFingerprint:selected.relationshipFingerprint,
    providerIdentityFingerprint:selected.providerIdentityFingerprint,activationReceiptHash:hash('exact authority activation'),
    stagedPayloadFingerprint:hash('exact postimage'),requestFingerprint:hash('native request'),nativeOperationId:hash('native operation'),
    generation:5,primaryAccountId:uid(201),accountIds:[uid(201),uid(202)]}
  return {envelope:wrap(proof,operator.privateKey),operatorAnchor:{keyId:'review-rsa',key:operator.publicKey},nowSeconds}
}
const refuseRecovery=(r,code)=>assert.throws(()=>verifyHeldRecovery(r),{code:'legacy_held_email_recovery_'+code})

test('one original job and the approved primary and additional account set are branded and immutable',()=>{
  const r=recoveryFixture(),first=verifyHeldRecovery(r)
  assertHeldRecovery(first)
  assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.accountIds))
  assert.equal(first.outboxId,r.envelope.proof.outboxId)
  assert.deepEqual(first.accountIds,[uid(201),uid(202)])
  assert.equal(Object.hasOwn(first,'retiredOutboxId'),false)
  assert.throws(()=>assertHeldRecovery(structuredClone(first)),{code:'legacy_held_email_recovery_unverified'})
  const renewed=verifyHeldRecovery({...r,envelope:wrap({...r.envelope.proof,expiresAt:nowSeconds+31},operator.privateKey)})
  assert.equal(renewed.intentHash,first.intentHash)
  assert.notEqual(renewed.approvalHash,first.approvalHash)
  const moved=verifyHeldRecovery({...r,envelope:wrap({...r.envelope.proof,primaryAccountId:uid(202)},operator.privateKey)})
  assert.notEqual(moved.intentHash,first.intentHash)
})

test('held-job recovery rejects archive and hold approvals, stale authority and any changed postimage or placement',()=>{
  const r=recoveryFixture()
  const release=load('legacyEmailRecoveryReleaseApproval')
  assert.throws(()=>release.verifyLegacyEmailRecoveryReleaseApproval(r),{code:'legacy_email_recovery_release_shape'})
  refuseRecovery({...r,envelope:holdRequest().operatorEnvelope},'shape')
  refuseRecovery({...r,envelope:wrap({...r.envelope.proof,purpose:'clawpilot-private-legacy-email-release-v1'},operator.privateKey)},'domain')
  refuseRecovery({...r,nowSeconds:nowSeconds+30},'expiry')
  refuseRecovery({...r,envelope:wrap({...r.envelope.proof,replacementOutboxId:uid(203)},operator.privateKey)},'shape')
  for(const fields of [{outboxId:uid(99)},{holdReceiptHash:hash('other hold')},{activationReceiptHash:hash('other authority')},
    {generation:6},{stagedPayloadFingerprint:hash('other postimage')},{relationshipFingerprint:hash('other contacts')},
    {providerIdentityFingerprint:hash('other source')},{requestFingerprint:hash('other request')},{primaryAccountId:uid(202)}]){
    refuseRecovery({...r,envelope:{...r.envelope,proof:{...r.envelope.proof,...fields}}},'signature')
  }
  for(const accountIds of [[uid(202)],[uid(201),uid(201)],[uid(202),uid(201)]]){
    refuseRecovery({...r,envelope:wrap({...r.envelope.proof,accountIds},operator.privateKey)},'accounts')
  }
  const array=[uid(201),uid(202)]
  Object.defineProperty(array,'0',{enumerable:true,get(){throw Error('must not run')}})
  refuseRecovery({...r,envelope:{...r.envelope,proof:{...r.envelope.proof,accountIds:array}}},'accounts')
})
