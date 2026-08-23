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
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()
assert.ok(
  ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'].includes(
    disposablePostgresImage,
  ),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
)

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

function requestHash(input) {
  return createHash('sha256').update(JSON.stringify({
    schema: 'shopify-order-webhooks-reconcile-v1',
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    integrationAccountId: input.integrationAccountId,
    credentialGeneration: input.credentialGeneration,
    externalAccountId: input.externalAccountId,
    shopDomain: input.shopDomain,
    desiredUri: input.desiredUri || input.callbackUri,
    topics,
    format: 'JSON',
    includeFields,
    actorEmail: input.actorEmail,
  })).digest('hex')
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

async function healthApplied(client, healthSql) {
  const result = await client.query(`SELECT (${healthSql}) AS applied`)
  return result.rows[0]?.applied === true
}

function loadHealthModule() {
  const orderEditingReleaseHealth = loadTypeScriptModule(
    'app_src/lib/persistence/operationsOrderEditingReleaseHealth.ts',
  )
  return loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderWebhookReconciliationHealth.ts',
    {
      '@/lib/persistence/operationsOrderEditingReleaseHealth':
        orderEditingReleaseHealth,
    },
  )
}

async function expectHealthTamper(pool, healthSql, sql, label) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(sql)
    assert.equal(
      await healthApplied(client, healthSql),
      false,
      `${label} must fail exact reconciliation health`,
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  assert.equal(
    await healthApplied(pool, healthSql),
    true,
    `${label} rollback must restore exact reconciliation health`,
  )
}

