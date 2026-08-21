import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  decryptCommerceCandidateSnapshot,
  encryptCommerceCandidateSnapshot,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  changedOrderShipToFields,
  mergeOrderShipToDraft,
  normalizeOrderShipToDraft,
  orderShipToIssues,
  orderShipToReadiness,
  orderShipToStorageValue,
  type OrderShipToDraft,
  type OrderShipToPatch,
} from '@/lib/operations/orderShipTo'
import type {
  OperationsImportedOrderShipToUpdateResult,
  OperationsImportedOrderWorkingCopy,
} from '@/lib/operations/types'
import {
  confirmCommerceCandidateAddressInPostgres,
  promoteCommerceCandidateInPostgres,
  validateCommerceCandidateInPostgres,
} from '@/lib/persistence/commerceIntake'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'operations.commerce_order_workbench.update_ship_to'
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const ADDRESS_BLOCKERS = new Set([
  'ship_to_confirmation_required',
  'ship_to_incomplete',
  'ship_to_redacted',
  'ship_to_unavailable',
])

type WorkbenchReadRow = {
  candidate_id: string
  candidate_global_id: string
  organization_id: string
  integration_account_id: string
  integration_account_global_id: string
  integration_account_name: string
  provider: 'shopify' | 'faire'
  external_order_id: string
  order_number_snapshot: string
  source_hash: string
  provider_updated_at: Date | null
  observed_at: Date
  candidate_row_version: string
  blocking_codes: string[]
  canonical_order_global_id: string | null
  customer_name: string | null
  line_count: string
  party_snapshot_state: 'missing' | 'redacted' | 'protected'
  party_snapshot_ciphertext: Buffer | null
  party_snapshot_iv: Buffer | null
  party_snapshot_tag: Buffer | null
  ship_to_snapshot_state:
    | 'missing'
    | 'redacted'
    | 'protected'
    | 'confirmed'
  ship_to_snapshot_ciphertext: Buffer | null
  ship_to_snapshot_iv: Buffer | null
  ship_to_snapshot_tag: Buffer | null
  workbench_id: string | null
  accepted_provider_source_hash: string | null
  ship_to_edit_state:
    | 'provider_snapshot'
    | 'local_missing'
    | 'local_incomplete'
    | 'local_carrier_ready'
    | null
  local_ship_to_ciphertext: Buffer | null
  local_ship_to_iv: Buffer | null
  local_ship_to_tag: Buffer | null
  local_ship_to_source_hash: string | null
  sync_state:
    | 'provider_snapshot'
    | 'local_only'
    | 'provider_sync_pending'
    | 'provider_synced'
    | 'provider_sync_failed'
    | null
  workbench_row_version: string | null
  latest_provider_source_hash: string
}

type LockedCandidateRow = {
  id: string
  global_id: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  external_order_id: string
  source_hash: string
  provider_updated_at: Date | null
  observed_at: Date
  canonical_order_id: string | null
  canonical_order_global_id: string | null
  workflow_state: 'held' | 'resolving' | 'ready' | 'promoted' | 'failed' | 'expired'
  blocking_codes: string[]
  row_version: string
  ship_to_snapshot_state:
    | 'missing'
    | 'redacted'
    | 'protected'
    | 'confirmed'
  ship_to_snapshot_ciphertext: Buffer | null
  ship_to_snapshot_iv: Buffer | null
  ship_to_snapshot_tag: Buffer | null
  live_for_new_draft: boolean
}

type LockedWorkbenchRow = {
  id: string
  candidate_id: string
  accepted_provider_source_hash: string
  accepted_provider_updated_at: Date | null
  ship_to_edit_state:
    | 'provider_snapshot'
    | 'local_missing'
    | 'local_incomplete'
    | 'local_carrier_ready'
  ship_to_ciphertext: Buffer | null
  ship_to_iv: Buffer | null
  ship_to_tag: Buffer | null
  ship_to_source_hash: string | null
  canonical_order_id: string | null
  last_command_receipt_id: string
  last_request_hash: string
  row_version: string
}

type CommandReceiptRow = {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

export class CommerceOrderWorkbenchError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CommerceOrderWorkbenchError'
    this.code = code
    this.status = status
  }
}

function requestError(code: string, message: string, status = 409): never {
  throw new CommerceOrderWorkbenchError(code, message, status)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!UUID.test(organizationId)) {
    requestError(
      'ACTIVE_ORGANIZATION_REQUIRED',
      'Select an active organization first',
      409,
    )
  }
  return organizationId
}

function requireCandidateGlobalId(value: string) {
  const candidateGlobalId = String(value || '').trim()
  if (!CANDIDATE_GLOBAL_ID.test(candidateGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_INVALID',
      'Imported order is invalid',
      400,
    )
  }
  return candidateGlobalId
}

function protectedDataUnreadable(): never {
  requestError(
    'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
    'Protected imported order data could not be read',
    500,
  )
}

