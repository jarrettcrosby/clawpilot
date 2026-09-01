#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  actorEmail,
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  orderIds,
  postgresAdapter,
  seedBeforeRevisionMigration,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()

const orderSignalTopics = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
]

function orderWebhookSubscriptionEvidence(accountGlobalId, overrides = {}) {
  return {
    accountGlobalId,
    credentialGeneration: 1,
    desiredUri:
      `https://webhooks.example.test/api/integrations/commerce/shopify/webhooks/${accountGlobalId}`,
    requiredTopics: orderSignalTopics,
    requiredIncludeFields: ['admin_graphql_api_id', 'updated_at'],
    observedCount: 7,
    matchingCount: 7,
    missingTopics: [],
    conflictingTopics: [],
    subscriptionReady: true,
    processorState: 'available',
    exactReadProcessorReady: true,
    scheduledPollBackstop: true,
    ready: true,
    observedAt: new Date().toISOString(),
    discoveryState: 'succeeded',
    discoveryErrorCode: null,
    providerWrites: 0,
    ...overrides,
  }
}

async function rejection(promise, pattern) {
  await assert.rejects(promise, pattern)
}

function runtime(ids) {
  return {
    organizationId: ids.organization,
    integrationAccountId: ids.integration,
    globalId: 'gia0009301',
    provider: 'shopify',
    environment: 'production',
    externalAccountId: 'gid://shopify/Shop/9301',
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 1,
    authMode: 'shopify_client_credentials',
    configuration: {
      shopDomain: 'revision-acceptance.myshopify.com',
      grantedScopes: ['read_orders', 'read_all_orders'],
      orderWebhookSubscriptions:
        orderWebhookSubscriptionEvidence('gia0009301'),
    },
    encrypted: {},
  }
}

function evidence(overrides = {}) {
  const body = Buffer.from(JSON.stringify({
    admin_graphql_api_id: 'gid://shopify/Order/9301',
    updated_at: '2026-08-13T17:00:00Z',
  }))
  return {
    topic: 'orders/updated',
    externalOrderId: 'gid://shopify/Order/9301',
    providerUpdatedAt: '2026-08-13T17:00:00.000Z',
    payloadHash: createHash('sha256').update(body).digest('hex'),
    payloadBytes: body.byteLength,
    ...overrides,
  }
}

