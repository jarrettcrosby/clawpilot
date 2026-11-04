import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTransaction } from './postgres'
import { reviewedEmailAudienceUnderNativeControlWithClient, type CrmOutboxItem } from './crm'
import { crmSourceHash } from '../crm/stableId'
import { nativeEmailDigest } from '../crm/nativeEmailPublication'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const GMAIL_ID = /^[a-f0-9]{1,128}(?![\s\S])/
const MAX_ATTEMPTS = 8
type Row = Record<string, unknown>

export class ExactEmailPublicationHeld extends Error {
  constructor() { super('Selected email publication is unavailable or changed; review a fresh preview') }
}
function check(value: unknown): asserts value { if (!value) throw new ExactEmailPublicationHeld() }

export type ExactEmailPublicationSelection = {
  ownerEmail: string
  workspaceId: string
  pipelineId: string
  connectionId: string
  messageIds: string[]
}
export type ExactEmailPublicationPreview = {
  digest: string
  pipelineId: string
  messages: Array<{ messageId: string; globalId: string; status: string }>
}
function selection(input: ExactEmailPublicationSelection) {
  check(input && typeof input.ownerEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail)
    && input.ownerEmail === input.ownerEmail.trim().toLowerCase()
    && typeof input.workspaceId === 'string' && UUID.test(input.workspaceId)
    && typeof input.pipelineId === 'string' && UUID.test(input.pipelineId)
    && typeof input.connectionId === 'string' && /^[A-Za-z0-9_-]{1,200}(?![\s\S])/.test(input.connectionId)
    && Array.isArray(input.messageIds) && input.messageIds.length > 0 && input.messageIds.length <= 25
    && input.messageIds.every(id => typeof id === 'string' && GMAIL_ID.test(id))
    && new Set(input.messageIds).size === input.messageIds.length)
  return { ...input, messageIds: [...input.messageIds].sort() }
}

/** Only the reviewed exact selection may be claimed. This intentionally does
 * not recycle leases or resolve the global active operation: either can write
 * messages outside the operator's selection. The ordinary resolver owns those
 * outcomes. No disabled-mode/legacy writer fallback is permitted here. */
