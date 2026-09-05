import type { PoolClient } from 'pg'

export type CommerceOrderHistoryAdmissionProvider = 'shopify' | 'faire'

export type CommerceOrderHistoryAdmission = Readonly<{
  admitted: boolean
  knownProviderIdentity: boolean
  ingestionFloor: string | null
  reason:
    | 'known_provider_identity'
    | 'within_frozen_floor'
    | 'provider_all'
    | 'before_frozen_floor'
    | 'provider_created_at_required'
    | 'policy_missing'
}>

export function commerceOrderIntakeIdentityLockKey(input: {
  organizationId: string
  integrationAccountId: string
  externalOrderId: string
}) {
  return [
    'commerce-intake-order-identity-v1',
    input.organizationId,
    input.integrationAccountId,
    input.externalOrderId,
  ].join(':')
}

export function commerceOrderObservationLockKey(input: {
  organizationId: string
  integrationAccountId: string
  provider: CommerceOrderHistoryAdmissionProvider
  externalOrderId: string
}) {
  return `commerce-order-observation:${input.organizationId}`
    + `:${input.integrationAccountId}:${input.provider}`
    + `:${input.externalOrderId}`
}

/**
 * Every order-admission path takes the intake identity lock first and the
 * observation lock second. This makes the frozen floor decision atomic with
 * canonical/candidate/observation materialization without introducing a
 * webhook/manual/scheduled lock-order cycle.
 */
export async function lockCommerceOrderHistoryAdmissionWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceOrderHistoryAdmissionProvider
    externalOrderId: string
  },
) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [commerceOrderIntakeIdentityLockKey(input)],
  )
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [commerceOrderObservationLockKey(input)],
  )
}

/**
 * The frozen floor governs first materialization only. A provider identity
 * already retained by ClawPilot must continue to receive exact revisions,
 * external-fulfillment state, line changes, returns, and tracking updates.
 */
export async function assessCommerceOrderHistoryAdmissionWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceOrderHistoryAdmissionProvider
    externalOrderId: string
    providerCreatedAt: string | null
    locksHeld?: boolean
  },
): Promise<CommerceOrderHistoryAdmission> {
  if (!input.locksHeld) {
    await lockCommerceOrderHistoryAdmissionWithClient(client, input)
  }
  const row = (
    await client.query<{
      ingestion_floor: Date | null
      policy_present: boolean
      known_provider_identity: boolean
    }>(
      `SELECT
         history.ingestion_floor,
         (history.integration_account_id IS NOT NULL) AS policy_present,
         (
           EXISTS (
             SELECT 1
             FROM operations_orders canonical
             WHERE canonical.organization_id = $1::uuid
               AND canonical.integration_account_id = $2::uuid
               AND canonical.source_provider = $3
               AND canonical.external_order_id = $4
           )
           OR EXISTS (
             SELECT 1
             FROM operations_external_identifiers external
             WHERE external.organization_id = $1::uuid
               AND external.integration_account_id = $2::uuid
               AND external.entity_type = 'operations.order'
               AND external.external_id = $4
           )
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_candidates candidate
             WHERE candidate.organization_id = $1::uuid
               AND candidate.integration_account_id = $2::uuid
               AND candidate.provider = $3
               AND candidate.external_order_id = $4
           )
           OR EXISTS (
             SELECT 1
             FROM operations_commerce_order_observations observation
             WHERE observation.organization_id = $1::uuid
               AND observation.integration_account_id = $2::uuid
               AND observation.provider = $3
               AND observation.external_order_id = $4
           )
         ) AS known_provider_identity
       FROM (SELECT 1) singleton
       LEFT JOIN operations_commerce_order_history_policies history
         ON history.organization_id = $1::uuid
        AND history.integration_account_id = $2::uuid
        AND history.provider = $3
       LIMIT 1`,
      [
        input.organizationId,
        input.integrationAccountId,
        input.provider,
        input.externalOrderId,
      ],
    )
  ).rows[0]
  if (!row?.policy_present) {
    return Object.freeze({
      admitted: false,
      knownProviderIdentity: false,
      ingestionFloor: null,
      reason: 'policy_missing',
    })
  }
  const ingestionFloor = row.ingestion_floor?.toISOString() || null
  if (row.known_provider_identity) {
    return Object.freeze({
      admitted: true,
      knownProviderIdentity: true,
      ingestionFloor,
      reason: 'known_provider_identity',
    })
  }
  if (!row.ingestion_floor) {
    return Object.freeze({
      admitted: true,
      knownProviderIdentity: false,
      ingestionFloor: null,
      reason: 'provider_all',
    })
  }
  const providerCreatedAt = input.providerCreatedAt
    ? new Date(input.providerCreatedAt).getTime()
    : Number.NaN
  if (!Number.isFinite(providerCreatedAt)) {
    return Object.freeze({
      admitted: false,
      knownProviderIdentity: false,
      ingestionFloor,
      reason: 'provider_created_at_required',
    })
  }
  const admitted = providerCreatedAt >= row.ingestion_floor.getTime()
  return Object.freeze({
    admitted,
    knownProviderIdentity: false,
    ingestionFloor,
    reason: admitted ? 'within_frozen_floor' : 'before_frozen_floor',
  })
}
