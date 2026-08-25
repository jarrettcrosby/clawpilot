import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
  SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'
import { query, withTransaction } from '@/lib/persistence/postgres'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const COMMAND_GLOBAL_ID = /^gsfc(?:[0-9]{7}|[0-9a-v]{12})$/u
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const SHA256 = /^[a-f0-9]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u

export type ShopifyReversalFixturePhase =
  | 'create_order'
  | 'create_fulfillment'
export type ShopifyReversalFixtureOutcomeState =
  | 'succeeded'
  | 'rejected'
  | 'unknown'
  | 'reconciled_applied'
  | 'reconciled_absent'
  | 'reconciled_ambiguous'

export type ShopifyReversalFixtureAuthority = Readonly<{
  organizationId: string
  actorEmail: string
  actorRole: 'owner' | 'admin'
  integrationAccountId: string
  accountGlobalId: typeof SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID
  externalAccountId: string
  shopDomain: string
  controlRowVersion: number
  credentialGeneration: number
  grantedScopeDigest: string
  grantedScopes: readonly string[]
  databaseIdentity: typeof SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY
}>

export type ShopifyReversalFixtureCommand = Readonly<{
  id: string
  globalId: string
  organizationId: string
  phase: ShopifyReversalFixturePhase
  actorEmail: string
  actorRole: 'owner' | 'admin'
  idempotencyKey: string
  intentHash: string
  confirmationHash: string
  sourceIdentifier: string | null
  uniqueTag: string | null
  tagFingerprint: string | null
  predecessorCommandId: string | null
  orderId: string | null
  orderGlobalId: string | null
  externalOrderId: string | null
  expectedOrderRowVersion: number | null
  releasedAt: string | null
  providerLocationId: string | null
  expectedLines: ReadonlyArray<{ lineItemId: string; quantity: number }> | null
  fulfillmentAttemptSignature: Record<string, unknown> | null
  fulfillmentAttemptSignatureHash: string | null
  preparedAt: string
  expiresAt: string
  authority: ShopifyReversalFixtureAuthority
}>

export type ShopifyReversalFixtureFulfillmentTarget = Readonly<{
  predecessorCommandId: string
  predecessorCommandGlobalId: string
  orderId: string
  orderGlobalId: string
  externalOrderId: string
  orderName: string
  expectedOrderRowVersion: number
  releasedAt: string
  providerLocationId: string
  expectedLines: ReadonlyArray<{ lineItemId: string; quantity: number }>
}>

export class ShopifyReversalFixturePersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyReversalFixturePersistenceError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyReversalFixturePersistenceError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_INVALID',
      'Organization is invalid',
      400,
    )
  }
  return normalized
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (
    !normalized
    || normalized.length > 320
    || !normalized.includes('@')
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ACTOR_INVALID',
      'An owner or administrator email is required',
      400,
    )
  }
  return normalized
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_IDEMPOTENCY_INVALID',
      'A valid idempotency key is required',
      400,
    )
  }
  return normalized
}

function sha256(value: unknown, label: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!SHA256.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_HASH_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function commandGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!COMMAND_GLOBAL_ID.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_COMMAND_INVALID',
      'Fixture command is invalid',
      400,
    )
  }
  return normalized
}

function orderGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!ORDER_GLOBAL_ID.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_INVALID',
      'Operations order is invalid',
      400,
    )
  }
  return normalized
}

