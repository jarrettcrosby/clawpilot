import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  QuickBooksWriteDraftPayload,
  QuickBooksWriteOperationKind,
} from '@/lib/integrations/quickBooksWritePayloads'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { configuredQuickBooksWritePolicy } from '@/lib/quickBooksWritePolicy'

export type QuickBooksWriteRequestStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'cancelled'

export type QuickBooksWriteRequest = {
  id: string
  operationKind: QuickBooksWriteOperationKind
  status: QuickBooksWriteRequestStatus
  clientRequestId: string
  providerRequestId: string
  requestPayload: QuickBooksWriteDraftPayload
  requestFingerprint: string
  providerEntityType: string | null
  providerEntityId: string | null
  providerSyncToken: string | null
  requestedBy: string
  requestedByName: string | null
  submittedBy: string | null
  approvedBy: string | null
  approvedByName: string | null
  cancelledBy: string | null
  approvalNote: string | null
  attemptCount: number
  maxAttempts: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  createdAt: string
  submittedAt: string | null
  approvedAt: string | null
  postedAt: string | null
  cancelledAt: string | null
  updatedAt: string
}

export type QuickBooksWriteJob = {
  id: string
  organizationId: string
  ownerEmail: string
  connectionId: string
  operationKind: QuickBooksWriteOperationKind
  requestPayload: QuickBooksWriteDraftPayload
  providerRequestId: string
  requestFingerprint: string
  attemptCount: number
  maxAttempts: number
  lockToken: string
  writeMode: 'sandbox' | 'production'
}

export class QuickBooksWriteRequestError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'QuickBooksWriteRequestError'
    this.code = code
    this.status = status
  }
}

type WriteRequestRow = {
  id: string
  reviewed_maton_connection_id: string | null
  operation_kind: QuickBooksWriteOperationKind
  status: QuickBooksWriteRequestStatus
  client_request_id: string
  provider_request_id: string
  request_payload: QuickBooksWriteDraftPayload
  request_fingerprint: string
  provider_entity_type: string | null
  provider_entity_id: string | null
  provider_sync_token: string | null
  requested_by: string
  requested_by_name: string | null
  submitted_by: string | null
  approved_by: string | null
  approved_by_name: string | null
  cancelled_by: string | null
  approval_note: string | null
  attempt_count: number
  max_attempts: number
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  submitted_at: string | null
  approved_at: string | null
  posted_at: string | null
  cancelled_at: string | null
  updated_at: string
}

function toWriteRequest(row: WriteRequestRow): QuickBooksWriteRequest {
  return {
    id: row.id,
    operationKind: row.operation_kind,
    status: row.status,
    clientRequestId: row.client_request_id,
    providerRequestId: row.provider_request_id,
    requestPayload: row.request_payload,
    requestFingerprint: row.request_fingerprint,
    providerEntityType: row.provider_entity_type,
    providerEntityId: row.provider_entity_id,
    providerSyncToken: row.provider_sync_token,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    cancelledBy: row.cancelled_by,
    approvalNote: row.approval_note,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
    cancelledAt: row.cancelled_at,
    updatedAt: row.updated_at,
  }
}

const WRITE_REQUEST_SELECT = `
  request.id::text, request.reviewed_maton_connection_id, request.operation_kind, request.status,
  request.client_request_id::text, request.provider_request_id,
  request.request_payload, request.request_fingerprint,
  request.provider_entity_type, request.provider_entity_id, request.provider_sync_token,
  request.requested_by, requested.display_name AS requested_by_name,
  request.submitted_by, request.approved_by, approved.display_name AS approved_by_name,
  request.cancelled_by, request.approval_note,
  request.attempt_count, request.max_attempts,
  request.last_error_code, request.last_error_message,
  request.created_at::text, request.submitted_at::text, request.approved_at::text,
  request.posted_at::text, request.cancelled_at::text, request.updated_at::text`

function requestSummary(operationKind: QuickBooksWriteOperationKind, payload: QuickBooksWriteDraftPayload) {
  const record = payload as unknown as Record<string, unknown>
  if (operationKind === 'invoice.create') {
    return { customerName: record.customerName, totalAmount: record.totalAmount }
  }
  return { name: record.displayName || record.name }
}

