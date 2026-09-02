#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  postgresAdapter,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const actorEmail = 'order-history-batch@clawpilot.com'

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function withReplicaWrites(pool, work) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    return await work(client)
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => {})
    client.release()
  }
}

function successfulResult(candidates, remaining = 0) {
  return {
    status: 'succeeded',
    batchLimit: 10,
    totalEligible: candidates[0]?.totalEligible || 0,
    remaining,
    hasMore: remaining > 0,
    continuation: remaining > 0
      ? { mode: 'refresh_again', remaining }
      : null,
    counts: {
      selected: candidates.length,
      attempted: candidates.length,
      refreshed: candidates.length,
      changed: candidates.length,
      unavailable: 0,
      providerReads: candidates.reduce((sum, candidate) => (
        sum + (candidate.provider === 'shopify' ? 3 : 2)
      ), 0),
    },
    failedByCode: {},
    outcomes: candidates.map((candidate) => ({
      candidateGlobalId: candidate.candidateGlobalId,
      accountGlobalId: candidate.accountGlobalId,
      provider: candidate.provider,
      outcome: 'captured',
      changed: true,
      code: null,
      terminalUnsupported: false,
      providerReads: candidate.provider === 'shopify' ? 3 : 2,
    })),
    providerWrites: 0,
    canonicalOrderWrites: 0,
  }
}

function unavailableResult(candidate, input = {}) {
  const remaining = input.remaining ?? Math.max(0, candidate.totalEligible - 1)
  const code = input.code || 'FAIRE_RATE_LIMITED'
  return {
    status: 'failed',
    batchLimit: 10,
    totalEligible: candidate.totalEligible,
    remaining,
    hasMore: remaining > 0,
    continuation: remaining > 0
      ? { mode: 'refresh_again', remaining }
      : null,
    counts: {
      selected: 1,
      attempted: 1,
      refreshed: 0,
      changed: 0,
      unavailable: 1,
      providerReads: 2,
    },
    failedByCode: { [code]: 1 },
    outcomes: [{
      candidateGlobalId: candidate.candidateGlobalId,
      accountGlobalId: candidate.accountGlobalId,
      provider: candidate.provider,
      outcome: 'unavailable',
      changed: false,
      code,
      terminalUnsupported: Boolean(input.terminalUnsupported),
      providerReads: 2,
    }],
    providerWrites: 0,
    canonicalOrderWrites: 0,
  }
}

function persistenceFor(pool) {
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderHistoryBatch.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadAccountSql: () => "account.status = 'active'",
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
}

