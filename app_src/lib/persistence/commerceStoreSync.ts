import { createHash, randomUUID } from 'node:crypto'
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
import {
  commerceReadAccountSql,
  type CommerceReadCapability,
} from '@/lib/integrations/commerceReadRuntime'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const EFFECTIVE_REASONS = new Set<CommerceStoreSyncEffectiveReason>(
  Object.keys(
    COMMERCE_STORE_SYNC_EFFECTIVE_REASON_LABELS,
  ) as CommerceStoreSyncEffectiveReason[],
)
const PROVIDER_READ_HEARTBEAT_INTERVAL_MS = 15_000
const PROVIDER_READ_LEASE_SECONDS = 60

export type CommerceStoreSyncProviderReadAuthority =
  | 'automatic'
  | 'manual_read_only'

export type CommerceStoreSyncProviderReadKind =
  | 'catalog_intake'
  | 'order_history'
  | 'order_revision'
  | 'shopify_webhook_hydration'
  | 'shopify_inventory'
  | 'product_image_import'
  | 'faire_inventory_poll'

export type CommerceStoreSyncProviderReadLease = {
  id: string
  authorityKind: CommerceStoreSyncProviderReadAuthority
  readKind: CommerceStoreSyncProviderReadKind
  intentFingerprintSha256: string
  controlRevision: number
  activationRevision: number
  expiresAt: string
}

function providerReadCapability(
  readKind: CommerceStoreSyncProviderReadKind,
): CommerceReadCapability {
  switch (readKind) {
    case 'catalog_intake':
      return 'catalog'
    case 'product_image_import':
      return 'images'
    case 'shopify_inventory':
    case 'faire_inventory_poll':
      return 'inventory'
    case 'shopify_webhook_hydration':
      return 'webhook_hydration'
    case 'order_history':
    case 'order_revision':
      return 'orders_history'
  }
}

function providerReadAccountSql(
  alias: string,
  readKind: CommerceStoreSyncProviderReadKind,
) {
  return commerceReadAccountSql(alias, {
    capability: providerReadCapability(readKind),
  })
}

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

export class CommerceStoreSyncProviderReadFenceError extends Error {
  readonly code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
  readonly status = 409

  constructor() {
    super('Store sync is Paused for this commerce connection')
    this.name = 'CommerceStoreSyncProviderReadFenceError'
  }
}

export class CommerceStoreSyncProviderReadLeaseError extends Error {
  readonly code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
  readonly status = 409

