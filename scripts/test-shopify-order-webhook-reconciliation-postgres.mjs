#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  actorEmail,
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
const root = process.cwd()

const topics = [
  'orders/create',
  'orders/updated',
  'orders/edited',
  'orders/cancelled',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
]
const includeFields = ['admin_graphql_api_id', 'updated_at']

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

async function expectCode(work, code, label) {
  await assert.rejects(
    work,
    (error) => {
      assert.equal(error?.code, code, `${label}: ${String(error?.message || error)}`)
      return true
    },
    label,
  )
}

async function seed(pool) {
  const organizationId = '03030000-0000-4000-8000-000000000001'
  const accountId = '03030000-0000-4000-8000-000000000002'
  const accountGlobalId = 'gia0303001'
  const memberEmail = 'member-order-webhooks@clawpilot.test'
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active'), ($2, 'member', 'active')`,
      [actorEmail, memberEmail],
    )
    await pool.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, reference_code
       ) VALUES (
         $1::uuid, 'Order webhook reconciliation acceptance',
         'member', 'ga0303001'
       )`,
      [organizationId],
    )
    await pool.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default,
         created_by, updated_by
       ) VALUES
         ($1, $3::uuid, 'owner', 'active', true, $1, $1),
         ($2, $3::uuid, 'member', 'active', false, $1, $1)`,
      [actorEmail, memberEmail, organizationId],
    )
    await pool.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox',
         'Pro Bakery Bites test', 'active',
         '{"shopDomain":"pro-bakery-bites.myshopify.com"}'::jsonb,
         'gid://shopify/Shop/303001', 1, $4, $4
       )`,
      [accountId, accountGlobalId, organizationId, actorEmail],
    )
    await pool.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'gid://shopify/Shop/303001',
         'shopify_client_credentials', decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, '0303', 'verified', now(), 'unverified', $3, $3
       )`,
      [organizationId, accountId, actorEmail],
    )
  } finally {
    await pool.query('SET session_replication_role = origin')
  }
  return {
    organizationId,
    accountId,
    accountGlobalId,
    memberEmail,
    callbackUri: (
      'https://development.clawpilot.test/api/integrations/commerce/'
      + `shopify/webhooks/${accountGlobalId}`
    ),
  }
}

function readiness(fixture) {
  const subscriptions = topics.map((topic, index) => ({
    providerId: `gid://shopify/WebhookSubscription/${303100 + index}`,
    topic,
    uri: fixture.callbackUri,
    format: 'JSON',
    includeFields,
    exactProfile: true,
  }))
  return {
    desiredUri: fixture.callbackUri,
    requiredTopics: topics,
    requiredIncludeFields: includeFields,
    subscriptions,
    matchingTopics: topics,
    missingTopics: [],
    conflictingTopics: [],
    ready: true,
    processorState: 'available',
    providerWrites: 0,
  }
}

function prepareInput(fixture, overrides = {}) {
  return {
    organizationId: fixture.organizationId,
    accountGlobalId: fixture.accountGlobalId,
    integrationAccountId: fixture.accountId,
    credentialGeneration: 1,
    externalAccountId: 'gid://shopify/Shop/303001',
    shopDomain: 'pro-bakery-bites.myshopify.com',
    callbackUri: fixture.callbackUri,
    idempotencyKey: 'order-webhook-reconcile-03030001',
    requestHash: sha('order-webhook-request-03030001'),
    confirmationHash: sha(
      `RECONCILE 7 ORDER WEBHOOKS FOR ${fixture.accountGlobalId}`,
    ),
    actorEmail,
    ...overrides,
  }
}

