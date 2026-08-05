#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const POLICY_MESSAGE = (
  'Mock proof orders are available only while Operations is in shadow mode'
)
const PREPARATION_MESSAGE = (
  'Fulfillment execution requires exact canonical lines, packages, allocations, '
  + 'and one succeeded selected whole-shipment rate attempt'
)
const ACTIVE_RATE_MESSAGE = (
  'Active warehouse planning requires production carrier-read evidence. '
  + 'Use Shadow for sandbox carrier estimates.'
)
const RATE_PROMISE_MESSAGE = (
  'No whole-shipment UPS or FedEx service meets the requested delivery timestamp'
)

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadHealthQueries() {
  const path = 'app_src/lib/persistence/operationsCommandReceiptHealth.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
  }, { filename: path })
  return {
    classificationCtes:
      module.exports.OPERATIONS_COMMAND_RECEIPT_CLASSIFICATION_CTES,
    healthQuery: module.exports.OPERATIONS_COMMAND_RECEIPT_HEALTH_QUERY,
  }
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => {})
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function createFixture(client) {
  await client.query(`
    CREATE TABLE workspace_organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      is_demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE operations_activation_scopes (
      organization_id uuid PRIMARY KEY,
      state text NOT NULL
    );
    CREATE TABLE crm_reference_registry (
      reference_code text PRIMARY KEY
    );
    CREATE TABLE operations_orders (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      global_id text NOT NULL UNIQUE
    );
    CREATE TABLE operations_command_receipts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      command_type text NOT NULL,
      idempotency_key text NOT NULL,
      request_hash text,
      actor_email text,
      correlation_id uuid NOT NULL DEFAULT
        '00000000-0000-4000-8000-000000000000'::uuid,
      attempts integer NOT NULL DEFAULT 1,
      status text NOT NULL,
      error_code text,
      error_message text,
      result_global_id text,
      result_payload jsonb,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `)
}