  constructor() {
    super('The bounded provider-read lease ended before the read completed')
    this.name = 'CommerceStoreSyncProviderReadLeaseError'
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

export function commerceStoreSyncProviderReadIntentFingerprint(input: {
  organizationId: string
  integrationAccountId: string
  authorityKind: CommerceStoreSyncProviderReadAuthority
  readKind: CommerceStoreSyncProviderReadKind
  intentKey: string
}) {
  return requestHash({
    version: 'commerce-store-sync-provider-read-v1',
    organizationId: input.organizationId,
    integrationAccountId: input.integrationAccountId,
    authorityKind: input.authorityKind,
    readKind: input.readKind,
    intentKey: input.intentKey,
  })
}

async function acquireProviderReadLease(input: {
  organizationId: string
  integrationAccountId: string
  authorityKind: CommerceStoreSyncProviderReadAuthority
  readKind: CommerceStoreSyncProviderReadKind
  intentKey: string
  acquiredBy: string
}): Promise<CommerceStoreSyncProviderReadLease> {
  const id = randomUUID()
  const intentFingerprintSha256 =
    commerceStoreSyncProviderReadIntentFingerprint(input)
  return withTransaction(async (client) => {
    // Establish the account-first order explicitly before touching leases or
    // controls. The authority query below retains its original SHARE locks
    // and all eligibility checks; no provider I/O runs in this transaction.
    await client.query(
      `SELECT id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR SHARE`,
      [input.organizationId, input.integrationAccountId],
    )
    await client.query(
      `UPDATE operations_commerce_store_sync_read_leases
       SET released_at = date_trunc('milliseconds', clock_timestamp()),
           release_reason = 'expired'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND released_at IS NULL
         AND expires_at <= clock_timestamp()`,
      [input.organizationId, input.integrationAccountId],
    )
    const current = await client.query<{
      control_revision: string | number
      activation_revision: string | number
    }>(
      `SELECT control.revision AS control_revision,
              activation.revision AS activation_revision
       FROM operations_integration_accounts account
       JOIN operations_commerce_store_sync_controls control
         ON control.organization_id = account.organization_id
        AND control.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
         AND ${providerReadAccountSql('account', input.readKind)}
         AND operations_commerce_provider_read_authority_is_current(
           account.organization_id,
           account.id,
           $3
         )
       LIMIT 1
       FOR SHARE OF account, control, activation`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.authorityKind,
      ],
    )
    if (!current.rows[0]) {
      throw new CommerceStoreSyncProviderReadFenceError()
    }
    const controlRevision = Number(current.rows[0].control_revision)
    const activationRevision = Number(current.rows[0].activation_revision)
    if (
      !Number.isSafeInteger(controlRevision)
      || controlRevision < 1
      || !Number.isSafeInteger(activationRevision)
      || activationRevision < 1
    ) {
      throw new CommerceStoreSyncProviderReadFenceError()
    }
    const inserted = await client.query<{ expires_at: Date | string }>(
      `INSERT INTO operations_commerce_store_sync_read_leases (
         id,
         organization_id,
         integration_account_id,
         authority_kind,
         read_kind,
         intent_fingerprint_sha256,
         control_revision,
         activation_revision,
         acquired_by,
         acquired_at,
         heartbeat_at,
         expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
         date_trunc('milliseconds', statement_timestamp()),
         date_trunc('milliseconds', statement_timestamp()),
         date_trunc('milliseconds', statement_timestamp())
           + ($10::integer * interval '1 second')
       )
       ON CONFLICT DO NOTHING
       RETURNING expires_at`,
      [
        id,
        input.organizationId,
        input.integrationAccountId,
        input.authorityKind,
        input.readKind,
        intentFingerprintSha256,
        controlRevision,
        activationRevision,
        input.acquiredBy,
        PROVIDER_READ_LEASE_SECONDS,
      ],
    )
    if (!inserted.rows[0]) {
      throw new CommerceStoreSyncProviderReadLeaseError()
    }
    return {
      id,
      authorityKind: input.authorityKind,
      readKind: input.readKind,
      intentFingerprintSha256,
      controlRevision,
      activationRevision,
      expiresAt: new Date(inserted.rows[0].expires_at).toISOString(),
    }
  })
}

async function renewProviderReadLease(input: {
  organizationId: string
  integrationAccountId: string
  leaseId: string
  readKind: CommerceStoreSyncProviderReadKind
}) {
  const result = await query(
    `UPDATE operations_commerce_store_sync_read_leases
     SET heartbeat_at = date_trunc('milliseconds', clock_timestamp()),
         expires_at = date_trunc('milliseconds', clock_timestamp())
           + ($4::integer * interval '1 second')
     WHERE id = $3::uuid
       AND organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND read_kind = $5
       AND released_at IS NULL
       AND expires_at > clock_timestamp()
       AND EXISTS (
         SELECT 1
         FROM operations_commerce_store_sync_controls control
         JOIN operations_integration_accounts account
           ON account.organization_id = control.organization_id
          AND account.id = control.integration_account_id
         WHERE control.organization_id =
                 operations_commerce_store_sync_read_leases.organization_id
           AND control.integration_account_id =
                 operations_commerce_store_sync_read_leases.integration_account_id
           AND control.revision =
                 operations_commerce_store_sync_read_leases.control_revision
           AND ${providerReadAccountSql('account', input.readKind)}
           AND operations_commerce_provider_read_authority_is_current(
             control.organization_id,
             control.integration_account_id,
             operations_commerce_store_sync_read_leases.authority_kind
           )
       )
     RETURNING id`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.leaseId,
      PROVIDER_READ_LEASE_SECONDS,
      input.readKind,
    ],
  )
  if (!result.rows[0]) throw new CommerceStoreSyncProviderReadLeaseError()
}