async function seedOrganization(client, suffix) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, $2, 'member', $3)`,
    [organizationId, `History batch ${suffix}`, `ga${suffix.padStart(7, '0')}`],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
    [pipelineId, `History batch ${suffix}`, actorEmail, organizationId],
  )
  return { organizationId, pipelineId }
}

async function seedAccount(client, input) {
  const integrationId = randomUUID()
  const runId = randomUUID()
  const environment = input.environment
    || (input.provider === 'shopify' ? 'sandbox' : 'production')
  const externalAccountId = input.provider === 'shopify'
    ? `gid://shopify/Shop/${input.globalId.slice(-7)}`
    : `brand_${input.globalId.slice(-7)}`
  const configuration = input.provider === 'shopify'
    ? { shopDomain: `${input.globalId}.myshopify.com` }
    : { brandId: externalAccountId }
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration,
       external_account_id, commerce_credential_generation,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4, 'commerce', $5,
       $6, $7, $8::jsonb, $9, 1, $10, $10
     )`,
    [
      integrationId,
      input.globalId,
      input.organizationId,
      input.provider,
      environment,
      `History ${input.provider} ${input.globalId}`,
      input.status || 'active',
      JSON.stringify(configuration),
      externalAccountId,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4,
       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
       decode(repeat('00', 16), 'hex'), 1, '0001', 'verified', now(),
       $5, $6, $6
     )`,
    [
      input.organizationId,
      integrationId,
      externalAccountId,
      input.provider === 'shopify'
        ? 'shopify_client_credentials'
        : 'faire_brand_token',
      input.provider === 'shopify' ? 'unverified' : 'not_applicable',
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_intake_runs (
       id, global_id, organization_id, integration_account_id, pipeline_id,
       provider, resource, credential_version, provider_api_version,
       normalizer_version, idempotency_key, request_hash, window_end,
       workflow_state, records_seen, records_staged, created_by, updated_by,
       expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6, 'orders', 1, 'history-batch-test',
       'history-batch-test-v1', $7, $8, now(),
       'held', 0, 0, $9, $9, now() + interval '7 days'
     )`,
    [
      runId,
      input.runGlobalId,
      input.organizationId,
      integrationId,
      input.pipelineId,
      input.provider,
      `history-batch-${input.runGlobalId}`,
      'e'.repeat(64),
      actorEmail,
    ],
  )
  return { integrationId, runId, externalAccountId }
}

async function seedIntakeRun(client, input) {
  const runId = randomUUID()
  await client.query(
    `INSERT INTO operations_commerce_intake_runs (
       id, global_id, organization_id, integration_account_id, pipeline_id,
       provider, resource, credential_version, provider_api_version,
       normalizer_version, idempotency_key, request_hash, window_end,
       workflow_state, records_seen, records_staged, created_by, updated_by,
       expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6, 'orders', 1, 'history-batch-test',
       'history-batch-test-v1', $7, $8, now(),
       'held', 0, 0, $9, $9, now() + interval '7 days'
     )`,
    [
      runId,
      input.runGlobalId,
      input.organizationId,
      input.integrationId,
      input.pipelineId,
      input.provider,
      `history-batch-${input.runGlobalId}`,
      'e'.repeat(64),
      actorEmail,
    ],
  )
  return runId
}

async function seedCandidate(client, input) {
  const id = randomUUID()
  const terminal = input.terminal !== false
  const sourceHash = input.sourceHash || String(input.sequence % 10).repeat(64)
  const externalOrderId = input.externalOrderId || (
    input.provider === 'shopify'
      ? `gid://shopify/Order/${10000 + input.sequence}`
      : `faire-order-${10000 + input.sequence}`
  )
  const providerAgeMinutes = input.providerAgeMinutes ?? input.sequence
  await client.query(
    `INSERT INTO operations_commerce_order_candidates (
       id, global_id, organization_id, integration_account_id, pipeline_id,
       run_id, provider, external_order_id, order_number_snapshot,
       provider_order_status_raw, provider_financial_status_raw,
       provider_fulfillment_status_raw, provider_return_status_raw,
       normalized_order_status, normalized_payment_status,
       normalized_fulfillment_status, normalized_return_status,
       requires_shipping, currency_code, subtotal_minor, discount_minor,
       brand_discount_minor, shipping_minor, tax_minor,
       other_adjustment_minor, total_minor, party_snapshot_state,
       customer_resolution_state, ship_to_snapshot_state,
       ship_to_snapshot_source, delivery_resolution_state,
       provider_updated_at, observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       $7, $8, $9,
       $10, 'PAID', $11, 'NONE',
       $12, 'paid', $13, 'none',
       true, 'USD', 1000, 0, 0, 0, 0, 0, 1000, 'missing',
       'unresolved', 'missing', 'none', 'not_supplied',
       now() - ($14::integer * interval '1 minute'),
       now() - ($14::integer * interval '1 minute'),
       $15, $16, 'history-batch-test', 'history-batch-test-v1',
       'held', '{}'::text[], 0, $17, $17, now() + interval '7 days'
     )`,
    [
      id,
      input.candidateGlobalId,
      input.organizationId,
      input.integrationId,
      input.pipelineId,
      input.runId,
      input.provider,
      externalOrderId,
      `#${10000 + input.sequence}`,
      terminal ? 'CLOSED' : 'OPEN',
      terminal ? 'FULFILLED' : 'UNFULFILLED',
      terminal ? 'closed' : 'open',
      terminal ? 'fulfilled' : 'unfulfilled',
      providerAgeMinutes,
      `history-batch-source-${input.sequence}`,
      sourceHash,
      actorEmail,
    ],
  )
  return { id, externalOrderId }
}

