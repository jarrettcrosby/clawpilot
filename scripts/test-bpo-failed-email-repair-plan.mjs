import assert from 'node:assert/strict'
import test from 'node:test'
import { describeBpoFailedEmailRepairInventory, planBpoFailedEmailRepair } from './lib/bpo-failed-email-repair-plan.mjs'

const workspaceId = 'c6c49765-9bf6-4223-9261-7553499f5d92', pipelineId = '587c8746-ecf6-40ae-8c50-e456f99ad555'
const hex = n=>n.toString(16).padStart(64,'0')
const uuid = n=>`fac795d8-ec53-4da8-86b8-${String(n).padStart(12,'0')}`
const slots = Array.from({length:19},(_,i)=>({interactionId:uuid(i+1),jobId:uuid(i+30),nativeId:uuid(i+60),
  globalId:`gi${String(i+1).padStart(7,'0')}`,providerMessageId:i === 18 ? null : `fixture-${i}`,
  interactionFingerprint:hex(i+100),jobFingerprint:hex(i+200),preimageFingerprint:hex(i+300),projectionFingerprint:hex(i+400)}))
const zero = {emailText:0,emailCustom:0,relationships:0,addressLinks:0,reverseLinks:0,notes:0,folderLinks:0,securityGroupLinks:0,scopedGrants:0}
const noReceipt = {state:'absent',fingerprint:null,projectionFingerprint:null}
const review = {workspaceId,pipelineId,app:{originFingerprint:hex(1),deploymentFingerprint:hex(2)},
  suiteCrm:{originFingerprint:hex(3),deploymentFingerprint:hex(4)},original11:slots.slice(0,11),later8:slots.slice(11)}
const inventory = describeBpoFailedEmailRepairInventory(review)

function input() {
  return structuredClone({review,expectedInventoryFingerprint:inventory,
    appReadback:{...review.app,readOnly:true,rows:slots.map(slot=>({...slot,workspaceId,pipelineId,syncStatus:'failed',
      terminalLatestJob:true,unclaimed:true,uniqueIdentity:true}))},
    nativeReadback:{...review.suiteCrm,readOnly:true,rows:slots.map(({interactionId,nativeId,globalId})=>({interactionId,nativeId,globalId,
      coverage:'exact-id-collated-global-aliases-deleted-and-sidecars',byNativeId:[],byGlobalId:[],sidecars:{...zero},receipt:{...noReceipt}}))}})
}

function exactExisting(args,index,withReceipt) {
  const slot = slots[index], row = args.nativeReadback.rows[index]
  row.byNativeId = [{nativeId:slot.nativeId,globalId:slot.globalId,deleted:false,projectionFingerprint:slot.projectionFingerprint}]
  row.byGlobalId = [{nativeId:slot.nativeId,globalId:slot.globalId}]
  row.sidecars = {...zero,emailText:1,emailCustom:1,relationships:3,addressLinks:1}
  if (withReceipt) row.receipt = {state:'committed',fingerprint:hex(499),projectionFingerprint:slot.projectionFingerprint}
  return row
}

test('exact independently pinned 11+8 diagnostic leaves exact native records alone and proposes only proven-absent slots',()=>{
  const args = input()
  exactExisting(args,0,true); exactExisting(args,11,false)
  const before = structuredClone(args), result = planBpoFailedEmailRepair(args)
  assert.deepEqual(args,before)
  assert.equal(result.diagnosticOnly,true); assert.equal(result.writeAuthorized,false)
  assert.equal(result.records.filter(row=>row.cohort==='original-11').length,11)
  assert.equal(result.records.filter(row=>row.cohort==='later-8').length,8)
  assert.deepEqual(result.records.filter(row=>row.disposition==='receipt-only-exact').map(row=>row.reason),
    ['exact_native_projection_and_receipt','exact_native_projection_without_receipt'])
  assert.equal(result.records.filter(row=>row.disposition==='create-candidate-proven-absent').length,17)
  assert.match(result.planFingerprint,/^[a-f0-9]{64}$/u)
  args.review.original11.reverse(); args.review.later8.reverse(); args.appReadback.rows.reverse(); args.nativeReadback.rows.reverse()
  assert.deepEqual(planBpoFailedEmailRepair(args),result)
  assert.ok(!JSON.stringify(result).includes(slots[0].projectionFingerprint) && !JSON.stringify(result).includes(slots[0].providerMessageId))
})

