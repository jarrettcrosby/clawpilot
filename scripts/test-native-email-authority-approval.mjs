#!/usr/bin/env node
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(resolve(root, 'app_src/package.json'))('typescript')
const cache = new Map()
function load(path) {
  const filename = resolve(root, path)
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports:{} }; cache.set(filename, module)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require','module','exports',code)(name => name === 'node:crypto' ? crypto
    : load(resolve(dirname(filename), name + '.ts')), module, module.exports)
  return module.exports
}
const issuerApi = load('app_src/lib/crm/nativeEmailAuthorityApproval.ts')
const protocol = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts')
const base = load('app_src/lib/crm/nativeEmailPublication.ts')
const fixture = JSON.parse(execFileSync(process.execPath, ['scripts/test-native-email-authority-transition.mjs','--emit-fixture'],
  { cwd:root, encoding:'utf8' }))
const copy = value => JSON.parse(JSON.stringify(value))
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength:3072 })
const config = { privateKey, keyId:'synthetic-key', nativeInstanceId:'synthetic-native', serviceUserId:'1', oauthClientId:'synthetic-client' }
const now = process.argv.includes('--emit-fixture') ? Date.now() : 1793386800000
function record(grant = false) {
  const result = { enabled:true, plan:copy(fixture.plan), revoke:{ state:'prepared',receipt:null },
    grant:{ state:'prepared',receipt:null }, appCommit:null, grantApproval:null }
  if (grant) {
    result.revoke = { state:'committed',receipt:copy(fixture.revokeReceipt) }
    result.appCommit = { version:1, transitionId:result.plan.revoke.transitionId, planHash:result.plan.planHash,
      desiredAppChangeHash:result.plan.revoke.desiredAppChangeHash,
      revokeReceiptHash:protocol.nativeEmailAuthorityReceiptHash(result.revoke.receipt),
      appAuthorityBeforeFingerprint:result.plan.expectedAppAuthorityBeforeFingerprint,
      appAuthorityAfterFingerprint:result.plan.expectedAppAuthorityAfterFingerprint }
  }
  return result
}
function harness(input = record(), options = {}) {
  let saved = null, creations = 0, calls = 0, currentTime = now
  const store = { issueApproval:async(id, phase, create) => {
    calls++; assert.equal(id, input.plan.revoke.transitionId)
    if (options.deny) throw Error('synthetic authorization denied')
    if (!saved) {
      creations++
      const candidate = create(copy(input))
      if (options.commitFails) throw Error('synthetic commit failed')
      saved = candidate
    }
    return options.returnValue ? options.returnValue(copy(saved)) : copy(saved)
  } }
  const issuer = issuerApi.createNativeEmailAuthorityApprovalIssuer(store,
    { ...config, ttlSeconds:process.argv.includes('--emit-fixture') ? 300 : 120 }, () => currentTime)
  return { issue:phase => issuer.issue(input.plan.revoke.transitionId, phase), input, count:() => ({ creations,calls }),
    advance:ms => { currentTime += ms }, saved:() => copy(saved) }
}
if (process.argv.includes('--emit-fixture')) {
  const r = harness(), g = harness(record(true))
  const retry=record(true),grantAttempts=[]
  let previous=retry.plan.grant
  for(let ordinal=1;ordinal<=2;ordinal++){
    const cancelled={version:previous.version,operationId:previous.operationId,transitionId:previous.transitionId,
      phase:'grant',commandHash:base.nativeEmailDigest(previous),state:'cancelled',result:null,replayed:false}
    retry.grantAttempt={ordinal,originalOperationId:retry.plan.grant.operationId,originalCommandHash:base.nativeEmailDigest(retry.plan.grant),
      previousOperationId:previous.operationId,previousCommandHash:base.nativeEmailDigest(previous),
      previousCancellationReceiptHash:protocol.nativeEmailAuthorityReceiptHash(cancelled)}
    const command=protocol.nativeEmailAuthorityPhaseCommand(retry,'grant')
    grantAttempts.push({command,envelope:await harness(copy(retry)).issue('grant')});previous=command
  }
  console.log(JSON.stringify({ syntheticOnly:true, now:Math.floor(now/1000), publicKey:publicKey.export({ type:'spki',format:'pem' }),
    config:{ keyId:config.keyId,nativeInstanceId:config.nativeInstanceId,serviceUserId:config.serviceUserId,oauthClientId:config.oauthClientId },
    revoke:{ command:fixture.plan.revoke, envelope:await r.issue('revoke') },
    grant:{ command:fixture.plan.grant, envelope:await g.issue('grant'), revokeReceipt:fixture.revokeReceipt },grantAttempts }))
  process.exit(0)
}
let count = 0
async function check(label, run) { await run(); count++; console.log('PASS ' + label) }
await check('approval is signed only from store-provided immutable exact plan and destination', async() => {
  const h = harness(), e = await h.issue('revoke')
  assert.equal(e.proof.commandHash, base.nativeEmailDigest(fixture.plan.revoke)); assert.equal(e.proof.planHash, fixture.plan.planHash)
  assert.equal(e.proof.expiresAt - e.proof.issuedAt, 120); assert.equal(e.proof.appCommit, null)
  assert.equal(crypto.verify('sha256',Buffer.from(base.nativeEmailCanonicalJson(e.proof),'ascii'),
    { key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING },Buffer.from(e.signature,'base64')),true)
  assert.equal(JSON.stringify(e).includes('PRIVATE KEY'),false)
})
await check('store denial or failed commit cannot return an unpersisted signed approval', async() => {
  for (const options of [{ deny:true },{ commitFails:true }]) {
    const h = harness(record(), options); await assert.rejects(() => h.issue('revoke')); assert.equal(h.saved(),null)
  }
})
await check('retry returns exact persisted envelope even after expiry and never renews it', async() => {
  const h = harness(), e = await h.issue('revoke'); h.advance(600000)
  assert.deepEqual(await h.issue('revoke'),e); assert.deepEqual(h.count(),{ creations:1,calls:2 })
  e.proof.commandHash = '0'.repeat(64)
  assert.notEqual(h.saved().proof.commandHash,e.proof.commandHash)
})
await check('disabled changed plans dispatched cancelled or early grant states cannot be signed', async() => {
  for (const mutate of [r=>{r.enabled=false},r=>{r.plan.planHash='0'.repeat(64)},r=>{r.revoke.state='dispatched'},
    r=>{r.revoke.state='cancelled'},r=>{r.plan.desiredAppChange.extra='unauthorized'}]) {
    const r=record(); mutate(r); await assert.rejects(() => harness(r).issue('revoke'))
  }
  await assert.rejects(() => harness().issue('grant'))
})
await check('grant binds exact committed app authority and normalized native revoke receipt', async() => {
  const r=record(true), e=await harness(r).issue('grant')
  assert.deepEqual(e.proof.appCommit,r.appCommit); assert.equal(e.proof.revokeOperationId,r.plan.revoke.operationId)
  r.revoke.receipt.replayed=true
  assert.deepEqual((await harness(r).issue('grant')).proof,e.proof)
  for (const key of ['planHash','revokeReceiptHash','appAuthorityBeforeFingerprint','appAuthorityAfterFingerprint','desiredAppChangeHash']) {
    const invalid=record(true); invalid.appCommit[key]='0'.repeat(64)
    await assert.rejects(() => harness(invalid).issue('grant'))
  }
})
await check('grant retry signs a new operation while retaining original plan app commit and exact cancelled parent',async()=>{
  const r=record(true),original=copy(r.plan.grant)
  const cancelled={version:original.version,operationId:original.operationId,transitionId:original.transitionId,
    phase:'grant',commandHash:base.nativeEmailDigest(original),state:'cancelled',result:null,replayed:false}
  r.grantAttempt={ordinal:1,originalOperationId:original.operationId,originalCommandHash:base.nativeEmailDigest(original),
    previousOperationId:original.operationId,previousCommandHash:base.nativeEmailDigest(original),
    previousCancellationReceiptHash:protocol.nativeEmailAuthorityReceiptHash(cancelled)}
  const command=protocol.nativeEmailAuthorityPhaseCommand(r,'grant'),h=harness(r),e=await h.issue('grant')
  assert.equal(e.proof.version,2);assert.deepEqual(e.proof.grantAttempt,r.grantAttempt)
  assert.equal(e.proof.operationId,command.operationId);assert.equal(e.proof.commandHash,base.nativeEmailDigest(command))
  assert.notEqual(command.operationId,original.operationId);assert.deepEqual({...command,operationId:original.operationId},original)
  assert.equal(e.proof.planHash,r.plan.planHash);assert.deepEqual(e.proof.appCommit,r.appCommit)
  h.advance(600000);assert.deepEqual(await h.issue('grant'),e)
  for(const edit of [x=>{x.grantAttempt.ordinal=0},x=>{x.grantAttempt.ordinal=Number.MAX_SAFE_INTEGER+1},
    x=>{x.grantAttempt.originalCommandHash='0'.repeat(64)},x=>{x.grantAttempt.previousCommandHash='0'.repeat(64)},
    x=>{x.grantAttempt.previousCancellationReceiptHash='0'.repeat(64)},x=>{x.grantAttempt.previousOperationId='0'.repeat(64)},
    x=>{x.grantAttempt.extra=true}]){
    const bad=copy(r);edit(bad);await assert.rejects(()=>harness(bad).issue('grant'))
  }
  const second=copy(r);second.grantAttempt={...r.grantAttempt,ordinal:2,previousOperationId:command.operationId,
    previousCommandHash:base.nativeEmailDigest(command),previousCancellationReceiptHash:protocol.nativeEmailAuthorityReceiptHash({
      ...cancelled,operationId:command.operationId,commandHash:base.nativeEmailDigest(command)})}
  assert.notEqual((await harness(second).issue('grant')).proof.operationId,command.operationId)
})
await check('stored envelope cannot switch instance client phase scope algorithm or signature', async() => {
  for (const mutate of [e=>{e.proof.nativeInstanceId='another'},e=>{e.proof.oauthClientId='another'},
    e=>{e.proof.commandHash='0'.repeat(64)},e=>{e.proof.phase='grant'},e=>{e.proof.extra='unsigned'},
    e=>{e.signature='A'.repeat(512)},e=>{e.algorithm='none'}]) {
    await assert.rejects(() => harness(record(),{ returnValue:e=>{mutate(e);return e} }).issue('revoke'))
  }
})
await check('issuer refuses unsuitable key material identifiers and unbounded expiry', async() => {
  const store={ issueApproval:async()=>{throw Error('not reached')} }
  const weak=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey
  for (const changed of [{privateKey:publicKey},{privateKey:weak},{privateKey:'invalid'},{keyId:'bad\nkey'},
    {ttlSeconds:0},{ttlSeconds:301},{ttlSeconds:1.5},{serviceUserId:'x'.repeat(37)}])
    assert.throws(() => issuerApi.createNativeEmailAuthorityApprovalIssuer(store,{...config,...changed}))
})
console.log(`Native approval issuer passed ${count} local cryptographic/protocol checks. Store callbacks are synthetic; no PG/native provisioning or production authorization claimed.`)