function decryptProtectedSnapshot(input: {
  ciphertext: Buffer | null
  iv: Buffer | null
  tag: Buffer | null
  organizationId: string
  accountGlobalId: string
  externalOrderId: string
  sourceHash: string | null
  kind: 'party' | 'ship_to'
  required: boolean
}): Record<string, unknown> | null {
  const protectedParts = [input.ciphertext, input.iv, input.tag]
    .filter((value) => value !== null).length
  if (protectedParts === 0 && !input.required) return null
  if (protectedParts !== 3 || !input.sourceHash) protectedDataUnreadable()
  try {
    return decryptCommerceCandidateSnapshot(
      {
        ciphertext: input.ciphertext!,
        iv: input.iv!,
        tag: input.tag!,
      },
      input.organizationId,
      input.accountGlobalId,
      input.externalOrderId,
      input.sourceHash,
      input.kind,
    )
  } catch {
    protectedDataUnreadable()
  }
}

function decryptAddress(input: {
  ciphertext: Buffer | null
  iv: Buffer | null
  tag: Buffer | null
  organizationId: string
  accountGlobalId: string
  externalOrderId: string
  sourceHash: string | null
  required: boolean
}): OrderShipToDraft {
  const value = decryptProtectedSnapshot({
    ...input,
    kind: 'ship_to',
  })
  if (!value) return normalizeOrderShipToDraft(null)
  return normalizeOrderShipToDraft({
    name: value.name || value.organizationName,
    line1: value.line1,
    line2: value.line2,
    city: value.city,
    region: value.regionCode || value.region,
    postalCode: value.postalCode,
    country: value.countryCode || value.country,
  })
}

function customerSnapshotName(row: WorkbenchReadRow) {
  if (row.customer_name) return row.customer_name
  const value = decryptProtectedSnapshot({
    ciphertext: row.party_snapshot_ciphertext,
    iv: row.party_snapshot_iv,
    tag: row.party_snapshot_tag,
    organizationId: row.organization_id,
    accountGlobalId: row.integration_account_global_id,
    externalOrderId: row.external_order_id,
    sourceHash: row.source_hash,
    kind: 'party',
    required: row.party_snapshot_state === 'protected',
  })
  if (!value) return null
  return String(value.organizationName || value.contactName || '').trim()
    || null
}

function mappedWorkingCopy(
  row: WorkbenchReadRow,
): OperationsImportedOrderWorkingCopy {
  const local = Boolean(
    row.workbench_id
    && row.ship_to_edit_state
    && row.ship_to_edit_state !== 'provider_snapshot',
  )
  const shipTo = local
    ? decryptAddress({
        ciphertext: row.local_ship_to_ciphertext,
        iv: row.local_ship_to_iv,
        tag: row.local_ship_to_tag,
        organizationId: row.organization_id,
        accountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
        sourceHash: row.local_ship_to_source_hash,
        required: true,
      })
    : decryptAddress({
        ciphertext: row.ship_to_snapshot_ciphertext,
        iv: row.ship_to_snapshot_iv,
        tag: row.ship_to_snapshot_tag,
        organizationId: row.organization_id,
        accountGlobalId: row.integration_account_global_id,
        externalOrderId: row.external_order_id,
        sourceHash: row.source_hash,
        required: row.ship_to_snapshot_state === 'protected'
          || row.ship_to_snapshot_state === 'confirmed',
      })
  const issues = orderShipToIssues(shipTo)
  const otherMissingFacts = row.blocking_codes.some((code) => (
    !ADDRESS_BLOCKERS.has(code)
  ))
  return {
    kind: 'imported_working_copy',
    globalId: row.candidate_global_id,
    candidateGlobalId: row.candidate_global_id,
    canonicalOrderGlobalId: row.canonical_order_global_id,
    integrationAccountGlobalId: row.integration_account_global_id,
    integrationAccountName: row.integration_account_name,
    provider: row.provider,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number_snapshot,
    status: 'imported',
    needsInfo: issues.length > 0 || otherMissingFacts,
    customerName: customerSnapshotName(row),
    lineCount: Number(row.line_count),
    sourceUpdatedAt: (
      row.provider_updated_at || row.observed_at
    ).toISOString(),
    candidateRowVersion: Number(row.candidate_row_version),
    rowVersion: Number(row.workbench_row_version || 0),
    providerVersionChanged: Boolean(
      row.accepted_provider_source_hash
      && row.accepted_provider_source_hash
        !== row.latest_provider_source_hash,
    ),
    shipTo: {
      value: shipTo,
      readiness: orderShipToReadiness(shipTo),
      provenance: local ? 'local' : 'provider',
      syncStatus: row.sync_state || 'provider_snapshot',
      issues,
    },
    providerWrites: 0,
  }
}