function timestamp(value: Date | string | null, label: string) {
  if (!value) fail('SHOPIFY_REVERSAL_FIXTURE_CONTEXT_INVALID', `${label} is missing`)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail('SHOPIFY_REVERSAL_FIXTURE_CONTEXT_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

type AuthorityRow = QueryResultRow & {
  organization_id: string
  actor_email: string
  actor_role: string
  integration_account_id: string
  account_global_id: string
  external_account_id: string
  shop_domain: string
  control_row_version: string
  credential_generation: number
  granted_scope_digest: string
  granted_scopes: string[]
  database_identity: string
  exact_current: boolean
}

const AUTHORITY_SELECT = `SELECT
  account.organization_id::text,
  membership.user_email AS actor_email,
  membership.role AS actor_role,
  account.id::text AS integration_account_id,
  account.global_id AS account_global_id,
  account.external_account_id,
  account.configuration->>'shopDomain' AS shop_domain,
  control.row_version::text AS control_row_version,
  account.commerce_credential_generation AS credential_generation,
  control.bound_granted_scope_digest AS granted_scope_digest,
  control.bound_granted_scopes AS granted_scopes,
  setting.value->>'id' AS database_identity,
  public.operations_shopify_reversal_fixture_account_is_current(
    account.organization_id,
    account.id,
    control.row_version,
    account.commerce_credential_generation,
    control.bound_granted_scope_digest,
    account.external_account_id,
    account.configuration->>'shopDomain'
  ) AS exact_current
FROM public.operations_integration_accounts account
JOIN public.app_user_organization_memberships membership
  ON membership.organization_id = account.organization_id
 AND membership.user_email = $2
 AND membership.status = 'active'
 AND membership.role IN ('owner', 'admin')
JOIN public.operations_commerce_provider_write_control_current control
  ON control.organization_id = account.organization_id
 AND control.integration_account_id = account.id
JOIN public.app_settings setting
  ON setting.key = 'deployment.database.identity'
WHERE account.organization_id = $1::uuid
  AND account.global_id = '${SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID}'
  AND public.operations_shopify_reversal_fixture_database_is_trusted()
LIMIT 2`

function mapAuthority(row: AuthorityRow | undefined): ShopifyReversalFixtureAuthority {
  if (
    !row
    || !['owner', 'admin'].includes(row.actor_role)
    || row.account_global_id !== SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID
    || row.database_identity !== SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY
    || row.exact_current !== true
    || Number(row.control_row_version) < 1
    || row.credential_generation < 1
    || !SHA256.test(row.granted_scope_digest || '')
    || !Array.isArray(row.granted_scopes)
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_AUTHORITY_REQUIRED',
      'The exact active owner/admin, development database, Shopify account, provider-write control, credential, and scopes are required',
      403,
    )
  }
  return Object.freeze({
    organizationId: row.organization_id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role as 'owner' | 'admin',
    integrationAccountId: row.integration_account_id,
    accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
    externalAccountId: row.external_account_id,
    shopDomain: row.shop_domain,
    controlRowVersion: Number(row.control_row_version),
    credentialGeneration: row.credential_generation,
    grantedScopeDigest: row.granted_scope_digest,
    grantedScopes: Object.freeze([...row.granted_scopes]),
    databaseIdentity: SHOPIFY_REVERSAL_FIXTURE_DATABASE_IDENTITY,
  })
}

export async function readShopifyReversalFixtureAuthorityInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actor = actorEmail(input.actorEmail)
  const result = await query<AuthorityRow>(AUTHORITY_SELECT, [
    scopedOrganizationId,
    actor,
  ])
  if (result.rows.length !== 1) return mapAuthority(undefined)
  return mapAuthority(result.rows[0])
}

export async function allocateShopifyReversalFixtureCommandGlobalIdInPostgres() {
  const result = await query<{ global_id: string }>(
    `SELECT public.allocate_global_reference('gsfc') AS global_id`,
  )
  return commandGlobalId(result.rows[0]?.global_id)
}

type CommandRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  phase: ShopifyReversalFixturePhase
  prepared_by: string
  prepared_role: 'owner' | 'admin'
  idempotency_key: string
  intent_hash: string
  confirmation_hash: string
  source_identifier: string | null
  unique_tag: string | null
  tag_fingerprint: string | null
  predecessor_command_id: string | null
  order_id: string | null
  order_global_id: string | null
  external_order_id: string | null
  expected_order_row_version: string | null
  released_at: Date | string | null
  provider_location_id: string | null
  expected_lines: Array<{ lineItemId: string; quantity: number }> | null
  fulfillment_attempt_signature: Record<string, unknown> | null
  fulfillment_attempt_signature_hash: string | null
  prepared_at: Date | string
  expires_at: Date | string
  integration_account_id: string
  external_account_id: string
  shop_domain: string
  provider_write_control_row_version: string
  credential_generation: number
  granted_scope_digest: string
  granted_scopes: string[]
  database_identity: string
}

