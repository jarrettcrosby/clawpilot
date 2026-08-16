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

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

function loadHealthModule(query) {
  const path = 'app_src/lib/persistence/shopifyWebhookReceiptHealth.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Date,
    Number,
    String,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === '@/lib/persistence/postgres') return { query }
      throw new Error(`Unexpected health module import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
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
    CREATE TABLE operations_integration_accounts (
      organization_id uuid NOT NULL,
      id uuid NOT NULL,
      global_id text NOT NULL,
      integration_type text NOT NULL,
      provider text NOT NULL,
      status text NOT NULL,
      receipt_intake_enabled boolean NOT NULL,
      external_account_id text NOT NULL,
      commerce_credential_generation integer NOT NULL,
      created_by text,
      updated_by text,
      PRIMARY KEY (organization_id, id)
    );
    CREATE TABLE operations_commerce_credentials (
      organization_id uuid NOT NULL,
      integration_account_id uuid NOT NULL,
      credential_version integer NOT NULL,
      external_account_id text NOT NULL,
      auth_mode text NOT NULL,
      verification_status text NOT NULL,
      webhook_verification_status text NOT NULL,
      created_by text,
      updated_by text,
      PRIMARY KEY (
        organization_id, integration_account_id, credential_version
      )
    );
    CREATE TABLE operations_activation_scopes (
      organization_id uuid PRIMARY KEY,
      state text NOT NULL
    );
    CREATE TABLE operations_commerce_store_sync_controls (
      organization_id uuid NOT NULL,
      integration_account_id uuid NOT NULL,
      desired_state text NOT NULL,
      explicit_choice boolean NOT NULL,
      PRIMARY KEY (organization_id, integration_account_id)
    );
    CREATE FUNCTION operations_commerce_store_sync_is_running(
      requested_organization_id uuid,
      requested_integration_account_id uuid
    ) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1
        FROM operations_integration_accounts account
        JOIN operations_commerce_store_sync_controls control
          ON control.organization_id = account.organization_id
         AND control.integration_account_id = account.id
        JOIN operations_activation_scopes activation
          ON activation.organization_id = account.organization_id
        WHERE account.organization_id = requested_organization_id
          AND account.id = requested_integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider IN ('shopify', 'faire')
          AND account.status = 'active'
          AND control.desired_state = 'running'
          AND activation.state NOT IN ('disabled', 'frozen')
      )
    $$;
    CREATE TABLE operations_commerce_webhook_receipts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      integration_account_id uuid NOT NULL,
      provider text NOT NULL,
      credential_version integer NOT NULL,
      topic text NOT NULL,
      state text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 12,
      received_at timestamptz NOT NULL,
      lease_expires_at timestamptz
    );
  `)
}