export async function readCommerceOrderWorkbenchFromPostgres(input: {
  organizationId: string
  search?: string | null
  candidateGlobalId?: string | null
}): Promise<OperationsImportedOrderWorkingCopy[]> {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = input.candidateGlobalId
    ? requireCandidateGlobalId(input.candidateGlobalId)
    : null
  const search = String(input.search || '').trim()
  const searchPattern = search
    ? `%${search.replace(/[!%_]/gu, '!$&')}%`
    : null
  const result = await query<WorkbenchReadRow>(
    `WITH latest_live_candidates AS (
       SELECT DISTINCT ON (
         candidate.integration_account_id,
         candidate.external_order_id
       )
         candidate.*
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
         AND run.expires_at > now()
         AND run.workflow_state <> 'expired'
       ORDER BY
         candidate.integration_account_id,
         candidate.external_order_id,
         candidate.observed_at DESC,
         candidate.created_at DESC,
         candidate.id DESC
     ), selected_candidate_ids AS (
       SELECT live.id AS candidate_id
       FROM latest_live_candidates live
       WHERE NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_workbench retained
         WHERE retained.organization_id = live.organization_id
           AND retained.integration_account_id
             = live.integration_account_id
           AND retained.external_order_id = live.external_order_id
       )
       UNION ALL
       SELECT retained.candidate_id
       FROM operations_commerce_order_workbench retained
       JOIN operations_commerce_order_candidates retained_candidate
         ON retained_candidate.organization_id = retained.organization_id
        AND retained_candidate.integration_account_id
          = retained.integration_account_id
        AND retained_candidate.id = retained.candidate_id
       WHERE retained.organization_id = $1::uuid
         AND retained.canonical_order_id IS NULL
         AND retained_candidate.canonical_order_id IS NULL
     )
     SELECT
       candidate.id::text AS candidate_id,
       candidate.global_id AS candidate_global_id,
       candidate.organization_id::text,
       candidate.integration_account_id::text,
       account.global_id AS integration_account_global_id,
       account.display_name AS integration_account_name,
       candidate.provider,
       candidate.external_order_id,
       candidate.order_number_snapshot,
       candidate.source_hash,
       candidate.provider_updated_at,
       candidate.observed_at,
       candidate.row_version::text AS candidate_row_version,
       candidate.blocking_codes,
       canonical_order.global_id AS canonical_order_global_id,
       customer.name AS customer_name,
       line_count.line_count,
       candidate.party_snapshot_state,
       candidate.party_snapshot_ciphertext,
       candidate.party_snapshot_iv,
       candidate.party_snapshot_tag,
       candidate.ship_to_snapshot_state,
       candidate.ship_to_snapshot_ciphertext,
       candidate.ship_to_snapshot_iv,
       candidate.ship_to_snapshot_tag,
       workbench.id::text AS workbench_id,
       workbench.accepted_provider_source_hash,
       workbench.ship_to_edit_state,
       workbench.ship_to_ciphertext AS local_ship_to_ciphertext,
       workbench.ship_to_iv AS local_ship_to_iv,
       workbench.ship_to_tag AS local_ship_to_tag,
       workbench.ship_to_source_hash AS local_ship_to_source_hash,
       workbench.sync_state,
       workbench.row_version::text AS workbench_row_version,
       COALESCE(
         latest_provider.source_hash,
         candidate.source_hash
       ) AS latest_provider_source_hash
     FROM selected_candidate_ids selected
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = $1::uuid
      AND candidate.id = selected.candidate_id
     JOIN operations_integration_accounts account
       ON account.organization_id = candidate.organization_id
      AND account.id = candidate.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider IN ('shopify', 'faire')
     LEFT JOIN operations_commerce_order_workbench workbench
       ON workbench.organization_id = candidate.organization_id
      AND workbench.integration_account_id = candidate.integration_account_id
      AND workbench.external_order_id = candidate.external_order_id
     LEFT JOIN operations_orders canonical_order
       ON canonical_order.organization_id = candidate.organization_id
      AND canonical_order.id = candidate.canonical_order_id
     LEFT JOIN crm_organizations customer
       ON customer.pipeline_id = candidate.pipeline_id
      AND customer.id = candidate.customer_id
     CROSS JOIN LATERAL (
       SELECT count(*)::text AS line_count
       FROM operations_commerce_order_candidate_lines line
       WHERE line.organization_id = candidate.organization_id
         AND line.integration_account_id = candidate.integration_account_id
         AND line.order_candidate_id = candidate.id
     ) line_count
     LEFT JOIN LATERAL (
       SELECT provider_candidate.source_hash
       FROM operations_commerce_order_candidates provider_candidate
       WHERE provider_candidate.organization_id = candidate.organization_id
         AND provider_candidate.integration_account_id
           = candidate.integration_account_id
         AND provider_candidate.external_order_id
           = candidate.external_order_id
         AND provider_candidate.workflow_state <> 'failed'
       ORDER BY
         provider_candidate.observed_at DESC,
         provider_candidate.created_at DESC,
         provider_candidate.id DESC
       LIMIT 1
     ) latest_provider ON true
     WHERE ($2::text IS NULL OR candidate.global_id = $2)
       AND (
         $3::text IS NULL
         OR candidate.global_id ILIKE $3 ESCAPE '!'
         OR candidate.order_number_snapshot ILIKE $3 ESCAPE '!'
         OR candidate.external_order_id ILIKE $3 ESCAPE '!'
         OR account.display_name ILIKE $3 ESCAPE '!'
         OR candidate.provider ILIKE $3 ESCAPE '!'
         OR COALESCE(customer.name, '') ILIKE $3 ESCAPE '!'
         OR COALESCE(canonical_order.global_id, '') ILIKE $3 ESCAPE '!'
       )
     ORDER BY
       candidate.provider_updated_at DESC NULLS LAST,
       candidate.observed_at DESC,
       candidate.id DESC
     LIMIT 200`,
    [organizationId, candidateGlobalId, searchPattern],
  )
  return result.rows
    .map(mappedWorkingCopy)
    .slice(0, 100)
}

