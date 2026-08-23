#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
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

async function rejection(promise, pattern) {
  await assert.rejects(promise, pattern)
}

function evidenceHash(label) {
  return createHash('sha256').update(label).digest('hex')
}

async function verify(databaseUrl, ids) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const accountTwo = randomUUID()
  const lockOne = randomUUID()
  const lockTwo = randomUUID()
  try {
    await pool.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default,
         created_by, updated_by
       ) VALUES ($1, $2::uuid, 'owner', 'active', true, $1, $1)
       ON CONFLICT (user_email, organization_id) DO UPDATE
       SET status = 'active', updated_at = now()`,
      [actorEmail, ids.organization],
    )
    const accountTwoRow = (await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'commerce', 'sandbox',
         'Order history lineage account', 'active',
         '{"brandId":"brand_history_9402"}'::jsonb,
         'brand_history_9402', 1, $3, $3
       ) RETURNING global_id`,
      [accountTwo, ids.organization, actorEmail],
    )).rows[0]
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'brand_history_9402',
         'faire_brand_token', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '9402', 'verified', now(), 'not_applicable', $3, $3
       )`,
      [ids.organization, accountTwo, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_order_sync_policies (
         organization_id, integration_account_id,
         historical_observation_enabled, continuous_observation_enabled,
         continuous_transport, provider_event_processor_state, revision,
         created_by, updated_by
       ) VALUES
         ($1::uuid, $2::uuid, true, true, 'scheduled_poll',
          'processor_pending', 1, $4, $4),
         ($1::uuid, $3::uuid, false, true, 'scheduled_poll',
          'processor_pending', 1, $4, $4)`,
      [ids.organization, ids.integration, accountTwo, actorEmail],
    )
    const invalidSessionBase = `INSERT INTO operations_commerce_order_backfill_sessions (
      organization_id, integration_account_id, provider, session_kind,
      credential_generation, policy_revision, coverage_basis, status,
      requested_from, requested_through, idempotency_key, request_hash,
      query_hash, requested_by, reason
    ) VALUES (
      $1::uuid, $2::uuid, $3, 'historical_backfill', $4, $5,
      $6, 'pending', $7::timestamptz, $8::timestamptz, $9, $10, $11, $12,
      'Invalid lineage regression fixture'
    )`
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, ids.integration, 'faire', 1, 1,
        'faire_provider_available_orders', null, new Date().toISOString(),
        'invalid-provider-session', '0'.repeat(64), '1'.repeat(64), actorEmail,
      ]),
      /session lineage is invalid/u,
    )
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, ids.integration, 'shopify', 2, 1,
        'shopify_rolling_60_days',
        new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString(),
        new Date().toISOString(), 'invalid-generation-session',
        '2'.repeat(64), '3'.repeat(64), actorEmail,
      ]),
      /session lineage is invalid/u,
    )
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, ids.integration, 'shopify', 1, 2,
        'shopify_rolling_60_days',
        new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString(),
        new Date().toISOString(), 'invalid-policy-session',
        '4'.repeat(64), '5'.repeat(64), actorEmail,
      ]),
      /session lineage is invalid/u,
    )
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, ids.integration, 'shopify', 1, 1,
        'shopify_rolling_60_days',
        new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
        new Date().toISOString(), 'invalid-window-session',
        '6'.repeat(64), '7'.repeat(64), actorEmail,
      ]),
      /commerce_order_backfill_window_valid/u,
    )
    const futureShopifyThrough = new Date(Date.now() + 2 * 60 * 1_000)
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, ids.integration, 'shopify', 1, 1,
        'shopify_rolling_60_days',
        new Date(
          futureShopifyThrough.getTime() - 60 * 24 * 60 * 60 * 1_000,
        ).toISOString(),
        futureShopifyThrough.toISOString(), 'future-window-session',
        '8'.repeat(64), '9'.repeat(64), actorEmail,
      ]),
      /session end is not request-time bounded/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_backfill_sessions (
           organization_id, integration_account_id, provider, session_kind,
           credential_generation, policy_revision, coverage_basis, status,
           read_all_orders_scope_observed, completeness_state,
           requested_from, requested_through, idempotency_key, request_hash,
           query_hash, requested_by, reason, completed_at
         ) VALUES (
           $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 1,
           'shopify_rolling_60_days', 'succeeded', true,
           'shopify_fixed_window_orders_complete',
           date_trunc('milliseconds', now()) - interval '60 days',
           date_trunc('milliseconds', now()), 'fabricated-history-complete',
           $3, $4, $5, 'Fabricated complete history regression', now()
         )`,
        [
          ids.organization,
          ids.integration,
          'c'.repeat(64),
          'd'.repeat(64),
          actorEmail,
        ],
      ),
      /initial session state is invalid/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_backfill_sessions (
           organization_id, integration_account_id, provider, session_kind,
           credential_generation, policy_revision, coverage_basis, status,
           requested_from, requested_through, attempt_count, locked_at,
           locked_by, lock_token, lease_expires_at, idempotency_key,
           request_hash, query_hash, requested_by, reason
         ) VALUES (
           $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
           'faire_updated_at_overlap_unfenced', 'processing',
           now() - interval '1 hour', now(), 1, now(), 'fabricated-worker',
           $3::uuid, now() + interval '10 minutes',
           'fabricated-processing-session', $4, $5, $6,
           'Fabricated processing session regression'
         )`,
        [
          ids.organization,
          accountTwo,
          randomUUID(),
          'e'.repeat(64),
          'f'.repeat(64),
          actorEmail,
        ],
      ),
      /initial session state is invalid/u,
    )
    const staleFaireThrough = new Date(Date.now() - 11 * 60 * 1_000)
    await rejection(
      pool.query(invalidSessionBase, [
        ids.organization, accountTwo, 'faire', 1, 1,
        'faire_provider_available_orders', null,
        staleFaireThrough.toISOString(), 'stale-window-session',
        'a'.repeat(64), 'b'.repeat(64), actorEmail,
      ]),
      /session end is not request-time bounded/u,
    )
    const sessionOne = (await pool.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 1,
         'shopify_rolling_60_days', 'pending',
         date_trunc('milliseconds', now() - interval '60 days'),
         date_trunc('milliseconds', now()), 'history-page-nine',
         $3, $4, $5, 'Multi-page claim regression'
       ) RETURNING id::text, global_id, requested_from, requested_through`,
      [
        ids.organization, ids.integration,
        'b'.repeat(64), 'c'.repeat(64), actorEmail,
      ],
    )).rows[0]
    const sessionTwo = (await pool.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key,
         request_hash, query_hash, requested_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
         'faire_updated_at_overlap_unfenced', 'pending',
         date_trunc('milliseconds', now() - interval '1 hour'),
         date_trunc('milliseconds', now()), 'history-continuous-positive',
         $3, $4, $5, 'Continuous session mapping regression'
       ) RETURNING id::text, global_id, requested_from, requested_through`,
      [
        ids.organization, accountTwo, 'd'.repeat(64),
        'e'.repeat(64), actorEmail,
      ],
    )).rows[0]

    const adapter = postgresAdapter(pool)
    const persistence = loadTypeScriptModule(
      'app_src/lib/persistence/commerceOrderSync.ts',
      {
        '@/lib/auditWriter': { async recordAuditEvent() {} },
        '@/lib/integrations/commerceCapabilities': {
          hasEffectiveShopifyScope: () => true,
        },
        '@/lib/integrations/commerceCredentialCrypto': {
          COMMERCE_ORDER_SYNC_CURSOR_AAD_VERSION:
            'commerce-order-sync-cursor-aad-v1',
          encryptCommerceOrderSyncCursor() {
            throw new Error('final-page test must not seal a cursor')
          },
          decryptCommerceOrderSyncCursor() {
            throw new Error('append test must not decrypt a cursor')
          },
        },
        '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs': {
          resolveCommerceOrderRevisionEvidenceKeyConfig: () => ({
            activeKeyId: 'history-k1', keyIds: ['history-k1'],
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
        '@/lib/persistence/postgres': adapter,
      },
    )
    await pool.query(
      `UPDATE operations_commerce_store_sync_controls
       SET desired_state = 'paused', explicit_choice = true,
           revision = revision + 1,
           reason = 'Pause order backfill no-churn acceptance',
           updated_by = $3, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])`,
      [ids.organization, [ids.integration, accountTwo], actorEmail],
    )
    const pausedSessionState = async () => (
      await pool.query(
        `SELECT id::text, status, attempt_count, page_count,
                provider_records_seen::text, cursor_ciphertext,
                cursor_iv, cursor_tag, cursor_hash,
                lock_token::text, locked_by, locked_at::text,
                lease_expires_at::text, last_error_code, updated_at::text
         FROM operations_commerce_order_backfill_sessions
         WHERE id = ANY($1::uuid[])
         ORDER BY id::text`,
        [[sessionOne.id, sessionTwo.id]],
      )
    ).rows
    const beforePausedClaims = await pausedSessionState()
    for (let cycle = 0; cycle < 2; cycle += 1) {
      assert.deepEqual(
        Array.from(await persistence.claimCommerceOrderBackfillsInPostgres({
          workerId: `paused-order-history-${cycle}`,
          limit: 5,
        })),
        [],
      )
    }
    assert.deepEqual(
      await pausedSessionState(),
      beforePausedClaims,
      'Repeated Paused order-history claims must retain exact session and cursor evidence',
    )
    await pool.query(
      `UPDATE operations_commerce_store_sync_controls
       SET desired_state = 'running', explicit_choice = true,
           revision = revision + 1,
           reason = 'Resume retained order backfill acceptance',
           updated_by = $3, updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = ANY($2::uuid[])`,
      [ids.organization, [ids.integration, accountTwo], actorEmail],
    )
    const initialClaims = await persistence.claimCommerceOrderBackfillsInPostgres({
      workerId: 'initial-history-claims',
      limit: 5,
    })
    const baseJob = initialClaims.find((job) => job.id === sessionOne.id)
    const continuousJob = initialClaims.find((job) => job.id === sessionTwo.id)
    assert.ok(baseJob)
    assert.ok(continuousJob)
    await rejection(
      persistence.appendCommerceOrderBackfillPageInPostgres({
        job: { ...baseJob, integrationAccountId: accountTwo },
        pageNumber: 1,
        providerRecordsSeen: 0,
        observations: [],
        hasNextPage: false,
        nextProviderCursor: null,
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: false,
      }),
      /session changed/u,
    )
    const pageOne = await persistence
      .appendCommerceOrderBackfillPageInPostgres({
        job: baseJob,
        pageNumber: 1,
        providerRecordsSeen: 0,
        observations: [],
        hasNextPage: false,
        nextProviderCursor: null,
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: false,
      })
    assert.equal(pageOne.status, 'succeeded')
    const completed = (await pool.query(
      `SELECT page_count, attempt_count, status
       FROM operations_commerce_order_backfill_sessions WHERE id = $1::uuid`,
      [sessionOne.id],
    )).rows[0]
    assert.deepEqual(completed, {
      page_count: 1,
      attempt_count: 0,
      status: 'succeeded',
    })
    const exhaustedSession = (await pool.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, max_attempts,
         idempotency_key, request_hash, query_hash, requested_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'historical_backfill', 1, 1,
         'shopify_rolling_60_days', 'pending',
         now() - interval '60 days', now(), 1,
         'history-exhausted-crash', $3, $4, $5,
         'Exhausted crashed lease regression'
       ) RETURNING id::text`,
      [
        ids.organization, ids.integration,
        '7'.repeat(64), '8'.repeat(64), actorEmail,
      ],
    )).rows[0]
    const exhaustedClaim = await persistence.claimCommerceOrderBackfillsInPostgres({
      workerId: 'retry-exhaustion-test',
      limit: 1,
    })
    assert.equal(exhaustedClaim[0].id, exhaustedSession.id)
    const exhaustedFailure = await persistence
      .failCommerceOrderBackfillInPostgres({
        job: exhaustedClaim[0],
        error: Object.assign(new Error('transient provider failure'), {
          code: 'SHOPIFY_RATE_LIMITED',
        }),
      })
    assert.equal(exhaustedFailure.status, 'dead')
    const terminalized = (await pool.query(
      `SELECT status, last_error_code
       FROM operations_commerce_order_backfill_sessions
       WHERE id = $1::uuid`,
      [exhaustedSession.id],
    )).rows[0]
    assert.deepEqual(terminalized, {
      status: 'dead',
      last_error_code: 'SHOPIFY_RATE_LIMITED',
    })

    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observations (
           organization_id, integration_account_id, backfill_session_id,
           provider, credential_generation, observation_kind,
           external_order_id, order_number, source_revision, source_hash,
           canonical_lifecycle_state, canonical_payment_state,
           canonical_fulfillment_state, canonical_return_state,
           provider_updated_at, observed_at, provider_read_count
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'shopify', 1, 'scheduled_poll',
           'cross-account-session', '#cross-account', 'v1', $4,
           'open', 'paid', 'unfulfilled', 'none', now(), now(), 1
         )`,
        [ids.organization, ids.integration, sessionTwo.id, '0'.repeat(64)],
      ),
      /backfill lineage is invalid/u,
    )
    const expiredReplayTracking = 'FAIRE-EXPIRED-REPLAY-TRACKING'
    const expiredReplayFingerprint = '9'.repeat(64)
    const expiredReplayOccurredAt = new Date(
      sessionTwo.requested_through.getTime() - 401 * 24 * 60 * 60 * 1_000,
    ).toISOString()
    const historyOnlyObservation = {
      observationKind: 'scheduled_poll',
      externalOrderId: 'bo_history_9402001',
      orderNumber: '#9402001',
      sourceRevision: sessionTwo.requested_through.toISOString(),
      sourceHash: 'f'.repeat(64),
      canonicalLifecycleState: 'closed',
      canonicalPaymentState: 'refunded',
      canonicalFulfillmentState: 'fulfilled',
      canonicalReturnState: 'returned',
      currency: 'USD',
      providerTotalMinor: 1500,
      providerCreatedAt: sessionTwo.requested_from.toISOString(),
      providerUpdatedAt: sessionTwo.requested_through.toISOString(),
      observedAt: sessionTwo.requested_through.toISOString(),
      providerReadCount: 4,
      lines: [{
        externalLineId: 'oi_history_94020011',
        originalQuantity: 3,
        currentQuantity: 2,
        unfulfilledQuantity: 0,
        fulfilledQuantity: 2,
        requiresShipping: true,
      }],
      events: [{
        externalEventId: 'faire-shipment-expired-replay:tracking:0',
        externalSubjectId: 'faire-shipment-expired-replay',
        eventKind: 'tracking_updated',
        eventStatus: 'shipped',
        quantity: null,
        amountMinor: null,
        currency: null,
        inventoryEffectKind: 'none',
        attributionSource: 'provider_staff',
        providerActorFingerprint: expiredReplayFingerprint,
        providerLocationId: null,
        trackingCarrier: 'UPS',
        trackingNumber: expiredReplayTracking,
        occurredAt: expiredReplayOccurredAt,
      }],
    }
    await rejection(
      persistence.appendCommerceOrderBackfillPageInPostgres({
        job: continuousJob,
        pageNumber: 1,
        providerRecordsSeen: 1,
        observations: [{
          ...historyOnlyObservation,
          observationKind: 'historical_backfill',
        }],
        hasNextPage: false,
        nextProviderCursor: null,
        readAllOrdersScopeObserved: null,
        returnHistoryScopeObserved: null,
      }),
      /wrong observation kind/u,
    )
    await persistence.appendCommerceOrderBackfillPageInPostgres({
      job: continuousJob,
      pageNumber: 1,
      providerRecordsSeen: 1,
      observations: [historyOnlyObservation],
      hasNextPage: false,
      nextProviderCursor: null,
      readAllOrdersScopeObserved: null,
      returnHistoryScopeObserved: null,
    })
    const pollCadences = (await pool.query(
      `SELECT account.provider,
              extract(epoch FROM (
                policy.continuous_next_poll_at - clock_timestamp()
              )) / 60.0 AS minutes_until_poll
       FROM operations_commerce_order_sync_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       WHERE policy.organization_id = $1::uuid
         AND policy.integration_account_id = ANY($2::uuid[])`,
      [ids.organization, [ids.integration, accountTwo]],
    )).rows
    const shopifyCadence = Number(pollCadences.find(
      (entry) => entry.provider === 'shopify',
    ).minutes_until_poll)
    const faireCadence = Number(pollCadences.find(
      (entry) => entry.provider === 'faire',
    ).minutes_until_poll)
    assert.ok(shopifyCadence > 29 && shopifyCadence <= 30)
    assert.ok(faireCadence > 4 && faireCadence <= 5)
    const observation = (await pool.query(
      `SELECT id::text, global_id, order_id::text
       FROM operations_commerce_order_observations
       WHERE integration_account_id = $1::uuid
         AND external_order_id = $2`,
      [accountTwo, historyOnlyObservation.externalOrderId],
    )).rows[0]
    assert.equal(observation.order_id, null)
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observation_lines (
           organization_id, observation_id, external_line_id,
           original_quantity, current_quantity
         ) VALUES ($1::uuid, $2::uuid, 'sealed-child', 1, 1)`,
        [ids.organization, observation.id],
      ),
      /observation line lineage is invalid/u,
    )
    const fixtureSessions = (await pool.query(
       `WITH fixture_clock AS (
          SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
        )
        INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash, query_hash,
         requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
          'faire_updated_at_overlap_unfenced', 'pending',
          fixture_clock.clock - interval '2 days',
          fixture_clock.clock + interval '30 seconds',
          'history-pagination-fixture', $4, $5, $6,
          'Session-bound history read fixture'
       FROM fixture_clock
       UNION ALL
       SELECT $1::uuid, $3::uuid, 'shopify', 'continuous_poll', 1, 1,
          'shopify_updated_at_overlap', 'pending',
          fixture_clock.clock - interval '2 days',
          fixture_clock.clock + interval '30 seconds',
          'history-canonical-fixture', $7, $8, $6,
          'Session-bound canonical history fixture'
       FROM fixture_clock
       RETURNING provider, id::text`,
      [
        ids.organization,
        accountTwo,
        ids.integration,
        '1'.repeat(64),
        '2'.repeat(64),
        actorEmail,
        '3'.repeat(64),
        '4'.repeat(64),
      ],
    )).rows
    const claimedFixtureSessions = await persistence
      .claimCommerceOrderBackfillsInPostgres({
        workerId: 'history-read-fixtures',
        limit: 5,
      })
    const faireFixtureSession = fixtureSessions.find(
      (row) => row.provider === 'faire',
    ).id
    const shopifyFixtureSession = fixtureSessions.find(
      (row) => row.provider === 'shopify',
    ).id
    const faireFixtureJob = claimedFixtureSessions.find(
      (session) => session.id === faireFixtureSession,
    )
    assert.ok(faireFixtureJob)
    assert.ok(claimedFixtureSessions.some(
      (session) => session.id === shopifyFixtureSession,
    ))
    const evidenceObservation = (await pool.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         currency, provider_total_minor, provider_created_at,
         provider_updated_at, observed_at, provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', 1, 'scheduled_poll',
         $4, '#9402001', 'fixture-v2', $5,
         'closed', 'refunded', 'fulfilled', 'returned',
         'USD', 1500, now() - interval '1 day', now(), now(), 1
       ) RETURNING id::text, global_id`,
      [
        ids.organization,
        accountTwo,
        faireFixtureSession,
        historyOnlyObservation.externalOrderId,
        '1'.repeat(64),
      ],
    )).rows[0]
    await pool.query(
      `INSERT INTO operations_commerce_order_observation_lines (
         organization_id, observation_id, external_line_id,
         original_quantity, current_quantity, unfulfilled_quantity,
         fulfilled_quantity, requires_shipping
       ) VALUES ($1::uuid, $2::uuid, $3, 3, 2, 0, 2, true)`,
      [ids.organization, evidenceObservation.id, 'oi_history_94020011'],
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observation_lines (
           organization_id, observation_id, external_line_id,
           original_quantity, current_quantity
         ) VALUES ($1::uuid, $2::uuid, 'invalid-quantity', 1, 2)`,
        [ids.organization, evidenceObservation.id],
      ),
      /commerce_order_observation_line_quantities_valid/u,
    )
    const shopifySyncState = await persistence
      .readCommerceOrderSyncStateFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: 'gia0009301',
      })
    assert.equal(
      shopifySyncState.latestBackfill.sessionKind,
      'historical_backfill',
      'A newer continuous poll must not obscure the historical backfill state',
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_observations (
           organization_id, integration_account_id, backfill_session_id,
           order_id, provider,
           credential_generation, observation_kind, external_order_id,
           order_number, source_revision, source_hash,
           canonical_lifecycle_state, canonical_payment_state,
           canonical_fulfillment_state, canonical_return_state,
           provider_updated_at, observed_at, provider_read_count
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', 1,
           'scheduled_poll', 'wrong-order-identity', '#wrong', 'v1',
           $5, 'open', 'paid', 'unfulfilled', 'none', now(), now(), 1
         )`,
        [
          ids.organization,
          ids.integration,
          shopifyFixtureSession,
          ids.current,
          '5'.repeat(64),
        ],
      ),
      /canonical order lineage is invalid/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           provider, external_order_id, event_hash, event_kind,
           attribution_source, occurred_at, observed_at,
           sensitive_evidence_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'faire', 'wrong-event-order',
           $4, 'order_updated', 'provider_system', now(), now(),
           now() + interval '1 day'
         )`,
        [ids.organization, accountTwo, evidenceObservation.id, '2'.repeat(64)],
      ),
      /event observation lineage is invalid/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           provider, external_order_id, event_hash, event_kind,
           attribution_source, actor_email, occurred_at, observed_at,
           sensitive_evidence_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5,
           'order_updated', 'clawpilot_user', $6,
           now(), now(), now() + interval '1 day'
         )`,
        [
          ids.organization, accountTwo, evidenceObservation.id,
          historyOnlyObservation.externalOrderId, '6'.repeat(64), actorEmail,
        ],
      ),
      /attribution_source|check constraint/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           provider, external_order_id, event_hash, event_kind,
           attribution_source, tracking_number, external_event_id,
           occurred_at, observed_at, sensitive_evidence_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5,
           'tracking_updated', 'unavailable', '1ZSECRET',
           'shipment:1ZSECRET:tracking', now(), now(), now() + interval '1 day'
         )`,
        [
          ids.organization, accountTwo, evidenceObservation.id,
          historyOnlyObservation.externalOrderId, '7'.repeat(64),
        ],
      ),
      /cannot be embedded in durable identifiers/u,
    )
    await rejection(
      pool.query(
        `INSERT INTO operations_commerce_order_event_observations (
           organization_id, integration_account_id, observation_id,
           provider, external_order_id, event_hash, event_kind,
           attribution_source, occurred_at, observed_at,
           sensitive_evidence_expires_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5,
           'order_updated', 'provider_system', now() + interval '1 day',
           now(), now() + interval '2 days'
         )`,
        [
          ids.organization, accountTwo, evidenceObservation.id,
          historyOnlyObservation.externalOrderId, '8'.repeat(64),
        ],
      ),
      /commerce_order_event_sensitive_retention_valid/u,
    )
    const sensitiveTracking = '1Z-PRIVATE'
    const sensitiveFingerprint = '4'.repeat(64)
    const sensitiveEvent = (await pool.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, event_hash, event_kind,
         attribution_source, provider_actor_fingerprint,
         tracking_carrier, tracking_number, occurred_at, observed_at,
         sensitive_evidence_expires_at, external_event_id,
         external_subject_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5,
         'tracking_updated', 'provider_staff', $6, 'UPS', $7,
         now() - interval '401 days', now(), now() - interval '1 day',
         'shipment-history:tracking:0:0', 'shipment-history'
       ) RETURNING id::text`,
      [
        ids.organization, accountTwo, evidenceObservation.id,
        historyOnlyObservation.externalOrderId, '3'.repeat(64),
        sensitiveFingerprint, sensitiveTracking,
      ],
    )).rows[0]
    const redactedAtInsert = (await pool.query(
      `SELECT provider_actor_fingerprint, tracking_number,
              attribution_source, sensitive_evidence_redacted_at IS NOT NULL
                AS redacted,
              external_event_id, external_subject_id, event_hash
       FROM operations_commerce_order_event_observations
       WHERE id = $1::uuid`,
      [sensitiveEvent.id],
    )).rows[0]
    assert.deepEqual(redactedAtInsert, {
      provider_actor_fingerprint: null,
      tracking_number: null,
      attribution_source: 'unavailable',
      redacted: true,
      external_event_id: 'shipment-history:tracking:0:0',
      external_subject_id: 'shipment-history',
      event_hash: '3'.repeat(64),
    })
    assert.equal(
      JSON.stringify(redactedAtInsert).includes(sensitiveTracking),
      false,
    )
    assert.equal(
      JSON.stringify(redactedAtInsert).includes(sensitiveFingerprint),
      false,
    )
    const recentSensitiveEvent = (await pool.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, event_hash, event_kind,
         attribution_source, provider_actor_fingerprint,
         tracking_carrier, tracking_number, occurred_at, observed_at,
         sensitive_evidence_expires_at, external_event_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', $4, $5,
         'tracking_updated', 'provider_staff', $6, 'UPS', $7,
         now() - interval '399 days', now(),
         clock_timestamp() + interval '50 milliseconds',
         'shipment-recent:tracking:0:0'
       ) RETURNING id::text`,
      [
        ids.organization, accountTwo, evidenceObservation.id,
        historyOnlyObservation.externalOrderId, '5'.repeat(64),
        '6'.repeat(64), '1Z-RECENT-PRIVATE',
      ],
    )).rows[0]
    await pool.query(`SELECT pg_sleep(0.1)`)
    const expiredBeforeMaintenance = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        externalOrderId: historyOnlyObservation.externalOrderId,
      })
    assert.equal(
      JSON.stringify(expiredBeforeMaintenance).includes('1Z-RECENT-PRIVATE'),
      false,
      'Expired tracking must be masked at read even before maintenance',
    )
    assert.equal(
      JSON.stringify(expiredBeforeMaintenance).includes('6'.repeat(64)),
      false,
      'Expired provider attribution must be masked at read before maintenance',
    )
    const expiredSummaryBeforeMaintenance = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 10,
      })
    assert.equal(
      JSON.stringify(expiredSummaryBeforeMaintenance).includes(
        '1Z-RECENT-PRIVATE',
      ),
      false,
    )
    const redaction = await persistence
      .redactExpiredCommerceOrderSensitiveEvidenceInPostgres({ limit: 10 })
    assert.equal(redaction.redacted, 1)
    const redacted = (await pool.query(
      `SELECT provider_actor_fingerprint, tracking_number,
              attribution_source, sensitive_evidence_redacted_at IS NOT NULL
                AS redacted
       FROM operations_commerce_order_event_observations
       WHERE id = $1::uuid`,
      [recentSensitiveEvent.id],
    )).rows[0]
    assert.deepEqual(redacted, {
      provider_actor_fingerprint: null,
      tracking_number: null,
      attribution_source: 'unavailable',
      redacted: true,
    })

    const page = await persistence.readCommerceOrderHistorySummariesFromPostgres({
      organizationId: ids.organization,
      accountGlobalId: accountTwoRow.global_id,
      limit: 10,
    })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].observationGlobalId, evidenceObservation.global_id)
    assert.equal(page.items[0].orderGlobalId, null)
    assert.equal(page.items[0].orderedQuantity, 3)
    await pool.query(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, ship_to, source_payload, created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify', $5,
         '#wrong-history-account', 'imported', 'USD', 1500,
         '{"country":"US"}'::jsonb, '{"historyFixture":true}'::jsonb,
         $6, $6
       )`,
      [
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.integration,
        historyOnlyObservation.externalOrderId,
        actorEmail,
      ],
    )
    const wrongAccountSummary = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 10,
      })
    assert.equal(wrongAccountSummary.items[0].orderGlobalId, null)
    const laterCanonicalOrder = (await pool.query(
      `INSERT INTO operations_orders (
         organization_id, pipeline_id, customer_id, integration_account_id,
         source_provider, external_order_id, order_number, status, currency,
         merchandise_total_minor, ship_to, source_payload, created_by,
         updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'faire', $5,
         '#later-canonical-history', 'imported', 'USD', 1500,
         '{"country":"US"}'::jsonb, '{"historyFixture":true}'::jsonb,
         $6, $6
       ) RETURNING global_id`,
      [
        ids.organization,
        ids.pipeline,
        ids.customer,
        accountTwo,
        historyOnlyObservation.externalOrderId,
        actorEmail,
      ],
    )).rows[0]
    const dynamicallyLinkedSummary = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 10,
      })
    assert.equal(
      dynamicallyLinkedSummary.items[0].orderGlobalId,
      laterCanonicalOrder.global_id,
      'A canonical order created after immutable evidence must link dynamically',
    )
    const timeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        externalOrderId: historyOnlyObservation.externalOrderId,
      })
    assert.equal(timeline.items.length, 4)
    assert.equal(timeline.truncated, false)
    assert.equal(timeline.limit, 500)
    assert.equal(timeline.providerWrites, 0)
    assert.equal(
      JSON.stringify(timeline).includes(sensitiveTracking),
      false,
    )
    assert.equal(
      JSON.stringify(timeline).includes(sensitiveFingerprint),
      false,
    )
    assert.equal(
      JSON.stringify(timeline).includes(expiredReplayTracking),
      false,
    )
    assert.equal(
      JSON.stringify(timeline).includes(expiredReplayFingerprint),
      false,
    )
    assert.equal(
      timeline.items.some((entry) => (
        typeof entry.payload.sensitiveEvidenceRedactedAt === 'string'
      )),
      true,
    )
    const lineSnapshot = timeline.items.find(
      (entry) => entry.eventKind === 'order_lines_snapshot',
    )
    assert.equal(
      lineSnapshot.payload.inventorySemantics,
      'order_demand',
    )
    assert.equal(
      lineSnapshot.payload.lines[0].externalLineId,
      'oi_history_94020011',
    )
    assert.equal(
      lineSnapshot.payload.lines[0].originalQuantity,
      3,
    )
    assert.equal(
      typeof timeline.items.find(
        (entry) => entry.eventKind === 'tracking_updated',
      ).payload.sensitiveEvidenceRedactedAt,
      'string',
    )
    await pool.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, event_hash, event_kind,
         attribution_source, occurred_at, observed_at,
         sensitive_evidence_expires_at
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, 'faire', $4,
              lpad(to_hex(1000 + sequence), 64, '0'),
              'order_updated', 'provider_system',
              clock_timestamp() + sequence * interval '1 millisecond',
              clock_timestamp(),
              clock_timestamp() + interval '1 day'
       FROM generate_series(1, 500) AS sequence`,
      [
        ids.organization,
        accountTwo,
        evidenceObservation.id,
        historyOnlyObservation.externalOrderId,
      ],
    )
    const cappedTimeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        externalOrderId: historyOnlyObservation.externalOrderId,
      })
    assert.equal(cappedTimeline.items.length, 500)
    assert.equal(cappedTimeline.truncated, true)
    assert.ok(
      new Date(cappedTimeline.items[0].occurredAt).getTime()
        <= new Date(cappedTimeline.items.at(-1).occurredAt).getTime(),
      'The retained newest timeline slice must remain chronological',
    )
    const cappedLineSnapshot = cappedTimeline.items.find(
      (entry) => entry.eventKind === 'order_lines_snapshot',
    )
    assert.ok(
      cappedLineSnapshot,
      'The latest privacy-safe order-line snapshot must survive the event cap',
    )
    assert.equal(cappedLineSnapshot.payload.inventorySemantics, 'order_demand')
    assert.equal(cappedLineSnapshot.payload.lines[0].originalQuantity, 3)

    const currentTrackingNumber = 'FAIRE-CURRENT-TRACKING'
    await pool.query(
      `WITH event_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp())
                  + interval '2 seconds' AS occurred_at
       )
       INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id, event_hash,
         event_kind, attribution_source, tracking_carrier, tracking_number,
         occurred_at, observed_at, sensitive_evidence_expires_at
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, 'faire', $4,
              evidence.external_event_id, evidence.event_hash,
              'tracking_updated', 'unavailable',
              evidence.tracking_carrier, evidence.tracking_number,
              event_clock.occurred_at, event_clock.occurred_at,
              event_clock.occurred_at + interval '400 days'
       FROM event_clock
       CROSS JOIN (VALUES
         ('faire-current-state:marker', $5::text, NULL::text, NULL::text),
         ('faire-current-state:number', $6::text, 'UPS'::text, $7::text)
       ) AS evidence(
         external_event_id, event_hash, tracking_carrier, tracking_number
       )`,
      [
        ids.organization,
        accountTwo,
        evidenceObservation.id,
        historyOnlyObservation.externalOrderId,
        evidenceHash('faire-current-state-marker'),
        evidenceHash('faire-current-state-number'),
        currentTrackingNumber,
      ],
    )
    const activeTrackingSummary = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 10,
      })
    const activeTrackingOrder = activeTrackingSummary.items.find(
      (item) => item.externalOrderId === historyOnlyObservation.externalOrderId,
    )
    assert.equal(activeTrackingOrder.latestTrackingNumber, currentTrackingNumber)
    assert.equal(activeTrackingOrder.latestTrackingCarrier, 'UPS')
    assert.equal(activeTrackingOrder.trackingCount, 1)

    await pool.query(
      `WITH event_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp())
                  + interval '4 seconds' AS occurred_at
       )
       INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id, event_hash,
         event_kind, attribution_source, occurred_at, observed_at,
         sensitive_evidence_expires_at
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, 'faire', $4,
              'faire-current-state:cleared', $5,
              'tracking_updated', 'unavailable', event_clock.occurred_at,
              event_clock.occurred_at,
              event_clock.occurred_at + interval '400 days'
       FROM event_clock`,
      [
        ids.organization,
        accountTwo,
        evidenceObservation.id,
        historyOnlyObservation.externalOrderId,
        evidenceHash('faire-current-state-cleared'),
      ],
    )
    const clearedTrackingSummary = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 10,
      })
    const clearedTrackingOrder = clearedTrackingSummary.items.find(
      (item) => item.externalOrderId === historyOnlyObservation.externalOrderId,
    )
    assert.equal(clearedTrackingOrder.latestTrackingNumber, null)
    assert.equal(clearedTrackingOrder.latestTrackingCarrier, null)
    assert.equal(
      clearedTrackingOrder.trackingCount,
      1,
      'Tracking-state markers must not inflate the historical number count',
    )

    await pool.query(
      `WITH event_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp())
                  + interval '10 seconds' AS observed_at
       )
       INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id,
         external_subject_id, event_hash, event_kind, event_status,
         amount_minor, currency, inventory_effect_kind, attribution_source,
         occurred_at, observed_at, sensitive_evidence_expires_at
       )
       SELECT $1::uuid, $2::uuid, $3::uuid, 'faire', $4,
              evidence.external_event_id, 'faire-refund-timeline',
              evidence.event_hash, evidence.event_kind, evidence.event_status,
              evidence.amount_minor, evidence.currency,
              evidence.inventory_effect_kind, evidence.attribution_source,
              event_clock.observed_at - evidence.age,
              event_clock.observed_at,
              event_clock.observed_at - evidence.age + interval '400 days'
       FROM event_clock
       CROSS JOIN (VALUES
         ('timeline-refund-created', $5::text, 'refund_created'::text,
          NULL::text, NULL::bigint, NULL::text, 'unknown'::text,
          'unavailable'::text, interval '2 seconds'),
         ('timeline-payment-one', $6::text, 'payment_updated'::text,
          'PAID'::text, NULL::bigint, NULL::text, 'none'::text,
          'provider_system'::text, interval '1 second'),
         ('timeline-return-one', $7::text, 'return_updated'::text,
          'REQUESTED'::text, NULL::bigint, NULL::text, 'unknown'::text,
          'provider_system'::text, interval '1 second'),
         ('timeline-refund-one', $8::text, 'refund_updated'::text,
          NULL::text, 250::bigint, 'USD'::text, 'unknown'::text,
          'unavailable'::text, interval '1 second'),
         ('timeline-payment-two', $9::text, 'payment_updated'::text,
          'REFUNDED'::text, NULL::bigint, NULL::text, 'none'::text,
          'provider_system'::text, interval '0 seconds'),
         ('timeline-return-two', $10::text, 'return_updated'::text,
          'RETURNED'::text, NULL::bigint, NULL::text, 'unknown'::text,
          'provider_system'::text, interval '0 seconds'),
         ('timeline-refund-two', $11::text, 'refund_updated'::text,
          NULL::text, 500::bigint, 'USD'::text, 'unknown'::text,
          'unavailable'::text, interval '0 seconds')
       ) AS evidence(
         external_event_id, event_hash, event_kind, event_status,
         amount_minor, currency, inventory_effect_kind, attribution_source, age
       )`,
      [
        ids.organization,
        accountTwo,
        evidenceObservation.id,
        historyOnlyObservation.externalOrderId,
        evidenceHash('timeline-refund-created'),
        evidenceHash('timeline-payment-one'),
        evidenceHash('timeline-return-one'),
        evidenceHash('timeline-refund-one'),
        evidenceHash('timeline-payment-two'),
        evidenceHash('timeline-return-two'),
        evidenceHash('timeline-refund-two'),
      ],
    )
    const lifecycleTimeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        externalOrderId: historyOnlyObservation.externalOrderId,
      })
    const refundCreated = lifecycleTimeline.items.find(
      (entry) => entry.eventKind === 'refund_created',
    )
    assert.equal(refundCreated.eventStatus, null)
    assert.equal(refundCreated.payload.amountMinor, undefined)
    assert.deepEqual(
      Array.from(lifecycleTimeline.items)
        .filter((entry) => entry.eventKind === 'payment_updated')
        .map((entry) => entry.eventStatus),
      ['PAID', 'REFUNDED'],
    )
    assert.deepEqual(
      Array.from(lifecycleTimeline.items)
        .filter((entry) => entry.eventKind === 'return_updated')
        .map((entry) => entry.eventStatus),
      ['REQUESTED', 'RETURNED'],
    )
    assert.deepEqual(
      Array.from(lifecycleTimeline.items)
        .filter((entry) => entry.eventKind === 'refund_updated')
        .map((entry) => entry.payload.amountMinor),
      [250, 500],
    )

    const paginationRows = (await pool.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id, provider,
         credential_generation, observation_kind, external_order_id,
         order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         provider_created_at, provider_updated_at, observed_at,
         provider_read_count
       ) VALUES
         ($1::uuid, $2::uuid, $6::uuid, 'faire', 1, 'scheduled_poll',
          'pagination-a', '#pagination-a', 'v1', $3,
          'open', 'paid', 'unfulfilled', 'none',
          now() - interval '1 day', now() - interval '1 second',
          now() - interval '1 second', 1),
         ($1::uuid, $2::uuid, $6::uuid, 'faire', 1, 'scheduled_poll',
          'pagination-b', '#pagination-b', 'v1', $4,
          'open', 'paid', 'unfulfilled', 'none',
          now() - interval '1 day', now() - interval '2 seconds',
          now() - interval '2 seconds', 1),
         ($1::uuid, $2::uuid, $6::uuid, 'faire', 1, 'scheduled_poll',
          'pagination-c', '#pagination-c', 'v1', $5,
          'open', 'paid', 'unfulfilled', 'none',
          now() - interval '1 day', now() - interval '3 seconds',
          now() - interval '3 seconds', 1)
       RETURNING external_order_id, global_id`,
      [
        ids.organization,
        accountTwo,
        '9'.repeat(64),
        'a'.repeat(64),
        'b'.repeat(64),
        faireFixtureSession,
      ],
    )).rows
    const firstPaginationPage = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        limit: 2,
      })
    assert.equal(firstPaginationPage.items.length, 2)
    const paginationCursor = firstPaginationPage
      .nextCursorObservationGlobalId
    const paginationSnapshot = firstPaginationPage.snapshotObservationGlobalId
    assert.ok(paginationCursor)
    assert.ok(paginationSnapshot)
    const remainingOrder = paginationRows.find(
      (row) => !firstPaginationPage.items.some(
        (item) => item.externalOrderId === row.external_order_id,
      ),
    ).external_order_id
    const postSnapshotObservation = (await pool.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id, provider,
         credential_generation, observation_kind, external_order_id,
         order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         provider_created_at, provider_updated_at, observed_at,
         provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $5::uuid, 'faire', 1, 'scheduled_poll',
         $3, '#pagination-updated', 'v2', $4,
         'open', 'paid', 'partial', 'none',
         now() - interval '1 day', now() + interval '1 second',
         now() + interval '1 second', 1
       ) RETURNING id::text`,
      [
        ids.organization,
        accountTwo,
        remainingOrder,
        'c'.repeat(64),
        faireFixtureSession,
      ],
    )).rows[0]
    await pool.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id, event_hash,
         event_kind, attribution_source, tracking_carrier, tracking_number,
         occurred_at, observed_at, sensitive_evidence_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'faire', $4,
         'pagination-post-snapshot:tracking:0', $5, 'tracking_updated',
         'unavailable', 'UPS', 'POST-SNAPSHOT-TRACKING',
         now(), now(), now() + interval '400 days'
       )`,
      [
        ids.organization,
        accountTwo,
        postSnapshotObservation.id,
        remainingOrder,
        'e'.repeat(64),
      ],
    )
    const secondPaginationPage = await persistence
      .readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        cursorObservationGlobalId: paginationCursor,
        snapshotObservationGlobalId: paginationSnapshot,
        limit: 10,
      })
    assert.ok(secondPaginationPage.items.length > 0)
    assert.equal(
      secondPaginationPage.items.some(
        (item) => item.externalOrderId === remainingOrder,
      ),
      true,
      'A newer observation for an unreturned order must not erase it from the anchored page',
    )
    const anchoredRemainingOrder = secondPaginationPage.items.find(
      (item) => item.externalOrderId === remainingOrder,
    )
    assert.equal(anchoredRemainingOrder.fulfillmentState, 'unfulfilled')
    assert.equal(anchoredRemainingOrder.trackingCount, 0)
    assert.equal(anchoredRemainingOrder.latestTrackingNumber, null)
    const foreignCursor = (await pool.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id, provider,
         credential_generation, observation_kind, external_order_id,
         order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         provider_created_at, provider_updated_at, observed_at,
         provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $4::uuid, 'shopify', 1, 'scheduled_poll',
         'foreign-pagination-cursor', '#foreign-cursor', 'v1', $3,
         'open', 'paid', 'unfulfilled', 'none', now(), now(), now(), 1
       ) RETURNING global_id`,
      [
        ids.organization,
        ids.integration,
        'd'.repeat(64),
        shopifyFixtureSession,
      ],
    )).rows[0].global_id
    await assert.rejects(
      persistence.readCommerceOrderHistorySummariesFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        cursorObservationGlobalId: foreignCursor,
        snapshotObservationGlobalId: paginationSnapshot,
        limit: 10,
      }),
      /snapshot is unavailable|cursor/i,
    )

    const nonmemberEmail = 'history-nonmember@example.com'
    await pool.query(
      `INSERT INTO app_users (email, role, status, activated_at)
       VALUES ($1, 'member', 'active', now())
       ON CONFLICT (email) DO UPDATE SET status = 'active'`,
      [nonmemberEmail],
    )
    const canonicalOrderIdentity = (await pool.query(
      `SELECT account.global_id AS account_global_id,
              orders.external_order_id
       FROM operations_orders orders
       JOIN operations_integration_accounts account
         ON account.organization_id = orders.organization_id
        AND account.id = orders.integration_account_id
       WHERE orders.organization_id = $1::uuid
         AND orders.id = $2::uuid`,
      [ids.organization, ids.current],
    )).rows[0]
    await pool.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id, aggregate_global_id,
         event_type, payload, actor_email, correlation_id, idempotency_key
       ) VALUES (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.order.assigned', $4::jsonb, $5, $6::uuid, $7
       ), (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.pick.assigned', $8::jsonb, $5, $9::uuid, $10
       ), (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.pick.assigned', $11::jsonb, $12, $13::uuid, $14
       )`,
      [
        ids.organization,
        ids.current,
        'gor0009301',
        JSON.stringify({
          assignedTo: actorEmail,
          quantity: 1,
          customerEmail: 'private-customer@example.com',
          shippingAddress: '123 Private Street',
        }),
        actorEmail,
        randomUUID(),
        `history-domain-privacy-${randomUUID()}`,
        JSON.stringify({ assignedTo: actorEmail }),
        randomUUID(),
        `history-pick-attribution-${randomUUID()}`,
        JSON.stringify({ assignedTo: nonmemberEmail }),
        nonmemberEmail,
        randomUUID(),
        `history-nonmember-attribution-${randomUUID()}`,
      ],
    )
    const canonicalTimeline = await persistence
      .readCommerceOrderEvidenceTimelineFromPostgres({
        organizationId: ids.organization,
        orderGlobalId: 'gor0009301',
      })
    const unrelatedDomainEntry = canonicalTimeline.find(
      (entry) => entry.eventKind === 'operations.order.assigned',
    )
    assert.deepEqual(unrelatedDomainEntry.payload, {})
    assert.equal(unrelatedDomainEntry.actorEmail, null)
    assert.equal(unrelatedDomainEntry.attributionSource, 'unavailable')
    const pickEntry = canonicalTimeline.find(
      (entry) => entry.eventKind === 'operations.pick.assigned'
        && entry.actorEmail === actorEmail,
    )
    assert.deepEqual(pickEntry.payload, { assignedTo: actorEmail })
    assert.equal(pickEntry.actorEmail, actorEmail)
    assert.equal(pickEntry.attributionSource, 'clawpilot_user')
    const nonmemberPickEntry = canonicalTimeline.find(
      (entry) => entry.eventKind === 'operations.pick.assigned'
        && entry.actorEmail === null
        && Object.keys(entry.payload).length === 0,
    )
    assert.ok(nonmemberPickEntry)
    assert.equal(nonmemberPickEntry.attributionSource, 'unavailable')
    assert.equal(
      JSON.stringify(canonicalTimeline).includes(
        'private-customer@example.com',
      ),
      false,
    )
    assert.equal(
      JSON.stringify(canonicalTimeline).includes('123 Private Street'),
      false,
    )
    const externalCanonicalTimeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: canonicalOrderIdentity.account_global_id,
        externalOrderId: canonicalOrderIdentity.external_order_id,
      })
    const externalPickEntry = externalCanonicalTimeline.items.find(
      (entry) => entry.eventKind === 'operations.pick.assigned'
        && entry.actorEmail === actorEmail,
    )
    assert.deepEqual(externalPickEntry.payload, { assignedTo: actorEmail })
    assert.equal(externalPickEntry.attributionSource, 'clawpilot_user')
    assert.equal(
      externalCanonicalTimeline.items.some((entry) => (
        entry.eventKind === 'operations.pick.assigned'
          && entry.actorEmail === null
          && Object.keys(entry.payload).length === 0
      )),
      true,
      'An exact pick event cannot attribute a nonmember',
    )

    await pool.query(
      `UPDATE app_user_organization_memberships
       SET status = 'disabled', updated_at = now()
       WHERE organization_id = $1::uuid AND user_email = $2`,
      [ids.organization, actorEmail],
    )
    const disabledPickerCanonicalTimeline = await persistence
      .readCommerceOrderEvidenceTimelineFromPostgres({
        organizationId: ids.organization,
        orderGlobalId: 'gor0009301',
      })
    const disabledCanonicalPick = disabledPickerCanonicalTimeline.find(
      (entry) => entry.eventKind === 'operations.pick.assigned'
        && entry.actorEmail === actorEmail,
    )
    assert.deepEqual(disabledCanonicalPick.payload, { assignedTo: actorEmail })
    assert.equal(disabledCanonicalPick.attributionSource, 'clawpilot_user')
    const disabledPickerExternalTimeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: canonicalOrderIdentity.account_global_id,
        externalOrderId: canonicalOrderIdentity.external_order_id,
      })
    const disabledExternalPick = disabledPickerExternalTimeline.items.find(
      (entry) => entry.eventKind === 'operations.pick.assigned'
        && entry.actorEmail === actorEmail,
    )
    assert.deepEqual(disabledExternalPick.payload, { assignedTo: actorEmail })
    assert.equal(disabledExternalPick.attributionSource, 'clawpilot_user')

    const registryBeforeReplay = (await pool.query(
      `SELECT count(*) FILTER (
                WHERE entity_type = 'operations.commerce_order_observation'
              )::integer AS observations,
              count(*) FILTER (
                WHERE entity_type =
                  'operations.commerce_order_event_observation'
              )::integer AS events,
              (SELECT count(*)::integer
               FROM crm_reference_number_registry) AS numbers
       FROM crm_reference_registry`,
    )).rows[0]
    const replaySessionEvidence = (await pool.query(
      `SELECT id::text, global_id, status, lock_token::text,
              integration_account_id::text, provider, session_kind,
              credential_generation, policy_revision, query_hash,
              requested_from, requested_through, page_count,
              read_all_orders_scope_observed, return_history_state
       FROM operations_commerce_order_backfill_sessions
       WHERE id = $1::uuid`,
      [faireFixtureJob.id],
    )).rows[0]
    assert.equal(replaySessionEvidence.status, 'processing')
    assert.equal(replaySessionEvidence.lock_token, faireFixtureJob.lockToken)
    assert.equal(
      replaySessionEvidence.requested_from.toISOString(),
      faireFixtureJob.requestedFrom,
    )
    assert.equal(
      replaySessionEvidence.requested_through.toISOString(),
      faireFixtureJob.requestedThrough,
    )
    assert.equal(faireFixtureJob.accountGlobalId, accountTwoRow.global_id)
    assert.equal(faireFixtureJob.integrationAccountId, accountTwo)
    assert.equal(faireFixtureJob.queryHash, replaySessionEvidence.query_hash)
    assert.equal(faireFixtureJob.pageCount, replaySessionEvidence.page_count)
    assert.equal(faireFixtureJob.globalId, replaySessionEvidence.global_id)
    assert.equal(faireFixtureJob.provider, replaySessionEvidence.provider)
    assert.equal(faireFixtureJob.sessionKind, replaySessionEvidence.session_kind)
    assert.equal(
      faireFixtureJob.credentialGeneration,
      replaySessionEvidence.credential_generation,
    )
    assert.equal(faireFixtureJob.policyRevision, replaySessionEvidence.policy_revision)
    const replayAuthorityFence = (await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_order_backfill_sessions session
       JOIN operations_commerce_order_sync_policies policy
         ON policy.organization_id = session.organization_id
        AND policy.integration_account_id = session.integration_account_id
       JOIN operations_integration_accounts account
         ON account.organization_id = session.organization_id
        AND account.id = session.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = session.credential_generation
       JOIN operations_activation_scopes activation
         ON activation.organization_id = session.organization_id
       WHERE session.id = $1::uuid
         AND session.status = 'processing'
         AND session.lease_expires_at > now()
         AND account.status = 'active'
         AND account.commerce_credential_generation
             = session.credential_generation
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
         AND policy.authority = 'provider'
         AND policy.continuous_observation_enabled
         AND policy.revision = session.policy_revision`,
      [faireFixtureJob.id],
    )).rows[0]
    assert.equal(replayAuthorityFence.count, 1)
    const replay = await persistence.appendCommerceOrderBackfillPageInPostgres({
      job: faireFixtureJob,
      pageNumber: 1,
      providerRecordsSeen: 1,
      observations: [historyOnlyObservation],
      hasNextPage: false,
      nextProviderCursor: null,
      readAllOrdersScopeObserved: null,
      returnHistoryScopeObserved: null,
    })
    assert.equal(replay.appended, 0)
    assert.equal(replay.preserved, 1)
    assert.equal(replay.linesAppended, 0)
    assert.equal(replay.eventsAppended, 0)
    const registryAfterReplay = (await pool.query(
      `SELECT count(*) FILTER (
                WHERE entity_type = 'operations.commerce_order_observation'
              )::integer AS observations,
              count(*) FILTER (
                WHERE entity_type =
                  'operations.commerce_order_event_observation'
              )::integer AS events,
              (SELECT count(*)::integer
               FROM crm_reference_number_registry) AS numbers
       FROM crm_reference_registry`,
    )).rows[0]
    assert.deepEqual(
      registryAfterReplay,
      registryBeforeReplay,
      'An unchanged provider-page replay cannot allocate orphan observation or event IDs',
    )

    const returnCycleSession = (await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
              'faire_updated_at_overlap_unfenced', 'pending',
              fixture_clock.clock - interval '1 hour', fixture_clock.clock,
              'return-state-cycle', $3, $4, $5,
              'Observed return-state cycle regression'
       FROM fixture_clock
       RETURNING id::text`,
      [
        ids.organization,
        accountTwo,
        evidenceHash('return-state-cycle-request'),
        evidenceHash('return-state-cycle-query'),
        actorEmail,
      ],
    )).rows[0]
    const returnCycleJob = (
      await persistence.claimCommerceOrderBackfillsInPostgres({
        workerId: 'return-state-cycle',
        limit: 1,
      })
    ).find((job) => job.id === returnCycleSession.id)
    assert.ok(returnCycleJob)
    const cycleThrough = new Date(returnCycleJob.requestedThrough).getTime()
    const cycleProviderUpdatedAt = new Date(cycleThrough - 10_000).toISOString()
    const returnStateObservation = (state, quantity, offsetSeconds) => {
      const observedAt = new Date(
        cycleThrough - offsetSeconds * 1_000,
      ).toISOString()
      return {
        observationKind: 'scheduled_poll',
        externalOrderId: 'bo_return_state_cycle',
        orderNumber: '#return-state-cycle',
        sourceRevision: cycleProviderUpdatedAt,
        sourceHash: evidenceHash(`ignored-${state}-${quantity}`),
        rawReturnState: state,
        canonicalLifecycleState: 'open',
        canonicalPaymentState: 'paid',
        canonicalFulfillmentState: 'fulfilled',
        canonicalReturnState: state === 'DECLINED' ? 'none' : 'requested',
        providerCreatedAt: returnCycleJob.requestedFrom,
        providerUpdatedAt: cycleProviderUpdatedAt,
        observedAt,
        providerReadCount: 2,
        lines: [],
        events: [{
          externalEventId: `faire-return-cycle:state:${state}:${quantity}`,
          externalSubjectId: 'faire-return-cycle',
          eventKind: 'return_state_observed',
          eventStatus: state,
          quantity,
          inventoryEffectKind: 'unknown',
          attributionSource: 'provider_system',
          occurredAt: observedAt,
        }],
      }
    }
    const returnCycleResult = await persistence
      .appendCommerceOrderBackfillPageInPostgres({
        job: returnCycleJob,
        pageNumber: 1,
        providerRecordsSeen: 4,
        observations: [
          returnStateObservation('REQUESTED', 1, 4),
          returnStateObservation('DECLINED', 2, 3),
          returnStateObservation('REQUESTED', 1, 2),
          returnStateObservation('REQUESTED', 1, 1),
        ],
        hasNextPage: false,
        nextProviderCursor: null,
        readAllOrdersScopeObserved: null,
        returnHistoryScopeObserved: null,
      })
    assert.equal(returnCycleResult.appended, 3)
    assert.equal(returnCycleResult.preserved, 1)
    assert.equal(returnCycleResult.eventsAppended, 3)
    const returnCycleTimeline = await persistence
      .readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: accountTwoRow.global_id,
        externalOrderId: 'bo_return_state_cycle',
      })
    assert.deepEqual(
      JSON.parse(JSON.stringify(returnCycleTimeline.items
        .filter((event) => event.eventKind === 'return_state_observed')
        .map((event) => [event.eventStatus, event.payload.quantity]))),
      [
        ['REQUESTED', 1],
        ['DECLINED', 2],
        ['REQUESTED', 1],
      ],
      'Observed return state must retain A to B to A without duplicating an unchanged poll',
    )

    const staleSession = (await pool.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
         'faire_updated_at_overlap_unfenced', 'pending',
         now() - interval '1 hour', now(), 'stale-authority-reaper',
         $3, $4, $5, 'Stale authority reaper regression'
       ) RETURNING id::text`,
      [
        ids.organization,
        accountTwo,
        'e'.repeat(64),
        'f'.repeat(64),
        actorEmail,
      ],
    )).rows[0]
    await pool.query(
      `UPDATE operations_commerce_order_sync_policies
       SET revision = revision + 1, updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, accountTwo],
    )
    const staleClaim = await persistence.claimCommerceOrderBackfillsInPostgres({
      workerId: 'stale-authority-reaper',
      limit: 1,
    })
    assert.equal(staleClaim.some((job) => job.id === staleSession.id), false)
    const staleResult = (await pool.query(
      `SELECT status, last_error_code, lock_token, lease_expires_at,
              cursor_ciphertext
       FROM operations_commerce_order_backfill_sessions
       WHERE id = $1::uuid`,
      [staleSession.id],
    )).rows[0]
    assert.deepEqual(staleResult, {
      status: 'blocked',
      last_error_code: 'COMMERCE_ORDER_SYNC_AUTHORITY_STALE',
      lock_token: null,
      lease_expires_at: null,
      cursor_ciphertext: null,
    })
    const incompatibleAccount = randomUUID()
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, organization_id, provider, integration_type, environment,
         display_name, status, configuration, external_account_id,
         commerce_credential_generation, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'faire', 'commerce', 'production',
         'Incompatible history auth fixture', 'active',
         '{"requestedScopes":["READ_ORDERS"]}'::jsonb,
         'incompatible-history-auth', 1, $3, $3
       )`,
      [incompatibleAccount, ids.organization, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'incompatible-history-auth',
         'shopify_client_credentials', decode('02', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, 'auth', 'verified', now(), 'unverified', $3, $3
       )`,
      [ids.organization, incompatibleAccount, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_order_sync_policies (
         organization_id, integration_account_id,
         historical_observation_enabled, continuous_observation_enabled,
         continuous_transport, provider_event_processor_state, revision,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, true, true, 'scheduled_poll',
         'processor_pending', 1, $3, $3
       )`,
      [ids.organization, incompatibleAccount, actorEmail],
    )
    const incompatibleAuthSession = (await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, last_error_code,
         idempotency_key, request_hash, query_hash, requested_by, reason,
         completed_at
       )
       SELECT $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
              'faire_updated_at_overlap_unfenced', 'blocked',
              fixture_clock.clock - interval '1 hour', fixture_clock.clock,
              'COMMERCE_ORDER_SYNC_AUTH_MODE_INCOMPATIBLE',
              'incompatible-auth-mode', $3, $4, $5,
              'Incompatible provider credential auth mode regression',
              fixture_clock.clock
       FROM fixture_clock
       RETURNING id::text`,
      [
        ids.organization,
        incompatibleAccount,
        '2'.repeat(64),
        '3'.repeat(64),
        actorEmail,
      ],
    )).rows[0]
    const incompatibleClaims = await persistence
      .claimCommerceOrderBackfillsInPostgres({
        workerId: 'incompatible-auth-mode',
        limit: 1,
      })
    assert.equal(
      incompatibleClaims.some((job) => job.id === incompatibleAuthSession.id),
      false,
    )
    await pool.query(`SET session_replication_role = replica`)
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET auth_mode = 'faire_brand_token',
           credential_ciphertext = decode('03', 'hex'),
           webhook_verification_status = 'not_applicable',
           webhook_verified_at = NULL,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, incompatibleAccount],
    )
    await pool.query(`SET session_replication_role = origin`)
    const identityMismatchSession = (await pool.query(
      `WITH fixture_clock AS (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS clock
       )
       INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, idempotency_key, request_hash,
         query_hash, requested_by, reason
       )
       SELECT $1::uuid, $2::uuid, 'faire', 'continuous_poll', 1, 1,
              'faire_updated_at_overlap_unfenced', 'pending',
              fixture_clock.clock - interval '1 hour', fixture_clock.clock,
              'external-identity-mismatch', $3, $4, $5,
              'External account identity mismatch regression'
       FROM fixture_clock
       RETURNING id::text`,
      [
        ids.organization,
        incompatibleAccount,
        '4'.repeat(64),
        '5'.repeat(64),
        actorEmail,
      ],
    )).rows[0]
    await pool.query(`SET session_replication_role = replica`)
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET external_account_id = 'mismatched-history-account', updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, incompatibleAccount],
    )
    await pool.query(`SET session_replication_role = origin`)
    const mismatchedIdentityReadiness = await persistence
      .readCommerceOrderSyncStateFromPostgres({
        organizationId: ids.organization,
        accountGlobalId: (await pool.query(
          `SELECT global_id FROM operations_integration_accounts
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [ids.organization, incompatibleAccount],
        )).rows[0].global_id,
      })
    assert.equal(mismatchedIdentityReadiness, null)
    const mismatchedIdentityClaims = await persistence
      .claimCommerceOrderBackfillsInPostgres({
        workerId: 'external-identity-mismatch',
        limit: 1,
      })
    assert.equal(
      mismatchedIdentityClaims.some((job) => job.id === identityMismatchSession.id),
      false,
    )
    assert.deepEqual((await pool.query(
      `SELECT status, last_error_code
       FROM operations_commerce_order_backfill_sessions
       WHERE id = $1::uuid`,
      [identityMismatchSession.id],
    )).rows[0], {
      status: 'blocked',
      last_error_code: 'COMMERCE_ORDER_SYNC_AUTHORITY_STALE',
    })
    await pool.query(
      `DELETE FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [ids.organization, incompatibleAccount],
    )
    await rejection(
      pool.query(
        `UPDATE operations_integration_accounts
         SET provider = 'shopify', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, incompatibleAccount],
      ),
      /credentialed commerce account provider and type are immutable/u,
    )
    await rejection(
      pool.query(
        `UPDATE operations_commerce_order_backfill_sessions
         SET read_all_orders_scope_observed = true,
             completeness_state = 'shopify_fixed_window_orders_complete'
         WHERE id = $1::uuid`,
        [staleSession.id],
      ),
      /completed commerce order sync sessions are immutable/u,
    )
    await rejection(
      pool.query(
        `DELETE FROM operations_commerce_order_backfill_sessions
         WHERE id = $1::uuid`,
        [staleSession.id],
      ),
      /append-only/u,
    )

    await rejection(
      pool.query(
        `UPDATE operations_integration_accounts
         SET provider = 'shopify', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, accountTwo],
      ),
      /credentialed commerce account provider and type are immutable/u,
    )
    await rejection(
      pool.query(
        `UPDATE operations_integration_accounts
         SET integration_type = 'carrier', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [ids.organization, accountTwo],
      ),
      /credentialed commerce account provider and type are immutable/u,
    )

    const policyAccounts = [
      {
        id: randomUUID(),
        provider: 'shopify',
        externalId: 'gid://shopify/Shop/9501',
        environment: 'sandbox',
        authMode: 'shopify_client_credentials',
        configuration: {
          shopDomain: 'webhook-preserve.myshopify.com',
          grantedScopes: ['read_orders', 'read_all_orders'],
        },
        webhookAvailable: true,
        webhookEvidenceReady: true,
        credentialGeneration: 1,
        webhookEvidenceGeneration: 1,
      },
      {
        id: randomUUID(),
        provider: 'shopify',
        externalId: 'gid://shopify/Shop/9502',
        environment: 'mock',
        authMode: 'shopify_client_credentials',
        configuration: {
          shopDomain: 'scheduled-fresh.myshopify.com',
          grantedScopes: ['read_orders', 'read_all_orders'],
        },
        webhookAvailable: true,
        webhookEvidenceReady: true,
        credentialGeneration: 2,
        webhookEvidenceGeneration: 1,
      },
      {
        id: randomUUID(),
        provider: 'faire',
        externalId: 'brand_policy_9503',
        environment: 'mock',
        authMode: 'faire_brand_token',
        configuration: { brandId: 'brand_policy_9503' },
        webhookAvailable: true,
        webhookEvidenceReady: false,
        credentialGeneration: 1,
        webhookEvidenceGeneration: 0,
      },
    ]
    for (const [index, account] of policyAccounts.entries()) {
      const inserted = await pool.query(
        `INSERT INTO operations_integration_accounts (
           id, organization_id, provider, integration_type, environment,
           display_name, status, configuration, external_account_id,
           commerce_credential_generation, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'commerce', $8, $4, 'active',
           $5::jsonb, $6, $9, $7, $7
         ) RETURNING global_id`,
        [
          account.id,
          ids.organization,
          account.provider,
          `Policy preservation ${index + 1}`,
          JSON.stringify(account.configuration),
          account.externalId,
          actorEmail,
          account.environment,
          account.credentialGeneration,
        ],
      )
      account.globalId = inserted.rows[0].global_id
      if (account.provider === 'shopify' && account.webhookAvailable) {
        account.configuration.orderWebhookSubscriptions = {
          accountGlobalId: account.globalId,
          credentialGeneration: account.webhookEvidenceGeneration,
          discoveryState: 'succeeded',
          ready: true,
          subscriptionReady: true,
          exactReadProcessorReady: true,
        }
        await pool.query(
          `UPDATE operations_integration_accounts
           SET configuration = $3::jsonb, updated_at = now()
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [ids.organization, account.id, JSON.stringify(account.configuration)],
        )
      }
      await pool.query(
        `INSERT INTO operations_commerce_credentials (
           organization_id, integration_account_id, external_account_id,
           auth_mode, credential_ciphertext, credential_iv, credential_tag,
           credential_version, credential_identifier_last_four,
           verification_status, verified_at, webhook_verification_status,
           webhook_verified_at,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, decode('01', 'hex'),
           decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
           $8, $5, 'verified', now(), $6,
           CASE WHEN $6 = 'verified' THEN now() ELSE NULL END, $7, $7
         )`,
        [
          ids.organization,
          account.id,
          account.externalId,
          account.authMode,
          String(9501 + index).slice(-4),
          account.provider === 'shopify' && account.webhookEvidenceReady
            ? 'verified'
            : account.provider === 'shopify'
              ? 'unverified'
              : 'not_applicable',
          actorEmail,
          account.credentialGeneration,
        ],
      )
      if (account.webhookAvailable) {
        await pool.query(
          `INSERT INTO operations_commerce_order_sync_policies (
             organization_id, integration_account_id,
             historical_observation_enabled, continuous_observation_enabled,
             continuous_transport, provider_event_processor_state, revision,
             created_by, updated_by
           ) VALUES (
             $1::uuid, $2::uuid, false, true,
             'webhook_signal_plus_poll', 'available', 1, $3, $3
           )`,
          [ids.organization, account.id, actorEmail],
        )
      }
      await persistence.requestCommerceOrderBackfillInPostgres({
        organizationId: ids.organization,
        accountGlobalId: account.globalId,
        actorEmail,
        idempotencyKey: `policy-preservation-${index + 1}`,
        reason: `Policy transport preservation regression ${index + 1}`,
      })
    }
    const preservedPolicies = await pool.query(
      `SELECT account.provider, account.external_account_id,
              policy.continuous_transport,
              policy.provider_event_processor_state
       FROM operations_commerce_order_sync_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       WHERE policy.organization_id = $1::uuid
         AND policy.integration_account_id = ANY($2::uuid[])
       ORDER BY account.external_account_id`,
      [ids.organization, policyAccounts.map((account) => account.id)],
    )
    const activatedShopify = preservedPolicies.rows.find(
      (row) => row.external_account_id === 'gid://shopify/Shop/9501',
    )
    assert.deepEqual(activatedShopify, {
      provider: 'shopify',
      external_account_id: 'gid://shopify/Shop/9501',
      continuous_transport: 'webhook_signal_plus_poll',
      provider_event_processor_state: 'available',
    })
    const freshShopify = preservedPolicies.rows.find(
      (row) => row.external_account_id === 'gid://shopify/Shop/9502',
    )
    assert.equal(freshShopify.continuous_transport, 'scheduled_poll')
    assert.equal(freshShopify.provider_event_processor_state, 'processor_pending')
    const fairePolicy = preservedPolicies.rows.find(
      (row) => row.external_account_id === 'brand_policy_9503',
    )
    assert.equal(fairePolicy.continuous_transport, 'scheduled_poll')
    assert.equal(fairePolicy.provider_event_processor_state, 'unsupported')
    assert.equal(
      freshShopify.provider_event_processor_state,
      'processor_pending',
      'Prior-generation webhook evidence must not survive credential rotation',
    )
    const durableTransport = await persistence
      .readCommerceOrderSyncHealthFromPostgres()
    assert.ok(durableTransport.continuousTransportCounts.scheduledPoll >= 1)
    assert.equal(
      durableTransport.continuousTransportCounts.webhookSignalPlusPoll,
      1,
    )
    assert.equal(durableTransport.transport, 'mixed')
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-order-sync-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_sync',
      '-e', 'POSTGRES_DB=commerce_order_sync',
      '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0)
    const databaseUrl = `postgresql://postgres:commerce_order_sync@127.0.0.1:${port}/commerce_order_sync`
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
    } finally {
      client.release()
      await pool.end()
    }
    await verify(databaseUrl, ids)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
    })
  }
  console.log('Commerce order sync disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
