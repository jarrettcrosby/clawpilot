import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  SANDBOX_COMMERCE_E2E_CONFIRMATION,
  SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
} from '@/lib/operations/sandboxCommerceE2e'
import { query, withTransaction } from '@/lib/persistence/postgres'

export {
  SANDBOX_COMMERCE_E2E_CONFIRMATION,
  SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
} from '@/lib/operations/sandboxCommerceE2e'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ORDER_GLOBAL_ID = /^gor[0-9]{7}$/
const AUTHORIZATION_GLOBAL_ID = /^gsea[0-9]{7}$/

export class SandboxCommerceE2eAuthorizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'SandboxCommerceE2eAuthorizationError'
  }
}

type AuthorizationRow = {
  id: string
  global_id: string
  organization_id: string
  order_id: string
  order_global_id: string
  external_order_id: string
  state: 'active' | 'consumed' | 'revoked' | 'expired'
  reason: string
  authorized_by: string
  authorized_at: Date | string
  expires_at: Date | string
  consumed_at: Date | string | null
  consumed_by: string | null
}

export type SandboxCommerceE2eAuthorization = {
  authorizationGlobalId: string
  orderGlobalId: string
  externalOrderId: string
  state: AuthorizationRow['state']
  reason: string
  authorizedBy: string
  authorizedAt: string
  expiresAt: string
  consumedAt: string | null
  consumedBy: string | null
}

function fail(code: string, message: string, status = 409): never {
  throw new SandboxCommerceE2eAuthorizationError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) fail('SANDBOX_E2E_ORGANIZATION_INVALID', 'Organization is invalid', 400)
  return normalized
}

function email(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    fail('SANDBOX_E2E_ACTOR_INVALID', 'A signed-in actor is required', 401)
  }
  return normalized
}

function reason(value: unknown) {
  const normalized = String(value || '').trim()
  if (normalized.length < 8 || normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('SANDBOX_E2E_REASON_INVALID', 'An 8-500 character authorization reason is required', 400)
  }
  return normalized
}