async function verifyTargetMigration(client) {
  const organizationId = randomUUID()
  const auditedOrganizationId = '60832306-9876-4384-98e8-e179b427c3c1'
  const authoritativeOrderGlobalId = 'gor7654321'
  const claimedOrderGlobalId = 'gor7654322'
  const malformedOrderGlobalId = 'gor7654323'
  const auditedOrderGlobalId = 'gor3gqctppbqk2c'
  await client.query(
    `INSERT INTO workspace_organizations (id, name, is_demo)
     VALUES
       ($1::uuid, 'Migration fixture', true),
       ($2::uuid, 'Audited development fixture', true)`,
    [organizationId, auditedOrganizationId],
  )
  await client.query(
    `INSERT INTO crm_reference_registry (reference_code)
     VALUES ($1), ($2), ($3), ($4)`,
    [
      authoritativeOrderGlobalId,
      claimedOrderGlobalId,
      malformedOrderGlobalId,
      auditedOrderGlobalId,
    ],
  )
  await client.query(
    `INSERT INTO operations_orders (
       id, organization_id, global_id
     ) VALUES
       ($1::uuid, $2::uuid, $3),
       ($4::uuid, $2::uuid, $5),
       ($6::uuid, $2::uuid, $7),
       ($8::uuid, $9::uuid, $10)`,
    [
      randomUUID(),
      organizationId,
      authoritativeOrderGlobalId,
      randomUUID(),
      claimedOrderGlobalId,
      randomUUID(),
      malformedOrderGlobalId,
      randomUUID(),
      auditedOrganizationId,
      auditedOrderGlobalId,
    ],
  )

  const insertLegacyReceipt = async (input) => {
    await client.query(
      `INSERT INTO operations_command_receipts (
         id, organization_id, command_type, idempotency_key,
         request_hash, actor_email, correlation_id, attempts,
         status, error_code, error_message,
         result_global_id, result_payload, started_at,
         created_at, completed_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4,
         $5, $6, $7::uuid, $8,
         $9, $10, $11,
         $12, $13::jsonb, $14::timestamptz,
         $15::timestamptz, $16::timestamptz, $17::timestamptz
       )`,
      [
        input.id,
        input.organizationId,
        input.commandType ?? 'plan_operations_order',
        input.idempotencyKey,
        input.requestHash,
        input.actorEmail ?? 'migration-fixture@example.com',
        input.correlationId ?? randomUUID(),
        input.attempts ?? 1,
        input.status,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.resultGlobalId ?? null,
        input.resultPayload === undefined
          ? null
          : JSON.stringify(input.resultPayload),
        input.startedAt ?? input.createdAt,
        input.createdAt,
        input.completedAt ?? null,
        input.updatedAt ?? input.completedAt ?? input.createdAt,
      ],
    )
  }

  const authoritativeSuccessId = randomUUID()
  const sameHashFailureId = randomUUID()
  const maliciousKeyFailureId = randomUUID()
  const malformedSuccessId = randomUUID()
  const auditedSuccessId = '6e70478c-cd3b-4df5-9694-928f42e50d40'
  const auditedFailureOneId = '684f5a84-0f47-4bca-ab2e-027f17ac4950'
  const auditedFailureTwoId = '2e7e43aa-7381-4de3-9294-f663ea5f880d'
  const auditedNearMissId = randomUUID()
  const authoritativeHash = 'a'.repeat(64)
  const unrelatedHash = 'b'.repeat(64)

  await insertLegacyReceipt({
    id: authoritativeSuccessId,
    organizationId,
    idempotencyKey: 'arbitrary-authoritative-success-key',
    requestHash: authoritativeHash,
    status: 'succeeded',
    resultGlobalId: authoritativeOrderGlobalId,
    resultPayload: planningResult(authoritativeOrderGlobalId, {
      fulfillmentPlanGlobalId: 'gfp7654321',
      cartonizationEvidenceGlobalId: 'gcte7654321',
    }),
    createdAt: '2026-08-01T01:00:00Z',
    completedAt: '2026-08-01T01:01:00Z',
  })
  await insertLegacyReceipt({
    id: sameHashFailureId,
    organizationId,
    idempotencyKey: 'arbitrary-same-hash-failure-key',
    requestHash: authoritativeHash,
    status: 'failed',
    errorCode: 'OPERATIONS_REQUEST_FAILED',
    errorMessage: 'Same immutable request failed before it later succeeded',
    createdAt: '2026-08-01T00:00:00Z',
    completedAt: '2026-08-01T00:01:00Z',
  })
  await insertLegacyReceipt({
    id: maliciousKeyFailureId,
    organizationId,
    idempotencyKey: (
      `operations-plan:${authoritativeOrderGlobalId}:`
      + '44444444-4444-4444-8444-444444444444'
    ),
    requestHash: unrelatedHash,
    status: 'failed',
    errorCode: 'OPERATIONS_REQUEST_FAILED',
    errorMessage: (
      `Caller key claims ${authoritativeOrderGlobalId}, `
      + `but the server request targeted ${claimedOrderGlobalId}`
    ),
    createdAt: '2026-08-01T00:10:00Z',
    completedAt: '2026-08-01T00:11:00Z',
  })
  await insertLegacyReceipt({
    id: malformedSuccessId,
    organizationId,
    idempotencyKey: 'malformed-success-payload-key',
    requestHash: 'c'.repeat(64),
    status: 'succeeded',
    resultGlobalId: malformedOrderGlobalId,
    resultPayload: planningResult(claimedOrderGlobalId),
    createdAt: '2026-08-01T02:00:00Z',
    completedAt: '2026-08-01T02:01:00Z',
  })

  await insertLegacyReceipt({
    id: auditedSuccessId,
    organizationId: auditedOrganizationId,
    idempotencyKey: (
      `operations-plan:${auditedOrderGlobalId}:`
      + '88fea5a6-0f35-4b2e-b41e-7658196a2424'
    ),
    requestHash: (
      'dc0be151be1c427af4aa7240f8f6646e1fee04156ff306b3706693b2daabdabc'
    ),
    actorEmail: 'jarrett@suburbiasandwichco.com',
    correlationId: '4463472c-ae48-44a8-b332-bb9a9f24e684',
    attempts: 1,
    status: 'succeeded',
    resultGlobalId: auditedOrderGlobalId,
    resultPayload: planningResult(auditedOrderGlobalId),
    startedAt: '2026-08-03T11:15:47.260995Z',
    createdAt: '2026-08-03T11:15:47.260995Z',
    completedAt: '2026-08-03T11:15:47.265098Z',
    updatedAt: '2026-08-03T11:15:47.265098Z',
  })
  await insertLegacyReceipt({
    id: auditedFailureOneId,
    organizationId: auditedOrganizationId,
    idempotencyKey: (
      `operations-plan:${auditedOrderGlobalId}:`
      + '1a117b53-34c6-4b52-bbb9-376af5edb2b2'
    ),
    requestHash: (
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274'
    ),
    actorEmail: 'jarrett@suburbiasandwichco.com',
    correlationId: '9efe8904-b38f-45de-8d3f-1ccc44fb1acb',
    attempts: 1,
    status: 'failed',
    errorCode: 'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
    errorMessage: ACTIVE_RATE_MESSAGE,
    startedAt: '2026-08-03T11:11:31.100605Z',
    createdAt: '2026-08-03T11:11:31.100605Z',
    completedAt: '2026-08-03T11:11:31.110882Z',
    updatedAt: '2026-08-03T11:11:31.110882Z',
  })
  await insertLegacyReceipt({
    id: auditedFailureTwoId,
    organizationId: auditedOrganizationId,
    idempotencyKey: (
      `operations-plan:${auditedOrderGlobalId}:`
      + '8bc80086-093b-4232-87cc-7e94f5f2754d'
    ),
    requestHash: (
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274'
    ),
    actorEmail: 'jarrett@suburbiasandwichco.com',
    correlationId: 'db5e1731-a210-4f79-a3ec-50feacf8790b',
    attempts: 1,
    status: 'failed',
    errorCode: 'OPERATIONS_CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
    errorMessage: RATE_PROMISE_MESSAGE,
    startedAt: '2026-08-03T11:13:13.178687Z',
    createdAt: '2026-08-03T11:13:13.178687Z',
    completedAt: '2026-08-03T11:13:13.209979Z',
    updatedAt: '2026-08-03T11:13:13.209979Z',
  })
  await insertLegacyReceipt({
    id: auditedNearMissId,
    organizationId: auditedOrganizationId,
    idempotencyKey: (
      `operations-plan:${auditedOrderGlobalId}:`
      + '55555555-5555-4555-8555-555555555555'
    ),
    requestHash: (
      'e422f911970377b598ea7e743efb95d1ca5b63bf0181e07183a0da08ffe28274'
    ),
    actorEmail: 'jarrett@suburbiasandwichco.com',
    status: 'failed',
    errorCode: 'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
    errorMessage: ACTIVE_RATE_MESSAGE,
    startedAt: '2026-08-03T11:11:31.100605Z',
    createdAt: '2026-08-03T11:11:31.100605Z',
    completedAt: '2026-08-03T11:11:31.110882Z',
    updatedAt: '2026-08-03T11:11:31.110882Z',
  })

  const migrationPath = (
    'db/migrations/0249_operations_command_receipt_targets.sql'
  )
  const migration = read(migrationPath)
  for (const fragment of [
    'ADD COLUMN IF NOT EXISTS target_global_id text',
    'operations_command_receipts_target_fkey',
    'authoritative_plan_receipt_targets',
    'count(DISTINCT authoritative.target_global_id) = 1',
    'Narrowly audited development receipt adjudication',
    'failed.actor_email = audited.actor_email',
    'authoritative.receipt_id = audited.successor_receipt_id',
    'idx_operations_command_receipts_target_health',
  ]) {
    assert.ok(
      migration.includes(fragment),
      `Receipt target migration is missing ${fragment}`,
    )
  }
  assert.doesNotMatch(
    migration,
    /substring\s*\(\s*receipt\.idempotency_key/iu,
    'Legacy target migration must not trust caller-controlled key text',
  )
  await client.query(migration)

  const targetsAfter0249 = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[
      authoritativeSuccessId,
      sameHashFailureId,
      maliciousKeyFailureId,
      malformedSuccessId,
      auditedSuccessId,
      auditedFailureOneId,
      auditedFailureTwoId,
      auditedNearMissId,
    ]],
  )
  assert.deepEqual(
    Object.fromEntries(targetsAfter0249.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [authoritativeSuccessId]: authoritativeOrderGlobalId,
      [sameHashFailureId]: authoritativeOrderGlobalId,
      [maliciousKeyFailureId]: null,
      [malformedSuccessId]: null,
      [auditedSuccessId]: auditedOrderGlobalId,
      [auditedFailureOneId]: null,
      [auditedFailureTwoId]: null,
      [auditedNearMissId]: null,
    },
    '0249 must fail closed when audited timestamps differ below milliseconds',
  )

  const exactAuditMigrationPath = (
    'db/migrations/0250_operations_command_receipt_exact_audit.sql'
  )
  const exactAuditMigration = read(exactAuditMigrationPath)
  for (const fragment of [
    'Follow-up to 0249',
    '2026-08-03T11:11:31.100605Z',
    '2026-08-03T11:13:13.209979Z',
    '2026-08-03T11:15:47.260995Z',
    "successor.result_payload =",
    'successor.idempotency_key =',
    'failed.correlation_id = audited.correlation_id',
    'failed.attempts = audited.attempts',
    'successor.correlation_id = audited.successor_correlation_id',
    'successor.attempts = audited.successor_attempts',
    'failed.updated_at = audited.updated_at',
  ]) {
    assert.ok(
      exactAuditMigration.includes(fragment),
      `Exact audit migration is missing ${fragment}`,
    )
  }
  assert.doesNotMatch(
    exactAuditMigration,
    /substring\s*\(\s*failed\.idempotency_key/iu,
    'Exact audit migration must not derive authority from key text',
  )
  await client.query(exactAuditMigration)

  const targets = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[
      authoritativeSuccessId,
      sameHashFailureId,
      maliciousKeyFailureId,
      malformedSuccessId,
      auditedSuccessId,
      auditedFailureOneId,
      auditedFailureTwoId,
      auditedNearMissId,
    ]],
  )
  assert.deepEqual(
    Object.fromEntries(targets.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [authoritativeSuccessId]: authoritativeOrderGlobalId,
      [sameHashFailureId]: authoritativeOrderGlobalId,
      [maliciousKeyFailureId]: null,
      [malformedSuccessId]: null,
      [auditedSuccessId]: auditedOrderGlobalId,
      [auditedFailureOneId]: auditedOrderGlobalId,
      [auditedFailureTwoId]: auditedOrderGlobalId,
      [auditedNearMissId]: null,
    },
    'Only the exact microsecond audited receipts may receive the target',
  )
  const schema = await client.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM pg_constraint
         WHERE conrelid = 'operations_command_receipts'::regclass
           AND conname = 'operations_command_receipts_target_fkey'
       ) AS has_target_fkey,
       to_regclass(
         'idx_operations_command_receipts_target_health'
       ) IS NOT NULL AS has_target_health_index`,
  )
  assert.deepEqual(schema.rows[0], {
    has_target_fkey: true,
    has_target_health_index: true,
  })

  await client.query(
    `UPDATE operations_command_receipts
     SET target_global_id = NULL,
         actor_email = 'tampered@example.com'
     WHERE id = $1::uuid`,
    [auditedFailureOneId],
  )
  await client.query(
    `UPDATE operations_command_receipts
     SET target_global_id = NULL,
         updated_at = updated_at + interval '1 microsecond'
     WHERE id = $1::uuid`,
    [auditedFailureTwoId],
  )
  await client.query(exactAuditMigration)
  const adjudicationMismatch = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[auditedFailureOneId, auditedFailureTwoId]],
  )
  assert.deepEqual(
    Object.fromEntries(adjudicationMismatch.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [auditedFailureOneId]: null,
      [auditedFailureTwoId]: null,
    },
    'Actor or one-microsecond mismatches must make the correction a no-op',
  )

  await client.query(
    `UPDATE operations_command_receipts
     SET actor_email = 'jarrett@suburbiasandwichco.com',
         correlation_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
     WHERE id = $1::uuid`,
    [auditedFailureOneId],
  )
  await client.query(
    `UPDATE operations_command_receipts
     SET updated_at = '2026-08-03T11:13:13.209979Z'::timestamptz,
         attempts = 2
     WHERE id = $1::uuid`,
    [auditedFailureTwoId],
  )
  await client.query(exactAuditMigration)
  const receiptIdentityMismatch = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[auditedFailureOneId, auditedFailureTwoId]],
  )
  assert.deepEqual(
    Object.fromEntries(receiptIdentityMismatch.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [auditedFailureOneId]: null,
      [auditedFailureTwoId]: null,
    },
    'Correlation or attempt mismatches must make the correction a no-op',
  )

  await client.query(
    `UPDATE operations_command_receipts
     SET correlation_id = '9efe8904-b38f-45de-8d3f-1ccc44fb1acb'::uuid
     WHERE id = $1::uuid`,
    [auditedFailureOneId],
  )
  await client.query(
    `UPDATE operations_command_receipts
     SET attempts = 1
     WHERE id = $1::uuid`,
    [auditedFailureTwoId],
  )
  await client.query(
    `UPDATE operations_command_receipts
     SET correlation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
     WHERE id = $1::uuid`,
    [auditedSuccessId],
  )
  await client.query(exactAuditMigration)
  const successorIdentityMismatch = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[auditedFailureOneId, auditedFailureTwoId]],
  )
  assert.deepEqual(
    Object.fromEntries(successorIdentityMismatch.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [auditedFailureOneId]: null,
      [auditedFailureTwoId]: null,
    },
    'A successor correlation mismatch must make the correction a no-op',
  )

  await client.query(
    `UPDATE operations_command_receipts
     SET correlation_id = '4463472c-ae48-44a8-b332-bb9a9f24e684'::uuid,
         attempts = 2
     WHERE id = $1::uuid`,
    [auditedSuccessId],
  )
  await client.query(exactAuditMigration)
  const successorAttemptMismatch = await client.query(
    `SELECT id::text, target_global_id
     FROM operations_command_receipts
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [[auditedFailureOneId, auditedFailureTwoId]],
  )
  assert.deepEqual(
    Object.fromEntries(successorAttemptMismatch.rows.map((row) => [
      row.id,
      row.target_global_id,
    ])),
    {
      [auditedFailureOneId]: null,
      [auditedFailureTwoId]: null,
    },
    'A successor attempt mismatch must make the correction a no-op',
  )
}