async function prepareReceipt(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string
    candidateGlobalId: string
    idempotencyKey: string
    requestHash: string
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `commerce-order-workbench-receipt:${input.organizationId}:${input.idempotencyKey}`,
  )
  const existing = await client.query<CommandReceiptRow>(
    `SELECT id::text, request_hash, target_global_id, status,
            correlation_id::text, result_payload, updated_at
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = $2
       AND idempotency_key = $3
     FOR UPDATE`,
    [input.organizationId, COMMAND_TYPE, input.idempotencyKey],
  )
  const receipt = existing.rows[0]
  if (receipt) {
    if (
      receipt.request_hash !== input.requestHash
      || (
        receipt.target_global_id
        && receipt.target_global_id !== input.candidateGlobalId
      )
    ) {
      requestError(
        'OPERATIONS_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different order edit',
      )
    }
    if (receipt.status === 'succeeded') {
      return { receipt, replayed: true }
    }
    // The local edit and the candidate handoff intentionally cross transaction
    // boundaries. The receipt advisory lock serializes the checkpoint update;
    // exact retries may then resume immediately instead of waiting for a stale
    // processing timeout. Every downstream candidate command has its own
    // deterministic idempotency key, so a concurrent exact retry cannot create
    // a second confirmation, validation, or canonical order.
    const retried = await client.query<CommandReceiptRow>(
      `UPDATE operations_command_receipts
       SET status = 'processing',
           actor_email = $2,
           target_global_id = $3,
           attempts = attempts + 1,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           started_at = now(),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_payload, updated_at`,
      [receipt.id, input.actorEmail, input.candidateGlobalId],
    )
    return { receipt: retried.rows[0], replayed: false }
  }
  const created = await client.query<CommandReceiptRow>(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, target_global_id
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7
     )
     RETURNING id::text, request_hash, target_global_id, status,
               correlation_id::text, result_payload, updated_at`,
    [
      input.organizationId,
      COMMAND_TYPE,
      input.idempotencyKey,
      input.requestHash,
      input.actorEmail,
      randomUUID(),
      input.candidateGlobalId,
    ],
  )
  return { receipt: created.rows[0], replayed: false }
}

function replayedResult(
  receipt: CommandReceiptRow,
): OperationsImportedOrderShipToUpdateResult {
  const payload = receipt.result_payload
  if (
    !payload
    || typeof payload.candidateGlobalId !== 'string'
    || !Number.isSafeInteger(payload.rowVersion)
    || !Array.isArray(payload.issues)
    || !Array.isArray(payload.changedFields)
    || (
      payload.canonicalOrderGlobalId !== null
      && typeof payload.canonicalOrderGlobalId !== 'string'
    )
    || !['not_ready', 'needs_info', 'promoted'].includes(
      String(payload.promotionStatus || ''),
    )
    || !Array.isArray(payload.remainingBlockerCodes)
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_RESULT_INVALID',
      'The saved order edit could not be reloaded',
      500,
    )
  }
  return {
    ...(payload as Omit<
      OperationsImportedOrderShipToUpdateResult,
      'replayed'
    >),
    replayed: true,
  }
}

type SavedDraft = {
  receipt: CommandReceiptRow
  result: OperationsImportedOrderShipToUpdateResult
  address: OrderShipToDraft
  candidate: LockedCandidateRow
}

type CandidateCommandResult = {
  rowVersion?: number
  ready?: boolean
  blockers?: unknown[]
  canonicalOrderGlobalId?: string
}

function checkpointResult(
  receipt: CommandReceiptRow,
): OperationsImportedOrderShipToUpdateResult {
  return { ...replayedResult(receipt), replayed: false }
}

function carrierAddress(address: OrderShipToDraft) {
  if (orderShipToReadiness(address) !== 'carrier_ready') {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_ADDRESS_INCOMPLETE',
      'Complete the ship-to address before handing off the imported order',
      422,
    )
  }
  return {
    name: address.name!,
    line1: address.line1!,
    line2: address.line2,
    city: address.city!,
    region: address.region!,
    postalCode: address.postalCode!,
    country: address.country!,
  }
}

function blockerCodes(values: unknown[] | undefined) {
  return [...new Set((values || []).map((value) => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    return String((value as Record<string, unknown>).code || '').trim()
  }).filter(Boolean))].sort()
}

async function completeWorkbenchReceipt(input: {
  organizationId: string
  actorEmail: string
  receiptId: string
  result: OperationsImportedOrderShipToUpdateResult
  canonicalOrderGlobalId?: string | null
}) {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench-receipt:${input.organizationId}:${input.receiptId}`,
    )
    const receiptResult = await client.query<CommandReceiptRow>(
      `SELECT id::text, request_hash, target_global_id, status,
              correlation_id::text, result_payload, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = $3
       FOR UPDATE`,
      [input.organizationId, input.receiptId, COMMAND_TYPE],
    )
    const receipt = receiptResult.rows[0]
    if (!receipt) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_RECEIPT_MISSING',
        'The saved order edit receipt is unavailable',
        500,
      )
    }
    if (receipt.status === 'succeeded') return replayedResult(receipt)

    let result = input.result
    const canonicalOrderGlobalId = input.canonicalOrderGlobalId || null
    if (canonicalOrderGlobalId) {
      const linked = await client.query<{
        row_version: string
        canonical_order_id: string
        canonical_order_global_id: string
      }>(
        `WITH canonical AS (
           SELECT candidate.canonical_order_id,
                  canonical_order.global_id AS canonical_order_global_id
           FROM operations_commerce_order_candidates candidate
           JOIN operations_orders canonical_order
             ON canonical_order.organization_id = candidate.organization_id
            AND canonical_order.id = candidate.canonical_order_id
           WHERE candidate.organization_id = $1::uuid
             AND candidate.global_id = $2
             AND canonical_order.global_id = $3
         ), updated AS (
           UPDATE operations_commerce_order_workbench workbench
           SET canonical_order_id = canonical.canonical_order_id,
               row_version = CASE
                 WHEN workbench.canonical_order_id IS DISTINCT FROM
                      canonical.canonical_order_id
                   THEN workbench.row_version + 1
                 ELSE workbench.row_version
               END,
               updated_by = $4,
               updated_at = now()
           FROM canonical
           WHERE workbench.organization_id = $1::uuid
             AND workbench.candidate_id = (
               SELECT id FROM operations_commerce_order_candidates
               WHERE organization_id = $1::uuid AND global_id = $2
             )
             AND (
               workbench.canonical_order_id IS NULL
               OR workbench.canonical_order_id = canonical.canonical_order_id
             )
           RETURNING workbench.row_version::text,
                     workbench.canonical_order_id::text
         )
         SELECT updated.row_version, updated.canonical_order_id,
                canonical.canonical_order_global_id
         FROM updated CROSS JOIN canonical`,
        [
          input.organizationId,
          result.candidateGlobalId,
          canonicalOrderGlobalId,
          input.actorEmail,
        ],
      )
      if (!linked.rows[0]) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_CANONICAL_LINK_INVALID',
          'The promoted order could not be linked to its working copy',
          500,
        )
      }
      result = {
        ...result,
        canonicalOrderGlobalId: linked.rows[0].canonical_order_global_id,
        rowVersion: Number(linked.rows[0].row_version),
        promotionStatus: 'promoted',
        remainingBlockerCodes: [],
      }
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'operations.commerce_order_workbench.canonical_linked',
        aggregateType: 'operations.order',
        aggregateId: linked.rows[0].canonical_order_global_id,
        subject: linked.rows[0].canonical_order_global_id,
        organizationId: input.organizationId,
        eventKey: `operations:commerce-order-workbench:${input.receiptId}:canonical`,
        payload: {
          candidateGlobalId: result.candidateGlobalId,
          canonicalOrderGlobalId: linked.rows[0].canonical_order_global_id,
          commandReceiptId: input.receiptId,
          providerWrites: 0,
          providerWriteIntentCreated: false,
        },
      }, client)
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded',
           result_global_id = $2,
           result_payload = $3::jsonb,
           error_code = NULL,
           error_message = NULL,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        receipt.id,
        result.canonicalOrderGlobalId || result.candidateGlobalId,
        JSON.stringify(result),
      ],
    )
    return result
  })
}