export async function readQuickBooksWriteWorkspaceInPostgres(input: {
  organizationId: string
  page?: number
  pageSize?: number
  requestId?: string | null
}) {
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 50), 100))
  const page = Math.max(1, Number(input.page || 1))
  const offset = (page - 1) * pageSize
  const [connection, count, requests, targetRequest, customers, items, accounts] = await Promise.all([
    query<{
      write_mode: 'disabled' | 'sandbox' | 'production'
      write_verified_at: string | null
      company_name: string
      currency_code: string | null
    }>(
      `SELECT write_mode, write_verified_at::text, company_name,
         (SELECT transaction.currency_code
          FROM quickbooks_transactions transaction
          WHERE transaction.organization_id = connection.organization_id
            AND transaction.currency_code IS NOT NULL
          GROUP BY transaction.currency_code
          ORDER BY count(*) DESC, transaction.currency_code
          LIMIT 1) AS currency_code
       FROM organization_quickbooks_connections connection
       WHERE organization_id = $1::uuid LIMIT 1`,
      [input.organizationId],
    ),
    query<{ count: string }>(
      'SELECT count(*)::text AS count FROM quickbooks_write_requests WHERE organization_id = $1::uuid',
      [input.organizationId],
    ),
    query<WriteRequestRow>(
      `SELECT ${WRITE_REQUEST_SELECT}
       FROM quickbooks_write_requests request
       LEFT JOIN app_users requested ON requested.email = request.requested_by
       LEFT JOIN app_users approved ON approved.email = request.approved_by
       WHERE request.organization_id = $1::uuid
       ORDER BY request.created_at DESC, request.id DESC
       LIMIT $2 OFFSET $3`,
      [input.organizationId, pageSize, offset],
    ),
    query<WriteRequestRow>(
      `SELECT ${WRITE_REQUEST_SELECT}
       FROM quickbooks_write_requests request
       LEFT JOIN app_users requested ON requested.email = request.requested_by
       LEFT JOIN app_users approved ON approved.email = request.approved_by
       WHERE request.organization_id = $1::uuid
         AND request.id = NULLIF($2, '')::uuid
       LIMIT 1`,
      [input.organizationId, input.requestId || ''],
    ),
    query<{ id: string; display_name: string; company_name: string | null; email: string | null }>(
      `SELECT quickbooks_customer_id AS id, display_name, company_name, email
       FROM quickbooks_customers
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY display_name, quickbooks_customer_id LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ id: string; name: string; item_type: string; unit_price: string; description: string | null }>(
      `SELECT quickbooks_item_id AS id, name, item_type, unit_price::text, description
       FROM quickbooks_items
       WHERE organization_id = $1::uuid AND active = true AND lower(item_type) <> 'category'
       ORDER BY name, quickbooks_item_id LIMIT 5000`,
      [input.organizationId],
    ),
    query<{ id: string; name: string; classification: string | null; account_type: string | null }>(
      `SELECT quickbooks_account_id AS id, fully_qualified_name AS name, classification, account_type
       FROM quickbooks_accounts
       WHERE organization_id = $1::uuid AND active = true
       ORDER BY fully_qualified_name, quickbooks_account_id LIMIT 5000`,
      [input.organizationId],
    ),
  ])
  const connectionRow = connection.rows[0]
  if (!connectionRow) throw new QuickBooksWriteRequestError('QUICKBOOKS_NOT_CONNECTED', 'Connect QuickBooks before preparing accounting changes', 409)
  const policy = configuredQuickBooksWritePolicy()
  const postingOperations = connectionRow?.write_verified_at
    && policy.enabled
    && policy.mode === connectionRow.write_mode
    ? policy.allowedOperations
    : []
  const requestRows = [...requests.rows]
  const targetedRow = targetRequest.rows[0]
  if (targetedRow && !requestRows.some((row) => row.id === targetedRow.id)) requestRows.unshift(targetedRow)
  return {
    connection: {
      companyName: connectionRow.company_name,
      writeMode: connectionRow.write_mode,
      writeVerifiedAt: connectionRow.write_verified_at,
      postingEnabled: postingOperations.length > 0,
      postingOperations,
      currencyCode: connectionRow.currency_code,
    },
    page,
    pageSize,
    total: Number(count.rows[0]?.count || 0),
    requests: requestRows.map(toWriteRequest),
    referenceData: {
      customers: customers.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        companyName: row.company_name,
        email: row.email,
      })),
      items: items.rows.map((row) => ({
        id: row.id,
        name: row.name,
        itemType: row.item_type,
        unitPrice: Number(row.unit_price || 0),
        description: row.description,
      })),
      accounts: accounts.rows.map((row) => ({
        id: row.id,
        name: row.name,
        classification: row.classification,
        accountType: row.account_type,
      })),
    },
  }
}

async function readWriteRequest(client: Parameters<Parameters<typeof withTransaction>[0]>[0], organizationId: string, requestId: string) {
  const result = await client.query<WriteRequestRow>(
    `SELECT ${WRITE_REQUEST_SELECT}
     FROM quickbooks_write_requests request
     LEFT JOIN app_users requested ON requested.email = request.requested_by
     LEFT JOIN app_users approved ON approved.email = request.approved_by
     WHERE request.organization_id = $1::uuid AND request.id = $2::uuid
     FOR UPDATE OF request`,
    [organizationId, requestId],
  )
  if (!result.rows[0]) throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_NOT_FOUND', 'Accounting draft was not found', 404)
  return result.rows[0]
}

export async function createQuickBooksWriteRequestInPostgres(input: {
  organizationId: string
  operationKind: QuickBooksWriteOperationKind
  clientRequestId: string
  payload: QuickBooksWriteDraftPayload
  requestFingerprint: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    const connection = await client.query<{ maton_connection_id: string }>(
      `SELECT maton_connection_id
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND status = 'active'
       FOR SHARE`,
      [input.organizationId],
    )
    const reviewedConnectionId = connection.rows[0]?.maton_connection_id
    if (!reviewedConnectionId) {
      throw new QuickBooksWriteRequestError('QUICKBOOKS_NOT_CONNECTED', 'Connect QuickBooks before preparing accounting changes', 409)
    }
    const inserted = await client.query<WriteRequestRow>(
      `INSERT INTO quickbooks_write_requests (
         organization_id, reviewed_maton_connection_id, operation_kind, client_request_id, provider_request_id,
         request_payload, request_fingerprint, requested_by, created_at, updated_at
       )
       VALUES ($1::uuid, $7, $2, $3::uuid, 'cp-' || $3::text, $4::jsonb, $5, lower($6), now(), now())
       ON CONFLICT (organization_id, client_request_id) DO NOTHING
       RETURNING id::text, reviewed_maton_connection_id, operation_kind, status, client_request_id::text, provider_request_id,
         request_payload, request_fingerprint, provider_entity_type, provider_entity_id, provider_sync_token,
         requested_by, NULL::text AS requested_by_name, submitted_by, approved_by,
         NULL::text AS approved_by_name, cancelled_by, approval_note, attempt_count, max_attempts,
         last_error_code, last_error_message, created_at::text, submitted_at::text, approved_at::text,
         posted_at::text, cancelled_at::text, updated_at::text`,
      [
        input.organizationId,
        input.operationKind,
        input.clientRequestId,
        JSON.stringify(input.payload),
        input.requestFingerprint,
        input.actorEmail,
        reviewedConnectionId,
      ],
    )
    let row = inserted.rows[0]
    if (!row) {
      const existing = await client.query<WriteRequestRow>(
        `SELECT ${WRITE_REQUEST_SELECT}
         FROM quickbooks_write_requests request
         LEFT JOIN app_users requested ON requested.email = request.requested_by
         LEFT JOIN app_users approved ON approved.email = request.approved_by
         WHERE request.organization_id = $1::uuid AND request.client_request_id = $2::uuid
         FOR UPDATE OF request`,
        [input.organizationId, input.clientRequestId],
      )
      row = existing.rows[0]
      if (!row) throw new QuickBooksWriteRequestError('QUICKBOOKS_NOT_CONNECTED', 'Connect QuickBooks before preparing accounting changes', 409)
      if (row.operation_kind !== input.operationKind || row.request_fingerprint !== input.requestFingerprint) {
        throw new QuickBooksWriteRequestError(
          'QUICKBOOKS_WRITE_IDEMPOTENCY_CONFLICT',
          'This draft request identifier was already used for different accounting content',
          409,
        )
      }
      if (row.reviewed_maton_connection_id !== reviewedConnectionId) {
        throw new QuickBooksWriteRequestError(
          'QUICKBOOKS_WRITE_CONNECTION_CONFLICT',
          'This draft request identifier was reviewed for a different QuickBooks connection',
          409,
        )
      }
      return toWriteRequest(row)
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'quickbooks.write.drafted',
      aggregateType: 'quickbooks_write_request',
      aggregateId: row.id,
      organizationId: input.organizationId,
      payload: {
        operationKind: input.operationKind,
        requestStatus: 'draft',
        providerRequestId: row.provider_request_id,
        requestFingerprint: input.requestFingerprint,
        ...requestSummary(input.operationKind, input.payload),
      },
    }, client)
    return toWriteRequest(row)
  })
}

export async function transitionQuickBooksWriteRequestInPostgres(input: {
  organizationId: string
  requestId: string
  action: 'submit' | 'approve' | 'cancel' | 'retry'
  actorEmail: string
  confirmFingerprint?: string | null
  approvalNote?: string | null
}) {
  return withTransaction(async (client) => {
    const current = await readWriteRequest(client, input.organizationId, input.requestId)
    let nextStatus: QuickBooksWriteRequestStatus
    if (input.action === 'submit') {
      if (current.status !== 'draft') throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_STATE_CONFLICT', 'Only a draft can be submitted for approval', 409)
      nextStatus = 'pending_approval'
    } else if (input.action === 'approve') {
      if (current.status !== 'pending_approval') throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_STATE_CONFLICT', 'Only a pending draft can be approved', 409)
      if (!input.confirmFingerprint || input.confirmFingerprint !== current.request_fingerprint) {
        throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_APPROVAL_STALE', 'Review the current draft content before approving it', 409)
      }
      nextStatus = 'approved'
    } else if (input.action === 'retry') {
      if (current.status !== 'failed' && current.status !== 'dead') {
        throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_STATE_CONFLICT', 'Only a failed accounting change can be retried', 409)
      }
      nextStatus = 'approved'
    } else {
      if (!['draft', 'pending_approval', 'approved', 'failed', 'dead'].includes(current.status)) {
        throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_STATE_CONFLICT', 'This accounting change can no longer be cancelled', 409)
      }
      nextStatus = 'cancelled'
    }

    if (input.action === 'approve' || input.action === 'retry') {
      const connection = await client.query<{
        write_mode: 'disabled' | 'sandbox' | 'production'
        write_verified_at: string | null
      }>(
        `SELECT write_mode, write_verified_at::text
         FROM organization_quickbooks_connections
         WHERE organization_id = $1::uuid AND status = 'active'
         FOR SHARE`,
        [input.organizationId],
      )
      const policy = configuredQuickBooksWritePolicy()
      const binding = connection.rows[0]
      const operationAllowed = Boolean(
        binding?.write_verified_at
        && policy.enabled
        && policy.mode === binding.write_mode
        && policy.allowedOperations.includes(current.operation_kind),
      )
      if (!operationAllowed) {
        throw new QuickBooksWriteRequestError(
          'QUICKBOOKS_WRITE_OPERATION_DISABLED',
          'Provider posting is not enabled for this type of accounting change',
          409,
        )
      }
    }

    const result = await client.query<WriteRequestRow>(
      `UPDATE quickbooks_write_requests request SET
         status = $3,
         submitted_by = CASE WHEN $4 = 'submit' THEN lower($5) ELSE submitted_by END,
         submitted_at = CASE WHEN $4 = 'submit' THEN now() ELSE submitted_at END,
         approved_by = CASE WHEN $4 IN ('approve', 'retry') THEN lower($5) ELSE approved_by END,
         approved_at = CASE WHEN $4 IN ('approve', 'retry') THEN now() ELSE approved_at END,
         approval_note = CASE WHEN $4 = 'approve' THEN $6 ELSE approval_note END,
         cancelled_by = CASE WHEN $4 = 'cancel' THEN lower($5) ELSE cancelled_by END,
         cancelled_at = CASE WHEN $4 = 'cancel' THEN now() ELSE cancelled_at END,
         attempt_count = CASE WHEN $4 = 'retry' THEN 0 ELSE attempt_count END,
         available_at = CASE WHEN $4 IN ('approve', 'retry') THEN now() ELSE available_at END,
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         last_error_code = CASE WHEN $4 = 'retry' THEN NULL ELSE last_error_code END,
         last_error_message = CASE WHEN $4 = 'retry' THEN NULL ELSE last_error_message END,
         updated_at = now()
       FROM app_users requested
       WHERE request.organization_id = $1::uuid AND request.id = $2::uuid
         AND requested.email = request.requested_by
       RETURNING request.id::text, request.operation_kind, request.status,
         request.client_request_id::text, request.provider_request_id, request.request_payload,
         request.request_fingerprint, request.provider_entity_type, request.provider_entity_id,
         request.provider_sync_token, request.requested_by, requested.display_name AS requested_by_name,
         request.submitted_by, request.approved_by, NULL::text AS approved_by_name,
         request.cancelled_by, request.approval_note, request.attempt_count, request.max_attempts,
         request.last_error_code, request.last_error_message, request.created_at::text,
         request.submitted_at::text, request.approved_at::text, request.posted_at::text,
         request.cancelled_at::text, request.updated_at::text`,
      [input.organizationId, input.requestId, nextStatus, input.action, input.actorEmail, input.approvalNote || null],
    )
    const updated = result.rows[0]
    if (!updated) throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_STATE_CONFLICT', 'Accounting draft could not be updated', 409)
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: `quickbooks.write.${{
        submit: 'submitted',
        approve: 'approved',
        cancel: 'cancelled',
        retry: 'retry_approved',
      }[input.action]}`,
      aggregateType: 'quickbooks_write_request',
      aggregateId: current.id,
      organizationId: input.organizationId,
      payload: {
        operationKind: current.operation_kind,
        previousStatus: current.status,
        requestStatus: nextStatus,
        providerRequestId: current.provider_request_id,
        requestFingerprint: current.request_fingerprint,
        approvalNote: input.action === 'approve' ? input.approvalNote || null : undefined,
        ...requestSummary(current.operation_kind, current.request_payload),
      },
    }, client)
    return toWriteRequest(updated)
  })
}

export async function claimQuickBooksWriteJobsInPostgres(input: {
  limit: number
  workerId: string
  writeMode: 'sandbox' | 'production'
  allowedOperations: QuickBooksWriteOperationKind[]
}) {
  if (input.allowedOperations.length === 0) return []
  return withTransaction(async (client) => {
    const claimed = await client.query<{
      id: string
      organization_id: string
      operation_kind: QuickBooksWriteOperationKind
      request_payload: QuickBooksWriteDraftPayload
      provider_request_id: string
      request_fingerprint: string
      attempt_count: number
      max_attempts: number
      lock_token: string
      credential_owner_email: string
      maton_connection_id: string
      write_mode: 'sandbox' | 'production'
    }>(
      `WITH candidate AS (
         SELECT request.id
         FROM quickbooks_write_requests request
         JOIN organization_quickbooks_connections connection
           ON connection.organization_id = request.organization_id
          AND connection.maton_connection_id = request.reviewed_maton_connection_id
         WHERE connection.status = 'active'
           AND connection.write_mode = $3
           AND connection.write_verified_at IS NOT NULL
           AND request.operation_kind = ANY($4::text[])
           AND (
             (request.status IN ('approved', 'failed') AND request.available_at <= now() AND request.attempt_count < request.max_attempts)
            OR (
              request.status = 'processing'
              AND request.locked_at < now() - interval '10 minutes'
              AND request.attempt_count < request.max_attempts
            )
           )
         ORDER BY request.available_at, request.created_at
         FOR UPDATE OF request, connection SKIP LOCKED
         LIMIT $1
       )
       UPDATE quickbooks_write_requests request SET
         status = 'processing', attempt_count = request.attempt_count + 1,
         locked_at = now(), locked_by = $2, lock_token = gen_random_uuid(), updated_at = now()
       FROM candidate, organization_quickbooks_connections connection
       WHERE request.id = candidate.id
         AND connection.organization_id = request.organization_id
         AND connection.maton_connection_id = request.reviewed_maton_connection_id
       RETURNING request.id::text, request.organization_id::text, request.operation_kind,
         request.request_payload, request.provider_request_id, request.request_fingerprint,
         request.attempt_count, request.max_attempts, request.lock_token::text,
         connection.credential_owner_email, connection.maton_connection_id, connection.write_mode`,
      [Math.max(1, Math.min(input.limit, 10)), input.workerId, input.writeMode, input.allowedOperations],
    )
    return claimed.rows.map((row): QuickBooksWriteJob => ({
      id: row.id,
      organizationId: row.organization_id,
      ownerEmail: row.credential_owner_email,
      connectionId: row.maton_connection_id,
      operationKind: row.operation_kind,
      requestPayload: row.request_payload,
      providerRequestId: row.provider_request_id,
      requestFingerprint: row.request_fingerprint,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      lockToken: row.lock_token,
      writeMode: row.write_mode,
    }))
  })
}

export async function completeQuickBooksWriteJobInPostgres(input: {
  job: QuickBooksWriteJob
  providerEntityType: string
  providerEntityId: string
  providerSyncToken: string | null
}) {
  return withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE quickbooks_write_requests SET
         status = 'succeeded', provider_entity_type = $3, provider_entity_id = $4,
         provider_sync_token = $5, result_payload = $6::jsonb,
         last_error_code = NULL, last_error_message = NULL,
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         posted_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2::uuid
         AND reviewed_maton_connection_id = $7`,
      [
        input.job.id,
        input.job.lockToken,
        input.providerEntityType,
        input.providerEntityId,
        input.providerSyncToken,
        JSON.stringify({
          entityType: input.providerEntityType,
          entityId: input.providerEntityId,
          syncToken: input.providerSyncToken,
          requestFingerprint: input.job.requestFingerprint,
        }),
        input.job.connectionId,
      ],
    )
    if (!completed.rowCount) throw new Error('QuickBooks write lease was lost')
    await recordAuditEvent({
      actor: 'system',
      eventType: 'quickbooks.write.succeeded',
      aggregateType: 'quickbooks_write_request',
      aggregateId: input.job.id,
      organizationId: input.job.organizationId,
      isSystem: true,
      payload: {
        operationKind: input.job.operationKind,
        requestStatus: 'succeeded',
        providerRequestId: input.job.providerRequestId,
        providerEntityType: input.providerEntityType,
        providerEntityId: input.providerEntityId,
        requestFingerprint: input.job.requestFingerprint,
        ...requestSummary(input.job.operationKind, input.job.requestPayload),
      },
    }, client)
  })
}