async function insertReceipt(client, input) {
  if (input.targetGlobalId) {
    await client.query(
      `INSERT INTO crm_reference_registry (reference_code)
       VALUES ($1)
       ON CONFLICT (reference_code) DO NOTHING`,
      [input.targetGlobalId],
    )
  }
  await client.query(
    `INSERT INTO operations_command_receipts (
       id, organization_id, command_type, idempotency_key, status,
       error_code, error_message, result_global_id, result_payload,
       completed_at, created_at, updated_at, target_global_id
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb,
       $10::timestamptz, $11::timestamptz, $12::timestamptz, $13
     )`,
    [
      randomUUID(),
      input.organizationId,
      input.commandType,
      input.idempotencyKey,
      input.status,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.resultGlobalId ?? null,
      input.resultPayload === undefined
        ? null
        : JSON.stringify(input.resultPayload),
      input.completedAt ?? null,
      input.createdAt,
      input.updatedAt ?? input.completedAt ?? input.createdAt,
      input.targetGlobalId ?? null,
    ],
  )
}

function failedPreparation(organizationId, orderGlobalId, overrides = {}) {
  return {
    organizationId,
    commandType: 'prepare_operations_shipment_execution',
    idempotencyKey:
      `operations-shadow-fulfillment-${orderGlobalId}-20260801-v1`,
    status: 'failed',
    errorCode: 'OPERATIONS_REQUEST_FAILED',
    errorMessage: PREPARATION_MESSAGE,
    createdAt: '2026-08-01T00:00:00Z',
    completedAt: '2026-08-01T00:10:00Z',
    ...overrides,
  }
}

