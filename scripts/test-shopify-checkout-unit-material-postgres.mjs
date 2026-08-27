#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  applyMigration,
  command,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const targetMigration =
  '0331_operations_shopify_checkout_line_authority.sql'
const organizationId = '32900000-0000-4000-8000-000000000001'
const accountId = '32900000-0000-4000-8000-000000000010'
const warehouseId = '32900000-0000-4000-8000-000000000020'
const materialId = '32900000-0000-4000-8000-000000000030'
const stockId = '32900000-0000-4000-8000-000000000040'
const configId = '32900000-0000-4000-8000-000000000050'
const receiptId = '32900000-0000-4000-8000-000000000060'

async function seedFixture(client) {
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ('checkout-unit-material@example.test', 'owner', 'active')`,
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, created_by, updated_by
       ) VALUES (
         $1::uuid, 'Checkout unit-material fixture', 'root',
         'checkout-unit-material@example.test',
         'checkout-unit-material@example.test'
       )`,
      [organizationId],
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration,
         external_account_id, commerce_credential_generation
       ) VALUES (
         $1::uuid, 'giah00000000001', $2::uuid, 'shopify', 'commerce',
         'sandbox', 'Checkout unit-material Shopify', 'active',
         '{"accountName":"Checkout unit-material store"}'::jsonb,
         'checkout-unit-material.myshopify.com', 1
       )`,
      [accountId, organizationId],
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         $1::uuid, 'gwhh00000000001', $2::uuid,
         'UNIT-MATERIAL', 'Checkout unit-material warehouse',
         '{
           "line1":"1 Test Street",
           "city":"Hartford",
           "region":"CT",
           "postalCode":"06103",
           "countryCode":"US"
         }'::jsonb,
         'active'
       )`,
      [warehouseId, organizationId],
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
         $1::uuid, 'gmath00000000001', $2::uuid,
         'UNIT-BOX', 'Checkout unit box', 'carton',
         200, 150, 100, 100, 10000, 100, 'USD',
         'active', 'manual', 1,
         'inner', 'measured', 'disposable PostgreSQL fixture', now(),
         210, 160, 110, 'measured', NULL, now()
       )`,
      [materialId, organizationId],
    )
    await client.query(
      `INSERT INTO operations_packaging_material_stock (
         id, global_id, organization_id, packaging_material_id,
         warehouse_id, is_available, on_hand_quantity, row_version
       ) VALUES (
         $1::uuid, 'gmash00000000001', $2::uuid, $3::uuid,
         $4::uuid, true, 10, 1
       )`,
      [stockId, organizationId, materialId, warehouseId],
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
         $1::uuid, 'gscfh00000000001', $2::uuid, $3::uuid, $4::uuid,
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
           },
           "checkoutRateControl": {
             "version": "shopify-checkout-rate-control-v1",
             "audience": "restricted_customers",
             "rateSource": "sandbox"
           }
         }'::jsonb,
         900, 900, 86400, 'unit-material-checkout-v1', 1
       )`,
      [configId, organizationId, accountId, warehouseId],
    )
    await client.query(
      `INSERT INTO operations_shopify_carrier_service_config_materials (
         organization_id, config_id, selection_sequence,
         packaging_material_id, packaging_material_row_version
       ) VALUES ($1::uuid, $2::uuid, 1, $3::uuid, 1)`,
      [organizationId, configId, materialId],
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipts (
         id, global_id, organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, rate_source, policy_revision, policy_hash,
         warehouse_id, algorithm_version, request_fingerprint,
         destination_fingerprint, carrier_destination_fingerprint,
         line_quantity_fingerprint, request_evidence_hash,
         redacted_request_snapshot, currency, idempotency_key, status,
         lease_token, lease_expires_at, claimed_by, line_count,
         inventory_snapshot_hash, inventory_snapshot_at,
         reconciliation_window_seconds, reconciliation_deadline_at,
         created_at, updated_at
       ) VALUES (
         $1::uuid, 'gsqrh00000000001', $2::uuid, $3::uuid, $4::uuid,
         1, 1, 1, 'shadow', 'sandbox', 1, repeat('f', 64), $5::uuid,
         'unit-material-checkout-v1', repeat('1', 64), repeat('2', 64),
         repeat('3', 64), repeat('4', 64), repeat('5', 64), '{}'::jsonb,
         'USD', 'checkout-unit-material-postgres', 'processing',
         gen_random_uuid(), now() + interval '5 minutes',
         'test:checkout-unit-material', 8, repeat('6', 64), now(),
         86400, now() + interval '1 day', now(), now()
       )`,
      [receiptId, organizationId, accountId, configId, warehouseId],
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_lines (
         organization_id, receipt_id, line_key, provider_variant_id, sku,
         quantity, unit_weight_grams, requires_shipping, line_hash,
         line_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, 'line-1',
         'gid://shopify/ProductVariant/1', 'UNIT-1', 1, 200, true,
         repeat('7', 64),
         '{
           "snapshotVersion":"shopify-checkout-line-pack-evidence-v2",
           "cartonizationAuthority":"unit_material_selection",
           "productGid":"gid://shopify/Product/1",
           "variantGid":"gid://shopify/ProductVariant/1",
           "productGlobalId":"gph00000000001",
           "productMappingGlobalId":"gpmh00000000001",
           "channelSourceRevision":"fixture-1",
           "channelSourceHash":"8888888888888888888888888888888888888888888888888888888888888888",
           "packMappingGlobalId":null,
           "packMappingRowVersion":null,
           "packEvidenceHash":null,
           "packProfileVersionGlobalId":null,
           "packProfileVersionRowVersion":null,
           "packageLevel":"each",
           "baseEachQuantity":1,
           "shipsAsOwnPackage":false,
           "inventoryLevelGlobalIds":["giilh00000000001"],
           "quantity":1,
           "unitWeightGrams":200
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-2',
         'gid://shopify/ProductVariant/2', 'PACK-2', 1, 300, true,
         repeat('8', 64),
         '{
           "snapshotVersion":"shopify-checkout-line-pack-evidence-v2",
           "cartonizationAuthority":"product_pack",
           "productGid":"gid://shopify/Product/2",
           "variantGid":"gid://shopify/ProductVariant/2",
           "productGlobalId":"gph00000000002",
           "productMappingGlobalId":"gpmh00000000002",
           "channelSourceRevision":"fixture-2",
           "channelSourceHash":"9999999999999999999999999999999999999999999999999999999999999999",
           "packMappingGlobalId":"gcvmh00000000001",
           "packMappingRowVersion":1,
           "packEvidenceHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
           "packProfileVersionGlobalId":"gppvh00000000001",
           "packProfileVersionRowVersion":1,
           "packageLevel":"each",
           "baseEachQuantity":1,
           "shipsAsOwnPackage":false,
           "inventoryLevelGlobalIds":["giilh00000000002"],
           "quantity":1,
           "unitWeightGrams":300
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-3',
         'gid://shopify/ProductVariant/3', 'PACK-V1-3', 1, 400, true,
         repeat('9', 64),
         '{
           "snapshotVersion":"shopify-checkout-line-pack-evidence-v1",
           "productGid":"gid://shopify/Product/3",
           "variantGid":"gid://shopify/ProductVariant/3",
           "productGlobalId":"gph00000000003",
           "packMappingGlobalId":"gcvmh00000000002",
           "packMappingRowVersion":1,
           "packEvidenceHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
           "packProfileVersionGlobalId":"gppvh00000000002",
           "packProfileVersionRowVersion":1,
           "packageLevel":"each",
           "baseEachQuantity":1,
           "shipsAsOwnPackage":false,
           "inventoryLevelGlobalIds":["giilh00000000003"],
           "quantity":1,
           "unitWeightGrams":400
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-4',
         'gid://shopify/ProductVariant/4', 'UNKNOWN-4', 1, 500, true,
         repeat('a', 64),
         '{
           "snapshotVersion":"shopify-checkout-line-pack-evidence-v99",
           "cartonizationAuthority":"product_pack",
           "packMappingGlobalId":"gcvmh00000000004",
           "packProfileVersionGlobalId":"gppvh00000000004"
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-5',
         'gid://shopify/ProductVariant/5', 'LEGACY-PACK-5', 1, 600, true,
         repeat('b', 64),
         '{
           "productGid":"gid://shopify/Product/5",
           "variantGid":"gid://shopify/ProductVariant/5",
           "productGlobalId":"gph00000000005",
           "packMappingGlobalId":"gcvmh00000000005",
           "packProfileVersionGlobalId":"gppvh00000000005",
           "packProfileVersionRowVersion":1,
           "packageLevel":"each",
           "baseEachQuantity":1,
           "shipsAsOwnPackage":false,
           "inventoryLevelGlobalIds":["giilh00000000005"],
           "quantity":1,
           "unitWeightGrams":600
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-6',
         'gid://shopify/ProductVariant/6', 'MALFORMED-LEGACY-6', 1, 700, true,
         repeat('c', 64),
         '{
           "productGid":"gid://shopify/Product/6",
           "variantGid":"gid://shopify/ProductVariant/6",
           "packMappingGlobalId":"gcvmh00000000006",
           "quantity":1,
           "unitWeightGrams":700
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-7',
         'gid://shopify/ProductVariant/7', 'NULL-VERSION-7', 1, 800, true,
         repeat('d', 64),
         '{
           "snapshotVersion":null,
           "productGid":"gid://shopify/Product/7",
           "variantGid":"gid://shopify/ProductVariant/7",
           "packMappingGlobalId":"gcvmh00000000007",
           "packProfileVersionGlobalId":"gppvh00000000007",
           "quantity":1,
           "unitWeightGrams":800
         }'::jsonb
       ), (
         $1::uuid, $2::uuid, 'line-8',
         'gid://shopify/ProductVariant/8', 'LEGACY-PACK-8', 1, 900, true,
         repeat('e', 64),
         '{
           "productGid":"gid://shopify/Product/8",
           "variantGid":"gid://shopify/ProductVariant/8",
           "productGlobalId":"gph00000000008",
           "packMappingGlobalId":"gcvmh00000000008",
           "packProfileVersionGlobalId":"gppvh00000000008",
           "packProfileVersionRowVersion":1,
           "packageLevel":"each",
           "baseEachQuantity":1,
           "shipsAsOwnPackage":false,
           "inventoryLevelGlobalIds":["giilh00000000008"],
           "quantity":1,
           "unitWeightGrams":900
         }'::jsonb
       )`,
      [organizationId, receiptId],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

function packageInsertSql() {
  return `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
    organization_id, receipt_id, package_key, package_sequence,
    planning_method,
    packaging_material_id, packaging_material_row_version,
    packaging_material_stock_id, packaging_material_stock_row_version,
    packaging_material_stock_on_hand_quantity,
    rated_outer_length_mm, rated_outer_width_mm, rated_outer_height_mm,
    content_weight_grams, tare_weight_grams, gross_weight_grams,
    allocation_count, package_hash, package_snapshot
  ) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5,
    $6::uuid, $7, $8::uuid, $9, $10,
    210, 160, 110, 200, 100, 300,
    $11, repeat($12, 64), '{"acceptanceFixture":true}'::jsonb
  )`
}

async function insertPackage(client, input) {
  await client.query(packageInsertSql(), [
    organizationId,
    receiptId,
    input.packageKey,
    input.packageSequence,
    input.planningMethod,
    materialId,
    input.materialRowVersion ?? 1,
    stockId,
    1,
    10,
    input.allocationCount ?? 1,
    input.hashDigit,
  ])
}

async function seedLegacyAllocationBeforeMigration(client) {
  await insertPackage(client, {
    packageKey: 'legacy-package-0',
    packageSequence: 11,
    planningMethod: 'approved_recipe',
    hashDigit: '0',
  })
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
       organization_id, receipt_id, package_key, line_key,
       quantity, allocation_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'legacy-package-0', 'line-5',
       1, repeat('0', 64)
     )`,
    [organizationId, receiptId],
  )
}

async function expectRejected(
  client,
  label,
  execute,
  messagePattern,
  expectedCode = 'P0001',
) {
  const savepoint = `expected_${label.replaceAll('-', '_')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let caught = null
  try {
    await execute()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  assert.ok(caught, `${label} unexpectedly succeeded`)
  assert.equal(caught.code, expectedCode)
  assert.match(caught.message, messagePattern)
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    const schema = await client.query(
      `SELECT
         pg_get_constraintdef(
           (
             SELECT oid FROM pg_constraint
             WHERE conrelid =
               'operations_shopify_checkout_rate_receipt_packages'::regclass
               AND conname =
                 'op_shopify_rate_packages_planning_method_valid'
           )
         ) AS planning_method_constraint,
         pg_get_constraintdef(
           (
             SELECT oid FROM pg_constraint
             WHERE conrelid =
               'operations_shopify_checkout_rate_receipt_packages'::regclass
               AND conname =
                 'op_shopify_rate_packages_profile_version_valid'
           )
         ) AS package_shape_constraint,
         pg_get_functiondef(
           'protect_operations_shopify_checkout_rate_receipt_package()'::regprocedure
         ) AS package_guard`,
    )
    assert.match(
      schema.rows[0].planning_method_constraint,
      /unit_material_selection/,
    )
    assert.match(
      schema.rows[0].package_shape_constraint,
      /allocation_count = 1/,
    )
    assert.match(
      schema.rows[0].package_guard,
      /approved_recipe.*unit_material_selection/s,
    )
    assert.match(
      await client.query(
        `SELECT pg_get_functiondef(
           'validate_operations_shopify_checkout_unit_material_allocation()'::regprocedure
         ) AS value`,
      ).then((result) => result.rows[0].value),
      /package method conflicts with retained line authority/,
    )
    assert.equal(
      await client.query(
        `SELECT count(*)::int AS value
         FROM operations_shopify_checkout_rate_receipt_allocations
         WHERE organization_id = $1::uuid
           AND receipt_id = $2::uuid
           AND package_key = 'legacy-package-0'
           AND line_key = 'line-5'`,
        [organizationId, receiptId],
      ).then((result) => result.rows[0].value),
      1,
      'migration must accept retained pre-versioned product-pack evidence',
    )

    const parcel = await client.query(
      `SELECT operations_shopify_checkout_carrier_request_parcel_snapshot(
         'unit_material_selection', 1, 210, 160, 110, 300
       ) AS value`,
    )
    assert.equal(parcel.rows[0].value.description, 'ClawPilot carton 1')

    await client.query('BEGIN')
    await insertPackage(client, {
      packageKey: 'unit-package-1',
      packageSequence: 1,
      planningMethod: 'unit_material_selection',
      hashDigit: 'a',
    })
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
         organization_id, receipt_id, package_key, line_key,
         quantity, allocation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'unit-package-1', 'line-1',
         1, repeat('b', 64)
       )`,
      [organizationId, receiptId],
    )
    await expectRejected(
      client,
      'v1-product-pack-line-in-unit-package',
      async () => {
        await insertPackage(client, {
          packageKey: 'unit-package-8',
          packageSequence: 8,
          planningMethod: 'unit_material_selection',
          hashDigit: '9',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'unit-package-8', 'line-3',
             1, repeat('a', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /package method conflicts with retained line authority/,
    )
    await insertPackage(client, {
      packageKey: 'legacy-recipe-package-13',
      packageSequence: 13,
      planningMethod: 'approved_recipe',
      hashDigit: 'f',
    })
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
         organization_id, receipt_id, package_key, line_key,
         quantity, allocation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'legacy-recipe-package-13', 'line-8',
         1, repeat('f', 64)
       )`,
      [organizationId, receiptId],
    )
    await expectRejected(
      client,
      'legacy-product-pack-line-in-unit-package',
      async () => {
        await insertPackage(client, {
          packageKey: 'unit-package-14',
          packageSequence: 14,
          planningMethod: 'unit_material_selection',
          hashDigit: 'a',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'unit-package-14', 'line-8',
             1, repeat('a', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /package method conflicts with retained line authority/,
    )
    await expectRejected(
      client,
      'unknown-line-version',
      async () => {
        await insertPackage(client, {
          packageKey: 'recipe-package-9',
          packageSequence: 9,
          planningMethod: 'approved_recipe',
          hashDigit: 'b',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'recipe-package-9', 'line-4',
             1, repeat('c', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /lacks valid retained line authority/,
    )
    await expectRejected(
      client,
      'unversioned-line-without-product-pack-evidence',
      async () => {
        await insertPackage(client, {
          packageKey: 'recipe-package-10',
          packageSequence: 10,
          planningMethod: 'approved_recipe',
          hashDigit: 'd',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'recipe-package-10', 'line-6',
             1, repeat('d', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /lacks valid retained line authority/,
    )
    await expectRejected(
      client,
      'explicit-null-line-version',
      async () => {
        await insertPackage(client, {
          packageKey: 'recipe-package-12',
          packageSequence: 12,
          planningMethod: 'approved_recipe',
          hashDigit: 'e',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'recipe-package-12', 'line-7',
             1, repeat('e', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /lacks valid retained line authority/,
    )
    await expectRejected(
      client,
      'second-allocation',
      () => client.query(
        `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
           organization_id, receipt_id, package_key, line_key,
           quantity, allocation_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'unit-package-1', 'line-1',
           1, repeat('c', 64)
         )`,
        [organizationId, receiptId],
      ),
      /must allocate exactly one line unit/,
    )

    await insertPackage(client, {
      packageKey: 'unit-package-2',
      packageSequence: 2,
      planningMethod: 'unit_material_selection',
      hashDigit: 'd',
    })
    await expectRejected(
      client,
      'quantity-two',
      () => client.query(
        `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
           organization_id, receipt_id, package_key, line_key,
           quantity, allocation_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'unit-package-2', 'line-1',
           2, repeat('e', 64)
         )`,
        [organizationId, receiptId],
      ),
      /must allocate exactly one line unit/,
    )
    await expectRejected(
      client,
      'allocation-count-two',
      () => insertPackage(client, {
        packageKey: 'unit-package-3',
        packageSequence: 3,
        planningMethod: 'unit_material_selection',
        allocationCount: 2,
        hashDigit: 'f',
      }),
      /op_shopify_rate_packages_profile_version_valid/,
      '23514',
    )
    await expectRejected(
      client,
      'material-revision-drift',
      () => insertPackage(client, {
        packageKey: 'unit-package-4',
        packageSequence: 4,
        planningMethod: 'unit_material_selection',
        materialRowVersion: 2,
        hashDigit: '1',
      }),
      /must use an exact selected material revision/,
    )
    await insertPackage(client, {
      packageKey: 'recipe-package-5',
      packageSequence: 5,
      planningMethod: 'approved_recipe',
      hashDigit: '2',
    })
    await expectRejected(
      client,
      'unit-line-in-recipe-package',
      () => client.query(
        `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
           organization_id, receipt_id, package_key, line_key,
           quantity, allocation_hash
         ) VALUES (
           $1::uuid, $2::uuid, 'recipe-package-5', 'line-1',
           1, repeat('3', 64)
         )`,
        [organizationId, receiptId],
      ),
      /package method conflicts with retained line authority/,
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
         organization_id, receipt_id, package_key, line_key,
         quantity, allocation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'recipe-package-5', 'line-2',
         1, repeat('4', 64)
       )`,
      [organizationId, receiptId],
    )
    await expectRejected(
      client,
      'product-pack-line-in-unit-package',
      async () => {
        await insertPackage(client, {
          packageKey: 'unit-package-6',
          packageSequence: 6,
          planningMethod: 'unit_material_selection',
          hashDigit: '5',
        })
        await client.query(
          `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
             organization_id, receipt_id, package_key, line_key,
             quantity, allocation_hash
           ) VALUES (
             $1::uuid, $2::uuid, 'unit-package-6', 'line-2',
             1, repeat('6', 64)
           )`,
          [organizationId, receiptId],
        )
      },
      /package method conflicts with retained line authority/,
    )
    await insertPackage(client, {
      packageKey: 'recipe-package-7',
      packageSequence: 7,
      planningMethod: 'approved_recipe',
      hashDigit: '7',
    })
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
         organization_id, receipt_id, package_key, line_key,
         quantity, allocation_hash
       ) VALUES (
         $1::uuid, $2::uuid, 'recipe-package-7', 'line-3',
         1, repeat('8', 64)
       )`,
      [organizationId, receiptId],
    )
    const retained = await client.query(
      `SELECT planning_method, allocation_count
       FROM operations_shopify_checkout_rate_receipt_packages
       WHERE organization_id = $1::uuid AND receipt_id = $2::uuid
       ORDER BY package_sequence`,
      [organizationId, receiptId],
    )
    assert.deepEqual(retained.rows, [
      { planning_method: 'unit_material_selection', allocation_count: 1 },
      { planning_method: 'unit_material_selection', allocation_count: 1 },
      { planning_method: 'approved_recipe', allocation_count: 1 },
      { planning_method: 'approved_recipe', allocation_count: 1 },
      { planning_method: 'approved_recipe', allocation_count: 1 },
      { planning_method: 'approved_recipe', allocation_count: 1 },
    ])
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-checkout-unit-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=checkout_unit',
      '-e', 'POSTGRES_DB=checkout_unit',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:checkout_unit@127.0.0.1:${port}/checkout_unit`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrations()
      const migrationIndex = files.indexOf(targetMigration)
      assert.ok(migrationIndex > 0, `${targetMigration} is missing`)
      for (const file of files.slice(0, migrationIndex)) {
        await applyMigration(client, file)
      }
      await seedFixture(client)
      await seedLegacyAllocationBeforeMigration(client)
      await applyMigration(client, targetMigration)
    } finally {
      client.release()
      await pool.end()
    }
    await verify(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Shopify checkout unit-material PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
