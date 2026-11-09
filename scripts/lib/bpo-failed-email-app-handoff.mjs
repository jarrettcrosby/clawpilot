import { createHash } from 'node:crypto'
import { bpoFailedEmailAppOriginSql, bpoFailedEmailAppSlotSql } from './bpo-failed-email-app-readback.mjs'
import { relationshipsSql } from './bpo-failed-email-app-settlement.mjs'
import { describeBpoFailedEmailRepairInventory } from './bpo-failed-email-repair-plan.mjs'
import { prepareBpoSharedEmailProjection, sharedEmailCanonicalJson } from './bpo-shared-email-projection.mjs'

const WORKSPACE='c6c49765-9bf6-4223-9261-7553499f5d92', PIPELINE='587c8746-ecf6-40ae-8c50-e456f99ad555'
const TYPE='system.crm.bpo_shared_email_dispatch_claimed'
const HASH=/^[a-f0-9]{64}(?![\s\S])/u, UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const GLOBAL=/^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u, PROVIDER=/^[a-z0-9_-]{1,128}(?![\s\S])/u
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/u
const fields=['interactionId','jobId','nativeId','globalId','providerMessageId','interactionFingerprint','jobFingerprint','preimageFingerprint']
const matches=(value,re)=>typeof value==='string'&&re.test(value)
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key))
const sha=value=>createHash('sha256').update(value).digest('hex')
const fail=reason=>{throw new Error(`Exact BPO failed Email App handoff held: ${reason}`)}
const need=(ok,reason)=>{if(!ok)fail(reason)}
const time=value=>matches(value,TIME)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const control=`SELECT 1 FROM public.crm_native_email_publication_control WHERE singleton AND NOT enabled
  AND active_operation_id IS NULL AND active_transition_id IS NULL AND active_initial_enrollment_id IS NULL`
const clock=`SELECT to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  current_user=session_user AND current_setting('role')='none' AS direct`
const auditRead=`SELECT event_type,aggregate_type,aggregate_id,organization_id::text,is_system,payload
  FROM public.audit_events WHERE event_key=$1`

async function exactAppSlot({client,pin,app,attestAppDeployment,write,handle}) {
  need(typeof client?.query==='function'&&typeof client.on==='function'&&typeof client.removeListener==='function','exclusive_client')
  let deployment
  try {deployment=await attestAppDeployment()}catch{fail('app_deployment_unavailable')}
  need(deployment===app.deploymentFingerprint,'app_deployment_changed')
  const query=async(sql,values,reason)=>{try{return await client.query(sql,values)}catch{fail(reason)}}
  const one=async(sql,values,reason)=>{const {rows}=await query(sql,values,reason);need(rows.length===1,reason);return rows[0]}
  const origin=async()=>{
    const row=await one(bpoFailedEmailAppOriginSql({write}),undefined,'database_origin')
    need(row.snapshotProtected===true&&row.originFingerprint===app.originFingerprint,'database_origin_changed')
  }
  const readClock=async()=>{
    const row=await one(clock,undefined,'database_clock')
    need(row.direct===true&&time(row.at),'database_clock')
    return row.at
  }
  const validateSlot=async()=>{
    const identity=Object.fromEntries(fields.slice(0,5).map(key=>[key,pin[key]]))
    const row=await one(bpoFailedEmailAppSlotSql,[JSON.stringify([identity]),WORKSPACE,PIPELINE],'slot_preimage')
    need(row.workspaceId===WORKSPACE&&row.pipelineId===PIPELINE&&row.syncStatus==='failed'
      &&row.terminalLatestJob===true&&row.uniqueIdentity===true&&row.unclaimed===true
      &&fields.every(key=>row[key]===pin[key]),'slot_preimage_changed')
  }
  let nested=false,begun=false
  const notice=value=>{if(value?.code==='25001')nested=true}
  client.on('notice',notice)
  try {
    await query(write?'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',undefined,'begin')
    need(!nested,'exclusive_idle_client');begun=true
  } finally {client.removeListener('notice',notice)}
  try {
    await query("SET LOCAL search_path = pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; SET LOCAL row_security = off",undefined,'session_profile')
    await origin()
    await readClock()
    await one(control+(write?' FOR UPDATE':''),undefined,'native_control_not_idle')
    if(write){
      await one('SELECT 1 FROM crm_legacy_email_retirement.serial WHERE singleton FOR UPDATE',undefined,'retirement_serial')
      await one("SELECT 1 FROM public.app_settings WHERE key='deployment.database.identity' FOR SHARE",undefined,'database_identity_lock')
      await one(`SELECT 1 FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
        WHERE p.id=$1::uuid AND w.id=$2::uuid AND NOT p.reference_access_disabled AND NOT w.is_demo FOR SHARE OF p,w`,[PIPELINE,WORKSPACE],'workspace_changed')
      await one('SELECT 1 FROM public.crm_interactions WHERE id=$1::uuid AND pipeline_id=$2::uuid FOR UPDATE',[pin.interactionId,PIPELINE],'interaction_lock')
      await one('SELECT 1 FROM public.sync_outbox WHERE id=$1::uuid FOR UPDATE',[pin.jobId],'job_lock')
    }
    await validateSlot()
    const deps=await query(`SELECT 1 FROM public.crm_contact_merge_outbox_dependencies
      WHERE dependent_outbox_id=$1::uuid OR prerequisite_outbox_id=$1::uuid LIMIT 1`,[pin.jobId],'dependency_check')
    need(deps.rows.length===0,'contact_merge_dependency')
    const {payload}=await one('SELECT payload FROM public.sync_outbox WHERE id=$1::uuid',[pin.jobId],'outbox_payload')
    const {links}=await one(relationshipsSql,[pin.interactionId,PIPELINE],'live_relationships')
    const projection=prepareBpoSharedEmailProjection({payload,pin,pipelineId:PIPELINE,liveRelationships:links})
    const result=await handle({query,one,readClock,projection})
    await validateSlot()
    await origin()
    if(write&&result.state==='dispatch-once'){
      // A caller must close this connection and inspect on a fresh pinned
      // connection if the response is lost. No dispatch may follow ambiguity.
      begun=false
      const committed=await query('COMMIT',undefined,'dispatch_commit_unproven')
      need(committed?.command==='COMMIT','dispatch_commit_unproven')
    }else{
      await query('ROLLBACK',undefined,'readback_end_unproven');begun=false
    }
    return result
  }finally{if(begun)await query('ROLLBACK',undefined,'handoff_rollback_unproven')}
}

