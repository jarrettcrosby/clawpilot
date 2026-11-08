import 'server-only'
import { nativeEmailDigest, NativeEmailPublicationHeld, requireNativeEmail } from '../crm/nativeEmailPublication'
import { nativeEmailPostgresStoreFingerprint } from '../crm/nativeEmailRecoveryStoreBinding'
import type { LegacyEmailTerminalHoldRow } from '../crm/legacyEmailRetirementApproval'
import type { LegacyEmailTerminalHoldAppObservation, LegacyEmailTerminalHoldAppObservationRequest }
  from '../crm/legacyEmailTerminalHoldPreview'

type Row = Record<string, unknown>
type Query = (text: string, values?: readonly unknown[]) => Promise<{ rows: Row[] }>
type WithSession = <T>(signal: AbortSignal, run: (query: Query) => Promise<T>) => Promise<T>
type Target = Readonly<{ database: string; databaseOid: string; systemIdentifier: string; observerRole: string }>
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const ROLE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}(?![\s\S])/u
const HASH = /^[a-f0-9]{64}(?![\s\S])/u
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})(?![\s\S])/u
const KNOWN_REFUSAL = /^legacy_terminal_hold_app_observer_(?:session|deadline|query_failed|shape|physical_session|authority|reviewed_set|session_changed)(?![\s\S])/u
const HELD = 'crm_legacy_email_terminal_hold'
const SESSION = `SELECT d.datname::text AS database,d.oid::text AS oid,c.system_identifier::text AS system,
  SESSION_USER::text AS login,CURRENT_USER::text AS role,pg_catalog.pg_backend_pid() AS pid,
  pg_catalog.pg_current_snapshot()::text AS snapshot,
  pg_catalog.transaction_timestamp()::text AS transaction_start,
  floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint::text AS epoch,
  pg_catalog.current_setting('transaction_read_only')='on'
    AND pg_catalog.current_setting('transaction_isolation')='repeatable read'
    AND pg_catalog.current_setting('TimeZone')='UTC'
    AND NOT pg_catalog.pg_is_in_recovery() AS observed
  FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() c
  WHERE d.datname=pg_catalog.current_database()`
const AUTHORITY = `SELECT c.generation::text AS generation,${HELD}.gate_fingerprint() AS gate,
  encode(public.digest(public.clawpilot_crm_native_initial_source_snapshot()::text,'sha256'),'hex') AS source,
  NOT c.enabled AND c.active_operation_id IS NULL AND c.active_transition_id IS NULL
    AND c.active_initial_enrollment_id IS NULL AS idle,
  EXISTS(SELECT 1 FROM public.crm_operator_accounts a
    JOIN public.workspace_organizations w ON w.id=a.root_workspace_id
    JOIN public.app_users u ON u.email=a.owner_email
    JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
    WHERE a.id=$2::uuid AND w.id=$3::uuid AND a.owner_email=$1::text AND a.enabled
      AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo
      AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner') AS owner
  FROM public.crm_native_email_publication_control c WHERE c.singleton`
