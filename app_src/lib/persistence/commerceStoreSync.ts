import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS,
  commerceStoreSyncEffectiveState,
  type CommerceStoreSyncControl,
  type CommerceStoreSyncDesiredState,
  type CommerceStoreSyncEffectiveReason,
  type CommerceStoreSyncUpdateResult,
} from '@/lib/operations/commerceStoreSync'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const EFFECTIVE_REASONS = new Set<CommerceStoreSyncEffectiveReason>(
  Object.keys(
    COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS,
  ) as CommerceStoreSyncEffectiveReason[],
)

type StoreSyncRow = {
  account_global_id: string
  provider: 'shopify' | 'faire'
  environment: 'mock' | 'sandbox' | 'production'
  display_name: string
  account_status: 'active' | 'disabled' | 'error'
  desired_state: CommerceStoreSyncDesiredState
  explicit_choice: boolean
  revision: string | number
  reason: string
  updated_at: Date | string
  effective_reason: CommerceStoreSyncEffectiveReason
}

export class CommerceStoreSyncPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new CommerceStoreSyncPersistenceError(code, message, status)
}

function requestHash(input: Record<string, unknown>) {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}

function mapControl(row: StoreSyncRow): CommerceStoreSyncControl {
  if (!EFFECTIVE_REASONS.has(row.effective_reason)) {
    fail(
      'COMMERCE_STORE_SYNC_EFFECTIVE_REASON_INVALID',
      'Store sync returned an unsupported effective reason',
      500,
    )
  }
  return {
    accountGlobalId: row.account_global_id,
    provider: row.provider,
    environment: row.environment,
    displayName: row.display_name,
    accountStatus: row.account_status,
    desiredState: row.desired_state,
    effectiveState: commerceStoreSyncEffectiveState(row.effective_reason),
    effectiveReason: row.effective_reason,
    effectiveReasonLabel:
      COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS[row.effective_reason],
    explicitChoice: row.explicit_choice,
    revision: Number(row.revision),
    reason: row.reason,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function retainedResult(value: string): CommerceStoreSyncUpdateResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    fail(
      'COMMERCE_STORE_SYNC_RECEIPT_INVALID',
      'Retained Store sync response evidence is invalid',
      500,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('COMMERCE_STORE_SYNC_RECEIPT_INVALID', 'Retained Store sync response evidence is invalid', 500)
  }
  const result = parsed as Record<string, unknown>
  if (Object.keys(result).length !== 1
      || !result.control
      || typeof result.control !== 'object'
      || Array.isArray(result.control)) {
    fail('COMMERCE_STORE_SYNC_RECEIPT_INVALID', 'Retained Store sync response evidence is invalid', 500)
  }
  const control = result.control as Record<string, unknown>
  const expectedKeys = [
    'accountGlobalId',
    'provider',
    'environment',
    'displayName',
    'accountStatus',
    'desiredState',
    'effectiveState',
    'effectiveReason',
    'effectiveReasonLabel',
    'explicitChoice',
    'revision',
    'reason',
    'updatedAt',
  ]
  if (
    Object.keys(control).sort().join('\n') !== expectedKeys.sort().join('\n')
    || typeof control.effectiveReason !== 'string'
    || !EFFECTIVE_REASONS.has(
      control.effectiveReason as CommerceStoreSyncEffectiveReason,
    )
    || !ACCOUNT_GLOBAL_ID.test(String(control.accountGlobalId || ''))
    || !['shopify', 'faire'].includes(String(control.provider || ''))
    || !['mock', 'sandbox', 'production'].includes(
      String(control.environment || ''),
    )
    || typeof control.displayName !== 'string'
    || control.displayName.length < 1
    || control.displayName.length > 200
    || !['active', 'disabled', 'error'].includes(
      String(control.accountStatus || ''),
    )
    || !['running', 'paused'].includes(String(control.desiredState || ''))
    || typeof control.explicitChoice !== 'boolean'
    || typeof control.revision !== 'number'
    || !Number.isSafeInteger(control.revision)
    || control.revision < 1
    || typeof control.reason !== 'string'
    || control.reason.length < 1
    || control.reason.length > 500
    || typeof control.updatedAt !== 'string'
    || Number.isNaN(new Date(control.updatedAt).getTime())
  ) {
    fail('COMMERCE_STORE_SYNC_RECEIPT_INVALID', 'Retained Store sync response evidence is invalid', 500)
  }
  const effectiveReason =
    control.effectiveReason as CommerceStoreSyncEffectiveReason
  if (
    control.effectiveState !== commerceStoreSyncEffectiveState(effectiveReason)
    || control.effectiveReasonLabel
      !== COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS[effectiveReason]
  ) {
    fail('COMMERCE_STORE_SYNC_RECEIPT_INVALID', 'Retained Store sync response evidence is invalid', 500)
  }
  return parsed as CommerceStoreSyncUpdateResult
}

const CONTROL_SELECT = `SELECT
  account.global_id AS account_global_id,
  account.provider,
  account.environment,
  account.display_name,
  account.status AS account_status,
  control.desired_state,
  control.explicit_choice,
  control.revision,
  control.reason,
  control.updated_at,
  operations_commerce_store_sync_effective_reason(
    account.organization_id,
    account.id
  ) AS effective_reason
FROM operations_integration_accounts account
JOIN operations_commerce_store_sync_controls control
  ON control.organization_id = account.organization_id
 AND control.integration_account_id = account.id
WHERE account.organization_id = $1::uuid
  AND account.integration_type = 'commerce'
  AND account.provider IN ('shopify', 'faire')`

export async function readCommerceStoreSyncControlsFromPostgres(
  organizationId: string,
) {
  if (!ORGANIZATION_ID.test(organizationId)) {
    fail('OPERATIONS_ORGANIZATION_INVALID', 'Store sync organization is invalid', 400)
  }
  const result = await query<StoreSyncRow>(
    `${CONTROL_SELECT}
     ORDER BY lower(account.display_name), account.provider, account.id`,
    [organizationId],
  )
  return result.rows.map(mapControl)
}

async function exactControlWithClient(
  client: PoolClient,
  input: { organizationId: string; accountGlobalId: string; lock?: boolean },
) {
  const result = await client.query<StoreSyncRow & { integration_account_id: string }>(
    `${CONTROL_SELECT.replace(
      'account.global_id AS account_global_id,',
      'account.id::text AS integration_account_id, account.global_id AS account_global_id,',
    )}
       AND account.global_id = $2
     LIMIT 1
     ${input.lock ? 'FOR UPDATE OF account, control' : ''}`,
    [input.organizationId, input.accountGlobalId],
  )
  if (!result.rows[0]) {
    const account = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND global_id = $2
           AND integration_type = 'commerce'
           AND provider IN ('shopify', 'faire')
       ) AS exists`,
      [input.organizationId, input.accountGlobalId],
    )
    fail(
      account.rows[0]?.exists
        ? 'COMMERCE_STORE_SYNC_CONTROL_MISSING'
        : 'COMMERCE_STORE_SYNC_ACCOUNT_NOT_FOUND',
      account.rows[0]?.exists
        ? 'This commerce connection has no Store sync control; migration health must be repaired'
        : 'Commerce connection was not found in the active organization',
    )
  }
  return result.rows[0]
}

export async function updateCommerceStoreSyncControlInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  desiredState: CommerceStoreSyncDesiredState
  expectedDesiredState: CommerceStoreSyncDesiredState
  expectedRevision: number
  reason: string
  actorEmail: string
  idempotencyKey: string
}): Promise<CommerceStoreSyncUpdateResult> {
  const reason = input.reason.trim()
  const actorEmail = input.actorEmail.trim().toLowerCase()
  if (!ORGANIZATION_ID.test(input.organizationId)) {
    fail('OPERATIONS_ORGANIZATION_INVALID', 'Store sync organization is invalid', 400)
  }
  if (!ACCOUNT_GLOBAL_ID.test(input.accountGlobalId)) {
    fail('COMMERCE_STORE_SYNC_ACCOUNT_INVALID', 'Commerce connection is invalid', 400)
  }
  if (!['running', 'paused'].includes(input.desiredState)
      || !['running', 'paused'].includes(input.expectedDesiredState)) {
    fail('COMMERCE_STORE_SYNC_STATE_INVALID', 'Store sync state is invalid', 400)
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail('COMMERCE_STORE_SYNC_REVISION_INVALID', 'Store sync revision is invalid', 400)
  }
  if (reason.length < 1 || reason.length > 500 || /[\p{C}]/u.test(reason)) {
    fail('COMMERCE_STORE_SYNC_REASON_INVALID', 'Enter a readable Store sync reason between 1 and 500 characters', 400)
  }
  if (!/^\S+@\S+\.\S+$/.test(actorEmail) || actorEmail.length > 320) {
    fail('COMMERCE_STORE_SYNC_ACTOR_INVALID', 'Store sync actor is invalid', 400)
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    fail('COMMERCE_STORE_SYNC_IDEMPOTENCY_INVALID', 'A valid Idempotency-Key is required', 400)
  }

  const fingerprint = requestHash({
    version: 'commerce-store-sync-change-v1',
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    desiredState: input.desiredState,
    expectedDesiredState: input.expectedDesiredState,
    expectedRevision: input.expectedRevision,
    reason,
    actorEmail,
  })

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-store-sync:${input.organizationId}:${input.accountGlobalId}`,
    )
    const current = await exactControlWithClient(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
      lock: true,
    })
    const replay = await client.query<{
      request_hash: string
      response_json: string
    }>(
      `SELECT request_hash, response_json
       FROM operations_commerce_store_sync_change_receipts
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND idempotency_key = $3
       LIMIT 1`,
      [input.organizationId, current.integration_account_id, input.idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== fingerprint) {
        fail(
          'COMMERCE_STORE_SYNC_IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used for a different Store sync change',
        )
      }
      return retainedResult(replay.rows[0].response_json)
    }

    if (
      Number(current.revision) !== input.expectedRevision
      || current.desired_state !== input.expectedDesiredState
    ) {
      fail(
        'COMMERCE_STORE_SYNC_REVISION_CONFLICT',
        'Store sync changed; reload the Operations workbench and try again',
      )
    }

    await client.query(
      `UPDATE operations_commerce_store_sync_controls
       SET desired_state = $3,
           explicit_choice = true,
           revision = revision + 1,
           reason = $4,
           updated_by = $5,
           updated_at = date_trunc('milliseconds', clock_timestamp())
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [
        input.organizationId,
        current.integration_account_id,
        input.desiredState,
        reason,
        actorEmail,
      ],
    )
    const updated = await exactControlWithClient(client, {
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    })
    const control = mapControl(updated)
    const responseJson = JSON.stringify({ control })
    await client.query(
      `INSERT INTO operations_commerce_store_sync_change_receipts (
         organization_id,
         integration_account_id,
         idempotency_key,
         request_hash,
         previous_desired_state,
         desired_state,
         resulting_revision,
         reason,
         actor_email,
         response_json
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10
       )`,
      [
        input.organizationId,
        current.integration_account_id,
        input.idempotencyKey,
        fingerprint,
        current.desired_state,
        input.desiredState,
        control.revision,
        reason,
        actorEmail,
        responseJson,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      organizationId: input.organizationId,
      eventType: 'commerce.store_sync.updated',
      aggregateType: 'operations.commerce_store_sync_control',
      aggregateId: input.accountGlobalId,
      eventKey:
        `commerce-store-sync:${input.organizationId}:${input.accountGlobalId}:${input.idempotencyKey}`,
      payload: {
        provider: control.provider,
        environment: control.environment,
        previousDesiredState: current.desired_state,
        desiredState: control.desiredState,
        effectiveState: control.effectiveState,
        effectiveReason: control.effectiveReason,
        revision: control.revision,
        reason,
        providerWrites: 0,
      },
    }, client)
    return { control }
  })
}