function safeError(value: unknown) {
  return String(value || 'QuickBooks write failed').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000)
}

export async function failQuickBooksWriteJobInPostgres(input: {
  job: QuickBooksWriteJob
  errorCode: string
  error: unknown
}) {
  const dead = input.job.attemptCount >= input.job.maxAttempts
  const message = safeError(input.error)
  return withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE quickbooks_write_requests SET
         status = $3, last_error_code = $4, last_error_message = $5,
         available_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempt_count, 7)))::integer),
         locked_at = NULL, locked_by = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2::uuid
         AND reviewed_maton_connection_id = $6`,
      [input.job.id, input.job.lockToken, dead ? 'dead' : 'failed', input.errorCode, message, input.job.connectionId],
    )
    if (!failed.rowCount) return false
    await recordAuditEvent({
      actor: 'system',
      eventType: dead ? 'quickbooks.write.dead' : 'quickbooks.write.failed',
      aggregateType: 'quickbooks_write_request',
      aggregateId: input.job.id,
      organizationId: input.job.organizationId,
      isSystem: true,
      payload: {
        operationKind: input.job.operationKind,
        requestStatus: dead ? 'dead' : 'failed',
        providerRequestId: input.job.providerRequestId,
        requestFingerprint: input.job.requestFingerprint,
        attemptCount: input.job.attemptCount,
        errorCode: input.errorCode,
        message,
        ...requestSummary(input.job.operationKind, input.job.requestPayload),
      },
    }, client)
    return dead
  })
}