async function handoffCarrierReadyDraft(input: {
  organizationId: string
  actorEmail: string
  exactRequestHash: string
  saved: SavedDraft
}) {
  const { saved } = input
  if (saved.candidate.canonical_order_global_id) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: saved.result,
      canonicalOrderGlobalId: saved.candidate.canonical_order_global_id,
    })
  }
  if (saved.result.providerVersionChanged) {
    // A refresh/rebase is an explicit future command: never replace the local
    // draft with the newer provider snapshot as a side effect of Save.
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: ['provider_refresh_rebase_required'],
      },
    })
  }
  if (
    !saved.candidate.live_for_new_draft
    || ['failed', 'expired'].includes(saved.candidate.workflow_state)
  ) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: ['candidate_refresh_required'],
      },
    })
  }
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: input.organizationId,
    accountGlobalId: saved.candidate.account_global_id,
  })
  if (!runtime || runtime.verificationStatus !== 'verified') {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_CONNECTION_REVALIDATION_REQUIRED',
      'Revalidate the commerce connection before importing this completed order',
      409,
    )
  }
  const addressResult = await confirmCommerceCandidateAddressInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:confirm-address`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: Number(saved.candidate.row_version),
    address: carrierAddress(saved.address),
  }) as CandidateCommandResult
  const confirmedRowVersion = Number(addressResult.rowVersion)
  if (!Number.isSafeInteger(confirmedRowVersion)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_HANDOFF_INVALID',
      'The address confirmation result was invalid',
      500,
    )
  }
  const validationResult = await validateCommerceCandidateInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:validate`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: confirmedRowVersion,
  }) as CandidateCommandResult
  const validatedRowVersion = Number(validationResult.rowVersion)
  if (!Number.isSafeInteger(validatedRowVersion)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_HANDOFF_INVALID',
      'The imported-order validation result was invalid',
      500,
    )
  }
  if (validationResult.ready !== true) {
    return completeWorkbenchReceipt({
      organizationId: input.organizationId,
      actorEmail: input.actorEmail,
      receiptId: saved.receipt.id,
      result: {
        ...saved.result,
        promotionStatus: 'needs_info',
        remainingBlockerCodes: blockerCodes(validationResult.blockers),
      },
    })
  }
  const promotion = await promoteCommerceCandidateInPostgres({
    runtime,
    actorEmail: input.actorEmail,
    idempotencyKey: `workbench:${saved.receipt.id}:promote`,
    candidateGlobalId: saved.result.candidateGlobalId,
    candidateRowVersion: validatedRowVersion,
    requestHash: requestHash({
      candidateGlobalId: saved.result.candidateGlobalId,
      workbenchRequestHash: input.exactRequestHash,
      commandReceiptId: saved.receipt.id,
      providerWrites: 0,
    }),
  }) as CandidateCommandResult
  if (!promotion.canonicalOrderGlobalId) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_PROMOTION_INVALID',
      'The canonical order result was invalid',
      500,
    )
  }
  return completeWorkbenchReceipt({
    organizationId: input.organizationId,
    actorEmail: input.actorEmail,
    receiptId: saved.receipt.id,
    result: saved.result,
    canonicalOrderGlobalId: promotion.canonicalOrderGlobalId,
  })
}

