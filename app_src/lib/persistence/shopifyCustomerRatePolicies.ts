import { createHash } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import {
  normalizeShopifyCustomerGid,
  normalizeShopifyCustomerRatePolicy,
  normalizeShopifyShadowPolicyLifetime,
  SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES,
  SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES,
  ShopifyCustomerRatePolicyError,
  type NormalizedShopifyCustomerRatePolicy,
  type ShopifyCustomerRatePolicyMode,
  type ShopifyShadowPolicyLifetimeMode,
  type ShopifyShadowTestChargeMode,
} from '@/lib/integrations/shopifyCustomerRatePolicy'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  readShopifyCheckoutRateControl,
  type ShopifyCheckoutRateControl,
} from '@/lib/operations/shopifyCheckoutRateControl'

export { normalizeShopifyCustomerGid }

const ORGANIZATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACCOUNT_GLOBAL_ID_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTOR_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ACTIVE_PROVIDER_WRITE_BLOCKED =
  'SHOPIFY_CUSTOMER_POLICY_PROVIDER_WRITE_UNAVAILABLE'
const ACTIVE_PROVIDER_DELETE_BLOCKED =
  'SHOPIFY_CUSTOMER_POLICY_PROVIDER_DELETE_UNAVAILABLE'

type ActivationState =
  | 'disabled'
  | 'shadow'
  | 'read_only'
  | 'active'
  | 'frozen'
  | 'missing'

export type ShopifyCustomerRatePolicyStatus =
  | 'simulated'
  | 'blocked'
  | 'enforced'
  | 'error'
  | 'removed'

export type ShopifyCustomerRatePolicyProviderState =
  | 'not_written'
  | 'write_blocked'
  | 'pending'
  | 'applied'
  | 'unknown'

export type ShopifyCustomerRatePolicy = {
  id: string
  globalId: string
  organizationId: string
  accountGlobalId: string
  customerGid: string
  mode: ShopifyCustomerRatePolicyMode
  serviceCodes: string[]
  policyHash: string
  status: ShopifyCustomerRatePolicyStatus
  providerState: ShopifyCustomerRatePolicyProviderState
  providerMetafieldGid: string | null
  providerMetafieldUpdatedAt: string | null
  lastErrorCode: string | null
  shadowLifetimeMode: ShopifyShadowPolicyLifetimeMode | null
  shadowDurationMinutes: number | null
  shadowExpiresAt: string | null
  shadowExpired: boolean
  shadowTestChargeMode: ShopifyShadowTestChargeMode
  shadowTestServiceCode: string | null
  shadowTestSubsidyReason: string | null
  rowVersion: number
  removedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ShopifyCustomerRatePolicyEnforcement = {
  activationState: ActivationState
  state: 'shadow_simulated' | 'active_blocked' | 'inactive_blocked'
  defaultPolicy: 'show_all' | 'hide_all'
  providerWriteAvailable: false
  providerWritesPerformed: 0
}

type PolicyRow = QueryResultRow & {
  id: string
  global_id: string
  organization_id: string
  account_global_id: string
  shopify_customer_gid: string
  mode: ShopifyCustomerRatePolicyMode
  service_codes: unknown
  policy_hash: string
  status: ShopifyCustomerRatePolicyStatus
  provider_state: ShopifyCustomerRatePolicyProviderState
  provider_metafield_gid: string | null
  provider_metafield_updated_at: Date | null
  last_error_code: string | null
  shadow_lifetime_mode: 'timed' | 'until_turned_off' | 'none'
  shadow_duration_minutes: string | number | null
  shadow_expires_at: Date | null
  shadow_expired: boolean
  shadow_test_charge_mode: ShopifyShadowTestChargeMode
  shadow_test_service_code: string | null
  shadow_test_subsidy_reason: string | null
  row_version: string | number
  removed_at: Date | null
  created_at: Date
  updated_at: Date
}

type AccountContextRow = QueryResultRow & {
  integration_account_id: string
  account_environment: 'mock' | 'sandbox' | 'production'
  activation_state: Exclude<ActivationState, 'missing'> | null
  policy_snapshot: Record<string, unknown>
}

type CountRow = QueryResultRow & {
  policy_count: string
  removed_count: string
  simulated_count: string
  until_turned_off_simulated_count: string
  shadow_allowed_count: string
  checkout_eligible_count: string
  expired_simulated_count: string
  blocked_count: string
  enforced_count: string
  error_count: string
  earliest_shadow_expires_at: Date | null
}

type AvailableServiceRow = QueryResultRow & {
  shopify_service_code: string
  service_name: string
  carrier_provider: 'ups_rest' | 'fedex_rest'
}

const POLICY_SELECT = `SELECT
    policy.id::text,
    policy.global_id,
    policy.organization_id::text,
    account.global_id AS account_global_id,
    policy.shopify_customer_gid,
    policy.mode,
    policy.service_codes,
    policy.policy_hash,
    policy.status,
    policy.provider_state,
    policy.provider_metafield_gid,
    policy.provider_metafield_updated_at,
    policy.last_error_code,
    policy.shadow_lifetime_mode,
    policy.shadow_duration_minutes::text,
    policy.shadow_expires_at,
    policy.shadow_test_charge_mode,
    policy.shadow_test_service_code,
    policy.shadow_test_subsidy_reason,
    (
      policy.status = 'simulated'
      AND NOT (
        (
          policy.shadow_lifetime_mode = 'timed'
          AND policy.shadow_duration_minutes BETWEEN 15 AND 240
          AND policy.shadow_expires_at > now()
        )
        OR (
          policy.shadow_lifetime_mode = 'until_turned_off'
          AND policy.shadow_duration_minutes IS NULL
          AND policy.shadow_expires_at IS NULL
        )
      )
    ) AS shadow_expired,
    policy.row_version::text,
    policy.removed_at,
    policy.created_at,
    policy.updated_at
  FROM operations_shopify_customer_rate_policies policy
  JOIN operations_integration_accounts account
    ON account.organization_id = policy.organization_id
   AND account.id = policy.integration_account_id`

export class ShopifyCustomerRatePolicyPersistenceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ShopifyCustomerRatePolicyPersistenceError'
    this.code = code
    this.status = status
  }
}