function succeededPreparation(organizationId, orderGlobalId, executionGlobalId, overrides = {}) {
  return {
    organizationId,
    commandType: 'prepare_operations_shipment_execution',
    idempotencyKey: `operations-shadow-fulfillment:${orderGlobalId}:${randomUUID()}`,
    status: 'succeeded',
    resultGlobalId: executionGlobalId,
    resultPayload: {
      orderGlobalId,
      fulfillmentExecutionGlobalId: executionGlobalId,
    },
    createdAt: '2026-08-01T01:00:00Z',
    completedAt: '2026-08-01T01:01:00Z',
    ...overrides,
  }
}

function failedPlan(organizationId, orderGlobalId, idempotencyKey, overrides = {}) {
  return {
    organizationId,
    commandType: 'plan_operations_order',
    idempotencyKey,
    targetGlobalId: orderGlobalId,
    status: 'failed',
    errorCode: 'OPERATIONS_ACTIVE_RATE_EVIDENCE_REQUIRES_PRODUCTION',
    errorMessage: ACTIVE_RATE_MESSAGE,
    createdAt: '2026-08-03T11:11:31.100Z',
    completedAt: '2026-08-03T11:11:31.110Z',
    ...overrides,
  }
}

function planningResult(orderGlobalId, overrides = {}) {
  return {
    carrier: 'FedEx',
    currency: 'USD',
    replayed: false,
    rowVersion: 2,
    orderStatus: 'planned',
    serviceCode: 'fedex_ground',
    serviceName: 'FedEx Ground®',
    packageCount: 1,
    orderGlobalId,
    carrierCostMinor: 2032,
    checkoutVarianceMinor: null,
    fulfillmentPlanGlobalId: 'gfpji951ll2matg',
    checkoutShippingChargeMinor: null,
    cartonizationEvidenceGlobalId: 'gcteutldj608te53',
    ...overrides,
  }
}

