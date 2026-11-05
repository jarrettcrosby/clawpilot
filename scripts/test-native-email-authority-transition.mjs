#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)),'..')
const ts = createRequire(resolve(root,'app_src/package.json'))('typescript')
const cache = new Map()
function load(path) {
  const filename = resolve(root,path)
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports:{} }; cache.set(filename,module)
  const code = ts.transpileModule(readFileSync(filename,'utf8'),{ compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText
  new Function('require','module','exports',code)(name => name === 'node:crypto' ? { createHash }
    : load(resolve(dirname(filename),name+'.ts')),module,module.exports)
  return module.exports
}
const protocol = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts')
const base = load('app_src/lib/crm/nativeEmailPublication.ts')
const audience = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts')
const copy = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const pipelineId = uuid(1), owner = 'native-owner'
const change = { kind:'pipeline-membership-change',before:{ userId:'reader-a',access:'viewer' },after:{ userId:'reader-b',access:'viewer' } }
function binding(generation,readers,policy) {
  const b = { pipeline_id:pipelineId,workspace_id:uuid(2),group_id:uuid(3),generation:String(generation),owner_id:owner,
    readers_json:JSON.stringify(readers),audience_fingerprint:'',policy_fingerprint:hash(policy),runtime_fingerprint:hash('runtime'),enabled:'1' }
  b.audience_fingerprint = audience.suiteCrmEmailAudienceFingerprint({ policy:'pipeline-internal',ownerSuiteCrmId:owner,
    allowedSuiteCrmUserIds:readers,workspaceId:b.workspace_id,pipelineId,fingerprint:'' })
  return b
}
function caps(readers,writers = [owner]) { return { view:[...readers],list:[...readers],export:[...readers],edit:[...writers],delete:[...writers] } }
function member(id,user,deleted) { return { id,date_modified:'2026-10-30 18:00:00',deleted,securitygroup_id:uuid(3),user_id:user,primary_group:'0',noninheritable:'1' } }
function command(phase,before,after,beforeCaps,afterCaps,changes) {
  return { version:1,operationId:hash(phase),transitionId:hash('transition'),phase,
    generationFrom:Number(before.generation),generationTo:Number(after.generation),desiredAppChangeHash:base.nativeEmailDigest(change),
    beforePolicyFingerprint:before.policy_fingerprint,afterPolicyFingerprint:after.policy_fingerprint,
    beforeBindingsFingerprint:base.nativeEmailDigest([before]),afterBindingsFingerprint:base.nativeEmailDigest([after]),
    runtimeFingerprint:before.runtime_fingerprint,bindings:[{ before,after }],membershipChanges:changes,
    capabilities:[{ emailId:'email-native',globalId:'gi1234567',pipelineId,before:beforeCaps,after:afterCaps }],pendingPublicationCommand:null }
}
function input() {
  const before = binding(7,[owner,'reader-a'],'before'), middle = binding(8,[owner],'middle'), final = binding(9,[owner,'reader-b'],'after')
  return { version:1,desiredAppChange:copy(change),expectedAppAuthorityBeforeFingerprint:hash('app-before'),expectedAppAuthorityAfterFingerprint:hash('app-after'),
    revoke:command('revoke',before,middle,caps([owner,'reader-a']),caps([owner]),[{ before:member('membership-a','reader-a','0'),after:member('membership-a','reader-a','1') }]),
    grant:command('grant',middle,final,caps([owner]),caps([owner,'reader-b']),[{ before:null,after:member('membership-b','reader-b','0') }]) }
}
function receipt(command,state='committed',replayed=false) {
  return { version:1,operationId:command.operationId,transitionId:command.transitionId,phase:command.phase,commandHash:base.nativeEmailDigest(command),state,replayed,
    result:state === 'cancelled' ? null : { desiredAppChangeHash:command.desiredAppChangeHash,generationFrom:command.generationFrom,generationTo:command.generationTo,
      beforePolicyFingerprint:command.beforePolicyFingerprint,afterPolicyFingerprint:command.afterPolicyFingerprint,
      beforeBindingsFingerprint:command.beforeBindingsFingerprint,afterBindingsFingerprint:command.afterBindingsFingerprint,
      capabilitiesFingerprint:base.nativeEmailDigest(command.capabilities.map(entry=>({ emailId:entry.emailId,globalId:entry.globalId,pipelineId:entry.pipelineId,capabilities:entry.after }))),
      pendingPublicationTerminalReceipt:null } }
}
function harness(options={}) {
  let record = { enabled:options.enabled !== false,plan:protocol.prepareNativeEmailAuthorityTransition(input()),
    revoke:{ state:'prepared',receipt:null },grant:{ state:'prepared',receipt:null },appCommit:null,grantApproval:null }
  const calls = { execute:[],resolve:[],commit:0,unknown:0 }, claims = []
  const appReceipt = () => ({ version:1,transitionId:record.plan.revoke.transitionId,planHash:record.plan.planHash,
    desiredAppChangeHash:record.plan.revoke.desiredAppChangeHash,revokeReceiptHash:protocol.nativeEmailAuthorityReceiptHash(record.revoke.receipt),
    appAuthorityBeforeFingerprint:record.plan.expectedAppAuthorityBeforeFingerprint,appAuthorityAfterFingerprint:record.plan.expectedAppAuthorityAfterFingerprint })
  const store = {
    load:async()=>copy(record),
    claimPhase:async(id,phase,worker)=>{
      const action = record[phase].state==='prepared' ? 'execute' : 'resolve'
      record[phase].state='dispatched'; const claim={ owner:worker,fence:claims.length+1 }; claims.push(claim)
      return { record:copy(record),claim,action:options.forceExecute ? 'execute' : action }
    },
    markUnknown:async(id,phase)=>{ calls.unknown++;record[phase].state='unknown' },
    settlePhase:async(id,phase,claim,value)=>{
      assert.deepEqual(claim,claims.at(-1));record[phase]={ state:value.state,receipt:copy(value) }
      if(options.lostSettle && !options.lostSettleUsed){options.lostSettleUsed=true;throw new Error('lost settlement acknowledgement')}
      return copy(record)
    },
    commitAppChange:async(id,planHash)=>{
      calls.commit++;assert.equal(planHash,record.plan.planHash);assert.equal(record.revoke.state,'committed');assert.equal(record.appCommit,null)
      record.appCommit=appReceipt()
      if(options.lostAppCommit && !options.lostAppCommitUsed){options.lostAppCommitUsed=true;throw new Error('lost app commit acknowledgement')}
      return copy(record)
    },
  }
  const bridge = { execute:async command=>{calls.execute.push(copy(command));if(options.lostNative)throw new Error('lost native reply');return receipt(command)},
    resolveOrCancel:async command=>{calls.resolve.push(copy(command));return receipt(command,options.cancelResolve?'cancelled':'committed',true)} }
  return { calls,store,bridge,step:()=>protocol.createNativeEmailAuthorityTransitionCoordinator(store,bridge,'worker-one').step(record.plan.revoke.transitionId),
    record:()=>copy(record),mutate:fn=>fn(record),approve:()=>{record.grantApproval={ operationId:record.plan.grant.operationId,
      commandHash:base.nativeEmailDigest(record.plan.grant),appCommitFingerprint:base.nativeEmailDigest(record.appCommit) }} }
}
if (process.argv.includes('--emit-fixture')) {
  const plan=protocol.prepareNativeEmailAuthorityTransition(input())
  console.log(JSON.stringify({ plan,revokeReceipt:receipt(plan.revoke),grantReceipt:receipt(plan.grant) }))
  process.exit(0)
}
let checks=0
async function check(label,fn){await fn();checks++;console.log('PASS '+label)}
await check('exact wire commands/hash and immutable desired app change are prepared without mutation',()=>{
  const value=input(), plan=protocol.prepareNativeEmailAuthorityTransition(value)
  assert.equal(plan.revoke.desiredAppChangeHash,base.nativeEmailDigest(value.desiredAppChange))
  assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.revoke.bindings[0].after))
  value.desiredAppChange.after.userId='other';assert.equal(plan.desiredAppChange.after.userId,'reader-b')
  for(const phase of ['revoke','grant'])assert.equal(protocol.prepareNativeEmailAuthorityCommand(plan[phase]).commandHash,base.nativeEmailDigest(plan[phase]))
})
await check('changed identity, desired hash, generation, policy/runtime or full matrix chain is refused',()=>{
  for(const mutate of [x=>{x.grant.transitionId=hash('other')},x=>{x.desiredAppChange.after.userId='other'},
    x=>{x.grant.operationId=x.revoke.operationId},x=>{x.grant.generationFrom=7},x=>{x.grant.beforePolicyFingerprint=hash('other')},
    x=>{x.grant.capabilities=[]},x=>{x.grant.runtimeFingerprint=hash('other')},x=>{x.revoke.extra=true},
    x=>{x.revoke.capabilities[0].globalId='gi7654321'},x=>{x.revoke.membershipChanges[0].after.noninheritable='0'},
    x=>{x.grant.membershipChanges[0].after.date_modified='2026-02-30 00:00:00'}]){
    const value=input();mutate(value);assert.throws(()=>protocol.prepareNativeEmailAuthorityTransition(value))
  }
})
await check('write-capability downgrade requires exact intersection, even with unchanged read permissions',()=>{
  const value=input()
  value.revoke.capabilities[0].before.edit=[owner,'reader-a'];
  assert.doesNotThrow(()=>protocol.prepareNativeEmailAuthorityTransition(value))
  const malicious=input();malicious.revoke.capabilities[0].before.edit=[owner];malicious.revoke.capabilities[0].after.edit=[]
  malicious.grant.capabilities[0].before.edit=[];malicious.grant.capabilities[0].after.edit=[owner]
  assert.throws(()=>protocol.prepareNativeEmailAuthorityTransition(malicious),/intersection/)
})
await check('receipt binds exact operation, phase, policy, full capability digest and substantive replay outcome',()=>{
  const request=protocol.prepareNativeEmailAuthorityCommand(input().revoke),valid=receipt(request.command)
  assert.deepEqual(protocol.verifyNativeEmailAuthorityReceipt(request,valid),valid)
  assert.equal(protocol.nativeEmailAuthorityReceiptHash(valid),protocol.nativeEmailAuthorityReceiptHash({...valid,replayed:true}))
  for(const mutate of [x=>{x.commandHash=hash('wrong')},x=>{x.phase='grant'},x=>{x.result.capabilitiesFingerprint=hash('wrong')},
    x=>{x.result.desiredAppChangeHash=hash('wrong')},x=>{x.result.afterBindingsFingerprint=hash('wrong')},x=>{x.state='pending'},
    x=>{x.result.pendingPublicationTerminalReceipt={state:'committed'}},x=>{x.extra=true}]){
    const changed=copy(valid);mutate(changed);assert.throws(()=>protocol.verifyNativeEmailAuthorityReceipt(request,changed))
  }
  assert.doesNotThrow(()=>protocol.verifyNativeEmailAuthorityReceipt(request,receipt(request.command,'cancelled')))
})
await check('default-off mode performs no IO; revoke, app commit, approved grant execute in separate ordered steps',async()=>{
  const off=harness({enabled:false});assert.equal((await off.step()).state,'disabled');assert.equal(off.calls.execute.length,0)
  const h=harness();assert.equal((await h.step()).state,'revoked');assert.equal(h.calls.commit,0)
  assert.equal((await h.step()).state,'app_committed');assert.equal(h.calls.execute.length,1)
  assert.deepEqual(await h.step(),{state:'held',code:'authority_grant_approval_required'})
  h.approve();assert.equal((await h.step()).state,'complete');assert.equal(h.calls.commit,1)
  assert.deepEqual(h.calls.execute.map(x=>x.phase),['revoke','grant'])
  assert.equal((await h.step()).state,'complete');assert.equal(h.calls.execute.length,2)
})
await check('lost native outcome resolves identical stored command; never resends or commits app early',async()=>{
  const h=harness({lostNative:true});assert.equal((await h.step()).code,'authority_native_outcome_unknown')
  assert.equal(h.calls.commit,0);assert.equal((await h.step()).state,'revoked')
  assert.equal(h.calls.execute.length,1);assert.equal(h.calls.resolve.length,1)
  assert.deepEqual(h.calls.execute[0],h.calls.resolve[0])
  const bad=harness({lostNative:true,forceExecute:true});await bad.step();await assert.rejects(bad.step(),/must_resolve/)
  assert.equal(bad.calls.execute.length,1)
})
await check('lost app commit response is loaded from durable ledger and never reapplied',async()=>{
  const h=harness({lostAppCommit:true});await h.step();await assert.rejects(h.step(),/lost app commit/)
  assert.equal((await h.step()).code,'authority_grant_approval_required');assert.equal(h.calls.commit,1)
  h.approve();assert.equal((await h.step()).state,'complete');assert.equal(h.calls.commit,1)
})
await check('lost settlement response retains exact native receipt rather than re-executing',async()=>{
  const h=harness({lostSettle:true});await assert.rejects(h.step(),/lost settlement/)
  assert.equal((await h.step()).state,'app_committed');assert.equal(h.calls.execute.length,1);assert.equal(h.calls.resolve.length,0)
})
await check('cancelled phases retain restrictive hold; no app change, grant or rollback is invented',async()=>{
  const h=harness({lostNative:true,cancelResolve:true});await h.step()
  assert.equal((await h.step()).code,'authority_phase_cancelled');assert.equal((await h.step()).code,'authority_phase_cancelled')
  assert.equal(h.calls.commit,0);assert.equal(h.calls.execute.length,1)
})
await check('tampered app proof or grant approval cannot authorize a grant',async()=>{
  for(const mutate of [r=>{r.appCommit.desiredAppChangeHash=hash('other')},r=>{r.appCommit.revokeReceiptHash=hash('other')},
    r=>{r.appCommit.appAuthorityAfterFingerprint=hash('other')},r=>{r.grantApproval.appCommitFingerprint=hash('other')}]){
    const h=harness();await h.step();await h.step();h.approve();h.mutate(mutate);await assert.rejects(h.step());assert.equal(h.calls.execute.length,1)
  }
})
console.log(`Native authority transition passed ${checks} local protocol/coordinator checks. Persistence/approval callbacks are synthetic; no PG/native execution or production authority established.`)
