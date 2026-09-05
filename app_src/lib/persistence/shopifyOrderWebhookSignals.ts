import { recordAuditEvent } from '@/lib/auditWriter'
import type { PoolClient } from 'pg'
import {
  inspectCommerceOrderNativeActivityWithClient,
  appendCommerceOrderNativeActivityWithClient,
} from '@/lib/persistence/commerceOrderNativeActivity'
import {
  appendCommerceOrderTrackingUrlEvidenceWithClient,
  inspectCommerceOrderTrackingUrlEvidenceWithClient,
} from '@/lib/persistence/commerceOrderTrackingUrlEvidence'
import {
  shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery,
  type ShopifyOrderWebhookSignalEvidence,
} from '@/lib/integrations/shopifyOrderWebhook'
import { commerceStoreSyncRunningSql } from '@/lib/operations/commerceStoreSync'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  assertCommerceStoreSyncProviderReadLeaseCurrentWithClient,
  type CommerceStoreSyncProviderReadLease,
} from '@/lib/persistence/commerceStoreSync'
import type {
  CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'
import {
  commerceOrderSyncAccountLockKey,
  CommerceOrderSyncError,
  normalizeCommerceOrderObservationInput,
  type CommerceOrderObservationInput,
} from '@/lib/persistence/commerceOrderSync'
import {
  assessCommerceOrderHistoryAdmissionWithClient,
} from '@/lib/persistence/commerceOrderHistoryAdmission'

const STORE_SYNC_RUNNING_SQL = commerceStoreSyncRunningSql('account')

export class ShopifyOrderWebhookSignalPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyOrderWebhookSignalPersistenceError'
  }
}

export type ShopifyOrderWebhookSignalResult = Readonly<{
  globalId: string
  externalOrderId: string
  duplicate: boolean
  dirtyVersion: number
  reconciledVersion: number
  processorState: 'exact_read_pending'
  providerWrites: 0
}>

export type ShopifyOrderWebhookDiscoveryPolicyAlignment = Readonly<{
  downgraded: boolean
  policyRevision: number | null
  providerWrites: 0
}>

export type ShopifyOrderWebhookTargetClaim = Readonly<{
  id: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  credentialGeneration: number
  policyRevision: number
  externalOrderId: string
  capturedDirtyVersion: number
  signalGlobalId: string
  claimedProviderUpdatedAt: string
  lockToken: string
  attemptCount: number
}>

type NormalizedObservation = ReturnType<
  typeof normalizeCommerceOrderObservationInput
>

function conflict(code: string, message: string, status = 409): never {
  throw new ShopifyOrderWebhookSignalPersistenceError(code, message, status)
}

function sensitiveEvidenceRetentionDays() {
  const raw = process.env.COMMERCE_ORDER_SENSITIVE_EVIDENCE_RETENTION_DAYS
  const days = raw === undefined || raw === '' ? 400 : Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > 400) {
    throw new CommerceOrderSyncError(
      'COMMERCE_ORDER_SYNC_RETENTION_INVALID',
      'Commerce order sensitive-evidence retention must be 1-400 days',
      503,
    )
  }
  return days
}

function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(code)
    ? code
    : 'SHOPIFY_ORDER_WEBHOOK_EXACT_READ_FAILED'
}

/**
 * Fail a previously activated order-webhook transport back to its durable poll
 * lane after a successful, exact subscription discovery reports not-ready.
 * The caller may already hold the shared account lock; PostgreSQL advisory
 * locks are re-entrant for the current transaction.
 */
export async function downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    accountGlobalId: string
    credentialGeneration: number
  },
): Promise<ShopifyOrderWebhookDiscoveryPolicyAlignment> {
  await acquireTransactionAdvisoryLock(
    client,
    commerceOrderSyncAccountLockKey({
      organizationId: input.organizationId,
      accountGlobalId: input.accountGlobalId,
    }),
  )
  const result = await client.query<{ revision: number }>(
    `UPDATE operations_commerce_order_sync_policies policy
     SET continuous_transport = 'scheduled_poll',
         provider_event_processor_state = 'processor_pending',
         revision = policy.revision + 1,
         updated_at = now()
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.credential_version = $3
      AND credential.external_account_id = account.external_account_id
      AND credential.auth_mode = 'shopify_client_credentials'
      AND credential.verification_status = 'verified'
     WHERE policy.organization_id = account.organization_id
       AND policy.integration_account_id = account.id
       AND account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND account.status = 'active'
       AND account.commerce_credential_generation = $3
       AND account.configuration
             #>> '{orderWebhookSubscriptions,accountGlobalId}' = $2
       AND account.configuration
             #>> '{orderWebhookSubscriptions,credentialGeneration}' = $3::text
       AND account.configuration
             #>> '{orderWebhookSubscriptions,discoveryState}' = 'succeeded'
       AND account.configuration
             #>> '{orderWebhookSubscriptions,subscriptionReady}' = 'false'
       AND account.configuration
             #>> '{orderWebhookSubscriptions,ready}' = 'false'
       AND policy.authority = 'provider'
       AND policy.continuous_observation_enabled
       AND policy.continuous_transport = 'webhook_signal_plus_poll'
       AND policy.provider_event_processor_state = 'available'
     RETURNING policy.revision`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.credentialGeneration,
    ],
  )
  return Object.freeze({
    downgraded: result.rowCount === 1,
    policyRevision: result.rows[0]?.revision || null,
    providerWrites: 0 as const,
  })
}

/**
 * Persist an HMAC-verified, payload-free Shopify order signal and coalesce an
 * exact-order read target in one transaction. This function receives no raw
 * body and has no provider client or provider-write path.
 */
