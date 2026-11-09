import { describeBpoFailedEmailRepairInventory } from './bpo-failed-email-repair-plan.mjs'

const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
const fingerprint = /^[a-f0-9]{64}(?![\s\S])/u
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const globalId = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const providerId = /^[a-z0-9_-]{1,128}(?![\s\S])/u
const need = (condition, reason) => {
  if (!condition) throw new Error(`Exact BPO failed Email app readback held: ${reason}`)
}
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
const verifiedText = (value, pattern) => matches(value, pattern) ? value : null

// The identity marker alone can be copied by a database restore. Pin the
// database OID and cluster system identifier as well as the durable marker.
export function bpoFailedEmailAppOriginSql({ write = false } = {}) {
  return `SELECT
  pg_catalog.current_setting('transaction_read_only')='${write ? 'off' : 'on'}'
    AND pg_catalog.current_setting('transaction_isolation')='${write ? 'read committed' : 'repeatable read'}'
    AND pg_catalog.current_setting('TimeZone')='UTC'
    AND NOT pg_catalog.pg_is_in_recovery() AS "snapshotProtected",
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    'clawpilot-bpo-failed-email-postgres-v1',d.datname,d.oid::text,c.system_identifier::text,s.value->>'id'
  )::text,'UTF8')),'hex') AS "originFingerprint"
  FROM pg_catalog.pg_database d
  CROSS JOIN pg_catalog.pg_control_system() c
  JOIN public.app_settings s ON s.key='deployment.database.identity'
  WHERE d.datname=pg_catalog.current_database()
    AND s.value->>'id' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'`
}
const originSql = bpoFailedEmailAppOriginSql()