function normalizedOrganizationId(value: unknown) {
  const organizationId = String(value || '').trim().toLowerCase()
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ORGANIZATION_INVALID',
      'A valid active organization is required',
    )
  }
  return organizationId
}

function normalizedAccountGlobalId(value: unknown) {
  const accountGlobalId = String(value || '').trim().toLowerCase()
  if (!ACCOUNT_GLOBAL_ID_PATTERN.test(accountGlobalId)) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ACCOUNT_INVALID',
      'A valid Shopify connection is required',
    )
  }
  return accountGlobalId
}

function normalizedActorEmail(value: unknown) {
  const actorEmail = String(value || '').trim().toLowerCase()
  if (
    actorEmail.length > 320
    || !ACTOR_EMAIL_PATTERN.test(actorEmail)
    || /[\u0000-\u001f\u007f]/.test(actorEmail)
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ACTOR_INVALID',
      'A valid policy actor is required',
    )
  }
  return actorEmail
}

function positiveInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  const candidate = value === null || value === undefined || value === ''
    ? fallback
    : Number(value)
  if (
    !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_PAGINATION_INVALID',
      `${label} is invalid`,
    )
  }
  return candidate
}

function expectedRowVersion(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return positiveInteger(value, 1, 1, Number.MAX_SAFE_INTEGER, 'row version')
}

function safeCount(value: string | number | null | undefined) {
  const count = Number(value || 0)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function iso(value: Date | null) {
  return value ? new Date(value).toISOString() : null
}

function serviceCodes(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string')
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_STORED_VALUE_INVALID',
      'Stored Shopify customer rate policy is invalid',
      500,
    )
  }
  return value as string[]
}

function storedShadowDurationMinutes(
  value: string | number | null,
): number | null {
  if (value === null) return null
  const minutes = Number(value)
  if (
    !Number.isSafeInteger(minutes)
    || minutes < SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES
    || minutes > SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_STORED_VALUE_INVALID',
      'Stored Shopify customer rate policy is invalid',
      500,
    )
  }
  return minutes
}

function storedShadowLifetime(row: PolicyRow) {
  const lifetimeMode = row.shadow_lifetime_mode
  const durationMinutes = storedShadowDurationMinutes(
    row.shadow_duration_minutes,
  )
  const expiresAt = iso(row.shadow_expires_at)
  const valid = lifetimeMode === 'timed'
    ? durationMinutes !== null && expiresAt !== null
    : lifetimeMode === 'until_turned_off'
      ? durationMinutes === null && expiresAt === null
      : lifetimeMode === 'none'
        ? durationMinutes === null && expiresAt === null
        : false
  if (!valid) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_STORED_VALUE_INVALID',
      'Stored Shopify customer rate policy is invalid',
      500,
    )
  }
  return {
    lifetimeMode: lifetimeMode === 'none' ? null : lifetimeMode,
    durationMinutes,
    expiresAt,
  }
}

