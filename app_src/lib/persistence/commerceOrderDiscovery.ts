import { createHash, randomUUID } from 'node:crypto'
import { CommerceIntegrationRequestError } from '@/lib/integrations/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'commerce.orders.discovery'
const PROCESSING_RECEIPT_STALE_MS = 6 * 60_000

type DiscoveryReceiptRow = {
  id: string
  request_hash: string
  target_global_id: string | null
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
  updated_at: Date
}

export type CommerceOrderDiscoveryHttpResult = {
  status: number
  body: Record<string, unknown>
}

export type CommerceOrderDiscoveryCommand =
  | {
      kind: 'execute'
      receiptId: string
      attemptToken: string
    }
  | {
      kind: 'replay'
      result: CommerceOrderDiscoveryHttpResult
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

function requestHash(accountGlobalId: string) {
  return createHash('sha256').update(canonicalJson({
    action: 'refresh-connected-store-orders',
    accountGlobalId,
    version: 1,
  })).digest('hex')
}

function receiptLockKey(input: {
  organizationId: string
  idempotencyKey: string
}) {
  return `commerce-order-discovery:${input.organizationId}:${input.idempotencyKey}`
}

function requestError(code: string, message: string, status = 409): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function replayResult(
  receipt: Pick<DiscoveryReceiptRow, 'result_payload'>,
): CommerceOrderDiscoveryHttpResult {
  const envelope = receipt.result_payload
  const body = envelope?.body
  if (
    !envelope
    || Object.keys(envelope).sort().join(',') !== 'body,httpStatus,version'
    || envelope.version !== 1
    || !Number.isSafeInteger(envelope.httpStatus)
    || Number(envelope.httpStatus) < 100
    || Number(envelope.httpStatus) > 599
    || !body
    || typeof body !== 'object'
    || Array.isArray(body)
  ) {
    requestError(
      'COMMERCE_ORDER_DISCOVERY_RECEIPT_INVALID',
      'The completed connected-store refresh result is invalid',
      500,
    )
  }
  return {
    status: Number(envelope.httpStatus),
    body: body as Record<string, unknown>,
  }
}

export async function prepareCommerceOrderDiscoveryCommandInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  actorEmail: string
  idempotencyKey: string
}): Promise<CommerceOrderDiscoveryCommand> {
  const expectedRequestHash = requestHash(input.accountGlobalId)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, receiptLockKey(input))
    const existing = await client.query<DiscoveryReceiptRow>(
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
        receipt.request_hash !== expectedRequestHash
        || receipt.target_global_id !== input.accountGlobalId
      ) {
        requestError(
          'COMMERCE_ORDER_DISCOVERY_IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different connected store refresh',
        )
      }
      if (receipt.status === 'succeeded') {
        return { kind: 'replay', result: replayResult(receipt) }
      }
      if (
        receipt.status === 'processing'
        && Date.now() - receipt.updated_at.getTime()
          < PROCESSING_RECEIPT_STALE_MS
      ) {
        requestError(
          'COMMERCE_ORDER_DISCOVERY_COMMAND_IN_PROGRESS',
          'This connected-store refresh request is already being processed',
        )
      }
      const attemptToken = randomUUID()
      const retried = await client.query<{
        id: string
        correlation_id: string
      }>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, result_global_id = NULL,
             result_payload = NULL, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             correlation_id = $3::uuid,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, correlation_id::text`,
        [receipt.id, input.actorEmail, attemptToken],
      )
      return {
        kind: 'execute',
        receiptId: retried.rows[0].id,
        attemptToken: retried.rows[0].correlation_id,
      }
    }
    const attemptToken = randomUUID()
    const created = await client.query<{
      id: string
      correlation_id: string
    }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, target_global_id
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7
       )
       RETURNING id::text, correlation_id::text`,
      [
        input.organizationId,
        COMMAND_TYPE,
        input.idempotencyKey,
        expectedRequestHash,
        input.actorEmail,
        attemptToken,
        input.accountGlobalId,
      ],
    )
    return {
      kind: 'execute',
      receiptId: created.rows[0].id,
      attemptToken: created.rows[0].correlation_id,
    }
  })
}

export async function completeCommerceOrderDiscoveryCommandInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  idempotencyKey: string
  receiptId: string
  attemptToken: string
  result: CommerceOrderDiscoveryHttpResult
}): Promise<CommerceOrderDiscoveryHttpResult> {
  if (
    !Number.isSafeInteger(input.result.status)
    || input.result.status < 100
    || input.result.status > 599
  ) {
    requestError(
      'COMMERCE_ORDER_DISCOVERY_RESULT_INVALID',
      'Connected-store refresh returned an invalid HTTP result',
      500,
    )
  }
  const expectedRequestHash = requestHash(input.accountGlobalId)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, receiptLockKey(input))
    const selected = await client.query<DiscoveryReceiptRow>(
      `SELECT id::text, request_hash, target_global_id, status,
              correlation_id::text, result_payload, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
         AND id = $4::uuid
       FOR UPDATE`,
      [
        input.organizationId,
        COMMAND_TYPE,
        input.idempotencyKey,
        input.receiptId,
      ],
    )
    const receipt = selected.rows[0]
    if (
      !receipt
      || receipt.request_hash !== expectedRequestHash
      || receipt.target_global_id !== input.accountGlobalId
    ) {
      requestError(
        'COMMERCE_ORDER_DISCOVERY_RECEIPT_INVALID',
        'The connected-store refresh receipt is invalid',
        500,
      )
    }
    if (
      receipt.status === 'succeeded'
      && receipt.correlation_id === input.attemptToken
    ) {
      return replayResult(receipt)
    }
    if (
      receipt.status !== 'processing'
      || receipt.correlation_id !== input.attemptToken
    ) {
      requestError(
        'COMMERCE_ORDER_DISCOVERY_ATTEMPT_SUPERSEDED',
        'This connected-store refresh attempt was superseded by a retry',
      )
    }
    const envelope = {
      version: 1,
      httpStatus: input.result.status,
      body: input.result.body,
    }
    const completed = await client.query<DiscoveryReceiptRow>(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, error_code = NULL,
           error_message = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'
         AND correlation_id = $4::uuid
       RETURNING id::text, request_hash, target_global_id, status,
                 correlation_id::text, result_payload, updated_at`,
      [
        input.receiptId,
        input.accountGlobalId,
        JSON.stringify(envelope),
        input.attemptToken,
      ],
    )
    if (!completed.rows[0]) {
      requestError(
        'COMMERCE_ORDER_DISCOVERY_ATTEMPT_SUPERSEDED',
        'This connected-store refresh attempt was superseded by a retry',
      )
    }
    return replayResult(completed.rows[0])
  })
}