const COMMAND_SELECT = `SELECT
  command.id::text, command.global_id, command.organization_id::text,
  command.phase, command.prepared_by, command.prepared_role,
  command.idempotency_key, command.intent_hash, command.confirmation_hash,
  command.source_identifier, command.unique_tag, command.tag_fingerprint,
  command.predecessor_command_id::text, command.order_id::text,
  command.order_global_id, command.external_order_id,
  command.expected_order_row_version::text, command.released_at,
  command.provider_location_id, command.expected_lines,
  command.fulfillment_attempt_signature,
  command.fulfillment_attempt_signature_hash,
  command.prepared_at, command.expires_at,
  command.integration_account_id::text, command.external_account_id,
  command.shop_domain,
  command.provider_write_control_row_version::text,
  command.credential_generation,
  command.granted_scope_digest,
  control.bound_granted_scopes AS granted_scopes,
  setting.value->>'id' AS database_identity
FROM public.operations_shopify_reversal_fixture_commands command
JOIN public.operations_commerce_provider_write_control_current control
  ON control.organization_id = command.organization_id
 AND control.integration_account_id = command.integration_account_id
JOIN public.app_settings setting
  ON setting.key = 'deployment.database.identity'`

function mapCommand(row: CommandRow | undefined): ShopifyReversalFixtureCommand {
  if (!row) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_COMMAND_NOT_FOUND',
      'Fixture command was not found',
      404,
    )
  }
  const authority = mapAuthority({
    organization_id: row.organization_id,
    actor_email: row.prepared_by,
    actor_role: row.prepared_role,
    integration_account_id: row.integration_account_id,
    account_global_id: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
    external_account_id: row.external_account_id,
    shop_domain: row.shop_domain,
    control_row_version: row.provider_write_control_row_version,
    credential_generation: row.credential_generation,
    granted_scope_digest: row.granted_scope_digest,
    granted_scopes: row.granted_scopes,
    database_identity: row.database_identity,
    exact_current: true,
  })
  return Object.freeze({
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    phase: row.phase,
    actorEmail: row.prepared_by,
    actorRole: row.prepared_role,
    idempotencyKey: row.idempotency_key,
    intentHash: row.intent_hash,
    confirmationHash: row.confirmation_hash,
    sourceIdentifier: row.source_identifier,
    uniqueTag: row.unique_tag,
    tagFingerprint: row.tag_fingerprint,
    predecessorCommandId: row.predecessor_command_id,
    orderId: row.order_id,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    expectedOrderRowVersion: row.expected_order_row_version === null
      ? null
      : Number(row.expected_order_row_version),
    releasedAt: row.released_at ? timestamp(row.released_at, 'Release time') : null,
    providerLocationId: row.provider_location_id,
    expectedLines: row.expected_lines,
    fulfillmentAttemptSignature: row.fulfillment_attempt_signature,
    fulfillmentAttemptSignatureHash: row.fulfillment_attempt_signature_hash,
    preparedAt: timestamp(row.prepared_at, 'Preparation time'),
    expiresAt: timestamp(row.expires_at, 'Expiration time'),
    authority,
  })
}

export async function readShopifyReversalFixtureCommandByIdempotencyInPostgres(
  input: {
    organizationId: unknown
    phase: ShopifyReversalFixturePhase
    idempotencyKey: unknown
  },
) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const key = idempotencyKey(input.idempotencyKey)
  const result = await query<CommandRow>(
    `${COMMAND_SELECT}
     WHERE command.organization_id = $1::uuid
       AND command.phase = $2
       AND command.idempotency_key = $3
     LIMIT 2`,
    [scopedOrganizationId, input.phase, key],
  )
  return result.rows[0] ? mapCommand(result.rows[0]) : null
}

export async function readShopifyReversalFixtureCommandInPostgres(input: {
  organizationId: unknown
  commandGlobalId: unknown
}) {
  const result = await query<CommandRow>(
    `${COMMAND_SELECT}
     WHERE command.organization_id = $1::uuid
       AND command.global_id = $2
     LIMIT 2`,
    [organizationId(input.organizationId), commandGlobalId(input.commandGlobalId)],
  )
  return mapCommand(result.rows[0])
}

