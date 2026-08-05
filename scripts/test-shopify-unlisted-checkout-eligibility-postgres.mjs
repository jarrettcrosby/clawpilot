#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const migration = readFileSync(
  resolve(
    root,
    'db/migrations/0255_operations_shopify_unlisted_checkout_eligibility.sql',
  ),
  'utf8',
)
const startMarker =
  '-- BEGIN SHOPIFY CHECKOUT CHANNEL ELIGIBILITY FUNCTION'
const endMarker =
  '-- END SHOPIFY CHECKOUT CHANNEL ELIGIBILITY FUNCTION'

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function applyMigrations(client) {
  const files = readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
  assert.ok(
    files.includes(
      '0255_operations_shopify_unlisted_checkout_eligibility.sql',
    ),
    'Shopify UNLISTED checkout migration is missing',
  )
  for (const file of files) {
    await client.query('BEGIN')
    try {
      await client.query(read(`db/migrations/${file}`))
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed`, { cause: error })
    }
  }
}

function eligibilityFunctionSql() {
  const start = migration.indexOf(startMarker)
  const end = migration.indexOf(endMarker)
  assert.ok(start >= 0, 'eligibility function start marker is missing')
  assert.ok(end > start, 'eligibility function end marker is missing')
  const sql = migration.slice(start + startMarker.length, end).trim()
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION\s+operations_shopify_checkout_channel_is_eligible/u,
  )
  return sql
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
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function assertEligibilityTruthTable(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    await pool.query(eligibilityFunctionSql())
    const result = await pool.query(`
      WITH cases(
        case_name,
        provider,
        environment,
        provider_status_raw,
        normalized_status,
        provider_active,
        requires_shipping,
        weight_grams,
        expected
      ) AS (VALUES
        ('active sandbox', 'shopify', 'sandbox', 'ACTIVE', 'active', true, true, 170, true),
        ('unlisted sandbox', 'shopify', 'sandbox', 'UNLISTED', 'unlisted', false, true, 170, true),
        ('unlisted production', 'shopify', 'production', 'UNLISTED', 'unlisted', false, true, 170, false),
        ('unlisted mock', 'shopify', 'mock', 'UNLISTED', 'unlisted', false, true, 170, false),
        ('wrong provider', 'faire', 'sandbox', 'UNLISTED', 'unlisted', false, true, 170, false),
        ('unlisted marked active', 'shopify', 'sandbox', 'UNLISTED', 'unlisted', true, true, 170, false),
        ('unlisted raw mismatch', 'shopify', 'sandbox', 'ACTIVE', 'unlisted', false, true, 170, false),
        ('active raw mismatch', 'shopify', 'sandbox', 'UNLISTED', 'active', true, true, 170, false),
        ('draft', 'shopify', 'sandbox', 'DRAFT', 'draft', false, true, 170, false),
        ('archived', 'shopify', 'sandbox', 'ARCHIVED', 'archived', false, true, 170, false),
        ('unavailable', 'shopify', 'sandbox', 'UNAVAILABLE', 'unavailable', false, true, 170, false),
        ('unknown', 'shopify', 'sandbox', 'UNKNOWN', 'unknown', NULL, true, 170, false),
        ('not shipping', 'shopify', 'sandbox', 'UNLISTED', 'unlisted', false, false, 170, false),
        ('zero weight', 'shopify', 'sandbox', 'UNLISTED', 'unlisted', false, true, 0, false),
        ('missing weight', 'shopify', 'sandbox', 'UNLISTED', 'unlisted', false, true, NULL, false)
      )
      SELECT
        case_name,
        expected,
        operations_shopify_checkout_channel_is_eligible(
          provider,
          environment,
          provider_status_raw,
          normalized_status,
          provider_active,
          requires_shipping,
          weight_grams
        ) AS actual
      FROM cases
      ORDER BY case_name
    `)
    for (const row of result.rows) {
      assert.equal(row.actual, row.expected, row.case_name)
    }
    const metadata = await pool.query(`
      SELECT
        procedure.provolatile,
        procedure.proparallel,
        procedure.proconfig
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname =
          'operations_shopify_checkout_channel_is_eligible'
        AND pg_get_function_identity_arguments(procedure.oid) =
          'requested_provider text, requested_environment text, requested_provider_status_raw text, requested_normalized_status text, requested_provider_active boolean, requested_requires_shipping boolean, requested_weight_grams integer'
    `)
    assert.equal(metadata.rowCount, 1)
    assert.equal(metadata.rows[0].provolatile, 'i')
    assert.equal(metadata.rows[0].proparallel, 's')
    assert.ok(
      metadata.rows[0].proconfig?.includes('search_path=pg_catalog'),
      'eligibility function must pin pg_catalog search_path',
    )
  } finally {
    await pool.end()
  }
}

async function seedTriggerFixture(pool) {
  const organizationId = randomUUID()
  const pipelineId = randomUUID()
  const productId = randomUUID()
  const actorEmail = 'shopify-unlisted-postgres@episcs.com'
  const externalProductId = 'gid://shopify/Product/8334592737480'
  const externalVariantId = 'gid://shopify/ProductVariant/45154205597896'
  const externalInventoryItemId =
    'gid://shopify/InventoryItem/47231303729352'
  const sourceRevision = 'shopify-unlisted-trigger-v1'
  const sourceHash = sha(sourceRevision)

  await pool.query(
    `INSERT INTO app_users (email, role, status, activated_at)
     VALUES ($1, 'owner', 'active', clock_timestamp())`,
    [actorEmail],
  )
  await pool.query(
    `INSERT INTO workspace_organizations (
       id, name, created_by, updated_by
     ) VALUES (
       $1::uuid, 'Shopify UNLISTED checkout acceptance', $2, $2
     )`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `UPDATE app_users
     SET organization_id = $2::uuid,
         organization_name = 'Shopify UNLISTED checkout acceptance'
     WHERE email = $1`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by
     ) VALUES (
       $1, $2::uuid, 'owner', 'active', true, $1, $1
     )`,
    [actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES (
       $1::uuid, 'Shopify UNLISTED checkout pipeline',
       $2, true, $3::uuid
     )`,
    [pipelineId, actorEmail, organizationId],
  )
  await pool.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow',
       'Shopify UNLISTED checkout trigger acceptance', $3
     )`,
    [organizationId, pipelineId, actorEmail],
  )

  const shopifyAccount = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       'Shopify UNLISTED sandbox', 'active', $2::jsonb,
       'unlisted-test.myshopify.com', 1, $3, $3
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      JSON.stringify({
        accountName: 'UNLISTED Checkout Test Store',
        canonicalDomain: 'unlisted-test.myshopify.com',
      }),
      actorEmail,
    ],
  )
  const shopifyAccountId = shopifyAccount.rows[0].id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'unlisted-test.myshopify.com',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
       1, 'TEST', 'verified', clock_timestamp(), 'unverified', $3, $3
     )`,
    [organizationId, shopifyAccountId, actorEmail],
  )

  const warehouse = await pool.query(
    `INSERT INTO operations_warehouses (
       organization_id, code, name, timezone, address, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, 'UNLISTED-E2E', 'UNLISTED test warehouse',
       'America/New_York', $2::jsonb, 'active', $3, $3
     ) RETURNING id::text`,
    [
      organizationId,
      JSON.stringify({
        name: 'UNLISTED test warehouse',
        line1: '35 Saxony Drive',
        city: 'Trumbull',
        region: 'CT',
        postalCode: '06611',
        country: 'US',
      }),
      actorEmail,
    ],
  )
  const warehouseId = warehouse.rows[0].id
  const material = await pool.query(
    `INSERT INTO operations_packaging_materials (
       organization_id, code, name, material_type,
       inner_length_mm, inner_width_mm, inner_height_mm,
       tare_weight_grams, max_weight_grams, unit_cost_minor, currency,
       status, source, dimension_basis, dimension_evidence_type,
       dimension_evidence_reference, dimension_confirmed_at,
       dimension_confirmed_by, rated_outer_length_mm,
       rated_outer_width_mm, rated_outer_height_mm,
       rated_outer_dimension_evidence_type,
       rated_outer_dimension_evidence_reference,
       rated_outer_dimension_confirmed_at,
       rated_outer_dimension_confirmed_by, created_by, updated_by
     ) VALUES (
       $1::uuid, 'UNLISTED-BOX', 'UNLISTED test carton', 'carton',
       280, 230, 180, 90, 5000, 25, 'USD',
       'active', 'manual', 'inner', 'measured',
       'UNLISTED trigger test measurement', clock_timestamp(), $2,
       290, 240, 190, 'measured',
       'UNLISTED trigger test outside measurement', clock_timestamp(), $2,
       $2, $2
     ) RETURNING id::text, row_version::text`,
    [organizationId, actorEmail],
  )
  await pool.query(
    `INSERT INTO operations_packaging_material_stock (
       organization_id, packaging_material_id, warehouse_id,
       is_available, on_hand_quantity, reorder_point_quantity,
       reorder_to_quantity, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, true, 10, 1, 10, $4, $4
     )`,
    [organizationId, material.rows[0].id, warehouseId, actorEmail],
  )

  const carrierAccounts = {}
  for (const [provider, lastFour] of [
    ['ups_rest', '1001'],
    ['fedex_rest', '2002'],
  ]) {
    const integration = await pool.query(
      `INSERT INTO operations_integration_accounts (
         organization_id, provider, integration_type, environment,
         display_name, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'carrier', 'sandbox', $3, 'active', $4, $4
       ) RETURNING id::text`,
      [
        organizationId,
        provider,
        `${provider} UNLISTED checkout test`,
        actorEmail,
      ],
    )
    const integrationAccountId = integration.rows[0].id
    await pool.query(
      `INSERT INTO operations_carrier_credentials (
         organization_id, integration_account_id,
         credential_ciphertext, credential_iv, credential_tag,
         credential_version, client_id_last_four,
         account_number_last_four, verification_status, verified_at,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, decode('01', 'hex'),
         decode(repeat('00', 12), 'hex'), decode(repeat('00', 16), 'hex'),
         1, 'TEST', $3, 'verified', clock_timestamp(), $4, $4
       )`,
      [organizationId, integrationAccountId, lastFour, actorEmail],
    )
    const carrierAccount = await pool.query(
      `INSERT INTO operations_carrier_accounts (
         organization_id, integration_account_id, display_name, sender_name,
         account_number_ciphertext, account_number_iv,
         account_number_tag, account_number_last_four,
         account_number_fingerprint, registered_address,
         registered_address_fingerprint, address_verification,
         status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $3, $4, $5, $6, $7, $8,
         $9::jsonb, $10, 'operator_attested', 'active', $11, $11
       ) RETURNING id::text`,
      [
        organizationId,
        integrationAccountId,
        `${provider} UNLISTED carrier account`,
        `${provider}-ciphertext`,
        `${provider}-iv`,
        `${provider}-tag`,
        lastFour,
        sha(`${provider}-account`),
        JSON.stringify({
          line1: '35 Saxony Drive',
          city: 'Trumbull',
          region: 'CT',
          postalCode: '06611',
          countryCode: 'US',
        }),
        sha(`${provider}-registered-address`),
        actorEmail,
      ],
    )
    carrierAccounts[provider] = {
      integrationAccountId,
      carrierAccountId: carrierAccount.rows[0].id,
    }
  }

  const policySnapshot = {
    version: 'shopify-checkout-rating-policy-v1',
    planRateOptimization: {
      version: 'shopify-checkout-plan-rate-objective-v2',
      maxCandidates: 4,
      objectivePriority: [
        'landed_price',
        'package_count',
        'unused_cube',
      ],
      handlingCostMinorPerPackage: 0,
      handlingCostCurrency: 'USD',
    },
    checkoutRateWarm: {
      version: 'shopify-checkout-rate-warm-v1',
      enabled: false,
      mode: 'hosted_ajax',
      zoneScope: 'all_saved_rate_zones',
      concurrency: 2,
      debounceMs: 350,
      minIntervalMs: 1000,
      supportedCountries: ['US'],
      staleCartAbort: true,
    },
  }
  const config = await pool.query(
    `INSERT INTO operations_shopify_carrier_service_configs (
       organization_id, integration_account_id, warehouse_id,
       registration_state, credential_generation, activation_revision,
       callback_token_version, callback_token_hash, policy_revision,
       policy_hash, policy_snapshot, inventory_max_age_seconds,
       quote_ttl_seconds, order_reconciliation_window_seconds,
       algorithm_version, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'unconfigured', 1, 1,
       1, $4, 1, $5, $6::jsonb, 300, 120, 3600,
       'shopify-unlisted-trigger-v1', $7, $7
     ) RETURNING id::text`,
    [
      organizationId,
      shopifyAccountId,
      warehouseId,
      sha('shopify-unlisted-callback-token'),
      sha(JSON.stringify(policySnapshot)),
      JSON.stringify(policySnapshot),
      actorEmail,
    ],
  )
  const configId = config.rows[0].id
  await pool.query(
    `INSERT INTO operations_shopify_carrier_service_config_materials (
       organization_id, config_id, selection_sequence,
       packaging_material_id, packaging_material_row_version
     ) VALUES (
       $1::uuid, $2::uuid, 1, $3::uuid, $4::bigint
     )`,
    [
      organizationId,
      configId,
      material.rows[0].id,
      material.rows[0].row_version,
    ],
  )
  for (const provider of ['ups_rest', 'fedex_rest']) {
    await pool.query(
      `INSERT INTO operations_shopify_carrier_service_config_carriers (
         organization_id, config_id, carrier_provider,
         carrier_account_id
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid
       )`,
      [
        organizationId,
        configId,
        provider,
        carrierAccounts[provider].carrierAccountId,
      ],
    )
  }
  // A disposable fixture may install provider-confirmed state directly; the
  // mapping trigger and the canonical readiness function remain enabled.
  await pool.query(
    `ALTER TABLE operations_shopify_carrier_service_configs
       DISABLE TRIGGER USER`,
  )
  try {
    await pool.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = 'registered',
           service_gid =
             'gid://shopify/DeliveryCarrierService/123456789',
           registered_service_name = 'UNLISTED Checkout Test Store',
           row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid`,
      [organizationId, configId],
    )
  } finally {
    await pool.query(
      `ALTER TABLE operations_shopify_carrier_service_configs
         ENABLE TRIGGER USER`,
    )
  }
  const readiness = await pool.query(
    `SELECT operations_shopify_carrier_service_config_is_ready(
       $1::uuid, $2::uuid
     ) AS ready`,
    [organizationId, configId],
  )
  assert.equal(
    readiness.rows[0]?.ready,
    true,
    'fixture must use the real registered-ready CarrierService predicate',
  )

  await pool.query(
    `INSERT INTO crm_products (
       id, pipeline_id, source_key, name, sku, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify-unlisted-trigger-product',
       'Shopify UNLISTED Test Product', 'AG-Test-Test', $3, $4, $4
     )`,
    [productId, pipelineId, sha('shopify-unlisted-product'), actorEmail],
  )
  const productMapping = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       channel_sku, external_product_id, external_variant_id,
       external_inventory_item_id, mapping_method,
       mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AG-Test-Test',
       $5, $6, $7, 'exact_variant', $8, true, $9
     ) RETURNING id::text`,
    [
      organizationId,
      shopifyAccountId,
      pipelineId,
      productId,
      externalProductId,
      externalVariantId,
      externalInventoryItemId,
      sourceRevision,
      actorEmail,
    ],
  )
  const channelState = await pool.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id,
       external_inventory_item_id, product_id, product_mapping_id,
       provider_product_title, provider_variant_title, provider_sku,
       provider_status_raw, normalized_status, provider_active,
       requires_shipping, weight_grams, provider_updated_at, observed_at,
       source_revision, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5, $6,
       $7::uuid, $8::uuid, 'Test Product', 'Default Title',
       'AG-Test-Test', 'UNLISTED', 'unlisted', false,
       true, 170, clock_timestamp(), clock_timestamp(), $9, $10, $11, $11
     ) RETURNING id::text, pack_evidence_hash`,
    [
      organizationId,
      shopifyAccountId,
      pipelineId,
      externalProductId,
      externalVariantId,
      externalInventoryItemId,
      productId,
      productMapping.rows[0].id,
      sourceRevision,
      sourceHash,
      actorEmail,
    ],
  )
  const profile = await pool.query(
    `INSERT INTO operations_product_pack_profiles (
       organization_id, pipeline_id, product_id, profile_key,
       profile_name, package_level, is_default, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify-test-case',
       'Shopify test case', 'case', true, 'active', $4, $4
     ) RETURNING id::text`,
    [organizationId, pipelineId, productId, actorEmail],
  )
  const version = await pool.query(
    `INSERT INTO operations_product_pack_profile_versions (
       organization_id, pipeline_id, product_id, profile_id,
       version_number, lifecycle_state, base_each_quantity,
       unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
       gross_weight_grams, weight_basis, fit_model,
       ships_as_own_package, assembly_policy, evidence_type,
       evidence_reference, confirmed_at, confirmed_by, source,
       is_current, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       1, 'active', 2, 'case', 203, 152, 51, 'outer',
       170, 'customer_stated', 'rigid_3d', true, 'never',
       'customer_confirmed', 'Shopify UNLISTED checkout test case',
       clock_timestamp(), $5, 'manual', true, $5
     ) RETURNING id::text`,
    [organizationId, pipelineId, productId, profile.rows[0].id, actorEmail],
  )
  return {
    actorEmail,
    organizationId,
    pipelineId,
    productId,
    shopifyAccountId,
    carrierAccounts,
    externalProductId,
    externalVariantId,
    sourceRevision,
    sourceHash,
    channelStateId: channelState.rows[0].id,
    packEvidenceHash: channelState.rows[0].pack_evidence_hash,
    profileVersionId: version.rows[0].id,
  }
}

