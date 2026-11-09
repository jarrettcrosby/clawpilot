#!/usr/bin/env node
// Operator sequencing only; the PostgreSQL and joined-native suites prove
// actual admission, permits, transaction boundaries, and receipt identity.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import test from 'node:test'

const ts=createRequire(new URL('../app_src/package.json',import.meta.url))('typescript')
const file=new URL('../app_src/lib/crm/nativeEmailRecoveryMaintenanceOperator.ts',import.meta.url)
const module={exports:{}}
const requireNativeEmail=(valid,code)=>{if(!valid)throw new Error(code)}
const deps={'server-only':{},'./nativeEmailPublication':{requireNativeEmail},'./nativeEmailPublicationTransport':{
  verifyNativeEmailPreparation:async (_command,execute)=>assert.equal(await execute(),'prepared'),
  verifyNativeEmailPublicationReceipt:(_request,value)=>{assert.equal(value,'receipt');return value},
}}
new Function('module','exports','require',ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
}}).outputText)(module,module.exports,name=>{assert.ok(Object.hasOwn(deps,name));return deps[name]})
const {createNativeEmailRecoveryMaintenanceOperator}=module.exports
const request={requestFingerprint:'synthetic-exact',command:{operationId:'exact-operation'}}
const lease={owner:'00000000-0000-4000-8000-000000000001',fence:1}
const item=Object.freeze({id:'exact-job'})

function fixture({active=false,state='not_admitted',publishError,commitWithoutAck=false,dropDuringCommit=false,
  allowsExistingAdmissionFirstPublish}={}) {
  const events=[]
  const persistence={
    allowsExistingAdmissionFirstPublish,
    mode:async()=>({enabled:true,activeTransitionId:null,activeOperationId:active?request.command.operationId:null}),
    loadItem:async()=>item,
    candidate:async selected=>{assert.equal(selected,item);return {request}},
    admit:async()=>assert.fail('initial controller must not admit ahead of readiness'),
    async withMaintenanceDispatch(selection,run){
      assert.ok(['prepare','resolve'].includes(selection.action));events.push(`fence:${selection.action}`)
      return run({request,permit:{action:selection.action}})
    },
    async withMaintenanceInitialPublish(selected,expected,owner,run){
      assert.equal(selected,item);assert.equal(expected.request,request);assert.equal(owner,lease.owner)
      events.push('fence:initial')
      let acknowledged=false
      return run({request,authorize:async()=>{
        if(dropDuringCommit)await new Promise(resolve=>setImmediate(resolve))
        events.push('atomic:commit');state='dispatched'
        if(commitWithoutAck)throw new Error('commit_ack_lost')
        acknowledged=true
      }},()=>acknowledged?lease:null)
    },
    async withMaintenancePublish(selected,claimed,run){
      assert.equal(selected,request);assert.equal(claimed,lease);events.push('fence:admitted')
      return run({request,authorize:async()=>{events.push('dispatch:commit');state='dispatched'}})
    },
    async maintenancePublishState(selected){assert.equal(selected,request);events.push(`state:${state}`);return state},
    async markUnknown(id){assert.equal(id,request.command.operationId);events.push('mark:unknown')},
    async settle(selected,claimed,receipt){
      assert.equal(selected,request);assert.equal(claimed,lease);assert.equal(receipt,'receipt')
      events.push('settle');return 'settled'
    },
    async claimResolution(id,owner){assert.equal(id,request.command.operationId);assert.equal(owner,lease.owner)
      events.push('claim');return {admission:{request,state},lease}},
  }
  const operator=createNativeEmailRecoveryMaintenanceOperator({persistence,owner:lease.owner,
    exchange:async packet=>{assert.equal(packet.request,request);events.push(`native:${packet.permit.action}`)
      return packet.permit.action==='prepare'?'prepared':'receipt'},
    exchangePublish:async input=>{assert.equal(input.request,request);events.push('native:ready-attempt')
      if(publishError)throw publishError
      events.push('native:ready')
      if(dropDuringCommit){void input.authorize();events.push('native:child-lost');throw new Error('child_lost')}
      await input.authorize();events.push('native:publish');return 'receipt'},
  })
  return {operator,events}
}

test('a failed readiness check leaves the exact job unadmitted without recording an unknown dispatch',async()=>{
  const error=new Error('ready_rejected'),f=fixture({publishError:error})
  await assert.rejects(f.operator.publish(),candidate=>candidate===error)
  assert.deepEqual(f.events,['fence:prepare','native:prepare','fence:initial','native:ready-attempt','state:not_admitted'])
})
test('initial dispatch settles only with a lease acknowledged after the atomic commit',async()=>{
  const f=fixture()
  assert.equal(await f.operator.publish(),'settled')
  assert.deepEqual(f.events,['fence:prepare','native:prepare','fence:initial','native:ready-attempt','native:ready','atomic:commit','native:publish','settle'])
})
test('lost commit acknowledgement never resends and records exact dispatched state as unknown',async()=>{
  const f=fixture({commitWithoutAck:true})
  await assert.rejects(f.operator.publish(),/native_outcome_unknown/u)
  assert.deepEqual(f.events,['fence:prepare','native:prepare','fence:initial','native:ready-attempt','native:ready','atomic:commit','state:dispatched','mark:unknown'])
})
test('a child that exits during authorization waits for the commit before reading durable state',async()=>{
  const f=fixture({dropDuringCommit:true})
  await assert.rejects(f.operator.publish(),/native_outcome_unknown/u)
  assert.deepEqual(f.events,['fence:prepare','native:prepare','fence:initial','native:ready-attempt','native:ready',
    'native:child-lost','atomic:commit','state:dispatched','mark:unknown'])
})
test('legacy admitted compatibility does not prepare twice and unsent items cannot be resolved',async()=>{
  const f=fixture({active:true,state:'admitted'})
  await assert.rejects(f.operator.resolve(),/legacy_dispatch_publish_not_sent/u)
  assert.equal(await f.operator.publish(),'settled')
  assert.deepEqual(f.events,['claim','claim','fence:admitted','native:ready-attempt','native:ready','dispatch:commit','native:publish','settle'])
})
test('an uncertain dispatch cannot publish again and resolves through its exact lease',async()=>{
  const f=fixture({active:true,state:'unknown'})
  await assert.rejects(f.operator.publish(),/native_publication_not_available/u)
  assert.equal(await f.operator.resolve(),'settled')
  assert.deepEqual(f.events,['claim','claim','fence:resolve','native:resolve','settle'])
})
test('a held original cannot publish an existing admission and can only resolve a dispatched operation',async()=>{
  for(const state of ['admitted','dispatched']){
    const f=fixture({active:true,state,allowsExistingAdmissionFirstPublish:false})
    await assert.rejects(f.operator.publish(),/legacy_dispatch_resolution_required/u)
    assert.deepEqual(f.events,[],'Refuse before claiming a lease or contacting the native transport')
    if(state==='dispatched'){
      assert.equal(await f.operator.resolve(),'settled')
      assert.deepEqual(f.events,['claim','fence:resolve','native:resolve','settle'])
    }
  }
})
