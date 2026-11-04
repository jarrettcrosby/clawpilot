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
const protocol = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts')
const base = load('app_src/lib/crm/nativeEmailPublication.ts')
const audience = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const approvals = load('app_src/lib/crm/nativeEmailAuthorityApproval.ts')
const legacy = JSON.parse(execFileSync(process.execPath, ['scripts/test-native-email-authority-transition.mjs','--emit-fixture'],
  { cwd:root, encoding:'utf8' }))
const copy = value => JSON.parse(JSON.stringify(value))
const principals = ['native-owner','reader-a','reader-b','unrelated-user']
function policyHash(p) {
  const { historical, ...future } = p
  return base.nativeEmailDigest(future)
}
function installPolicy(binding, change = p => p) {
  const readers = JSON.parse(binding.readers_json)
  const p = change({ version:2,pipelineId:binding.pipeline_id,workspaceId:binding.workspace_id,
    ownerSuiteCrmId:binding.owner_id,audienceFingerprint:binding.audience_fingerprint,
    principalSuiteCrmUserIds:[...principals],
    futureCreate:{ view:[...readers],list:[...readers],export:[...readers],edit:[...readers],delete:[...readers] },historical:[] })
  // Deliberately valid noncanonical storage bytes, matching older native installs.
  binding.capability_policy_json = JSON.stringify(p, null, 1)
  binding.capability_policy_fingerprint = policyHash(p)
}
function editPolicy(binding, change) {
  const p = JSON.parse(binding.capability_policy_json); change(p)
  binding.capability_policy_json = JSON.stringify(p, null, 1)
  binding.capability_policy_fingerprint = policyHash(p)
}
function pins(command) {
  command.beforeBindingsFingerprint = base.nativeEmailDigest(command.bindings.map(x => x.before))
  command.afterBindingsFingerprint = base.nativeEmailDigest(command.bindings.map(x => x.after))
  return command
}
function input() {
  const { planHash, ...value } = copy(legacy.plan)
  for (const phase of ['revoke','grant']) {
    value[phase].version = 2
    for (const pair of value[phase].bindings) { installPolicy(pair.before); installPolicy(pair.after) }
    pins(value[phase])
  }
  return value
}
function receipt(command, state = 'committed') {
  const r = copy(command.phase === 'revoke' ? legacy.revokeReceipt : legacy.grantReceipt)
  r.version = command.version; r.commandHash = base.nativeEmailDigest(command); r.state = state
  r.operationId = command.operationId; r.transitionId = command.transitionId; r.phase = command.phase
  if (state === 'cancelled') r.result = null
  else {
    for (const k of ['desiredAppChangeHash','generationFrom','generationTo','beforePolicyFingerprint','afterPolicyFingerprint',
      'beforeBindingsFingerprint','afterBindingsFingerprint']) r.result[k] = command[k]
    r.result.capabilitiesFingerprint = base.nativeEmailDigest(command.capabilities.map(x => ({
      emailId:x.emailId,globalId:x.globalId,pipelineId:x.pipelineId,capabilities:x.after })))
  }
  return r
}
function invalidCommand(change, match) {
  const c = input().revoke; change(c); pins(c)
  assert.throws(() => protocol.prepareNativeEmailAuthorityCommand(c), match)
}
function v2Record(grant = false) {
  const plan = protocol.prepareNativeEmailAuthorityTransition(input())
  const r = { enabled:true,plan,revoke:{state:'prepared',receipt:null},grant:{state:'prepared',receipt:null},appCommit:null,grantApproval:null }
  if (grant) {
    r.revoke = { state:'committed',receipt:receipt(plan.revoke) }
    r.appCommit = { version:1,transitionId:plan.revoke.transitionId,planHash:plan.planHash,
      desiredAppChangeHash:plan.revoke.desiredAppChangeHash,revokeReceiptHash:protocol.nativeEmailAuthorityReceiptHash(r.revoke.receipt),
      appAuthorityBeforeFingerprint:plan.expectedAppAuthorityBeforeFingerprint,appAuthorityAfterFingerprint:plan.expectedAppAuthorityAfterFingerprint }
  }
  return r
}
if (process.argv.includes('--emit-fixture')) {
  const plan = protocol.prepareNativeEmailAuthorityTransition(input())
  console.log(JSON.stringify({ plan,revokeReceipt:receipt(plan.revoke),grantReceipt:receipt(plan.grant) }))
  process.exit(0)
}
let checks = 0
async function check(label, run) { await run(); checks++; console.log('PASS ' + label) }
await check('v1 exact ten-column bindings, fixture hashes and receipts remain unchanged', () => {
  const { planHash, ...value } = legacy.plan
  assert.deepEqual(protocol.prepareNativeEmailAuthorityTransition(value),legacy.plan)
  assert.equal(base.nativeEmailDigest(value),planHash)
  for (const phase of ['revoke','grant']) {
    assert.equal(Object.keys(value[phase].bindings[0].before).length,10)
    assert.deepEqual(protocol.verifyNativeEmailAuthorityReceipt(protocol.prepareNativeEmailAuthorityCommand(value[phase]),legacy[phase+'Receipt']),legacy[phase+'Receipt'])
  }
})
await check('v2 preserves raw policy JSON and independent historical versus future write matrices', () => {
  const value = input(), plan = protocol.prepareNativeEmailAuthorityTransition(value)
  assert.equal(plan.revoke.bindings[0].before.capability_policy_json,value.revoke.bindings[0].before.capability_policy_json)
  assert.notEqual(value.revoke.bindings[0].before.capability_policy_json,base.nativeEmailCanonicalJson(JSON.parse(value.revoke.bindings[0].before.capability_policy_json)))
  assert.deepEqual(plan.revoke.capabilities[0].before.edit,['native-owner'])
  assert.deepEqual(JSON.parse(plan.revoke.bindings[0].before.capability_policy_json).futureCreate.edit,['native-owner','reader-a'])
  assert.ok(Object.isFrozen(plan.revoke.bindings[0].before))
  assert.notEqual(plan.revoke.bindings[0].before.capability_policy_fingerprint,plan.revoke.bindings[0].after.capability_policy_fingerprint)
})
await check('v2 requires exact twelve-column shape, paired nullable policies and unchanged mode', () => {
  for (const change of [c=>{delete c.bindings[0].before.capability_policy_json},c=>{c.bindings[0].before.extra=true},
    c=>{c.bindings[0].before.capability_policy_json=null},c=>{c.bindings[0].after.capability_policy_json=null;c.bindings[0].after.capability_policy_fingerprint=null},
    c=>{c.version=1},c=>{c.version=3}]) invalidCommand(change)
  const value = input()
  for (const phase of ['revoke','grant']) {
    for (const pair of value[phase].bindings) for (const stage of ['before','after']) {
      pair[stage].capability_policy_json=null;pair[stage].capability_policy_fingerprint=null
    }
    pins(value[phase])
  }
  assert.doesNotThrow(() => protocol.prepareNativeEmailAuthorityTransition(value))
})
await check('decoded policy identity, reader binding, hash and empty-history pins are mandatory', () => {
  for (const change of [p=>{p.pipelineId='00000000-0000-4000-8000-000000000099'},p=>{p.workspaceId='other'},
    p=>{p.ownerSuiteCrmId='reader-a'},p=>{p.audienceFingerprint='0'.repeat(64)},p=>{p.futureCreate.view=['native-owner']},
    p=>{p.historical=[{}]},p=>{p.extra=true}]) invalidCommand(c=>editPolicy(c.bindings[0].before,change))
  invalidCommand(c=>{c.bindings[0].before.capability_policy_json='not-json'},/policy_json/)
  invalidCommand(c=>{c.bindings[0].before.capability_policy_fingerprint='0'.repeat(64)},/policy_fingerprint/)
})
await check('complete principal inventory cannot drift across stages or between installed policies', () => {
  invalidCommand(c=>editPolicy(c.bindings[0].after,p=>{p.principalSuiteCrmUserIds.pop()}),/inventory_changed/)
  invalidCommand(c=>{
    const pair=copy(c.bindings[0])
    for (const stage of ['before','after']) {
      const b=pair[stage];b.pipeline_id='00000000-0000-4000-8000-000000000004';b.group_id='00000000-0000-4000-8000-000000000005'
      b.audience_fingerprint=audience.suiteCrmEmailAudienceFingerprint({ policy:'pipeline-internal',ownerSuiteCrmId:b.owner_id,
        allowedSuiteCrmUserIds:JSON.parse(b.readers_json),workspaceId:b.workspace_id,pipelineId:b.pipeline_id,fingerprint:'' })
      installPolicy(b,p=>{p.principalSuiteCrmUserIds.pop();return p})
    }
    c.bindings.push(pair)
  },/inventory_changed/)
})
await check('v2 future policy deltas preserve retained members and explicitly remove or add only changed readers', () => {
  invalidCommand(c=>editPolicy(c.bindings[0].after,p=>{p.futureCreate.edit=[]}),/retained_capability_changed/)
  const grant=input().grant
  editPolicy(grant.bindings[0].before,p=>{p.futureCreate.delete=[]});pins(grant)
  assert.throws(()=>protocol.prepareNativeEmailAuthorityCommand(grant),/retained_capability_changed/)
  const v=input();v.grant.version=1
  assert.throws(()=>protocol.prepareNativeEmailAuthorityTransition(v))
  const drift=input();editPolicy(drift.grant.bindings[0].before,p=>{p.principalSuiteCrmUserIds.pop()});pins(drift.grant)
  assert.throws(()=>protocol.prepareNativeEmailAuthorityTransition(drift))
})
await check('v2 historical matrices remain separate but cannot silently change retained editors', () => {
  invalidCommand(c=>{c.capabilities[0].after.edit=[]},/retained_capability_changed/)
  const c=input().grant;c.capabilities[0].before.delete=[]
  assert.throws(()=>protocol.prepareNativeEmailAuthorityCommand(c),/retained_capability_changed/)
  const v=input();v.grant.capabilities[0].after.edit.push('reader-b')
  assert.doesNotThrow(()=>protocol.prepareNativeEmailAuthorityTransition(v))
})
await check('v2 pending publication is explicitly held rather than normalized or cancelled implicitly', () => {
  invalidCommand(c=>{c.pendingPublicationCommand={version:2}},/v2_pending_publication_held/)
  const legacyCommand=copy(legacy.plan.revoke);legacyCommand.pendingPublicationCommand={version:2}
  assert.throws(()=>protocol.prepareNativeEmailAuthorityCommand(legacyCommand),/pending_publication_version/)
})
await check('versioned receipts bind policy-containing before/after fingerprints and historical matrices', () => {
  const request=protocol.prepareNativeEmailAuthorityCommand(input().revoke),valid=receipt(request.command)
  assert.deepEqual(protocol.verifyNativeEmailAuthorityReceipt(request,valid),valid)
  assert.doesNotThrow(()=>protocol.verifyNativeEmailAuthorityReceipt(request,receipt(request.command,'cancelled')))
  for (const change of [r=>{r.version=1},r=>{r.result.afterBindingsFingerprint='0'.repeat(64)},
    r=>{r.result.beforeBindingsFingerprint='0'.repeat(64)},r=>{r.result.capabilitiesFingerprint='0'.repeat(64)}]) {
    const r=copy(valid);change(r);assert.throws(()=>protocol.verifyNativeEmailAuthorityReceipt(request,r))
  }
  const cancelled=receipt(request.command,'cancelled');cancelled.version=1
  assert.throws(()=>protocol.verifyNativeEmailAuthorityReceipt(request,cancelled))
})
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa',{modulusLength:3072})
const config={privateKey,keyId:'synthetic-v2',nativeInstanceId:'synthetic-native',serviceUserId:'native-owner',oauthClientId:'synthetic-client'}
function issuerHarness(record, returned = x => x) {
  let saved=null,created=0,now=1793386800000
  const issuer=approvals.createNativeEmailAuthorityApprovalIssuer({issueApproval:async(id,phase,create)=>{
    assert.equal(id,record.plan.revoke.transitionId)
    if (!saved) { saved=create(copy(record));created++ }
    return returned(copy(saved))
  }},config,()=>now)
  return {issue:phase=>issuer.issue(record.plan.revoke.transitionId,phase),advance:()=>{now+=600000},created:()=>created}
}
await check('unchanged version-one approval proof signs exact v2 command and policy bytes', async () => {
  const record=v2Record(),h=issuerHarness(record),envelope=await h.issue('revoke')
  assert.equal(envelope.proof.version,1);assert.equal(envelope.proof.commandHash,base.nativeEmailDigest(record.plan.revoke))
  assert.equal(envelope.proof.planHash,record.plan.planHash)
  assert.equal(crypto.verify('sha256',Buffer.from(base.nativeEmailCanonicalJson(envelope.proof),'ascii'),
    {key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')),true)
  const changed=copy(record.plan.revoke)
  changed.bindings[0].before.capability_policy_json=base.nativeEmailCanonicalJson(JSON.parse(changed.bindings[0].before.capability_policy_json));pins(changed)
  assert.notEqual(base.nativeEmailDigest(changed),envelope.proof.commandHash)
  h.advance();assert.deepEqual(await h.issue('revoke'),envelope);assert.equal(h.created(),1)
  await assert.rejects(()=>issuerHarness(record,e=>{e.proof.commandHash='0'.repeat(64);return e}).issue('revoke'),/signature_invalid/)
})
await check('grant approval preserves version-one app commit and requires a committed version-two revoke receipt', async () => {
  const record=v2Record(true),envelope=await issuerHarness(record).issue('grant')
  assert.equal(envelope.proof.version,1);assert.equal(envelope.proof.appCommit.version,1)
  assert.deepEqual(envelope.proof.appCommit,record.appCommit)
  assert.equal(envelope.proof.revokeCommandHash,base.nativeEmailDigest(record.plan.revoke))
  record.revoke.receipt.version=1
  await assert.rejects(()=>issuerHarness(record).issue('grant'),/receipt_identity/)
})
console.log(`Native authority v2 passed ${checks} pure protocol/approval checks. No database, native execution or production authorization claimed.`)