async function snapshot(tx: PoolClient, input: ExactEmailPublicationSelection) {
  const control = await tx.query(`SELECT enabled,generation,verified_generation,native_policy_fingerprint,
    activation_receipt_hash,active_operation_id,active_transition_id
    FROM crm_native_email_publication_control WHERE singleton FOR UPDATE`)
  const c = control.rows[0]
  check(control.rows.length === 1 && c.enabled === true && c.active_operation_id === null
    && c.active_transition_id === null && Number.isSafeInteger(Number(c.generation)) && Number(c.generation) > 0
    && Number(c.verified_generation) === Number(c.generation)
    && typeof c.native_policy_fingerprint === 'string' && HASH.test(c.native_policy_fingerprint)
    && typeof c.activation_receipt_hash === 'string' && HASH.test(c.activation_receipt_hash))
  // All app authority is read under the same control lock used by its guards.
  const owner = await tx.query(`SELECT pipeline.id FROM pipeline_spaces pipeline
    JOIN app_users app_user ON app_user.email=pipeline.owner_email AND app_user.status='active'
    JOIN app_user_organization_memberships membership ON membership.user_email=app_user.email
      AND membership.organization_id=pipeline.workspace_organization_id AND membership.status='active'
      AND membership.trashed_at IS NULL
    WHERE pipeline.id=$1::uuid AND pipeline.workspace_organization_id=$2::uuid
      AND pipeline.owner_email=$3 AND NOT pipeline.reference_access_disabled`,
  [input.pipelineId,input.workspaceId,input.ownerEmail])
  check(owner.rows.length === 1)
  const audience = await reviewedEmailAudienceUnderNativeControlWithClient(tx,input.pipelineId)
  check(audience.pipelineId === input.pipelineId && audience.workspaceId === input.workspaceId)
  // Bind to the independently verified selected mailbox, never an address or
  // caller-supplied provider subject. A changed connector invalidates review.
  const mailbox = await tx.query(`SELECT mailbox.id::text,binding.verified_at::text,binding.account_email
    FROM crm_email_mailboxes mailbox JOIN crm_email_mailbox_bindings binding
      ON binding.mailbox_id=mailbox.id AND binding.owner_email=mailbox.owner_email
    JOIN user_maton_connections connection ON connection.owner_email=binding.owner_email
      AND connection.connection_id=binding.connection_id AND connection.app='google-mail'
      AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
    WHERE mailbox.owner_email=$1 AND mailbox.provider='gmail' AND binding.connection_id=$2
      AND lower(btrim(binding.account_email))=lower(btrim(connection.account_email))
      AND COALESCE((to_jsonb(connection)->>'remote_updated_at')::timestamptz,'-infinity')<=binding.verified_at
    FOR SHARE OF mailbox,binding,connection`,[input.ownerEmail,input.connectionId])
  check(mailbox.rows.length === 1 && UUID.test(mailbox.rows[0].id))
  const sources = await tx.query(`SELECT id::text,provider_message_id,provider_thread_id,evidence_hash
    FROM crm_email_sources WHERE mailbox_id=$1::uuid AND owner_email=$2
      AND provider_message_id=ANY($3::text[]) ORDER BY provider_message_id FOR SHARE`,
  [mailbox.rows[0].id,input.ownerEmail,input.messageIds])
  check(sources.rows.length === input.messageIds.length
    && new Set(sources.rows.map(row => row.provider_message_id)).size === input.messageIds.length
    && sources.rows.every(row => input.messageIds.includes(row.provider_message_id)
      && UUID.test(row.id) && typeof row.evidence_hash === 'string' && HASH.test(row.evidence_hash)))
  // Canonical source + pipeline identity, not subject or global queue order.
  // Lock interactions before outboxes, matching publication admission.
  const interactions = await tx.query(`SELECT id::text,canonical_source_id::text,pipeline_id::text,
    provider_message_id,provider_thread_id,reference_code,suitecrm_id,suitecrm_module,source_hash,source_payload
    FROM crm_interactions WHERE pipeline_id=$1::uuid AND canonical_source_id=ANY($2::uuid[])
    ORDER BY id FOR UPDATE`,[input.pipelineId,sources.rows.map(row => row.id)])
  check(interactions.rows.length === sources.rows.length
    && new Set(interactions.rows.map(row => row.canonical_source_id)).size === sources.rows.length)
  const identities = interactions.rows.map(i => {
    const source = sources.rows.find(row => row.id === i.canonical_source_id)
    check(source && i.pipeline_id === input.pipelineId && i.provider_message_id === source.provider_message_id
      && i.provider_thread_id === source.provider_thread_id && i.suitecrm_module === 'Emails'
      && typeof i.id === 'string' && UUID.test(i.id) && typeof i.suitecrm_id === 'string' && UUID.test(i.suitecrm_id)
      && typeof i.reference_code === 'string' && i.reference_code.length > 0
      && typeof i.source_hash === 'string' && HASH.test(i.source_hash)
      && !['true','1','yes'].includes(String((i.source_payload as Row | null)?.archived || '').toLowerCase()))
    return { interaction:i,source,key:`crm:interactions:v4:${i.id}:Emails:${i.source_hash}` }
  })
  const outboxes = await tx.query(`SELECT outbox.*,outbox.available_at<=now() AS ready,
    EXISTS(SELECT 1 FROM crm_native_email_publication_work work
      JOIN crm_native_email_publication_admissions admission ON admission.operation_id=work.operation_id
      WHERE work.work_kind='outbox' AND work.context->>'outboxId'=outbox.id::text
        AND admission.state IN ('admitted','dispatched','unknown')) AS unresolved
    FROM sync_outbox outbox WHERE outbox.target_system='suitecrm' AND outbox.aggregate_type='crm_interactions'
      AND outbox.aggregate_id=ANY($1::text[]) AND outbox.idempotency_key=ANY($2::text[])
    ORDER BY outbox.id FOR UPDATE OF outbox`,[identities.map(row => row.interaction.id),identities.map(row => row.key)])
  check(outboxes.rows.length === identities.length)
  const rows = identities.map(({interaction:i,source,key}) => {
    const matches = outboxes.rows.filter(row => row.aggregate_id === i.id && row.idempotency_key === key)
    check(matches.length === 1)
    const o = matches[0], p = o.payload as Row, projection = p?.emailProjection as Row | undefined
    check(o.operation === 'upsert_record' && UUID.test(o.id) && p?.entity === 'interactions'
      && p.localId === i.id && p.pipelineId === input.pipelineId && p.suiteCrmId === i.suitecrm_id
      && p.suiteCrmModule === 'Emails' && !p.previousSuiteCrmModule
      && (p.attributes as Row)?.global_id_c === i.reference_code
      && (p.attributes as Row)?.assigned_user_id === audience.ownerSuiteCrmId
      && projection && nativeEmailDigest(projection.audience) === nativeEmailDigest(audience)
      && o.unresolved === false && ['queued','failed','processing','succeeded','dead'].includes(o.status))
    return {interaction:i,source,outbox:o}
  }).sort((a,b) => a.source.provider_message_id.localeCompare(b.source.provider_message_id))
  const digest = nativeEmailDigest({ version:1,input,mailbox:mailbox.rows[0],generation:Number(c.generation),
    policyFingerprint:c.native_policy_fingerprint,activationReceiptHash:c.activation_receipt_hash,audience,
    messages:rows.map(({interaction:i,source,outbox:o}) => ({source,localId:i.id,globalId:i.reference_code,
      nativeId:i.suitecrm_id,sourceHash:i.source_hash,outboxId:o.id,idempotencyKey:o.idempotency_key,payloadHash:crmSourceHash(o.payload)})) })
  const preview:ExactEmailPublicationPreview = {digest,pipelineId:input.pipelineId,
    messages:rows.map(({interaction,source,outbox}) => ({messageId:source.provider_message_id,
      globalId:interaction.reference_code,status:outbox.status}))}
  return {preview,rows}
}

