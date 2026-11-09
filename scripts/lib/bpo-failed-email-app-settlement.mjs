import { createHash } from 'node:crypto'
import { bpoFailedEmailAppOriginSql, bpoFailedEmailAppSlotSql } from './bpo-failed-email-app-readback.mjs'
import { describeBpoFailedEmailRepairInventory } from './bpo-failed-email-repair-plan.mjs'
import { prepareBpoSharedEmailProjection, sharedEmailCanonicalJson } from './bpo-shared-email-projection.mjs'

const HASH = /^[a-f0-9]{64}(?![\s\S])/u
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z(?![\s\S])/u
const TYPE = 'system.crm.bpo_shared_email_settled'
const fail = reason => { throw new Error(`Exact BPO failed Email app settlement held: ${reason}`) }
const need = (condition, reason) => { if (!condition) fail(reason) }
const digest = input => createHash('sha256').update(sharedEmailCanonicalJson(input)).digest('hex')
const hash = value => typeof value === 'string' && HASH.test(value)
const same = (a,b) => sharedEmailCanonicalJson(a) === sharedEmailCanonicalJson(b)
const fingerprint = row => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(${row})::text,'UTF8')),'hex')`

// Relies on the 0398/0408/0406/0413 statement fences for App relationship,
// identity and outbox writers. Reuse the relationship semantics of 0408, but
// not its retired/held-only provider predicate; the slot check below covers it.
const relationshipsSql = `WITH target AS (
  SELECT id,pipeline_id,organization_id,contact_id FROM public.crm_interactions WHERE id=$1::uuid AND pipeline_id=$2::uuid
), selected_accounts AS (
  SELECT t.organization_id AS id FROM target t WHERE t.organization_id IS NOT NULL
  UNION
  SELECT l.organization_id FROM target t JOIN public.crm_interaction_organizations l ON (l.pipeline_id,l.interaction_id)=(t.pipeline_id,t.id)
), selected_contacts AS (
  SELECT l.contact_id AS id FROM target t JOIN public.crm_interaction_contacts l ON (l.pipeline_id,l.interaction_id)=(t.pipeline_id,t.id)
), designated_primary AS (
  SELECT l.organization_id AS id FROM target t JOIN public.crm_interaction_organizations l ON (l.pipeline_id,l.interaction_id)=(t.pipeline_id,t.id) AND l.is_primary
), accounts AS (
  SELECT s.id,o.suitecrm_id AS native_id,o.source_payload FROM selected_accounts s
  LEFT JOIN public.crm_organizations o ON o.pipeline_id=$2::uuid AND o.id=s.id
), contacts AS (
  SELECT c.suitecrm_id AS native_id,c.source_payload,a.native_id AS account_id FROM selected_contacts s
  LEFT JOIN public.crm_contacts c ON c.pipeline_id=$2::uuid AND c.id=s.id LEFT JOIN accounts a ON a.id=c.organization_id
)
SELECT CASE WHEN (t.contact_id IS NULL OR EXISTS(SELECT 1 FROM selected_contacts WHERE id=t.contact_id))
  AND ((t.organization_id IS NULL AND NOT EXISTS(SELECT 1 FROM designated_primary))
    OR ((SELECT count(*) FROM designated_primary)=1 AND EXISTS(SELECT 1 FROM designated_primary WHERE id=t.organization_id)))
  AND NOT EXISTS(SELECT 1 FROM accounts WHERE native_id IS NULL OR lower(coalesce(source_payload->>'archived','false')) IN ('true','1','yes'))
  AND NOT EXISTS(SELECT 1 FROM contacts WHERE native_id IS NULL OR account_id IS NULL OR lower(coalesce(source_payload->>'archived','false')) IN ('true','1','yes'))
