#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function errorCode(error) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : null
}

function emptyBatchResult() {
  return {
    status: 'succeeded',
    batchLimit: 5,
    totalEligible: 0,
    counts: {
      selected: 0,
      attempted: 0,
      refreshed: 0,
      changed: 0,
      current: 0,
      providerFulfilled: 0,
      providerCancelled: 0,
      reviewRequired: 0,
      failed: 0,
      providerReads: 0,
    },
    failedByCode: {},
    outcomes: [],
    providerWrites: 0,
    canonicalOrderWrites: 0,
  }
}

function successfulBatchResultFor(candidates) {
  const totalEligible = candidates[0]?.totalEligible || 0
  return {
    status: 'succeeded',
    batchLimit: 5,
    totalEligible,
    counts: {
      selected: candidates.length,
      attempted: candidates.length,
      refreshed: candidates.length,
      changed: 0,
      current: candidates.length,
      providerFulfilled: 0,
      providerCancelled: 0,
      reviewRequired: 0,
      failed: 0,
      providerReads: candidates.length,
    },
    failedByCode: {},
    outcomes: candidates.map((candidate) => ({
      orderGlobalId: candidate.orderGlobalId,
      provider: candidate.provider,
      outcome: 'current',
      code: null,
    })),
    providerWrites: 0,
    canonicalOrderWrites: 0,
  }
}

function successfulBatchResult(candidate) {
  return successfulBatchResultFor([candidate])
}

async function seedSecondTenant(pool) {
  const ids = {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integration: randomUUID(),
    customer: randomUUID(),
    order: randomUUID(),
  }
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES ($1::uuid, 'Order status sync tenant two', 'member', 'ga0009401')`,
      [ids.organization],
    )
    await pool.query(
      `INSERT INTO pipeline_spaces (
         id, name, owner_email, is_default, workspace_organization_id
       ) VALUES ($1::uuid, 'Order status sync tenant two', $2, true, $3::uuid)`,
      [ids.pipeline, actorEmail, ids.organization],
    )
    await pool.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES ($1::uuid, $2::uuid, 'shadow', 1)`,
      [ids.organization, ids.pipeline],
    )
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, 'gia0009401', $2::uuid, 'shopify', 'commerce', 'production',
         'Order status sync tenant two', 'active',
         '{"shopDomain":"order-status-sync-tenant-two.myshopify.com"}'::jsonb,
         'gid://shopify/Shop/9401', 1, $3, $3
       )`,
      [ids.integration, ids.organization, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/9401',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '9401', 'verified', now(), 'unverified', $3, $3
       )`,
      [ids.organization, ids.integration, actorEmail],
    )
    await pool.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, identity_key, name, relationship_type,
         source_payload, source_hash, sync_status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'order-status-sync-tenant-two',
         'customer:order-status-sync-tenant-two', 'Tenant two customer',
         'customer', '{}'::jsonb, $3, 'synced', $4, $4
       )`,
      [ids.customer, ids.pipeline, 'f'.repeat(64), actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor,
         ship_to, source_payload, created_by, updated_by
       ) VALUES (
         $1::uuid, 'gor0009401', $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'shopify', 'gid://shopify/Order/9401', '#9401',
         'imported', 'USD', 1000, '{"country":"US"}'::jsonb,
         jsonb_build_object('sourceHash', $6::text), $7, $7
       )`,
      [
        ids.order,
        ids.organization,
        ids.pipeline,
        ids.customer,
        ids.integration,
        '9'.repeat(64),
        actorEmail,
      ],
    )
    await pool.query(
      `INSERT INTO operations_commerce_order_revision_targets (
         organization_id, integration_account_id, order_id, provider,
         accepted_source_hash, claim_state, next_check_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, 'pending', now()
       )`,
      [ids.organization, ids.integration, ids.order, '9'.repeat(64)],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  return ids
}

function persistenceFor(pool) {
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderRevisions.ts',
    {
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadAccountSql: () => "account.status <> 'error'",
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
      '@/lib/auditWriter': { async recordAuditEvent() {} },
    },
  )
}

async function assertRejectsCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(errorCode(error), expectedCode)
    return true
  })
}

