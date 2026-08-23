import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  commerceAuthorityCapability,
  commerceAuthorityDefaults,
  commerceAuthorityHistoricalCoverageReady,
  DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
  isCommerceAuthorityProvider,
  isCommerceAuthorityResource,
  type CommerceAuthorityCapability,
  type CommerceAuthorityMode,
  type CommerceAuthorityProvider,
  type CommerceAuthorityResource,
  type CommerceDesiredIngestMode,
  type CommerceProviderWriteMode,
} from '@/lib/integrations/commerceAuthorityPolicy'
import {
  SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS,
} from '@/lib/integrations/shopifyOrderWebhook'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const POLICY_GLOBAL_ID = /^gaup(?:[0-9]{7}|[0-9a-v]{12})$/u
const SCOPE_REQUEST_GLOBAL_ID = /^gaud(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const SHA256 = /^[a-f0-9]{64}$/u

type TimestampValue = string | Date

type PolicyRow = {
  account_global_id: string
  account_display_name: string
  account_environment: 'mock' | 'sandbox' | 'production'
  account_status: string
  provider: string
  resource: string
  global_id: string | null
  revision: string | number | null
  authority_mode: string
  desired_ingest_mode: string
  provider_write_mode: string
  provider_write_count: string | number
  expected_previous_revision: string | number | null
  reason: string | null
  actor_email: string | null
  actor_role: string | null
  idempotency_key: string | null
  request_hash: string | null
  created_at: TimestampValue | null
  credential_verification_status: string | null
  credential_current: boolean
  webhook_verification_status: string | null
  activation_state: string | null
  activation_revision: string | number | null
  store_sync_running: boolean
  store_sync_effective_reason: string | null
  order_policy_revision: string | number | null
  historical_observation_enabled: boolean | null
  continuous_observation_enabled: boolean | null
  continuous_transport: string | null
  provider_event_processor_state: string | null
  continuous_high_watermark: TimestampValue | null
  continuous_next_poll_at: TimestampValue | null
  historical_backfill_status: string | null
  historical_backfill_completeness_state: string | null
  historical_backfill_coverage_basis: string | null
  historical_backfill_completed_at: TimestampValue | null
  continuous_poll_status: string | null
  continuous_poll_requested_through: TimestampValue | null
  continuous_poll_completed_at: TimestampValue | null
  continuous_poll_last_error_code: string | null
  continuous_poll_fresh: boolean
  continuous_cadence_current: boolean
  shopify_inventory_job_status: string | null
  shopify_inventory_job_completed_at: TimestampValue | null
  shopify_inventory_last_error_code: string | null
  shopify_inventory_max_age_seconds: string | number | null
  shopify_inventory_fresh: boolean
  shopify_inventory_watermark_clean: boolean | null
  shopify_inventory_last_reconciled_at: TimestampValue | null
  shopify_inventory_subscription_ready: boolean
  shopify_inventory_subscription_desired_uri: string | null
  shopify_inventory_subscription_observed_at: string | null
  shopify_inventory_subscription_missing_count: string | number | null
  shopify_inventory_subscription_conflicting_count: string | number | null
  shopify_order_subscription_ready: boolean
  shopify_order_subscription_desired_uri: string | null
  shopify_order_subscription_observed_at: string | null
  shopify_order_subscription_missing_count: string | number | null
  shopify_order_subscription_conflicting_count: string | number | null
  faire_inventory_poll_status: string | null
  faire_inventory_poll_completed_at: TimestampValue | null
  faire_inventory_poll_last_error_code: string | null
  faire_inventory_observation_fresh: boolean
}

type ScopeRequestRow = {
  global_id: string
  account_global_id: string
  provider: string
  account_environment: string
  deployment_scope: string
  requested_resources: string[]
  state: string
  provider_write_enabled: boolean
  supported_outbound_effect: string | null
  blocker_codes: string[]
  customer_global_id: string
  product_global_id: string
  product_mapping_global_id: string
  channel_sku: string
  external_product_id: string
  external_variant_id: string
  external_inventory_item_id: string
  request_reason: string
  recorded_by: string
  created_at: TimestampValue
}

type AccountRow = {
  id: string
  global_id: string
  provider: string
  environment: 'mock' | 'sandbox' | 'production'
  display_name: string
  status: string
  credential_verification_status: string | null
  credential_current: boolean
}

type PolicyRevisionRow = {
  global_id: string
  revision: string | number
  authority_mode: string
  desired_ingest_mode: string
  provider_write_mode: string
  provider_write_count: string | number
  expected_previous_revision: string | number
  reason: string
  actor_email: string
  actor_role: string
  idempotency_key: string
  request_hash: string
  created_at: TimestampValue
}

export type CommerceAuthorityActualReadiness = {
  state:
    | 'ready'
    | 'degraded'
    | 'not_configured'
    | 'unavailable'
    | 'observation_only'
  accountStatus: 'active' | 'disabled' | 'error'
  credentialStatus: 'missing' | 'unverified' | 'verified' | 'failed'
  credentialCurrent: boolean
  policyChangeAllowed: boolean
  blockerCodes: string[]
  evidence: {
    webhookVerificationStatus: string | null
    activationState: string | null
    activationRevision: number | null
    storeSyncRunning: boolean
    storeSyncEffectiveReason: string | null
    orderPolicyRevision: number | null
    historicalObservationEnabled: boolean | null
    continuousObservationEnabled: boolean | null
    continuousTransport: string | null
    providerEventProcessorState: string | null
    continuousHighWatermark: string | null
    continuousNextPollAt: string | null
    continuousPollFresh: boolean
    continuousCadenceCurrent: boolean
    continuousTransportAvailable: boolean
    realtimeTransportAvailable: boolean
    historicalBackfillStatus: string | null
    historicalBackfillCompletenessState: string | null
    historicalBackfillCoverageBasis: string | null
    historicalBackfillCompletedAt: string | null
    continuousPollStatus: string | null
    continuousPollRequestedThrough: string | null
    continuousPollCompletedAt: string | null
    continuousPollLastErrorCode: string | null
    shopifyInventoryJobStatus: string | null
    shopifyInventoryJobCompletedAt: string | null
    shopifyInventoryLastErrorCode: string | null
    shopifyInventoryMaxAgeSeconds: number | null
    shopifyInventoryFresh: boolean
    shopifyInventoryWatermarkClean: boolean | null
    shopifyInventoryLastReconciledAt: string | null
    shopifyInventorySubscriptionReady: boolean
    shopifyInventorySubscriptionDesiredUri: string | null
    shopifyInventorySubscriptionObservedAt: string | null
    shopifyInventorySubscriptionMissingCount: number | null
    shopifyInventorySubscriptionConflictingCount: number | null
    shopifyOrderSubscriptionReady: boolean
    shopifyOrderSubscriptionDesiredUri: string | null
    shopifyOrderSubscriptionObservedAt: string | null
    shopifyOrderSubscriptionMissingCount: number | null
    shopifyOrderSubscriptionConflictingCount: number | null
    faireInventoryPollStatus: string | null
    faireInventoryPollCompletedAt: string | null
    faireInventoryPollLastErrorCode: string | null
    faireInventoryObservationFresh: boolean
  }
}

export type CommerceAuthorityPolicy = {
  accountGlobalId: string
  accountDisplayName: string
  accountEnvironment: 'mock' | 'sandbox' | 'production'
  provider: CommerceAuthorityProvider
  resource: CommerceAuthorityResource
  policyGlobalId: string | null
  revision: number
  authorityMode: CommerceAuthorityMode
  desiredIngestMode: CommerceDesiredIngestMode
  providerWriteMode: CommerceProviderWriteMode
  providerWriteCount: 0
  effectiveFromDefault: boolean
  expectedPreviousRevision: number
  reason: string | null
  actorEmail: string | null
  actorRole: 'owner' | 'admin' | null
  idempotencyKey: string | null
  requestHash: string | null
  createdAt: string | null
  capability: CommerceAuthorityCapability
  actualReadiness: CommerceAuthorityActualReadiness
}

export type CommerceProviderWriteScopeRequest = {
  requestGlobalId: string
  accountGlobalId: string
  provider: 'shopify'
  accountEnvironment: 'sandbox'
  deploymentScope: 'development'
  requestedResources: ['orders', 'inventory']
  state: 'blocked'
  providerWriteEnabled: false
  supportedOutboundEffect: null
  blockerCodes: [
    'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
    'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
  ]
  customerGlobalId: string
  productGlobalId: string
  productMappingGlobalId: string
  channelSku: string
  externalProductId: string
  externalVariantId: string
  externalInventoryItemId: string
  requestReason: string
  recordedBy: string
  createdAt: string
}

export type CommerceAuthorityPolicyState = {
  organizationId: string
  policies: CommerceAuthorityPolicy[]
  providerWriteScopeRequests: CommerceProviderWriteScopeRequest[]
}

export type SetCommerceAuthorityPolicyResult = {
  policy: CommerceAuthorityPolicy
  replayed: boolean
}

export class CommerceAuthorityPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'CommerceAuthorityPolicyError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new CommerceAuthorityPolicyError(code, message, status)
}