function policy(row: PolicyRow): ShopifyCustomerRatePolicy {
  const shadowLifetime = storedShadowLifetime(row)
  let normalizedPolicy: NormalizedShopifyCustomerRatePolicy
  try {
    normalizedPolicy = normalizeShopifyCustomerRatePolicy({
      mode: row.mode,
      serviceCodes: serviceCodes(row.service_codes),
      shadowTestChargeMode: row.shadow_test_charge_mode,
      shadowTestServiceCode: row.shadow_test_service_code,
      shadowTestSubsidyReason: row.shadow_test_subsidy_reason,
    })
  } catch {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_STORED_VALUE_INVALID',
      'Stored Shopify customer rate policy is invalid',
      500,
    )
  }
  return {
    id: row.id,
    globalId: row.global_id,
    organizationId: row.organization_id,
    accountGlobalId: row.account_global_id,
    customerGid: row.shopify_customer_gid,
    mode: normalizedPolicy.mode,
    serviceCodes: normalizedPolicy.serviceCodes,
    policyHash: row.policy_hash,
    status: row.status,
    providerState: row.provider_state,
    providerMetafieldGid: row.provider_metafield_gid,
    providerMetafieldUpdatedAt: iso(row.provider_metafield_updated_at),
    lastErrorCode: row.last_error_code,
    shadowLifetimeMode: shadowLifetime.lifetimeMode,
    shadowDurationMinutes: shadowLifetime.durationMinutes,
    shadowExpiresAt: shadowLifetime.expiresAt,
    shadowExpired: row.shadow_expired === true,
    shadowTestChargeMode: normalizedPolicy.shadowTestChargeMode,
    shadowTestServiceCode: normalizedPolicy.shadowTestServiceCode,
    shadowTestSubsidyReason: normalizedPolicy.shadowTestSubsidyReason,
    rowVersion: safeCount(row.row_version),
    removedAt: iso(row.removed_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function policyHash(
  value: NormalizedShopifyCustomerRatePolicy,
  shadowLifetimeMode: ShopifyShadowPolicyLifetimeMode | null,
  shadowDurationMinutes: number | null,
) {
  return createHash('sha256')
    .update(JSON.stringify({
      version: value.version,
      mode: value.mode,
      serviceCodes: value.serviceCodes,
      shadowLifetimeMode,
      shadowDurationMinutes,
      shadowTestChargeMode: value.shadowTestChargeMode,
      shadowTestServiceCode: value.shadowTestServiceCode,
      shadowTestSubsidyReason: value.shadowTestSubsidyReason,
    }), 'utf8')
    .digest('hex')
}

function enforcement(
  activationState: ActivationState,
  checkoutRateControl: ShopifyCheckoutRateControl,
): ShopifyCustomerRatePolicyEnforcement {
  const shadow = activationState === 'shadow'
  return {
    activationState,
    state: shadow
      ? 'shadow_simulated'
      : activationState === 'active'
        ? 'active_blocked'
        : 'inactive_blocked',
    defaultPolicy: checkoutRateControl.audience === 'all_eligible'
      ? 'show_all'
      : 'hide_all',
    providerWriteAvailable: false,
    providerWritesPerformed: 0,
  }
}

function assertLocalPolicyMutationAllowed(activationState: ActivationState) {
  if (activationState === 'missing') {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ACTIVATION_MISSING',
      'Operations safety state is unavailable for this customer policy',
      409,
    )
  }
}

function checkoutPolicyUsesProofLane(
  control: ShopifyCheckoutRateControl,
  accountEnvironment: 'mock' | 'sandbox' | 'production',
) {
  return control.audience === 'restricted_customers'
    && control.rateSource === 'sandbox'
    && accountEnvironment !== 'production'
}

async function accountContext(
  client: PoolClient | null,
  input: { organizationId: string; accountGlobalId: string },
) {
  const run = <T extends QueryResultRow>(sql: string, values: unknown[]) => (
    client ? client.query<T>(sql, values) : query<T>(sql, values)
  )
  const result = await run<AccountContextRow>(
    `SELECT
       account.id::text AS integration_account_id,
       account.environment AS account_environment,
       activation.state AS activation_state,
       config.policy_snapshot
     FROM operations_integration_accounts account
     LEFT JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     JOIN operations_shopify_carrier_service_configs config
       ON config.organization_id = account.organization_id
      AND config.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ACCOUNT_NOT_FOUND',
      'The Shopify connection was not found in the active organization',
      404,
    )
  }
  return {
    integrationAccountId: row.integration_account_id,
    accountEnvironment: row.account_environment,
    activationState: row.activation_state || 'missing' as ActivationState,
    checkoutRateControl: readShopifyCheckoutRateControl(
      row.policy_snapshot,
      {
        activationState: row.activation_state || 'disabled',
        accountEnvironment: row.account_environment,
      },
    ),
  }
}

async function currentPolicy(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    customerGid: string
  },
) {
  const result = await client.query<PolicyRow>(
    `${POLICY_SELECT}
     WHERE policy.organization_id = $1::uuid
       AND policy.integration_account_id = $2::uuid
       AND policy.shopify_customer_gid = $3
     FOR UPDATE OF policy`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.customerGid,
    ],
  )
  return result.rows[0] || null
}

function assertLocallyMutable(row: PolicyRow | null) {
  if (
    row
    && !['not_written', 'write_blocked'].includes(row.provider_state)
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_PROVIDER_RECONCILIATION_REQUIRED',
      'This customer policy has provider state that must be reconciled before it can change',
      409,
    )
  }
}

function assertExpectedVersion(
  row: PolicyRow | null,
  expected: number | null,
  options: { requireForCurrent: boolean },
) {
  if (row && expected === null && options.requireForCurrent) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_ROW_VERSION_REQUIRED',
      'Refresh this customer policy before changing it',
      409,
    )
  }
  if (
    (row && expected !== null && safeCount(row.row_version) !== expected)
    || (!row && expected !== null)
  ) {
    throw new ShopifyCustomerRatePolicyPersistenceError(
      'SHOPIFY_CUSTOMER_POLICY_STALE',
      'This customer policy changed; refresh it before trying again',
      409,
    )
  }
}

export async function listShopifyCustomerRatePoliciesFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  page?: unknown
  pageSize?: unknown
  includeRemoved?: boolean
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const page = positiveInteger(input.page, 1, 1, 1_000_000, 'page')
  const pageSize = positiveInteger(input.pageSize, 25, 1, 100, 'page size')
  const context = await accountContext(null, {
    organizationId,
    accountGlobalId,
  })
  const removedFilter = input.includeRemoved
    ? ''
    : "AND policy.status <> 'removed'"
  const [countResult, policyResult] = await Promise.all([
    query<QueryResultRow & { total: string }>(
      `SELECT count(*)::text AS total
       FROM operations_shopify_customer_rate_policies policy
       WHERE policy.organization_id = $1::uuid
         AND policy.integration_account_id = $2::uuid
         ${removedFilter}`,
      [organizationId, context.integrationAccountId],
    ),
    query<PolicyRow>(
      `${POLICY_SELECT}
       WHERE policy.organization_id = $1::uuid
         AND policy.integration_account_id = $2::uuid
         ${removedFilter}
       ORDER BY policy.updated_at DESC, policy.global_id
       LIMIT $3 OFFSET $4`,
      [
        organizationId,
        context.integrationAccountId,
        pageSize,
        (page - 1) * pageSize,
      ],
    ),
  ])
  const total = safeCount(countResult.rows[0]?.total)
  return {
    policies: policyResult.rows.map(policy),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
    enforcement: enforcement(
      context.activationState,
      context.checkoutRateControl,
    ),
  }
}

export async function readShopifyCustomerRatePolicyFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  customerGid: unknown
  includeRemoved?: boolean
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const customerGid = normalizeShopifyCustomerGid(input.customerGid)
  const context = await accountContext(null, {
    organizationId,
    accountGlobalId,
  })
  const removedFilter = input.includeRemoved
    ? ''
    : "AND policy.status <> 'removed'"
  const result = await query<PolicyRow>(
    `${POLICY_SELECT}
     WHERE policy.organization_id = $1::uuid
       AND policy.integration_account_id = $2::uuid
       AND policy.shopify_customer_gid = $3
       ${removedFilter}
     LIMIT 1`,
    [organizationId, context.integrationAccountId, customerGid],
  )
  return result.rows[0] ? policy(result.rows[0]) : null
}

export async function upsertShopifyCustomerRatePolicyInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  customerGid: unknown
  mode: unknown
  serviceCodes: unknown
  shadowLifetimeMode?: unknown
  shadowDurationMinutes?: unknown
  shadowTestChargeMode?: unknown
  shadowTestServiceCode?: unknown
  shadowTestSubsidyReason?: unknown
  expectedRowVersion?: unknown
  actorEmail: unknown
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const customerGid = normalizeShopifyCustomerGid(input.customerGid)
  const normalizedPolicy = normalizeShopifyCustomerRatePolicy({
    mode: input.mode,
    serviceCodes: input.serviceCodes,
    shadowTestChargeMode: input.shadowTestChargeMode,
    shadowTestServiceCode: input.shadowTestServiceCode,
    shadowTestSubsidyReason: input.shadowTestSubsidyReason,
  })
  const requestedShadowLifetime = normalizeShopifyShadowPolicyLifetime({
    shadowLifetimeMode: input.shadowLifetimeMode,
    shadowDurationMinutes: input.shadowDurationMinutes,
  })
  const shadowLifetimeIsExplicit = input.shadowLifetimeMode !== undefined
    && input.shadowLifetimeMode !== null
    && input.shadowLifetimeMode !== ''
  const expected = expectedRowVersion(input.expectedRowVersion)
  const actorEmail = normalizedActorEmail(input.actorEmail)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:activation:${organizationId}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-customer-policy:${organizationId}:${accountGlobalId}:${customerGid}`,
    )
    const context = await accountContext(client, {
      organizationId,
      accountGlobalId,
    })
    assertLocalPolicyMutationAllowed(context.activationState)
    const current = await currentPolicy(client, {
      organizationId,
      integrationAccountId: context.integrationAccountId,
      customerGid,
    })
    assertLocallyMutable(current)
    assertExpectedVersion(current, expected, {
      requireForCurrent: current?.status !== 'removed',
    })

    const testLane = checkoutPolicyUsesProofLane(
      context.checkoutRateControl,
      context.accountEnvironment,
    )
    if (testLane && current && !shadowLifetimeIsExplicit) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_SHADOW_POLICY_LIFETIME_REQUIRED',
        'Choose timed or until turned off when updating an existing TEST customer policy',
      )
    }
    if (
      !testLane
      && normalizedPolicy.shadowTestChargeMode !== 'carrier_rate'
    ) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CHECKOUT_TEST_SUBSIDY_REQUIRES_TEST_SOURCE',
        'A zero checkout test charge requires the Restricted TEST rate source',
        409,
      )
    }
    const shadowLifetimeMode = testLane
      ? requestedShadowLifetime.shadowLifetimeMode
      : null
    const shadowDurationMinutes = testLane
      ? requestedShadowLifetime.shadowDurationMinutes
      : null
    const hash = policyHash(
      normalizedPolicy,
      shadowLifetimeMode,
      shadowDurationMinutes,
    )
    const status: ShopifyCustomerRatePolicyStatus = testLane
      ? 'simulated'
      : 'blocked'
    const providerState: ShopifyCustomerRatePolicyProviderState = testLane
      ? 'not_written'
      : 'write_blocked'
    const lastErrorCode = testLane
      ? null
      : ACTIVE_PROVIDER_WRITE_BLOCKED
    let writeSucceeded = false
    if (current) {
      const result = await client.query<PolicyRow>(
        `UPDATE operations_shopify_customer_rate_policies
         SET mode = $4,
             service_codes = $5::jsonb,
             policy_hash = $6,
             status = $7,
             provider_state = $8,
             provider_metafield_gid = NULL,
             provider_metafield_updated_at = NULL,
             last_error_code = $9,
             shadow_lifetime_mode = $10,
             shadow_duration_minutes = $11::smallint,
             shadow_expires_at = CASE
               WHEN $10 = 'timed'
                 THEN now() + ($11::integer * interval '1 minute')
               ELSE NULL
             END,
             shadow_test_charge_mode = $12,
             shadow_test_service_code = $13,
             shadow_test_subsidy_reason = $14,
             removed_at = NULL,
             row_version = row_version + 1,
             updated_by = $15,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND shopify_customer_gid = $3
           AND row_version = $16::bigint
         RETURNING id::text`,
        [
          organizationId,
          context.integrationAccountId,
          customerGid,
          normalizedPolicy.mode,
          JSON.stringify(normalizedPolicy.serviceCodes),
          hash,
          status,
          providerState,
          lastErrorCode,
          shadowLifetimeMode || 'none',
          shadowDurationMinutes,
          normalizedPolicy.shadowTestChargeMode,
          normalizedPolicy.shadowTestServiceCode,
          normalizedPolicy.shadowTestSubsidyReason,
          actorEmail,
          safeCount(current.row_version),
        ],
      )
      writeSucceeded = Boolean(result.rows[0])
    } else {
      const result = await client.query<PolicyRow>(
        `INSERT INTO operations_shopify_customer_rate_policies (
           organization_id, integration_account_id, shopify_customer_gid,
           mode, service_codes, policy_hash, status, provider_state,
           last_error_code, shadow_lifetime_mode,
           shadow_duration_minutes, shadow_expires_at,
           shadow_test_charge_mode, shadow_test_service_code,
           shadow_test_subsidy_reason,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9,
           $10, $11::smallint,
           CASE
             WHEN $10 = 'timed'
               THEN now() + ($11::integer * interval '1 minute')
             ELSE NULL
           END,
           $12, $13, $14, $15, $15
         )
         RETURNING id::text`,
        [
          organizationId,
          context.integrationAccountId,
          customerGid,
          normalizedPolicy.mode,
          JSON.stringify(normalizedPolicy.serviceCodes),
          hash,
          status,
          providerState,
          lastErrorCode,
          shadowLifetimeMode || 'none',
          shadowDurationMinutes,
          normalizedPolicy.shadowTestChargeMode,
          normalizedPolicy.shadowTestServiceCode,
          normalizedPolicy.shadowTestSubsidyReason,
          actorEmail,
        ],
      )
      writeSucceeded = Boolean(result.rows[0])
    }
    if (!writeSucceeded) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CUSTOMER_POLICY_STALE',
        'This customer policy changed; refresh it before trying again',
        409,
      )
    }
    const stored = await currentPolicy(client, {
      organizationId,
      integrationAccountId: context.integrationAccountId,
      customerGid,
    })
    if (!stored) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CUSTOMER_POLICY_WRITE_FAILED',
        'Shopify customer rate policy could not be stored',
        500,
      )
    }
    return {
      policy: policy(stored),
      enforcement: enforcement(
        context.activationState,
        context.checkoutRateControl,
      ),
    }
  })
}

export async function removeShopifyCustomerRatePolicyInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  customerGid: unknown
  expectedRowVersion?: unknown
  actorEmail: unknown
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const customerGid = normalizeShopifyCustomerGid(input.customerGid)
  const expected = expectedRowVersion(input.expectedRowVersion)
  const actorEmail = normalizedActorEmail(input.actorEmail)

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `operations:activation:${organizationId}`,
    )
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-customer-policy:${organizationId}:${accountGlobalId}:${customerGid}`,
    )
    const context = await accountContext(client, {
      organizationId,
      accountGlobalId,
    })
    assertLocalPolicyMutationAllowed(context.activationState)
    const current = await currentPolicy(client, {
      organizationId,
      integrationAccountId: context.integrationAccountId,
      customerGid,
    })
    if (!current) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CUSTOMER_POLICY_NOT_FOUND',
        'The Shopify customer rate policy was not found',
        404,
      )
    }
    assertLocallyMutable(current)
    assertExpectedVersion(current, expected, { requireForCurrent: true })
    if (current.status === 'removed') {
      return {
        removed: true,
        customerGid,
        policy: policy(current),
        enforcement: enforcement(
          context.activationState,
          context.checkoutRateControl,
        ),
      }
    }
    const testLane = checkoutPolicyUsesProofLane(
      context.checkoutRateControl,
      context.accountEnvironment,
    )
    const providerState: ShopifyCustomerRatePolicyProviderState = testLane
      ? 'not_written'
      : 'write_blocked'
    const lastErrorCode = testLane
      ? null
      : ACTIVE_PROVIDER_DELETE_BLOCKED
    const currentPolicyValue = policy(current)
    const removedPolicyHash = policyHash(
      {
        version: 2,
        mode: currentPolicyValue.mode,
        serviceCodes: currentPolicyValue.serviceCodes,
        shadowTestChargeMode: 'carrier_rate',
        shadowTestServiceCode: null,
        shadowTestSubsidyReason: null,
      },
      testLane ? currentPolicyValue.shadowLifetimeMode : null,
      testLane ? currentPolicyValue.shadowDurationMinutes : null,
    )
    const result = await client.query<PolicyRow>(
      `UPDATE operations_shopify_customer_rate_policies
       SET status = 'removed',
           provider_state = $4,
           provider_metafield_gid = NULL,
           provider_metafield_updated_at = NULL,
           last_error_code = $5,
           shadow_lifetime_mode = CASE
             WHEN $4 = 'not_written' THEN shadow_lifetime_mode
             ELSE 'none'
           END,
           shadow_duration_minutes = CASE
             WHEN $4 = 'not_written' THEN shadow_duration_minutes
             ELSE NULL
           END,
           shadow_expires_at = CASE
             WHEN $4 = 'not_written' THEN shadow_expires_at
             ELSE NULL
           END,
           shadow_test_charge_mode = 'carrier_rate',
           shadow_test_service_code = NULL,
           shadow_test_subsidy_reason = NULL,
           policy_hash = $6,
           removed_at = now(),
           row_version = row_version + 1,
           updated_by = $7,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND shopify_customer_gid = $3
         AND row_version = $8::bigint
       RETURNING id::text`,
      [
        organizationId,
        context.integrationAccountId,
        customerGid,
        providerState,
        lastErrorCode,
        removedPolicyHash,
        actorEmail,
        safeCount(current.row_version),
      ],
    )
    if (!result.rows[0]) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CUSTOMER_POLICY_STALE',
        'This customer policy changed; refresh it before trying again',
        409,
      )
    }
    const removed = await currentPolicy(client, {
      organizationId,
      integrationAccountId: context.integrationAccountId,
      customerGid,
    })
    if (!removed) {
      throw new ShopifyCustomerRatePolicyPersistenceError(
        'SHOPIFY_CUSTOMER_POLICY_WRITE_FAILED',
        'Shopify customer rate policy could not be removed',
        500,
      )
    }
    return {
      removed: true,
      customerGid,
      policy: policy(removed),
      enforcement: enforcement(
        context.activationState,
        context.checkoutRateControl,
      ),
    }
  })
}

export async function readActiveShopifyCustomerRatePolicyFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  shopifyCustomerGid: unknown
}): Promise<ShopifyCustomerRatePolicy | null> {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const customerGid = normalizeShopifyCustomerGid(input.shopifyCustomerGid)
  const result = await query<PolicyRow>(
    `${POLICY_SELECT}
     JOIN operations_activation_scopes activation
       ON activation.organization_id = policy.organization_id
     WHERE policy.organization_id = $1::uuid
       AND account.global_id = $2
       AND policy.shopify_customer_gid = $3
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND (
         (
           activation.state = 'shadow'
           AND policy.status = 'simulated'
           AND policy.provider_state = 'not_written'
           AND (
             (
               policy.shadow_lifetime_mode = 'timed'
               AND policy.shadow_duration_minutes BETWEEN 15 AND 240
               AND policy.shadow_expires_at > now()
             )
             OR (
               policy.shadow_lifetime_mode = 'until_turned_off'
               AND policy.shadow_duration_minutes IS NULL
               AND policy.shadow_expires_at IS NULL
             )
           )
         )
         OR (
           activation.state = 'active'
           AND policy.status = 'enforced'
           AND policy.provider_state = 'applied'
         )
       )
     LIMIT 1`,
    [organizationId, accountGlobalId, customerGid],
  )
  return result.rows[0] ? policy(result.rows[0]) : null
}

/**
 * Read the exact local customer policy used by checkout rating.
 *
 * Checkout rating is a local read-only decision, but it must match the exact
 * current account control. Only a bounded simulated policy on a non-production
 * Shopify store can authorize the Restricted proof lane. A blocked desired
 * LIVE policy never authorizes a callback.
 */
export async function readShopifyCheckoutCustomerRatePolicyFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
  shopifyCustomerGid: unknown
}): Promise<ShopifyCustomerRatePolicy | null> {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const customerGid = normalizeShopifyCustomerGid(input.shopifyCustomerGid)
  const result = await query<PolicyRow>(
    `${POLICY_SELECT}
     JOIN operations_shopify_carrier_service_configs config
       ON config.organization_id = policy.organization_id
      AND config.integration_account_id = policy.integration_account_id
     WHERE policy.organization_id = $1::uuid
       AND account.global_id = $2
       AND policy.shopify_customer_gid = $3
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.environment <> 'production'
       AND config.policy_snapshot #>> '{checkoutRateControl,audience}'
         = 'restricted_customers'
       AND config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
         = 'sandbox'
       AND policy.status = 'simulated'
       AND policy.provider_state = 'not_written'
       AND (
         (
           policy.shadow_lifetime_mode = 'timed'
           AND policy.shadow_duration_minutes BETWEEN 15 AND 240
           AND policy.shadow_expires_at > now()
         )
         OR (
           policy.shadow_lifetime_mode = 'until_turned_off'
           AND policy.shadow_duration_minutes IS NULL
           AND policy.shadow_expires_at IS NULL
         )
       )
     LIMIT 1`,
    [organizationId, accountGlobalId, customerGid],
  )
  return result.rows[0] ? policy(result.rows[0]) : null
}

export async function readShopifyCustomerRatePolicySummaryFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const context = await accountContext(null, {
    organizationId,
    accountGlobalId,
  })
  const result = await query<CountRow>(
    `SELECT
       count(*) FILTER (WHERE status <> 'removed')::text AS policy_count,
       count(*) FILTER (WHERE status = 'removed')::text AS removed_count,
       count(*) FILTER (
         WHERE status = 'simulated'
           AND provider_state = 'not_written'
           AND (
             (
               shadow_lifetime_mode = 'timed'
               AND shadow_duration_minutes BETWEEN 15 AND 240
               AND shadow_expires_at > now()
             )
             OR (
               shadow_lifetime_mode = 'until_turned_off'
               AND shadow_duration_minutes IS NULL
               AND shadow_expires_at IS NULL
             )
           )
       )::text AS simulated_count,
       count(*) FILTER (
         WHERE status = 'simulated'
           AND provider_state = 'not_written'
           AND shadow_lifetime_mode = 'until_turned_off'
           AND shadow_duration_minutes IS NULL
           AND shadow_expires_at IS NULL
       )::text AS until_turned_off_simulated_count,
       count(*) FILTER (
         WHERE status = 'simulated'
           AND provider_state = 'not_written'
           AND (
             (
               shadow_lifetime_mode = 'timed'
               AND shadow_duration_minutes BETWEEN 15 AND 240
               AND shadow_expires_at > now()
             )
             OR (
               shadow_lifetime_mode = 'until_turned_off'
               AND shadow_duration_minutes IS NULL
               AND shadow_expires_at IS NULL
             )
           )
           AND mode <> 'hide_all'
       )::text AS shadow_allowed_count,
       count(*) FILTER (
         WHERE $3::boolean
           AND mode <> 'hide_all'
           AND status = 'simulated'
           AND provider_state = 'not_written'
           AND (
             (
               shadow_lifetime_mode = 'timed'
               AND shadow_duration_minutes BETWEEN 15 AND 240
               AND shadow_expires_at > now()
             )
             OR (
               shadow_lifetime_mode = 'until_turned_off'
               AND shadow_duration_minutes IS NULL
               AND shadow_expires_at IS NULL
             )
           )
       )::text AS checkout_eligible_count,
       count(*) FILTER (
         WHERE status = 'simulated'
           AND NOT (
             (
               shadow_lifetime_mode = 'timed'
               AND shadow_duration_minutes BETWEEN 15 AND 240
               AND shadow_expires_at > now()
             )
             OR (
               shadow_lifetime_mode = 'until_turned_off'
               AND shadow_duration_minutes IS NULL
               AND shadow_expires_at IS NULL
             )
           )
       )::text AS expired_simulated_count,
       count(*) FILTER (WHERE status = 'blocked')::text AS blocked_count,
       count(*) FILTER (WHERE status = 'enforced')::text AS enforced_count,
       count(*) FILTER (WHERE status = 'error')::text AS error_count,
       min(shadow_expires_at) FILTER (
         WHERE status = 'simulated'
           AND shadow_lifetime_mode = 'timed'
           AND shadow_expires_at > now()
       ) AS earliest_shadow_expires_at
     FROM operations_shopify_customer_rate_policies
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [
      organizationId,
      context.integrationAccountId,
      checkoutPolicyUsesProofLane(
        context.checkoutRateControl,
        context.accountEnvironment,
      ),
    ],
  )
  const row = result.rows[0]
  return {
    policyCount: safeCount(row?.policy_count),
    removedCount: safeCount(row?.removed_count),
    simulatedCount: safeCount(row?.simulated_count),
    untilTurnedOffSimulatedCount: safeCount(
      row?.until_turned_off_simulated_count,
    ),
    shadowAllowedCount: safeCount(row?.shadow_allowed_count),
    checkoutEligibleCount: safeCount(row?.checkout_eligible_count),
    expiredSimulatedCount: safeCount(row?.expired_simulated_count),
    blockedCount: safeCount(row?.blocked_count),
    enforcedCount: safeCount(row?.enforced_count),
    errorCount: safeCount(row?.error_count),
    earliestShadowExpiresAt: iso(row?.earliest_shadow_expires_at || null),
    enforcement: enforcement(
      context.activationState,
      context.checkoutRateControl,
    ),
  }
}