async function seedCanonicalOrder(client, input) {
  const canonicalOrderId = randomUUID()
  const promotionReceiptId = randomUUID()
  await client.query(
    `INSERT INTO operations_orders (
       id, global_id, organization_id, pipeline_id, customer_id,
       integration_account_id, source_provider, external_order_id,
       order_number, ship_to, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, $7, $8, $9, '{}'::jsonb, $10, $10
     )`,
    [
      canonicalOrderId,
      input.orderGlobalId,
      input.organizationId,
      input.pipelineId,
      randomUUID(),
      input.integrationId,
      input.provider,
      input.externalOrderId,
      input.orderNumber,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_command_receipts (
       id, organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, 'operations.commerce_order_promote',
       $3, $4, $5, 'succeeded', $6::uuid, now()
     )`,
    [
      promotionReceiptId,
      input.organizationId,
      `canonical-${input.externalOrderId}`,
      '9'.repeat(64),
      actorEmail,
      randomUUID(),
    ],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidates
     SET canonical_order_id = $1::uuid,
         workflow_state = 'promoted',
         requires_shipping = false,
         customer_resolution_state = 'resolved',
         customer_id = $7::uuid,
         customer_match_method = 'history_batch_test',
         delivery_resolution_state = 'not_required',
         promotion_command_receipt_id = $4::uuid,
         promotion_idempotency_key = $5,
         promotion_request_hash = $6,
         promoted_at = now()
     WHERE organization_id = $2::uuid
       AND id = $3::uuid`,
    [
      canonicalOrderId,
      input.organizationId,
      input.candidateId,
      promotionReceiptId,
      `canonical-${input.externalOrderId}`,
      '9'.repeat(64),
      randomUUID(),
    ],
  )
  return canonicalOrderId
}

async function seedFixture(pool) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    const first = await seedOrganization(client, '9811')
    const second = await seedOrganization(client, '9812')
    const shopify = await seedAccount(client, {
      ...first,
      provider: 'shopify',
      globalId: 'gia0009811',
      runGlobalId: 'gcir0009811',
    })
    const faire = await seedAccount(client, {
      ...first,
      provider: 'faire',
      globalId: 'gia0009812',
      runGlobalId: 'gcir0009812',
    })
    const disabled = await seedAccount(client, {
      ...first,
      provider: 'shopify',
      globalId: 'gia0009813',
      runGlobalId: 'gcir0009813',
      status: 'disabled',
      environment: 'production',
    })
    const otherTenant = await seedAccount(client, {
      ...second,
      provider: 'shopify',
      globalId: 'gia0009814',
      runGlobalId: 'gcir0009814',
    })
    let canonicalCandidateGlobalId = ''
    let retainedImportedCandidate = null
    for (let index = 1; index <= 12; index += 1) {
      const account = index % 2 === 0 ? faire : shopify
      const provider = index % 2 === 0 ? 'faire' : 'shopify'
      const candidateGlobalId = `gcoc${String(9810 + index).padStart(7, '0')}`
      const seeded = await seedCandidate(client, {
        ...first,
        ...account,
        provider,
        sequence: index,
        candidateGlobalId,
      })
      if (index === 3) {
        retainedImportedCandidate = {
          ...seeded,
          candidateGlobalId,
        }
      }
      if (index === 1) {
        canonicalCandidateGlobalId = candidateGlobalId
        await seedCanonicalOrder(client, {
          ...first,
          ...shopify,
          provider: 'shopify',
          externalOrderId: seeded.externalOrderId,
          candidateId: seeded.id,
          orderGlobalId: 'gor0009811',
          orderNumber: '#10001',
        })
      }
    }
    assert.ok(retainedImportedCandidate)
    const retainedWorkbenchReceiptId = randomUUID()
    await client.query(
      `INSERT INTO operations_command_receipts (
         id, organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, completed_at
       ) VALUES (
         $1::uuid, $2::uuid,
         'operations.commerce_order_workbench.update_ship_to',
         'history-batch-retained-imported-0001', $3, $4,
         'succeeded', $5::uuid, now()
       )`,
      [
        retainedWorkbenchReceiptId,
        first.organizationId,
        '7'.repeat(64),
        actorEmail,
        randomUUID(),
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_workbench (
         organization_id, integration_account_id, candidate_id,
         external_order_id, accepted_provider_source_hash,
         ship_to_edit_state, line_resolution_drafts, sync_state,
         last_command_receipt_id, last_idempotency_key,
         last_request_hash, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         'provider_snapshot', '{}'::jsonb, 'provider_snapshot',
         $6::uuid, 'history-batch-retained-imported-0001',
         $7, $8, $8
       )`,
      [
        first.organizationId,
        shopify.integrationId,
        retainedImportedCandidate.id,
        retainedImportedCandidate.externalOrderId,
        '3'.repeat(64),
        retainedWorkbenchReceiptId,
        '7'.repeat(64),
        actorEmail,
      ],
    )
    const newerImportedCandidateGlobalId = 'gcoc0009892'
    const newerImportedRunId = await seedIntakeRun(client, {
      ...first,
      ...shopify,
      provider: 'shopify',
      runGlobalId: 'gcir0009892',
    })
    await seedCandidate(client, {
      ...first,
      ...shopify,
      runId: newerImportedRunId,
      provider: 'shopify',
      sequence: 82,
      candidateGlobalId: newerImportedCandidateGlobalId,
      externalOrderId: retainedImportedCandidate.externalOrderId,
      providerAgeMinutes: 0,
      sourceHash: '8'.repeat(64),
    })
    await seedCandidate(client, {
      ...first,
      ...disabled,
      provider: 'shopify',
      sequence: 20,
      candidateGlobalId: 'gcoc0009830',
    })
    await seedCandidate(client, {
      ...second,
      ...otherTenant,
      provider: 'shopify',
      sequence: 21,
      candidateGlobalId: 'gcoc0009831',
    })
    return {
      first,
      second,
      faire,
      canonicalCandidateGlobalId,
      canonicalOrderGlobalId: 'gor0009811',
      retainedImportedCandidateGlobalId:
        retainedImportedCandidate.candidateGlobalId,
      newerImportedCandidateGlobalId,
    }
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => {})
    client.release()
  }
}

async function verify(pool) {
  const fixture = await seedFixture(pool)
  const persistence = persistenceFor(pool)
  const firstPage = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
    }),
  )
  assert.equal(firstPage.length, 10, 'one batch never exceeds the hard limit')
  assert.ok(firstPage.every((candidate) => candidate.totalEligible === 12))
  assert.ok(
    firstPage.some((candidate) => (
      candidate.candidateGlobalId === fixture.canonicalCandidateGlobalId
    )),
    'a promoted canonical order remains eligible for exact history hydration',
  )
  assert.deepEqual(
    new Set(firstPage.map((candidate) => candidate.provider)),
    new Set(['shopify', 'faire']),
    'the bounded batch supports both eligible provider types',
  )
  assert.ok(firstPage.every((candidate) => (
    ['gia0009811', 'gia0009812'].includes(candidate.accountGlobalId)
  )), 'disabled and foreign accounts are excluded')
  assert.ok(firstPage.every((candidate) => candidate.accountGlobalId !== 'gia0009814'))
  const targetedOrderKeys = [
    `canonical:${fixture.canonicalOrderGlobalId}`,
    'imported:gcoc0009812',
  ]
  const targeted = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: targetedOrderKeys,
    }),
  )
  assert.deepEqual(
    new Set(targeted.map((candidate) => candidate.candidateGlobalId)),
    new Set([fixture.canonicalCandidateGlobalId, 'gcoc0009812']),
    'canonical and imported visible-row keys select only their provider identities',
  )
  assert.ok(targeted.every((candidate) => candidate.totalEligible === 2))
  const retainedImportedTarget = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: [
        `imported:${fixture.retainedImportedCandidateGlobalId}`,
      ],
    }),
  )
  assert.equal(retainedImportedTarget.length, 1)
  assert.equal(
    retainedImportedTarget[0].candidateGlobalId,
    fixture.newerImportedCandidateGlobalId,
    'a retained imported row key hydrates the newest candidate for its provider identity',
  )
  assert.equal(retainedImportedTarget[0].totalEligible, 1)
  const canonicalThroughImportedNamespace = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: [`imported:${fixture.canonicalCandidateGlobalId}`],
    }),
  )
  assert.deepEqual(
    canonicalThroughImportedNamespace,
    [],
    'an imported key cannot target an order promoted into the canonical source',
  )
  const firstTargeted = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 1,
      orderKeys: targetedOrderKeys,
    }),
  )
  assert.equal(firstTargeted.length, 1)
  assert.equal(firstTargeted[0].totalEligible, 2)
  const remainingTargeted = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 1,
      orderKeys: targetedOrderKeys,
      excludeProviderIdentities: firstTargeted.map((candidate) => ({
        integrationAccountId: candidate.integrationAccountId,
        provider: candidate.provider,
        externalOrderId: candidate.externalOrderId,
      })),
    }),
  )
  assert.equal(remainingTargeted.length, 1)
  assert.equal(
    remainingTargeted[0].totalEligible,
    1,
    'remaining evidence stays within the visible-page target set',
  )
  const noTargets = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: [],
    }),
  )
  assert.deepEqual(noTargets, [])
  const missingTarget = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: ['canonical:gor9999999'],
    }),
  )
  assert.deepEqual(missingTarget, [])
  const duplicateTarget = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      orderKeys: [
        `canonical:${fixture.canonicalOrderGlobalId}`,
        `canonical:${fixture.canonicalOrderGlobalId}`,
      ],
    }),
  )
  assert.equal(duplicateTarget.length, 1)
  assert.equal(duplicateTarget[0].totalEligible, 1)
  const targetedIdempotencyKey = 'order-history-batch-targeted-replay-0001'
  const targetedPrepared = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey: targetedIdempotencyKey,
      batchLimit: 10,
      orderKeys: [
        `canonical:${fixture.canonicalOrderGlobalId}`,
        `canonical:${fixture.canonicalOrderGlobalId}`,
      ],
      candidates: duplicateTarget,
    }),
  )
  const targetedResult = successfulResult(duplicateTarget)
  await persistence.completeCommerceOrderHistoryBatchInPostgres({
    organizationId: fixture.first.organizationId,
    receiptId: targetedPrepared.receiptId,
    attemptToken: targetedPrepared.attemptToken,
    result: targetedResult,
  })
  const targetedReplay = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey: targetedIdempotencyKey,
      batchLimit: 10,
      orderKeys: [`canonical:${fixture.canonicalOrderGlobalId}`],
      candidates: [],
    }),
  )
  assert.deepEqual(targetedReplay.replayedResult, targetedResult)
  await assert.rejects(
    persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey: targetedIdempotencyKey,
      batchLimit: 10,
      orderKeys: ['imported:gcoc0009812'],
      candidates: [],
    }),
    (error) => (
      error.code === 'COMMERCE_ORDER_HISTORY_BATCH_IDEMPOTENCY_CONFLICT'
    ),
    'one idempotency key cannot replay a different visible-page target set',
  )
  const boundedContinuation = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 1,
      excludeProviderIdentities: firstPage.map((candidate) => ({
        integrationAccountId: candidate.integrationAccountId,
        provider: candidate.provider,
        externalOrderId: candidate.externalOrderId,
      })),
    }),
  )
  assert.equal(boundedContinuation.length, 1)
  assert.equal(
    boundedContinuation[0].totalEligible,
    2,
    'remaining evidence excludes the exact identities attempted in this batch',
  )

  const tenantTwo = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.second.organizationId,
      limit: 10,
    }),
  )
  assert.equal(tenantTwo.length, 1)
  assert.equal(tenantTwo[0].accountGlobalId, 'gia0009814')
  assert.equal(tenantTwo[0].totalEligible, 1)
  await assert.rejects(
    persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 11,
    }),
    (error) => error.code === 'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
  )
  for (const orderKeys of [
    ['imported:gcoc0009812 '],
    Array.from({ length: 101 }, (_, index) => (
      `imported:gcoc${String(1_000_000 + index)}`
    )),
  ]) {
    await assert.rejects(
      persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
        organizationId: fixture.first.organizationId,
        limit: 10,
        orderKeys,
      }),
      (error) => error.code === 'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
    )
  }

  const unavailableCandidate = firstPage.find((candidate) => (
    candidate.provider === 'faire'
  ))
  assert.ok(unavailableCandidate)
  const cooldownKey = 'order-history-batch-cooldown-0001'
  const cooldownPrepared = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey: cooldownKey,
      batchLimit: 10,
      candidates: [unavailableCandidate],
    }),
  )
  await persistence.completeCommerceOrderHistoryBatchInPostgres({
    organizationId: fixture.first.organizationId,
    receiptId: cooldownPrepared.receiptId,
    attemptToken: cooldownPrepared.attemptToken,
    result: unavailableResult(unavailableCandidate),
  })
  const cooldownReplacementGlobalId = 'gcoc0009890'
  await withReplicaWrites(pool, async (client) => {
    const cooldownReplacementRunId = await seedIntakeRun(client, {
      ...fixture.first,
      ...fixture.faire,
      provider: 'faire',
      runGlobalId: 'gcir0009890',
    })
    await seedCandidate(client, {
      ...fixture.first,
      ...fixture.faire,
      runId: cooldownReplacementRunId,
      provider: 'faire',
      sequence: 80,
      candidateGlobalId: cooldownReplacementGlobalId,
      externalOrderId: unavailableCandidate.externalOrderId,
      providerAgeMinutes: 1,
      sourceHash: 'e'.repeat(64),
    })
  })
  const duringCooldown = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
    }),
  )
  assert.ok(duringCooldown.every((candidate) => candidate.totalEligible === 11))
  assert.ok(duringCooldown.every((candidate) => (
    candidate.externalOrderId !== unavailableCandidate.externalOrderId
  )))
  await pool.query(
    `UPDATE operations_command_receipts
     SET completed_at = now() - interval '2 days'
     WHERE organization_id = $1::uuid
       AND command_type = 'operations.commerce_order_history_sync'
       AND idempotency_key = $2`,
    [fixture.first.organizationId, cooldownKey],
  )
  const afterCooldown = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
    }),
  )
  assert.ok(afterCooldown.every((candidate) => candidate.totalEligible === 12))
  const afterCooldownContinuation = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
      excludeProviderIdentities: afterCooldown.map((candidate) => ({
        integrationAccountId: candidate.integrationAccountId,
        provider: candidate.provider,
        externalOrderId: candidate.externalOrderId,
      })),
    }),
  )
  const reenteredCandidate = [
    ...afterCooldown,
    ...afterCooldownContinuation,
  ].find((candidate) => (
    candidate.externalOrderId === unavailableCandidate.externalOrderId
  ))
  assert.equal(
    reenteredCandidate?.candidateGlobalId,
    cooldownReplacementGlobalId,
    'the identity re-enters through its newest candidate after cooldown',
  )

  const unsupportedKey = 'order-history-batch-terminal-unsupported-0001'
  const unsupportedPrepared = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey: unsupportedKey,
      batchLimit: 10,
      candidates: [reenteredCandidate],
    }),
  )
  await persistence.completeCommerceOrderHistoryBatchInPostgres({
    organizationId: fixture.first.organizationId,
    receiptId: unsupportedPrepared.receiptId,
    attemptToken: unsupportedPrepared.attemptToken,
    result: unavailableResult(reenteredCandidate, {
      code: 'FAIRE_RESOURCE_NOT_FOUND',
      terminalUnsupported: true,
    }),
  })
  const terminalReplacementGlobalId = 'gcoc0009891'
  await withReplicaWrites(pool, async (client) => {
    const terminalReplacementRunId = await seedIntakeRun(client, {
      ...fixture.first,
      ...fixture.faire,
      provider: 'faire',
      runGlobalId: 'gcir0009891',
    })
    await seedCandidate(client, {
      ...fixture.first,
      ...fixture.faire,
      runId: terminalReplacementRunId,
      provider: 'faire',
      sequence: 81,
      candidateGlobalId: terminalReplacementGlobalId,
      externalOrderId: unavailableCandidate.externalOrderId,
      providerAgeMinutes: 0,
      sourceHash: 'f'.repeat(64),
    })
  })
  await pool.query(
    `UPDATE operations_command_receipts
     SET completed_at = now() - interval '1 day'
     WHERE organization_id = $1::uuid
       AND command_type = 'operations.commerce_order_history_sync'
       AND idempotency_key = $2`,
    [fixture.first.organizationId, unsupportedKey],
  )
  const afterUnsupportedCooldown = plain(
    await persistence.listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId: fixture.first.organizationId,
      limit: 10,
    }),
  )
  assert.ok(
    afterUnsupportedCooldown.every((candidate) => candidate.totalEligible === 11),
    'terminal unsupported orders do not keep hasMore true after cooldown',
  )
  assert.ok(afterUnsupportedCooldown.every((candidate) => (
    candidate.externalOrderId !== unavailableCandidate.externalOrderId
  )), 'a newer candidate cannot bypass provider-identity terminal suppression')

  const idempotencyKey = 'order-history-batch-replay-0001'
  const replayPage = afterUnsupportedCooldown
  const prepared = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey,
      batchLimit: 10,
      candidates: replayPage,
    }),
  )
  assert.equal(prepared.candidates.length, 10)
  assert.match(prepared.attemptToken, /^[0-9a-f-]{36}$/u)
  const result = successfulResult(replayPage, 1)
  await persistence.completeCommerceOrderHistoryBatchInPostgres({
    organizationId: fixture.first.organizationId,
    receiptId: prepared.receiptId,
    attemptToken: prepared.attemptToken,
    result,
  })
  const replay = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.first.organizationId,
      actorEmail,
      idempotencyKey,
      batchLimit: 10,
      candidates: [],
    }),
  )
  assert.equal(replay.attemptToken, null)
  assert.deepEqual(replay.candidates, [])
  assert.deepEqual(replay.replayedResult, result)
  const receipt = (await pool.query(
    `SELECT status, attempts, result_payload
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = 'operations.commerce_order_history_sync'
       AND idempotency_key = $2`,
    [fixture.first.organizationId, idempotencyKey],
  )).rows[0]
  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.attempts, 1)
  assert.equal(receipt.result_payload.candidates.length, 10)
  assert.equal(receipt.result_payload.response.providerWrites, 0)

  const tenantReplay = plain(
    await persistence.prepareCommerceOrderHistoryBatchInPostgres({
      organizationId: fixture.second.organizationId,
      actorEmail,
      idempotencyKey,
      batchLimit: 10,
      candidates: tenantTwo,
    }),
  )
  assert.notEqual(tenantReplay.receiptId, prepared.receiptId)
  await persistence.completeCommerceOrderHistoryBatchInPostgres({
    organizationId: fixture.second.organizationId,
    receiptId: tenantReplay.receiptId,
    attemptToken: tenantReplay.attemptToken,
    result: successfulResult(tenantTwo),
  })
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-history-batch-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=history_batch',
      '-e', 'POSTGRES_DB=history_batch',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:history_batch@127.0.0.1:${port}/history_batch`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 2 })
    const client = await pool.connect()
    try {
      for (const file of migrations()) await applyMigration(client, file)
    } finally {
      client.release()
    }
    try {
      await verify(pool)
    } finally {
      await pool.end()
    }
    console.log('Commerce order exact-history batch PostgreSQL acceptance passed')
  } finally {
    command('docker', ['rm', '-f', container], { timeout: 30_000 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