async function seed(pool) {
  const organizationId = '03030000-0000-4000-8000-000000000001'
  const accountId = '03030000-0000-4000-8000-000000000002'
  const accountGlobalId = 'gia0303001'
  const memberEmail = 'member-order-webhooks@clawpilot.test'
  const successorEmail = 'admin-order-webhooks@clawpilot.test'
  await pool.query('SET session_replication_role = replica')
  try {
    await pool.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active'), ($2, 'member', 'active'),
         ($3, 'admin', 'active')`,
      [actorEmail, memberEmail, successorEmail],
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
         ($1, $4::uuid, 'owner', 'active', true, $1, $1),
         ($2, $4::uuid, 'member', 'active', false, $1, $1),
         ($3, $4::uuid, 'admin', 'active', false, $1, $1)`,
      [actorEmail, memberEmail, successorEmail, organizationId],
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
    successorEmail,
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
  const input = {
    organizationId: fixture.organizationId,
    accountGlobalId: fixture.accountGlobalId,
    integrationAccountId: fixture.accountId,
    credentialGeneration: 1,
    externalAccountId: 'gid://shopify/Shop/303001',
    shopDomain: 'pro-bakery-bites.myshopify.com',
    callbackUri: fixture.callbackUri,
    idempotencyKey: 'order-webhook-reconcile-03030001',
    confirmationHash: sha(
      `RECONCILE 7 ORDER WEBHOOKS FOR ${fixture.accountGlobalId}`,
    ),
    actorEmail,
    ...overrides,
  }
  return {
    ...input,
    requestHash: overrides.requestHash || requestHash(input),
  }
}

async function exercise(pool) {
  const fixture = await seed(pool)
  const health = loadHealthModule()
  const healthyMigration = await pool.query(
    `SELECT (${health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL})
       AS applied`,
  )
  assert.equal(healthyMigration.rows[0].applied, true)
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `UPDATE public.schema_migrations
     SET checksum = repeat('0', 64)
     WHERE filename =
       '0316_operations_commerce_fulfillment_authority_leases.sql'`,
    'wrong 0316 migration checksum',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `ALTER TABLE public.operations_integration_accounts
       DISABLE TRIGGER protect_commerce_fulfillment_account_authority`,
    'disabled 0316 account-authority trigger',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `CREATE OR REPLACE FUNCTION
       public.operations_shopify_order_webhook_plan_is_valid(candidate jsonb)
     RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
     AS 'SELECT true'`,
    'weakened CREATE OR REPLACE function body',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `ALTER TABLE public.operations_shopify_order_webhook_commands
       DROP CONSTRAINT ops_shopify_order_webhook_command_profile_valid;
     ALTER TABLE public.operations_shopify_order_webhook_commands
       ADD CONSTRAINT ops_shopify_order_webhook_command_profile_valid
       CHECK (true)`,
    'same-named CHECK(true)',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `ALTER TABLE public.operations_shopify_order_webhook_attempts
       DISABLE TRIGGER protect_shopify_order_webhook_attempt_write`,
    'disabled provider-attempt trigger',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `DROP TRIGGER protect_shopify_order_webhook_command_write
       ON public.operations_shopify_order_webhook_commands;
     CREATE TRIGGER protect_shopify_order_webhook_command_write
       BEFORE INSERT OR UPDATE
       ON public.operations_shopify_order_webhook_commands
       FOR EACH ROW WHEN (false)
       EXECUTE FUNCTION public.protect_shopify_order_webhook_command()`,
    'WHEN(false) command trigger',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `CREATE FUNCTION public.tampered_shopify_order_webhook_command()
       RETURNS trigger LANGUAGE plpgsql
       AS 'BEGIN RETURN NEW; END';
     DROP TRIGGER protect_shopify_order_webhook_command_write
       ON public.operations_shopify_order_webhook_commands;
     CREATE TRIGGER protect_shopify_order_webhook_command_write
       BEFORE INSERT OR UPDATE
       ON public.operations_shopify_order_webhook_commands
       FOR EACH ROW EXECUTE FUNCTION
         public.tampered_shopify_order_webhook_command()`,
    'same-named trigger rebound to a different function OID',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `CREATE FUNCTION public.zzz_shopify_order_webhook_authority_tamper()
       RETURNS trigger LANGUAGE plpgsql
       AS $$ BEGIN
         NEW.authorized_by := 'member-order-webhooks@clawpilot.test';
         RETURN NEW;
       END $$;
     CREATE TRIGGER zzz_shopify_order_webhook_authority_tamper
       BEFORE INSERT ON public.operations_shopify_order_webhook_commands
       FOR EACH ROW EXECUTE FUNCTION
         public.zzz_shopify_order_webhook_authority_tamper()`,
    'unexpected authority trigger',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `DROP INDEX public.ops_shopify_order_webhook_one_open_idx;
     CREATE UNIQUE INDEX ops_shopify_order_webhook_one_open_idx
       ON public.operations_shopify_order_webhook_commands (
         organization_id, integration_account_id
       ) WHERE status = 'prepared'`,
    'one-open unique-index predicate drift',
  )
  await expectHealthTamper(
    pool,
    health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
    `CREATE SCHEMA health_lookalike;
     CREATE TABLE health_lookalike.operations_shopify_order_webhook_commands (
       id uuid PRIMARY KEY
     );
     ALTER TABLE public.operations_shopify_order_webhook_commands
       RENAME TO operations_shopify_order_webhook_commands_displaced;
     SET LOCAL search_path = health_lookalike, public`,
    'foreign-schema table lookalike',
  )
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/shopifyOrderWebhookReconciliation.ts',
    {
      '@/lib/integrations/shopifyOrderWebhook': {
        SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS: topics,
        SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS: includeFields,
        shopifyOrderWebhookReconciliationRequestHash: requestHash,
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

  const concurrentlyPrepared = await Promise.all([
    persistence.prepareShopifyOrderWebhookReconciliationInPostgres(
      prepareInput(fixture),
    ),
    persistence.prepareShopifyOrderWebhookReconciliationInPostgres(
      prepareInput(fixture),
    ),
  ])
  const prepared = concurrentlyPrepared[0]
  assert.equal(prepared.status, 'prepared')
  assert.equal(concurrentlyPrepared[1].commandId, prepared.commandId)
  assert.deepEqual(
    concurrentlyPrepared.map((state) => state.replayed).sort(),
    [false, true],
    'concurrent same-key preparation must create exactly one durable command',
  )
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         configuration, '{shopDomain}', '"drifted.myshopify.com"'::jsonb
       )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.accountId],
    ),
    /dispatch binding cannot drift/u,
    'prepared commands must fence account binding drift',
  )
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_integration_accounts
       SET global_id = 'gia0303099'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.accountId],
    ),
    /dispatch binding cannot drift/u,
    'prepared commands must fence the public account/callback identity',
  )
  await assert.rejects(
    () => pool.query(
      `DELETE FROM operations_commerce_credentials
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [fixture.organizationId, fixture.accountId],
    ),
    /credential cannot rotate/u,
    'prepared commands must fence credential deletion',
  )
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, prepared.commandId],
    ),
    /command transition is invalid/u,
    'same-status open-command evidence must be immutable',
  )
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
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET completed_at = completed_at + interval '1 second',
           error_code = 'SHOPIFY_ORDER_WEBHOOK_AUDIT_TAMPER'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, prepared.commandId],
    ),
    /command transition is invalid/u,
    'same-status terminal timestamps and errors must be immutable',
  )
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
  assert.equal(configuration.rows[0].reconciliation.status, 'succeeded')
  assert.equal(
    configuration.rows[0].reconciliation.idempotencyKeyHash,
    sha(prepareInput(fixture).idempotencyKey),
    'terminal readiness must bind the exact durable command key hash',
  )
  assert.equal(
    configuration.rows[0].reconciliation.requestHash,
    prepared.requestHash,
    'terminal readiness must bind the exact durable request authority',
  )

  const recoverableInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030002',
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
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_commerce_credentials
       SET last_error_code = 'TEST_RECOVERABLE_CREDENTIAL_DRIFT'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [fixture.organizationId, fixture.accountId],
    ),
    /credential cannot rotate/u,
    'deterministic residual authority must fence credential drift',
  )
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
  await assert.rejects(
    () => pool.query(
      `UPDATE app_user_organization_memberships
       SET role = 'member', updated_by = $3
       WHERE organization_id = $1::uuid AND user_email = $2`,
      [fixture.organizationId, actorEmail, fixture.successorEmail],
    ),
    /command author cannot lose authority/u,
    'the browser-key holder cannot lose authority while recovery is open',
  )
  const successorRecoveredKey = await persistence
    .readOpenShopifyOrderWebhookRecoveryKeyInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      confirmationHash: recoverableInput.confirmationHash,
      actorEmail: fixture.successorEmail,
    })
  assert.equal(
    successorRecoveredKey,
    recoverableInput.idempotencyKey,
    'a current successor administrator must recover the exact open key read-only',
  )
  await expectCode(
    () => persistence.readOpenShopifyOrderWebhookRecoveryKeyInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      confirmationHash: recoverableInput.confirmationHash,
      actorEmail: fixture.memberEmail,
    }),
    'SHOPIFY_ORDER_WEBHOOK_ACCOUNT_FORBIDDEN',
    'members cannot read open reconciliation keys',
  )
  const successorInput = prepareInput(fixture, {
    idempotencyKey: recoverableInput.idempotencyKey,
    actorEmail: fixture.successorEmail,
  })
  const successorReplay = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(successorInput)
  assert.equal(successorReplay.commandId, recoverablePrepared.commandId)
  assert.equal(successorReplay.status, 'recoverable')
  const residualClaim = await persistence
    .claimShopifyOrderWebhookReconciliationInPostgres({
      organizationId: fixture.organizationId,
      commandId: recoverablePrepared.commandId,
      actorEmail: fixture.successorEmail,
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
    actorEmail: fixture.successorEmail,
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
  const successorAudit = await pool.query(
    `SELECT attempt.claimed_by, outcome.completed_by
     FROM operations_shopify_order_webhook_attempts attempt
     JOIN operations_shopify_order_webhook_outcomes outcome
       ON outcome.organization_id = attempt.organization_id
      AND outcome.provider_attempt_id = attempt.id
     WHERE attempt.organization_id = $1::uuid AND attempt.id = $2::uuid
       AND outcome.outcome_state = 'succeeded'`,
    [fixture.organizationId, residualClaim.attemptId],
  )
  assert.deepEqual(successorAudit.rows[0], {
    claimed_by: fixture.successorEmail,
    completed_by: fixture.successorEmail,
  })
  const uncertainInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030003',
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
  const ambiguousNotClosed = await persistence
    .failShopifyOrderWebhookPreDispatchInPostgres({
      organizationId: fixture.organizationId,
      commandId: uncertainPrepared.commandId,
      actorEmail,
      errorCode: 'SHOPIFY_ORDER_WEBHOOK_SCOPE_REQUIRED',
    })
  assert.equal(
    ambiguousNotClosed.status,
    'unknown',
    'a definitive read rejection must not erase an ambiguous write outcome',
  )
  const movedCallbackUri = (
    'https://moved.clawpilot.test/api/integrations/commerce/'
    + `shopify/webhooks/${fixture.accountGlobalId}`
  )
  const callbackDriftUnknown = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(prepareInput(fixture, {
      idempotencyKey: uncertainInput.idempotencyKey,
      callbackUri: movedCallbackUri,
    }))
  assert.equal(callbackDriftUnknown.status, 'unknown')
  assert.equal(
    callbackDriftUnknown.callbackUri,
    fixture.callbackUri,
    'an ambiguous prior command may only reconcile its original callback read-only',
  )
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
  await assert.rejects(
    () => pool.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET processing_at = now() - interval '3 minutes',
           processing_lease_expires_at = now() - interval '1 minute'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, expiredPrepared.commandId],
    ),
    /command transition is invalid/u,
    'same-status processing leases must be immutable',
  )
  const clockClient = await pool.connect()
  try {
    await clockClient.query('SET session_replication_role = replica')
    await clockClient.query(
      `UPDATE operations_shopify_order_webhook_commands
       SET processing_at = now() - interval '3 minutes',
           processing_lease_expires_at = now() - interval '1 minute'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, expiredPrepared.commandId],
    )
  } finally {
    await clockClient.query('SET session_replication_role = origin')
      .catch(() => {})
    clockClient.release()
  }
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
  const definitiveInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030006',
  })
  const definitivePrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(definitiveInput)
  const definitiveFailed = await persistence
    .failShopifyOrderWebhookPreDispatchInPostgres({
      organizationId: fixture.organizationId,
      commandId: definitivePrepared.commandId,
      actorEmail,
      errorCode: 'SHOPIFY_ORDER_WEBHOOK_SCOPE_REQUIRED',
    })
  assert.equal(definitiveFailed.status, 'failed')
  assert.equal(
    definitiveFailed.errorCode,
    'SHOPIFY_ORDER_WEBHOOK_SCOPE_REQUIRED',
    'the original definitive rejection must remain the durable terminal code',
  )
  const releasedKey = await persistence
    .readOpenShopifyOrderWebhookRecoveryKeyInPostgres({
      organizationId: fixture.organizationId,
      accountGlobalId: fixture.accountGlobalId,
      confirmationHash: definitiveInput.confirmationHash,
      actorEmail,
    })
  assert.equal(releasedKey, null, 'a definitive pre-dispatch failure must release the open key')
  await pool.query('BEGIN')
  try {
    await pool.query(
      `UPDATE operations_commerce_credentials
       SET credential_ciphertext = decode('02', 'hex'),
           credential_identifier_last_four = '0404',
           credential_version = 2,
           updated_by = $3,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid`,
      [fixture.organizationId, fixture.accountId, actorEmail],
    )
    await pool.query(
      `UPDATE operations_integration_accounts
       SET commerce_credential_generation = 2,
           updated_by = $3,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, fixture.accountId, actorEmail],
    )
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    throw error
  }
  const repairedInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030007',
    credentialGeneration: 2,
  })
  const repairedPrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(repairedInput)
  assert.equal(
    repairedPrepared.status,
    'prepared',
    'repair must permit a new explicitly authorized command',
  )
  await persistence.failShopifyOrderWebhookPreDispatchInPostgres({
    organizationId: fixture.organizationId,
    commandId: repairedPrepared.commandId,
    actorEmail,
    errorCode: 'SHOPIFY_ORDER_WEBHOOK_OPERATOR_REVIEW_REQUIRED',
  })
  const callbackPreparedInput = prepareInput(fixture, {
    idempotencyKey: 'order-webhook-reconcile-03030005',
    credentialGeneration: 2,
  })
  const callbackPrepared = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(callbackPreparedInput)
  assert.equal(callbackPrepared.status, 'prepared')
  const callbackClosed = await persistence
    .prepareShopifyOrderWebhookReconciliationInPostgres(prepareInput(fixture, {
      idempotencyKey: callbackPreparedInput.idempotencyKey,
      callbackUri: movedCallbackUri,
      credentialGeneration: 2,
    }))
  assert.equal(callbackClosed.status, 'failed')
  assert.equal(
    callbackClosed.errorCode,
    'SHOPIFY_ORDER_WEBHOOK_CALLBACK_DRIFT_RESTART_REQUIRED',
  )
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
      disposablePostgresImage,
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
        const files = migrations()
        const leaseMigration =
          '0316_operations_commerce_fulfillment_authority_leases.sql'
        const leaseIndex = files.indexOf(leaseMigration)
        assert.ok(leaseIndex > 0, `${leaseMigration} is missing`)
        for (const file of files.slice(0, leaseIndex)) {
          await applyMigration(client, file)
        }
        const health = loadHealthModule()
        assert.equal(
          await healthApplied(
            client,
            health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
          ),
          true,
          'The exact pre-0316 reconciliation phase must remain healthy',
        )
        await expectHealthTamper(
          pool,
          health.SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL,
          `CREATE OR REPLACE FUNCTION
             public.protect_shopify_order_webhook_credential_drift()
           RETURNS trigger LANGUAGE plpgsql
           AS 'BEGIN RETURN NEW; END'`,
          'weakened pre-0316 credential-drift function',
        )
        for (const file of files.slice(leaseIndex)) {
          await applyMigration(client, file)
        }
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