export async function previewExactEmailPublicationInPostgres(input:ExactEmailPublicationSelection) {
  const selected = selection(input)
  return withTransaction(async tx => (await snapshot(tx,selected)).preview)
}

export async function claimExactEmailPublicationInPostgres(input:ExactEmailPublicationSelection,expectedDigest:string) {
  const selected = selection(input)
  check(typeof expectedDigest === 'string' && HASH.test(expectedDigest))
  return withTransaction(async tx => {
    const {preview,rows} = await snapshot(tx,selected)
    check(preview.digest === expectedDigest)
    // Validate the complete requested batch before its first mutation. A replay
    // of the same reviewed revision never reclaims a succeeded job. It does not
    // by itself assert native delivery; the receipt-owning coordinator does.
    const pending = rows.filter(row => row.outbox.status !== 'succeeded')
    check(pending.every(({outbox:o}) => ['queued','failed'].includes(o.status) && o.ready === true
      && Number.isInteger(Number(o.attempts)) && Number(o.attempts) >= 0 && Number(o.attempts) < MAX_ATTEMPTS))
    const items:CrmOutboxItem[] = []
    for (const {outbox:o} of pending) {
      const token = randomUUID()
      const updated = await tx.query(`UPDATE sync_outbox SET status='processing',attempts=attempts+1,
        locked_at=now(),lock_token=$2,updated_at=now()
        WHERE id=$1::uuid AND target_system='suitecrm' AND aggregate_type='crm_interactions'
          AND aggregate_id=$3 AND idempotency_key=$4 AND payload=$5::jsonb
          AND status IN ('queued','failed') AND attempts=$6 AND available_at<=now()
        RETURNING id`,[o.id,token,o.aggregate_id,o.idempotency_key,JSON.stringify(o.payload),o.attempts])
      check(updated.rows.length === 1)
      items.push({id:o.id,aggregateType:o.aggregate_type,aggregateId:o.aggregate_id,operation:'upsert_record',
        payload:o.payload,idempotencyKey:o.idempotency_key,attempts:Number(o.attempts)+1,lockToken:token})
    }
    return {preview,items,alreadyCompleted:rows.length-pending.length,maxAttempts:MAX_ATTEMPTS}
  })
}