// This returns identifiers and hashes, not Email subjects, bodies, provider IDs,
// queue payloads or role credentials. The hold transaction independently
// revalidates every condition and fingerprint under its own locks.
const ORIGINALS = `SELECT o.id::text AS "outboxId",i.id::text AS "localId",i.pipeline_id::text AS "pipelineId",
  w.id::text AS "workspaceId",i.suitecrm_id AS "nativeId",i.reference_code AS "globalId",o.attempts,
  encode(public.digest(to_jsonb(o)::text,'sha256'),'hex') AS "rowFingerprint",
  encode(public.digest(to_jsonb(i)::text,'sha256'),'hex') AS "sourceFingerprint",
  encode(public.digest(o.payload::text,'sha256'),'hex') AS "payloadFingerprint",
  encode(public.digest(o.idempotency_key,'sha256'),'hex') AS "keyFingerprint",
  ${HELD}.relationship_fingerprint(i.id) AS "relationshipFingerprint",
  ${HELD}.provider_identity_fingerprint(i.id) AS "providerIdentityFingerprint"
  FROM public.sync_outbox o JOIN public.crm_interactions i ON i.id::text=o.aggregate_id
  JOIN public.pipeline_spaces p ON p.id=i.pipeline_id
  JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
  JOIN public.crm_operator_workspace_bindings b ON b.workspace_id=w.id AND b.operator_account_id=$2::uuid
  WHERE o.id=ANY($3::uuid[]) AND b.owner_email=$1::text AND b.enabled AND NOT w.is_demo AND NOT p.reference_access_disabled
    AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.operation='upsert_record'
    AND o.status='dead' AND o.attempts=8 AND o.last_error='native_projection_proof_unavailable'
    AND o.processed_at IS NOT NULL AND o.locked_at IS NULL AND o.lock_token IS NULL
    AND o.payload->>'entity'='interactions' AND o.payload->>'localId'=i.id::text AND o.payload->>'pipelineId'=i.pipeline_id::text
    AND o.payload->>'suiteCrmId'=i.suitecrm_id AND o.payload->>'suiteCrmModule'='Emails'
    AND o.payload->>'previousSuiteCrmModule' IS NULL AND o.payload#>>'{attributes,global_id_c}'=i.reference_code
    AND i.suitecrm_module='Emails' AND i.suitecrm_synced_at IS NULL AND i.sync_status='failed'
    AND lower(i.source_key) NOT LIKE 'suitecrm%'
    AND o.idempotency_key='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
    AND jsonb_typeof(i.metadata)='object' AND NOT (i.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
    AND COALESCE(lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND NOT EXISTS(SELECT 1 FROM ${HELD}.held h WHERE h.outbox_id=o.id OR h.local_id=i.id
      OR h.native_id=i.suitecrm_id OR h.global_id=i.reference_code
      OR h.key_hash=encode(public.digest(o.idempotency_key,'sha256'),'hex')
      OR (h.pipeline_id=i.pipeline_id AND (h.provider_alias=NULLIF(lower(btrim(i.provider_message_id)),'')
        OR h.source_key=i.source_key)))
    AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_work x WHERE x.work_kind='outbox'
      AND (x.context->>'outboxId'=o.id::text OR x.context->>'idempotencyKey'=o.idempotency_key))
    AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=i.id
      OR lower(a.native_id)=i.suitecrm_id OR lower(a.global_id)=i.reference_code)
    AND NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=o.id OR h.retired_outbox_id=o.id
      OR h.local_id=i.id OR h.native_id=i.suitecrm_id OR h.global_id=i.reference_code)
    AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h WHERE h.outbox_id=o.id OR h.local_id=i.id
      OR h.native_id=i.suitecrm_id OR h.global_id=i.reference_code)
    AND NOT EXISTS(SELECT 1 FROM public.crm_interactions other WHERE other.id<>i.id AND (
      lower(other.suitecrm_id)=i.suitecrm_id OR lower(other.reference_code)=i.reference_code OR (other.pipeline_id=i.pipeline_id
        AND (lower(btrim(other.provider_message_id))=NULLIF(lower(btrim(i.provider_message_id)),'') OR other.source_key=i.source_key))))
    AND NOT EXISTS(SELECT 1 FROM public.sync_outbox other WHERE other.id<>o.id AND other.target_system='suitecrm'
      AND ((other.aggregate_type='crm_interactions' AND lower(other.aggregate_id)=i.id::text)
      OR lower(other.payload->>'localId')=i.id::text OR lower(other.payload->>'suiteCrmId')=i.suitecrm_id
      OR lower(other.payload#>>'{attributes,global_id_c}')=i.reference_code OR other.idempotency_key=o.idempotency_key))
  ORDER BY o.id`

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_terminal_hold_app_observer_' + code)
}
const matches = (value: unknown, pattern: RegExp): value is string => typeof value==='string' && pattern.test(value)
function one(rows: Row[]): Row { need(rows.length===1,'shape'); return rows[0] }
function number(value: unknown): number {
  need(matches(value,DECIMAL)&&Number.isSafeInteger(Number(value)),'shape')
  return Number(value)
}

/** The trusted port owns a direct READ ONLY REPEATABLE READ session, statement
 * deadlines and closure; the adapter supplies only fixed SELECT statements.
 * No default connection or role grants are provided. */