function organizationId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID.test(normalized)) {
    fail('COMMERCE_AUTHORITY_ORGANIZATION_INVALID', 'Active organization is invalid', 400)
  }
  return normalized
}

function accountGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!ACCOUNT_GLOBAL_ID.test(normalized)) {
    fail('COMMERCE_AUTHORITY_ACCOUNT_INVALID', 'Commerce account is invalid', 400)
  }
  return normalized
}

function actorEmail(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized || normalized.length > 320 || !normalized.includes('@')
      || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('COMMERCE_AUTHORITY_ACTOR_INVALID', 'A signed-in owner or administrator is required', 401)
  }
  return normalized
}

function actorRole(value: unknown): 'owner' | 'admin' {
  if (value !== 'owner' && value !== 'admin') {
    fail('COMMERCE_AUTHORITY_ROLE_FORBIDDEN', 'Organization owner or administrator access is required', 403)
  }
  return value
}

function resource(value: unknown): CommerceAuthorityResource {
  if (!isCommerceAuthorityResource(value)) {
    fail('COMMERCE_AUTHORITY_RESOURCE_INVALID', 'Commerce authority resource is invalid', 400)
  }
  return value
}

function requestedAuthorityMode(value: unknown): CommerceAuthorityMode {
  if (value === 'clawpilot') {
    fail(
      'COMMERCE_AUTHORITY_OUTBOUND_CAPABILITY_UNAVAILABLE',
      'ClawPilot authority remains unavailable until an exact outbound effect and activation fence are implemented',
    )
  }
  if (value !== 'provider' && value !== 'observation_only') {
    fail('COMMERCE_AUTHORITY_MODE_INVALID', 'Commerce authority mode is invalid', 400)
  }
  return value
}

function expectedRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0
      || Number(value) > Number.MAX_SAFE_INTEGER - 1) {
    fail('COMMERCE_AUTHORITY_EXPECTED_REVISION_INVALID', 'Expected authority policy revision is invalid', 400)
  }
  return Number(value)
}

function reason(value: unknown) {
  if (typeof value !== 'string' || value !== value.trim()
      || value.length < 10 || value.length > 500
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('COMMERCE_AUTHORITY_REASON_INVALID', 'A 10-500 character policy reason is required', 400)
  }
  return value
}

function idempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    fail('COMMERCE_AUTHORITY_IDEMPOTENCY_KEY_INVALID', 'A valid Idempotency-Key header is required', 400)
  }
  return value
}

function numberValue(value: string | number | null | undefined) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function exactProvider(value: unknown): CommerceAuthorityProvider {
  if (!isCommerceAuthorityProvider(value)) {
    fail('COMMERCE_AUTHORITY_PROVIDER_UNSUPPORTED', 'Only Shopify and Faire authority policies are supported', 409)
  }
  return value
}

function exactAccountStatus(value: string): 'active' | 'disabled' | 'error' {
  if (value !== 'active' && value !== 'disabled' && value !== 'error') {
    fail('COMMERCE_AUTHORITY_ACCOUNT_EVIDENCE_INVALID', 'Commerce account evidence is invalid', 500)
  }
  return value
}

function policyHash(input: {
  organizationId: string
  accountGlobalId: string
  provider: CommerceAuthorityProvider
  resource: CommerceAuthorityResource
  authorityMode: CommerceAuthorityMode
  desiredIngestMode: CommerceDesiredIngestMode
  expectedRevision: number
  reason: string
  actorEmail: string
  actorRole: 'owner' | 'admin'
}) {
  return createHash('sha256').update(JSON.stringify({
    version: 'commerce-authority-policy-v2',
    ...input,
    providerWriteMode: DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
  })).digest('hex')
}