function map(row: AuthorizationRow): SandboxCommerceE2eAuthorization {
  return {
    authorizationGlobalId: row.global_id,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    state: row.state,
    reason: row.reason,
    authorizedBy: row.authorized_by,
    authorizedAt: new Date(row.authorized_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedBy: row.consumed_by,
  }
}

const SELECT = `SELECT auth.id::text, auth.global_id,
  auth.organization_id::text, auth.order_id::text,
  source_order.global_id AS order_global_id,
  auth.external_order_id, auth.state,
  auth.reason, auth.authorized_by,
  auth.authorized_at, auth.expires_at,
  auth.consumed_at, auth.consumed_by
FROM operations_sandbox_commerce_e2e_authorizations auth
JOIN operations_orders source_order
  ON source_order.organization_id = auth.organization_id
 AND source_order.id = auth.order_id`

export async function authorizeSandboxCommerceE2eInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  orderGlobalId: unknown
  confirmationStatement: unknown
  reason: unknown
  lifetimeMinutes?: unknown
}): Promise<SandboxCommerceE2eAuthorization> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actorEmail = email(input.actorEmail)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    fail('SANDBOX_E2E_ORDER_INVALID', 'Operations order is invalid', 400)
  }
  if (input.confirmationStatement !== SANDBOX_COMMERCE_E2E_CONFIRMATION) {
    fail('SANDBOX_E2E_CONFIRMATION_REQUIRED', 'The exact sandbox E2E confirmation is required', 400)
  }
  const authorizationReason = reason(input.reason)
  const lifetimeMinutes = input.lifetimeMinutes === undefined
    ? 120
    : Number(input.lifetimeMinutes)
  if (!Number.isSafeInteger(lifetimeMinutes) || lifetimeMinutes < 5 || lifetimeMinutes > 1_440) {
    fail('SANDBOX_E2E_LIFETIME_INVALID', 'Authorization lifetime must be 5-1440 minutes', 400)
  }
  return withTransaction(async (client) => {
    const orderResult = await client.query<{
      id: string
      external_order_id: string
      source_provider: string
      status: string
    }>(
      `SELECT id::text, external_order_id, source_provider, status
       FROM operations_orders
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [scopedOrganizationId, orderGlobalId],
    )
    const order = orderResult.rows[0]
    if (!order) fail('SANDBOX_E2E_ORDER_NOT_FOUND', 'Operations order was not found', 404)
    if (order.source_provider !== 'shopify' || order.status !== 'packed') {
      fail('SANDBOX_E2E_ORDER_INELIGIBLE', 'Authorization requires one packed Shopify order')
    }
    await client.query(
      `UPDATE operations_sandbox_commerce_e2e_authorizations
       SET state = 'expired'
       WHERE organization_id = $1::uuid AND order_id = $2::uuid
         AND state = 'active' AND expires_at <= now()`,
      [scopedOrganizationId, order.id],
    )
    const existingResult = await client.query<AuthorizationRow>(
      `${SELECT}
       WHERE auth.organization_id = $1::uuid
         AND auth.order_id = $2::uuid
         AND auth.state = 'active'
         AND auth.expires_at > now()
       FOR UPDATE OF auth`,
      [scopedOrganizationId, order.id],
    )
    const existing = existingResult.rows[0]
    if (existing) {
      if (
        existing.authorized_by === actorEmail
        && existing.reason === authorizationReason
      ) {
        return map(existing)
      }
      fail(
        'SANDBOX_E2E_AUTHORIZATION_ALREADY_ACTIVE',
        'A different active sandbox E2E authorization already exists for this order',
      )
    }
    const confirmationHash = createHash('sha256').update(JSON.stringify({
      version: SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
      statement: SANDBOX_COMMERCE_E2E_CONFIRMATION,
      organizationId: scopedOrganizationId,
      orderGlobalId,
      externalOrderId: order.external_order_id,
      actorEmail,
      reason: authorizationReason,
    })).digest('hex')
    const inserted = await client.query<AuthorizationRow>(
      `WITH created AS (
         INSERT INTO operations_sandbox_commerce_e2e_authorizations (
           organization_id, order_id, external_order_id,
           confirmation_statement_version, confirmation_hash, reason,
           authorized_by, expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3,
           '${SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION}', $5, $6,
           $7, now() + ($8::integer * interval '1 minute')
         )
         RETURNING *
       )
       SELECT created.id::text, created.global_id,
              created.organization_id::text, created.order_id::text,
              $4 AS order_global_id, created.external_order_id, created.state,
              created.reason, created.authorized_by, created.authorized_at,
              created.expires_at, created.consumed_at, created.consumed_by
       FROM created`,
      [
        scopedOrganizationId, order.id, order.external_order_id, orderGlobalId,
        confirmationHash, authorizationReason, actorEmail, lifetimeMinutes,
      ],
    )
    const authorization = inserted.rows[0]
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.sandbox_commerce_e2e.authorized',
      aggregateType: 'operations.order',
      aggregateId: orderGlobalId,
      subject: authorization.global_id,
      organizationId: scopedOrganizationId,
      eventKey: `operations:sandbox-commerce-e2e-authorized:${authorization.global_id}`,
      payload: {
        authorizationGlobalId: authorization.global_id,
        externalOrderId: order.external_order_id,
        expiresAt: new Date(authorization.expires_at).toISOString(),
        confirmationStatementVersion: SANDBOX_COMMERCE_E2E_CONFIRMATION_VERSION,
        reason: authorizationReason,
      },
    }, client)
    return map(authorization)
  })
}

export async function requireActiveSandboxCommerceE2eAuthorization(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = String(input.authorizationGlobalId || '').trim()
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const actorEmail = email(input.actorEmail)
  if (!AUTHORIZATION_GLOBAL_ID.test(authorizationGlobalId)) {
    fail('SANDBOX_E2E_AUTHORIZATION_INVALID', 'Sandbox E2E authorization is invalid', 400)
  }
  const result = await client.query<AuthorizationRow>(
    `${SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2
       AND source_order.global_id = $3
     FOR UPDATE OF auth`,
    [scopedOrganizationId, authorizationGlobalId, orderGlobalId],
  )
  const row = result.rows[0]
  if (!row || row.authorized_by !== actorEmail) {
    fail('SANDBOX_E2E_AUTHORIZATION_REQUIRED', 'Exact actor-bound sandbox E2E authorization is required', 403)
  }
  if (row.state !== 'active' || Date.parse(new Date(row.expires_at).toISOString()) <= Date.now()) {
    fail('SANDBOX_E2E_AUTHORIZATION_EXPIRED', 'Sandbox E2E authorization is no longer active', 403)
  }
  return row
}

export async function consumeSandboxCommerceE2eAuthorization(
  client: PoolClient,
  input: {
    organizationId: unknown
    authorizationGlobalId: unknown
    orderGlobalId: unknown
    actorEmail: unknown
  },
) {
  const row = await requireActiveSandboxCommerceE2eAuthorization(client, input)
  const result = await client.query<AuthorizationRow>(
    `WITH updated AS (
         UPDATE operations_sandbox_commerce_e2e_authorizations
         SET state = 'consumed', consumed_at = now(), consumed_by = $3
         WHERE organization_id = $1::uuid AND id = $2::uuid AND state = 'active'
         RETURNING *
       )
       SELECT updated.id::text, updated.global_id,
              updated.organization_id::text, updated.order_id::text,
              source_order.global_id AS order_global_id,
              updated.external_order_id, updated.state, updated.reason,
              updated.authorized_by, updated.authorized_at, updated.expires_at,
              updated.consumed_at, updated.consumed_by
       FROM updated
       JOIN operations_orders source_order
         ON source_order.organization_id = updated.organization_id
        AND source_order.id = updated.order_id`,
    [row.organization_id, row.id, row.authorized_by],
  )
  if (!result.rows[0]) fail('SANDBOX_E2E_AUTHORIZATION_CHANGED', 'Sandbox E2E authorization changed')
  return map(result.rows[0])
}

export async function readSandboxCommerceE2eAuthorizationInPostgres(input: {
  organizationId: unknown
  authorizationGlobalId: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const authorizationGlobalId = String(input.authorizationGlobalId || '').trim()
  const result = await query<AuthorizationRow>(
    `${SELECT}
     WHERE auth.organization_id = $1::uuid
       AND auth.global_id = $2`,
    [scopedOrganizationId, authorizationGlobalId],
  )
  return result.rows[0] ? map(result.rows[0]) : null
}

export async function readActiveSandboxCommerceE2eAuthorizationForOrderInPostgres(input: {
  organizationId: unknown
  orderGlobalId: unknown
  actorEmail: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const orderGlobalId = String(input.orderGlobalId || '').trim()
  const actorEmail = email(input.actorEmail)
  if (!ORDER_GLOBAL_ID.test(orderGlobalId)) {
    fail('SANDBOX_E2E_ORDER_INVALID', 'Operations order is invalid', 400)
  }
  const result = await query<AuthorizationRow>(
    `${SELECT}
     WHERE auth.organization_id = $1::uuid
       AND source_order.global_id = $2
       AND auth.authorized_by = $3
       AND auth.state = 'active'
       AND auth.expires_at > now()
     ORDER BY auth.authorized_at DESC, auth.id DESC
     LIMIT 1`,
    [scopedOrganizationId, orderGlobalId, actorEmail],
  )
  return result.rows[0] ? map(result.rows[0]) : null
}
