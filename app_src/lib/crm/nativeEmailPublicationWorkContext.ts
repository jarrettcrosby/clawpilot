import { nativeEmailCanonicalJson, nativeEmailDigest, prepareNativeEmailPublication, requireNativeEmail,
  type NativeEmailPublicationRequest } from './nativeEmailPublication'
import type { NativeEmailSqlClient } from './nativeEmailPublicationPostgres'

/** Prepared, unwired work identity. The repair variant requires an independently
 * approved exact manifest item; a hash alone is never approval. No payloads,
 * mailbox cursors, credentials or mutable source values are persisted here. */
export type NativeEmailPublicationWorkContext = {
  kind: 'outbox'
  outboxId: string
  idempotencyKey: string
  sourceHash: string
  payloadHash: string
  attempt: number
} | {
  kind: 'repair'
  manifestHash: string
  itemId: string
}
export type NativeEmailPublicationWorkLease = {
  operationId: string
  owner: string
  fence: number
  expiresAt: string
  context: NativeEmailPublicationWorkContext
}
/** Runs under the supplied transaction's control/admission/context locks.
 * Registration MUST verify the current exact outbox claim, immutable payload,
 * source revision and authority, or the exact approved repair manifest item.
 * Reassignment MUST verify resolver authorization and the same immutable work
 * identity, not require an expired original outbox claim or unchanged source.
 * Throw on any mismatch. A caller-supplied owner UUID is a lease identity, NOT
 * authentication; this mandatory callback supplies application authorization. */
export type NativeEmailWorkAuthorizer = (tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest,
  context: NativeEmailPublicationWorkContext, action: 'register' | 'resolve', owner: string) => Promise<void>

const HASH = /^[a-f0-9]{64}(?![\s\S])/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const ITEM = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}(?![\s\S])/
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())

function checkedRequest(request: NativeEmailPublicationRequest): NativeEmailPublicationRequest {
  const normalized = prepareNativeEmailPublication({ command: request.command,
    nativePolicyFingerprint: request.nativePolicyFingerprint, allowedReaderSuiteCrmUserIds: request.allowedReaderSuiteCrmUserIds })
  requireNativeEmail(normalized.commandHash === request.commandHash
    && normalized.requestFingerprint === request.requestFingerprint, 'work_request_fingerprint_changed')
  return normalized
}
export function prepareNativeEmailWorkContext(request: NativeEmailPublicationRequest,
  value: NativeEmailPublicationWorkContext): NativeEmailPublicationWorkContext {
  const checked = checkedRequest(request)
  requireNativeEmail(value && typeof value === 'object', 'invalid_work_context')
  if (value.kind === 'outbox') {
    requireNativeEmail(exact(value, ['kind','outboxId','idempotencyKey','sourceHash','payloadHash','attempt'])
      && checked.command.mode === 'publish' && matches(value.outboxId, UUID)
      && matches(value.sourceHash, HASH) && matches(value.payloadHash, HASH)
      && Number.isSafeInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 20
      && value.idempotencyKey === `crm:interactions:v4:${checked.command.localId}:Emails:${value.sourceHash}`,
    'invalid_outbox_work_context')
  } else {
    requireNativeEmail(exact(value, ['kind','manifestHash','itemId']) && value.kind === 'repair'
      && checked.command.mode === 'repair' && matches(value.manifestHash, HASH) && matches(value.itemId, ITEM),
    'invalid_repair_work_context')
  }
  return JSON.parse(nativeEmailCanonicalJson(value)) as NativeEmailPublicationWorkContext
}
function checkOwner(owner: string, seconds?: number): void {
  requireNativeEmail(matches(owner, UUID), 'invalid_work_lease_owner')
  if (seconds !== undefined) requireNativeEmail(Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 300,
    'invalid_work_lease_duration')
}
async function lockControl(tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest,
  active: boolean): Promise<void> {
  const c = request.command
  const result = await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
  const row = result.rows[0]
  requireNativeEmail(result.rows.length === 1 && row.enabled === true && Number(row.generation) === c.generation
    && Number(row.verified_generation) === c.generation && row.native_policy_fingerprint === request.nativePolicyFingerprint
    && matches(row.activation_receipt_hash, HASH)
    && row.active_operation_id === (active ? c.operationId : null), 'work_control_not_active')
}
async function lockAdmission(tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest): Promise<void> {
  const result = await tx.query('SELECT request_fingerprint,state FROM crm_native_email_publication_admissions WHERE operation_id=$1 FOR UPDATE',
    [request.command.operationId])
  requireNativeEmail(result.rows.length === 1 && result.rows[0].request_fingerprint === request.requestFingerprint
    && ['admitted','dispatched','unknown'].includes(String(result.rows[0].state)), 'work_admission_not_unresolved')
}
function readLease(request: NativeEmailPublicationRequest, row: Record<string, unknown>): NativeEmailPublicationWorkLease {
  const context = prepareNativeEmailWorkContext(request, row.context as NativeEmailPublicationWorkContext)
  requireNativeEmail(row.operation_id === request.command.operationId && row.request_fingerprint === request.requestFingerprint
    && row.context_hash === nativeEmailDigest(context) && row.work_kind === context.kind,
  'stored_work_context_changed')
  const fence = Number(row.lease_fence)
  const expiresAt = row.lease_until instanceof Date ? row.lease_until.toISOString() : String(row.lease_until)
  requireNativeEmail(matches(row.lease_owner, UUID) && Number.isSafeInteger(fence) && fence > 0
    && Number.isFinite(Date.parse(expiresAt)), 'stored_work_lease_invalid')
  return { operationId: request.command.operationId, owner: row.lease_owner, fence, expiresAt, context }
}