function succeededPlan(organizationId, orderGlobalId, overrides = {}) {
  return {
    organizationId,
    commandType: 'plan_operations_order',
    idempotencyKey: `canonical-plan-success-${orderGlobalId}`,
    targetGlobalId: orderGlobalId,
    status: 'succeeded',
    resultGlobalId: orderGlobalId,
    resultPayload: planningResult(orderGlobalId),
    createdAt: '2026-08-03T11:15:47.260Z',
    completedAt: '2026-08-03T11:15:47.265Z',
    ...overrides,
  }
}

async function seedFixture(client) {
  const primary = randomUUID()
  const other = randomUUID()
  const demo = randomUUID()
  await client.query(
    `INSERT INTO workspace_organizations (id, name, is_demo)
     VALUES ($1, 'Primary', false), ($2, 'Other', false), ($3, 'Demo', true)`,
    [primary, other, demo],
  )
  await client.query(
    `INSERT INTO operations_activation_scopes (organization_id, state)
     VALUES ($1, 'active'), ($2, 'shadow')`,
    [primary, other],
  )

  await insertReceipt(client, {
    organizationId: primary,
    commandType: 'inventory_count',
    idempotencyKey: 'fresh-processing',
    status: 'processing',
    createdAt: new Date().toISOString(),
  })
  await insertReceipt(client, {
    organizationId: primary,
    commandType: 'inventory_count',
    idempotencyKey: 'stale-processing',
    status: 'processing',
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  })

  const exactPolicy = {
    organizationId: primary,
    commandType: 'prepare_mock_operations_order',
    idempotencyKey: 'mock-commerce:zebra-proof-20260801:planned',
    status: 'failed',
    errorCode: 'OPERATIONS_PROOF_REQUIRES_SHADOW',
    errorMessage: POLICY_MESSAGE,
    createdAt: '2026-08-01T00:00:00Z',
    completedAt: '2026-08-01T00:01:00Z',
  }
  await insertReceipt(client, exactPolicy)
  await insertReceipt(client, {
    ...exactPolicy,
    idempotencyKey: 'mock-commerce:message-near-miss:planned',
    errorMessage: `${POLICY_MESSAGE}.`,
  })
  await insertReceipt(client, {
    ...exactPolicy,
    idempotencyKey: 'mock-commerce:bad key:planned',
  })
  await insertReceipt(client, {
    ...exactPolicy,
    idempotencyKey: 'mock-commerce:unexpected-result:planned',
    resultPayload: { unexpected: true },
  })

  await insertReceipt(client, failedPreparation(primary, 'gor7386776'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor7386776',
    'gofe2702718',
  ))
  await insertReceipt(client, failedPreparation(primary, 'gor0a1b2c3d4e5f'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor0a1b2c3d4e5f',
    'gofe0f1e2d3c4b5a',
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor6666666', {
    idempotencyKey: 'operations-shadow-fulfillment-gor6666666-2026080x-v1',
  }))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor6666666',
    'gofe6666666',
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor2222222'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor2222222',
    'gofe2222222',
    {
      createdAt: '2026-07-31T23:00:00Z',
      completedAt: '2026-07-31T23:01:00Z',
    },
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor3333333'))
  await insertReceipt(client, succeededPreparation(
    other,
    'gor3333333',
    'gofe3333333',
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor4444444'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor4444445',
    'gofe4444444',
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor5555555'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor5555555',
    'gofe5555555',
    { commandType: 'prepare_other_shipment_execution' },
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor7777777'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor7777777',
    'gofe7777777',
    {
      resultPayload: {
        orderGlobalId: 'gor7777777',
        fulfillmentExecutionGlobalId: 'gofe7777778',
      },
    },
  ))

  await insertReceipt(client, failedPreparation(primary, 'gor8888888'))
  await insertReceipt(client, succeededPreparation(
    primary,
    'gor8888888',
    'gofe8888888',
    { resultPayload: 'gor8888888' },
  ))

  const liveOrderGlobalId = 'gor3gqctppbqk2c'
  await insertReceipt(client, failedPlan(
    primary,
    liveOrderGlobalId,
    (
      `operations-plan:${liveOrderGlobalId}:`
      + '11111111-1111-4111-8111-111111111111'
    ),
  ))
  await insertReceipt(client, failedPlan(
    primary,
    liveOrderGlobalId,
    (
      `operations-plan:${liveOrderGlobalId}:`
      + '22222222-2222-4222-8222-222222222222'
    ),
    {
      errorCode: 'OPERATIONS_CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
      errorMessage: RATE_PROMISE_MESSAGE,
      createdAt: '2026-08-03T11:13:13.178Z',
      completedAt: '2026-08-03T11:13:13.209Z',
    },
  ))
  await insertReceipt(client, succeededPlan(primary, liveOrderGlobalId))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000000',
    'custom-plan-failure-1000000',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000000', {
    resultPayload: planningResult('gor1000000', {
      fulfillmentPlanGlobalId: 'gfp1000000',
      cartonizationEvidenceGlobalId: 'gcte1000000',
    }),
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000001',
    'custom-plan-failure-1000001',
    { targetGlobalId: null },
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000001'))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000002',
    'custom-plan-failure-1000002',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000002', {
    createdAt: '2026-08-03T11:10:00Z',
    completedAt: '2026-08-03T11:10:01Z',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000003',
    'custom-plan-failure-1000003',
  ))
  await insertReceipt(client, succeededPlan(other, 'gor1000003'))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000004',
    'custom-plan-failure-1000004',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000005'))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000006',
    'custom-plan-failure-1000006',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000006', {
    commandType: 'release_operations_order',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000007',
    'custom-plan-failure-1000007',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000007', {
    resultGlobalId: 'gfp1000007',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000008',
    'custom-plan-failure-1000008',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000008', {
    resultPayload: 'gor1000008',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000009',
    'custom-plan-failure-1000009',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000009', {
    resultPayload: planningResult('gor1000009', {
      carrierCostMinor: '2032',
    }),
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000010',
    (
      'operations-plan:gor1000011:'
      + '40000000-0000-4000-8000-000000000000'
    ),
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000011'))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000012',
    'custom-plan-failure-1000012',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000012', {
    completedAt: '2026-08-03T11:11:31.110Z',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000013',
    'custom-plan-failure-1000013',
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000013', {
    createdAt: '2026-08-03T11:11:31.105Z',
    completedAt: '2026-08-03T11:15:47.265Z',
  }))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000014',
    'custom-plan-failure-1000014',
    {
      createdAt: '2026-08-03T11:11:31.100Z',
      completedAt: '2026-08-03T11:11:31.090Z',
    },
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000014'))

  await insertReceipt(client, failedPlan(
    primary,
    'gor1000015',
    'custom-plan-failure-1000015',
    { updatedAt: '2026-08-03T11:11:31.105Z' },
  ))
  await insertReceipt(client, succeededPlan(primary, 'gor1000015'))

  await insertReceipt(client, { ...exactPolicy, organizationId: demo })
  await insertReceipt(client, {
    organizationId: demo,
    commandType: 'inventory_count',
    idempotencyKey: 'demo-stale-processing',
    status: 'processing',
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  })
}