export async function insertShopifyReversalFixtureCommandInPostgres(input: {
  commandGlobalId: unknown
  authority: ShopifyReversalFixtureAuthority
  phase: ShopifyReversalFixturePhase
  idempotencyKey: unknown
  intentHash: unknown
  confirmationHash: unknown
  sourceIdentifier?: string | null
  uniqueTag?: string | null
  tagFingerprint?: string | null
  fulfillmentTarget?: ShopifyReversalFixtureFulfillmentTarget | null
  fulfillmentAttemptSignature?: Record<string, unknown> | null
  fulfillmentAttemptSignatureHash?: string | null
}) {
  const globalId = commandGlobalId(input.commandGlobalId)
  const key = idempotencyKey(input.idempotencyKey)
  const intentHash = sha256(input.intentHash, 'Intent hash')
  const confirmationHash = sha256(
    input.confirmationHash,
    'Confirmation hash',
  )
  const existing = await readShopifyReversalFixtureCommandByIdempotencyInPostgres({
    organizationId: input.authority.organizationId,
    phase: input.phase,
    idempotencyKey: key,
  })
  if (existing) {
    if (
      existing.intentHash !== intentHash
      || existing.actorEmail !== input.authority.actorEmail
    ) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_IDEMPOTENCY_CONFLICT',
        'Idempotency key is already bound to a different fixture intent',
      )
    }
    return existing
  }
  const target = input.fulfillmentTarget || null
  const result = await query<CommandRow>(
    `WITH inserted AS (
       INSERT INTO public.operations_shopify_reversal_fixture_commands (
         global_id, organization_id, integration_account_id,
         phase, fixture_profile_version, prepared_by, prepared_role,
         idempotency_key, intent_hash, confirmation_hash,
         provider_write_control_row_version, credential_generation,
         granted_scope_digest, external_account_id, shop_domain,
         source_identifier, unique_tag, tag_fingerprint,
         predecessor_command_id, order_id, order_global_id,
         external_order_id, expected_order_row_version,
         released_at, provider_location_id, expected_lines,
         fulfillment_attempt_signature,
         fulfillment_attempt_signature_hash,
         expires_at
       ) VALUES (
         $1, $2::uuid, $3::uuid,
         $4, 'shopify-reversal-fixture-v1', $5, $6,
         $7, $8, $9,
         $10::bigint, $11::integer, $12, $13, $14,
         $15, $16, $17,
         $18::uuid, $19::uuid, $20,
         $21, $22::bigint,
         $23::timestamptz, $24, $25::jsonb,
         $26::jsonb, $27,
         pg_catalog.clock_timestamp() + interval '5 minutes'
       ) RETURNING *
     )
     ${COMMAND_SELECT.replace(
       'FROM public.operations_shopify_reversal_fixture_commands command',
       'FROM inserted command',
     )}`,
    [
      globalId,
      input.authority.organizationId,
      input.authority.integrationAccountId,
      input.phase,
      input.authority.actorEmail,
      input.authority.actorRole,
      key,
      intentHash,
      confirmationHash,
      input.authority.controlRowVersion,
      input.authority.credentialGeneration,
      input.authority.grantedScopeDigest,
      input.authority.externalAccountId,
      input.authority.shopDomain,
      input.sourceIdentifier || null,
      input.uniqueTag || null,
      input.tagFingerprint || null,
      target?.predecessorCommandId || null,
      target?.orderId || null,
      target?.orderGlobalId || null,
      target?.externalOrderId || null,
      target?.expectedOrderRowVersion ?? null,
      target?.releasedAt || null,
      target?.providerLocationId || null,
      target ? JSON.stringify(target.expectedLines) : null,
      input.fulfillmentAttemptSignature
        ? JSON.stringify(input.fulfillmentAttemptSignature)
        : null,
      input.fulfillmentAttemptSignatureHash || null,
    ],
  )
  const command = mapCommand(result.rows[0])
  await recordAuditEvent({
    actor: command.actorEmail,
    eventType: 'operations.shopify_reversal_fixture.prepared',
    aggregateType: 'operations.shopify_reversal_fixture_command',
    aggregateId: command.globalId,
    organizationId: command.organizationId,
    eventKey: `operations:shopify-reversal-fixture:prepared:${command.globalId}`,
    payload: {
      commandGlobalId: command.globalId,
      phase: command.phase,
      intentHash: command.intentHash,
      accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
      fixtureProfileVersion: 'shopify-reversal-fixture-v1',
      normalUiAvailable: false,
      providerWrites: 0,
    },
  })
  return command
}