async function releaseProviderReadLease(input: {
  organizationId: string
  integrationAccountId: string
  leaseId: string
  readKind: CommerceStoreSyncProviderReadKind
  releaseReason: 'completed' | 'failed'
}) {
  const result = await query<{ release_reason: string | null }>(
    `UPDATE operations_commerce_store_sync_read_leases
     SET released_at = date_trunc('milliseconds', clock_timestamp()),
         release_reason = $4
     WHERE id = $3::uuid
       AND organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND read_kind = $5
       AND released_at IS NULL
       AND (
         $4 <> 'completed'
         OR (
           captured_at IS NOT NULL
           OR (
             expires_at > clock_timestamp()
             AND EXISTS (
             SELECT 1
             FROM operations_commerce_store_sync_controls control
             JOIN operations_integration_accounts account
               ON account.organization_id = control.organization_id
              AND account.id = control.integration_account_id
             WHERE control.organization_id =
                     operations_commerce_store_sync_read_leases.organization_id
               AND control.integration_account_id =
                     operations_commerce_store_sync_read_leases.integration_account_id
               AND control.revision =
                     operations_commerce_store_sync_read_leases.control_revision
               AND ${providerReadAccountSql('account', input.readKind)}
               AND operations_commerce_provider_read_authority_is_current(
                 control.organization_id,
                 control.integration_account_id,
                 operations_commerce_store_sync_read_leases.authority_kind
               )
             )
           )
         )
       )
     RETURNING release_reason`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.leaseId,
      input.releaseReason,
      input.readKind,
    ],
  )
  if (result.rows[0]) return
  if (input.releaseReason === 'completed') {
    await query(
      `UPDATE operations_commerce_store_sync_read_leases
       SET released_at = date_trunc('milliseconds', clock_timestamp()),
           release_reason = CASE
             WHEN expires_at <= clock_timestamp() THEN 'expired'
             ELSE 'failed'
           END
       WHERE id = $3::uuid
         AND organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND released_at IS NULL`,
      [input.organizationId, input.integrationAccountId, input.leaseId],
    )
    throw new CommerceStoreSyncProviderReadLeaseError()
  }
  const retained = await query<{ release_reason: string | null }>(
    `SELECT release_reason
     FROM operations_commerce_store_sync_read_leases
     WHERE id = $3::uuid
       AND organization_id = $1::uuid
       AND integration_account_id = $2::uuid
     LIMIT 1`,
    [input.organizationId, input.integrationAccountId, input.leaseId],
  )
  if (!retained.rows[0]?.release_reason) {
    throw new CommerceStoreSyncProviderReadLeaseError()
  }
}

export async function assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    lease: CommerceStoreSyncProviderReadLease
    authorityKind: CommerceStoreSyncProviderReadAuthority
    readKind: CommerceStoreSyncProviderReadKind
  },
) {
  const current = await client.query(
    `SELECT lease.id
     FROM operations_commerce_store_sync_read_leases lease
     JOIN operations_commerce_store_sync_controls control
       ON control.organization_id = lease.organization_id
      AND control.integration_account_id = lease.integration_account_id
     JOIN operations_integration_accounts account
       ON account.organization_id = lease.organization_id
      AND account.id = lease.integration_account_id
     WHERE lease.id = $3::uuid
       AND lease.organization_id = $1::uuid
       AND lease.integration_account_id = $2::uuid
       AND lease.authority_kind = $4
       AND lease.read_kind = $5
       AND lease.intent_fingerprint_sha256 = $6
       AND lease.control_revision = $7
       AND lease.activation_revision = $8
       AND lease.released_at IS NULL
       AND lease.expires_at > clock_timestamp()
       AND control.revision = lease.control_revision
       AND ${providerReadAccountSql('account', input.readKind)}
       AND operations_commerce_provider_read_authority_is_current(
         lease.organization_id,
         lease.integration_account_id,
         lease.authority_kind
       )
     LIMIT 1
     FOR SHARE OF lease, control, account`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.lease.id,
      input.authorityKind,
      input.readKind,
      input.lease.intentFingerprintSha256,
      input.lease.controlRevision,
      input.lease.activationRevision,
    ],
  )
  if (!current.rows[0]) throw new CommerceStoreSyncProviderReadLeaseError()
  const captured = await client.query(
    `UPDATE operations_commerce_store_sync_read_leases
     SET captured_at = date_trunc('milliseconds', clock_timestamp())
     WHERE id = $3::uuid
       AND organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND captured_at IS NULL
       AND released_at IS NULL
       AND expires_at > clock_timestamp()
     RETURNING id`,
    [input.organizationId, input.integrationAccountId, input.lease.id],
  )
  if (!captured.rows[0]) throw new CommerceStoreSyncProviderReadLeaseError()
}

