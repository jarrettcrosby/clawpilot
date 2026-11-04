#!/usr/bin/env node
// Actual coordinator module, deliberately synthetic store/native transports.
// This proves orchestration only; actual DAL and native gates are separate.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript'),cache=new Map()
function load(name){if(cache.has(name))return cache.get(name);const m={exports:{}}
 const code=ts.transpileModule(readFileSync(new URL('../app_src/lib/crm/'+name+'.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 new Function('require','module','exports',code)(id=>id==='server-only'?{}:id.startsWith('node:')?createRequire(import.meta.url)(id):load(id.slice(2)),m,m.exports)
 cache.set(name,m.exports);return m.exports}
const {NativeEmailInitialEnrollmentCoordinator:Coordinator}=load('nativeEmailInitialEnrollmentCoordinator')
const {NativeEmailPublicationHeld:Held}=load('nativeEmailPublication'),clone=v=>JSON.parse(JSON.stringify(v))
const op='1'.repeat(64),planHash='2'.repeat(64),receiptHash='3'.repeat(64)
function fixture(){
 const calls=[],state={status:'admitted',nowEpoch:1000,receiptHash:null,nativeState:null}
 const execution={plan:{operationId:op},planHash,nativeDelta:{purpose:'synthetic'},approval:{proof:{expiresAt:1010},signature:'synthetic'}}
 const store={async readExecution(id){assert.equal(id,op);calls.push('read');return {state:state.status,execution:clone(execution),receiptHash:state.receiptHash,nowEpoch:state.nowEpoch}},
  async markDispatched(id){assert.equal(id,op);assert.equal(state.status,'admitted');calls.push('dispatch');state.status='dispatched';return clone(execution)},
  async markUnknown(id){assert.equal(id,op);calls.push('unknown');if(!['activated','cancelled'].includes(state.status))state.status='unknown'},
  async resolveAndSettle(id,native){assert.equal(id,op);calls.push('settle');const value=await native.resolve(clone(execution))
   assert.ok(['committed','cancelled'].includes(value.state));state.status=value.state==='committed'?'activated':'cancelled';state.receiptHash=receiptHash
   return {state:state.status,receiptHash}}}
 const issuer={async issue(id,pin){assert.equal(id,op);assert.equal(pin,planHash);calls.push('issue');return clone(execution.approval)}}
 const native={async execute(value){assert.deepEqual(value,execution);assert.equal(state.status,'dispatched');calls.push('execute');state.nativeState='committed';return {untrusted:'ignored ack'}},
  async resolve(value){assert.deepEqual(value,execution);calls.push('resolve');assert.ok(state.nativeState,'synthetic missing native outcome');return {state:state.nativeState}},
  async cancelExpired(value){assert.deepEqual(value,execution);calls.push('cancel');assert.ok(state.nowEpoch>=1010);state.nativeState=state.nativeState??'cancelled';return {state:state.nativeState}}}
 return {calls,state,execution,store,issuer,native,coordinator:new Coordinator(store,issuer,native)}
}
let checks=0
async function check(label,fn){await fn();checks++;console.log('PASS '+label)}
await check('durable dispatch precedes native execution; acknowledgement never substitutes for fresh resolve',async()=>{
 const f=fixture(),result=await f.coordinator.execute(op,planHash)
 assert.deepEqual(result,{state:'activated',receiptHash})
 assert.deepEqual(f.calls,['issue','read','dispatch','execute','settle','resolve'])
})
await check('lost native COMMIT response records unknown then freshly resolves without executing again',async()=>{
 const f=fixture();f.native.execute=async()=>{f.calls.push('execute-lost-response');f.state.nativeState='committed';throw Error('PRIVATE_PROVIDER_SENTINEL')}
 assert.equal((await f.coordinator.execute(op,planHash)).state,'activated')
 assert.deepEqual(f.calls,['issue','read','dispatch','execute-lost-response','unknown','settle','resolve'])
})
await check('unknown response and failed fresh resolution retain barrier with sanitized failure',async()=>{
 const f=fixture();f.native.execute=async()=>{throw Error('PRIVATE_PROVIDER_SENTINEL')};f.native.resolve=async()=>{throw Error('PRIVATE_PROVIDER_SENTINEL')}
 await assert.rejects(f.coordinator.execute(op,planHash),e=>e instanceof Held&&e.code==='initial_operator_outcome_held'&&!e.message.includes('PRIVATE_PROVIDER_SENTINEL'))
 assert.equal(f.state.status,'unknown');assert.equal(f.state.receiptHash,null)
 await assert.rejects(f.coordinator.execute(op,planHash),e=>e.code==='initial_operator_resolve_existing_attempt')
 assert.equal(f.calls.filter(value=>value==='dispatch').length,1)
})
await check('resume only resolves the existing operation and does not renew or redispatch approval',async()=>{
 const f=fixture();f.state.status='unknown';f.state.nativeState='committed'
 assert.equal((await f.coordinator.resume(op)).state,'activated')
 assert.deepEqual(f.calls,['read','settle','resolve'])
 // Later ordinary generations may change all native state. Retained status
 // must not rerun/replay the original initial Email manifest on every resume.
 f.calls.length=0;f.native.resolve=async()=>{throw Error('Legitimate later generation')}
 assert.equal((await f.coordinator.resume(op)).receiptHash,receiptHash);assert.deepEqual(f.calls,['read'])
})
await check('explicit cancellation uses stored SQL clock, no early timer release and no commit reversal',async()=>{
 const f=fixture();await assert.rejects(f.coordinator.cancelExpired(op),e=>e.code==='initial_operator_approval_not_expired')
 assert.equal(f.state.status,'admitted');assert.deepEqual(f.calls,['read']);f.calls.length=0;f.state.nowEpoch=1010
 assert.equal((await f.coordinator.cancelExpired(op)).state,'cancelled')
 assert.deepEqual(f.calls,['read','dispatch','cancel','settle','resolve'])
 const committed=fixture();await committed.coordinator.execute(op,planHash);committed.calls.length=0;committed.state.nowEpoch=5000
 assert.equal((await committed.coordinator.cancelExpired(op)).state,'activated');assert.deepEqual(committed.calls,['read'])
})
await check('expired admission is not renewed; existing unknown cancellation never sends execute',async()=>{
 const f=fixture();f.state.nowEpoch=1010
 await assert.rejects(f.coordinator.execute(op,planHash),e=>e.code==='initial_operator_resolve_existing_attempt')
 assert.equal(f.state.status,'admitted');assert.ok(!f.calls.includes('dispatch'))
 f.state.status='unknown';f.calls.length=0
 assert.equal((await f.coordinator.cancelExpired(op)).state,'cancelled')
 assert.deepEqual(f.calls,['read','cancel','settle','resolve'])
})
await check('changed retained approval or dispatch command is refused without a native write',async()=>{
 const f=fixture();f.issuer.issue=async()=>({...clone(f.execution.approval),signature:'other'})
 await assert.rejects(f.coordinator.execute(op,planHash),e=>e.code==='initial_operator_approval_changed');assert.equal(f.state.status,'admitted')
 const changed=fixture(),dispatch=changed.store.markDispatched
 changed.store.markDispatched=async id=>({...await dispatch(id),planHash:'4'.repeat(64)})
 await assert.rejects(changed.coordinator.execute(op,planHash),e=>e.code==='initial_operator_execution_changed')
 assert.equal(changed.state.status,'dispatched');assert.ok(!changed.calls.includes('execute'))
})
await check('failed durable unknown recording cannot trigger retry, settlement or release',async()=>{
 const f=fixture();f.native.execute=async()=>{throw Error('synthetic transport loss')};f.store.markUnknown=async()=>{throw Error('synthetic SQL status loss')}
 await assert.rejects(f.coordinator.execute(op,planHash),e=>e.code==='initial_operator_barrier_status_held')
 assert.equal(f.state.status,'dispatched');assert.equal(f.state.receiptHash,null);assert.ok(!f.calls.includes('settle'))
})
console.log(`PASS ${checks} initial operator orchestration groups; synthetic store/native only, no SQL/native execution or production proof`)