type FulfillmentTargetRow = QueryResultRow & {
  predecessor_command_id: string
  predecessor_command_global_id: string
  order_id: string
  order_global_id: string
  external_order_id: string
  order_name: string
  order_row_version: string
  released_at: Date | string
  provider_location_ids: string[]
  expected_lines: Array<{ lineItemId: string; quantity: number }>
  safe: boolean
}

export async function readShopifyReversalFixtureFulfillmentTargetInPostgres(
  input: {
    organizationId: unknown
    predecessorCommandGlobalId: unknown
    orderGlobalId: unknown
  },
): Promise<ShopifyReversalFixtureFulfillmentTarget> {
  const scopedOrganizationId = organizationId(input.organizationId)
  const predecessorGlobalId = commandGlobalId(
    input.predecessorCommandGlobalId,
  )
  const scopedOrderGlobalId = orderGlobalId(input.orderGlobalId)
  const result = await query<FulfillmentTargetRow>(
    `WITH exact AS (
       SELECT predecessor.id::text AS predecessor_command_id,
              predecessor.global_id AS predecessor_command_global_id,
              source_order.id::text AS order_id,
              source_order.global_id AS order_global_id,
              source_order.external_order_id,
              source_order.order_number AS order_name,
              source_order.row_version::text AS order_row_version,
              wave.released_at,
              array_agg(DISTINCT inventory.provider_location_id) FILTER (
                WHERE inventory.provider_location_id IS NOT NULL
              ) AS provider_location_ids,
              (
                SELECT jsonb_agg(jsonb_build_object(
                  'lineItemId', line.external_line_id,
                  'quantity', line.quantity::integer
                ) ORDER BY line.external_line_id)
                FROM public.operations_current_order_lines line
                WHERE line.organization_id = source_order.organization_id
                  AND line.order_id = source_order.id
                  AND line.quantity = trunc(line.quantity)
                  AND line.quantity BETWEEN 1 AND 2147483647
              ) AS expected_lines
       FROM public.operations_shopify_reversal_fixture_commands predecessor
       JOIN public.operations_shopify_reversal_fixture_attempts predecessor_attempt
         ON predecessor_attempt.organization_id = predecessor.organization_id
        AND predecessor_attempt.command_id = predecessor.id
       JOIN public.operations_shopify_reversal_fixture_outcomes predecessor_outcome
         ON predecessor_outcome.organization_id = predecessor.organization_id
        AND predecessor_outcome.command_id = predecessor.id
        AND predecessor_outcome.attempt_id = predecessor_attempt.id
        AND predecessor_outcome.outcome_state IN (
          'succeeded', 'reconciled_applied'
        )
       JOIN public.operations_orders source_order
         ON source_order.organization_id = predecessor.organization_id
        AND source_order.integration_account_id =
              predecessor.integration_account_id
        AND source_order.external_order_id =
              predecessor_outcome.provider_order_id
       JOIN public.operations_fulfillment_plans plan
         ON plan.organization_id = source_order.organization_id
        AND plan.order_id = source_order.id
        AND plan.status = 'released'
       JOIN public.operations_pick_tasks pick
         ON pick.organization_id = plan.organization_id
        AND pick.plan_id = plan.id
       JOIN public.operations_waves wave
         ON wave.organization_id = pick.organization_id
        AND wave.id = pick.wave_id
       JOIN public.operations_fulfillment_allocations allocation
         ON allocation.organization_id = plan.organization_id
        AND allocation.plan_id = plan.id
       JOIN public.operations_reservations reservation
         ON reservation.organization_id = allocation.organization_id
        AND reservation.id = allocation.reservation_id
       JOIN public.operations_commerce_inventory_levels inventory
         ON inventory.organization_id = reservation.organization_id
        AND inventory.id = reservation.provider_inventory_level_id
        AND inventory.sync_run_id = reservation.provider_inventory_sync_run_id
       WHERE predecessor.organization_id = $1::uuid
         AND predecessor.global_id = $2
         AND predecessor.phase = 'create_order'
         AND source_order.global_id = $3
         AND source_order.status = 'released'
         AND source_order.archived_at IS NULL
         AND wave.status = 'released'
         AND wave.released_at IS NOT NULL
         AND pick.status = 'ready'
         AND COALESCE(pick.picked_quantity, 0) = 0
         AND pick.picked_at IS NULL
         AND reservation.status = 'active'
         AND reservation.reservation_authority = 'provider_commitment'
       GROUP BY predecessor.id, predecessor.global_id,
                source_order.id, source_order.global_id,
                source_order.external_order_id, source_order.order_number,
                source_order.row_version, wave.id, wave.released_at
     )
     SELECT exact.*,
            public.operations_shopify_reversal_fixture_fulfillment_is_safe(
              $1::uuid,
              exact.predecessor_command_id::uuid,
              exact.order_id::uuid,
              exact.order_row_version::bigint,
              exact.released_at,
              exact.provider_location_ids[1],
              exact.expected_lines
            ) AS safe
     FROM exact`,
    [scopedOrganizationId, predecessorGlobalId, scopedOrderGlobalId],
  )
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || row.safe !== true
    || !Array.isArray(row.expected_lines)
    || row.expected_lines.length < 1
    || !Array.isArray(row.provider_location_ids)
    || row.provider_location_ids.length !== 1
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_TARGET_UNSAFE',
      'Phase 2 requires the exact phase-1 order after ordinary import and one released, wholly-unpicked plan with zero label, shipment, export, execution, reconciliation, or billable evidence',
    )
  }
  return Object.freeze({
    predecessorCommandId: row.predecessor_command_id,
    predecessorCommandGlobalId: row.predecessor_command_global_id,
    orderId: row.order_id,
    orderGlobalId: row.order_global_id,
    externalOrderId: row.external_order_id,
    orderName: row.order_name,
    expectedOrderRowVersion: Number(row.order_row_version),
    releasedAt: timestamp(row.released_at, 'Wave release time'),
    providerLocationId: row.provider_location_ids[0],
    expectedLines: Object.freeze(row.expected_lines.map((line) => ({
      lineItemId: String(line.lineItemId),
      quantity: Number(line.quantity),
    }))),
  })
}

export async function claimShopifyReversalFixtureCommandInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  commandGlobalId: unknown
  intentHash: unknown
  confirmationStatement: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const actor = actorEmail(input.actorEmail)
  const globalId = commandGlobalId(input.commandGlobalId)
  const intentHash = sha256(input.intentHash, 'Intent hash')
  const statement = typeof input.confirmationStatement === 'string'
    ? input.confirmationStatement
    : ''
  if (!/^(?:CREATE|FULFILL) TEST ORDER [a-f0-9]{12}$/u.test(statement)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_CONFIRMATION_REQUIRED',
      'The exact short fixture confirmation is required',
      403,
    )
  }
  const confirmationHash = createHash('sha256').update(statement).digest('hex')
  return withTransaction(async (client) => {
    const commandResult = await client.query<CommandRow>(
      `${COMMAND_SELECT}
       WHERE command.organization_id = $1::uuid
         AND command.global_id = $2
       LIMIT 1
       FOR UPDATE OF command`,
      [scopedOrganizationId, globalId],
    )
    const command = mapCommand(commandResult.rows[0])
    if (
      command.actorEmail !== actor
      || command.intentHash !== intentHash
      || command.confirmationHash !== confirmationHash
      || Date.parse(command.expiresAt) <= Date.now()
    ) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_CONFIRMATION_REQUIRED',
        'The exact actor-bound, unexpired fixture intent confirmation is required',
        403,
      )
    }
    const inserted = await client.query<{
      id: string
      global_id: string
      claimed_at: Date | string
    }>(
      `INSERT INTO public.operations_shopify_reversal_fixture_attempts (
         organization_id, command_id, phase,
         claimed_by, claimed_role, intent_hash, confirmation_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7
       ) RETURNING id::text, global_id, claimed_at`,
      [
        command.organizationId,
        command.id,
        command.phase,
        actor,
        command.actorRole,
        command.intentHash,
        command.confirmationHash,
      ],
    )
    const attempt = inserted.rows[0]
    await recordAuditEvent({
      actor,
      eventType: 'operations.shopify_reversal_fixture.claimed',
      aggregateType: 'operations.shopify_reversal_fixture_command',
      aggregateId: command.globalId,
      organizationId: command.organizationId,
      eventKey: `operations:shopify-reversal-fixture:claimed:${attempt.global_id}`,
      payload: {
        commandGlobalId: command.globalId,
        attemptGlobalId: attempt.global_id,
        phase: command.phase,
        intentHash: command.intentHash,
      },
    }, client)
    return Object.freeze({
      command,
      attemptId: attempt.id,
      attemptGlobalId: attempt.global_id,
      claimedAt: timestamp(attempt.claimed_at, 'Claim time'),
    })
  })
}