/** Read-only materialization from the independently pinned raw 19-slot App
 * capture. Result contains private projection content: keep it in memory,
 * never log it or substitute this diagnostic for a reviewed repair permit. */
export async function prepareBpoFailedEmailCandidate({client,interactionId,candidateManifestJson,expectedManifestFingerprint,
  appDeploymentFingerprint,attestAppDeployment}) {
  need(matches(expectedManifestFingerprint,HASH)&&matches(appDeploymentFingerprint,HASH)&&typeof attestAppDeployment==='function'
    &&typeof candidateManifestJson==='string'&&Buffer.byteLength(candidateManifestJson,'utf8')<=30000
    &&sha(candidateManifestJson.trim())===expectedManifestFingerprint,'candidate_inventory_pin')
  let manifest
  try{manifest=JSON.parse(candidateManifestJson)}catch{fail('candidate_inventory_shape')}
  need(exact(manifest,['version','purpose','readOnly','originFingerprint','original11','later8'])
    &&manifest.version===1&&manifest.readOnly===true&&manifest.purpose==='clawpilot-bpo-terminal-email-candidate-inventory'
    &&matches(manifest.originFingerprint,HASH)&&Array.isArray(manifest.original11)&&manifest.original11.length===11
    &&Array.isArray(manifest.later8)&&manifest.later8.length===8,'candidate_inventory_shape')
  const slots=[...manifest.original11,...manifest.later8]
  need(slots.every(slot=>exact(slot,fields)&&fields.slice(0,3).every(key=>matches(slot[key],UUID))
    &&matches(slot.globalId,GLOBAL)&&(slot.providerMessageId===null||matches(slot.providerMessageId,PROVIDER))
    &&fields.slice(5).every(key=>matches(slot[key],HASH)))
    &&new Set(slots.flatMap(slot=>fields.slice(0,3).map(key=>slot[key]))).size===57
    &&new Set(slots.map(slot=>slot.globalId)).size===19,'candidate_inventory_shape')
  const pin=slots.find(slot=>slot.interactionId===interactionId)
  need(pin,'not_in_exact_review')
  return exactAppSlot({client,pin,app:{originFingerprint:manifest.originFingerprint,deploymentFingerprint:appDeploymentFingerprint},
    attestAppDeployment,write:false,handle:({projection})=>projection})
}

/** Operator-only composition: deployment and fresh native absence attestors
 * must be independently configured, never passed by an HTTP caller. Claim
 * consumes the one dispatch opportunity before any external write. */