test('rejects cohort relabeling, duplicate identities, non-BPO pins and unpinned readback',()=>{
  const rejects = (mutate,expected)=>{const args=input();mutate(args);assert.throws(()=>planBpoFailedEmailRepair(args),expected)}
  rejects(a=>{a.review.original11.pop()},/exact_cohorts_required/u)
  rejects(a=>{[a.review.original11[0],a.review.later8[0]]=[a.review.later8[0],a.review.original11[0]]},/independent_inventory_pin/u)
  rejects(a=>{a.review.original11[0].nativeId=a.review.original11[1].jobId},/duplicate_reviewed_identity/u)
  rejects(a=>{a.review.later8[0].providerMessageId='1a18e03ea586cd7e'},/reviewed_slot/u)
  rejects(a=>{a.review.later8[0].nativeId='49a36454-67c9-4792-a6d5-9cff0ed29447'},/reviewed_slot/u)
  rejects(a=>{a.review.pipelineId=uuid(999)},/exact_cohorts_required/u)
  rejects(a=>{a.review.suiteCrm.originFingerprint=a.review.app.originFingerprint},/distinct_database_origins/u)
  rejects(a=>{a.review.later8[0].preimageFingerprint=hex(999)},/independent_inventory_pin/u)
  rejects(a=>{a.appReadback.readOnly=false},/readback_origin_or_scope/u)
  rejects(a=>{a.nativeReadback.deploymentFingerprint=hex(999)},/readback_origin_or_scope/u)
  rejects(a=>{a.nativeReadback.rows.pop()},/readback_origin_or_scope/u)
  rejects(a=>{a.nativeReadback.rows[0].interactionId=a.nativeReadback.rows[1].interactionId},/readback_identity_set/u)
  rejects(a=>{a.nativeReadback.rows[0].sidecars.notes=-1},/native_readback_shape/u)
})

test('keeps aliases, partial rows, unknown outcomes, app drift and side effects on hold',()=>{
  for (const [mutate,expected] of [
    [a=>{a.nativeReadback.rows[0].byGlobalId.push({nativeId:uuid(999),globalId:slots[0].globalId})},'native_identity_alias'],
    [a=>{const r=exactExisting(a,0,false);r.byGlobalId.push({nativeId:r.nativeId,globalId:r.globalId+' '})},'native_identity_alias'],
    [a=>{a.nativeReadback.rows[0].sidecars.reverseLinks=1},'native_orphaned_sidecars'],
    [a=>{a.nativeReadback.rows[0].sidecars.scopedGrants=1},'native_orphaned_sidecars'],
    [a=>{a.nativeReadback.rows[0].receipt={state:'committed',fingerprint:hex(8),projectionFingerprint:slots[0].projectionFingerprint}},'receipt_without_native_record'],
    [a=>{a.nativeReadback.rows[0].receipt={state:'uncertain',fingerprint:null,projectionFingerprint:null}},'native_receipt_uncertain'],
    [a=>{const r=exactExisting(a,0,false);r.sidecars.emailText=0},'native_projection_partial'],
    [a=>{const r=exactExisting(a,0,false);r.byNativeId[0].deleted=true},'native_record_deleted'],
    [a=>{const r=exactExisting(a,0,false);r.byNativeId[0].projectionFingerprint=hex(19)},'native_projection_mismatch'],
    [a=>{const r=exactExisting(a,0,true);r.receipt.projectionFingerprint=hex(19)},'native_projection_mismatch'],
    [a=>{Object.assign(a.nativeReadback.rows[0],{coverage:'unknown',byNativeId:null,byGlobalId:null,sidecars:null,receipt:null})},'native_readback_unknown'],
    [a=>{a.nativeReadback.rows[0].globalId='gi0000999'},'native_scope_mismatch'],
    [a=>{a.appReadback.rows[0].jobFingerprint=hex(999)},'app_preimage_or_job_changed'],
    [a=>{a.appReadback.rows[0].terminalLatestJob=false},'app_preimage_or_job_changed'],
    [a=>{a.appReadback.rows[0].unclaimed=false},'app_preimage_or_job_changed'],
    [a=>{a.appReadback.rows[0].uniqueIdentity=false},'app_preimage_or_job_changed'],
  ]) {
    const args=input();mutate(args)
    const {records} = planBpoFailedEmailRepair(args)
    assert.deepEqual(records[0],{cohort:'original-11',interactionId:slots[0].interactionId,jobId:slots[0].jobId,disposition:'hold',reason:expected})
    assert.ok(records.slice(1).every(row=>row.disposition==='create-candidate-proven-absent'))
  }
})

test('an alias in one slot prevents treating another implicated slot as absent',()=>{
  const args=input()
  args.nativeReadback.rows[0].byGlobalId.push({nativeId:slots[11].nativeId,globalId:slots[0].globalId})
  const {records}=planBpoFailedEmailRepair(args)
  assert.deepEqual(records.filter(row=>row.disposition==='hold').map(row=>[row.interactionId,row.reason]),[
    [slots[0].interactionId,'native_cross_slot_identity_conflict'],[slots[11].interactionId,'native_cross_slot_identity_conflict']])
  assert.equal(records.filter(row=>row.disposition==='create-candidate-proven-absent').length,17)
})