export async function assertShopifyReversalFixtureClaimCurrentInPostgres(input: {
  organizationId: string
  commandId: string
  attemptId: string
  actorEmail: string
}) {
  const result = await query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.operations_shopify_reversal_fixture_commands command
       JOIN public.operations_shopify_reversal_fixture_attempts attempt
         ON attempt.organization_id = command.organization_id
        AND attempt.command_id = command.id
       WHERE command.organization_id = $1::uuid
         AND command.id = $2::uuid
         AND attempt.id = $3::uuid
         AND attempt.claimed_by = $4
         AND public.operations_shopify_reversal_fixture_database_is_trusted()
         AND public.operations_shopify_reversal_fixture_actor_is_manager(
           command.organization_id, attempt.claimed_by, attempt.claimed_role
         )
         AND public.operations_shopify_reversal_fixture_account_is_current(
           command.organization_id,
           command.integration_account_id,
           command.provider_write_control_row_version,
           command.credential_generation,
           command.granted_scope_digest,
           command.external_account_id,
           command.shop_domain
         )
         AND (
           command.phase <> 'create_fulfillment'
           OR public.operations_shopify_reversal_fixture_fulfillment_is_safe(
             command.organization_id,
             command.predecessor_command_id,
             command.order_id,
             command.expected_order_row_version,
             command.released_at,
             command.provider_location_id,
             command.expected_lines
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.operations_shopify_reversal_fixture_outcomes outcome
           WHERE outcome.organization_id = attempt.organization_id
             AND outcome.attempt_id = attempt.id
         )
     ) AS current`,
    [input.organizationId, input.commandId, input.attemptId, input.actorEmail],
  )
  if (result.rows[0]?.current !== true) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_CLAIM_STALE',
      'The fixture provider claim or its exact safety facts changed before mutation',
      409,
    )
  }
}

export async function recordShopifyReversalFixtureOutcomeInPostgres(input: {
  command: ShopifyReversalFixtureCommand
  attemptId: string
  outcomeState: ShopifyReversalFixtureOutcomeState
  providerMutationAttempted: boolean
  providerWrites: 0 | 1 | null
  providerReference?: string | null
  providerOrderId?: string | null
  providerOrderName?: string | null
  providerOrderUpdatedAt?: string | null
  errorCode?: string | null
  evidenceHash?: string | null
}) {
  const result = await query<{
    global_id: string
    outcome_state: ShopifyReversalFixtureOutcomeState
    recorded_at: Date | string
  }>(
    `INSERT INTO public.operations_shopify_reversal_fixture_outcomes (
       organization_id, command_id, attempt_id, outcome_state,
       provider_mutation_attempted, provider_writes,
       provider_reference, provider_order_id, provider_order_name,
       provider_order_updated_at, error_code, evidence_hash, recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5, $6::integer,
       $7, $8, $9, $10::timestamptz, $11, $12, $13
     ) RETURNING global_id, outcome_state, recorded_at`,
    [
      input.command.organizationId,
      input.command.id,
      input.attemptId,
      input.outcomeState,
      input.providerMutationAttempted,
      input.providerWrites,
      input.providerReference || null,
      input.providerOrderId || null,
      input.providerOrderName || null,
      input.providerOrderUpdatedAt || null,
      input.errorCode || null,
      input.evidenceHash || null,
      input.command.actorEmail,
    ],
  )
  const outcome = result.rows[0]
  await recordAuditEvent({
    actor: input.command.actorEmail,
    eventType: 'operations.shopify_reversal_fixture.outcome_recorded',
    aggregateType: 'operations.shopify_reversal_fixture_command',
    aggregateId: input.command.globalId,
    organizationId: input.command.organizationId,
    eventKey: `operations:shopify-reversal-fixture:outcome:${outcome.global_id}`,
    payload: {
      commandGlobalId: input.command.globalId,
      outcomeGlobalId: outcome.global_id,
      phase: input.command.phase,
      outcomeState: outcome.outcome_state,
      providerMutationAttempted: input.providerMutationAttempted,
      providerWrites: input.providerWrites,
      providerReference: input.providerReference || null,
      errorCode: input.errorCode || null,
    },
  })
  return Object.freeze({
    outcomeGlobalId: outcome.global_id,
    state: outcome.outcome_state,
    recordedAt: timestamp(outcome.recorded_at, 'Outcome time'),
  })
}

export async function readUnknownShopifyReversalFixtureCommandInPostgres(input: {
  organizationId: unknown
  actorEmail: unknown
  commandGlobalId: unknown
}) {
  const command = await readShopifyReversalFixtureCommandInPostgres(input)
  const actor = actorEmail(input.actorEmail)
  if (command.actorEmail !== actor) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_ACTOR_MISMATCH',
      'The original actor must reconcile this exact provider attempt',
      403,
    )
  }
  await readShopifyReversalFixtureAuthorityInPostgres({
    organizationId: command.organizationId,
    actorEmail: actor,
  })
  const result = await query<{
    attempt_id: string
    attempt_global_id: string
  }>(
    `SELECT attempt.id::text AS attempt_id,
            attempt.global_id AS attempt_global_id
     FROM public.operations_shopify_reversal_fixture_attempts attempt
     JOIN public.operations_shopify_reversal_fixture_outcomes outcome
       ON outcome.organization_id = attempt.organization_id
      AND outcome.attempt_id = attempt.id
      AND outcome.outcome_state = 'unknown'
     WHERE attempt.organization_id = $1::uuid
       AND attempt.command_id = $2::uuid
       AND NOT EXISTS (
         SELECT 1
         FROM public.operations_shopify_reversal_fixture_outcomes resolved
         WHERE resolved.organization_id = attempt.organization_id
           AND resolved.attempt_id = attempt.id
           AND resolved.outcome_state LIKE 'reconciled_%'
       )
     LIMIT 2`,
    [command.organizationId, command.id],
  )
  if (result.rows.length !== 1) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_RECONCILIATION_NOT_REQUIRED',
      'This exact fixture command has no unresolved unknown provider outcome',
    )
  }
  return Object.freeze({
    command,
    attemptId: result.rows[0].attempt_id,
    attemptGlobalId: result.rows[0].attempt_global_id,
  })
}

export async function readShopifyReversalFixtureCommandStateInPostgres(input: {
  organizationId: unknown
  commandGlobalId: unknown
}) {
  const scopedOrganizationId = organizationId(input.organizationId)
  const globalId = commandGlobalId(input.commandGlobalId)
  const result = await query<{
    phase: ShopifyReversalFixturePhase
    state: string
    attempt_global_id: string | null
    initial_outcome_global_id: string | null
    reconciliation_outcome_global_id: string | null
    provider_order_id: string | null
    provider_reference: string | null
    prepared_at: Date | string
    expires_at: Date | string
  }>(
    `SELECT phase, state, attempt_global_id,
            initial_outcome_global_id, reconciliation_outcome_global_id,
            provider_order_id, provider_reference,
            prepared_at, expires_at
     FROM public.operations_shopify_reversal_fixture_command_state
     WHERE organization_id = $1::uuid
       AND command_global_id = $2
     LIMIT 2`,
    [scopedOrganizationId, globalId],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_COMMAND_NOT_FOUND',
      'Fixture command was not found',
      404,
    )
  }
  return Object.freeze({
    commandGlobalId: globalId,
    phase: row.phase,
    state: row.state,
    attemptGlobalId: row.attempt_global_id,
    initialOutcomeGlobalId: row.initial_outcome_global_id,
    reconciliationOutcomeGlobalId: row.reconciliation_outcome_global_id,
    providerOrderId: row.provider_order_id,
    providerReference: row.provider_reference,
    preparedAt: timestamp(row.prepared_at, 'Preparation time'),
    expiresAt: timestamp(row.expires_at, 'Expiration time'),
  })
}