async function insertCheckoutMapping(client, fixture, overrides = {}) {
  const values = {
    providerLifecycleState: 'unlisted',
    packEvidenceHash: fixture.packEvidenceHash,
    ...overrides,
  }
  return client.query(
    `INSERT INTO operations_commerce_variant_pack_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       provider, external_product_id, external_variant_id,
       default_pack_profile_version_id, provider_lifecycle_state,
       projection_state, mapping_purpose, source_revision, source_hash,
       pack_evidence_hash, observed_at, is_current, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'shopify', $5, $6, $7::uuid, $8,
       'current', 'shopify_checkout', $9, $10, $11,
       clock_timestamp(), true, $12, $12
     ) RETURNING global_id, provider_lifecycle_state, projection_state`,
    [
      fixture.organizationId,
      fixture.shopifyAccountId,
      fixture.pipelineId,
      fixture.productId,
      fixture.externalProductId,
      fixture.externalVariantId,
      fixture.profileVersionId,
      values.providerLifecycleState,
      fixture.sourceRevision,
      fixture.sourceHash,
      values.packEvidenceHash,
      fixture.actorEmail,
    ],
  )
}

async function assertMappingRejected(
  pool,
  fixture,
  { mutate, overrides, message },
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (mutate) await mutate(client)
    await assert.rejects(
      insertCheckoutMapping(client, fixture, overrides),
      (error) => {
        assert.match(String(error.message || error), message)
        return true
      },
    )
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

async function assertMappingTriggerContract(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const fixture = await seedTriggerFixture(pool)
    await assertMappingRejected(pool, fixture, {
      mutate: (client) => client.query(
        `UPDATE operations_commerce_credentials
         SET verification_status = 'failed',
             verified_at = NULL,
             last_error_code = 'TEST_UNVERIFIED'
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid`,
        [fixture.organizationId, fixture.shopifyAccountId],
      ),
      message: /exact eligible sandbox shipping and pack evidence/u,
    })
    await assertMappingRejected(pool, fixture, {
      overrides: { packEvidenceHash: sha('stale-pack-evidence') },
      message: /match pack-relevant channel evidence/u,
    })
    await assertMappingRejected(pool, fixture, {
      overrides: { providerLifecycleState: 'active' },
      message: /match pack-relevant channel evidence/u,
    })
    await assertMappingRejected(pool, fixture, {
      mutate: (client) => client.query(
        `UPDATE operations_product_channel_states
         SET provider_status_raw = 'ACTIVE'
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [fixture.organizationId, fixture.channelStateId],
      ),
      message: /exact eligible sandbox shipping and pack evidence/u,
    })
    await assertMappingRejected(pool, fixture, {
      mutate: (client) => client.query(
        `UPDATE operations_integration_accounts
         SET status = 'disabled'
         WHERE organization_id = $1::uuid
           AND id = $2::uuid`,
        [
          fixture.organizationId,
          fixture.carrierAccounts.ups_rest.integrationAccountId,
        ],
      ),
      message: /registered ready CarrierService/u,
    })
    const accepted = await insertCheckoutMapping(pool, fixture)
    assert.equal(accepted.rowCount, 1)
    assert.deepEqual(
      {
        lifecycle: accepted.rows[0].provider_lifecycle_state,
        projection: accepted.rows[0].projection_state,
      },
      { lifecycle: 'unlisted', projection: 'current' },
      'the trigger must retain truthful UNLISTED lifecycle evidence',
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-shopify-unlisted-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=clawpilot_unlisted',
      '-e',
      'POSTGRES_DB=clawpilot_unlisted',
      '-p',
      '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:clawpilot_unlisted@127.0.0.1:${port}/clawpilot_unlisted`
    await waitForPostgres(databaseUrl)
    const migrationPool = new Pool({ connectionString: databaseUrl, max: 1 })
    const migrationClient = await migrationPool.connect()
    try {
      await applyMigrations(migrationClient)
    } finally {
      migrationClient.release()
      await migrationPool.end()
    }
    await assertEligibilityTruthTable(databaseUrl)
    await assertMappingTriggerContract(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Shopify UNLISTED checkout PostgreSQL eligibility checks passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