THEN pg_catalog.jsonb_build_object('parentType',CASE WHEN t.organization_id IS NULL THEN '' ELSE 'Accounts' END,
  'parentId',coalesce((SELECT native_id FROM accounts WHERE id=t.organization_id),''),
  'accounts',coalesce((SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM accounts),'[]'::jsonb),
  'contacts',coalesce((SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb),
  'contactAccounts',coalesce((SELECT jsonb_agg(jsonb_build_object('contactId',native_id,'accountId',account_id)
    ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb)) END AS links FROM target t`

const exactRows = `SELECT i.metadata->'suiteCrmEmailProjection' AS projection, i.sync_status AS interaction_status,
  o.status AS job_status, ${fingerprint('i')} AS interaction, ${fingerprint('o')} AS job
  FROM public.crm_interactions i CROSS JOIN public.sync_outbox o WHERE i.id=$1::uuid AND o.id=$2::uuid`
const control = `SELECT 1 FROM public.crm_native_email_publication_control WHERE singleton AND NOT enabled
  AND active_operation_id IS NULL AND active_transition_id IS NULL AND active_initial_enrollment_id IS NULL FOR UPDATE`
const state = `SELECT to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  current_user=session_user AND current_setting('role')='none' AS direct`
const jobChanges = `jsonb_build_object('status','succeeded','last_error',NULL,'locked_at',NULL,'lock_token',NULL,
  'processed_at',$3::timestamptz,'updated_at',$3::timestamptz)`
const interactionChanges = `jsonb_build_object('sync_status','synced','sync_error',NULL,
  'suitecrm_synced_at',$3::timestamptz,'updated_at',$3::timestamptz,
  'metadata', i.metadata || jsonb_build_object('suiteCrmEmailProjection',$4::jsonb))`
const settleJob = `WITH pinned AS MATERIALIZED (
  SELECT to_jsonb(o)||${jobChanges} AS expected FROM public.sync_outbox o
  WHERE o.id=$1::uuid AND o.status='dead' AND o.attempts=8 AND o.locked_at IS NULL AND o.lock_token IS NULL AND ${fingerprint('o')}=$2
)
UPDATE public.sync_outbox o SET status='succeeded',last_error=NULL,locked_at=NULL,lock_token=NULL,
  processed_at=$3::timestamptz,updated_at=$3::timestamptz FROM pinned WHERE o.id=$1::uuid
RETURNING to_jsonb(o)=pinned.expected AS exact,${fingerprint('o')} AS fingerprint`
const settleInteraction = `WITH pinned AS MATERIALIZED (
  SELECT to_jsonb(i)||${interactionChanges} AS expected FROM public.crm_interactions i
  WHERE i.id=$1::uuid AND i.sync_status='failed' AND jsonb_typeof(i.metadata)='object' AND ${fingerprint('i')}=$2
)
UPDATE public.crm_interactions i SET sync_status='synced',sync_error=NULL,suitecrm_synced_at=$3::timestamptz,updated_at=$3::timestamptz,
  metadata=i.metadata||jsonb_build_object('suiteCrmEmailProjection',$4::jsonb) FROM pinned WHERE i.id=$1::uuid
RETURNING to_jsonb(i)=pinned.expected AS exact,${fingerprint('i')} AS fingerprint`

/** Private composition boundary: both callbacks must be operator-installed,
 * independently attested transports, never supplied by a request or derived
 * from the envelope/database being checked. verifyNativeReceipt must first
 * authenticate a fresh exact native readback (including active row, content,
 * all links, deleted/alias/sidecar absence, and the approved login boundary).
 * It returns only the bounded evidence fields checked below. No native call
 * or role change occurs during the App transaction. Requires the trigger
 * lineage through migration 0417 and an exclusive idle direct PG session.
 */
export function createBpoFailedEmailAppSettler({review,expectedInventoryFingerprint,verifyNativeReceipt,attestAppDeployment}) {
  const reviewed=structuredClone(review)
  const inventoryFingerprint=describeBpoFailedEmailRepairInventory(reviewed)
  need(hash(expectedInventoryFingerprint) && inventoryFingerprint===expectedInventoryFingerprint, 'inventory_pin')
  need(typeof verifyNativeReceipt==='function' && typeof attestAppDeployment==='function','independent_attestors')
  const {workspaceId,pipelineId,app,suiteCrm}=reviewed
  const slots=new Map([...reviewed.original11,...reviewed.later8].map(pin=>[pin.interactionId,Object.freeze(pin)]))

  async function run({client,interactionId,receiptEnvelope},write) {
    const pin=slots.get(interactionId)
    need(pin,'not_in_exact_review')
    need(typeof client?.query==='function' && typeof client.on==='function' && typeof client.removeListener==='function','exclusive_client')
    const target=Object.freeze({workspaceId,pipelineId,inventoryFingerprint,interactionId,jobId:pin.jobId,nativeId:pin.nativeId,
      globalId:pin.globalId,preimageFingerprint:pin.preimageFingerprint,projectionFingerprint:pin.projectionFingerprint,
      appOriginFingerprint:app.originFingerprint,appDeploymentFingerprint:app.deploymentFingerprint,
      nativeOriginFingerprint:suiteCrm.originFingerprint,nativeDeploymentFingerprint:suiteCrm.deploymentFingerprint})
    let receipt, deployment
    try {
      receipt=structuredClone(await verifyNativeReceipt(receiptEnvelope,target))
      deployment=await attestAppDeployment()
    } catch { fail('independent_evidence_unavailable') }
    need(deployment===app.deploymentFingerprint,'deployment_changed')
    const receiptKeys=[...Object.keys(target),'version','state','kind','snapshotFingerprint','receiptFingerprint','observedAt']
    need(receipt && typeof receipt==='object' && !Array.isArray(receipt) && Object.keys(receipt).length===receiptKeys.length
      && receiptKeys.every(key=>Object.hasOwn(receipt,key)) && receipt.version===1 && receipt.state==='exact'
      && ['created','exact-existing'].includes(receipt.kind) && hash(receipt.snapshotFingerprint) && hash(receipt.receiptFingerprint)
      && typeof receipt.observedAt==='string' && TIME.test(receipt.observedAt) && Number.isFinite(Date.parse(receipt.observedAt))
      && new Date(receipt.observedAt).toISOString()===receipt.observedAt
      && Object.entries(target).every(([key,value])=>receipt[key]===value),'native_receipt_binding')
    const {observedAt,...durableEvidence}=receipt
    const receiptDigest=digest(['clawpilot-shared-bpo-app-settlement-v1',durableEvidence])
    const key=`crm-bpo-shared-email-settlement-v1:${pin.jobId}`
    const slotArgs=[JSON.stringify([{interactionId,jobId:pin.jobId,nativeId:pin.nativeId,globalId:pin.globalId,
      providerMessageId:pin.providerMessageId}]),workspaceId,pipelineId]
    const query=async (sql,values,reason)=>{try { return (await client.query(sql,values)).rows } catch { fail(reason) }}
    const one=async (sql,values,reason)=>{const rows=await query(sql,values,reason);need(rows.length===1,reason);return rows[0]}
    const checkReceiptTime=async ()=>{
      const {at,direct}=await one(state,undefined,'database_clock')
      const age=Date.parse(at)-Date.parse(observedAt)
      need(direct===true && typeof at==='string' && TIME.test(at) && age>=0 && age<=60_000,'native_receipt_not_fresh')
      return at
    }
    const checkPreimage=async ()=>{
      const current=await one(bpoFailedEmailAppSlotSql,slotArgs,'locked_slot')
      need(current.workspaceId===workspaceId && current.pipelineId===pipelineId && current.syncStatus==='failed'
        && current.terminalLatestJob===true && current.uniqueIdentity===true && current.unclaimed===true
        && ['interactionId','jobId','nativeId','globalId','providerMessageId','interactionFingerprint','jobFingerprint','preimageFingerprint']
          .every(name=>current[name]===pin[name]), 'slot_preimage_changed')
    }
    const checkOrigin=async ()=>{
      const row=await one(bpoFailedEmailAppOriginSql({write}),undefined,'database_origin')
      need(row.snapshotProtected===true && row.originFingerprint===app.originFingerprint,'database_origin_changed')
    }
    let nested=false, begun=false
    const notice=value=>{if(value?.code==='25001')nested=true}
    client.on('notice',notice)
    try {
      await query(write?'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',undefined,'begin')
      need(!nested,'exclusive_idle_client')
      begun=true
    } finally { client.removeListener('notice',notice) }
    try {
      await query("SET LOCAL search_path = pg_catalog,public; SET LOCAL TIME ZONE 'UTC'; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s'; SET LOCAL row_security = off",undefined,'session_profile')
      await checkOrigin()
      await checkReceiptTime()
      if(write){
        await one(control,undefined,'native_control_not_idle')
        await one('SELECT 1 FROM crm_legacy_email_retirement.serial WHERE singleton FOR UPDATE',undefined,'retirement_serial')
        await one("SELECT 1 FROM public.app_settings WHERE key='deployment.database.identity' FOR SHARE",undefined,'database_identity_lock')
        await one(`SELECT 1 FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
          WHERE p.id=$1::uuid AND w.id=$2::uuid AND NOT p.reference_access_disabled AND NOT w.is_demo FOR SHARE OF p,w`,
        [pipelineId,workspaceId],'workspace_changed')
        await one('SELECT 1 FROM public.crm_interactions WHERE id=$1::uuid AND pipeline_id=$2::uuid FOR UPDATE',[interactionId,pipelineId],'interaction_lock')
        await one('SELECT 1 FROM public.sync_outbox WHERE id=$1::uuid FOR UPDATE',[pin.jobId],'job_lock')
      }
      const prior=await query(`SELECT payload FROM public.audit_events WHERE event_key=$1 AND event_type=$2
        AND aggregate_type='crm_interactions' AND aggregate_id=$3 AND organization_id=$4::uuid AND is_system`,
      [key,TYPE,interactionId,workspaceId],'settlement_audit')
      const rows=await one(exactRows,[interactionId,pin.jobId],'settlement_readback')
      if(prior.length){
        need(prior.length===1 && rows.interaction_status==='synced' && rows.job_status==='succeeded'
          && rows.projection?.suiteCrmId===pin.nativeId && rows.projection?.sharedRepair?.receiptDigest===receiptDigest
          && same(prior[0].payload,{receiptDigest,inventoryFingerprint,jobFingerprint:rows.job,interactionFingerprint:rows.interaction}),
        'settlement_postimage_changed')
        await query('ROLLBACK',undefined,'readback_end_unproven');begun=false
        return {state:'settled',replayed:true,interactionId,jobId:pin.jobId,receiptDigest}
      }
      await checkPreimage()
      if(!write){
        await query('ROLLBACK',undefined,'readback_end_unproven');begun=false
        return {state:'unsettled',interactionId,jobId:pin.jobId,receiptDigest}
      }
      const deps=await query(`SELECT 1 FROM public.crm_contact_merge_outbox_dependencies
        WHERE dependent_outbox_id=$1::uuid OR prerequisite_outbox_id=$1::uuid LIMIT 1`,[pin.jobId],'dependency_check')
      need(deps.length===0,'contact_merge_dependency')
      const {payload}=await one('SELECT payload FROM public.sync_outbox WHERE id=$1::uuid',[pin.jobId],'outbox_payload')
      const {links}=await one(relationshipsSql,[interactionId,pipelineId],'live_relationships')
      const {projection}=prepareBpoSharedEmailProjection({payload,pin,pipelineId,liveRelationships:links})
      const at=await checkReceiptTime()
      const metadata={version:2,suiteCrmId:pin.nativeId,globalId:pin.globalId,capturedAt:at,accounts:projection.accounts,
        contacts:projection.contacts,contactAccounts:projection.contactAccounts,snapshotFingerprint:receipt.snapshotFingerprint,
        sharedRepair:{version:1,kind:receipt.kind,receiptDigest,projectionFingerprint:pin.projectionFingerprint}}
      await query("SELECT set_config('clawpilot.crm_shared_write_v1','on',true)",undefined,'shared_writer_guard')
      const job=await one(settleJob,[pin.jobId,pin.jobFingerprint,at],'job_compare_and_set')
      const interaction=await one(settleInteraction,[interactionId,pin.interactionFingerprint,at,JSON.stringify(metadata)],'interaction_compare_and_set')
      need(job.exact===true && interaction.exact===true && hash(job.fingerprint) && hash(interaction.fingerprint),'unexpected_postimage')
      const audit={receiptDigest,inventoryFingerprint,jobFingerprint:job.fingerprint,interactionFingerprint:interaction.fingerprint}
      await one(`INSERT INTO public.audit_events(actor,subject,event_type,event_key,aggregate_type,aggregate_id,organization_id,is_system,payload)
        VALUES('system','system',$1,$2,'crm_interactions',$3,$4::uuid,true,$5::jsonb) RETURNING 1`,
      [TYPE,key,interactionId,workspaceId,JSON.stringify(audit)],'audit_compare_and_set')
      const readback=await one(exactRows,[interactionId,pin.jobId],'settlement_postimage')
      need(readback.job===job.fingerprint && readback.interaction===interaction.fingerprint
        && same(readback.projection,metadata),'unexpected_postimage')
      await checkReceiptTime()
      await checkOrigin()
      // Never automatically retry an uncertain COMMIT. Close the connection
      // and use resolve() on a new pinned connection before another write.
      begun=false
      let committed
      try { committed=await client.query('COMMIT') } catch { fail('settlement_commit_unproven') }
      need(committed?.command==='COMMIT','settlement_commit_unproven')
      return {state:'settled',replayed:false,interactionId,jobId:pin.jobId,receiptDigest}
    } finally {
      if(begun) await query('ROLLBACK',undefined,'settlement_rollback_unproven')
    }
  }
  return Object.freeze({settle: input=>run(input,true),resolve: input=>run(input,false)})
}
