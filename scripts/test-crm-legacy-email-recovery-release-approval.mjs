#!/usr/bin/env node
// Synthetic keys only. No database, network, providers, or saved credentials.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as util from 'node:util'

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
const {verifyLegacyEmailRecoveryReleaseApproval:verify,assertVerifiedLegacyEmailRecoveryReleaseApproval:assertVerified}
  =load('legacyEmailRecoveryReleaseApproval')
const operator=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const other=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const now=1783404000
const proof=()=>({version:1,purpose:'clawpilot-private-legacy-email-release-v1',keyId:'review-rsa',
  holdId:uid(1),outboxId:uid(2),retiredOutboxId:uid(3),localId:uid(4),nativeId:uid(5),globalId:'gi1234567',
  pipelineId:uid(6),workspaceId:uid(7),sourceFingerprint:hash('source'),retirementReceiptHash:hash('retirement'),
  activationReceiptHash:hash('activation'),requestFingerprint:hash('request'),nativeOperationId:hash('native-operation'),
  issuedAt:now-10,expiresAt:now+30})
const sign=(p,key=operator.privateKey)=>({proof:p,signature:crypto.sign('sha256',Buffer.from(json(p),'ascii'),
  {key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')})
const request=(envelope=sign(proof()))=>({envelope,operatorAnchor:{keyId:'review-rsa',key:operator.publicKey},nowSeconds:now})
const hasCode=code=>error=>error.code==='legacy_email_recovery_release_'+code
const held=(input,code)=>assert.throws(()=>verify(input),hasCode(code))

test('exact signed release verifies and is branded, frozen, key-order independent, and detached from the wire',()=>{
  const r=request(),p=r.envelope.proof,v=verify(r)
  assert.match(v.intentHash,/^[a-f0-9]{64}$/)
  assert.deepEqual(v,{...p,intentHash:v.intentHash,approvalHash:hash(r.envelope)})
  assert.ok(Object.isFrozen(v))
  assert.doesNotThrow(()=>assertVerified(v))
  const reordered=Object.fromEntries(Object.entries(p).reverse())
  assert.deepEqual(verify(request({signature:r.envelope.signature,proof:reordered})),v)
  p.sourceFingerprint=hash('mutated after verify');r.envelope.signature='not the verified signature'
  assert.equal(v.sourceFingerprint,hash('source'))
  for(const forged of [{...v},structuredClone(v),new Proxy(v,{}),null,'verified',true])
    assert.throws(()=>assertVerified(forged),hasCode('unverified'))
})

test('renewed trust can approve the same intent, but not substitute a different exact source or command',()=>{
  const first=verify(request()),fresh={...proof(),keyId:'renewed-rsa',issuedAt:now+200,expiresAt:now+250}
  const renewed=p=>verify({envelope:sign(p,other.privateKey),operatorAnchor:{keyId:'renewed-rsa',key:other.publicKey},nowSeconds:now+220})
  const next=renewed(fresh)
  assert.equal(first.intentHash,next.intentHash)
  assert.notEqual(first.approvalHash,next.approvalHash)
  for(const field of ['sourceFingerprint','retirementReceiptHash','activationReceiptHash','requestFingerprint','nativeOperationId']) {
    assert.notEqual(renewed({...fresh,[field]:hash('replacement')}).intentHash,first.intentHash)
  }
})

test('every reviewed identity, source, activation, request and operation pin is signature-bound',()=>{
  const r=request()
  for(const key of ['holdId','outboxId','retiredOutboxId','localId','nativeId','pipelineId','workspaceId']) {
    held(request({...r.envelope,proof:{...r.envelope.proof,[key]:uid(99)}}),'signature')
  }
  for(const key of ['sourceFingerprint','retirementReceiptHash','activationReceiptHash','requestFingerprint','nativeOperationId']) {
    held(request({...r.envelope,proof:{...r.envelope.proof,[key]:hash('different')}}),'signature')
  }
  held(request({...r.envelope,proof:{...r.envelope.proof,globalId:'gi7654321'}}),'signature')
})

test('wrong trust key, short key, private key, wrong purpose and malformed signature fail closed',()=>{
  held(request(sign(proof(),other.privateKey)),'signature')
  const bad=request();bad.operatorAnchor.key=operator.privateKey
  held(bad,'trust_anchor')
  const short=crypto.generateKeyPairSync('rsa',{modulusLength:2048})
  const shortRequest=request();shortRequest.operatorAnchor.key=short.publicKey
  held(shortRequest,'trust_anchor')
  held(request(sign({...proof(),purpose:'clawpilot-legacy-email-retirement-review-v1'})),'domain')
  held(request(sign({...proof(),keyId:'different'})),'domain')
  const wrong=request();wrong.envelope.signature=wrong.envelope.signature.slice(0,-1)+'='
  held(wrong,'signature')
})

test('only current positive safe-integer windows of at most 120 seconds verify',()=>{
  const exact=request(sign({...proof(),issuedAt:now,expiresAt:now+120}))
  assert.equal(verify(exact).expiresAt,now+120)
  for(const p of [{issuedAt:now+1},{expiresAt:now},{issuedAt:now-91},{issuedAt:0}]) {
    held(request(sign({...proof(),...p})),'expiry')
  }
  for(const badClock of [0,NaN,1.5,Number.MAX_SAFE_INTEGER+1,String(now)]) {
    held({...request(),nowSeconds:badClock},'clock')
  }
})

test('rejects unknown fields, symbols, accessors, proxies and ambiguous or malformed identifiers',()=>{
  const r=request()
  held({...r,extra:true},'shape')
  held({...r,envelope:{...r.envelope,[Symbol('hidden')]:1}},'shape')
  held({...r,envelope:{...r.envelope,proof:new Proxy(r.envelope.proof,{get(){throw Error('must not run')}})}},'shape')
  let reads=0
  const accessor={...r.envelope.proof}
  Object.defineProperty(accessor,'outboxId',{enumerable:true,get(){reads++;return uid(2)}})
  held(request({...r.envelope,proof:accessor}),'shape')
  assert.equal(reads,0)
  held(request(sign({...proof(),outboxId:uid(3)})),'identity')
  held(request(sign({...proof(),globalId:'gi7654321\n'})),'identity')
  held(request(sign({...proof(),requestFingerprint:'F'.repeat(64)})),'fingerprint')
})

test('the anchored actual key is snapshotted without calling caller-supplied export or key metadata',()=>{
  const r=request(sign(proof(),other.privateKey))
  const wrapped=structuredClone(operator.publicKey)
  let reads=0
  for(const key of ['export','type','asymmetricKeyType','asymmetricKeyDetails']) {
    Object.defineProperty(wrapped,key,{get(){reads++;throw Error('must not read caller override')}})
  }
  r.operatorAnchor.key=wrapped
  held(r,'signature')
  assert.doesNotThrow(()=>verify({...r,envelope:sign(proof())}))
  assert.equal(reads,0)
})