// Only identifiers, hashes and booleans cross the wire. The hashes cover
// entire app/job rows, including their payloads, inside PostgreSQL. In
// particular the projection fingerprint is *not* derived from these rows.
export const bpoFailedEmailAppSlotSql = `WITH slots AS (
  SELECT "interactionId","jobId","nativeId","globalId","providerMessageId"
  FROM pg_catalog.jsonb_to_recordset($1::jsonb)
    AS s("interactionId" uuid,"jobId" uuid,"nativeId" text,"globalId" text,"providerMessageId" text)
)
SELECT s."interactionId"::text AS "interactionId", j.id::text AS "jobId",
  i.suitecrm_id AS "nativeId", i.reference_code AS "globalId",
  NULLIF(pg_catalog.lower(pg_catalog.btrim(i.provider_message_id)),'') AS "providerMessageId",
  i.pipeline_id::text AS "pipelineId", w.id::text AS "workspaceId", i.sync_status AS "syncStatus",
  CASE WHEN i.id IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(i)::text,'UTF8')),'hex') END AS "interactionFingerprint",
  CASE WHEN j.id IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(j)::text,'UTF8')),'hex') END AS "jobFingerprint",
  CASE WHEN i.id IS NOT NULL AND j.id IS NOT NULL THEN pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(i),pg_catalog.to_jsonb(j))::text,'UTF8')),'hex') END AS "preimageFingerprint",
  COALESCE(j.id=s."jobId" AND j.status='dead' AND j.attempts=8 AND j.processed_at IS NOT NULL
    AND j.last_error IN ('native_projection_proof_unavailable',
      'Native Email projection held: exact identity, relationships, or audience proof is unavailable')
    AND j.operation IN ('upsert_record','reproject_record')
    AND j.payload->>'entity'='interactions' AND j.payload->>'localId'=i.id::text
    AND j.payload->>'pipelineId'=i.pipeline_id::text AND j.payload->>'suiteCrmModule'='Emails'
    AND j.payload->>'previousSuiteCrmModule' IS NULL
    AND j.payload->>'suiteCrmId'=i.suitecrm_id AND j.payload#>>'{attributes,global_id_c}'=i.reference_code
    AND j.idempotency_key='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
    AND i.suitecrm_module='Emails' AND i.suitecrm_synced_at IS NULL
    AND pg_catalog.lower(i.source_key) NOT LIKE 'suitecrm%'
    AND NOT (i.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
    AND COALESCE(pg_catalog.lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND w.id=$2::uuid AND NOT w.is_demo AND NOT p.reference_access_disabled,false) AS "terminalLatestJob",
  (j.id IS NOT NULL AND j.locked_at IS NULL AND j.lock_token IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a
      WHERE a.state<>'cancelled'
        AND (a.local_id=s."interactionId" OR pg_catalog.lower(a.native_id)=s."nativeId"
          OR pg_catalog.lower(a.global_id)=s."globalId"))
    AND NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h
      WHERE h.outbox_id=s."jobId" OR h.retired_outbox_id=s."jobId" OR h.local_id=s."interactionId"
        OR pg_catalog.lower(h.native_id)=s."nativeId" OR pg_catalog.lower(h.global_id)=s."globalId")
    AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h
      WHERE h.outbox_id=s."jobId" OR h.local_id=s."interactionId"
        OR pg_catalog.lower(h.native_id)=s."nativeId" OR pg_catalog.lower(h.global_id)=s."globalId")
    AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h
      WHERE h.outbox_id=s."jobId" OR h.local_id=s."interactionId"
        OR pg_catalog.lower(h.native_id)=s."nativeId" OR pg_catalog.lower(h.global_id)=s."globalId")) AS "unclaimed",
  (i.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_interactions other
    WHERE other.id<>s."interactionId" AND (pg_catalog.lower(pg_catalog.btrim(other.suitecrm_id))=s."nativeId"
      OR pg_catalog.lower(pg_catalog.btrim(other.reference_code))=s."globalId"
      OR (other.pipeline_id=$3::uuid AND (other.source_key=i.source_key
        OR pg_catalog.lower(pg_catalog.btrim(other.provider_message_id))=s."providerMessageId"))))
    AND NOT EXISTS(SELECT 1 FROM public.sync_outbox other
      WHERE other.id<>s."jobId" AND other.target_system='suitecrm'
        AND (other.idempotency_key=j.idempotency_key
          OR (other.aggregate_type='crm_interactions' AND pg_catalog.lower(other.aggregate_id)=s."interactionId"::text
            AND (other.status IN ('queued','processing','failed') OR other.locked_at IS NOT NULL
              OR other.lock_token IS NOT NULL OR other.created_at=j.created_at))
          OR ((other.aggregate_type<>'crm_interactions' OR other.aggregate_id<>s."interactionId"::text)
            AND (pg_catalog.lower(pg_catalog.btrim(other.payload->>'localId'))=s."interactionId"::text
              OR pg_catalog.lower(pg_catalog.btrim(other.payload->>'suiteCrmId'))=s."nativeId"
              OR pg_catalog.lower(pg_catalog.btrim(other.payload#>>'{attributes,global_id_c}'))=s."globalId"))))) AS "uniqueIdentity"
FROM slots s
LEFT JOIN public.workspace_organizations w ON w.id=$2::uuid AND NOT w.is_demo
LEFT JOIN public.pipeline_spaces p ON p.id=$3::uuid AND p.workspace_organization_id=w.id AND NOT p.reference_access_disabled
LEFT JOIN public.crm_interactions i ON i.id=s."interactionId" AND i.pipeline_id=p.id
LEFT JOIN LATERAL (
  SELECT o.id FROM public.sync_outbox o
    WHERE o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text
    ORDER BY o.created_at DESC, o.id DESC LIMIT 1
) latest ON true
LEFT JOIN public.sync_outbox j ON j.id=latest.id
ORDER BY s."interactionId"`

/** Exact 19-slot App-side diagnostic. The caller supplies an authenticated
 * pinned transport, an exclusive idle connection which it owns and closes,
 * an independently reviewed inventory hash, and a separately attested
 * deployment fingerprint. This adapter cannot verify that last attestation
 * itself. Do not treat the readback as approval or as a write-time guard.
 */
