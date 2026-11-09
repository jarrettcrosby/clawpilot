import { createHash } from 'node:crypto'

const WORKSPACE = 'c6c49765-9bf6-4223-9261-7553499f5d92'
const PIPELINE = '587c8746-ecf6-40ae-8c50-e456f99ad555'
const RESERVED = new Set(['9cc8284b-bb63-4b81-8cb1-303ad5cb3540','49a36454-67c9-4792-a6d5-9cff0ed29447',
  '0686578b-6593-562b-ad30-cba14b714762','1ee4618a-a604-58b4-9bec-03cb8fe3da35','7d9c55b5-a30d-517e-b160-6bce99a5075b',
  '9ee99c44-e206-58f3-bc11-9474caa38db6','d813b0b2-5933-52bc-bc27-34fb6c721b2f'])
const REVIEWED_GMAIL = new Set(['1a17e730c78d319c','1a17f5004f29592c','1a17f5d46a224e0a','1a18e03ea586cd7e','1a18f01749eb87a6'])
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const GLOBAL = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const SHA = /^[a-f0-9]{64}(?![\s\S])/u
const PROVIDER = /^[a-z0-9_-]{1,128}(?![\s\S])/u
const pinKeys = ['interactionId','jobId','nativeId','globalId','providerMessageId','interactionFingerprint','jobFingerprint','preimageFingerprint','projectionFingerprint']
const sidecars = ['emailText','emailCustom','relationships','addressLinks','reverseLinks','notes','folderLinks','securityGroupLinks','scopedGrants']
const nativeKeys = ['interactionId','nativeId','globalId','coverage','byNativeId','byGlobalId','sidecars','receipt']
const coverage = 'exact-id-collated-global-aliases-deleted-and-sidecars'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const match = (value,re) => typeof value === 'string' && re.test(value)
const need = (ok,why) => { if (!ok) throw new Error(`Exact BPO failed Email repair plan held: ${why}`) }
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key))

function origin(value) {
  need(exact(value,['originFingerprint','deploymentFingerprint']) && Object.values(value).every(x=>match(x,SHA)), 'origin_pin')
  return { originFingerprint:value.originFingerprint,deploymentFingerprint:value.deploymentFingerprint }
}

function normalize(review) {
  need(exact(review,['workspaceId','pipelineId','app','suiteCrm','original11','later8']) && review.workspaceId === WORKSPACE
    && review.pipelineId === PIPELINE && Array.isArray(review.original11) && review.original11.length === 11
    && Array.isArray(review.later8) && review.later8.length === 8,'exact_cohorts_required')
  const pins = (rows,cohort) => [...rows].map(row=>{
    need(exact(row,pinKeys) && ['interactionId','jobId','nativeId'].every(key=>match(row[key],UUID) && !RESERVED.has(row[key]))
      && match(row.globalId,GLOBAL) && row.globalId !== 'gi3ti7iqfht2mb'
      && (row.providerMessageId === null || (match(row.providerMessageId,PROVIDER) && !REVIEWED_GMAIL.has(row.providerMessageId)))
      && pinKeys.slice(5).every(key=>match(row[key],SHA)),'reviewed_slot')
    return {cohort,...Object.fromEntries(pinKeys.map(key=>[key,row[key]]))}
  }).sort((a,b)=>a.interactionId < b.interactionId ? -1 : 1)
  const rows = [...pins(review.original11,'original-11'),...pins(review.later8,'later-8')]
  const allIds = rows.flatMap(row=>[row.interactionId,row.jobId,row.nativeId])
  const providers = rows.map(row=>row.providerMessageId).filter(id=>id!==null)
  need(new Set(allIds).size === allIds.length && new Set(rows.map(row=>row.globalId)).size === rows.length
    && new Set(providers).size === providers.length,'duplicate_reviewed_identity')
  const app = origin(review.app), suiteCrm = origin(review.suiteCrm)
  need(app.originFingerprint!==suiteCrm.originFingerprint,'distinct_database_origins')
  return {workspaceId:WORKSPACE,pipelineId:PIPELINE,app,suiteCrm,rows}
}

/** Domain digest of independently reviewed cohort/identity and deployment pins.
 * Compute outside the observation path; do not derive approval from live rows. */
export function describeBpoFailedEmailRepairInventory(review) {
  return digest(['clawpilot-bpo-failed-email-inventory-19-v1',normalize(review)])
}

function observation(value,expected,slots) {
  need(exact(value,['originFingerprint','deploymentFingerprint','readOnly','rows']) && value.readOnly === true
    && value.originFingerprint === expected.originFingerprint && value.deploymentFingerprint === expected.deploymentFingerprint
    && Array.isArray(value.rows) && value.rows.length === 19,'readback_origin_or_scope')
  const found = new Map()
  for (const row of value.rows) {
    need(slots.has(row?.interactionId) && !found.has(row.interactionId),'readback_identity_set')
    found.set(row.interactionId,row)
  }
  return found
}