function readiness(row: PolicyRow): CommerceAuthorityActualReadiness {
  const provider = exactProvider(row.provider)
  const accountStatus = exactAccountStatus(row.account_status)
  const credentialStatus = row.credential_verification_status === null
    ? 'missing'
    : row.credential_verification_status === 'verified'
      ? 'verified'
      : row.credential_verification_status === 'failed'
        ? 'failed'
        : 'unverified'
  const blockers: string[] = []
  if (accountStatus !== 'active') {
    blockers.push(`COMMERCE_AUTHORITY_ACCOUNT_${accountStatus.toUpperCase()}`)
  }
  if (credentialStatus !== 'verified') {
    blockers.push(`COMMERCE_AUTHORITY_CREDENTIAL_${credentialStatus.toUpperCase()}`)
  } else if (!row.credential_current) {
    blockers.push('COMMERCE_AUTHORITY_CREDENTIAL_STALE')
  }
  const accountAvailable = accountStatus === 'active'
    && credentialStatus === 'verified'
    && row.credential_current
  const storeSyncAvailable = row.store_sync_running === true
  if (!storeSyncAvailable) {
    blockers.push('COMMERCE_AUTHORITY_STORE_SYNC_PAUSED')
    if (row.store_sync_effective_reason) {
      blockers.push(row.store_sync_effective_reason)
    }
  }
  const baseAvailable = accountAvailable && storeSyncAvailable
  const realtimeTransportAvailable = provider === 'shopify'
    && row.continuous_transport === 'webhook_signal_plus_poll'
    && row.provider_event_processor_state === 'available'
    && row.webhook_verification_status === 'verified'
    && row.shopify_order_subscription_ready
  const continuousTransportAvailable = provider === 'shopify'
    ? realtimeTransportAvailable
    : row.continuous_transport === 'scheduled_poll'
      && row.provider_event_processor_state === 'unsupported'
  let state: CommerceAuthorityActualReadiness['state'] = 'unavailable'
  if (baseAvailable && row.provider === 'faire' && row.resource === 'inventory') {
    state = 'observation_only'
    blockers.push('COMMERCE_FAIRE_INVENTORY_OBSERVATION_ONLY')
    if (!row.faire_inventory_poll_status) {
      blockers.push('COMMERCE_FAIRE_INVENTORY_POLL_NOT_OBSERVED')
    } else if (row.faire_inventory_poll_status !== 'succeeded') {
      blockers.push('COMMERCE_FAIRE_INVENTORY_POLL_UNREADY')
    } else if (!row.faire_inventory_observation_fresh) {
      blockers.push('COMMERCE_FAIRE_INVENTORY_OBSERVATION_STALE')
    }
  } else if (baseAvailable && row.resource === 'orders') {
    if (row.order_policy_revision === null) {
      state = 'not_configured'
      blockers.push('COMMERCE_ORDER_SYNC_NOT_CONFIGURED')
    } else {
      const historicalComplete = commerceAuthorityHistoricalCoverageReady({
        provider,
        enabled: row.historical_observation_enabled === true,
        status: row.historical_backfill_status,
        completenessState: row.historical_backfill_completeness_state,
      })
      const ready = historicalComplete
        && row.continuous_observation_enabled === true
        && row.continuous_poll_status === 'succeeded'
        && row.continuous_poll_fresh
        && row.continuous_cadence_current
        && continuousTransportAvailable
      state = ready ? 'ready' : 'degraded'
      if (!historicalComplete) {
        blockers.push('COMMERCE_ORDER_HISTORICAL_COVERAGE_INCOMPLETE')
      }
      if (row.continuous_observation_enabled !== true) {
        blockers.push('COMMERCE_ORDER_CONTINUOUS_OBSERVATION_DISABLED')
      }
      if (row.continuous_poll_status !== 'succeeded') {
        blockers.push('COMMERCE_ORDER_CONTINUOUS_POLL_UNREADY')
      } else if (!row.continuous_poll_fresh) {
        blockers.push('COMMERCE_ORDER_CONTINUOUS_POLL_STALE')
      }
      if (!row.continuous_cadence_current) {
        blockers.push('COMMERCE_ORDER_CONTINUOUS_CADENCE_OVERDUE')
      }
      if (provider === 'shopify') {
        if (row.continuous_transport !== 'webhook_signal_plus_poll') {
          blockers.push('COMMERCE_ORDER_REALTIME_TRANSPORT_UNAVAILABLE')
        }
        if (row.provider_event_processor_state !== 'available') {
          blockers.push(
            row.provider_event_processor_state === 'processor_pending'
              ? 'COMMERCE_ORDER_EVENT_PROCESSOR_PENDING'
              : 'COMMERCE_ORDER_EVENT_PROCESSOR_UNAVAILABLE',
          )
        }
        if (row.webhook_verification_status !== 'verified') {
          blockers.push('COMMERCE_ORDER_WEBHOOK_SECRET_UNVERIFIED')
        }
        if (!row.shopify_order_subscription_ready) {
          blockers.push('COMMERCE_ORDER_WEBHOOK_SUBSCRIPTIONS_UNREADY')
        }
      } else {
        if (row.continuous_transport !== 'scheduled_poll') {
          blockers.push(
            'COMMERCE_ORDER_CONTINUOUS_POLL_TRANSPORT_UNAVAILABLE',
          )
        }
        if (row.provider_event_processor_state !== 'unsupported') {
          blockers.push(
            'COMMERCE_ORDER_FAIRE_EVENT_PROCESSOR_STATE_INVALID',
          )
        }
      }
    }
  } else if (baseAvailable) {
    if (!row.shopify_inventory_job_status) {
      state = 'not_configured'
      blockers.push('COMMERCE_SHOPIFY_INVENTORY_REFRESH_NOT_OBSERVED')
    } else {
      const ready = row.shopify_inventory_job_status === 'succeeded'
        && row.shopify_inventory_fresh
        && row.shopify_inventory_watermark_clean === true
        && row.webhook_verification_status === 'verified'
        && row.shopify_inventory_subscription_ready
      state = ready ? 'ready' : 'degraded'
      if (row.shopify_inventory_job_status !== 'succeeded') {
        blockers.push('COMMERCE_SHOPIFY_INVENTORY_REFRESH_UNREADY')
      } else if (!row.shopify_inventory_fresh) {
        blockers.push('COMMERCE_SHOPIFY_INVENTORY_REFRESH_STALE')
      }
      if (row.shopify_inventory_watermark_clean !== true) {
        blockers.push('COMMERCE_SHOPIFY_INVENTORY_WATERMARK_DIRTY')
      }
      if (row.webhook_verification_status !== 'verified') {
        blockers.push('COMMERCE_SHOPIFY_INVENTORY_REALTIME_UNVERIFIED')
      }
      if (!row.shopify_inventory_subscription_ready) {
        blockers.push(
          'COMMERCE_SHOPIFY_INVENTORY_SUBSCRIPTION_UNREADY',
        )
      }
    }
  }
  return {
    state,
    accountStatus,
    credentialStatus,
    credentialCurrent: row.credential_current,
    policyChangeAllowed: accountAvailable,
    blockerCodes: blockers,
    evidence: {
      webhookVerificationStatus: row.webhook_verification_status,
      activationState: row.activation_state,
      activationRevision: row.activation_revision === null
        ? null : numberValue(row.activation_revision),
      storeSyncRunning: row.store_sync_running,
      storeSyncEffectiveReason: row.store_sync_effective_reason,
      orderPolicyRevision: row.order_policy_revision === null
        ? null : numberValue(row.order_policy_revision),
      historicalObservationEnabled: row.historical_observation_enabled,
      continuousObservationEnabled: row.continuous_observation_enabled,
      continuousTransport: row.continuous_transport,
      providerEventProcessorState: row.provider_event_processor_state,
      continuousHighWatermark: iso(row.continuous_high_watermark),
      continuousNextPollAt: iso(row.continuous_next_poll_at),
      continuousPollFresh: row.continuous_poll_fresh,
      continuousCadenceCurrent: row.continuous_cadence_current,
      continuousTransportAvailable,
      realtimeTransportAvailable,
      historicalBackfillStatus: row.historical_backfill_status,
      historicalBackfillCompletenessState:
        row.historical_backfill_completeness_state,
      historicalBackfillCoverageBasis: row.historical_backfill_coverage_basis,
      historicalBackfillCompletedAt: iso(row.historical_backfill_completed_at),
      continuousPollStatus: row.continuous_poll_status,
      continuousPollRequestedThrough: iso(row.continuous_poll_requested_through),
      continuousPollCompletedAt: iso(row.continuous_poll_completed_at),
      continuousPollLastErrorCode: row.continuous_poll_last_error_code,
      shopifyInventoryJobStatus: row.shopify_inventory_job_status,
      shopifyInventoryJobCompletedAt: iso(row.shopify_inventory_job_completed_at),
      shopifyInventoryLastErrorCode: row.shopify_inventory_last_error_code,
      shopifyInventoryMaxAgeSeconds:
        row.shopify_inventory_max_age_seconds === null
          ? null : numberValue(row.shopify_inventory_max_age_seconds),
      shopifyInventoryFresh: row.shopify_inventory_fresh,
      shopifyInventoryWatermarkClean: row.shopify_inventory_watermark_clean,
      shopifyInventoryLastReconciledAt: iso(row.shopify_inventory_last_reconciled_at),
      shopifyInventorySubscriptionReady:
        row.shopify_inventory_subscription_ready,
      shopifyInventorySubscriptionDesiredUri:
        row.shopify_inventory_subscription_desired_uri,
      shopifyInventorySubscriptionObservedAt:
        row.shopify_inventory_subscription_observed_at,
      shopifyInventorySubscriptionMissingCount:
        row.shopify_inventory_subscription_missing_count === null
          ? null
          : numberValue(row.shopify_inventory_subscription_missing_count),
      shopifyInventorySubscriptionConflictingCount:
        row.shopify_inventory_subscription_conflicting_count === null
          ? null
          : numberValue(row.shopify_inventory_subscription_conflicting_count),
      shopifyOrderSubscriptionReady: row.shopify_order_subscription_ready,
      shopifyOrderSubscriptionDesiredUri:
        row.shopify_order_subscription_desired_uri,
      shopifyOrderSubscriptionObservedAt:
        row.shopify_order_subscription_observed_at,
      shopifyOrderSubscriptionMissingCount:
        row.shopify_order_subscription_missing_count === null
          ? null
          : numberValue(row.shopify_order_subscription_missing_count),
      shopifyOrderSubscriptionConflictingCount:
        row.shopify_order_subscription_conflicting_count === null
          ? null
          : numberValue(row.shopify_order_subscription_conflicting_count),
      faireInventoryPollStatus: row.faire_inventory_poll_status,
      faireInventoryPollCompletedAt: iso(row.faire_inventory_poll_completed_at),
      faireInventoryPollLastErrorCode: row.faire_inventory_poll_last_error_code,
      faireInventoryObservationFresh: row.faire_inventory_observation_fresh,
    },
  }
}