export async function recordShopifyOrderWebhookSignalInPostgres(input: {
  runtime: CommerceRuntimeCredentialRecord
  providerEventId: string
  sourceDomain: string
  providerApiVersion: string | null
  providerTriggeredAt: string | null
  expectedCallbackUri: string
  evidence: ShopifyOrderWebhookSignalEvidence
}): Promise<ShopifyOrderWebhookSignalResult> {
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      commerceOrderSyncAccountLockKey({
        organizationId: input.runtime.organizationId,
        accountGlobalId: input.runtime.globalId,
      }),
    )
    const exactAccount = await client.query<{
      id: string
      global_id: string
    }>(
      `SELECT account.id::text, account.global_id
       FROM operations_integration_accounts account
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.global_id = $3
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF account`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.globalId,
      ],
    )
    if (!exactAccount.rows[0]) {
      conflict(
        'SHOPIFY_ORDER_WEBHOOK_LINEAGE_STALE',
        'Shopify order webhook account lineage is not current',
      )
    }
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-webhook:${input.runtime.globalId}:${input.providerEventId}`,
    )

    await client.query(
      `INSERT INTO operations_commerce_order_sync_policies (
         organization_id, integration_account_id, authority,
         historical_observation_enabled, continuous_observation_enabled,
         continuous_transport, provider_event_processor_state, revision,
         continuous_high_watermark, created_by, updated_by
       )
       SELECT
         account.organization_id, account.id, 'provider',
         false, true, 'scheduled_poll', 'processor_pending', 1,
         date_trunc('milliseconds', clock_timestamp()),
         COALESCE(
           account.updated_by, account.created_by,
           credential.updated_by, credential.created_by
         ),
         COALESCE(
           account.updated_by, account.created_by,
           credential.updated_by, credential.created_by
         )
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version
              = account.commerce_credential_generation
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
         AND COALESCE(
               account.updated_by, account.created_by,
               credential.updated_by, credential.created_by
             ) IS NOT NULL
       ON CONFLICT (organization_id, integration_account_id) DO NOTHING`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ],
    )

    const fence = await client.query<{
      account_global_id: string
      status: 'active' | 'disabled' | 'error'
      account_external_account_id: string | null
      commerce_credential_generation: number
      shop_domain: string | null
      credential_external_account_id: string
      credential_version: number
      auth_mode: string
      verification_status: string
      authority: string
      policy_revision: number
      continuous_observation_enabled: boolean
      continuous_transport: string
      provider_event_processor_state: string
      order_webhook_subscriptions: unknown
      checked_at: Date | string
    }>(
      `SELECT
         account.global_id AS account_global_id,
         account.status,
         account.external_account_id AS account_external_account_id,
         account.commerce_credential_generation,
         account.configuration->>'shopDomain' AS shop_domain,
         credential.external_account_id AS credential_external_account_id,
         credential.credential_version,
         credential.auth_mode,
         credential.verification_status,
         policy.authority,
         policy.revision AS policy_revision,
         policy.continuous_observation_enabled,
         policy.continuous_transport,
         policy.provider_event_processor_state,
         account.configuration->'orderWebhookSubscriptions'
           AS order_webhook_subscriptions,
         clock_timestamp() AS checked_at
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = account.organization_id
        AND policy.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider = 'shopify'
       FOR UPDATE OF account, credential, policy`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
      ],
    )
    const current = fence.rows[0]
    if (
      !current
      || current.account_global_id !== input.runtime.globalId
      || current.status !== 'active'
      || current.account_external_account_id !== input.runtime.externalAccountId
      || current.credential_external_account_id
        !== current.account_external_account_id
      || current.commerce_credential_generation
        !== input.runtime.credentialVersion
      || current.credential_version !== input.runtime.credentialVersion
      || current.auth_mode !== 'shopify_client_credentials'
      || current.verification_status !== 'verified'
      || current.shop_domain !== input.sourceDomain
      || current.authority !== 'provider'
      || !current.continuous_observation_enabled
    ) {
      conflict(
        'SHOPIFY_ORDER_WEBHOOK_LINEAGE_STALE',
        'Shopify order webhook credential or policy lineage is not current',
      )
    }
    const runtimeSubscriptionEvidence = input.runtime.configuration
      .orderWebhookSubscriptions
    const fallbackCallbackUri = runtimeSubscriptionEvidence
      && typeof runtimeSubscriptionEvidence === 'object'
      && !Array.isArray(runtimeSubscriptionEvidence)
      && typeof (runtimeSubscriptionEvidence as Record<string, unknown>)
        .desiredUri === 'string'
      ? String((runtimeSubscriptionEvidence as Record<string, unknown>).desiredUri)
      : ''
    const subscriptionReady =
      shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery(
        current.order_webhook_subscriptions,
        {
          accountGlobalId: current.account_global_id,
          credentialGeneration: current.credential_version,
          desiredUri: input.expectedCallbackUri || fallbackCallbackUri,
        },
      )
    if (!subscriptionReady) {
      conflict(
        'SHOPIFY_ORDER_WEBHOOK_SUBSCRIPTIONS_UNREADY',
        'Shopify order webhook subscription evidence is not current',
      )
    }
    if (
      current.continuous_transport !== 'webhook_signal_plus_poll'
      || current.provider_event_processor_state !== 'available'
    ) {
      await client.query(
        `UPDATE operations_commerce_order_sync_policies
         SET continuous_transport = 'webhook_signal_plus_poll',
             provider_event_processor_state = 'available',
             revision = revision + 1,
             updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [input.runtime.organizationId, input.runtime.integrationAccountId],
      )
      current.policy_revision += 1
      current.continuous_transport = 'webhook_signal_plus_poll'
      current.provider_event_processor_state = 'available'
    }
    await acquireTransactionAdvisoryLock(
      client,
      `shopify-order-webhook-target:${input.runtime.organizationId}:${input.runtime.integrationAccountId}:${input.evidence.externalOrderId}`,
    )

    const existing = await client.query<{
      global_id: string
      credential_generation: number
      policy_revision: number
      topic: string
      source_domain: string
      provider_api_version: string | null
      external_order_id: string
      provider_updated_at: string | Date
      payload_hash: string
      payload_bytes: number
      provider_triggered_at: string | Date | null
      dirty_version: string | number
      reconciled_version: string | number
    }>(
      `SELECT
         signal.global_id,
         signal.credential_generation,
         signal.policy_revision,
         signal.topic,
         signal.source_domain,
         signal.provider_api_version,
         signal.external_order_id,
         signal.provider_updated_at,
         signal.payload_hash,
         signal.payload_bytes,
         signal.provider_triggered_at,
         target.dirty_version,
         target.reconciled_version
       FROM operations_shopify_order_webhook_signals signal
       JOIN operations_shopify_order_webhook_targets target
         ON target.organization_id = signal.organization_id
        AND target.integration_account_id = signal.integration_account_id
        AND target.external_order_id = signal.external_order_id
       WHERE signal.organization_id = $1::uuid
         AND signal.integration_account_id = $2::uuid
         AND signal.provider_event_id = $3`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.providerEventId,
      ],
    )
    if (existing.rows[0]) {
      const prior = existing.rows[0]
      const priorTriggeredAt = prior.provider_triggered_at
        ? new Date(prior.provider_triggered_at).toISOString()
        : null
      if (
        prior.credential_generation !== input.runtime.credentialVersion
        || prior.topic !== input.evidence.topic
        || prior.source_domain !== input.sourceDomain
        || prior.provider_api_version !== input.providerApiVersion
        || prior.external_order_id !== input.evidence.externalOrderId
        || new Date(prior.provider_updated_at).toISOString()
          !== input.evidence.providerUpdatedAt
        || prior.payload_hash !== input.evidence.payloadHash
        || prior.payload_bytes !== input.evidence.payloadBytes
        || priorTriggeredAt !== input.providerTriggeredAt
      ) {
        conflict(
          'SHOPIFY_ORDER_WEBHOOK_EVENT_CONFLICT',
          'Shopify reused an order webhook event ID with different evidence',
        )
      }
      return Object.freeze({
        globalId: prior.global_id,
        externalOrderId: prior.external_order_id,
        duplicate: true,
        dirtyVersion: Number(prior.dirty_version),
        reconciledVersion: Number(prior.reconciled_version),
        processorState: 'exact_read_pending' as const,
        providerWrites: 0 as const,
      })
    }

    const inserted = await client.query<{
      global_id: string
    }>(
      `INSERT INTO operations_shopify_order_webhook_signals (
         organization_id, integration_account_id,
         credential_generation, policy_revision,
         provider_event_id, topic, source_domain, provider_api_version,
         external_order_id, provider_updated_at, payload_hash, payload_bytes,
         provider_triggered_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
         $9, $10::timestamptz, $11, $12, $13::timestamptz
       )
       RETURNING global_id`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.runtime.credentialVersion,
        current.policy_revision,
        input.providerEventId,
        input.evidence.topic,
        input.sourceDomain,
        input.providerApiVersion,
        input.evidence.externalOrderId,
        input.evidence.providerUpdatedAt,
        input.evidence.payloadHash,
        input.evidence.payloadBytes,
        input.providerTriggeredAt,
      ],
    )
    const currentTarget = await client.query<{
      claim_state: 'pending' | 'processing' | 'failed' | 'idle' | 'dead'
      credential_generation: number
      policy_revision: number
    }>(
      `SELECT claim_state, credential_generation, policy_revision
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3
       FOR UPDATE`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.evidence.externalOrderId,
      ],
    )
    const target = await client.query<{
      dirty_version: string | number
      reconciled_version: string | number
    }>(currentTarget.rows[0]
      ? `UPDATE operations_shopify_order_webhook_targets
         SET credential_generation = $4,
             policy_revision = $5,
             dirty_version = dirty_version + 1,
             latest_signal_global_id = $6,
             latest_provider_updated_at = GREATEST(
               latest_provider_updated_at, $7::timestamptz
             ),
             last_signaled_at = (
               SELECT signal.received_at
               FROM operations_shopify_order_webhook_signals signal
               WHERE signal.organization_id = $1::uuid
                 AND signal.integration_account_id = $2::uuid
                 AND signal.global_id = $6
             ),
             claim_state = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN 'processing'
               ELSE 'pending'
             END,
             claimed_dirty_version = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN claimed_dirty_version ELSE NULL
             END,
             claimed_signal_global_id = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN claimed_signal_global_id ELSE NULL
             END,
             claimed_provider_updated_at = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN claimed_provider_updated_at ELSE NULL
             END,
             locked_at = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN locked_at ELSE NULL
             END,
             locked_by = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN locked_by ELSE NULL
             END,
             lock_token = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN lock_token ELSE NULL
             END,
             lease_expires_at = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN lease_expires_at ELSE NULL
             END,
             attempt_count = CASE
               WHEN claim_state = 'processing'
                 AND credential_generation = $4
                 AND policy_revision = $5
               THEN attempt_count ELSE 0
             END,
             available_at = clock_timestamp(),
             last_error_code = NULL,
             updated_at = clock_timestamp()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = $3
         RETURNING dirty_version, reconciled_version`
      : `INSERT INTO operations_shopify_order_webhook_targets (
         organization_id, integration_account_id, external_order_id,
         credential_generation, policy_revision,
         dirty_version, reconciled_version,
         latest_signal_global_id, latest_provider_updated_at,
         last_signaled_at, claim_state
         ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, 1, 0, $6,
         $7::timestamptz,
         (
           SELECT signal.received_at
           FROM operations_shopify_order_webhook_signals signal
           WHERE signal.organization_id = $1::uuid
             AND signal.integration_account_id = $2::uuid
             AND signal.global_id = $6
         ),
         'pending'
       )
       RETURNING dirty_version, reconciled_version`,
      [
        input.runtime.organizationId,
        input.runtime.integrationAccountId,
        input.evidence.externalOrderId,
        input.runtime.credentialVersion,
        current.policy_revision,
        inserted.rows[0].global_id,
        input.evidence.providerUpdatedAt,
      ],
    )
    await recordAuditEvent({
      actor: null,
      eventType: 'commerce.shopify_order_webhook.signaled',
      aggregateType: 'operations.shopify_order_webhook_signal',
      aggregateId: inserted.rows[0].global_id,
      organizationId: input.runtime.organizationId,
      eventKey: `shopify-order-webhook:${inserted.rows[0].global_id}`,
      isSystem: true,
      payload: {
        accountGlobalId: input.runtime.globalId,
        topic: input.evidence.topic,
        externalOrderId: input.evidence.externalOrderId,
        providerUpdatedAt: input.evidence.providerUpdatedAt,
        dirtyVersion: Number(target.rows[0].dirty_version),
        processorState: 'exact_read_pending',
        scheduledPollBackstop: true,
        providerWrites: 0,
      },
    }, client)
    return Object.freeze({
      globalId: inserted.rows[0].global_id,
      externalOrderId: input.evidence.externalOrderId,
      duplicate: false,
      dirtyVersion: Number(target.rows[0].dirty_version),
      reconciledVersion: Number(target.rows[0].reconciled_version),
      processorState: 'exact_read_pending' as const,
      providerWrites: 0 as const,
    })
  })
}