export async function hasAnyShopifyCustomerRatePoliciesInPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const summary = await readShopifyCustomerRatePolicySummaryFromPostgres(input)
  return summary.policyCount > 0
}

export async function readAvailableShopifyCheckoutServicesFromPostgres(input: {
  organizationId: unknown
  accountGlobalId: unknown
}) {
  const organizationId = normalizedOrganizationId(input.organizationId)
  const accountGlobalId = normalizedAccountGlobalId(input.accountGlobalId)
  const result = await query<AvailableServiceRow>(
    `SELECT
       latest.shopify_service_code,
       latest.service_name,
       latest.carrier_provider
     FROM (
       SELECT DISTINCT ON (offer.shopify_service_code)
         offer.shopify_service_code,
         offer.service_name,
         offer.carrier_provider,
         receipt.completed_at
       FROM operations_shopify_checkout_rate_receipt_offers offer
       JOIN operations_shopify_checkout_rate_receipts receipt
         ON receipt.organization_id = offer.organization_id
        AND receipt.id = offer.receipt_id
       JOIN operations_integration_accounts account
         ON account.organization_id = receipt.organization_id
        AND account.id = receipt.integration_account_id
       WHERE receipt.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND receipt.status = 'succeeded'
       ORDER BY
         offer.shopify_service_code,
         receipt.completed_at DESC NULLS LAST,
         receipt.id DESC
     ) latest
     ORDER BY latest.shopify_service_code
     LIMIT 101`,
    [organizationId, accountGlobalId],
  )
  return {
    availableServices: result.rows.slice(0, 100).map((row) => ({
      shopifyServiceCode: row.shopify_service_code,
      serviceName: row.service_name,
      provider: row.carrier_provider,
    })),
    availableServicesTruncated: result.rows.length > 100,
  }
}

export function customerRatePolicyError(error: unknown) {
  if (
    error instanceof ShopifyCustomerRatePolicyPersistenceError
    || error instanceof ShopifyCustomerRatePolicyError
  ) return error
  return new ShopifyCustomerRatePolicyPersistenceError(
    'SHOPIFY_CUSTOMER_POLICY_INTERNAL_ERROR',
    'Shopify customer rate policy request failed',
    500,
  )
}