function mapPolicy(row: PolicyRow): CommerceAuthorityPolicy {
  const provider = exactProvider(row.provider)
  const exactResource = resource(row.resource)
  const defaults = commerceAuthorityDefaults(provider, exactResource)
  const persisted = row.global_id !== null
  if (row.authority_mode !== defaults.authorityMode
      || row.desired_ingest_mode !== defaults.desiredIngestMode
      || row.provider_write_mode !== defaults.providerWriteMode
      || numberValue(row.provider_write_count) !== 0
      || (persisted && (
        !POLICY_GLOBAL_ID.test(row.global_id || '')
        || (row.actor_role !== 'owner' && row.actor_role !== 'admin')
        || !row.request_hash || !SHA256.test(row.request_hash)
      ))) {
    fail('COMMERCE_AUTHORITY_POLICY_EVIDENCE_INVALID', 'Commerce authority policy evidence is invalid', 500)
  }
  return {
    accountGlobalId: row.account_global_id,
    accountDisplayName: row.account_display_name,
    accountEnvironment: row.account_environment,
    provider,
    resource: exactResource,
    policyGlobalId: persisted ? row.global_id : null,
    revision: persisted ? numberValue(row.revision) : 0,
    authorityMode: defaults.authorityMode,
    desiredIngestMode: defaults.desiredIngestMode,
    providerWriteMode: defaults.providerWriteMode,
    providerWriteCount: 0,
    effectiveFromDefault: !persisted,
    expectedPreviousRevision: persisted ? numberValue(row.expected_previous_revision) : 0,
    reason: persisted ? row.reason : null,
    actorEmail: persisted ? row.actor_email : null,
    actorRole: persisted ? row.actor_role as 'owner' | 'admin' : null,
    idempotencyKey: persisted ? row.idempotency_key : null,
    requestHash: persisted ? row.request_hash : null,
    createdAt: persisted ? iso(row.created_at) : null,
    capability: commerceAuthorityCapability(provider, exactResource),
    actualReadiness: readiness(row),
  }
}

