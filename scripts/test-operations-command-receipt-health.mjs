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
    CREATE TABLE operations_command_receipts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      command_type text NOT NULL,
      idempotency_key text NOT NULL,
      status text NOT NULL,
      error_code text,
      error_message text,
      result_global_id text,
      result_payload jsonb,
      completed_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `)
}

async function insertReceipt(client, input) {
  await client.query(
    `INSERT INTO operations_command_receipts (
       id, organization_id, command_type, idempotency_key, status,
       error_code, error_message, result_global_id, result_payload,
       completed_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb,
       $10::timestamptz, $11::timestamptz, $12::timestamptz
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
    await seedFixture(client)
    const before = await snapshotReceipts(client)
    const { classificationCtes, healthQuery } = loadHealthQueries()
    assert.match(healthQuery, /^\s*WITH\b/u)
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
      },
    )
    const result = await client.query(healthQuery)
    assert.equal(result.rowCount, 1)
    assert.deepEqual(result.rows[0], {
      processing: 2,
      failed: 13,
      stale_processing: 1,
      policy_rejected: 1,
      superseded: 2,
      actionable_failed: 10,
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