export function createBpoFailedEmailAppHandoff({review,expectedInventoryFingerprint,attestAppDeployment,verifyNativeAbsence}) {
  const reviewed=structuredClone(review), inventoryFingerprint=describeBpoFailedEmailRepairInventory(reviewed)
  need(matches(expectedInventoryFingerprint,HASH)&&inventoryFingerprint===expectedInventoryFingerprint,'inventory_pin')
  need(typeof attestAppDeployment==='function'&&typeof verifyNativeAbsence==='function','independent_attestors')
  const {app,suiteCrm}=reviewed
  const slots=new Map([...reviewed.original11,...reviewed.later8].map(pin=>[pin.interactionId,pin]))
  const uncertain=new Set()
  const run=async({client,interactionId,absenceEvidence},write)=>{
    const pin=slots.get(interactionId)
    need(pin,'not_in_exact_review')
    const target=Object.freeze({workspaceId:WORKSPACE,pipelineId:PIPELINE,inventoryFingerprint,interactionId,
      jobId:pin.jobId,nativeId:pin.nativeId,globalId:pin.globalId,preimageFingerprint:pin.preimageFingerprint,
      projectionFingerprint:pin.projectionFingerprint,appOriginFingerprint:app.originFingerprint,appDeploymentFingerprint:app.deploymentFingerprint,
      nativeOriginFingerprint:suiteCrm.originFingerprint,nativeDeploymentFingerprint:suiteCrm.deploymentFingerprint})
    let evidence
    if(write&&absenceEvidence!==undefined){
      try{evidence=structuredClone(await verifyNativeAbsence(absenceEvidence,target))}catch{fail('native_absence_unverified')}
    }
    const key=`crm-bpo-shared-email-dispatch-v1:${pin.jobId}`
    try{return await exactAppSlot({client,pin,app,attestAppDeployment,write,handle:async({query,one,readClock,projection})=>{
      const audit=async()=>{
        const {rows}=await query(auditRead,[key],'dispatch_audit')
        need(rows.length<=1,'dispatch_audit_binding')
        if(!rows.length)return null
        const row=rows[0], p=row.payload
        need(row.event_type===TYPE&&row.aggregate_type==='crm_interactions'&&row.aggregate_id===interactionId
          &&row.organization_id===WORKSPACE&&row.is_system===true
          &&exact(p,['target','evidenceFingerprint','observedAt','claimedAt'])&&matches(p.evidenceFingerprint,HASH)
          &&time(p.observedAt)&&time(p.claimedAt)&&sharedEmailCanonicalJson(p.target)===sharedEmailCanonicalJson(target),'dispatch_audit_binding')
        return p
      }
      const prior=await audit()
      const result={target,projection:projection.projection}
      if(prior||uncertain.has(interactionId))return {...result,state:'reconcile-only',dispatchClaim:prior}
      if(!write)return {...result,state:'ready',dispatchClaim:null}
      need(exact(evidence,[...Object.keys(target),'version','state','observedAt','evidenceFingerprint'])
        &&evidence.version===1&&evidence.state==='absent'&&time(evidence.observedAt)&&matches(evidence.evidenceFingerprint,HASH)
        &&Object.entries(target).every(([key,value])=>evidence[key]===value),'native_absence_binding')
      const claimedAt=await readClock(), age=Date.parse(claimedAt)-Date.parse(evidence.observedAt)
      need(age>=0&&age<=60_000,'native_absence_stale')
      const claim={target,evidenceFingerprint:evidence.evidenceFingerprint,observedAt:evidence.observedAt,claimedAt}
      await one(`INSERT INTO public.audit_events(actor,subject,event_type,event_key,aggregate_type,aggregate_id,organization_id,is_system,payload)
        VALUES('system','system',$1,$2,'crm_interactions',$3,$4::uuid,true,$5::jsonb) RETURNING 1`,
      [TYPE,key,interactionId,WORKSPACE,JSON.stringify(claim)],'dispatch_audit_insert')
      need(sharedEmailCanonicalJson(await audit())===sharedEmailCanonicalJson(claim),'dispatch_audit_changed')
      return {...result,state:'dispatch-once',dispatchClaim:claim}
    }})}catch(error){if(error?.message?.endsWith(': dispatch_commit_unproven'))uncertain.add(interactionId);throw error}
  }
  return Object.freeze({inspect:input=>run(input,false),claim:input=>run(input,true)})
}