function mapScopeRequest(row: ScopeRequestRow): CommerceProviderWriteScopeRequest {
  const exactBlockers = [
    'COMMERCE_ORDER_WRITE_ADAPTER_UNAVAILABLE',
    'COMMERCE_CUSTOMER_SCOPED_INVENTORY_NOT_REPRESENTABLE',
  ]
  if (!SCOPE_REQUEST_GLOBAL_ID.test(row.global_id)
      || row.provider !== 'shopify'
      || row.account_environment !== 'sandbox'
      || row.deployment_scope !== 'development'
      || row.requested_resources.join(':') !== 'orders:inventory'
      || row.state !== 'blocked'
      || row.provider_write_enabled !== false
      || row.supported_outbound_effect !== null
      || row.blocker_codes.join(':') !== exactBlockers.join(':')) {
    fail('COMMERCE_PROVIDER_WRITE_SCOPE_EVIDENCE_INVALID', 'Commerce provider-write scope request evidence is invalid', 500)
  }
  return {
    requestGlobalId: row.global_id,
    accountGlobalId: row.account_global_id,
    provider: 'shopify',
    accountEnvironment: 'sandbox',
    deploymentScope: 'development',
    requestedResources: ['orders', 'inventory'],
    state: 'blocked',
    providerWriteEnabled: false,
    supportedOutboundEffect: null,
    blockerCodes: exactBlockers as CommerceProviderWriteScopeRequest['blockerCodes'],
    customerGlobalId: row.customer_global_id,
    productGlobalId: row.product_global_id,
    productMappingGlobalId: row.product_mapping_global_id,
    channelSku: row.channel_sku,
    externalProductId: row.external_product_id,
    externalVariantId: row.external_variant_id,
    externalInventoryItemId: row.external_inventory_item_id,
    requestReason: row.request_reason,
    recordedBy: row.recorded_by,
    createdAt: iso(row.created_at) || new Date(0).toISOString(),
  }
}