/** Call ONLY inside PostgresNativeEmailPublicationStore.admit's validator, after
 * all source/audience checks, using that callback's same open transaction. The
 * deferred FK requires the admission inserted later in that transaction. No
 * separate transaction/provider I/O is permitted inside this function/callback. */
export async function registerNativeEmailPublicationWork(tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest,
  input: NativeEmailPublicationWorkContext, owner: string, authorize: NativeEmailWorkAuthorizer,
  leaseSeconds = 120): Promise<NativeEmailPublicationWorkLease> {
  const checked = checkedRequest(request), context = prepareNativeEmailWorkContext(checked, input)
  checkOwner(owner, leaseSeconds)
  requireNativeEmail(typeof authorize === 'function', 'work_authorizer_required')
  await lockControl(tx, checked, false)
  await authorize(tx, checked, context, 'register', owner)
  const result = await tx.query(`INSERT INTO crm_native_email_publication_work
    (operation_id,request_fingerprint,work_kind,context,context_hash,lease_owner,lease_fence,lease_until)
    VALUES($1,$2,$3,$4::jsonb,$5,$6::uuid,1,clock_timestamp()+($7::integer * interval '1 second')) RETURNING *`,
  [checked.command.operationId,checked.requestFingerprint,context.kind,nativeEmailCanonicalJson(context),
    nativeEmailDigest(context),owner,leaseSeconds])
  requireNativeEmail(result.rows.length === 1, 'work_registration_missing')
  return readLease(checked, result.rows[0])
}

/** In a short open transaction, lock control -> admission -> work. Expiration
 * only permits another authorized resolver to take ownership; it NEVER changes
 * admission state, releases its barrier, grants permission, or resends publish.
 * Same-owner retries return the current live lease without extending it. */
export async function claimNativeEmailPublicationResolution(tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest,
  owner: string, authorize: NativeEmailWorkAuthorizer, leaseSeconds = 120): Promise<NativeEmailPublicationWorkLease> {
  const checked = checkedRequest(request)
  checkOwner(owner, leaseSeconds)
  requireNativeEmail(typeof authorize === 'function', 'work_authorizer_required')
  await lockControl(tx, checked, true)
  await lockAdmission(tx, checked)
  const selected = await tx.query(`SELECT *,lease_until>clock_timestamp() AS lease_live
    FROM crm_native_email_publication_work WHERE operation_id=$1 FOR UPDATE`, [checked.command.operationId])
  requireNativeEmail(selected.rows.length === 1, 'work_context_missing')
  const row = selected.rows[0], existing = readLease(checked, row)
  await authorize(tx, checked, existing.context, 'resolve', owner)
  if (row.lease_live === true) {
    requireNativeEmail(existing.owner === owner, 'work_lease_busy')
    return existing
  }
  requireNativeEmail(row.lease_live === false && existing.fence < Number.MAX_SAFE_INTEGER, 'work_lease_fence_exhausted')
  const result = await tx.query(`UPDATE crm_native_email_publication_work SET lease_owner=$2::uuid,
    lease_fence=lease_fence+1,lease_until=clock_timestamp()+($3::integer * interval '1 second'),updated_at=clock_timestamp()
    WHERE operation_id=$1 AND lease_fence=$4 AND lease_until<=clock_timestamp() RETURNING *`,
  [checked.command.operationId,owner,leaseSeconds,existing.fence])
  requireNativeEmail(result.rows.length === 1, 'work_lease_changed')
  return readLease(checked, result.rows[0])
}

/** Call first inside the store.settle finalizer's SAME transaction, then verify
 * raw receipt/audience and finalize exact outbox/repair evidence there. A source
 * revision change is superseded, not proof that the latest source is synced.
 * Stale/expired owners cannot settle even if they have a valid native receipt. */
export async function assertNativeEmailPublicationWorkLease(tx: NativeEmailSqlClient, request: NativeEmailPublicationRequest,
  expected: NativeEmailPublicationWorkLease): Promise<NativeEmailPublicationWorkContext> {
  const checked = checkedRequest(request)
  checkOwner(expected.owner)
  requireNativeEmail(expected.operationId === checked.command.operationId && Number.isSafeInteger(expected.fence)
    && expected.fence > 0, 'invalid_work_lease')
  await lockControl(tx, checked, true)
  await lockAdmission(tx, checked)
  const result = await tx.query(`SELECT *,lease_until>clock_timestamp() AS lease_live
    FROM crm_native_email_publication_work WHERE operation_id=$1 FOR UPDATE`, [checked.command.operationId])
  requireNativeEmail(result.rows.length === 1, 'work_context_missing')
  const row = result.rows[0], current = readLease(checked, row)
  requireNativeEmail(row.lease_live === true && current.owner === expected.owner && current.fence === expected.fence
    && nativeEmailDigest(current.context) === nativeEmailDigest(prepareNativeEmailWorkContext(checked, expected.context)),
  'work_lease_not_owned')
  return current.context
}