async function verifyCandidateScheduling(pool, persistence, ids, tenantTwo) {
  const initial = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(
    new Set(initial.map((candidate) => candidate.orderGlobalId)),
    new Set(['gor0009301', 'gor0009302', 'gor0009303']),
    'only canonical nonterminal orders in the requested tenant are initially eligible',
  )
  assert.ok(initial.every((candidate) => candidate.totalEligible === 3))
  assert.ok(initial.every((candidate) => candidate.orderGlobalId !== 'gor0009401'))

  const excluded = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
      excludeOrderGlobalIds: ['gor0009301'],
    }),
  )
  assert.deepEqual(
    new Set(excluded.map((candidate) => candidate.orderGlobalId)),
    new Set(['gor0009302', 'gor0009303']),
    'a manager continuation excludes only the already checked canonical orders',
  )
  assert.ok(excluded.every((candidate) => candidate.totalEligible === 2))
  await assertRejectsCode(
    persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
      excludeOrderGlobalIds: ['gor0009301', 'gor0009301'],
    }),
    'COMMERCE_ORDER_REVISION_REFRESH_INVALID',
  )

  const byOrder = new Map(initial.map((candidate) => [candidate.orderGlobalId, candidate]))
  const retainedCandidate = byOrder.get('gor0009301')
  assert.ok(retainedCandidate, 'receipt fixture candidate is available')

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET claim_state = CASE
           WHEN order_id = $2::uuid THEN 'failed'
           WHEN order_id = $3::uuid THEN 'processing'
           WHEN order_id = $4::uuid THEN 'dead_letter'
         END,
         next_check_at = CASE
           WHEN order_id IN ($2::uuid, $4::uuid) THEN now() + interval '1 hour'
           ELSE next_check_at
         END,
         locked_by = CASE WHEN order_id = $3::uuid THEN 'active-worker' END,
         lock_token = CASE WHEN order_id = $3::uuid THEN gen_random_uuid() END,
         locked_until = CASE
           WHEN order_id = $3::uuid THEN now() + interval '5 minutes'
         END,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND order_id IN ($2::uuid, $3::uuid, $4::uuid)`,
    [ids.organization, ids.current, ids.missing, ids.stale],
  )

  const noneEligible = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(noneEligible, [], 'future failed, active processing, and dead-letter targets are excluded')

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() - interval '1 second', updated_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.current],
  )
  const retryEligible = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(
    retryEligible.map((candidate) => candidate.orderGlobalId),
    ['gor0009301'],
    'a failed target becomes eligible only after next_check_at',
  )

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() + interval '1 hour', updated_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.current],
  )
  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET locked_until = now() - interval '1 second', updated_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.missing],
  )
  const expiredLeaseEligible = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(
    expiredLeaseEligible.map((candidate) => candidate.orderGlobalId),
    ['gor0009302'],
    'an expired processing lease is eligible for recovery',
  )
  assert.ok(
    expiredLeaseEligible.every((candidate) => candidate.orderGlobalId !== 'gor0009303'),
    'a dead-letter target remains deferred before next_check_at',
  )

  await pool.query(
    `UPDATE operations_commerce_order_revision_targets
     SET next_check_at = now() - interval '1 second', updated_at = now()
     WHERE organization_id = $1::uuid AND order_id = $2::uuid`,
    [ids.organization, ids.stale],
  )
  const deadLetterRecoveryEligible = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: ids.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(
    new Set(deadLetterRecoveryEligible.map((candidate) => candidate.orderGlobalId)),
    new Set(['gor0009302', 'gor0009303']),
    'a dead-letter target becomes manager-recoverable after next_check_at',
  )

  const tenantTwoCandidates = plain(
    await persistence.listCommerceOrderRevisionRefreshCandidatesInPostgres({
      organizationId: tenantTwo.organization,
      limit: 10,
    }),
  )
  assert.deepEqual(
    tenantTwoCandidates.map((candidate) => candidate.orderGlobalId),
    ['gor0009401'],
    'the second tenant sees only its own eligible order',
  )
  assert.equal(tenantTwoCandidates[0].totalEligible, 1)

  return retainedCandidate
}

async function verifyDurableBatchReceipts(
  pool,
  persistence,
  ids,
  tenantTwo,
  retainedCandidate,
) {
  const emptyKey = 'order-status-sync-empty-0001'
  const emptyPrepared = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: emptyKey,
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.deepEqual(emptyPrepared.candidates, [])
  assert.match(emptyPrepared.attemptToken, /^[0-9a-f-]{36}$/u)
  assert.equal(emptyPrepared.replayedResult, null)
  const emptyResult = emptyBatchResult()
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: ids.organization,
    receiptId: emptyPrepared.receiptId,
    attemptToken: emptyPrepared.attemptToken,
    result: emptyResult,
  })
  const emptyReplay = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: emptyKey,
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.deepEqual(emptyReplay.candidates, [])
  assert.equal(emptyReplay.attemptToken, null)
  assert.deepEqual(emptyReplay.replayedResult, emptyResult)
  const emptyReceipt = (await pool.query(
    `SELECT status, attempts, result_payload
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid
       AND command_type = 'operations.commerce_order_status_sync'
       AND idempotency_key = $2`,
    [ids.organization, emptyKey],
  )).rows[0]
  assert.equal(emptyReceipt.status, 'succeeded')
  assert.equal(emptyReceipt.attempts, 1)
  assert.equal(emptyReceipt.result_payload.batchLimit, 5)
  assert.equal(emptyReceipt.result_payload.totalEligible, 0)
  assert.deepEqual(emptyReceipt.result_payload.candidates, [])
  assert.deepEqual(emptyReceipt.result_payload.response, emptyResult)

  const requestHashKey = 'order-status-sync-request-hash-0001'
  const requestHashPrepared = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: requestHashKey,
      batchLimit: 5,
      candidates: [],
      excludeOrderGlobalIds: ['gor0009301'],
    }),
  )
  await assertRejectsCode(
    persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: requestHashKey,
      batchLimit: 5,
      candidates: [],
      excludeOrderGlobalIds: ['gor0009302'],
    }),
    'COMMERCE_ORDER_STATUS_SYNC_IDEMPOTENCY_CONFLICT',
  )
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: ids.organization,
    receiptId: requestHashPrepared.receiptId,
    attemptToken: requestHashPrepared.attemptToken,
    result: emptyBatchResult(),
  })

  const staleKey = 'order-status-sync-stale-0001'
  const firstAttempt = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: staleKey,
      batchLimit: 5,
      candidates: [retainedCandidate],
    }),
  )
  await pool.query(
    `UPDATE operations_command_receipts
     SET updated_at = now() - interval '6 minutes'
     WHERE id = $1::uuid`,
    [firstAttempt.receiptId],
  )
  const resumed = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: staleKey,
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.deepEqual(
    resumed.candidates,
    [retainedCandidate],
    'a stale processing receipt resumes its originally retained candidates',
  )
  assert.equal(resumed.receiptId, firstAttempt.receiptId)
  assert.notEqual(
    resumed.attemptToken,
    firstAttempt.attemptToken,
    'a reclaimed receipt receives a new attempt lease token',
  )
  const staleReceipt = (await pool.query(
    `SELECT status, attempts
     FROM operations_command_receipts
     WHERE id = $1::uuid`,
    [firstAttempt.receiptId],
  )).rows[0]
  assert.equal(staleReceipt.status, 'processing')
  assert.equal(staleReceipt.attempts, 2)
  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      receiptId: firstAttempt.receiptId,
      attemptToken: firstAttempt.attemptToken,
      result: successfulBatchResult(retainedCandidate),
    }),
    'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_STALE_ATTEMPT',
  )
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: ids.organization,
    receiptId: resumed.receiptId,
    attemptToken: resumed.attemptToken,
    result: successfulBatchResult(retainedCandidate),
  })
  const staleCompletedReceipt = (await pool.query(
    `SELECT result_payload
     FROM operations_command_receipts
     WHERE id = $1::uuid`,
    [firstAttempt.receiptId],
  )).rows[0]
  assert.deepEqual(staleCompletedReceipt.result_payload.candidates, [retainedCandidate])
  assert.deepEqual(
    staleCompletedReceipt.result_payload.response,
    successfulBatchResult(retainedCandidate),
  )
  const staleReplay = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: staleKey,
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.equal(staleReplay.attemptToken, null)
  assert.deepEqual(
    staleReplay.replayedResult,
    successfulBatchResult(retainedCandidate),
    'replay returns the validated retained response without new work',
  )

  const activeKey = 'order-status-sync-active-0001'
  const active = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: activeKey,
      batchLimit: 5,
      candidates: [retainedCandidate],
    }),
  )
  await assertRejectsCode(
    persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: activeKey,
      batchLimit: 5,
      candidates: [retainedCandidate],
    }),
    'COMMERCE_ORDER_STATUS_SYNC_IN_PROGRESS',
  )

  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: tenantTwo.organization,
      receiptId: active.receiptId,
      attemptToken: active.attemptToken,
      result: successfulBatchResult(retainedCandidate),
    }),
    'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_NOT_RETAINED',
  )
  const afterWrongTenant = (await pool.query(
    `SELECT status
     FROM operations_command_receipts
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [ids.organization, active.receiptId],
  )).rows[0]
  assert.equal(afterWrongTenant.status, 'processing', 'cross-tenant completion cannot mutate the receipt')
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: ids.organization,
    receiptId: active.receiptId,
    attemptToken: active.attemptToken,
    result: successfulBatchResult(retainedCandidate),
  })

  const secondCandidate = {
    ...retainedCandidate,
    orderGlobalId: 'gor0009311',
  }
  await assertRejectsCode(
    persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: 'order-status-sync-duplicate-candidates-0001',
      batchLimit: 5,
      candidates: [retainedCandidate, retainedCandidate],
    }),
    'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
  )
  const exactSet = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: 'order-status-sync-exact-outcomes-0001',
      batchLimit: 5,
      candidates: [retainedCandidate, secondCandidate],
    }),
  )
  const mismatched = successfulBatchResultFor([retainedCandidate, secondCandidate])
  mismatched.outcomes[1].orderGlobalId = 'gor0009312'
  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      receiptId: exactSet.receiptId,
      attemptToken: exactSet.attemptToken,
      result: mismatched,
    }),
    'COMMERCE_ORDER_STATUS_SYNC_RESULT_INVALID',
  )
  const duplicated = successfulBatchResultFor([retainedCandidate, secondCandidate])
  duplicated.outcomes[1] = { ...duplicated.outcomes[0] }
  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      receiptId: exactSet.receiptId,
      attemptToken: exactSet.attemptToken,
      result: duplicated,
    }),
    'COMMERCE_ORDER_STATUS_SYNC_RESULT_INVALID',
  )
  const wrongBatchLimit = successfulBatchResultFor([
    retainedCandidate,
    secondCandidate,
  ])
  wrongBatchLimit.batchLimit = 4
  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      receiptId: exactSet.receiptId,
      attemptToken: exactSet.attemptToken,
      result: wrongBatchLimit,
    }),
    'COMMERCE_ORDER_STATUS_SYNC_RESULT_INVALID',
  )
  const wrongTotalEligible = successfulBatchResultFor([
    retainedCandidate,
    secondCandidate,
  ])
  wrongTotalEligible.totalEligible += 1
  await assertRejectsCode(
    persistence.completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      receiptId: exactSet.receiptId,
      attemptToken: exactSet.attemptToken,
      result: wrongTotalEligible,
    }),
    'COMMERCE_ORDER_STATUS_SYNC_RESULT_INVALID',
  )
  const exactSetReceipt = (await pool.query(
    `SELECT status
     FROM operations_command_receipts
     WHERE id = $1::uuid`,
    [exactSet.receiptId],
  )).rows[0]
  assert.equal(
    exactSetReceipt.status,
    'processing',
    'invalid outcomes do not complete or corrupt the retained receipt',
  )
  const exactResult = successfulBatchResultFor([retainedCandidate, secondCandidate])
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: ids.organization,
    receiptId: exactSet.receiptId,
    attemptToken: exactSet.attemptToken,
    result: exactResult,
  })
  const exactReplay = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: ids.organization,
      actorEmail,
      idempotencyKey: 'order-status-sync-exact-outcomes-0001',
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.deepEqual(exactReplay.replayedResult, exactResult)

  const tenantReceipt = plain(
    await persistence.prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId: tenantTwo.organization,
      actorEmail,
      idempotencyKey: activeKey,
      batchLimit: 5,
      candidates: [],
    }),
  )
  assert.notEqual(
    tenantReceipt.receiptId,
    active.receiptId,
    'the same idempotency key is isolated by organization',
  )
  await persistence.completeCommerceOrderStatusSyncBatchInPostgres({
    organizationId: tenantTwo.organization,
    receiptId: tenantReceipt.receiptId,
    attemptToken: tenantReceipt.attemptToken,
    result: emptyBatchResult(),
  })
}