/**
 * Claim a bounded set of exact Shopify Order GIDs. The claim captures the
 * dirty version, signed signal, credential generation, policy revision, and a
 * lease token so a later append cannot acknowledge newer or foreign work.
 */
export async function claimShopifyOrderWebhookTargetsInPostgres(input: {
  workerId: string
  limit?: number
}): Promise<ShopifyOrderWebhookTargetClaim[]> {
  const workerId = String(input.workerId || '').trim().slice(0, 200)
  if (!workerId) {
    conflict(
      'SHOPIFY_ORDER_WEBHOOK_WORKER_INVALID',
      'Shopify order webhook worker identity is required',
      400,
    )
  }
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 5))
  return withTransaction(async (client) => {
    // A scheduled history request legitimately advances the shared policy
    // revision. Rebind a bounded set of unclaimed dirty targets only when the
    // complete Shopify identity, credential, authority, activation, and
    // webhook-plus-poll policy still match. Otherwise terminalize that stale
    // local work without issuing a provider read or write.
    await client.query(
      `WITH candidates AS (
         SELECT target.organization_id, target.id
         FROM operations_shopify_order_webhook_targets target
         WHERE target.dirty_version > target.reconciled_version
           AND (
             target.claim_state IN ('pending', 'failed')
             OR (
               target.claim_state = 'processing'
               AND target.lease_expires_at <= clock_timestamp()
             )
           )
           AND target.available_at <= clock_timestamp()
         ORDER BY target.available_at, target.last_signaled_at,
                  target.organization_id, target.id
         LIMIT $1
         FOR UPDATE OF target SKIP LOCKED
       ), evaluated AS (
         SELECT target.organization_id, target.id,
                policy.revision AS current_policy_revision,
                (
                  account.integration_type = 'commerce'
                  AND account.provider = 'shopify'
                  AND account.status = 'active'
                  AND account.external_account_id IS NOT NULL
                  AND account.commerce_credential_generation
                        = target.credential_generation
                  AND credential.credential_version
                        = target.credential_generation
                  AND credential.external_account_id
                        = account.external_account_id
                  AND credential.auth_mode = 'shopify_client_credentials'
                  AND credential.verification_status = 'verified'
                  AND policy.revision >= target.policy_revision
                  AND policy.authority = 'provider'
                  AND policy.continuous_observation_enabled
                  AND policy.continuous_transport
                        = 'webhook_signal_plus_poll'
                  AND policy.provider_event_processor_state = 'available'
                  AND authority.provider = 'shopify'
                  AND authority.resource = 'orders'
                  AND authority.authority_mode = 'provider'
                  AND authority.desired_ingest_mode
                        = 'windowed_history_and_core_order_signals_plus_poll'
                  AND authority.provider_write_mode = 'disabled'
                  AND authority.provider_write_count = 0
                  AND ${STORE_SYNC_RUNNING_SQL}
                  AND signal.integration_account_id
                        = target.integration_account_id
                  AND signal.external_order_id = target.external_order_id
                  AND signal.credential_generation
                        = target.credential_generation
                  AND signal.policy_revision <= target.policy_revision
                  AND signal.source_domain
                        = account.configuration->>'shopDomain'
                  AND signal.provider_updated_at
                        <= target.latest_provider_updated_at
                  AND signal.received_at = target.last_signaled_at
                ) AS eligible
         FROM candidates
         JOIN operations_shopify_order_webhook_targets target
           ON target.organization_id = candidates.organization_id
          AND target.id = candidates.id
         LEFT JOIN operations_integration_accounts account
           ON account.organization_id = target.organization_id
          AND account.id = target.integration_account_id
         LEFT JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         LEFT JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = target.organization_id
          AND policy.integration_account_id = target.integration_account_id
         LEFT JOIN operations_commerce_authority_policy_current authority
           ON authority.organization_id = target.organization_id
          AND authority.integration_account_id
                = target.integration_account_id
          AND authority.resource = 'orders'
         LEFT JOIN operations_activation_scopes activation
           ON activation.organization_id = target.organization_id
         LEFT JOIN operations_shopify_order_webhook_signals signal
           ON signal.organization_id = target.organization_id
          AND signal.global_id = target.latest_signal_global_id
       )
       UPDATE operations_shopify_order_webhook_targets target
       SET policy_revision = CASE
             WHEN COALESCE(evaluated.eligible, false)
             THEN evaluated.current_policy_revision
             ELSE target.policy_revision
           END,
           claim_state = CASE
             WHEN COALESCE(evaluated.eligible, false) THEN 'pending'
             ELSE 'dead'
           END,
           claimed_dirty_version = NULL,
           claimed_signal_global_id = NULL,
           claimed_provider_updated_at = NULL,
           attempt_count = CASE
             WHEN COALESCE(evaluated.eligible, false) THEN 0
             ELSE target.attempt_count
           END,
           available_at = CASE
             WHEN COALESCE(evaluated.eligible, false)
             THEN clock_timestamp()
             ELSE target.available_at
           END,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = CASE
             WHEN COALESCE(evaluated.eligible, false)
             THEN target.last_error_code
             ELSE 'SHOPIFY_ORDER_WEBHOOK_LINEAGE_STALE'
           END,
           updated_at = clock_timestamp()
       FROM evaluated
       WHERE target.organization_id = evaluated.organization_id
         AND target.id = evaluated.id
         AND (
           NOT COALESCE(evaluated.eligible, false)
           OR target.policy_revision
                <> evaluated.current_policy_revision
         )`,
      [Math.min(limit * 5, 25)],
    )
    await client.query(
      `UPDATE operations_shopify_order_webhook_targets
       SET claim_state = 'dead',
           claimed_dirty_version = NULL,
           claimed_signal_global_id = NULL,
           claimed_provider_updated_at = NULL,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'SHOPIFY_ORDER_WEBHOOK_ATTEMPTS_EXHAUSTED',
           updated_at = clock_timestamp()
       WHERE claim_state = 'processing'
         AND lease_expires_at <= clock_timestamp()
         AND attempt_count >= 12`,
    )
    const claimed = await client.query<{
      id: string
      organization_id: string
      integration_account_id: string
      account_global_id: string
      credential_generation: number
      policy_revision: number
      external_order_id: string
      claimed_dirty_version: string | number
      claimed_signal_global_id: string
      claimed_provider_updated_at: Date | string
      lock_token: string
      attempt_count: number
    }>(
      `WITH candidates AS (
         SELECT target.organization_id, target.id
         FROM operations_shopify_order_webhook_targets target
         JOIN operations_integration_accounts account
           ON account.organization_id = target.organization_id
          AND account.id = target.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider = 'shopify'
          AND account.status = 'active'
          AND account.commerce_credential_generation
              = target.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = target.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.auth_mode = 'shopify_client_credentials'
          AND credential.verification_status = 'verified'
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = target.organization_id
          AND policy.integration_account_id = target.integration_account_id
          AND policy.revision = target.policy_revision
          AND policy.authority = 'provider'
          AND policy.continuous_observation_enabled
          AND policy.continuous_transport = 'webhook_signal_plus_poll'
          AND policy.provider_event_processor_state = 'available'
         JOIN operations_commerce_authority_policy_current authority
           ON authority.organization_id = target.organization_id
          AND authority.integration_account_id
                = target.integration_account_id
          AND authority.provider = 'shopify'
          AND authority.resource = 'orders'
          AND authority.authority_mode = 'provider'
          AND authority.desired_ingest_mode
                = 'windowed_history_and_core_order_signals_plus_poll'
          AND authority.provider_write_mode = 'disabled'
          AND authority.provider_write_count = 0
         JOIN operations_activation_scopes activation
           ON activation.organization_id = target.organization_id
          AND ${STORE_SYNC_RUNNING_SQL}
         WHERE target.dirty_version > target.reconciled_version
           AND target.attempt_count < 12
           AND target.available_at <= clock_timestamp()
           AND (
             target.claim_state IN ('pending', 'failed')
             OR (
               target.claim_state = 'processing'
               AND target.lease_expires_at <= clock_timestamp()
             )
           )
         ORDER BY target.available_at, target.last_signaled_at,
                  target.organization_id, target.id
         LIMIT $1
         FOR UPDATE OF target SKIP LOCKED
       ), updated AS (
         UPDATE operations_shopify_order_webhook_targets target
         SET claim_state = 'processing',
             claimed_dirty_version = target.dirty_version,
             claimed_signal_global_id = target.latest_signal_global_id,
             claimed_provider_updated_at = target.latest_provider_updated_at,
             attempt_count = target.attempt_count + 1,
             locked_at = clock_timestamp(),
             locked_by = $2,
             lock_token = gen_random_uuid(),
             lease_expires_at = clock_timestamp() + interval '10 minutes',
             last_error_code = NULL,
             updated_at = clock_timestamp()
         FROM candidates
         WHERE target.organization_id = candidates.organization_id
           AND target.id = candidates.id
         RETURNING target.*
       )
       SELECT updated.id::text, updated.organization_id::text,
              updated.integration_account_id::text,
              account.global_id AS account_global_id,
              updated.credential_generation, updated.policy_revision,
              updated.external_order_id, updated.claimed_dirty_version,
              updated.claimed_signal_global_id,
              updated.claimed_provider_updated_at, updated.lock_token::text,
              updated.attempt_count
       FROM updated
       JOIN operations_integration_accounts account
         ON account.organization_id = updated.organization_id
        AND account.id = updated.integration_account_id
       ORDER BY updated.locked_at, updated.organization_id, updated.id`,
      [limit, workerId],
    )
    return claimed.rows.map((row) => Object.freeze({
      id: row.id,
      organizationId: row.organization_id,
      integrationAccountId: row.integration_account_id,
      accountGlobalId: row.account_global_id,
      credentialGeneration: row.credential_generation,
      policyRevision: row.policy_revision,
      externalOrderId: row.external_order_id,
      capturedDirtyVersion: Number(row.claimed_dirty_version),
      signalGlobalId: row.claimed_signal_global_id,
      claimedProviderUpdatedAt:
        new Date(row.claimed_provider_updated_at).toISOString(),
      lockToken: row.lock_token,
      attemptCount: row.attempt_count,
    }))
  })
}