const POLICY_SELECT = `SELECT
  current_policy.account_global_id,
  current_policy.account_display_name,
  current_policy.account_environment,
  current_policy.account_status,
  current_policy.provider,
  current_policy.resource,
  current_policy.global_id,
  current_policy.revision,
  current_policy.authority_mode,
  current_policy.desired_ingest_mode,
  current_policy.provider_write_mode,
  current_policy.provider_write_count,
  current_policy.expected_previous_revision,
  current_policy.reason,
  current_policy.actor_email,
  current_policy.actor_role,
  current_policy.idempotency_key,
  current_policy.request_hash,
  current_policy.created_at,
  credential.verification_status AS credential_verification_status,
  COALESCE(
    credential.credential_version = account.commerce_credential_generation
      AND credential.external_account_id = account.external_account_id,
      false
  ) AND COALESCE(
    (account.provider = 'shopify'
      AND credential.auth_mode = 'shopify_client_credentials')
      OR (account.provider = 'faire'
        AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth')),
    false
  ) AS credential_current,
  credential.webhook_verification_status,
  activation.state AS activation_state,
  activation.revision AS activation_revision,
  operations_commerce_store_sync_is_running(
    account.organization_id,
    account.id
  ) AS store_sync_running,
  operations_commerce_store_sync_effective_reason(
    account.organization_id,
    account.id
  ) AS store_sync_effective_reason,
  order_policy.revision AS order_policy_revision,
  order_policy.historical_observation_enabled,
  order_policy.continuous_observation_enabled,
  order_policy.continuous_transport,
  order_policy.provider_event_processor_state,
  order_policy.continuous_high_watermark,
  order_policy.continuous_next_poll_at,
  historical_backfill.status AS historical_backfill_status,
  historical_backfill.completeness_state
    AS historical_backfill_completeness_state,
  historical_backfill.coverage_basis AS historical_backfill_coverage_basis,
  historical_backfill.completed_at AS historical_backfill_completed_at,
  continuous_poll.status AS continuous_poll_status,
  continuous_poll.requested_through AS continuous_poll_requested_through,
  continuous_poll.completed_at AS continuous_poll_completed_at,
  continuous_poll.last_error_code AS continuous_poll_last_error_code,
  COALESCE(
    continuous_poll.status = 'succeeded'
      AND continuous_poll.completed_at >=
            clock_timestamp() - CASE
              WHEN current_policy.provider = 'faire'
                THEN interval '5 minutes'
              ELSE interval '30 minutes'
            END
      AND continuous_poll.completed_at <=
            clock_timestamp() + interval '5 minutes'
      AND continuous_poll.requested_through >=
            clock_timestamp() - CASE
              WHEN current_policy.provider = 'faire'
                THEN interval '5 minutes'
              ELSE interval '30 minutes'
            END
      AND continuous_poll.requested_through <=
            clock_timestamp() + interval '5 minutes'
      AND order_policy.continuous_high_watermark >=
            clock_timestamp() - CASE
              WHEN current_policy.provider = 'faire'
                THEN interval '5 minutes'
              ELSE interval '30 minutes'
            END
      AND order_policy.continuous_high_watermark <=
            clock_timestamp() + interval '5 minutes',
    false
  ) AS continuous_poll_fresh,
  COALESCE(
    order_policy.continuous_next_poll_at > clock_timestamp()
      AND order_policy.continuous_next_poll_at <=
            clock_timestamp() + CASE
              WHEN current_policy.provider = 'faire'
                THEN interval '10 minutes'
              ELSE interval '35 minutes'
            END,
    false
  ) AS continuous_cadence_current,
  shopify_job.status AS shopify_inventory_job_status,
  shopify_job.completed_at AS shopify_inventory_job_completed_at,
  shopify_job.last_error_code AS shopify_inventory_last_error_code,
  shopify_job.inventory_max_age_seconds
    AS shopify_inventory_max_age_seconds,
  COALESCE(
    shopify_job.status = 'succeeded'
      AND shopify_job.completed_at >= clock_timestamp()
            - make_interval(secs => shopify_job.inventory_max_age_seconds)
      AND shopify_job.completed_at <=
            clock_timestamp() + interval '5 minutes'
      AND watermark.last_reconciled_at >= clock_timestamp()
            - make_interval(secs => shopify_job.inventory_max_age_seconds)
      AND watermark.last_reconciled_at <=
            clock_timestamp() + interval '5 minutes',
    false
  ) AS shopify_inventory_fresh,
  CASE WHEN watermark.integration_account_id IS NULL THEN NULL
       ELSE watermark.dirty_version = watermark.reconciled_version END
    AS shopify_inventory_watermark_clean,
  watermark.last_reconciled_at AS shopify_inventory_last_reconciled_at,
  COALESCE(
    current_policy.provider = 'shopify'
      AND current_policy.resource = 'orders'
      AND credential.webhook_verification_status = 'verified'
      AND jsonb_typeof(
            account.configuration->'orderWebhookSubscriptions'
          ) = 'object'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,accountGlobalId}' = account.global_id
      AND account.configuration #>>
            '{orderWebhookSubscriptions,credentialGeneration}' =
              account.commerce_credential_generation::text
      AND account.configuration #>>
            '{orderWebhookSubscriptions,discoveryState}' = 'succeeded'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,subscriptionReady}' = 'true'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,exactReadProcessorReady}' = 'true'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,scheduledPollBackstop}' = 'true'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,ready}' = 'true'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,processorState}' = 'available'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,providerWrites}' = '0'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,observedCount}' = '7'
      AND account.configuration #>>
            '{orderWebhookSubscriptions,matchingCount}' = '7'
      AND jsonb_typeof(
            account.configuration #>
              '{orderWebhookSubscriptions,requiredTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{orderWebhookSubscriptions,requiredTopics}'
          ) = 7
      AND (
            account.configuration #>
              '{orderWebhookSubscriptions,requiredTopics}'
          ) ?& ARRAY[
            'orders/create', 'orders/updated', 'orders/edited',
            'orders/cancelled', 'orders/paid', 'orders/fulfilled',
            'orders/partially_fulfilled'
          ]
      AND jsonb_typeof(
            account.configuration #>
              '{orderWebhookSubscriptions,requiredIncludeFields}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{orderWebhookSubscriptions,requiredIncludeFields}'
          ) = 2
      AND (
            account.configuration #>
              '{orderWebhookSubscriptions,requiredIncludeFields}'
          ) ?& ARRAY['admin_graphql_api_id', 'updated_at']
      AND jsonb_typeof(
            account.configuration #>
              '{orderWebhookSubscriptions,missingTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{orderWebhookSubscriptions,missingTopics}'
          ) = 0
      AND jsonb_typeof(
            account.configuration #>
              '{orderWebhookSubscriptions,conflictingTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{orderWebhookSubscriptions,conflictingTopics}'
          ) = 0
      AND account.configuration #>>
            '{orderWebhookSubscriptions,desiredUri}' ~
              ('^https://[^/?#]+/api/integrations/commerce/shopify/webhooks/'
                || account.global_id || '$')
      AND jsonb_typeof(
            account.configuration #>
              '{orderWebhookSubscriptions,observedAt}'
          ) = 'string'
      AND CASE
        WHEN pg_input_is_valid(
          account.configuration #>>
            '{orderWebhookSubscriptions,observedAt}',
          'timestamp with time zone'
        ) THEN (
          (account.configuration #>>
            '{orderWebhookSubscriptions,observedAt}')::timestamptz >=
              clock_timestamp() - make_interval(
                secs => ${SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS}
              )
          AND (account.configuration #>>
            '{orderWebhookSubscriptions,observedAt}')::timestamptz <=
              clock_timestamp() + interval '10 minutes'
        )
        ELSE false
      END
      AND account.configuration #>>
            '{orderWebhookSubscriptions,discoveryErrorCode}' IS NULL,
    false
  ) AS shopify_order_subscription_ready,
  account.configuration #>> '{orderWebhookSubscriptions,desiredUri}'
    AS shopify_order_subscription_desired_uri,
  account.configuration #>> '{orderWebhookSubscriptions,observedAt}'
    AS shopify_order_subscription_observed_at,
  CASE
    WHEN jsonb_typeof(
           account.configuration #>
             '{orderWebhookSubscriptions,missingTopics}'
         ) = 'array'
      THEN jsonb_array_length(
        account.configuration #> '{orderWebhookSubscriptions,missingTopics}'
      )
    ELSE NULL
  END AS shopify_order_subscription_missing_count,
  CASE
    WHEN jsonb_typeof(
           account.configuration #>
             '{orderWebhookSubscriptions,conflictingTopics}'
         ) = 'array'
      THEN jsonb_array_length(
        account.configuration #>
          '{orderWebhookSubscriptions,conflictingTopics}'
      )
    ELSE NULL
  END AS shopify_order_subscription_conflicting_count,
  COALESCE(
    current_policy.provider = 'shopify'
      AND current_policy.resource = 'inventory'
      AND jsonb_typeof(
            account.configuration->'webhookSubscriptions'
          ) = 'object'
      AND account.configuration #>>
            '{webhookSubscriptions,ready}' = 'true'
      AND account.configuration #>>
            '{webhookSubscriptions,accountGlobalId}' = account.global_id
      AND account.configuration #>>
            '{webhookSubscriptions,credentialGeneration}' =
              account.commerce_credential_generation::text
      AND account.configuration #>>
            '{webhookSubscriptions,discoveryState}' = 'succeeded'
      AND account.configuration #>>
            '{webhookSubscriptions,discoveryErrorCode}' IS NULL
      AND account.configuration #>>
            '{webhookSubscriptions,observedCount}' = '6'
      AND account.configuration #>>
            '{webhookSubscriptions,matchingCount}' = '6'
      AND jsonb_typeof(
            account.configuration #>
              '{webhookSubscriptions,requiredTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{webhookSubscriptions,requiredTopics}'
          ) = 6
      AND (
            account.configuration #>
              '{webhookSubscriptions,requiredTopics}'
          ) ?& ARRAY[
            'inventory_items/create', 'inventory_items/delete',
            'inventory_items/update', 'inventory_levels/connect',
            'inventory_levels/disconnect', 'inventory_levels/update'
          ]
      AND jsonb_typeof(
            account.configuration #>
              '{webhookSubscriptions,missingTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{webhookSubscriptions,missingTopics}'
          ) = 0
      AND jsonb_typeof(
            account.configuration #>
              '{webhookSubscriptions,conflictingTopics}'
          ) = 'array'
      AND jsonb_array_length(
            account.configuration #>
              '{webhookSubscriptions,conflictingTopics}'
          ) = 0
      AND account.configuration #>>
            '{webhookSubscriptions,providerWrites}' = '0'
      AND account.configuration #>>
            '{webhookSubscriptions,desiredUri}' ~
              ('^https://[^/?#]+/api/integrations/commerce/shopify/webhooks/'
                || account.global_id || '$')
      AND jsonb_typeof(
            account.configuration #>
              '{webhookSubscriptions,observedAt}'
          ) = 'string'
      AND CASE
        WHEN pg_input_is_valid(
          account.configuration #>> '{webhookSubscriptions,observedAt}',
          'timestamp with time zone'
        ) THEN (
          (account.configuration #>>
            '{webhookSubscriptions,observedAt}')::timestamptz >=
              clock_timestamp() - make_interval(
                secs => ${SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS}
              )
          AND (account.configuration #>>
            '{webhookSubscriptions,observedAt}')::timestamptz <=
              clock_timestamp() + interval '10 minutes'
        )
        ELSE false
      END,
    false
  ) AS shopify_inventory_subscription_ready,
  account.configuration #>> '{webhookSubscriptions,desiredUri}'
    AS shopify_inventory_subscription_desired_uri,
  account.configuration #>> '{webhookSubscriptions,observedAt}'
    AS shopify_inventory_subscription_observed_at,
  CASE
    WHEN jsonb_typeof(
           account.configuration #>
             '{webhookSubscriptions,missingTopics}'
         ) = 'array'
      THEN jsonb_array_length(
        account.configuration #> '{webhookSubscriptions,missingTopics}'
      )
    ELSE NULL
  END AS shopify_inventory_subscription_missing_count,
  CASE
    WHEN jsonb_typeof(
           account.configuration #>
             '{webhookSubscriptions,conflictingTopics}'
         ) = 'array'
      THEN jsonb_array_length(
        account.configuration #> '{webhookSubscriptions,conflictingTopics}'
      )
    ELSE NULL
  END AS shopify_inventory_subscription_conflicting_count,
  faire_job.status AS faire_inventory_poll_status,
  faire_job.completed_at AS faire_inventory_poll_completed_at,
  faire_job.last_error_code AS faire_inventory_poll_last_error_code,
  COALESCE(
    faire_job.status = 'succeeded'
      AND faire_job.completed_at >=
            clock_timestamp() - interval '30 minutes'
      AND faire_job.completed_at <=
            clock_timestamp() + interval '5 minutes',
    false
  ) AS faire_inventory_observation_fresh
FROM operations_commerce_authority_policy_current current_policy
JOIN operations_integration_accounts account
  ON account.organization_id = current_policy.organization_id
 AND account.id = current_policy.integration_account_id
LEFT JOIN operations_commerce_credentials credential
  ON credential.organization_id = account.organization_id
 AND credential.integration_account_id = account.id
LEFT JOIN operations_commerce_order_sync_policies order_policy
  ON current_policy.resource = 'orders'
 AND order_policy.organization_id = account.organization_id
 AND order_policy.integration_account_id = account.id
LEFT JOIN operations_activation_scopes activation
  ON activation.organization_id = account.organization_id
LEFT JOIN LATERAL (
  SELECT session.status, session.completeness_state,
         session.coverage_basis, session.completed_at
  FROM operations_commerce_order_backfill_sessions session
  WHERE current_policy.resource = 'orders'
    AND session.organization_id = account.organization_id
    AND session.integration_account_id = account.id
    AND session.provider = current_policy.provider
    AND session.session_kind = 'historical_backfill'
    AND session.credential_generation =
          account.commerce_credential_generation
  ORDER BY session.created_at DESC, session.id DESC
  LIMIT 1
) historical_backfill ON true
LEFT JOIN LATERAL (
  SELECT session.status, session.requested_through,
         session.completed_at, session.last_error_code
  FROM operations_commerce_order_backfill_sessions session
  WHERE current_policy.resource = 'orders'
    AND session.organization_id = account.organization_id
    AND session.integration_account_id = account.id
    AND session.session_kind = 'continuous_poll'
    AND session.credential_generation =
          account.commerce_credential_generation
    AND session.policy_revision = order_policy.revision
  ORDER BY session.created_at DESC, session.id DESC
  LIMIT 1
) continuous_poll ON true
LEFT JOIN LATERAL (
  SELECT job.status, job.completed_at, job.last_error_code,
         job.inventory_max_age_seconds
  FROM operations_shopify_inventory_refresh_jobs job
  JOIN operations_shopify_carrier_service_configs config
    ON config.organization_id = job.organization_id
   AND config.integration_account_id = job.integration_account_id
   AND config.id = job.carrier_service_config_id
   AND config.warehouse_id = job.warehouse_id
   AND config.credential_generation = job.credential_generation
   AND config.activation_revision = job.activation_revision
   AND config.row_version = job.config_row_version
   AND config.policy_revision = job.policy_revision
   AND config.policy_hash = job.policy_hash
   AND config.inventory_max_age_seconds = job.inventory_max_age_seconds
  WHERE current_policy.provider = 'shopify'
    AND current_policy.resource = 'inventory'
    AND job.organization_id = account.organization_id
    AND job.integration_account_id = account.id
    AND job.credential_generation = account.commerce_credential_generation
    AND job.activation_revision = activation.revision
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1
) shopify_job ON true
LEFT JOIN operations_shopify_inventory_refresh_watermarks watermark
  ON current_policy.provider = 'shopify'
 AND current_policy.resource = 'inventory'
 AND watermark.organization_id = account.organization_id
 AND watermark.integration_account_id = account.id
 AND watermark.credential_generation = account.commerce_credential_generation
LEFT JOIN LATERAL (
  SELECT job.status, job.completed_at, job.last_error_code
  FROM operations_faire_inventory_poll_jobs job
  WHERE current_policy.provider = 'faire'
    AND current_policy.resource = 'inventory'
    AND job.organization_id = account.organization_id
    AND job.integration_account_id = account.id
    AND job.credential_version = account.commerce_credential_generation
    AND job.activation_revision = activation.revision
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1
) faire_job ON true
WHERE current_policy.organization_id = $1::uuid`