async function exercise(pool) {
  const fixture = await seed(pool)
  const health = loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderWebhookReconciliationHealth.ts',
  )
  const healthyMigration = await pool.query(
    `SELECT (${health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL})
       AS applied`,
  )
  assert.equal(healthyMigration.rows[0].applied, true)
  await pool.query(
    `ALTER TABLE operations_shopify_order_webhook_attempts
     DISABLE TRIGGER protect_shopify_order_webhook_attempt_write`,
  )
  const disabledTrigger = await pool.query(
    `SELECT (${health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL})
       AS applied`,
  )
  assert.equal(disabledTrigger.rows[0].applied, false)
  await pool.query(
    `ALTER TABLE operations_shopify_order_webhook_attempts
     ENABLE TRIGGER protect_shopify_order_webhook_attempt_write`,
  )
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderWebhookReconciliation.ts',
    {
      '@/lib/integrations/shopifyOrderWebhook': {
        SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS: topics,
        SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS: includeFields,
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )

  await expectCode(
    () => persistence.prepareShopifyOrderWebhookReconciliationInPostgres(
      prepareInput(fixture, { actorEmail: fixture.memberEmail }),
    ),
    'SHOPIFY_ORDER_WEBHOOK_ACCOUNT_FORBIDDEN',
    'member authorization',
  )

  const prepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(prepareInput(fixture))
  assert.equal(prepared.status, 'prepared')
  assert.equal(prepared.replayed, false)
  const preparedReplay = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(prepareInput(fixture))
  assert.equal(preparedReplay.commandId, prepared.commandId)
  assert.equal(preparedReplay.replayed, true)
  await expectCode(
    () => persistence.prepareShopifyOrderWebhookReconciliationInPostgres(
      prepareInput(fixture, { requestHash: sha('different-request') }),
    ),
    'SHOPIFY_ORDER_WEBHOOK_IDEMPOTENCY_CONFLICT',
    'request hash replay fence',
  )

  const plan = topics.map((topic) => ({
    topic,
    action: 'create',
    providerId: null,
  }))
  const claimed = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: prepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: plan,
    })
  const durableBeforeProvider = await pool.query(
    `SELECT command.status, attempt.dispatch_state,
            jsonb_array_length(attempt.mutation_plan) AS planned
     FROM operations_shopify_order_webhook_commands command
     JOIN operations_shopify_order_webhook_attempts attempt
       ON attempt.organization_id = command.organization_id
      AND attempt.command_id = command.id
     WHERE command.id = $1::uuid`,
    [prepared.commandId],
  )
  assert.deepEqual(durableBeforeProvider.rows[0], {
    status: 'processing',
    dispatch_state: 'authorized',
    planned: 7,
  })
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_commerce_credentials
       SET verification_status = 'failed',
           last_error_code = 'TEST_ORDER_WEBHOOK_DRIFT'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [fixture.organizationId, fixture.accountId],
    ),
    /credential cannot rotate during dispatch/u,
  )

  const ready = readiness(fixture)
  const completed = await persistence
    .finalizeShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: prepared.commandId,
      attemptId: claimed.attemptId,
      actorEmail,
      outcome: 'succeeded',
      providerWriteCount: 7,
      providerReferences: ready.subscriptions.map((row) => row.providerId),
      completedMutations: plan.map((item, index) => ({
        topic: item.topic,
        action: item.action,
        providerId: ready.subscriptions[index].providerId,
      })),
      stoppedMutation: null,
      stopClassification: null,
      errorCode: null,
      resultSnapshot: {
        ready: true,
        providerWrites: 7,
        deletionWrites: 0,
      },
      readiness: ready,
    })
  assert.equal(completed.status, 'succeeded')
  const terminalReplay = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(prepareInput(fixture))
  assert.equal(terminalReplay.status, 'succeeded')
  assert.equal(terminalReplay.replayed, true)
  assert.equal(terminalReplay.resultSnapshot.ready, true)
  const configuration = await pool.query(
    `SELECT configuration->'orderWebhookSubscriptions' AS readiness,
            configuration->'orderWebhookReconciliation' AS reconciliation
     FROM operations_integration_accounts
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, fixture.accountId],
  )
  assert.equal(configuration.rows[0].readiness.ready, true)
  assert.equal(configuration.rows[0].readiness.providerWrites, 0)
  assert.equal(configuration.rows[0].reconciliation.providerWriteCount, 7)

  const recoverableInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030002',
    requestHash: sha('order-webhook-request-03030002'),
  })
  const recoverablePrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(recoverableInput)
  const recoverableClaim = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: recoverablePrepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: plan,
    })
  const completedBeforeRejection = plan.slice(0, 3).map((item, index) => ({
    topic: item.topic,
    action: item.action,
    providerId: ready.subscriptions[index].providerId,
  }))
  await persistence.finalizeShopifyOrderWebhookReconciliationInPostgres({
    organizationId: fixture.organizationId,
    commandId: recoverablePrepared.commandId,
    attemptId: recoverableClaim.attemptId,
    actorEmail,
    outcome: 'recoverable',
    providerWriteCount: 3,
    providerReferences: completedBeforeRejection.map((item) => item.providerId),
    completedMutations: completedBeforeRejection,
    stoppedMutation: plan[3],
    stopClassification: 'deterministic_rejection',
    errorCode: 'SHOPIFY_ORDER_WEBHOOK_MUTATION_REJECTED',
    resultSnapshot: {
      ready: false,
      providerWrites: 3,
      stopClassification: 'deterministic_rejection',
      deletionWrites: 0,
    },
  })
  const remountedReplay = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(recoverableInput)
  assert.equal(remountedReplay.status, 'recoverable')
  assert.equal(remountedReplay.commandId, recoverablePrepared.commandId)
  const deterministicReceipt = await pool.query(
    `SELECT provider_write_count,
            jsonb_array_length(completed_mutations) AS completed,
            stopped_mutation->>'topic' AS stopped_topic,
            stop_classification,
            cardinality(provider_references) AS provider_references
     FROM operations_shopify_order_webhook_outcomes
     WHERE organization_id = $1::uuid AND command_id = $2::uuid
       AND outcome_state = 'recoverable'`,
    [fixture.organizationId, recoverablePrepared.commandId],
  )
  assert.deepEqual(deterministicReceipt.rows[0], {
    provider_write_count: 3,
    completed: 3,
    stopped_topic: 'orders/cancelled',
    stop_classification: 'deterministic_rejection',
    provider_references: 3,
  })
  const residualPlan = plan.slice(3)
  const residualClaim = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: recoverablePrepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: residualPlan,
    })
  const residualAttempts = await pool.query(
    `SELECT attempt_number, jsonb_array_length(mutation_plan) AS planned
     FROM operations_shopify_order_webhook_attempts
     WHERE organization_id = $1::uuid AND command_id = $2::uuid
     ORDER BY attempt_number`,
    [fixture.organizationId, recoverablePrepared.commandId],
  )
  assert.deepEqual(residualAttempts.rows, [
    { attempt_number: 1, planned: 7 },
    { attempt_number: 2, planned: 4 },
  ])
  const residualCompletions = residualPlan.map((item, index) => ({
    topic: item.topic,
    action: item.action,
    providerId: ready.subscriptions[index + 3].providerId,
  }))
  await persistence.finalizeShopifyOrderWebhookReconciliationInPostgres({
    organizationId: fixture.organizationId,
    commandId: recoverablePrepared.commandId,
    attemptId: residualClaim.attemptId,
    actorEmail,
    outcome: 'succeeded',
    providerWriteCount: 4,
    providerReferences: residualCompletions.map((item) => item.providerId),
    completedMutations: residualCompletions,
    stoppedMutation: null,
    stopClassification: null,
    errorCode: null,
    resultSnapshot: { ready: true, providerWrites: 4, deletionWrites: 0 },
    readiness: ready,
  })

  const uncertainInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030003',
    requestHash: sha('order-webhook-request-03030003'),
  })
  const uncertainPrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(uncertainInput)
  const uncertainClaim = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: uncertainPrepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: plan,
    })
  await persistence.finalizeShopifyOrderWebhookReconciliationInPostgres({
    organizationId: fixture.organizationId,
    commandId: uncertainPrepared.commandId,
    attemptId: uncertainClaim.attemptId,
    actorEmail,
    outcome: 'unknown',
    providerWriteCount: null,
    providerReferences: completedBeforeRejection.map((item) => item.providerId),
    completedMutations: completedBeforeRejection,
    stoppedMutation: plan[3],
    stopClassification: 'ambiguous',
    errorCode: 'SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN',
    resultSnapshot: {
      ready: false,
      providerWrites: null,
      stopClassification: 'ambiguous',
      deletionWrites: 0,
    },
  })
  const ambiguousRemount = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(uncertainInput)
  assert.equal(ambiguousRemount.status, 'unknown')
  await expectCode(
    () => persistence.claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: uncertainPrepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: residualPlan,
    }),
    'SHOPIFY_ORDER_WEBHOOK_COMMAND_NOT_PREPARED',
    'ambiguous response must authorize zero residual writes',
  )
  await persistence.finalizeShopifyOrderWebhookReconciliationInPostgres({
    organizationId: fixture.organizationId,
    commandId: uncertainPrepared.commandId,
    attemptId: uncertainClaim.attemptId,
    actorEmail,
    outcome: 'reconciled',
    providerWriteCount: 0,
    providerReferences: [],
    completedMutations: [],
    stoppedMutation: null,
    stopClassification: null,
    errorCode: null,
    resultSnapshot: { ready: true, providerWrites: 0, deletionWrites: 0 },
    readiness: ready,
  })

  const expiredInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030004',
    requestHash: sha('order-webhook-request-03030004'),
  })
  const expiredPrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(expiredInput)
  const expiredClaim = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: expiredPrepared.commandId,
      actorEmail,
      currentCallbackUri: fixture.callbackUri,
      mutationPlan: [plan[0]],
    })
  await pool.query(
    `UPDATE operations_shopify_order_webhook_commands
     SET processing_at = now() - interval '3 minutes',
         processing_lease_expires_at = now() - interval '1 minute'
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organizationId, expiredPrepared.commandId],
  )
  const expiredRemount = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(expiredInput)
  assert.equal(expiredRemount.status, 'processing')
  assert.equal(expiredRemount.processingLeaseExpired, true)
  const expiredAttemptId = await persistence
    .markStaleShopifyOrderWebhookAttemptUnknownInPostgres({
      organizationId: fixture.organizationId,
      commandId: expiredPrepared.commandId,
      actorEmail,
    })
  assert.equal(expiredAttemptId, expiredClaim.attemptId)
  const unknownAfterRemount = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(expiredInput)
  assert.equal(unknownAfterRemount.status, 'unknown')
  await persistence.finalizeShopifyOrderWebhookReconciliationInPostgres({
    organizationId: fixture.organizationId,
    commandId: expiredPrepared.commandId,
    attemptId: expiredClaim.attemptId,
    actorEmail,
    outcome: 'reconciled',
    providerWriteCount: 0,
    providerReferences: [],
    completedMutations: [],
    stoppedMutation: null,
    stopClassification: null,
    errorCode: null,
    resultSnapshot: { ready: true, providerWrites: 0, deletionWrites: 0 },
    readiness: ready,
  })
  const outcomeCounts = await pool.query(
    `SELECT outcome_state, count(*)::integer AS count
     FROM operations_shopify_order_webhook_outcomes
     GROUP BY outcome_state ORDER BY outcome_state`,
  )
  assert.deepEqual(outcomeCounts.rows, [
    { outcome_state: 'reconciled', count: 2 },
    { outcome_state: 'recoverable', count: 1 },
    { outcome_state: 'succeeded', count: 2 },
    { outcome_state: 'unknown', count: 2 },
  ])
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_shopify_order_webhook_attempts
       SET plan_hash = $2 WHERE id = $1::uuid`,
      [claimed.attemptId, sha('changed-plan')],
    ),
    /attempts are immutable/u,
  )
  await assert.rejects(
    () => pool.query(
      `DELETE FROM operations_shopify_order_webhook_outcomes
       WHERE command_id = $1::uuid`,
      [prepared.commandId],
    ),
    /outcomes are immutable/u,
  )
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-order-webhook-0303-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=order_webhook_0303',
      '-e', 'POSTGRES_DB=order_webhook_0303',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:order_webhook_0303@127.0.0.1:'
      + `${port}/order_webhook_0303`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 4 })
    try {
      const client = await pool.connect()
      try {
        for (const file of migrations()) await applyMigration(client, file)
      } finally {
        client.release()
      }
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Shopify order webhook reconciliation PostgreSQL safety tests passed')
}

main().catch((error) => {
  console.error(error)
  if (error.cause) console.error(error.cause)
  process.exit(1)
})
