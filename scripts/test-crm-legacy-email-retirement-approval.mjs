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
  const source=readFileSync(new URL('../app_src/lib/crm/'+name+'.ts',import.meta.url),'utf8')
  const emitted=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  const m={exports:{}}
  new Function('require','module','exports',emitted)(dependency=>{
    if(dependency==='server-only')return {}
    if(dependency==='node:crypto')return crypto
    if(dependency==='node:util')return util
    assert.equal(dependency,'./nativeEmailPublication')
    return load('nativeEmailPublication')
  },m,m.exports)
  modules.set(name,m.exports)
  return m.exports
}
const {nativeEmailCanonicalJson:json,nativeEmailDigest:hash}=load('nativeEmailPublication')
const {legacyEmailRetirementManifestDigest:digest,verifyLegacyEmailRetirementApproval:verify}=load('legacyEmailRetirementApproval')
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