async function snapshotReceipts(client) {
  const result = await client.query(
    `SELECT row_to_json(receipt)::text AS snapshot
     FROM operations_command_receipts receipt
     ORDER BY receipt.id`,
  )
  return result.rows.map((row) => row.snapshot)
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    await createFixture(client)
    await verifyTargetMigration(client)
    await seedFixture(client)
    const before = await snapshotReceipts(client)
    const { classificationCtes, healthQuery } = loadHealthQueries()
    assert.match(healthQuery, /^\s*WITH\b/u)
    assert.ok(
      classificationCtes.includes('failed.target_global_id'),
      'Planning health must use the server-resolved receipt target',
    )
    assert.doesNotMatch(
      classificationCtes,
      /operations-plan:/u,
      'Planning health must not derive order authority from idempotency keys',
    )
    assert.doesNotMatch(
      healthQuery,
      /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/iu,
      'Receipt health classification must be read-only',
    )
    const classifications = await client.query(
      `${classificationCtes}
       SELECT idempotency_key, classification
       FROM classified_failures
       ORDER BY idempotency_key`,
    )
    assert.deepEqual(
      Object.fromEntries(classifications.rows.map((row) => [
        row.idempotency_key,
        row.classification,
      ])),
      {
        'mock-commerce:bad key:planned': 'actionable',
        'mock-commerce:message-near-miss:planned': 'actionable',
        'mock-commerce:unexpected-result:planned': 'actionable',
        'mock-commerce:zebra-proof-20260801:planned': 'policy_rejected',
        'operations-shadow-fulfillment-gor0a1b2c3d4e5f-20260801-v1':
          'superseded',
        'operations-shadow-fulfillment-gor2222222-20260801-v1':
          'actionable',
        'operations-shadow-fulfillment-gor3333333-20260801-v1':
          'actionable',
        'operations-shadow-fulfillment-gor4444444-20260801-v1':
          'actionable',
        'operations-shadow-fulfillment-gor5555555-20260801-v1':
          'actionable',
        'operations-shadow-fulfillment-gor6666666-2026080x-v1':
          'actionable',
        'operations-shadow-fulfillment-gor7386776-20260801-v1':
          'superseded',
        'operations-shadow-fulfillment-gor7777777-20260801-v1':
          'actionable',
        'operations-shadow-fulfillment-gor8888888-20260801-v1':
          'actionable',
        'custom-plan-failure-1000000': 'superseded',
        'custom-plan-failure-1000001': 'actionable',
        'custom-plan-failure-1000002': 'actionable',
        'custom-plan-failure-1000003': 'actionable',
        'custom-plan-failure-1000004': 'actionable',
        'custom-plan-failure-1000006': 'actionable',
        'custom-plan-failure-1000007': 'actionable',
        'custom-plan-failure-1000008': 'actionable',
        'custom-plan-failure-1000009': 'actionable',
        'custom-plan-failure-1000012': 'actionable',
        'custom-plan-failure-1000013': 'actionable',
        'custom-plan-failure-1000014': 'actionable',
        'custom-plan-failure-1000015': 'actionable',
        'operations-plan:gor1000011:40000000-0000-4000-8000-000000000000':
          'actionable',
        'operations-plan:gor3gqctppbqk2c:11111111-1111-4111-8111-111111111111':
          'superseded',
        'operations-plan:gor3gqctppbqk2c:22222222-2222-4222-8222-222222222222':
          'superseded',
      },
    )
    const result = await client.query(healthQuery)
    assert.equal(result.rowCount, 1)
    assert.deepEqual(result.rows[0], {
      processing: 2,
      failed: 29,
      stale_processing: 1,
      policy_rejected: 1,
      superseded: 5,
      actionable_failed: 23,
      active_organizations: 1,
      shadow_organizations: 1,
    })
    assert.deepEqual(
      await snapshotReceipts(client),
      before,
      'Receipt health classification must not mutate audit evidence',
    )

    const route = read('app_src/app/api/health/route.ts')
    for (const fragment of [
      'policyRejected',
      'superseded',
      'actionableFailed',
      "actionableFailed > 0",
      'Operations command receipts have stale processing commands.',
      'Operations command receipts have actionable failures available for review or retry.',
    ]) {
      assert.ok(route.includes(fragment), `Health route is missing ${fragment}`)
    }
    assert.ok(
      !route.includes('Operations command queue has'),
      'Receipt health must not describe the audit table as a queue',
    )
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-receipt-health-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_receipt_health',
      '-e', 'POSTGRES_DB=clawpilot_receipt_health',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_receipt_health@127.0.0.1:'
      + `${port}/clawpilot_receipt_health`
    )
    await waitForPostgres(databaseUrl)
    await verify(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log('Operations command receipt health acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
