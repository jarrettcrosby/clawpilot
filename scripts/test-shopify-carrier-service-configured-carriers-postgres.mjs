#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const migration = '0285_shopify_carrier_service_configured_carriers.sql'

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function seedFixture(client) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO operations_activation_scopes (
         organization_id, data_pipeline_id, state, revision
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000002'::uuid,
         'shadow', 1
       )`,
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES
       (
         '28500000-0000-4000-8000-000000000010'::uuid,
         'giah00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'shopify', 'commerce', 'sandbox', 'Carrier fixture Shopify',
         'active', '{"accountName":"Carrier fixture store"}'::jsonb,
         'carrier-fixture.myshopify.com', 1
       ),
       (
         '28500000-0000-4000-8000-000000000020'::uuid,
         'giah00000000002',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'ups_rest', 'carrier', 'sandbox', 'Carrier fixture UPS',
         'active', '{}'::jsonb, NULL, 0
       ),
       (
         '28500000-0000-4000-8000-000000000030'::uuid,
         'giah00000000003',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'fedex_rest', 'carrier', 'sandbox', 'Carrier fixture FedEx',
         'active', '{}'::jsonb, NULL, 0
       )`,
    )
    await client.query(
      `INSERT INTO operations_commerce_credentials (
         organization_id, integration_account_id, external_account_id,
         auth_mode, credential_ciphertext, credential_iv, credential_tag,
         credential_version, credential_identifier_last_four,
         verification_status, verified_at, webhook_verification_status
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         'carrier-fixture.myshopify.com', 'shopify_client_credentials',
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '0001', 'verified', now(),
         'unverified'
       )`,
    )
    await client.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id,
         credential_ciphertext, credential_iv, credential_tag,
         credential_version, client_id_last_four,
         account_number_last_four, verification_status, verified_at,
         credential_fingerprint, credential_kind,
         credential_identifier_last_four
       ) VALUES
       (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '0002', '0002',
         'verified', now(),
         operations_carrier_credential_fingerprint(
           1, decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
           decode(repeat('00', 16), 'hex')
         ), 'oauth_client_credentials', '0002'
       ),
       (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000030'::uuid,
         decode('02', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '0003', '0003',
         'verified', now(),
         operations_carrier_credential_fingerprint(
           1, decode('02', 'hex'), decode(repeat('00', 12), 'hex'),
           decode(repeat('00', 16), 'hex')
         ), 'oauth_client_credentials', '0003'
       )`,
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, status
       ) VALUES (
         '28500000-0000-4000-8000-000000000040'::uuid,
         'gwhh00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'CS-READY', 'Carrier readiness warehouse', 'active'
       )`,
    )
    await client.query(
      `INSERT INTO operations_packaging_materials (
         id, global_id, organization_id, code, name, material_type,
         inner_length_mm, inner_width_mm, inner_height_mm,
         tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
         status, source, row_version,
         dimension_basis, dimension_evidence_type,
         dimension_evidence_reference, dimension_confirmed_at,
         rated_outer_length_mm, rated_outer_width_mm, rated_outer_height_mm,
         rated_outer_dimension_evidence_type,
         rated_outer_dimension_evidence_reference,
         rated_outer_dimension_confirmed_at
       ) VALUES (
         '28500000-0000-4000-8000-000000000050'::uuid,
         'gmath00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'CS-BOX', 'Carrier readiness box', 'carton',
         200, 150, 100, 100, 10000, 100, 'USD', 'active', 'manual', 1,
         'inner', 'measured', 'disposable acceptance fixture', now(),
         210, 160, 110, 'measured', 'disposable acceptance fixture', now()
       )`,
    )
    await client.query(
      `INSERT INTO operations_packaging_material_stock (
         id, global_id, organization_id, packaging_material_id,
         warehouse_id, is_available, on_hand_quantity, row_version
       ) VALUES (
         '28500000-0000-4000-8000-000000000060'::uuid,
         'gmash00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000050'::uuid,
         '28500000-0000-4000-8000-000000000040'::uuid,
         true, 10, 1
       )`,
    )
    const registeredAddress = JSON.stringify({
      line1: '1 Test Street',
      city: 'Hartford',
      region: 'CT',
      postalCode: '06103',
      countryCode: 'US',
    })
    await client.query(
      `INSERT INTO operations_carrier_accounts (
         id, global_id, organization_id, integration_account_id,
         display_name, sender_name,
         account_number_ciphertext, account_number_iv,
         account_number_tag, account_number_last_four,
         account_number_fingerprint, registered_address,
         registered_address_fingerprint, status
       ) VALUES
       (
         '28500000-0000-4000-8000-000000000070'::uuid,
         'gach00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         'Carrier fixture UPS', 'Carrier fixture UPS',
         'ciphertext', 'iv', 'tag', '0002',
         repeat('a', 64), $1::jsonb, repeat('b', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000080'::uuid,
         'gach00000000002',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000030'::uuid,
         'Carrier fixture FedEx', 'Carrier fixture FedEx',
         'ciphertext', 'iv', 'tag', '0003',
         repeat('c', 64), $1::jsonb, repeat('d', 64), 'active'
       )`,
      [registeredAddress],
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_configs (
         id, global_id, organization_id, integration_account_id,
         warehouse_id, registration_state, credential_generation,
         activation_revision, callback_token_version, callback_token_hash,
         policy_revision, policy_hash, policy_snapshot,
         inventory_max_age_seconds, quote_ttl_seconds,
         order_reconciliation_window_seconds, algorithm_version, row_version
       ) VALUES (
         '28500000-0000-4000-8000-000000000090'::uuid,
         'gscfh00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         '28500000-0000-4000-8000-000000000040'::uuid,
         'shadow_simulated', 1, 1, 1, repeat('e', 64),
         1, repeat('f', 64),
         '{
           "planRateOptimization": {
             "version": "shopify-checkout-plan-rate-objective-v2",
             "maxCandidates": 4,
             "objectivePriority": [
               "landed_price", "package_count", "unused_cube"
             ],
             "handlingCostMinorPerPackage": 0,
             "handlingCostCurrency": "USD"
           },
           "checkoutRateWarm": {
             "version": "shopify-checkout-rate-warm-v1",
             "enabled": false,
             "mode": "hosted_ajax",
             "zoneScope": "all_saved_rate_zones",
             "concurrency": 2,
             "debounceMs": 350,
             "minIntervalMs": 1000,
             "supportedCountries": ["US"],
             "staleCartAbort": true
           }
         }'::jsonb,
         900, 900, 86400,
         'disposable-one-or-two-carriers-v1', 1
       )`,
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_config_materials (
         organization_id, config_id, selection_sequence,
         packaging_material_id, packaging_material_row_version
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         1, '28500000-0000-4000-8000-000000000050'::uuid, 1
       )`,
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_config_carriers (
         organization_id, config_id, carrier_provider, carrier_account_id
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000070'::uuid
       )`,
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function isReady(client) {
  const result = await client.query(
    `SELECT operations_shopify_carrier_service_config_is_ready(
       '28500000-0000-4000-8000-000000000001'::uuid,
       '28500000-0000-4000-8000-000000000090'::uuid
     ) AS ready`,
  )
  return result.rows[0]?.ready === true
}

async function main() {
  const docker = spawnSync('docker', ['info'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (docker.status !== 0) {
    console.log(
      'Shopify configured-carrier disposable PostgreSQL acceptance skipped: Docker is unavailable',
    )
    return
  }

  const container = `clawpilot-shopify-carriers-${process.pid}-${
    crypto.randomBytes(3).toString('hex')
  }`
  let pool = null
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_carriers',
      '-e', 'POSTGRES_DB=clawpilot_carriers',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const postgresPort = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(
      postgresPort > 0,
      `Unable to resolve disposable PostgreSQL port from ${portOutput}`,
    )
    const databaseUrl =
      `postgresql://postgres:clawpilot_carriers@127.0.0.1:${
        postgresPort
      }/clawpilot_carriers`
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2_000,
      max: 2,
    })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })

    const applied = await pool.query(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS applied',
      [migration],
    )
    assert.equal(applied.rows[0]?.applied, true, `${migration} was not applied`)

    const client = await pool.connect()
    try {
      await seedFixture(client)
      assert.equal(
        await isReady(client),
        true,
        'one verified UPS binding must be callback-ready',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'fedex_rest', '28500000-0000-4000-8000-000000000080'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'verified UPS and FedEx bindings must remain callback-ready',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = 'disabled'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'a stale selected carrier binding must fail callback readiness',
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = 'active'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query('SET session_replication_role = origin')

      await client.query(
        `UPDATE operations_carrier_credentials
         SET verification_status = 'failed', last_error_code = 'TEST_FAILED'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND integration_account_id =
             '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      assert.equal(
        await isReady(client),
        false,
        'every selected carrier must remain verified',
      )

      await client.query(
        `UPDATE operations_carrier_credentials
         SET verification_status = 'verified',
             verified_at = now(),
             last_error_code = NULL
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND integration_account_id =
             '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_provider = 'ups_rest'`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'one verified FedEx binding must be callback-ready',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'zero selected carriers must fail callback readiness',
      )
    } finally {
      await client.query('SET session_replication_role = origin')
        .catch(() => undefined)
      client.release()
    }
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    spawnSync('docker', ['rm', '-f', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
}

await main()
console.log('Shopify configured-carrier PostgreSQL acceptance passed.')