async function seedFixture(client) {
  const organizationId = '11111111-1111-4111-8111-111111111111'
  const otherOrganizationId = '33333333-3333-4333-8333-333333333333'
  const otherAccountId = '44444444-4444-4444-8444-444444444444'
  const faireAccountId = '55555555-5555-4555-8555-555555555555'
  const accountIds = [
    '22222222-2222-4222-8222-222222222221',
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222223',
    '22222222-2222-4222-8222-222222222224',
  ]
  await client.query(
    `INSERT INTO operations_activation_scopes (organization_id, state)
     VALUES ($1::uuid, 'read_only'), ($2::uuid, 'shadow')`,
    [organizationId, otherOrganizationId],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, id, global_id, integration_type, provider, status,
       receipt_intake_enabled, external_account_id,
       commerce_credential_generation,
       created_by, updated_by
     ) VALUES
       ($1::uuid, $2::uuid, 'gia1111111', 'commerce', 'shopify', 'active',
        true, 'gid://shopify/Shop/1', 2, 'owner@example.com', NULL),
       ($1::uuid, $3::uuid, 'gia1111112', 'commerce', 'shopify', 'active',
        false, 'gid://shopify/Shop/2', 1, 'owner@example.com', NULL),
       ($1::uuid, $4::uuid, 'gia1111113', 'commerce', 'shopify', 'active',
        true, 'gid://shopify/Shop/3', 1, 'owner@example.com', NULL),
       ($1::uuid, $5::uuid, 'gia1111114', 'commerce', 'shopify', 'disabled',
        false, 'gid://shopify/Shop/4', 4, 'owner@example.com', NULL),
       ($1::uuid, $6::uuid, 'gia1111115', 'commerce', 'faire', 'active',
        true, 'faire-brand-1', 1, 'owner@example.com', NULL),
       ($7::uuid, $8::uuid, 'gia2222221', 'commerce', 'shopify', 'active',
        true, 'gid://shopify/Shop/5', 1, 'other@example.com', NULL)`,
    [
      organizationId,
      ...accountIds,
      faireAccountId,
      otherOrganizationId,
      otherAccountId,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_store_sync_controls (
       organization_id, integration_account_id,
       desired_state, explicit_choice
     ) VALUES
       ($1::uuid, $2::uuid, 'running', true),
       ($1::uuid, $3::uuid, 'running', true),
       ($1::uuid, $4::uuid, 'paused', true),
       ($1::uuid, $5::uuid, 'running', true),
       ($1::uuid, $6::uuid, 'running', true),
       ($7::uuid, $8::uuid, 'running', true)`,
    [
      organizationId,
      ...accountIds,
      // Faire stays outside Shopify receipt health but still receives the
      // same fail-closed per-account control shape.
      faireAccountId,
      otherOrganizationId,
      otherAccountId,
    ],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, credential_version,
       external_account_id, auth_mode, verification_status,
       webhook_verification_status, created_by
     ) VALUES
       ($1::uuid, $2::uuid, 2, 'gid://shopify/Shop/1',
        'shopify_client_credentials', 'verified', 'verified',
        'owner@example.com'),
       ($1::uuid, $3::uuid, 1, 'gid://shopify/Shop/2',
        'shopify_client_credentials', 'verified', 'verified',
        'owner@example.com'),
       ($1::uuid, $4::uuid, 1, 'gid://shopify/Shop/3',
        'shopify_client_credentials', 'verified', 'verified',
        'owner@example.com'),
       ($5::uuid, $6::uuid, 1, 'gid://shopify/Shop/5',
        'shopify_client_credentials', 'verified', 'verified',
        'other@example.com')`,
    [
      organizationId,
      ...accountIds.slice(0, 3),
      otherOrganizationId,
      otherAccountId,
    ],
  )

  const insertReceipt = async (
    accountId,
    credentialVersion,
    topic,
    state,
    receivedAt,
    leaseExpiresAt = null,
  ) => client.query(
    `INSERT INTO operations_commerce_webhook_receipts (
       id, organization_id, integration_account_id, provider,
       credential_version, topic, state, received_at, lease_expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5, $6,
       clock_timestamp() + $7::interval,
       CASE WHEN $8::text IS NULL THEN NULL
            ELSE clock_timestamp() + $8::interval END
     )`,
    [
      randomUUID(),
      organizationId,
      accountId,
      credentialVersion,
      topic,
      state,
      receivedAt,
      leaseExpiresAt,
    ],
  )

  await insertReceipt(accountIds[0], 2, 'inventory_levels/update', 'held', '-1 day')
  await insertReceipt(accountIds[0], 2, 'products/delete', 'held', '-9 minutes')
  await insertReceipt(accountIds[0], 2, 'products/update', 'queued', '-8 minutes')
  await insertReceipt(accountIds[0], 2, 'products/update', 'queued', '-10 seconds')
  await insertReceipt(
    accountIds[0],
    2,
    'products/update',
    'processing',
    '-7 minutes',
    '-1 minute',
  )
  await insertReceipt(
    accountIds[0],
    2,
    'products/update',
    'processing',
    '-1 minute',
    '5 minutes',
  )
  await insertReceipt(accountIds[0], 2, 'products/update', 'failed', '-6 minutes')
  await insertReceipt(accountIds[0], 2, 'products/update', 'dead_letter', '-5 minutes')
  await insertReceipt(accountIds[0], 2, 'products/update', 'succeeded', '-4 minutes')
  await insertReceipt(accountIds[0], 1, 'products/update', 'dead_letter', '-2 days')
  await insertReceipt(accountIds[1], 1, 'products/delete', 'held', '-3 minutes')
  await insertReceipt(accountIds[2], 1, 'products/delete', 'held', '-2 minutes')
  await insertReceipt(accountIds[3], 4, 'products/update', 'queued', '-2 days')
  await insertReceipt(accountIds[3], 4, 'products/update', 'dead_letter', '-2 days')
  await client.query(
    `INSERT INTO operations_commerce_webhook_receipts (
       id, organization_id, integration_account_id, provider,
       credential_version, topic, state, received_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify', 1,
       'products/update', 'queued', clock_timestamp() - interval '10 minutes'
     )`,
    [randomUUID(), otherOrganizationId, otherAccountId],
  )

  return { organizationId, actionableAccountId: accountIds[0] }
}

async function snapshotReceipts(client) {
  return (
    await client.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(receipt) ORDER BY receipt.id), '[]')::text
         AS snapshot
       FROM operations_commerce_webhook_receipts receipt`,
    )
  ).rows[0].snapshot
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const client = await pool.connect()
  try {
    await createFixture(client)
    await client.query(read(
      'db/migrations/0253_operations_shopify_webhook_receipt_health.sql',
    ))
    const fixture = await seedFixture(client)
    const before = await snapshotReceipts(client)
    const health = loadHealthModule((sql, values) => client.query(sql, values))

    assert.match(
      health.SHOPIFY_WEBHOOK_RECEIPT_CLASSIFICATION_CTES,
      /receipt\.credential_version\s*=\s*account\.commerce_credential_generation/u,
      'Health must inspect only the current credential generation',
    )
    assert.match(
      health.SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_CLASSIFICATION_CTES,
      /account\.provider = 'shopify'[\s\S]*account\.organization_id = \$1::uuid[\s\S]*\), classified_receipts/u,
      'Account health must tenant-filter inside current_shopify_accounts',
    )
    assert.match(
      health.SHOPIFY_WEBHOOK_RECEIPT_CLASSIFICATION_CTES,
      /receipt\.state IN \('queued', 'processing', 'failed', 'dead_letter'\)[\s\S]*receipt\.state = 'held'[\s\S]*receipt\.topic = 'products\/delete'/u,
      'Health must exclude succeeded and ordinary held history before classification',
    )
    const healthIndex = await client.query(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname =
             'operations_commerce_webhook_receipts_health_idx'`,
    )
    assert.equal(healthIndex.rowCount, 1)
    assert.match(
      healthIndex.rows[0].indexdef,
      /organization_id, integration_account_id, credential_version, state, received_at/u,
      'Receipt health index must lead with the account and generation fence',
    )
    assert.match(
      healthIndex.rows[0].indexdef,
      /WHERE \(\(state = ANY \(ARRAY\['queued'::text, 'processing'::text, 'failed'::text, 'dead_letter'::text\]\)\) OR \(\(state = 'held'::text\) AND \(topic = 'products\/delete'::text\)\)\)/u,
      'Receipt health index must exclude non-actionable immutable history',
    )
    for (const query of [
      health.SHOPIFY_WEBHOOK_RECEIPT_HEALTH_QUERY,
      health.SHOPIFY_WEBHOOK_RECEIPT_ACCOUNT_HEALTH_QUERY,
    ]) {
      assert.doesNotMatch(
        query,
        /\b(?:INSERT\s+INTO|UPDATE\s+operations|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/iu,
        'Shopify receipt health must be read-only',
      )
    }

    const globalHealth = JSON.parse(JSON.stringify(
      await health.readShopifyWebhookReceiptHealthFromPostgres(),
    ))
    const oldestActionableAt = globalHealth.oldestActionableAt
    delete globalHealth.oldestActionableAt
    assert.deepEqual(
      globalHealth,
      {
        status: 'attention',
        accounts: 4,
        actionableAccounts: 2,
        actionable: 6,
        staleQueued: 2,
        staleProcessing: 1,
        failed: 1,
        deadLetter: 1,
        heldProductDeletes: 1,
      },
    )
    assert.match(oldestActionableAt, /^\d{4}-\d{2}-\d{2}T/u)
    const accountHealth = JSON.parse(JSON.stringify(
      await health.readShopifyWebhookReceiptAccountHealthFromPostgres(
        fixture.organizationId,
      ),
    ))
    assert.equal(accountHealth.length, 3)
    assert.deepEqual(
      accountHealth.map((row) => ({
        integrationAccountId: row.integrationAccountId,
        status: row.status,
        actionable: row.actionable,
      })),
      [
        {
          integrationAccountId: fixture.actionableAccountId,
          status: 'attention',
          actionable: 5,
        },
        {
          integrationAccountId:
            '22222222-2222-4222-8222-222222222222',
          status: 'ready',
          actionable: 0,
        },
        {
          integrationAccountId:
            '22222222-2222-4222-8222-222222222223',
          status: 'ready',
          actionable: 0,
        },
      ],
    )
    assert.deepEqual(
      await snapshotReceipts(client),
      before,
      'Health classification must not mutate webhook evidence',
    )

    const route = read('app_src/app/api/health/route.ts')
    for (const fragment of [
      'readShopifyWebhookReceiptHealthFromPostgres',
      'shopifyWebhookReceipts',
      'Current Shopify webhook receipts require operator attention.',
    ]) {
      assert.ok(route.includes(fragment), `Health route missing ${fragment}`)
    }
    const settings = read(
      'app_src/components/settings/CommerceIntegrationPanel.tsx',
    )
    for (const fragment of [
      'webhookReceiptHealth.actionable > 0',
      'Current Shopify webhook receipts need attention',
      'Ordinary held inventory/catalog history and prior generations remain',
    ]) {
      assert.ok(settings.includes(fragment), `Settings UI missing ${fragment}`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-shopify-receipt-health-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_shopify_receipt_health',
      '-e', 'POSTGRES_DB=clawpilot_shopify_receipt_health',
      '-p', '127.0.0.1::5432',
      'postgres:16-alpine',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:clawpilot_shopify_receipt_health@127.0.0.1:'
      + `${port}/clawpilot_shopify_receipt_health`
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
  console.log('Shopify webhook receipt health acceptance passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