function nativeOutcome(row,pin) {
  need(exact(row,nativeKeys) && ['unknown',coverage].includes(row.coverage),'native_observation_shape')
  if (row.nativeId !== pin.nativeId || row.globalId !== pin.globalId) return ['hold','native_scope_mismatch']
  if (row.coverage === 'unknown') {
    need(['byNativeId','byGlobalId','sidecars','receipt'].every(key=>row[key]===null),'unknown_native_evidence')
    return ['hold','native_readback_unknown']
  }
  const {byNativeId,byGlobalId,sidecars:owned,receipt} = row
  need(Array.isArray(byNativeId) && byNativeId.length <= 20 && Array.isArray(byGlobalId) && byGlobalId.length <= 20
    && byNativeId.every(record=>exact(record,['nativeId','globalId','deleted','projectionFingerprint']) && match(record.nativeId,UUID)
      && (record.globalId===null || typeof record.globalId==='string' && record.globalId.length <= 64)
      && typeof record.deleted==='boolean' && (record.projectionFingerprint===null || match(record.projectionFingerprint,SHA)))
    && byGlobalId.every(record=>exact(record,['nativeId','globalId']) && match(record.nativeId,UUID)
      && typeof record.globalId==='string' && record.globalId.length <= 64)
    && exact(owned,sidecars) && Object.values(owned).every(n=>Number.isSafeInteger(n) && n>=0)
    && exact(receipt,['state','fingerprint','projectionFingerprint']) && ['absent','committed','uncertain'].includes(receipt.state)
    && (receipt.state==='committed' ? match(receipt.fingerprint,SHA) && match(receipt.projectionFingerprint,SHA)
      : receipt.fingerprint===null && receipt.projectionFingerprint===null),'native_readback_shape')
  if (receipt.state === 'uncertain') return ['hold','native_receipt_uncertain']
  if (byNativeId.length>1 || byGlobalId.length>1 || byNativeId.some(x=>x.nativeId!==pin.nativeId)
    || byGlobalId.some(x=>x.nativeId!==pin.nativeId || x.globalId!==pin.globalId)) return ['hold','native_identity_alias']
  if (byNativeId.length===0) {
    if (byGlobalId.length!==0 || Object.values(owned).some(n=>n!==0)) return ['hold','native_orphaned_sidecars']
    if (receipt.state!=='absent') return ['hold','receipt_without_native_record']
    return ['create-candidate-proven-absent','no_native_identity_or_sidecars']
  }
  const current = byNativeId[0]
  if (current.deleted) return ['hold','native_record_deleted']
  if (byGlobalId.length!==1 || current.globalId===null || owned.emailText!==1 || owned.emailCustom!==1
    || current.projectionFingerprint===null) return ['hold','native_projection_partial']
  if (current.globalId!==pin.globalId || current.projectionFingerprint!==pin.projectionFingerprint
    || (receipt.state==='committed' && receipt.projectionFingerprint!==pin.projectionFingerprint)) return ['hold','native_projection_mismatch']
  return ['receipt-only-exact',receipt.state==='committed' ? 'exact_native_projection_and_receipt' : 'exact_native_projection_without_receipt']
}

/** Diagnostic planner only. Callers must independently verify all snapshot
 * provenance. The native fingerprint covers normalized content/links and
 * their exact cardinalities, including all sidecars; these counts alone do
 * not certify a matching projection. No returned disposition is a permit. */
export function planBpoFailedEmailRepair({review, expectedInventoryFingerprint, appReadback, nativeReadback}) {
  const pinned = normalize(review), inventoryFingerprint = describeBpoFailedEmailRepairInventory(review)
  need(match(expectedInventoryFingerprint,SHA) && inventoryFingerprint===expectedInventoryFingerprint,'independent_inventory_pin')
  const slots = new Map(pinned.rows.map(row=>[row.interactionId,row]))
  const apps = observation(appReadback,pinned.app,slots), natives = observation(nativeReadback,pinned.suiteCrm,slots)
  const nativeVerdicts = new Map(pinned.rows.map(pin=>[pin.interactionId,nativeOutcome(natives.get(pin.interactionId),pin)]))
  const byNative = new Map(pinned.rows.map(pin=>[pin.nativeId,pin.interactionId]))
  const byGlobal = new Map(pinned.rows.map(pin=>[pin.globalId,pin.interactionId]))
  const conflicts = new Set()
  for (const [id,row] of natives) {
    // An apparent absence is unsafe if another readback names that slot's
    // native or Global ID. Hold both sides instead of choosing a winner.
    const mentions = [row,...(Array.isArray(row.byNativeId)?row.byNativeId:[]),...(Array.isArray(row.byGlobalId)?row.byGlobalId:[])]
    for (const hit of mentions) for (const other of [byNative.get(hit?.nativeId),
      typeof hit?.globalId==='string' ? byGlobal.get(hit.globalId.trim().toLowerCase()) : null]) {
      if (other && other!==id) { conflicts.add(id); conflicts.add(other) }
    }
  }
  const records = pinned.rows.map(pin=>{
    const app = apps.get(pin.interactionId)
    need(exact(app,[...pinKeys,'workspaceId','pipelineId','syncStatus','terminalLatestJob','unclaimed','uniqueIdentity']),'app_observation_shape')
    const current = pinKeys.every(key=>app[key]===pin[key]) && app.workspaceId===WORKSPACE && app.pipelineId===PIPELINE
      && app.syncStatus==='failed' && app.terminalLatestJob===true && app.unclaimed===true && app.uniqueIdentity===true
    const [disposition,reason] = !current ? ['hold','app_preimage_or_job_changed']
      : conflicts.has(pin.interactionId) ? ['hold','native_cross_slot_identity_conflict'] : nativeVerdicts.get(pin.interactionId)
    return {cohort:pin.cohort,interactionId:pin.interactionId,jobId:pin.jobId,disposition,reason}
  })
  return {version:1,diagnosticOnly:true,writeAuthorized:false,inventoryFingerprint,records,
    planFingerprint:digest(['clawpilot-bpo-failed-email-plan-v1',inventoryFingerprint,records])}
}