export async function observeBpoFailedEmailAppReadback({
  client, review, expectedInventoryFingerprint, observedDeploymentFingerprint,
}) {
  const pinned = structuredClone(review)
  const inventory = describeBpoFailedEmailRepairInventory(pinned)
  need(matches(expectedInventoryFingerprint,fingerprint) && inventory===expectedInventoryFingerprint,'independent_inventory_pin')
  need(matches(observedDeploymentFingerprint,fingerprint)
    && observedDeploymentFingerprint===pinned.app.deploymentFingerprint,'deployment_pin')
  need(typeof client?.query==='function','exclusive_client_required')
  const slots = new Map([...pinned.original11,...pinned.later8].map(row=>[row.interactionId,row]))
  const parameters = [...slots.values()].map(({interactionId,jobId,nativeId,globalId,providerMessageId})=>({
    interactionId,jobId,nativeId,globalId,providerMessageId,
  }))
  const query = async (sql, values, reason) => {
    try { return await client.query(sql,values) } catch { need(false,reason) }
  }
  const assertOrigin = async () => {
    const {rows} = await query(originSql,undefined,'database_origin_unavailable')
    need(rows?.length===1 && rows[0].snapshotProtected===true,'read_only_snapshot_unproven')
    need(rows[0].originFingerprint===pinned.app.originFingerprint,'database_origin_pin')
  }
  // Nested BEGIN only warns in PostgreSQL; refuse a client already in a
  // transaction when the driver reports that warning.
  let nested = false
  const notice = value => { if (value?.code==='25001') nested = true }
  client.on?.('notice',notice)
  try {
    await query(begin,undefined,'cannot_start_read_only_snapshot')
    need(!nested,'exclusive_idle_client_required')
  } finally {
    client.removeListener?.('notice',notice)
  }
  try {
    await query("SET LOCAL TIME ZONE 'UTC'",undefined,'snapshot_timezone')
    await query("SET LOCAL statement_timeout = '5s'",undefined,'snapshot_timeout')
    await assertOrigin()
    const {rows} = await query(bpoFailedEmailAppSlotSql,[JSON.stringify(parameters),pinned.workspaceId,pinned.pipelineId],'app_slot_readback_unavailable')
    need(rows?.length===19,'readback_identity_set')
    const seen = new Set()
    const observations = rows.map(row=>{
      const pin = slots.get(row?.interactionId)
      need(pin && !seen.has(pin.interactionId),'readback_identity_set')
      seen.add(pin.interactionId)
      return {
        interactionId:pin.interactionId,jobId:verifiedText(row.jobId,uuid),nativeId:verifiedText(row.nativeId,uuid),
        globalId:verifiedText(row.globalId,globalId),providerMessageId:verifiedText(row.providerMessageId,providerId),
        interactionFingerprint:verifiedText(row.interactionFingerprint,fingerprint),jobFingerprint:verifiedText(row.jobFingerprint,fingerprint),
        preimageFingerprint:verifiedText(row.preimageFingerprint,fingerprint),projectionFingerprint:pin.projectionFingerprint,
        workspaceId:verifiedText(row.workspaceId,uuid),pipelineId:verifiedText(row.pipelineId,uuid),
        syncStatus:['pending','syncing','synced','failed'].includes(row.syncStatus) ? row.syncStatus : null,
        terminalLatestJob:row.terminalLatestJob===true,
        unclaimed:row.unclaimed===true,uniqueIdentity:row.uniqueIdentity===true
          && (row.providerMessageId===null || matches(row.providerMessageId,providerId)),
      }
    })
    await assertOrigin()
    return {originFingerprint:pinned.app.originFingerprint,deploymentFingerprint:observedDeploymentFingerprint,readOnly:true,rows:observations}
  } finally {
    // No COMMIT, even on success. A rollback failure discards the evidence;
    // the caller must close (never pool) the exclusive diagnostic connection.
    await query('ROLLBACK',undefined,'snapshot_rollback_unproven')
  }
}