async function verifyAcceptance(databaseUrl, ids) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const tenantTwo = await seedSecondTenant(pool)
    const persistence = persistenceFor(pool)
    const retainedCandidate = await verifyCandidateScheduling(
      pool,
      persistence,
      ids,
      tenantTwo,
    )
    await verifyDurableBatchReceipts(
      pool,
      persistence,
      ids,
      tenantTwo,
      retainedCandidate,
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-order-status-sync-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_status_sync',
      '-e', 'POSTGRES_DB=commerce_order_status_sync',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:commerce_order_status_sync@127.0.0.1:'
      + `${port}/commerce_order_status_sync`
    )
    await waitForPostgres(databaseUrl)

    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    const files = migrations()
    const revisionIndex = files.indexOf('0273_operations_commerce_order_revisions.sql')
    assert.ok(revisionIndex > 0, '0273 commerce order revision migration is missing')
    const ids = orderIds()
    try {
      for (const file of files.slice(0, revisionIndex)) {
        await applyMigration(client, file)
      }
      await seedBeforeRevisionMigration(client, ids)
      for (const file of files.slice(revisionIndex)) {
        await applyMigration(client, file)
      }
    } finally {
      client.release()
      await pool.end()
    }
    await verifyAcceptance(databaseUrl, ids)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Commerce order status sync disposable-PostgreSQL acceptance passed')
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