const POLICY_ORDER = ` ORDER BY
  current_policy.account_display_name,
  current_policy.account_global_id,
  current_policy.resource`

const SCOPE_REQUEST_SELECT = `SELECT
  request.global_id, request.account_global_id, request.provider,
  request.account_environment, request.deployment_scope,
  request.requested_resources, request.state, request.provider_write_enabled,
  request.supported_outbound_effect, request.blocker_codes,
  request.customer_global_id, request.product_global_id,
  request.product_mapping_global_id, request.channel_sku,
  request.external_product_id, request.external_variant_id,
  request.external_inventory_item_id, request.request_reason,
  request.recorded_by, request.created_at
FROM operations_commerce_provider_write_scope_requests request
WHERE request.organization_id = $1::uuid
ORDER BY request.created_at, request.id`

export async function readCommerceAuthorityPoliciesFromPostgres(input: {
  organizationId: string
}): Promise<CommerceAuthorityPolicyState> {
  const exactOrganizationId = organizationId(input.organizationId)
  const [policyResult, scopeRequestResult] = await Promise.all([
    query<PolicyRow>(`${POLICY_SELECT}${POLICY_ORDER}`, [exactOrganizationId]),
    query<ScopeRequestRow>(SCOPE_REQUEST_SELECT, [exactOrganizationId]),
  ])
  return {
    organizationId: exactOrganizationId,
    policies: policyResult.rows.map(mapPolicy),
    providerWriteScopeRequests: scopeRequestResult.rows.map(mapScopeRequest),
  }
}