export function createLegacyEmailTerminalHoldAppObserver(target: Target, withReadOnlySession: WithSession) {
  const {database,databaseOid,systemIdentifier,observerRole}=target
  need(matches(observerRole,ROLE)&&typeof withReadOnlySession==='function','configuration')
  const storeFingerprint=nativeEmailPostgresStoreFingerprint({database,databaseOid,systemIdentifier})
  const observerFingerprint=nativeEmailDigest({version:1,purpose:'clawpilot-terminal-hold-app-observer-v1',storeFingerprint,observerRole})
  async function observeApp(request: LegacyEmailTerminalHoldAppObservationRequest, signal: AbortSignal):
    Promise<LegacyEmailTerminalHoldAppObservation> {
    const {target:{outboxIds,scope,actorEmail,operatorAccountId,rootWorkspaceId},phase,observationId,candidateFingerprint}=request
    const ids=[...outboxIds]
    need(!signal.aborted&&['appBefore','appAfter'].includes(phase)&&matches(observationId,UUID)
      &&matches(candidateFingerprint,HASH)&&scope.postgresDatabaseFingerprint===storeFingerprint
      &&request.target.postgresObserverFingerprint===observerFingerprint&&ids.length>=1&&ids.length<=25
      &&ids.every((id,index)=>matches(id,UUID)&&(index===0||ids[index-1]<id))
      &&matches(operatorAccountId,UUID)&&matches(rootWorkspaceId,UUID),'request')
    let invoked=false,open=true,completed:LegacyEmailTerminalHoldAppObservation|undefined
    const result=await Promise.resolve().then(()=>withReadOnlySession(signal,async query=>{
      need(open&&!invoked&&!signal.aborted,'session')
      invoked=true
      const read=async (text:string,values?:readonly unknown[])=>{
        need(open&&!signal.aborted,'deadline')
        let reply
        try { reply=await query(text,values) } catch { need(false,'query_failed') }
        need(open&&!signal.aborted&&Array.isArray(reply?.rows),'shape')
        return reply.rows
      }
      const identity=async()=>{
        const row=one(await read(SESSION))
        need(row.observed===true&&row.database===database&&row.oid===databaseOid&&row.system===systemIdentifier
          &&row.login===observerRole&&row.role===observerRole&&Number.isSafeInteger(row.pid)&&Number(row.pid)>0
          &&typeof row.snapshot==='string'&&typeof row.transaction_start==='string','physical_session')
        return {pid:row.pid,snapshot:row.snapshot,transactionStart:row.transaction_start,epoch:number(row.epoch)}
      }
      const before=await identity()
      const gate=one(await read(AUTHORITY,[actorEmail,operatorAccountId,rootWorkspaceId]))
      need(gate.idle===true&&gate.owner===true&&matches(gate.gate,HASH)&&matches(gate.source,HASH),'authority')
      const rows=await read(ORIGINALS,[actorEmail,operatorAccountId,ids])
      need(rows.length===ids.length&&rows.every((row,index)=>row.outboxId===ids[index]),'reviewed_set')
      const after=await identity()
      need(after.pid===before.pid&&after.snapshot===before.snapshot&&after.transactionStart===before.transactionStart
        &&after.epoch>=before.epoch,'session_changed')
      completed=Object.freeze({phase,observationId,candidateFingerprint,storeFingerprint,observerFingerprint,observedAtMs:after.epoch,
        appGeneration:number(gate.generation),gateFingerprint:gate.gate,appSourceFingerprint:gate.source,
        authorityDisabledIdle:true,operatorRootVerified:true,rows:Object.freeze(rows.map(row=>Object.freeze({...row}) as LegacyEmailTerminalHoldRow))})
      return completed
    })).catch((error:unknown)=>{
      if(error instanceof NativeEmailPublicationHeld&&KNOWN_REFUSAL.test(error.code))throw error
      need(false,'session_failed')
    }).finally(()=>{open=false})
    need(completed&&result===completed&&!signal.aborted,'session')
    return completed
  }
  return Object.freeze({storeFingerprint,observerFingerprint,observeApp})
}