/** Revalidate the exact claimed target and Store sync fence before Shopify I/O. */
export async function assertShopifyOrderWebhookClaimCurrentForProviderReadInPostgres(
  claim: ShopifyOrderWebhookTargetClaim,
) {
  const result = await query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM operations_shopify_order_webhook_targets target
       JOIN operations_integration_accounts account
         ON account.organization_id = target.organization_id
        AND account.id = target.integration_account_id
        AND account.global_id = $4
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
        AND account.commerce_credential_generation = $5
       WHERE target.organization_id = $1::uuid
         AND target.id = $2::uuid
         AND target.integration_account_id = $3::uuid
         AND target.credential_generation = $5
         AND target.policy_revision = $6
         AND target.external_order_id = $7
         AND target.claim_state = 'processing'
         AND target.claimed_dirty_version = $8
         AND target.claimed_signal_global_id = $9
         AND target.claimed_provider_updated_at = $10::timestamptz
         AND target.lock_token = $11::uuid
         AND target.lease_expires_at > clock_timestamp()
         AND ${STORE_SYNC_RUNNING_SQL}
     ) AS current`,
    [
      claim.organizationId,
      claim.id,
      claim.integrationAccountId,
      claim.accountGlobalId,
      claim.credentialGeneration,
      claim.policyRevision,
      claim.externalOrderId,
      claim.capturedDirtyVersion,
      claim.signalGlobalId,
      claim.claimedProviderUpdatedAt,
      claim.lockToken,
    ],
  )
  if (result.rows[0]?.current !== true) {
    conflict(
      'SHOPIFY_ORDER_WEBHOOK_PROVIDER_READ_FENCE_CHANGED',
      'Store sync paused or the exact webhook read lease changed before Shopify I/O',
    )
  }
}

async function inspectSensitiveEvidence(
  client: PoolClient,
  claim: ShopifyOrderWebhookTargetClaim,
  observation: NormalizedObservation,
  requireRetained: boolean,
) {
  return inspectCommerceOrderTrackingUrlEvidenceWithClient(client, {
    organizationId: claim.organizationId, integrationAccountId: claim.integrationAccountId, provider: 'shopify',
  }, observation, { requireRetained, conflict: () => {
    throw new CommerceOrderSyncError('COMMERCE_ORDER_SYNC_SENSITIVE_REVISION_CONFLICT',
      'Sensitive provider evidence changed without a new provider revision', 409)
  } })
}

async function insertExactObservation(
  client: PoolClient,
  claim: ShopifyOrderWebhookTargetClaim,
  observation: NormalizedObservation,
) {
  type ObservationRow = {
    id: string
    global_id: string
    order_id: string | null
    source_hash: string
    observation_kind: string
    webhook_target_id: string | null
    webhook_dirty_version: string | null
  }
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `commerce-order-observation:${claim.organizationId}`
        + `:${claim.integrationAccountId}:shopify`
        + `:${observation.externalOrderId}`,
    ],
  )
  let row: ObservationRow | undefined = (
    await client.query<ObservationRow>(
      `SELECT id::text, global_id, order_id::text, source_hash,
              observation_kind, webhook_target_id::text,
              webhook_dirty_version::text
       FROM operations_commerce_order_observations
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider = 'shopify'
         AND external_order_id = $3
       ORDER BY observed_at DESC, id DESC
       LIMIT 1
       FOR SHARE`,
      [
        claim.organizationId,
        claim.integrationAccountId,
        observation.externalOrderId,
      ],
    )
  ).rows[0]
  let appended = false
  if (
    row?.source_hash !== observation.sourceHash
    || row.observation_kind !== 'webhook_exact_read'
    || row.webhook_target_id !== claim.id
    || row.webhook_dirty_version !== String(claim.capturedDirtyVersion)
  ) {
    row = (
      await client.query<ObservationRow>(
        `SELECT id::text, global_id, order_id::text, source_hash,
                observation_kind, webhook_target_id::text,
                webhook_dirty_version::text
         FROM operations_commerce_order_observations
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND provider = 'shopify'
           AND external_order_id = $3
           AND source_hash = $4
           AND observed_at = $5::timestamptz
           AND observation_kind = 'webhook_exact_read'
           AND webhook_target_id = $6::uuid
           AND webhook_dirty_version = $7
         LIMIT 1
         FOR SHARE`,
        [
          claim.organizationId,
          claim.integrationAccountId,
          observation.externalOrderId,
          observation.sourceHash,
          observation.observedAt,
          claim.id,
          claim.capturedDirtyVersion,
        ],
      )
    ).rows[0]
  }
  const urlEnrichments = await inspectSensitiveEvidence(client, claim, observation, Boolean(row))
  const nativeScope = { organizationId: claim.organizationId, integrationAccountId: claim.integrationAccountId, provider: 'shopify' as const }
  const nativeSnapshots = await inspectCommerceOrderNativeActivityWithClient(client, nativeScope, observation)
  // A URL-aware hash can have been sealed without its URL by the old writer.
  // Capture the fresh read under this claim instead of modifying that parent.
  if (urlEnrichments.length || nativeSnapshots.length) row = undefined
  if (!row) {
    const inserted = await client.query<ObservationRow>(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         webhook_target_id, webhook_dirty_version, webhook_lock_token,
         order_id, provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         raw_lifecycle_state, raw_payment_state, raw_fulfillment_state,
         raw_return_state, canonical_lifecycle_state,
         canonical_payment_state, canonical_fulfillment_state,
         canonical_return_state, currency, provider_total_minor,
         provider_inventory_reservation_state, provider_created_at,
         provider_processed_at, provider_updated_at, provider_cancelled_at,
         provider_closed_at, observed_at, provider_read_count,
         native_activity_state, native_activity_reason, native_activity_fetched_count
       )
       SELECT
         $1::uuid, $2::uuid, NULL, $3::uuid, $4, $5::uuid,
         canonical.id, 'shopify', $6, 'webhook_exact_read',
         $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22::timestamptz, $23::timestamptz,
         $24::timestamptz, $25::timestamptz, $26::timestamptz,
         $27::timestamptz, $28, $29, $30, $31
       FROM (SELECT 1) singleton
       LEFT JOIN LATERAL (
         SELECT orders.id
         FROM operations_orders orders
         WHERE orders.organization_id = $1::uuid
           AND orders.integration_account_id = $2::uuid
           AND orders.source_provider = 'shopify'
           AND orders.external_order_id = $7
         LIMIT 1
       ) canonical ON true
       ON CONFLICT (
         organization_id, integration_account_id, provider,
         external_order_id, observation_kind, observed_at, source_hash,
         backfill_session_id, webhook_target_id, webhook_dirty_version,
         manual_provider_read_lease_id
       ) DO NOTHING
       RETURNING id::text, global_id, order_id::text, source_hash`,
      [
        claim.organizationId,
        claim.integrationAccountId,
        claim.id,
        claim.capturedDirtyVersion,
        claim.lockToken,
        claim.credentialGeneration,
        observation.externalOrderId,
        observation.orderNumber,
        observation.sourceRevision,
        observation.sourceHash,
        observation.rawLifecycleState,
        observation.rawPaymentState,
        observation.rawFulfillmentState,
        observation.rawReturnState,
        observation.canonicalLifecycleState,
        observation.canonicalPaymentState,
        observation.canonicalFulfillmentState,
        observation.canonicalReturnState,
        observation.currency,
        observation.providerTotalMinor,
        observation.providerInventoryReservationState,
        observation.providerCreatedAt,
        observation.providerProcessedAt,
        observation.providerUpdatedAt,
        observation.providerCancelledAt,
        observation.providerClosedAt,
        observation.observedAt,
        observation.providerReadCount,
        observation.nativeActivityState || null,
        observation.nativeActivityReason || null,
        observation.nativeActivityFetchedCount ?? null,
      ],
    )
    row = inserted.rows[0]
    appended = Boolean(row)
    if (!row) {
      row = (
        await client.query<ObservationRow>(
          `SELECT id::text, global_id, order_id::text, source_hash,
                  observation_kind, webhook_target_id::text,
                  webhook_dirty_version::text
           FROM operations_commerce_order_observations
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND provider = 'shopify'
             AND external_order_id = $3
             AND source_hash = $4
             AND observed_at = $5::timestamptz
             AND observation_kind = 'webhook_exact_read'
             AND webhook_target_id = $6::uuid
             AND webhook_dirty_version = $7
           LIMIT 1
           FOR SHARE`,
          [
            claim.organizationId,
            claim.integrationAccountId,
            observation.externalOrderId,
            observation.sourceHash,
            observation.observedAt,
            claim.id,
            claim.capturedDirtyVersion,
          ],
        )
      ).rows[0]
    }
  }
  if (!row) {
    conflict(
      'SHOPIFY_ORDER_WEBHOOK_OBSERVATION_CONFLICT',
      'Shopify exact-order observation conflict could not be resolved',
    )
  }
  if (!appended && !urlEnrichments.length && !nativeSnapshots.length) {
    return { row, appended: 0, preserved: 1, linesAppended: 0, eventsAppended: 0 }
  }
  let linesAppended = 0
  let eventsAppended = 0
  for (const line of observation.lines) {
    const result = await client.query(
      `INSERT INTO operations_commerce_order_observation_lines (
         organization_id, observation_id, external_line_id,
         external_product_id, external_variant_id, sku,
         title_snapshot, variant_title_snapshot, vendor_snapshot,
         original_quantity, current_quantity, unfulfilled_quantity,
         fulfilled_quantity, returned_quantity, requires_shipping,
         unit_price_currency, unit_price_minor,
         subtotal_currency, subtotal_minor,
         discount_currency, discount_minor, tax_currency, tax_minor
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23
       )`,
      [
        claim.organizationId,
        row.id,
        line.externalLineId,
        line.externalProductId,
        line.externalVariantId,
        line.sku,
        line.titleSnapshot,
        line.variantTitleSnapshot,
        line.vendorSnapshot,
        line.originalQuantity,
        line.currentQuantity,
        line.unfulfilledQuantity,
        line.fulfilledQuantity,
        line.returnedQuantity,
        line.requiresShipping,
        line.unitPriceCurrency,
        line.unitPriceMinor,
        line.subtotalCurrency,
        line.subtotalMinor,
        line.discountCurrency,
        line.discountMinor,
        line.taxCurrency,
        line.taxMinor,
      ],
    )
    linesAppended += Number(result.rowCount || 0)
  }
  for (const event of observation.events) {
    const result = await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         order_id, provider, external_order_id, external_event_id,
         external_subject_id, event_hash, event_kind, event_status,
         quantity, amount_minor, currency, inventory_effect_kind,
         attribution_source, provider_actor_fingerprint,
         provider_location_id, tracking_carrier, tracking_number,
         tracking_url, sensitive_evidence_expires_at, occurred_at, observed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, LEAST($21::timestamptz, $23::timestamptz)
           + make_interval(days => $22),
         $21::timestamptz, $23::timestamptz
       )
       ON CONFLICT (
         organization_id, integration_account_id, provider,
         external_order_id, event_hash
       ) DO NOTHING`,
      [
        claim.organizationId,
        claim.integrationAccountId,
        row.id,
        row.order_id,
        observation.externalOrderId,
        event.externalEventId,
        event.externalSubjectId,
        event.eventHash,
        event.eventKind,
        event.eventKind === 'provider_activity' ? null : event.eventStatus,
        event.quantity,
        event.amountMinor,
        event.currency,
        event.inventoryEffectKind,
        event.eventKind === 'provider_activity' ? 'unavailable' : event.attributionSource,
        event.eventKind === 'provider_activity' ? null : event.providerActorFingerprint,
        event.providerLocationId,
        event.trackingCarrier,
        event.trackingNumber,
        event.trackingUrl,
        event.occurredAt,
        sensitiveEvidenceRetentionDays(),
        observation.observedAt,
      ],
    )
    eventsAppended += Number(result.rowCount || 0)
  }
  await appendCommerceOrderTrackingUrlEvidenceWithClient(client, {
    organizationId: claim.organizationId, integrationAccountId: claim.integrationAccountId, provider: 'shopify',
  }, observation, row.id, urlEnrichments)
  await appendCommerceOrderNativeActivityWithClient(client, nativeScope, observation, row.id, nativeSnapshots)
  return {
    row,
    appended: 1,
    preserved: 0,
    linesAppended,
    eventsAppended,
  }
}

/**
 * Append or preserve the normalized exact read, write immutable completion
 * evidence, and acknowledge only the dirty version captured by this lease.
 */
export async function appendShopifyOrderWebhookExactReadInPostgres(input: {
  claim: ShopifyOrderWebhookTargetClaim
  providerReadLease: CommerceStoreSyncProviderReadLease
  observation: CommerceOrderObservationInput
  readAllOrdersScopeObserved: boolean
  returnHistoryScopeObserved: boolean
}) {
  const observation = normalizeCommerceOrderObservationInput(input.observation)
  if (
    observation.observationKind !== 'webhook_exact_read'
    || observation.externalOrderId !== input.claim.externalOrderId
    || observation.providerReadCount < 3 || observation.providerReadCount > 5
    || !observation.providerUpdatedAt
    || new Date(observation.providerUpdatedAt).getTime()
      < new Date(input.claim.claimedProviderUpdatedAt).getTime()
  ) {
    conflict(
      'SHOPIFY_ORDER_WEBHOOK_EXACT_READ_MISMATCH',
      'Shopify exact-order read does not cover the captured signed signal',
    )
  }
  return withTransaction(async (client) => {
    await assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(client, {
      organizationId: input.claim.organizationId,
      integrationAccountId: input.claim.integrationAccountId,
      lease: input.providerReadLease,
      authorityKind: 'automatic',
      readKind: 'shopify_webhook_hydration',
    })
    const target = await client.query(
      `SELECT 1
       FROM operations_shopify_order_webhook_targets target
       JOIN operations_integration_accounts account
         ON account.organization_id = target.organization_id
        AND account.id = target.integration_account_id
        AND account.global_id = $4
        AND account.integration_type = 'commerce'
        AND account.provider = 'shopify'
        AND account.status = 'active'
        AND account.commerce_credential_generation = target.credential_generation
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = target.credential_generation
        AND credential.external_account_id = account.external_account_id
        AND credential.auth_mode = 'shopify_client_credentials'
        AND credential.verification_status = 'verified'
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = target.organization_id
        AND policy.integration_account_id = target.integration_account_id
        AND policy.revision >= target.policy_revision
        AND policy.authority = 'provider'
        AND policy.continuous_observation_enabled
        AND policy.continuous_transport = 'webhook_signal_plus_poll'
        AND policy.provider_event_processor_state = 'available'
       JOIN operations_activation_scopes activation
         ON activation.organization_id = target.organization_id
        AND ${STORE_SYNC_RUNNING_SQL}
       WHERE target.organization_id = $1::uuid
         AND target.id = $2::uuid
         AND target.integration_account_id = $3::uuid
         AND target.credential_generation = $5
         AND target.policy_revision = $6
         AND target.external_order_id = $7
         AND target.claim_state = 'processing'
         AND target.claimed_dirty_version = $8
         AND target.claimed_signal_global_id = $9
         AND target.claimed_provider_updated_at = $10::timestamptz
         AND target.lock_token = $11::uuid
         AND target.lease_expires_at > clock_timestamp()
       FOR UPDATE OF target`,
      [
        input.claim.organizationId,
        input.claim.id,
        input.claim.integrationAccountId,
        input.claim.accountGlobalId,
        input.claim.credentialGeneration,
        input.claim.policyRevision,
        input.claim.externalOrderId,
        input.claim.capturedDirtyVersion,
        input.claim.signalGlobalId,
        input.claim.claimedProviderUpdatedAt,
        input.claim.lockToken,
      ],
    )
    if (!target.rows[0]) {
      conflict(
        'SHOPIFY_ORDER_WEBHOOK_CLAIM_STALE',
        'Shopify exact-order read claim is stale',
      )
    }
    const admission = await assessCommerceOrderHistoryAdmissionWithClient(
      client,
      {
        organizationId: input.claim.organizationId,
        integrationAccountId: input.claim.integrationAccountId,
        provider: 'shopify',
        externalOrderId: observation.externalOrderId,
        providerCreatedAt: observation.providerCreatedAt,
      },
    )
    if (admission.reason === 'policy_missing') {
      conflict(
        'COMMERCE_ORDER_HISTORY_POLICY_MISSING',
        'The immutable order-history policy is unavailable',
      )
    }
    if (admission.reason === 'provider_created_at_required') {
      conflict(
        'COMMERCE_ORDER_HISTORY_POLICY_EVIDENCE_INVALID',
        'Provider order creation time is required by the frozen history policy',
      )
    }
    const persisted = admission.admitted
      ? await insertExactObservation(client, input.claim, observation)
      : {
          row: null,
          appended: 0,
          preserved: 0,
          linesAppended: 0,
          eventsAppended: 0,
        }
    const read = await client.query<{ global_id: string }>(
      `INSERT INTO operations_shopify_order_webhook_reads (
         organization_id, integration_account_id, target_id,
         captured_dirty_version, lock_token, signal_global_id,
         observation_id, credential_generation, policy_revision,
         external_order_id, claimed_provider_updated_at,
         observed_provider_updated_at, source_hash,
         read_all_orders_scope_observed, return_history_scope_observed,
         provider_read_count, provider_write_count, observed_at,
         history_exclusion_code, excluded_provider_created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::uuid,
         $8, $9, $10, $11::timestamptz, $12::timestamptz, $13,
         $14, $15, $17, 0, $16::timestamptz, $18,
         $19::timestamptz
       )
       RETURNING global_id`,
      [
        input.claim.organizationId,
        input.claim.integrationAccountId,
        input.claim.id,
        input.claim.capturedDirtyVersion,
        input.claim.lockToken,
        input.claim.signalGlobalId,
        persisted.row?.id || null,
        input.claim.credentialGeneration,
        input.claim.policyRevision,
        input.claim.externalOrderId,
        input.claim.claimedProviderUpdatedAt,
        observation.providerUpdatedAt,
        observation.sourceHash,
        input.readAllOrdersScopeObserved,
        input.returnHistoryScopeObserved,
        observation.observedAt,
        observation.providerReadCount,
        admission.admitted
          ? null
          : 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED',
        admission.admitted ? null : observation.providerCreatedAt,
      ],
    )
    const completed = await client.query<{
      claim_state: 'pending' | 'idle'
      dirty_version: string | number
      reconciled_version: string | number
    }>(
      `UPDATE operations_shopify_order_webhook_targets
       SET reconciled_version = $4,
           last_reconciled_at = $5::timestamptz,
           claim_state = CASE
             WHEN dirty_version = $4 THEN 'idle' ELSE 'pending'
           END,
           claimed_dirty_version = NULL,
           claimed_signal_global_id = NULL,
           claimed_provider_updated_at = NULL,
           attempt_count = 0,
           available_at = clock_timestamp(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL,
           provider_read_count = provider_read_count + $7,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND integration_account_id = $3::uuid
         AND claim_state = 'processing'
         AND claimed_dirty_version = $4
         AND lock_token = $6::uuid
       RETURNING claim_state, dirty_version, reconciled_version`,
      [
        input.claim.organizationId,
        input.claim.id,
        input.claim.integrationAccountId,
        input.claim.capturedDirtyVersion,
        observation.observedAt,
        input.claim.lockToken,
        observation.providerReadCount,
      ],
    )
    if (!completed.rows[0]) {
      conflict(
        'SHOPIFY_ORDER_WEBHOOK_COMPLETION_STALE',
        'Shopify exact-order read could not acknowledge the captured signal',
      )
    }
    await recordAuditEvent({
      actor: null,
      eventType: 'commerce.shopify_order_webhook.exact_read_completed',
      aggregateType: 'operations.shopify_order_webhook_read',
      aggregateId: read.rows[0].global_id,
      organizationId: input.claim.organizationId,
      eventKey: `shopify-order-webhook-read:${read.rows[0].global_id}`,
      isSystem: true,
      payload: {
        accountGlobalId: input.claim.accountGlobalId,
        externalOrderId: input.claim.externalOrderId,
        capturedDirtyVersion: input.claim.capturedDirtyVersion,
        appended: persisted.appended,
        preserved: persisted.preserved,
        historyExcluded: !admission.admitted,
        providerReads: observation.providerReadCount,
        providerWrites: 0,
      },
    }, client)
    return Object.freeze({
      readGlobalId: read.rows[0].global_id,
      status: completed.rows[0].claim_state,
      dirtyVersion: Number(completed.rows[0].dirty_version),
      reconciledVersion: Number(completed.rows[0].reconciled_version),
      appended: persisted.appended,
      preserved: persisted.preserved,
      linesAppended: persisted.linesAppended,
      eventsAppended: persisted.eventsAppended,
      providerReads: observation.providerReadCount,
      providerWrites: 0 as const,
      historyExcluded: !admission.admitted,
    })
  })
}

export async function failShopifyOrderWebhookExactReadInPostgres(input: {
  claim: ShopifyOrderWebhookTargetClaim
  error: unknown
}) {
  const code = failureCode(input.error)
  return withTransaction(async (client) => {
    const result = await client.query<{
      claim_state: 'failed' | 'dead'
      attempt_count: number
    }>(
      `UPDATE operations_shopify_order_webhook_targets
       SET claim_state = CASE WHEN attempt_count >= 12 THEN 'dead'
                              ELSE 'failed' END,
           claimed_dirty_version = NULL,
           claimed_signal_global_id = NULL,
           claimed_provider_updated_at = NULL,
           available_at = clock_timestamp()
             + make_interval(secs => LEAST(1800, 30 * attempt_count)),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = $7,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND integration_account_id = $3::uuid
         AND credential_generation = $4
         AND policy_revision = $5
         AND claim_state = 'processing'
         AND claimed_dirty_version = $6
         AND lock_token = $8::uuid
       RETURNING claim_state, attempt_count`,
      [
        input.claim.organizationId,
        input.claim.id,
        input.claim.integrationAccountId,
        input.claim.credentialGeneration,
        input.claim.policyRevision,
        input.claim.capturedDirtyVersion,
        code,
        input.claim.lockToken,
      ],
    )
    if (!result.rows[0]) {
      return Object.freeze({
        status: 'stale' as const,
        errorCode: code,
        providerWrites: 0 as const,
      })
    }
    await recordAuditEvent({
      actor: null,
      eventType: 'commerce.shopify_order_webhook.exact_read_failed',
      aggregateType: 'operations.shopify_order_webhook_target',
      aggregateId: input.claim.id,
      organizationId: input.claim.organizationId,
      eventKey: `shopify-order-webhook-failed:${input.claim.id}:${input.claim.attemptCount}`,
      isSystem: true,
      payload: {
        accountGlobalId: input.claim.accountGlobalId,
        externalOrderId: input.claim.externalOrderId,
        capturedDirtyVersion: input.claim.capturedDirtyVersion,
        status: result.rows[0].claim_state,
        errorCode: code,
        providerWrites: 0,
      },
    }, client)
    return Object.freeze({
      status: result.rows[0].claim_state,
      attemptCount: result.rows[0].attempt_count,
      errorCode: code,
      providerWrites: 0 as const,
    })
  })
}

export async function parkShopifyOrderWebhookExactReadForStoreSyncPauseInPostgres(
  input: { claim: ShopifyOrderWebhookTargetClaim },
) {
  const parked = await query(
    `UPDATE operations_shopify_order_webhook_targets
     SET claim_state = 'pending',
         claimed_dirty_version = NULL,
         claimed_signal_global_id = NULL,
         claimed_provider_updated_at = NULL,
         attempt_count = GREATEST(0, attempt_count - 1),
         available_at = clock_timestamp(),
         locked_at = NULL,
         locked_by = NULL,
         lock_token = NULL,
         lease_expires_at = NULL,
         last_error_code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
         updated_at = clock_timestamp()
     WHERE organization_id = $1::uuid
       AND id = $2::uuid
       AND integration_account_id = $3::uuid
       AND credential_generation = $4
       AND policy_revision = $5
       AND claim_state = 'processing'
       AND claimed_dirty_version = $6
       AND lock_token = $7::uuid
     RETURNING id`,
    [
      input.claim.organizationId,
      input.claim.id,
      input.claim.integrationAccountId,
      input.claim.credentialGeneration,
      input.claim.policyRevision,
      input.claim.capturedDirtyVersion,
      input.claim.lockToken,
    ],
  )
  return { parked: parked.rowCount === 1 }
}

export async function readShopifyOrderWebhookSignalHealthFromPostgres() {
  const result = await query<{
    pending_dirty: number
    processing: number
    stale_processing: number
    failed: number
    dead: number
    overdue_dirty: number
    paused_retained_dirty: number
    last_signaled_at: Date | string | null
    last_succeeded_at: Date | string | null
    last_failed_at: Date | string | null
    last_processed_at: Date | string | null
  }>(
    `SELECT
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND claim_state = 'pending'
       )::integer AS pending_dirty,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND claim_state = 'processing'
       )::integer AS processing,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND claim_state = 'processing'
           AND lease_expires_at <= clock_timestamp()
       )::integer AS stale_processing,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND claim_state = 'failed'
       )::integer AS failed,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND claim_state = 'dead'
       )::integer AS dead,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
           AND available_at <= clock_timestamp()
           AND (
             claim_state IN ('pending', 'failed')
             OR (
               claim_state = 'processing'
               AND lease_expires_at <= clock_timestamp()
             )
           )
       )::integer AS overdue_dirty,
       count(*) FILTER (
         WHERE dirty_version > reconciled_version
           AND NOT operations_commerce_store_sync_is_running(
             target.organization_id, target.integration_account_id
           )
       )::integer AS paused_retained_dirty,
       max(last_signaled_at) AS last_signaled_at,
       max(last_reconciled_at) AS last_succeeded_at,
       max(updated_at) FILTER (
         WHERE claim_state IN ('failed', 'dead')
       ) AS last_failed_at,
       GREATEST(
         max(last_reconciled_at),
         max(updated_at) FILTER (
           WHERE claim_state IN ('failed', 'dead')
         )
       ) AS last_processed_at
     FROM operations_shopify_order_webhook_targets target`,
  )
  const row = result.rows[0]
  const iso = (value: Date | string | null | undefined) => value
    ? new Date(value).toISOString()
    : null
  return Object.freeze({
    pendingDirty: Number(row?.pending_dirty || 0),
    processing: Number(row?.processing || 0),
    staleProcessing: Number(row?.stale_processing || 0),
    failed: Number(row?.failed || 0),
    dead: Number(row?.dead || 0),
    overdueDirty: Number(row?.overdue_dirty || 0),
    pausedRetainedDirty: Number(row?.paused_retained_dirty || 0),
    lastSignaledAt: iso(row?.last_signaled_at),
    lastSucceededAt: iso(row?.last_succeeded_at),
    lastFailedAt: iso(row?.last_failed_at),
    lastProcessedAt: iso(row?.last_processed_at),
    providerWrites: 0 as const,
  })
}