async function verify(databaseUrl, ids) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const audits = []
  const shopifyOrderWebhook = loadTypeScriptModule(
    'app_src/lib/integrations/shopifyOrderWebhook.ts',
    {
      '@/lib/integrations/shopifyCommerceClient': {
        async shopifyAdminGraphql() {
          throw new Error('Provider discovery is not used by persistence tests')
        },
      },
    },
  )
  const commerceOrderSync = loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderSync.ts',
    {
      '@/lib/auditWriter': { async recordAuditEvent() {} },
      '@/lib/integrations/commerceCapabilities': {
        hasEffectiveShopifyScope: () => true,
      },
      '@/lib/integrations/commerceCredentialCrypto': {
        COMMERCE_ORDER_SYNC_CURSOR_AAD_VERSION:
          'commerce-order-sync-cursor-aad-v1',
      },
      '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': {
        resolveCommerceOrderRevisionEvidenceKeyConfig: () => ({
          activeKeyId: 'webhook-k1', keyIds: ['webhook-k1'],
          hasEncryptionKey: () => true,
        }),
        summarizeCommerceOrderRevisionEvidenceKeyReadiness: () => ({
          ready: true,
        }),
      },
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadAccountSql: () => "account.status = 'active'",
      },
      '@/lib/persistence/config': { isHostedRuntime: () => false },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderWebhookSignals.ts',
    {
      '@/lib/auditWriter': {
        async recordAuditEvent(input) {
          audits.push(input)
        },
      },
      '@/lib/integrations/shopifyOrderWebhook': shopifyOrderWebhook,
      '@/lib/persistence/postgres': postgresAdapter(pool),
      '@/lib/persistence/commerceOrderSync': commerceOrderSync,
    },
  )
  try {
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        ids.integration,
        JSON.stringify(runtime(ids).configuration),
      ],
    )
    const input = {
      runtime: runtime(ids),
      providerEventId: 'webhook-order-event-93010001',
      sourceDomain: 'revision-acceptance.myshopify.com',
      providerApiVersion: '2026-07',
      providerTriggeredAt: '2026-08-13T17:00:01.000Z',
      evidence: evidence(),
    }
    const first = await persistence
      .recordShopifyOrderWebhookSignalInPostgres(input)
    assert.equal(first.duplicate, false)
    assert.equal(first.externalOrderId, 'gid://shopify/Order/9301')
    assert.equal(first.dirtyVersion, 1)
    assert.equal(first.reconciledVersion, 0)
    assert.equal(first.processorState, 'exact_read_pending')
    assert.equal(first.providerWrites, 0)
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET webhook_verification_status = 'verified',
           webhook_verified_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND credential_version = 1`,
      [ids.organization, ids.integration],
    )

    const replay = await persistence
      .recordShopifyOrderWebhookSignalInPostgres(input)
    assert.equal(replay.duplicate, true)
    assert.equal(replay.globalId, first.globalId)
    assert.equal(replay.dirtyVersion, 1)

    await rejection(
      persistence.recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        evidence: evidence({ topic: 'orders/paid' }),
      }),
      /event ID with different evidence/u,
    )

    const second = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93010002',
        evidence: evidence({
          topic: 'orders/paid',
          providerUpdatedAt: '2026-08-13T17:02:00.000Z',
          payloadHash: 'b'.repeat(64),
        }),
      })
    assert.equal(second.dirtyVersion, 2)
    assert.equal(second.reconciledVersion, 0)

    const stored = await pool.query(
      `SELECT
         signal.global_id, signal.provider_event_id, signal.topic,
         signal.source_domain, signal.external_order_id,
         signal.provider_updated_at, signal.payload_hash,
         signal.payload_bytes, signal.provider_write_count,
         target.dirty_version, target.reconciled_version,
         target.latest_signal_global_id, target.claim_state,
         target.provider_read_count, target.provider_write_count
       FROM operations_shopify_order_webhook_signals signal
       JOIN operations_shopify_order_webhook_targets target
         ON target.organization_id = signal.organization_id
        AND target.integration_account_id = signal.integration_account_id
        AND target.external_order_id = signal.external_order_id
       WHERE signal.organization_id = $1::uuid
       ORDER BY signal.received_at, signal.id`,
      [ids.organization],
    )
    assert.equal(stored.rowCount, 2)
    assert.equal(Number(stored.rows[1].dirty_version), 2)
    assert.equal(Number(stored.rows[1].reconciled_version), 0)
    assert.equal(stored.rows[1].latest_signal_global_id, second.globalId)
    assert.equal(stored.rows[1].claim_state, 'pending')
    assert.equal(Number(stored.rows[1].provider_read_count), 0)
    assert.equal(Number(stored.rows[1].provider_write_count), 0)

    const backfill = await commerceOrderSync
      .requestCommerceOrderBackfillInPostgres({
        organizationId: ids.organization,
        accountGlobalId: runtime(ids).globalId,
        actorEmail,
        idempotencyKey: 'webhook-policy-rebase-9301',
        reason: 'Prove dirty webhook work survives a scheduled backfill request',
      })
    assert.equal(backfill.providerWrites, 0)
    const beforeRebase = await pool.query(
      `SELECT target.policy_revision AS target_revision,
              policy.revision AS current_revision,
              policy.continuous_transport,
              policy.provider_event_processor_state
       FROM operations_shopify_order_webhook_targets target
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = target.organization_id
        AND policy.integration_account_id = target.integration_account_id
       WHERE target.organization_id = $1::uuid
         AND target.integration_account_id = $2::uuid
         AND target.external_order_id = 'gid://shopify/Order/9301'`,
      [ids.organization, ids.integration],
    )
    assert.equal(Number(beforeRebase.rows[0].target_revision), 2)
    assert.equal(Number(beforeRebase.rows[0].current_revision), 3)
    assert.equal(beforeRebase.rows[0].continuous_transport,
      'webhook_signal_plus_poll')
    assert.equal(beforeRebase.rows[0].provider_event_processor_state,
      'available')

    const lockKey = commerceOrderSync
      .commerceOrderSyncAccountLockKey({
        organizationId: ids.organization,
        accountGlobalId: runtime(ids).globalId,
      })
    const lockHolder = await pool.connect()
    let serializedSignal
    try {
      await lockHolder.query('BEGIN')
      await lockHolder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [lockKey],
      )
      await lockHolder.query(
        `SELECT id
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
         FOR UPDATE`,
        [ids.organization, ids.integration],
      )
      let ingressSettled = false
      const blockedIngress = persistence
        .recordShopifyOrderWebhookSignalInPostgres({
          ...input,
          providerEventId: 'webhook-order-event-93050001',
          evidence: evidence({
            externalOrderId: 'gid://shopify/Order/9301',
            providerUpdatedAt: '2026-08-13T17:01:00.000Z',
            payloadHash: '5'.repeat(64),
          }),
        })
        .finally(() => { ingressSettled = true })
      await delay(100)
      assert.equal(ingressSettled, false,
        'ingress must block behind the exact account transaction lock')
      await lockHolder.query(
        `UPDATE operations_commerce_order_sync_policies
         SET revision = revision + 1, updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [ids.organization, ids.integration],
      )
      await lockHolder.query('COMMIT')
      serializedSignal = await blockedIngress
      assert.equal(serializedSignal.dirtyVersion, 3)
      const serializedTarget = await pool.query(
        `SELECT signal.policy_revision AS signal_revision,
                target.policy_revision AS target_revision,
                policy.revision AS current_revision
         FROM operations_shopify_order_webhook_signals signal
         JOIN operations_shopify_order_webhook_targets target
           ON target.organization_id = signal.organization_id
          AND target.integration_account_id = signal.integration_account_id
          AND target.external_order_id = signal.external_order_id
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = signal.organization_id
          AND policy.integration_account_id = signal.integration_account_id
         WHERE signal.organization_id = $1::uuid
           AND signal.global_id = $2`,
        [ids.organization, serializedSignal.globalId],
      )
      assert.deepEqual(serializedTarget.rows[0], {
        signal_revision: 4,
        target_revision: 4,
        current_revision: 4,
      })
      const reverseHolder = await pool.connect()
      try {
        await reverseHolder.query('BEGIN')
        await reverseHolder.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [lockKey],
        )
        await reverseHolder.query(
          `SELECT id
           FROM operations_integration_accounts
           WHERE organization_id = $1::uuid
             AND id = $2::uuid
           FOR UPDATE`,
          [ids.organization, ids.integration],
        )
        await reverseHolder.query('ROLLBACK')
      } finally {
        reverseHolder.release()
      }
    } finally {
      await lockHolder.query('ROLLBACK').catch(() => undefined)
      lockHolder.release()
    }
    assert.ok(serializedSignal)

    const claims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-test-worker',
        limit: 1,
      })
    assert.equal(claims.length, 1)
    assert.equal(claims[0].capturedDirtyVersion, 3)
    assert.equal(claims[0].signalGlobalId, serializedSignal.globalId)
    assert.equal(claims[0].credentialGeneration, 1)
    assert.equal(claims[0].policyRevision, 4)

    const activatedPolicy = await pool.query(
      `SELECT continuous_transport, provider_event_processor_state, revision
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    assert.equal(activatedPolicy.rows[0].continuous_transport,
      'webhook_signal_plus_poll')
    assert.equal(activatedPolicy.rows[0].provider_event_processor_state,
      'available')
    assert.equal(Number(activatedPolicy.rows[0].revision), 4)

    const third = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93010003',
        evidence: evidence({
          topic: 'orders/fulfilled',
          providerUpdatedAt: '2026-08-13T17:03:00.000Z',
          payloadHash: 'c'.repeat(64),
        }),
      })
    assert.equal(third.dirtyVersion, 4)
    const observation = (providerUpdatedAt) => ({
      observationKind: 'webhook_exact_read',
      externalOrderId: 'gid://shopify/Order/9301',
      orderNumber: '#9301',
      sourceRevision: providerUpdatedAt,
      sourceHash: '0'.repeat(64),
      rawLifecycleState: 'OPEN',
      rawPaymentState: 'PAID',
      rawFulfillmentState: 'UNFULFILLED',
      rawReturnState: 'NO_RETURN',
      canonicalLifecycleState: 'open',
      canonicalPaymentState: 'paid',
      canonicalFulfillmentState: 'unfulfilled',
      canonicalReturnState: 'none',
      currency: 'USD',
      providerTotalMinor: 1000,
      providerInventoryReservationState: 'reported_reserved',
      providerCreatedAt: '2026-08-13T16:00:00.000Z',
      providerProcessedAt: '2026-08-13T16:00:01.000Z',
      providerUpdatedAt,
      providerCancelledAt: null,
      providerClosedAt: null,
      observedAt: '2026-08-13T17:04:00.000Z',
      providerReadCount: 3,
      lines: [{
        externalLineId: 'gid://shopify/LineItem/9301',
        externalProductId: 'gid://shopify/Product/9301',
        externalVariantId: 'gid://shopify/ProductVariant/9301',
        sku: 'TEST-9301',
        originalQuantity: 1,
        currentQuantity: 1,
        unfulfilledQuantity: 1,
        fulfilledQuantity: 0,
        returnedQuantity: 0,
        requiresShipping: true,
      }],
      events: [{
        externalEventId: 'webhook-9301-tracking',
        externalSubjectId: 'webhook-9301-shipment',
        eventKind: 'tracking_updated',
        eventStatus: 'in_transit',
        inventoryEffectKind: 'none',
        attributionSource: 'provider_system',
        trackingCarrier: 'UPS',
        trackingNumber: 'WEBHOOK-TRACKING-9301',
        trackingUrl: 'https://www.ups.com/track?tracknum=WEBHOOK-TRACKING-9301',
        occurredAt: providerUpdatedAt,
      }],
    })
    const firstObservation = observation('2026-08-13T17:02:00.000Z')
    const normalizedFirstObservation = commerceOrderSync
      .normalizeCommerceOrderObservationInput(firstObservation)
    const scheduledSession = (await pool.query(
      `SELECT id::text
       FROM operations_commerce_order_backfill_sessions
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [ids.organization, ids.integration],
    )).rows[0]
    assert.ok(scheduledSession)
    const crossKindSeed = await pool.connect()
    try {
      await crossKindSeed.query('BEGIN')
      await crossKindSeed.query('SET LOCAL session_replication_role = replica')
      await crossKindSeed.query(
        `INSERT INTO operations_commerce_order_observations (
           organization_id, integration_account_id, backfill_session_id,
           provider, credential_generation, observation_kind,
           external_order_id, order_number, source_revision, source_hash,
           canonical_lifecycle_state, canonical_payment_state,
           canonical_fulfillment_state, canonical_return_state,
           currency, provider_total_minor, provider_created_at,
           provider_updated_at, observed_at, provider_read_count
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'shopify', 1, 'scheduled_poll',
           $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14::timestamptz, $15::timestamptz, $16::timestamptz, 3
         )`,
        [
          ids.organization,
          ids.integration,
          scheduledSession.id,
          normalizedFirstObservation.externalOrderId,
          normalizedFirstObservation.orderNumber,
          normalizedFirstObservation.sourceRevision,
          normalizedFirstObservation.sourceHash,
          normalizedFirstObservation.canonicalLifecycleState,
          normalizedFirstObservation.canonicalPaymentState,
          normalizedFirstObservation.canonicalFulfillmentState,
          normalizedFirstObservation.canonicalReturnState,
          normalizedFirstObservation.currency,
          normalizedFirstObservation.providerTotalMinor,
          normalizedFirstObservation.providerCreatedAt,
          normalizedFirstObservation.providerUpdatedAt,
          normalizedFirstObservation.observedAt,
        ],
      )
      await crossKindSeed.query('COMMIT')
    } catch (error) {
      await crossKindSeed.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      crossKindSeed.release()
    }
    const firstRead = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: claims[0],
        observation: firstObservation,
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(firstRead.status, 'pending')
    assert.equal(firstRead.reconciledVersion, 3)
    assert.equal(firstRead.dirtyVersion, 4)
    assert.equal(firstRead.appended, 1)
    assert.equal(firstRead.providerReads, 3)
    assert.equal(firstRead.providerWrites, 0)
    const firstReadLineage = await pool.query(
      `SELECT observation.observation_kind, observation.source_hash,
              line.returned_quantity::text,
              event.tracking_url
       FROM operations_commerce_order_observations observation
       LEFT JOIN operations_commerce_order_observation_lines line
         ON line.organization_id = observation.organization_id
        AND line.observation_id = observation.id
       LEFT JOIN operations_commerce_order_event_observations event
         ON event.organization_id = observation.organization_id
        AND event.observation_id = observation.id
       WHERE observation.organization_id = $1::uuid
         AND observation.integration_account_id = $2::uuid
         AND observation.external_order_id = $3
       ORDER BY observation.observation_kind`,
      [ids.organization, ids.integration, firstObservation.externalOrderId],
    )
    assert.deepEqual(firstReadLineage.rows.map((row) => ({
      observationKind: row.observation_kind,
      sourceHash: row.source_hash,
      returnedQuantity: row.returned_quantity,
      trackingUrl: row.tracking_url,
    })), [{
      observationKind: 'scheduled_poll',
      sourceHash: normalizedFirstObservation.sourceHash,
      returnedQuantity: null,
      trackingUrl: null,
    }, {
      observationKind: 'webhook_exact_read',
      sourceHash: normalizedFirstObservation.sourceHash,
      returnedQuantity: '0',
      trackingUrl: 'https://www.ups.com/track?tracknum=WEBHOOK-TRACKING-9301',
    }], 'Webhook exact lineage, returned quantity, and tracking URL must persist independently of an identical scheduled row')

    const followupClaims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-test-worker',
        limit: 1,
      })
    assert.equal(followupClaims.length, 1)
    assert.equal(followupClaims[0].capturedDirtyVersion, 4)
    assert.equal(followupClaims[0].signalGlobalId, third.globalId)
    const secondRead = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: followupClaims[0],
        observation: observation('2026-08-13T17:03:00.000Z'),
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(secondRead.status, 'idle')
    assert.equal(secondRead.reconciledVersion, 4)
    assert.equal(secondRead.dirtyVersion, 4)
    const completedTarget = await pool.query(
      `SELECT claim_state, dirty_version, reconciled_version,
              provider_read_count, provider_write_count
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9301'`,
      [ids.organization, ids.integration],
    )
    assert.equal(completedTarget.rows[0].claim_state, 'idle')
    assert.equal(Number(completedTarget.rows[0].dirty_version), 4)
    assert.equal(Number(completedTarget.rows[0].reconciled_version), 4)
    assert.equal(Number(completedTarget.rows[0].provider_read_count), 6)
    assert.equal(Number(completedTarget.rows[0].provider_write_count), 0)
    const readEvidence = await pool.query(
      `SELECT provider_read_count, provider_write_count,
              read_all_orders_scope_observed,
              return_history_scope_observed
       FROM operations_shopify_order_webhook_reads
       WHERE organization_id = $1::uuid
       ORDER BY captured_dirty_version`,
      [ids.organization],
    )
    assert.equal(readEvidence.rowCount, 2)
    assert.ok(readEvidence.rows.every((row) => (
      Number(row.provider_read_count) === 3
      && Number(row.provider_write_count) === 0
      && row.read_all_orders_scope_observed === true
      && row.return_history_scope_observed === true
    )))

    const returnCycleStates = [
      {
        state: 'requested', raw: 'RETURN_REQUESTED', observedAt:
          '2026-08-13T17:04:10.000Z', payloadHash: 'a'.repeat(64),
      },
      {
        state: 'returned', raw: 'RETURNED', observedAt:
          '2026-08-13T17:04:20.000Z', payloadHash: 'b'.repeat(64),
      },
      {
        state: 'requested', raw: 'RETURN_REQUESTED', observedAt:
          '2026-08-13T17:04:30.000Z', payloadHash: 'c'.repeat(64),
      },
    ]
    const cycleAppends = []
    for (const [index, cycle] of returnCycleStates.entries()) {
      await persistence.recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: `webhook-order-return-cycle-${index + 1}-9320`,
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9320',
          providerUpdatedAt: '2026-08-13T17:03:30.000Z',
          payloadHash: cycle.payloadHash,
        }),
      })
      const [cycleClaim] = await persistence
        .claimShopifyOrderWebhookTargetsInPostgres({
          workerId: `shopify-order-return-cycle-${index + 1}`,
          limit: 1,
        })
      assert.equal(cycleClaim.externalOrderId, 'gid://shopify/Order/9320')
      const cycleAppend = await persistence
        .appendShopifyOrderWebhookExactReadInPostgres({
          claim: cycleClaim,
          observation: {
            ...observation('2026-08-13T17:03:30.000Z'),
            externalOrderId: 'gid://shopify/Order/9320',
            sourceRevision: '2026-08-13T17:03:30.000Z',
            sourceHash: cycle.payloadHash,
            rawReturnState: cycle.raw,
            canonicalReturnState: cycle.state,
            observedAt: cycle.observedAt,
            lines: [],
          },
          readAllOrdersScopeObserved: true,
          returnHistoryScopeObserved: true,
        })
      cycleAppends.push(cycleAppend)
    }
    assert.deepEqual(cycleAppends.map((result) => result.appended), [1, 1, 1])
    const returnCycle = await pool.query(
      `SELECT observation.source_hash, observation.canonical_return_state,
              observation.observed_at, read.captured_dirty_version,
              read.provider_write_count
       FROM operations_commerce_order_observations observation
       JOIN operations_shopify_order_webhook_reads read
         ON read.organization_id = observation.organization_id
        AND read.observation_id = observation.id
       WHERE observation.organization_id = $1::uuid
         AND observation.integration_account_id = $2::uuid
         AND observation.provider = 'shopify'
         AND observation.external_order_id = 'gid://shopify/Order/9320'
       ORDER BY observation.observed_at, read.captured_dirty_version`,
      [ids.organization, ids.integration],
    )
    assert.equal(returnCycle.rowCount, 3)
    assert.deepEqual(
      returnCycle.rows.map((row) => row.canonical_return_state),
      ['requested', 'returned', 'requested'],
    )
    assert.equal(returnCycle.rows[0].source_hash,
      returnCycle.rows[2].source_hash,
      'The same-parent Return A state must hash identically after A to B to A')
    assert.notEqual(returnCycle.rows[0].source_hash,
      returnCycle.rows[1].source_hash)
    assert.deepEqual(
      returnCycle.rows.map((row) => Number(row.captured_dirty_version)),
      [1, 2, 3],
    )
    assert.ok(returnCycle.rows.every((row) => row.provider_write_count === 0))
    const columns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'operations_shopify_order_webhook_signals'
       ORDER BY column_name`,
    )
    const names = columns.rows.map((row) => row.column_name)
    for (const forbidden of [
      'payload', 'payload_ciphertext', 'customer', 'email', 'phone',
      'billing_address', 'shipping_address', 'line_items', 'tracking_number',
    ]) assert.equal(names.includes(forbidden), false)

    await rejection(
      pool.query(
        `UPDATE operations_shopify_order_webhook_signals
         SET topic = 'orders/cancelled'
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [ids.organization, first.globalId],
      ),
      /signals are immutable/u,
    )
    await rejection(
      pool.query(
        `DELETE FROM operations_shopify_order_webhook_signals
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [ids.organization, first.globalId],
      ),
      /signals are immutable/u,
    )
    await rejection(
      pool.query(
        `UPDATE operations_shopify_order_webhook_targets
         SET dirty_version = 1
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = 'gid://shopify/Order/9301'`,
        [ids.organization, ids.integration],
      ),
      /target (?:signal lineage is invalid|evidence is monotonic)/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_shopify_order_webhook_signals (
           organization_id, integration_account_id,
           credential_generation, policy_revision,
           provider_event_id, topic, source_domain,
           external_order_id, provider_updated_at, payload_hash, payload_bytes
         ) VALUES (
           $1::uuid, $2::uuid, 2, 4, 'webhook-order-event-93010004',
           'orders/updated', 'revision-acceptance.myshopify.com',
           'gid://shopify/Order/9301', now(), $3, 80
         )`,
        [ids.organization, ids.integration, 'c'.repeat(64)],
      ),
      /signal lineage is not current/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_shopify_order_webhook_signals (
           organization_id, integration_account_id,
           credential_generation, policy_revision,
           provider_event_id, topic, source_domain,
           external_order_id, provider_updated_at, payload_hash, payload_bytes
         ) VALUES (
           $1::uuid, $2::uuid, 1, 4, 'webhook-order-event-93010005',
           'orders/updated', 'wrong-shop.myshopify.com',
           'gid://shopify/Order/9301', now(), $3, 80
         )`,
        [ids.organization, ids.integration, 'd'.repeat(64)],
      ),
      /signal lineage is not current/u,
    )

    const inFlight = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93070001',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9307',
          providerUpdatedAt: '2026-08-13T17:03:30.000Z',
          payloadHash: '7'.repeat(64),
        }),
      })
    assert.equal(inFlight.dirtyVersion, 1)
    const inFlightClaim = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-in-flight-worker',
        limit: 1,
      })
    assert.equal(inFlightClaim.length, 1)
    assert.equal(inFlightClaim[0].externalOrderId,
      'gid://shopify/Order/9307')
    assert.equal(inFlightClaim[0].policyRevision, 4)
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET revision = revision + 1, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    const inFlightRead = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: inFlightClaim[0],
        observation: {
          ...observation('2026-08-13T17:03:30.000Z'),
          externalOrderId: 'gid://shopify/Order/9307',
          sourceRevision: '2026-08-13T17:03:30.000Z',
          sourceHash: '7'.repeat(64),
          lines: [],
        },
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(inFlightRead.status, 'idle')
    assert.equal(inFlightRead.reconciledVersion, 1)
    const compatibleReadEvidence = await pool.query(
      `SELECT target.policy_revision AS target_revision,
              policy.revision AS current_revision,
              read.policy_revision AS read_revision,
              read.provider_read_count, read.provider_write_count
       FROM operations_shopify_order_webhook_targets target
       JOIN operations_shopify_order_webhook_reads read
         ON read.organization_id = target.organization_id
        AND read.target_id = target.id
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = target.organization_id
        AND policy.integration_account_id = target.integration_account_id
       WHERE target.organization_id = $1::uuid
         AND target.integration_account_id = $2::uuid
         AND target.external_order_id = 'gid://shopify/Order/9307'`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(compatibleReadEvidence.rows[0], {
      target_revision: 4,
      current_revision: 5,
      read_revision: 4,
      provider_read_count: 3,
      provider_write_count: 0,
    })

    const crashed = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93030001',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9303',
          providerUpdatedAt: '2026-08-13T17:04:00.000Z',
          payloadHash: 'f'.repeat(64),
        }),
      })
    assert.equal(crashed.dirtyVersion, 1)
    const crashedClaim = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-crash-worker',
        limit: 1,
      })
    assert.equal(crashedClaim.length, 1)
    assert.equal(crashedClaim[0].externalOrderId, 'gid://shopify/Order/9303')
    assert.equal(crashedClaim[0].capturedDirtyVersion, 1)
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET revision = revision + 1, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    const unexpiredClaims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-no-steal-worker',
        limit: 1,
      })
    assert.equal(unexpiredClaims.length, 0)
    const unexpired = await pool.query(
      `SELECT claim_state, policy_revision, lock_token IS NOT NULL AS locked
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9303'`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(unexpired.rows[0], {
      claim_state: 'processing', policy_revision: 5, locked: true,
    })
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         DISABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
    await pool.query(
      `UPDATE operations_shopify_order_webhook_targets
       SET locked_at = clock_timestamp() - interval '11 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9303'`,
      [ids.organization, ids.integration],
    )
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         ENABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
    const staleHealth = await persistence
      .readShopifyOrderWebhookSignalHealthFromPostgres()
    assert.equal(staleHealth.processing, 1)
    assert.equal(staleHealth.staleProcessing, 1)
    assert.equal(staleHealth.overdueDirty, 1)
    assert.equal(staleHealth.providerWrites, 0)
    const recoveredClaims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-recovery-worker',
        limit: 1,
      })
    assert.equal(recoveredClaims.length, 1)
    assert.equal(recoveredClaims[0].externalOrderId,
      'gid://shopify/Order/9303')
    assert.equal(recoveredClaims[0].capturedDirtyVersion, 1)
    assert.equal(recoveredClaims[0].policyRevision, 6)
    assert.equal(recoveredClaims[0].attemptCount, 1)
    const recoveredRead = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: recoveredClaims[0],
        observation: {
          ...observation('2026-08-13T17:04:00.000Z'),
          externalOrderId: 'gid://shopify/Order/9303',
          sourceRevision: '2026-08-13T17:04:00.000Z',
          sourceHash: '3'.repeat(64),
          lines: [],
        },
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(recoveredRead.status, 'idle')
    assert.equal(recoveredRead.reconciledVersion, 1)
    const cleanHealth = await persistence
      .readShopifyOrderWebhookSignalHealthFromPostgres()
    assert.deepEqual({
      pendingDirty: cleanHealth.pendingDirty,
      processing: cleanHealth.processing,
      staleProcessing: cleanHealth.staleProcessing,
      failed: cleanHealth.failed,
      dead: cleanHealth.dead,
      overdueDirty: cleanHealth.overdueDirty,
      providerWrites: cleanHealth.providerWrites,
    }, {
      pendingDirty: 0,
      processing: 0,
      staleProcessing: 0,
      failed: 0,
      dead: 0,
      overdueDirty: 0,
      providerWrites: 0,
    })
    assert.ok(cleanHealth.lastSignaledAt)
    assert.ok(cleanHealth.lastSucceededAt)
    assert.ok(cleanHealth.lastProcessedAt)
    assert.equal(cleanHealth.lastFailedAt, null)

    const failed = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93040001',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9304',
          providerUpdatedAt: '2026-08-13T17:04:30.000Z',
          payloadHash: '4'.repeat(64),
        }),
      })
    assert.equal(failed.dirtyVersion, 1)
    const failedClaim = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-failure-worker',
        limit: 1,
      })
    assert.equal(failedClaim.length, 1)
    assert.equal(failedClaim[0].externalOrderId, 'gid://shopify/Order/9304')
    const failedResult = await persistence
      .failShopifyOrderWebhookExactReadInPostgres({
        claim: failedClaim[0],
        error: { code: 'SHOPIFY_UPSTREAM_FAILED' },
      })
    assert.equal(failedResult.status, 'failed')
    const failedBeforeRetry = await pool.query(
      `SELECT attempt_count, available_at, claim_state
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9304'`,
      [ids.organization, ids.integration],
    )
    const earlyRetry = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-early-retry-worker',
        limit: 1,
      })
    assert.equal(earlyRetry.length, 0)
    const failedAfterRetry = await pool.query(
      `SELECT attempt_count, available_at, claim_state
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9304'`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(failedAfterRetry.rows[0], failedBeforeRetry.rows[0],
      'Current-revision failure backoff and retry budget must be preserved')
    assert.equal(failedAfterRetry.rows[0].attempt_count, 1)
    assert.equal(failedAfterRetry.rows[0].claim_state, 'failed')
    const failedHealth = await persistence
      .readShopifyOrderWebhookSignalHealthFromPostgres()
    assert.equal(failedHealth.failed, 1)
    assert.equal(failedHealth.dead, 0)
    assert.equal(failedHealth.lastFailedAt !== null, true)
    assert.equal(failedHealth.providerWrites, 0)

    const currentCrash = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93060001',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9306',
          providerUpdatedAt: '2026-08-13T17:04:45.000Z',
          payloadHash: '6'.repeat(64),
        }),
      })
    assert.equal(currentCrash.dirtyVersion, 1)
    const currentCrashClaim = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-current-crash-worker',
        limit: 1,
      })
    assert.equal(currentCrashClaim.length, 1)
    assert.equal(currentCrashClaim[0].externalOrderId,
      'gid://shopify/Order/9306')
    assert.equal(currentCrashClaim[0].attemptCount, 1)
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         DISABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
    await pool.query(
      `UPDATE operations_shopify_order_webhook_targets
       SET locked_at = clock_timestamp() - interval '11 minutes',
           lease_expires_at = clock_timestamp() - interval '1 minute'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9306'`,
      [ids.organization, ids.integration],
    )
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         ENABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
    const currentReclaim = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-current-reclaim-worker',
        limit: 1,
      })
    assert.equal(currentReclaim.length, 1)
    assert.equal(currentReclaim[0].externalOrderId,
      'gid://shopify/Order/9306')
    assert.equal(currentReclaim[0].policyRevision,
      currentCrashClaim[0].policyRevision)
    assert.equal(currentReclaim[0].attemptCount, 2,
      'Current-revision expired leases must retain the retry budget')
    const currentCrashRead = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: currentReclaim[0],
        observation: {
          ...observation('2026-08-13T17:04:45.000Z'),
          externalOrderId: 'gid://shopify/Order/9306',
          sourceRevision: '2026-08-13T17:04:45.000Z',
          sourceHash: '6'.repeat(64),
          lines: [],
        },
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(currentCrashRead.status, 'idle')
    assert.equal(currentCrashRead.reconciledVersion, 1)

    const drifted = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: 'webhook-order-event-93020001',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9302',
          providerUpdatedAt: '2026-08-13T17:05:00.000Z',
          payloadHash: 'e'.repeat(64),
        }),
      })
    assert.equal(drifted.dirtyVersion, 1)
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET revision = revision + 1, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET verification_status = 'failed',
           last_error_code = 'TEST_CREDENTIAL_DRIFT',
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    await rejection(
      pool.query(
        `UPDATE operations_shopify_order_webhook_targets
         SET policy_revision = 7, updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND external_order_id = 'gid://shopify/Order/9302'`,
        [ids.organization, ids.integration],
      ),
      /(?:policy rebase|target transition) is invalid/u,
    )
    const driftClaims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-drift-worker',
        limit: 1,
      })
    assert.equal(driftClaims.length, 0)
    const staleTarget = await pool.query(
      `SELECT claim_state, policy_revision, dirty_version,
              reconciled_version, last_error_code,
              provider_read_count, provider_write_count
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9302'`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(staleTarget.rows[0], {
      claim_state: 'dead',
      policy_revision: 6,
      dirty_version: '1',
      reconciled_version: '0',
      last_error_code: 'SHOPIFY_ORDER_WEBHOOK_LINEAGE_STALE',
      provider_read_count: '0',
      provider_write_count: 0,
    })
    const degradedHealth = await persistence
      .readShopifyOrderWebhookSignalHealthFromPostgres()
    assert.equal(degradedHealth.pendingDirty, 0)
    assert.equal(degradedHealth.processing, 0)
    assert.equal(degradedHealth.staleProcessing, 0)
    assert.equal(degradedHealth.failed, 1)
    assert.equal(degradedHealth.dead, 1)
    assert.equal(degradedHealth.overdueDirty, 0)
    assert.ok(degradedHealth.lastSignaledAt)
    assert.ok(degradedHealth.lastSucceededAt)
    assert.ok(degradedHealth.lastFailedAt)
    assert.ok(degradedHealth.lastProcessedAt)
    assert.equal(degradedHealth.providerWrites, 0)
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET verification_status = 'verified',
           verified_at = now(), last_error_code = NULL,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )

    const staleHistoricalClaims = await commerceOrderSync
      .claimCommerceOrderBackfillsInPostgres({
        workerId: 'shopify-order-webhook-stale-history-sweep',
        limit: 1,
      })
    assert.equal(staleHistoricalClaims.length, 0)
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         DISABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
    await pool.query(
      `UPDATE operations_shopify_order_webhook_targets
       SET available_at = now() + interval '1 day'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9304'`,
      [ids.organization, ids.integration],
    )
    await pool.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         ENABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )

    for (const suffix of ['9311', '9312']) {
      await persistence.recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        providerEventId: `webhook-order-event-${suffix}0001`,
        evidence: evidence({
          externalOrderId: `gid://shopify/Order/${suffix}`,
          providerUpdatedAt: `2026-08-13T17:0${suffix === '9311' ? '6' : '7'}:00.000Z`,
          payloadHash: (suffix === '9311' ? '1' : '2').repeat(64),
        }),
      })
    }
    const policyRaceClaims = await persistence
      .claimShopifyOrderWebhookTargetsInPostgres({
        workerId: 'shopify-order-webhook-policy-race-worker',
        limit: 2,
      })
    assert.equal(policyRaceClaims.length, 2)
    const appendAfterBumpClaim = policyRaceClaims.find(
      (claim) => claim.externalOrderId === 'gid://shopify/Order/9311',
    )
    const failAfterBumpClaim = policyRaceClaims.find(
      (claim) => claim.externalOrderId === 'gid://shopify/Order/9312',
    )
    assert.ok(appendAfterBumpClaim)
    assert.ok(failAfterBumpClaim)
    const policyBeforeBackfillRequest = appendAfterBumpClaim.policyRevision
    const compatibleBackfill = await commerceOrderSync
      .requestCommerceOrderBackfillInPostgres({
        organizationId: ids.organization,
        accountGlobalId: runtime(ids).globalId,
        actorEmail,
        idempotencyKey: 'webhook-active-claim-policy-bump-9301',
        reason: 'Prove an in-flight exact read survives a poll request revision bump',
      })
    assert.equal(compatibleBackfill.status, 'pending')
    assert.equal(compatibleBackfill.providerWrites, 0)
    const policyAfterBackfillRequest = await pool.query(
      `SELECT revision, continuous_transport,
              provider_event_processor_state
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    assert.ok(
      Number(policyAfterBackfillRequest.rows[0].revision)
        > policyBeforeBackfillRequest,
    )
    assert.equal(policyAfterBackfillRequest.rows[0].continuous_transport,
      'webhook_signal_plus_poll')
    assert.equal(
      policyAfterBackfillRequest.rows[0].provider_event_processor_state,
      'available',
    )
    const appendAfterBump = await persistence
      .appendShopifyOrderWebhookExactReadInPostgres({
        claim: appendAfterBumpClaim,
        observation: {
          ...observation('2026-08-13T17:06:00.000Z'),
          externalOrderId: 'gid://shopify/Order/9311',
          sourceRevision: '2026-08-13T17:06:00.000Z',
          sourceHash: '1'.repeat(64),
          lines: [],
        },
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: true,
      })
    assert.equal(appendAfterBump.status, 'idle')
    assert.equal(appendAfterBump.reconciledVersion, 1)
    assert.equal(appendAfterBump.providerWrites, 0)
    const failAfterBump = await persistence
      .failShopifyOrderWebhookExactReadInPostgres({
        claim: failAfterBumpClaim,
        error: { code: 'SHOPIFY_ACTIVE_READ_FAILED' },
      })
    assert.equal(failAfterBump.status, 'failed')
    assert.equal(failAfterBump.providerWrites, 0)
    const failedAfterPolicyBump = await pool.query(
      `SELECT claim_state, last_error_code, attempt_count,
              provider_write_count
       FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = 'gid://shopify/Order/9312'`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(failedAfterPolicyBump.rows[0], {
      claim_state: 'failed',
      last_error_code: 'SHOPIFY_ACTIVE_READ_FAILED',
      attempt_count: 1,
      provider_write_count: 0,
    })

    const historicalClaims = await commerceOrderSync
      .claimCommerceOrderBackfillsInPostgres({
        workerId: 'shopify-order-webhook-lineage-worker',
        limit: 1,
      })
    assert.equal(historicalClaims.length, 1)
    const historicalClaim = historicalClaims[0]
    assert.equal(historicalClaim.sessionKind, 'historical_backfill')
    const historicalObservation = await pool.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         provider_created_at, provider_updated_at, observed_at,
         provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', 1,
         'historical_backfill', 'gid://shopify/Order/9390', '#9390',
         $4::text, $5, 'open', 'paid', 'unfulfilled', 'none',
         $4::timestamptz, $4::timestamptz, $4::timestamptz, 3
       ) RETURNING id::text`,
      [
        ids.organization,
        ids.integration,
        historicalClaim.id,
        historicalClaim.requestedThrough,
        '9'.repeat(64),
      ],
    )
    const historicalObservationId = historicalObservation.rows[0].id
    await pool.query('SET session_replication_role = replica')
    try {
      await pool.query(
        `UPDATE operations_commerce_credentials
         SET external_account_id = 'gid://shopify/Shop/999999'
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [ids.organization, ids.integration],
      )
    } finally {
      await pool.query('SET session_replication_role = origin')
    }
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observations (
           organization_id, integration_account_id, backfill_session_id,
           provider, credential_generation, observation_kind,
           external_order_id, order_number, source_revision, source_hash,
           canonical_lifecycle_state, canonical_payment_state,
           canonical_fulfillment_state, canonical_return_state,
           provider_created_at, provider_updated_at, observed_at,
           provider_read_count
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'shopify', 1,
           'historical_backfill', 'gid://shopify/Order/9391', '#9391',
           $4::text, $5, 'open', 'paid', 'unfulfilled', 'none',
           $4::timestamptz, $4::timestamptz, $4::timestamptz, 3
         )`,
        [
          ids.organization,
          ids.integration,
          historicalClaim.id,
          historicalClaim.requestedThrough,
          'a'.repeat(64),
        ],
      ),
      /backfill lineage is invalid/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observation_lines (
           organization_id, observation_id, external_line_id,
           original_quantity, current_quantity, unfulfilled_quantity,
           fulfilled_quantity, requires_shipping
         ) VALUES ($1::uuid, $2::uuid, 'line-identity-drift', 1, 1, 1, 0, true)`,
        [ids.organization, historicalObservationId],
      ),
      /observation line lineage is invalid/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           provider, external_order_id, event_hash, event_kind,
           sensitive_evidence_expires_at, occurred_at, observed_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'shopify',
           'gid://shopify/Order/9390', $4, 'order_updated',
           now() + interval '30 days', now(), now()
         )`,
        [
          ids.organization,
          ids.integration,
          historicalObservationId,
          'b'.repeat(64),
        ],
      ),
      /event observation session is sealed/u,
    )
    await pool.query('SET session_replication_role = replica')
    try {
      await pool.query(
        `UPDATE operations_commerce_credentials
         SET external_account_id = 'gid://shopify/Shop/9301'
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [ids.organization, ids.integration],
      )
    } finally {
      await pool.query('SET session_replication_role = origin')
    }

    const unreadyDiscovery = {
      accountGlobalId: runtime(ids).globalId,
      credentialGeneration: 1,
      discoveryState: 'succeeded',
      subscriptionReady: false,
      ready: false,
    }
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{orderWebhookSubscriptions}', $3::jsonb, true
           ), updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        ids.integration,
        JSON.stringify(unreadyDiscovery),
      ],
    )
    const alignmentClient = await pool.connect()
    try {
      await alignmentClient.query('BEGIN')
      const downgraded = await persistence
        .downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient(
          alignmentClient,
          {
            organizationId: ids.organization,
            accountGlobalId: runtime(ids).globalId,
            credentialGeneration: 1,
          },
        )
      assert.equal(downgraded.downgraded, true)
      assert.ok(downgraded.policyRevision)
      assert.equal(downgraded.providerWrites, 0)
      await alignmentClient.query('COMMIT')
    } catch (error) {
      await alignmentClient.query('ROLLBACK')
      throw error
    } finally {
      alignmentClient.release()
    }
    const downgradedPolicy = await pool.query(
      `SELECT continuous_transport, provider_event_processor_state
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(downgradedPolicy.rows[0], {
      continuous_transport: 'scheduled_poll',
      provider_event_processor_state: 'processor_pending',
    })
    await rejection(
      persistence.recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        // The runtime snapshot still contains the prior ready discovery, but
        // the locked account row above contains the newer unready result.
        runtime: runtime(ids),
        providerEventId: 'webhook-order-event-93019998',
        evidence: evidence({
          providerUpdatedAt: '2026-08-13T17:18:00.000Z',
          payloadHash: '6'.repeat(64),
        }),
      }),
      /subscription evidence is not current/u,
    )
    const staleRuntimeIngress = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_webhook_signals
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider_event_id = 'webhook-order-event-93019998'`,
      [ids.organization, ids.integration],
    )
    assert.equal(staleRuntimeIngress.rows[0].count, 0)
    const policyAfterStaleRuntimeIngress = await pool.query(
      `SELECT continuous_transport, provider_event_processor_state
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(policyAfterStaleRuntimeIngress.rows[0], {
      continuous_transport: 'scheduled_poll',
      provider_event_processor_state: 'processor_pending',
    })
    const staleDiscovery = orderWebhookSubscriptionEvidence(
      runtime(ids).globalId,
      { observedAt: '2026-08-11T17:00:00.000Z' },
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{orderWebhookSubscriptions}', $3::jsonb, true
           ), updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        ids.integration,
        JSON.stringify(staleDiscovery),
      ],
    )
    const staleDiscoveryAccepted = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        runtime: runtime(ids),
        providerEventId: 'webhook-order-event-93019997',
        evidence: evidence({
          providerUpdatedAt: '2026-08-13T17:19:00.000Z',
          payloadHash: '7'.repeat(64),
        }),
      })
    assert.equal(staleDiscoveryAccepted.providerWrites, 0)
    const staleDiscoveryIngress = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_shopify_order_webhook_signals
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND provider_event_id = 'webhook-order-event-93019997'`,
      [ids.organization, ids.integration],
    )
    assert.equal(
      staleDiscoveryIngress.rows[0].count,
      1,
      'older-than-24h exact evidence must accept an already HMAC-verified signal',
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{orderWebhookSubscriptions,desiredUri}',
             to_jsonb($3::text), true
           ), updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        ids.integration,
        `https://drift.example.test/api/integrations/commerce/shopify/webhooks/${runtime(ids).globalId}`,
      ],
    )
    await rejection(
      persistence.recordShopifyOrderWebhookSignalInPostgres({
        ...input,
        runtime: runtime(ids),
        providerEventId: 'webhook-order-event-93019996',
        evidence: evidence({
          providerUpdatedAt: '2026-08-13T17:20:00.000Z',
          payloadHash: '8'.repeat(64),
        }),
      }),
      /subscription evidence is not current/u,
    )
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET continuous_transport = 'webhook_signal_plus_poll',
           provider_event_processor_state = 'available',
           revision = revision + 1, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
             configuration, '{orderWebhookSubscriptions}', $3::jsonb, true
           ), updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        ids.integration,
        JSON.stringify({
          ...unreadyDiscovery,
          discoveryState: 'failed',
        }),
      ],
    )
    const failedDiscoveryClient = await pool.connect()
    try {
      await failedDiscoveryClient.query('BEGIN')
      const unchanged = await persistence
        .downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient(
          failedDiscoveryClient,
          {
            organizationId: ids.organization,
            accountGlobalId: runtime(ids).globalId,
            credentialGeneration: 1,
          },
        )
      assert.deepEqual(JSON.parse(JSON.stringify(unchanged)), {
        downgraded: false,
        policyRevision: null,
        providerWrites: 0,
      })
      await failedDiscoveryClient.query('COMMIT')
    } catch (error) {
      await failedDiscoveryClient.query('ROLLBACK')
      throw error
    } finally {
      failedDiscoveryClient.release()
    }
    const policyAfterFailedDiscovery = await pool.query(
      `SELECT continuous_transport, provider_event_processor_state
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, ids.integration],
    )
    assert.deepEqual(policyAfterFailedDiscovery.rows[0], {
      continuous_transport: 'webhook_signal_plus_poll',
      provider_event_processor_state: 'available',
    })

    const webhookFirstAccountId = randomUUID()
    const webhookFirstAccount = await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'commerce', 'sandbox',
         'Webhook first Shopify', 'active', $3::jsonb,
         'gid://shopify/Shop/9330', 1, $4, $4
       ) RETURNING global_id`,
      [
        webhookFirstAccountId,
        ids.organization,
        JSON.stringify({
          shopDomain: 'webhook-first.myshopify.com',
          grantedScopes: ['read_orders', 'read_all_orders'],
        }),
        actorEmail,
      ],
    )
    const webhookFirstGlobalId = webhookFirstAccount.rows[0].global_id
    const webhookFirstConfiguration = {
      shopDomain: 'webhook-first.myshopify.com',
      grantedScopes: ['read_orders', 'read_all_orders'],
      orderWebhookSubscriptions:
        orderWebhookSubscriptionEvidence(webhookFirstGlobalId),
    }
    await pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = $3::jsonb, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        ids.organization,
        webhookFirstAccountId,
        JSON.stringify(webhookFirstConfiguration),
      ],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         webhook_verified_at, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/9330',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '9330', 'verified', now(), 'verified', now(), $3, $3
       )`,
      [ids.organization, webhookFirstAccountId, actorEmail],
    )
    const webhookFirstRuntime = {
      ...runtime(ids),
      integrationAccountId: webhookFirstAccountId,
      globalId: webhookFirstGlobalId,
      environment: 'sandbox',
      externalAccountId: 'gid://shopify/Shop/9330',
      configuration: webhookFirstConfiguration,
    }
    const webhookFirstSignal = await persistence
      .recordShopifyOrderWebhookSignalInPostgres({
        runtime: webhookFirstRuntime,
        providerEventId: 'webhook-first-order-event-93300001',
        sourceDomain: 'webhook-first.myshopify.com',
        providerApiVersion: '2026-07',
        providerTriggeredAt: '2026-08-13T17:10:01.000Z',
        evidence: evidence({
          externalOrderId: 'gid://shopify/Order/9330',
          providerUpdatedAt: '2026-08-13T17:10:00.000Z',
          payloadHash: 'd'.repeat(64),
        }),
      })
    assert.equal(webhookFirstSignal.providerWrites, 0)
    const webhookFirstPolicy = await pool.query(
      `SELECT continuous_transport, provider_event_processor_state,
              continuous_high_watermark IS NOT NULL AS has_high_watermark,
              created_by, updated_by
       FROM operations_commerce_order_sync_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, webhookFirstAccountId],
    )
    assert.deepEqual(webhookFirstPolicy.rows[0], {
      continuous_transport: 'webhook_signal_plus_poll',
      provider_event_processor_state: 'available',
      has_high_watermark: true,
      created_by: actorEmail,
      updated_by: actorEmail,
    })
    const webhookFirstBackstop = await commerceOrderSync
      .ensureContinuousCommerceOrderPollsInPostgres({ limit: 5 })
    assert.equal(webhookFirstBackstop.scheduled, 1)
    assert.equal(webhookFirstBackstop.providerWrites, 0)
    const webhookFirstPoll = await pool.query(
      `SELECT session_kind, status, requested_by
       FROM operations_commerce_order_backfill_sessions
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, webhookFirstAccountId],
    )
    assert.deepEqual(webhookFirstPoll.rows[0], {
      session_kind: 'continuous_poll',
      status: 'pending',
      requested_by: actorEmail,
    })
    await rejection(
      pool.query(
        `UPDATE operations_integration_accounts
         SET provider = 'faire', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, ids.integration],
      ),
      /credentialed commerce account provider and type are immutable/u,
    )
    await rejection(
      pool.query(
        `UPDATE operations_commerce_order_sync_policies
         SET authority = 'clawpilot', updated_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [ids.organization, ids.integration],
      ),
      /check constraint/u,
    )
    assert.equal(audits.length, 27)
    assert.equal(audits[0].payload.providerWrites, 0)
    assert.equal(audits[0].payload.scheduledPollBackstop, true)
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-order-webhook-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=shopify_order_webhook',
      '-e', 'POSTGRES_DB=shopify_order_webhook',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0)
    const databaseUrl = (
      'postgresql://postgres:shopify_order_webhook@127.0.0.1:'
      + `${port}/shopify_order_webhook`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    let ids
    try {
      const files = migrations()
      const revisionIndex = files.indexOf(
        '0273_operations_commerce_order_revisions.sql',
      )
      assert.ok(revisionIndex > 0)
      for (const file of files.slice(0, revisionIndex)) {
        await applyMigration(client, file)
      }
      ids = orderIds()
      await seedBeforeRevisionMigration(client, ids)
      for (const file of files.slice(revisionIndex)) {
        await applyMigration(client, file)
      }
      await client.query(
        `INSERT INTO operations_commerce_order_sync_policies (
           organization_id, integration_account_id,
           historical_observation_enabled, continuous_observation_enabled,
           continuous_transport, provider_event_processor_state, revision,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, false, true, 'scheduled_poll',
           'processor_pending', 1, $3, $3
         ) ON CONFLICT (organization_id, integration_account_id) DO NOTHING`,
        [ids.organization, ids.integration, actorEmail],
      )
    } finally {
      client.release()
      await pool.end()
    }
    await verify(databaseUrl, ids)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Shopify order webhook signal disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