export async function reconcileExpiredCommerceStoreSyncProviderReadLeasesInPostgres(
  limit = 250,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new CommerceStoreSyncProviderReadLeaseError()
  }
  const reconciled = await query(
    `WITH expired AS (
       SELECT id
       FROM operations_commerce_store_sync_read_leases
       WHERE released_at IS NULL
         AND expires_at <= clock_timestamp()
       ORDER BY expires_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE operations_commerce_store_sync_read_leases lease
     SET released_at = date_trunc('milliseconds', clock_timestamp()),
         release_reason = 'expired'
     FROM expired
     WHERE lease.id = expired.id
     RETURNING lease.id`,
    [limit],
  )
  return { reconciled: reconciled.rowCount || 0 }
}

/**
 * Acquires one durable provider-read intent in a short exact-account
 * transaction, then releases every row lock before network I/O. Pause and
 * control changes therefore commit promptly. Automatic acquisition requires
 * effective Running; permissioned manual read-only acquisition ignores
 * Desired=Paused. A heartbeat keeps
 * a precommitted read visible as draining and makes crash expiry bounded.
 */
export async function withCommerceStoreSyncProviderReadFenceInPostgres<T>(
  input: {
    organizationId: string
    integrationAccountId: string
    authorityKind: CommerceStoreSyncProviderReadAuthority
    readKind: CommerceStoreSyncProviderReadKind
    intentKey: string
    acquiredBy: string
    read: (lease: CommerceStoreSyncProviderReadLease) => Promise<T>
  },
): Promise<T> {
  if (
    !ORGANIZATION_ID.test(input.organizationId)
    || !ORGANIZATION_ID.test(input.integrationAccountId)
    || !['automatic', 'manual_read_only'].includes(input.authorityKind)
    || ![
      'catalog_intake',
      'order_history',
      'order_revision',
      'shopify_webhook_hydration',
      'shopify_inventory',
      'product_image_import',
      'faire_inventory_poll',
    ].includes(input.readKind)
    || input.intentKey.length < 1
    || input.intentKey.length > 500
    || /[\p{C}]/u.test(input.intentKey)
    || input.acquiredBy.length < 1
    || input.acquiredBy.length > 200
    || /[\p{C}]/u.test(input.acquiredBy)
  ) {
    throw new CommerceStoreSyncProviderReadFenceError()
  }
  const lease = await acquireProviderReadLease(input)
  let finished = false
  let renewal = Promise.resolve()
  let renewalError: unknown = null
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (finished || renewalError) return
      try {
        await renewProviderReadLease({
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          leaseId: lease.id,
          readKind: input.readKind,
        })
      } catch (error) {
        renewalError = error
      }
    })
  }, PROVIDER_READ_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  let succeeded = false
  let runtimeMaintenance = false
  try {
    const result = await input.read(lease)
    await renewal
    if (renewalError) throw renewalError
    succeeded = true
    return result
  } catch (error) {
    runtimeMaintenance = isIntegrationCredentialRuntimeGateError(error)
    throw error
  } finally {
    finished = true
    clearInterval(timer)
    const release = async () => {
      await renewal
      await releaseProviderReadLease({
        organizationId: input.organizationId,
        integrationAccountId: input.integrationAccountId,
        leaseId: lease.id,
        readKind: input.readKind,
        releaseReason: succeeded ? 'completed' : 'failed',
      })
    }
    if (runtimeMaintenance) {
      // Releasing the lease is best-effort during credential maintenance. A
      // database/lease cleanup failure must not replace the typed outage that
      // lets routes and workers return 503 or park claimed work for retry.
      await Promise.allSettled([release()])
    } else {
      await release()
    }
  }
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