export async function updateCommerceOrderWorkbenchShipToInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidateGlobalId: string
  expectedRowVersion: number
  changes: OrderShipToPatch
  /** Test-only crash seam after the durable local checkpoint commits. */
  afterLocalSaveBeforeHandoff?: () => void | Promise<void>
}): Promise<OperationsImportedOrderShipToUpdateResult> {
  const organizationId = requireOrganizationId(input.organizationId)
  const candidateGlobalId = requireCandidateGlobalId(input.candidateGlobalId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    requestError('OPERATIONS_ACTOR_REQUIRED', 'A signed-in user is required', 401)
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
  ) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_VERSION_INVALID',
      'Imported order version is invalid',
      400,
    )
  }
  if (!Object.keys(input.changes).length) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_EDIT_EMPTY',
      'Choose at least one ship-to field to update',
      400,
    )
  }
  const exactRequestHash = requestHash({
    candidateGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    changes: input.changes,
  })
  const saved = await withTransaction<
    SavedDraft | OperationsImportedOrderShipToUpdateResult
  >(async (client) => {
    const prepared = await prepareReceipt(client, {
      organizationId,
      actorEmail,
      candidateGlobalId,
      idempotencyKey: input.idempotencyKey,
      requestHash: exactRequestHash,
    })
    if (prepared.replayed) return replayedResult(prepared.receipt)

    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench-candidate:${organizationId}:${candidateGlobalId}`,
    )
    const candidateResult = await client.query<LockedCandidateRow>(
      `SELECT
         candidate.id::text,
         candidate.global_id,
         candidate.organization_id::text,
         candidate.integration_account_id::text,
         account.global_id AS account_global_id,
         candidate.external_order_id,
         candidate.source_hash,
         candidate.provider_updated_at,
         candidate.observed_at,
         candidate.canonical_order_id::text,
         canonical_order.global_id AS canonical_order_global_id,
         candidate.workflow_state,
         candidate.blocking_codes,
         candidate.row_version::text,
         candidate.ship_to_snapshot_state,
         candidate.ship_to_snapshot_ciphertext,
         candidate.ship_to_snapshot_iv,
         candidate.ship_to_snapshot_tag,
         (
           candidate.canonical_order_id IS NULL
           AND candidate.workflow_state IN ('held', 'resolving', 'ready')
           AND candidate.expires_at > now()
           AND run.expires_at > now()
           AND run.workflow_state <> 'expired'
         ) AS live_for_new_draft
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider IN ('shopify', 'faire')
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.global_id = $2
       FOR UPDATE OF candidate`,
      [organizationId, candidateGlobalId],
    )
    const candidate = candidateResult.rows[0]
    if (!candidate) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
        'Imported order is no longer available',
        404,
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-workbench:${organizationId}:${candidate.integration_account_id}:${candidate.external_order_id}`,
    )
    const workbenchResult = await client.query<LockedWorkbenchRow>(
      `SELECT id::text, candidate_id::text,
              accepted_provider_source_hash,
              accepted_provider_updated_at, ship_to_edit_state,
              ship_to_ciphertext, ship_to_iv, ship_to_tag,
              ship_to_source_hash, canonical_order_id::text,
              last_command_receipt_id::text, last_request_hash,
              row_version::text
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
       FOR UPDATE`,
      [organizationId, candidate.integration_account_id, candidate.external_order_id],
    )
    const current = workbenchResult.rows[0] || null
    if (current && current.candidate_id !== candidate.id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_CHANGED',
        'This order changed. Reload it before saving your edit',
      )
    }
    const resumingCheckpoint = Boolean(
      current
      && current.last_command_receipt_id === prepared.receipt.id
      && current.last_request_hash === exactRequestHash,
    )
    if (resumingCheckpoint) {
      const address = decryptAddress({
        ciphertext: current!.ship_to_ciphertext,
        iv: current!.ship_to_iv,
        tag: current!.ship_to_tag,
        organizationId,
        accountGlobalId: candidate.account_global_id,
        externalOrderId: candidate.external_order_id,
        sourceHash: current!.ship_to_source_hash,
        required: true,
      })
      return {
        receipt: prepared.receipt,
        result: checkpointResult(prepared.receipt),
        address,
        candidate,
      }
    }
    if (candidate.canonical_order_id) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL',
        'This imported order is already available in Orders',
        409,
      )
    }
    if (!current) {
      if (!candidate.live_for_new_draft) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
          'Imported order is no longer available',
          404,
        )
      }
      const latestLive = await client.query<{ global_id: string }>(
        `SELECT selected.global_id
         FROM operations_commerce_order_candidates selected
         JOIN operations_commerce_intake_runs selected_run
           ON selected_run.organization_id = selected.organization_id
          AND selected_run.integration_account_id
            = selected.integration_account_id
          AND selected_run.pipeline_id = selected.pipeline_id
          AND selected_run.id = selected.run_id
         WHERE selected.organization_id = $1::uuid
           AND selected.integration_account_id = $2::uuid
           AND selected.external_order_id = $3
           AND selected.canonical_order_id IS NULL
           AND selected.workflow_state IN ('held', 'resolving', 'ready')
           AND selected.expires_at > now()
           AND selected_run.expires_at > now()
           AND selected_run.workflow_state <> 'expired'
         ORDER BY selected.observed_at DESC, selected.created_at DESC,
                  selected.id DESC
         LIMIT 1`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.external_order_id,
        ],
      )
      if (latestLive.rows[0]?.global_id !== candidateGlobalId) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_CHANGED',
          'This order changed. Reload it before saving your edit',
        )
      }
    }
    const latestProvider = await client.query<{ source_hash: string }>(
      `SELECT selected.source_hash
       FROM operations_commerce_order_candidates selected
       WHERE selected.organization_id = $1::uuid
         AND selected.integration_account_id = $2::uuid
         AND selected.external_order_id = $3
         AND selected.workflow_state <> 'failed'
       ORDER BY selected.observed_at DESC, selected.created_at DESC,
                selected.id DESC
       LIMIT 1`,
      [
        organizationId,
        candidate.integration_account_id,
        candidate.external_order_id,
      ],
    )
    const latestProviderSourceHash = latestProvider.rows[0]?.source_hash
      || candidate.source_hash
    const currentRowVersion = Number(current?.row_version || 0)
    if (currentRowVersion !== input.expectedRowVersion) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
        'This order changed. Reload it before saving your edit',
      )
    }
    const before = current && current.ship_to_edit_state !== 'provider_snapshot'
      ? decryptAddress({
          ciphertext: current.ship_to_ciphertext,
          iv: current.ship_to_iv,
          tag: current.ship_to_tag,
          organizationId,
          accountGlobalId: candidate.account_global_id,
          externalOrderId: candidate.external_order_id,
          sourceHash: current.ship_to_source_hash,
          required: true,
        })
      : decryptAddress({
          ciphertext: candidate.ship_to_snapshot_ciphertext,
          iv: candidate.ship_to_snapshot_iv,
          tag: candidate.ship_to_snapshot_tag,
          organizationId,
          accountGlobalId: candidate.account_global_id,
          externalOrderId: candidate.external_order_id,
          sourceHash: candidate.source_hash,
          required: candidate.ship_to_snapshot_state === 'protected'
            || candidate.ship_to_snapshot_state === 'confirmed',
        })
    const after = mergeOrderShipToDraft(before, input.changes)
    const readiness = orderShipToReadiness(after)
    const issues = orderShipToIssues(after)
    const changedFields = changedOrderShipToFields(before, after)
    const encrypted = encryptCommerceCandidateSnapshot(
      orderShipToStorageValue(after),
      organizationId,
      candidate.account_global_id,
      candidate.external_order_id,
      candidate.source_hash,
      'ship_to',
    )
    const shipToEditState = `local_${readiness}` as const
    const acceptedProviderSourceHash = current
      ?.accepted_provider_source_hash || candidate.source_hash
    const acceptedProviderUpdatedAt = current
      ? current.accepted_provider_updated_at
      : candidate.provider_updated_at || candidate.observed_at
    let rowVersion: number
    if (current) {
      const updated = await client.query<{ row_version: string }>(
        `UPDATE operations_commerce_order_workbench
         SET ship_to_edit_state = $4,
             ship_to_ciphertext = $5,
             ship_to_iv = $6,
             ship_to_tag = $7,
             ship_to_hash = $8,
             ship_to_source_hash = $9,
             ship_to_encryption_version = $10,
             sync_state = 'local_only',
             last_command_receipt_id = $11::uuid,
             last_idempotency_key = $12,
             last_request_hash = $13,
             row_version = row_version + 1,
             updated_by = $14,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = $3
           AND canonical_order_id IS NULL
           AND row_version = $15::bigint
         RETURNING row_version::text`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.external_order_id,
          shipToEditState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          candidate.source_hash,
          encrypted.encryptionVersion,
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
          input.expectedRowVersion,
        ],
      )
      if (!updated.rows[0]) {
        requestError(
          'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
          'This order changed. Reload it before saving your edit',
        )
      }
      rowVersion = Number(updated.rows[0].row_version)
    } else {
      const created = await client.query<{ row_version: string }>(
        `INSERT INTO operations_commerce_order_workbench (
           organization_id, integration_account_id, candidate_id,
           external_order_id, canonical_order_id,
           accepted_provider_source_hash, accepted_provider_updated_at,
           ship_to_edit_state, ship_to_ciphertext, ship_to_iv, ship_to_tag,
           ship_to_hash, ship_to_source_hash, ship_to_encryption_version,
           sync_state, last_command_receipt_id, last_idempotency_key,
           last_request_hash, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, NULL, $5, $6,
           $7, $8, $9, $10, $11, $12, $13,
           'local_only', $14::uuid, $15, $16, $17, $17
         )
         RETURNING row_version::text`,
        [
          organizationId,
          candidate.integration_account_id,
          candidate.id,
          candidate.external_order_id,
          acceptedProviderSourceHash,
          acceptedProviderUpdatedAt,
          shipToEditState,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          encrypted.hash,
          candidate.source_hash,
          encrypted.encryptionVersion,
          prepared.receipt.id,
          input.idempotencyKey,
          exactRequestHash,
          actorEmail,
        ],
      )
      rowVersion = Number(created.rows[0].row_version)
    }
    const providerVersionChanged =
      acceptedProviderSourceHash !== latestProviderSourceHash
    const result: OperationsImportedOrderShipToUpdateResult = {
      candidateGlobalId,
      canonicalOrderGlobalId: null,
      rowVersion,
      readiness,
      issues,
      changedFields,
      syncStatus: 'local_only',
      promotionStatus: readiness === 'carrier_ready'
        ? 'needs_info'
        : 'not_ready',
      remainingBlockerCodes: readiness === 'carrier_ready'
        ? candidate.blocking_codes.filter((code) => !ADDRESS_BLOCKERS.has(code))
        : [],
      providerVersionChanged,
      providerWrites: 0,
      providerWriteIntentCreated: false,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET result_payload = $2::jsonb,
           result_global_id = $3,
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'`,
      [prepared.receipt.id, JSON.stringify(result), candidateGlobalId],
    )
    prepared.receipt.result_payload = result as unknown as Record<string, unknown>
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.commerce_order_workbench.ship_to_updated',
      aggregateType: 'operations.commerce_order_workbench',
      aggregateId: candidateGlobalId,
      subject: candidateGlobalId,
      organizationId,
      eventKey: `operations:commerce-order-workbench:${prepared.receipt.id}`,
      payload: {
        candidateGlobalId,
        rowVersion,
        readiness,
        issueFields: issues.map((issue) => issue.field),
        changedFields,
        syncStatus: 'local_only',
        providerVersionChanged,
        providerWrites: 0,
        providerWriteIntentCreated: false,
        commandReceiptId: prepared.receipt.id,
        correlationId: prepared.receipt.correlation_id,
      },
    }, client)
    return { receipt: prepared.receipt, result, address: after, candidate }
  })
  if (!('receipt' in saved)) return saved
  if (saved.result.readiness !== 'carrier_ready') {
    return completeWorkbenchReceipt({
      organizationId,
      actorEmail,
      receiptId: saved.receipt.id,
      result: saved.result,
    })
  }
  await input.afterLocalSaveBeforeHandoff?.()
  return handoffCarrierReadyDraft({
    organizationId,
    actorEmail,
    exactRequestHash,
    saved,
  })
}