async function accountForPolicy(
  client: PoolClient,
  input: { organizationId: string; accountGlobalId: string },
) {
  const result = await client.query<AccountRow>(
    `SELECT account.id::text, account.global_id, account.provider,
            account.environment, account.display_name, account.status,
            credential.verification_status AS credential_verification_status,
            COALESCE(
              credential.credential_version = account.commerce_credential_generation
                AND credential.external_account_id = account.external_account_id,
              false
            ) AND COALESCE(
              (account.provider = 'shopify'
                AND credential.auth_mode = 'shopify_client_credentials')
                OR (account.provider = 'faire'
                  AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth')),
              false
            ) AS credential_current
     FROM operations_integration_accounts account
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider IN ('shopify', 'faire')
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const account = result.rows[0]
  if (!account) {
    fail('COMMERCE_AUTHORITY_ACCOUNT_NOT_FOUND', 'Commerce account is unavailable in the active organization', 404)
  }
  exactProvider(account.provider)
  if (account.status !== 'active') {
    fail('COMMERCE_AUTHORITY_ACCOUNT_UNAVAILABLE', 'Commerce authority policy changes require an active account')
  }
  if (account.credential_verification_status !== 'verified'
      || !account.credential_current) {
    fail('COMMERCE_AUTHORITY_CREDENTIAL_UNREADY', 'Commerce authority policy changes require current verified credentials')
  }
  return account
}

async function replayedPolicy(client: PoolClient, input: {
  organizationId: string
  integrationAccountId: string
  idempotencyKey: string
  requestHash: string
}) {
  const result = await client.query<PolicyRevisionRow>(
    `SELECT global_id, revision, authority_mode, desired_ingest_mode,
            provider_write_mode, provider_write_count,
            expected_previous_revision, reason, actor_email, actor_role,
            idempotency_key, request_hash, created_at
     FROM operations_commerce_authority_policies
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND idempotency_key = $3
     LIMIT 1`,
    [input.organizationId, input.integrationAccountId, input.idempotencyKey],
  )
  if (result.rows[0] && result.rows[0].request_hash !== input.requestHash) {
    fail('COMMERCE_AUTHORITY_IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different authority policy request')
  }
  return result.rows[0] || null
}

async function exactPolicyRow(
  client: PoolClient,
  input: { organizationId: string; accountGlobalId: string; resource: CommerceAuthorityResource },
) {
  const result = await client.query<PolicyRow>(
    `${POLICY_SELECT}
     AND current_policy.account_global_id = $2
     AND current_policy.resource = $3${POLICY_ORDER}`,
    [input.organizationId, input.accountGlobalId, input.resource],
  )
  if (result.rows.length !== 1) {
    fail('COMMERCE_AUTHORITY_POLICY_NOT_RETAINED', 'Commerce authority policy revision was not retained', 500)
  }
  return result.rows[0]
}

export async function setCommerceAuthorityPolicyInPostgres(rawInput: {
  organizationId: unknown
  accountGlobalId: unknown
  resource: unknown
  authorityMode: unknown
  expectedRevision: unknown
  reason: unknown
  actorEmail: unknown
  actorRole: unknown
  idempotencyKey: unknown
}): Promise<SetCommerceAuthorityPolicyResult> {
  const input = {
    organizationId: organizationId(rawInput.organizationId),
    accountGlobalId: accountGlobalId(rawInput.accountGlobalId),
    resource: resource(rawInput.resource),
    authorityMode: requestedAuthorityMode(rawInput.authorityMode),
    expectedRevision: expectedRevision(rawInput.expectedRevision),
    reason: reason(rawInput.reason),
    actorEmail: actorEmail(rawInput.actorEmail),
    actorRole: actorRole(rawInput.actorRole),
    idempotencyKey: idempotencyKey(rawInput.idempotencyKey),
  }

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-authority:${input.organizationId}:${input.accountGlobalId}:${input.resource}`,
    )
    const account = await accountForPolicy(client, input)
    const provider = exactProvider(account.provider)
    const defaults = commerceAuthorityDefaults(provider, input.resource)
    if (input.authorityMode !== defaults.authorityMode) {
      fail(
        'COMMERCE_AUTHORITY_MODE_INVALID',
        `The ${provider} ${input.resource} authority mode must be ${defaults.authorityMode}`,
        400,
      )
    }
    const requestHash = policyHash({
      ...input,
      provider,
      desiredIngestMode: defaults.desiredIngestMode,
    })
    const replayed = await replayedPolicy(client, {
      organizationId: input.organizationId,
      integrationAccountId: account.id,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    })
    if (replayed) {
      const currentEvidence = await exactPolicyRow(client, input)
      return {
        policy: mapPolicy({ ...currentEvidence, ...replayed }),
        replayed: true,
      }
    }

    const currentResult = await client.query<{ revision: string | number }>(
      `SELECT revision
       FROM operations_commerce_authority_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = $3
       ORDER BY revision DESC
       LIMIT 1`,
      [input.organizationId, account.id, input.resource],
    )
    const currentRevision = numberValue(currentResult.rows[0]?.revision)
    if (currentRevision !== input.expectedRevision) {
      fail('COMMERCE_AUTHORITY_REVISION_CONFLICT', 'Commerce authority policy changed; reload and try again')
    }

    await client.query(
      `INSERT INTO operations_commerce_authority_policies (
         organization_id, integration_account_id, provider, resource,
         revision, authority_mode, desired_ingest_mode,
         provider_write_mode, provider_write_count,
         expected_previous_revision, reason, actor_email, actor_role,
         idempotency_key, request_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'disabled', 0,
         $8, $9, $10, $11, $12, $13
       )`,
      [
        input.organizationId,
        account.id,
        provider,
        input.resource,
        currentRevision + 1,
        defaults.authorityMode,
        defaults.desiredIngestMode,
        currentRevision,
        input.reason,
        input.actorEmail,
        input.actorRole,
        input.idempotencyKey,
        requestHash,
      ],
    )
    const policy = mapPolicy(await exactPolicyRow(client, input))
    await recordAuditEvent({
      actor: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'commerce.authority_policy.recorded',
      aggregateType: 'operations.commerce_authority_policy',
      aggregateId: policy.policyGlobalId,
      eventKey:
        `commerce-authority-policy:${input.organizationId}:${input.accountGlobalId}:${input.idempotencyKey}`,
      payload: {
        provider: policy.provider,
        resource: policy.resource,
        authorityMode: policy.authorityMode,
        desiredIngestMode: policy.desiredIngestMode,
        providerWriteMode: policy.providerWriteMode,
        providerWriteCount: 0,
        revision: policy.revision,
        expectedPreviousRevision: policy.expectedPreviousRevision,
        reason: policy.reason,
        accountGlobalId: policy.accountGlobalId,
      },
    }, client)
    return { policy, replayed: false }
  })
}
