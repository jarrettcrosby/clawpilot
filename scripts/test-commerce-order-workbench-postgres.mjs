#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const root = process.cwd()
const actorEmail = 'commerce-order-workbench-postgres@clawpilot.com'
const commandType = 'operations.commerce_order_workbench.update_ship_to'

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

function ids(suffix) {
  return {
    organization: randomUUID(),
    pipeline: randomUUID(),
    integration: randomUUID(),
    run: randomUUID(),
    candidate: randomUUID(),
    customer: randomUUID(),
    product: randomUUID(),
    line: randomUUID(),
    packageProfile: randomUUID(),
    organizationReference: `ga${suffix}`,
    customerGlobalId: `ga1${suffix.slice(1)}`,
    productGlobalId: `gp1${suffix.slice(1)}`,
    lineGlobalId: `gcol1${suffix.slice(1)}`,
    packageProfileGlobalId: `gpp1${suffix.slice(1)}`,
    integrationGlobalId: `gia${suffix}`,
    runGlobalId: `gcir${suffix}`,
    candidateGlobalId: `gcoc${suffix}`,
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function expectWorkbenchError(action, code, status) {
  let observed = null
  try {
    await action()
  } catch (error) {
    observed = error
  }
  assert.ok(observed, `Expected ${code}`)
  assert.equal(observed.code, code)
  assert.equal(observed.status, status)
}

async function expectDatabaseError(action, pattern) {
  let observed = null
  try {
    await action()
  } catch (error) {
    observed = error
  }
  assert.ok(observed, `Expected database error ${pattern}`)
  assert.match(String(observed.message || observed), pattern)
}

async function waitForBlockedDatabaseLock(pool, label) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::integer AS waiting
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'`,
    )
    if (Number(result.rows[0]?.waiting || 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`${label} did not reach its expected database lock wait`)
}

async function providerFenceLocksAreAvailable(pool, fixture) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const externalOrderId =
      `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`
    const keys = [
      [
        'commerce-intake-order-identity-v1',
        fixture.organization,
        fixture.integration,
        externalOrderId,
      ].join(':'),
      `commerce-order-observation:${fixture.organization}`
        + `:${fixture.integration}:shopify:${externalOrderId}`,
    ]
    for (const key of keys) {
      const result = await client.query(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended($1::text, 0)
         ) AS acquired`,
        [key],
      )
      if (result.rows[0]?.acquired !== true) return false
    }
    return true
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function seedTenant(client, fixture, label) {
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES
       ($1, 'gcoc', $1, 'active', 'operations.commerce_order_candidate'),
       ($2, 'gcir', $2, 'active', 'operations.commerce_intake_run'),
       ($3, 'gia', $3, 'active', 'operations.integration_account')`,
    [
      fixture.candidateGlobalId,
      fixture.runGlobalId,
      fixture.integrationGlobalId,
    ],
  )
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code
     ) VALUES ($1::uuid, $2, 'member', $3)`,
    [fixture.organization, `${label} organization`, fixture.organizationReference],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1::uuid, $2, $3, true, $4::uuid)`,
    [fixture.pipeline, `${label} pipeline`, actorEmail, fixture.organization],
  )
  await client.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, reason, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'shadow', 'Workbench handoff acceptance', $3
     )`,
    [fixture.organization, fixture.pipeline, actorEmail],
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration,
       external_account_id, commerce_credential_generation,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, 'shopify', 'commerce', 'sandbox', $4,
       'active', jsonb_build_object('shopDomain', $5::text), $6, 1, $7, $7
     )`,
    [
      fixture.integration,
      fixture.integrationGlobalId,
      fixture.organization,
      `${label} Shopify`,
      `${label.toLowerCase().replaceAll(' ', '-')}.myshopify.com`,
      `gid://shopify/Shop/${fixture.integrationGlobalId.slice(-7)}`,
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
       'shopify', 'orders', 1, '2026-07',
       'commerce-order-workbench-postgres-v1', $6, $7, now(),
       'held', 1, 1, $8, $8, now() + interval '7 days'
     )`,
    [
      fixture.run,
      fixture.runGlobalId,
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      `workbench-run-${fixture.runGlobalId}`,
      'a'.repeat(64),
      actorEmail,
    ],
  )
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
       ship_to_snapshot_source, delivery_resolution_state, observed_at,
       source_revision, source_hash, provider_api_version, normalizer_version,
       workflow_state, blocking_codes, row_version, created_by, updated_by,
       expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, 'shopify', $7, $8,
       'OPEN', 'PAID', 'UNFULFILLED', 'NONE',
       'open', 'paid', 'unfulfilled', 'none',
       true, 'USD', 1000, 0, 0, 0, 0, 0, 1000, 'missing',
       'unresolved', 'missing', 'none', 'unresolved', now(),
       'workbench-source-v1', $9, '2026-07',
       'commerce-order-workbench-postgres-v1', 'held',
       ARRAY['ship_to_unavailable']::text[], 0, $10, $10,
       now() + interval '7 days'
     )`,
    [
      fixture.candidate,
      fixture.candidateGlobalId,
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      fixture.run,
      `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
      `#${fixture.candidateGlobalId.slice(-7)}`,
      fixture.candidateGlobalId.endsWith('1') ? 'b'.repeat(64) : 'c'.repeat(64),
      actorEmail,
    ],
  )
}

async function seedReadyFacts(client, fixture) {
  await client.query(
    `INSERT INTO crm_organizations (
       id, pipeline_id, source_key, name, source_payload, source_hash,
       identity_key, relationship_type, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, '{}'::jsonb, $5,
       $6, 'customer', $7, $7
     )`,
    [
      fixture.customer,
      fixture.pipeline,
      `workbench-ready-customer-${fixture.candidateGlobalId}`,
      'Workbench Ready Customer',
      '1'.repeat(64),
      `customer:workbench-ready:${fixture.candidateGlobalId}`,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO crm_products (
       id, pipeline_id, source_key, name, sku, price, currency,
       source_payload, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 10, 'USD',
       '{}'::jsonb, $6, $7, $7
     )`,
    [
      fixture.product,
      fixture.pipeline,
      `workbench-ready-product-${fixture.candidateGlobalId}`,
      'Workbench Ready Product',
      `WB-${fixture.candidateGlobalId.slice(-4)}`,
      '2'.repeat(64),
      actorEmail,
    ],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidates
     SET header_money_state = 'complete',
         header_money_gaps = '{}'::text[],
         customer_resolution_state = 'resolved',
         customer_id = $3::uuid,
         customer_match_method = 'external_id',
         delivery_resolution_state = 'policy',
         requested_delivery_at = now() + interval '7 days',
         delivery_policy_version = 'workbench-ready-test-v1',
         blocking_codes = ARRAY['ship_to_unavailable']::text[]
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organization, fixture.candidate, fixture.customer],
  )
  await client.query(
    `INSERT INTO operations_commerce_order_candidate_lines (
       organization_id, integration_account_id, pipeline_id, run_id,
       order_candidate_id, provider, external_line_id,
       product_title_snapshot, provider_status_raw, normalized_status,
       ordered_quantity, current_quantity, cancelled_quantity,
       fulfilled_quantity, unfulfilled_quantity, returned_quantity,
       unit_multiplier, physical_quantity, currency_code, unit_price_minor,
       subtotal_minor, discount_minor, brand_discount_minor, tax_minor,
       other_adjustment_minor, total_minor, price_resolution_state,
       resolved_currency_code, resolved_unit_price_minor,
       resolved_subtotal_minor, resolved_discount_minor,
       resolved_brand_discount_minor, resolved_tax_minor,
       resolved_other_adjustment_minor, resolved_total_minor,
       requires_shipping, mapping_state, product_id, packaging_state,
       packaging_source, weight_grams, length_mm, width_mm, height_mm,
       observed_at, source_revision, source_hash, provider_api_version,
       normalizer_version, workflow_state, blocking_codes,
       created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, 'shopify', $6,
       'Workbench Ready Product', 'OPEN', 'open',
       1, 1, 0, 0, 1, 0, 1, 1, 'USD', 1000,
       1000, 0, 0, 0, 0, 1000, 'provider',
       'USD', 1000, 1000, 0, 0, 0, 0, 1000,
       true, 'resolved', $7::uuid, 'resolved',
       'manual', 250, 200, 150, 100,
       now(), $8, $9, '2026-07',
       'commerce-order-workbench-postgres-v1', 'held', '{}'::text[],
       $10, $10, now() + interval '7 days'
     )`,
    [
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      fixture.run,
      fixture.candidate,
      `gid://shopify/LineItem/${fixture.candidateGlobalId.slice(-7)}`,
      fixture.product,
      `workbench-line-${fixture.candidateGlobalId}`,
      '3'.repeat(64),
      actorEmail,
    ],
  )
}

async function seedNonShippingReadyFacts(client, fixture) {
  await seedReadyFacts(client, fixture)
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES
       ($1, 'ga', $1, 'active', 'crm.organization'),
       ($2, 'gp', $2, 'active', 'crm.product')`,
    [fixture.customerGlobalId, fixture.productGlobalId],
  )
  await client.query(
    `UPDATE crm_organizations SET reference_code = $3
     WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
    [fixture.pipeline, fixture.customer, fixture.customerGlobalId],
  )
  await client.query(
    `UPDATE crm_products SET reference_code = $3
     WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
    [fixture.pipeline, fixture.product, fixture.productGlobalId],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidates
     SET requires_shipping = false,
         delivery_resolution_state = 'not_required',
         requested_delivery_at = NULL,
         delivery_policy_version = NULL,
         blocking_codes = '{}'::text[]
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidate_lines
     SET requires_shipping = false,
         packaging_state = 'not_required',
         packaging_source = 'none',
         weight_grams = NULL,
         length_mm = NULL,
         width_mm = NULL,
         height_mm = NULL,
         blocking_codes = '{}'::text[]
     WHERE organization_id = $1::uuid
       AND order_candidate_id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
}

async function seedUnitCartonizationReadyFacts(client, fixture) {
  await seedReadyFacts(client, fixture)
  await client.query(
    `UPDATE operations_commerce_order_candidates
     SET blocking_codes = array_append(
       blocking_codes, 'packaging_required'
     )
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidate_lines
     SET packaging_state = 'unresolved',
         packaging_source = 'none',
         weight_grams = NULL,
         length_mm = NULL,
         width_mm = NULL,
         height_mm = NULL,
         blocking_codes = ARRAY['packaging_required']::text[]
     WHERE organization_id = $1::uuid
       AND order_candidate_id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
}

async function seedNeedsInfoFacts(client, fixture) {
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES
       ($1, 'ga', $1, 'active', 'crm.organization'),
       ($2, 'gp', $2, 'active', 'crm.product'),
       ($3, 'gpp', $3, 'active', 'operations.product_package_profile'),
       ($4, 'gcol', $4, 'active',
        'operations.commerce_order_candidate_line')`,
    [
      fixture.customerGlobalId,
      fixture.productGlobalId,
      fixture.packageProfileGlobalId,
      fixture.lineGlobalId,
    ],
  )
  await client.query(
    `INSERT INTO crm_organizations (
       id, reference_code, pipeline_id, source_key, name, email,
       source_payload, source_hash, identity_key, relationship_type,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4, 'Pro Bakery Bites',
       'orders@probakery.example', '{}'::jsonb, $5, $6, 'customer', $7, $7
     )`,
    [
      fixture.customer,
      fixture.customerGlobalId,
      fixture.pipeline,
      `workbench-customer-${fixture.candidateGlobalId}`,
      '4'.repeat(64),
      `customer:workbench:${fixture.candidateGlobalId}`,
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO crm_products (
       id, reference_code, pipeline_id, source_key, name, sku, price,
       currency, source_payload, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4, 'Bakery Bites Variety Box',
       'BB-VARIETY', 12.50, 'USD', '{}'::jsonb, $5, $6, $6
     )`,
    [
      fixture.product,
      fixture.productGlobalId,
      fixture.pipeline,
      `workbench-product-${fixture.candidateGlobalId}`,
      '5'.repeat(64),
      actorEmail,
    ],
  )
  await client.query(
    `INSERT INTO operations_product_package_profiles (
       id, global_id, organization_id, pipeline_id, product_id,
       profile_key, profile_name, package_type, unit_of_measure,
       units_per_package, measurement_system, length_mm, width_mm,
       height_mm, weight_grams, is_default, active, source,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       'measured-each', 'Measured each', 'each', 'each', 1, 'imperial',
       254, 203, 152, 907, true, true, 'manual', $6, $6
     )`,
    [
      fixture.packageProfile,
      fixture.packageProfileGlobalId,
      fixture.organization,
      fixture.pipeline,
      fixture.product,
      actorEmail,
    ],
  )
  await client.query(
    `UPDATE operations_commerce_order_candidates
     SET header_money_state = 'complete',
         header_money_gaps = '{}'::text[],
         provider_requested_delivery_at =
           date_trunc('second', now() + interval '5 days')
           + interval '0.123456 seconds',
         blocking_codes = ARRAY[
           'customer_resolution_required',
           'ship_to_unavailable',
           'delivery_decision_required',
           'product_mapping_required',
           'line_price_required',
           'packaging_required'
         ]::text[]
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
  await client.query(
    `INSERT INTO operations_commerce_order_candidate_lines (
       id, global_id, organization_id, integration_account_id, pipeline_id,
       run_id, order_candidate_id, provider, external_line_id,
       external_product_id, external_variant_id, sku_snapshot,
       product_title_snapshot, provider_status_raw, normalized_status,
       ordered_quantity, current_quantity, cancelled_quantity,
       fulfilled_quantity, unfulfilled_quantity, returned_quantity,
       unit_multiplier, physical_quantity, currency_code, unit_price_minor,
       subtotal_minor, discount_minor, brand_discount_minor, tax_minor,
       other_adjustment_minor, total_minor, price_resolution_state,
       requires_shipping, mapping_state, packaging_state, packaging_source,
       observed_at, source_revision, source_hash, provider_api_version,
       normalizer_version, workflow_state, blocking_codes,
       created_by, updated_by, expires_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, $7::uuid, 'shopify', $8, $9, $10, 'PB-BOX-12',
       'Bakery Bites Provider Box', 'OPEN', 'open',
       2, 2, 0, 0, 2, 0, 1, 2, 'USD', 1250,
       2500, 0, 0, 0, 0, 2500, 'unresolved',
       true, 'unresolved', 'unresolved', 'none',
       now(), $11, $12, '2026-07',
       'commerce-order-workbench-postgres-v1', 'held', ARRAY[
         'product_mapping_required', 'line_price_required',
         'packaging_required'
       ]::text[], $13, $13, now() + interval '7 days'
     )`,
    [
      fixture.line,
      fixture.lineGlobalId,
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      fixture.run,
      fixture.candidate,
      `gid://shopify/LineItem/${fixture.lineGlobalId.slice(-7)}`,
      `gid://shopify/Product/${fixture.productGlobalId.slice(-7)}`,
      `gid://shopify/ProductVariant/${fixture.productGlobalId.slice(-7)}`,
      `workbench-line-${fixture.candidateGlobalId}`,
      '6'.repeat(64),
      actorEmail,
    ],
  )
}

async function seedCurrentMappedProductPack(client, fixture) {
  const externalProductId =
    `gid://shopify/Product/${fixture.productGlobalId.slice(-7)}`
  const externalVariantId =
    `gid://shopify/ProductVariant/${fixture.productGlobalId.slice(-7)}`
  const channelRevision =
    `workbench-mapped-pack-${fixture.candidateGlobalId}`
  const channelSourceHash = '7'.repeat(64)
  const packEvidenceHash = '8'.repeat(64)
  const productMapping = (await client.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id,
       product_id, channel_sku, external_product_id,
       external_variant_id, external_inventory_item_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PB-BOX-12', $5, $6,
       $7, 'exact_variant', $8, true, $9
     ) RETURNING id::text, global_id`,
    [
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      fixture.product,
      externalProductId,
      externalVariantId,
      `gid://shopify/InventoryItem/${fixture.productGlobalId.slice(-7)}`,
      channelRevision,
      actorEmail,
    ],
  )).rows[0]
  await client.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id,
       external_inventory_item_id, product_id, product_mapping_id,
       provider_product_title, provider_variant_title, provider_sku,
       provider_status_raw, normalized_status, provider_active,
       requires_shipping, weight_grams, observed_at, source_revision,
       source_hash, pack_evidence_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify', $4, $5, $6,
       $7::uuid, $8::uuid, 'Bakery Bites Provider Box', 'Default',
       'PB-BOX-12', 'ACTIVE', 'active', true, true, 907, now(),
       $9, $10, $11, $12, $12
     )`,
    [
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      externalProductId,
      externalVariantId,
      `gid://shopify/InventoryItem/${fixture.productGlobalId.slice(-7)}`,
      fixture.product,
      productMapping.id,
      channelRevision,
      channelSourceHash,
      packEvidenceHash,
      actorEmail,
    ],
  )
  const packProfile = (await client.query(
    `INSERT INTO operations_product_pack_profiles (
       organization_id, pipeline_id, product_id, profile_key,
       profile_name, package_level, is_default, status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'mapped-each',
       'Mapped sellable each', 'each', true, 'active', $4, $4
     ) RETURNING id::text, global_id`,
    [
      fixture.organization,
      fixture.pipeline,
      fixture.product,
      actorEmail,
    ],
  )).rows[0]
  const packVersion = (await client.query(
    `INSERT INTO operations_product_pack_profile_versions (
       organization_id, pipeline_id, product_id, profile_id,
       version_number, lifecycle_state, base_each_quantity,
       unit_of_measure, length_mm, width_mm, height_mm, dimension_basis,
       gross_weight_grams, weight_basis, fit_model, ships_as_own_package,
       assembly_policy, evidence_type, source, is_current,
       evidence_reference, confirmed_at, confirmed_by, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       1, 'active', 1, 'each', 254, 203, 152, 'outer',
       907, 'customer_stated', 'rigid_3d', false, 'never',
       'customer_confirmed', 'manual', true,
       'Workbench mapped Product pack evidence', now(), $5, $5
     ) RETURNING id::text, global_id, row_version::text`,
    [
      fixture.organization,
      fixture.pipeline,
      fixture.product,
      packProfile.id,
      actorEmail,
    ],
  )).rows[0]
  const packMapping = (await client.query(
    `INSERT INTO operations_commerce_variant_pack_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       provider, external_product_id, external_variant_id,
       default_pack_profile_version_id, provider_lifecycle_state,
       projection_state, mapping_purpose, source_revision, source_hash,
       pack_evidence_hash, observed_at, is_current, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'shopify', $5, $6, $7::uuid, 'active',
       'current', 'catalog', $8, $9, $10, now(), true, $11, $11
     ) RETURNING id::text, global_id, row_version::text`,
    [
      fixture.organization,
      fixture.integration,
      fixture.pipeline,
      fixture.product,
      externalProductId,
      externalVariantId,
      packVersion.id,
      channelRevision,
      channelSourceHash,
      packEvidenceHash,
      actorEmail,
    ],
  )).rows[0]
  Object.assign(fixture, {
    productMappingGlobalId: productMapping.global_id,
    modernPackProfileGlobalId: packProfile.global_id,
    packVersionGlobalId: packVersion.global_id,
    packMappingGlobalId: packMapping.global_id,
  })
}

async function seedUnitPackAssociationMigrationFixture(client, fixture) {
  await client.query('SET session_replication_role = replica')
  try {
    await seedTenant(client, fixture, 'Unit pack migration')
    await seedReadyFacts(client, fixture)
    await seedCurrentMappedProductPack(client, fixture)
    await client.query(
      `UPDATE operations_commerce_order_candidate_lines line
     SET packaging_state = 'unresolved',
         packaging_source = 'variant_pack_mapping',
         package_profile_id = NULL,
         commerce_variant_pack_mapping_id = pack_mapping.id,
         commerce_variant_pack_mapping_row_version = pack_mapping.row_version,
         pack_profile_version_id = pack_version.id,
         pack_profile_version_row_version = pack_version.row_version,
         pack_profile_package_level = 'each',
         pack_profile_base_each_quantity = 1,
         packaging_weight_source = NULL,
         weight_grams = NULL,
         length_mm = NULL,
         width_mm = NULL,
         height_mm = NULL,
         blocking_codes = ARRAY['packaging_required']::text[]
     FROM operations_commerce_variant_pack_mappings pack_mapping
     JOIN operations_product_pack_profile_versions pack_version
       ON pack_version.organization_id = pack_mapping.organization_id
      AND pack_version.id = pack_mapping.default_pack_profile_version_id
     WHERE line.organization_id = $1::uuid
       AND line.order_candidate_id = $2::uuid
       AND pack_mapping.organization_id = line.organization_id
       AND pack_mapping.global_id = $3
       AND pack_version.global_id = $4`,
      [
        fixture.organization,
        fixture.candidate,
        fixture.packMappingGlobalId,
        fixture.packVersionGlobalId,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function seedFixtures(
  pool,
  primary,
  other,
  ready,
  needsInfo,
  accept,
  refresh,
  nonShipping,
) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [actorEmail],
    )
    await seedTenant(client, primary, 'Primary workbench')
    await seedTenant(client, other, 'Other tenant')
    await seedTenant(client, ready, 'Ready workbench')
    await seedTenant(client, needsInfo, 'Needs info workbench')
    await seedTenant(client, accept, 'Accept workbench')
    await seedTenant(client, refresh, 'Refresh workbench')
    await seedTenant(client, nonShipping, 'Non shipping workbench')
    await seedReadyFacts(client, ready)
    await seedNeedsInfoFacts(client, needsInfo)
    await seedCurrentMappedProductPack(client, needsInfo)
    await seedUnitCartonizationReadyFacts(client, accept)
    await seedNeedsInfoFacts(client, refresh)
    await seedNonShippingReadyFacts(client, nonShipping)
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function seedTerminalProviderObservation(pool, fixture, key) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO operations_commerce_order_sync_policies (
         organization_id, integration_account_id,
         historical_observation_enabled, continuous_observation_enabled,
         continuous_transport, provider_event_processor_state, revision,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, false, true,
         'scheduled_poll', 'processor_pending', 1, $3, $3
       )`,
      [fixture.organization, fixture.integration, actorEmail],
    )
    const session = (await client.query(
      `INSERT INTO operations_commerce_order_backfill_sessions (
         organization_id, integration_account_id, provider, session_kind,
         credential_generation, policy_revision, coverage_basis, status,
         requested_from, requested_through, locked_at, locked_by,
         lock_token, lease_expires_at, idempotency_key, request_hash,
         query_hash, requested_by, reason
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify', 'continuous_poll', 1, 1,
         'shopify_updated_at_overlap', 'processing',
         now() - interval '1 day', now() + interval '2 seconds',
         now(), $3, gen_random_uuid(), now() + interval '5 minutes',
         $4, $5, $6, $7, $8
       ) RETURNING id::text`,
      [
        fixture.organization,
        fixture.integration,
        `workbench-provider-status-${key}`,
        `workbench-provider-status-${key}`,
        'f'.repeat(64),
        '0'.repeat(64),
        actorEmail,
        'Workbench current provider status read fixture',
      ],
    )).rows[0]
    await client.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id, backfill_session_id,
         provider, credential_generation, observation_kind,
         external_order_id, order_number, source_revision, source_hash,
         canonical_lifecycle_state, canonical_payment_state,
         canonical_fulfillment_state, canonical_return_state,
         provider_updated_at, observed_at, provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', 1, 'scheduled_poll',
         $4, $5, $6, $7,
         'closed', 'paid', 'fulfilled', 'none',
         now() + interval '1 second', now() + interval '1 second', 1
       )`,
      [
        fixture.organization,
        fixture.integration,
        session.id,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        `#${fixture.candidateGlobalId.slice(-7)}`,
        `workbench-provider-status-${key}`,
        'e'.repeat(64),
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => {})
    client.release()
  }
}

async function seedNewerTerminalProviderCandidate(pool, fixture) {
  const runId = randomUUID()
  const candidateId = randomUUID()
  const customerId = randomUUID()
  const runGlobalId = 'gcir0009715'
  const candidateGlobalId = 'gcoc0009715'
  const externalLineId = 'gid://shopify/LineItem/latest-terminal-0009715'
  const orderNumber = '#LATEST-TERMINAL-9715'
  const customerName = 'Zulu Terminal Customer'
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES
         ($1, 'gcir', $1, 'active', 'operations.commerce_intake_run'),
         ($2, 'gcoc', $2, 'active', 'operations.commerce_order_candidate')`,
      [runGlobalId, candidateGlobalId],
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
         'shopify', 'orders', 1, '2026-07',
         'commerce-order-workbench-postgres-v1', $6, $7,
         now() + interval '2 seconds', 'held', 1, 1, $8, $8,
         now() + interval '7 days'
       )`,
      [
        runId,
        runGlobalId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        `workbench-run-${runGlobalId}`,
        'd'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, name, source_payload, source_hash,
         identity_key, relationship_type, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, '{}'::jsonb, $5,
         $6, 'customer', $7, $7
       )`,
      [
        customerId,
        fixture.pipeline,
        'workbench-latest-terminal-customer',
        customerName,
        '5'.repeat(64),
        'customer:workbench-latest-terminal',
        actorEmail,
      ],
    )
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
         customer_resolution_state, customer_id, customer_match_method,
         ship_to_snapshot_state, ship_to_snapshot_source,
         delivery_resolution_state, observed_at, provider_updated_at,
         source_revision, source_hash, provider_api_version,
         normalizer_version, workflow_state, blocking_codes, row_version,
         created_by, updated_by, expires_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'shopify', $7, $8,
         'CLOSED', 'PAID', 'FULFILLED', 'NONE',
         'closed', 'paid', 'fulfilled', 'none',
         true, 'USD', 5000, 0, 0, 0, 0, 0, 5000, 'missing',
         'resolved', $9::uuid, 'external_id', 'missing', 'none',
         'not_supplied', now() - interval '1 hour',
         now() + interval '2 seconds', $10, $11, '2026-07',
         'commerce-order-workbench-postgres-v1', 'held',
         '{}'::text[], 0, $12, $12, now() + interval '7 days'
       )`,
      [
        candidateId,
        candidateGlobalId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        runId,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        orderNumber,
        customerId,
        'workbench-latest-terminal-source',
        '7'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_candidate_lines (
         organization_id, integration_account_id, pipeline_id, run_id,
         order_candidate_id, provider, external_line_id,
         product_title_snapshot, provider_status_raw, normalized_status,
         ordered_quantity, current_quantity, cancelled_quantity,
         fulfilled_quantity, unfulfilled_quantity, returned_quantity,
         unit_multiplier, physical_quantity, currency_code, unit_price_minor,
         subtotal_minor, discount_minor, brand_discount_minor, tax_minor,
         other_adjustment_minor, total_minor, price_resolution_state,
         resolved_currency_code, resolved_unit_price_minor,
         resolved_subtotal_minor, resolved_discount_minor,
         resolved_brand_discount_minor, resolved_tax_minor,
         resolved_other_adjustment_minor, resolved_total_minor,
         requires_shipping, mapping_state, product_id, packaging_state,
         packaging_source, weight_grams, length_mm, width_mm, height_mm,
         observed_at, source_revision, source_hash, provider_api_version,
         normalizer_version, workflow_state, blocking_codes,
         created_by, updated_by, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, 'shopify', $6,
         'Latest externally fulfilled item', 'FULFILLED', 'fulfilled',
         7, 5, 2, 4, 0, 1, 1, 5, 'USD', 1000,
         5000, 0, 0, 0, 0, 5000, 'provider',
         'USD', 1000, 5000, 0, 0, 0, 0, 5000,
         true, 'resolved', $7::uuid, 'resolved',
         'manual', 250, 200, 150, 100,
         now() + interval '2 seconds', $8, $9, '2026-07',
         'commerce-order-workbench-postgres-v1', 'held', '{}'::text[],
         $10, $10, now() + interval '7 days'
       )`,
      [
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        runId,
        candidateId,
        externalLineId,
        fixture.product,
        'workbench-latest-terminal-line',
        '8'.repeat(64),
        actorEmail,
      ],
    )
    return {
      candidateId,
      candidateGlobalId,
      externalLineId,
      orderNumber,
      customerName,
    }
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => {})
    client.release()
  }
}

async function seedExactTerminalProviderHistory(
  pool,
  fixture,
  terminalCandidate,
) {
  const leaseId = randomUUID()
  const exactOnlyExternalLineId =
    'gid://shopify/LineItem/exact-history-only-0009715'
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO operations_commerce_store_sync_controls (
         organization_id, integration_account_id, desired_state,
         explicit_choice, revision, reason, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, 'running', true, 1,
         'Exact terminal-order history regression fixture', $3, $3
       )
       ON CONFLICT (organization_id, integration_account_id) DO NOTHING`,
      [fixture.organization, fixture.integration, actorEmail],
    )
    await client.query(
      `INSERT INTO operations_commerce_store_sync_read_leases (
         id, organization_id, integration_account_id, authority_kind,
         read_kind, intent_fingerprint_sha256, control_revision,
         activation_revision, acquired_by, acquired_at, heartbeat_at,
         expires_at, captured_at
       ) SELECT
         $1::uuid, $2::uuid, $3::uuid, 'manual_read_only',
         'order_history', $4, 1, activation.revision, $5,
         clock_timestamp() - interval '1 second',
         clock_timestamp() - interval '1 second',
         clock_timestamp() + interval '60 seconds', clock_timestamp()
       FROM operations_activation_scopes activation
       WHERE activation.organization_id = $2::uuid`,
      [
        leaseId,
        fixture.organization,
        fixture.integration,
        '6'.repeat(64),
        actorEmail,
      ],
    )
    const observation = (await client.query(
      `INSERT INTO operations_commerce_order_observations (
         organization_id, integration_account_id,
         manual_provider_read_lease_id, provider, credential_generation,
         observation_kind, external_order_id, order_number,
         source_revision, source_hash, canonical_lifecycle_state,
         canonical_payment_state, canonical_fulfillment_state,
         canonical_return_state, provider_updated_at, observed_at,
         provider_read_count
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', 1,
         'manual_exact_read', $4, $5, $6, $7,
         'closed', 'paid', 'fulfilled', 'returned',
         now() + interval '4 seconds', now() + interval '4 seconds', 3
       ) RETURNING id::text, global_id, observed_at`,
      [
        fixture.organization,
        fixture.integration,
        leaseId,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        `#${fixture.candidateGlobalId.slice(-7)}`,
        'workbench-terminal-manual-exact-read-v1',
        '9'.repeat(64),
      ],
    )).rows[0]
    await client.query(
      `INSERT INTO operations_commerce_order_observation_lines (
         organization_id, observation_id, external_line_id,
         external_product_id, external_variant_id, sku,
         original_quantity, current_quantity, unfulfilled_quantity,
         fulfilled_quantity, returned_quantity, requires_shipping
       ) VALUES
         ($1::uuid, $2::uuid, $3,
          'gid://shopify/Product/exact-matched',
          'gid://shopify/ProductVariant/exact-matched', 'EXACT-MATCHED',
          9, 8, 0, 8, 3, true),
         ($1::uuid, $2::uuid, $4,
          'gid://shopify/Product/exact-only',
          'gid://shopify/ProductVariant/exact-only', 'EXACT-ONLY-SKU',
          2, 1, 0, 1, 1, true)`,
      [
        fixture.organization,
        observation.id,
        terminalCandidate.externalLineId,
        exactOnlyExternalLineId,
      ],
    )
    const trackingNumber = '1ZEXACTWORKBENCH0009715'
    const trackingEvent = (await client.query(
      `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id,
         external_subject_id, event_hash, event_kind, event_status,
         attribution_source, tracking_carrier, tracking_number,
         tracking_url, sensitive_evidence_expires_at,
         occurred_at, observed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'shopify', $4,
         'workbench-exact-tracking-0009715',
         'workbench-exact-shipment-0009715', $5,
         'tracking_updated', 'delivered', 'provider_system', 'UPS', $6,
         'https://www.ups.com/track?tracknum=1ZEXACTWORKBENCH0009715',
         $7::timestamptz + interval '30 days',
         $7::timestamptz + interval '1 day',
         $7::timestamptz + interval '1 day'
       )
       RETURNING occurred_at`,
      [
        fixture.organization,
        fixture.integration,
        observation.id,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        '4'.repeat(64),
        trackingNumber,
        observation.observed_at,
      ],
    )).rows[0]
    return {
      exactOnlyExternalLineId,
      observationGlobalId: observation.global_id,
      observedAt: observation.observed_at.toISOString(),
      trackingActivityAt: trackingEvent.occurred_at.toISOString(),
      trackingNumber,
    }
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => {})
    client.release()
  }
}

async function seedSearchBoundaryCandidates(pool, fixture) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
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
         ship_to_snapshot_source, delivery_resolution_state, observed_at,
         provider_updated_at, source_revision, source_hash,
         provider_api_version, normalizer_version, workflow_state,
         blocking_codes, row_version, created_by, updated_by, expires_at
       )
       SELECT
         gen_random_uuid(),
         'gcoc' || lpad((3000000 + ordinal)::text, 7, '0'),
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'shopify',
         'gid://shopify/Order/boundary-' || ordinal::text,
         CASE WHEN ordinal = 1
           THEN '#NeedleBeyondLimit'
           ELSE '#BOUNDARY-' || ordinal::text
         END,
         'OPEN', 'PAID', 'UNFULFILLED', 'NONE',
         'open', 'paid', 'unfulfilled', 'none',
         true, 'USD', 1000, 0, 0, 0, 0, 0, 1000, 'missing',
         'unresolved', 'missing', 'none', 'unresolved',
         now() + ordinal * interval '1 second',
         now() + ordinal * interval '1 second',
         'workbench-boundary-v1', repeat('d', 64), '2026-07',
         'commerce-order-workbench-postgres-v1', 'held',
         ARRAY['ship_to_unavailable']::text[], 0, $5, $5,
         now() + interval '7 days'
       FROM generate_series(1, 1205) AS ordinal`,
      [
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        fixture.run,
        actorEmail,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function expireAcceptedCandidate(pool, fixture) {
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `UPDATE operations_commerce_order_candidates
       SET workflow_state = 'expired',
           created_at = now() - interval '8 days',
           expires_at = now() - interval '1 day'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organization, fixture.candidate],
    )
    await client.query(
      `UPDATE operations_commerce_intake_runs
       SET workflow_state = 'expired',
           created_at = now() - interval '8 days',
           expires_at = now() - interval '1 day'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organization, fixture.run],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function seedNewerProviderRevision(pool, fixture) {
  const client = await pool.connect()
  const runId = randomUUID()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES (
         'gcoc0009703', 'gcoc', 'gcoc0009703', 'active',
         'operations.commerce_order_candidate'
       ) ON CONFLICT (reference_code) DO NOTHING`,
    )
    await client.query(
      `INSERT INTO operations_commerce_intake_runs (
         id, global_id, organization_id, integration_account_id, pipeline_id,
         provider, resource, credential_version, provider_api_version,
         normalizer_version, idempotency_key, request_hash, window_end,
         workflow_state, records_seen, records_staged, created_by, updated_by,
         expires_at
       ) VALUES (
         $1::uuid, 'gcir0009703', $2::uuid, $3::uuid, $4::uuid,
         'shopify', 'orders', 1, '2026-07',
         'commerce-order-workbench-postgres-v2',
         'workbench-newer-provider-revision', $5, now(), 'held', 1, 1,
         $6, $6, now() + interval '7 days'
       )`,
      [
        runId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        'e'.repeat(64),
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_candidates (
         global_id, organization_id, integration_account_id, pipeline_id,
         run_id, provider, external_order_id, order_number_snapshot,
         provider_order_status_raw, provider_financial_status_raw,
         provider_fulfillment_status_raw, provider_return_status_raw,
         normalized_order_status, normalized_payment_status,
         normalized_fulfillment_status, normalized_return_status,
         requires_shipping, currency_code, subtotal_minor, discount_minor,
         brand_discount_minor, shipping_minor, tax_minor,
         other_adjustment_minor, total_minor, party_snapshot_state,
         customer_resolution_state, ship_to_snapshot_state,
         ship_to_snapshot_source, delivery_resolution_state, observed_at,
         provider_updated_at, source_revision, source_hash,
         provider_api_version, normalizer_version, workflow_state,
         blocking_codes, row_version, created_by, updated_by, expires_at
       ) VALUES (
         'gcoc0009703', $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         'shopify', $5, '#NEWER-PROVIDER-REVISION',
         'OPEN', 'PAID', 'UNFULFILLED', 'NONE',
         'open', 'paid', 'unfulfilled', 'none',
         true, 'USD', 1000, 0, 0, 0, 0, 0, 1000, 'missing',
         'unresolved', 'missing', 'none', 'unresolved',
         now() + interval '1 day', now() + interval '1 day',
         'workbench-source-v2', $6, '2026-07',
         'commerce-order-workbench-postgres-v2', 'held',
         ARRAY['ship_to_unavailable']::text[], 0, $7, $7,
         now() + interval '7 days'
       )`,
      [
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        runId,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        'e'.repeat(64),
        actorEmail,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

async function seedProviderLineRevision(pool, fixture, input) {
  const client = await pool.connect()
  const runId = randomUUID()
  const candidateId = randomUUID()
  const lineId = randomUUID()
  const candidateGlobalId = `gcoc${input.suffix}`
  const runGlobalId = `gcir${input.suffix}`
  const lineGlobalId = `gcol${input.suffix}`
  const sourceHash = input.sourceCharacter.repeat(64)
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, entity_type
       ) VALUES
         ($1, 'gcoc', $1, 'active',
          'operations.commerce_order_candidate'),
         ($2, 'gcir', $2, 'active',
          'operations.commerce_intake_run'),
         ($3, 'gcol', $3, 'active',
          'operations.commerce_order_candidate_line')
       ON CONFLICT (reference_code) DO NOTHING`,
      [candidateGlobalId, runGlobalId, lineGlobalId],
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
         'shopify', 'orders', 1, '2026-07',
         'commerce-order-workbench-postgres-line-refresh-v1',
         $6, $7, now(), 'held', 1, 1, $8, $8,
         now() + interval '7 days'
       )`,
      [
        runId,
        runGlobalId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        `workbench-line-refresh-${input.suffix}`,
        sourceHash,
        actorEmail,
      ],
    )
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
         ship_to_snapshot_source, delivery_resolution_state, observed_at,
         provider_updated_at, source_revision, source_hash,
         provider_api_version, normalizer_version, workflow_state,
         blocking_codes, row_version, created_by, updated_by, expires_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'shopify', $7, $8,
         'OPEN', 'PAID', 'UNFULFILLED', 'NONE',
         'open', 'paid', 'unfulfilled', 'none',
         true, 'USD', 2500, 0, 0, 0, 0, 0, 2500, 'missing',
         'unresolved', 'missing', 'none', 'unresolved',
         now() + $9::integer * interval '1 minute',
         now() + $9::integer * interval '1 minute',
         $10, $11, '2026-07',
         'commerce-order-workbench-postgres-line-refresh-v1', 'held',
         ARRAY[
           'customer_resolution_required', 'ship_to_unavailable',
           'delivery_decision_required', 'product_mapping_required',
           'line_price_required', 'packaging_required'
         ]::text[], 0, $12, $12, now() + interval '7 days'
       )`,
      [
        candidateId,
        candidateGlobalId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        runId,
        `gid://shopify/Order/${fixture.candidateGlobalId.slice(-7)}`,
        `#REFRESH-${input.suffix}`,
        input.order,
        `workbench-line-refresh-${input.suffix}`,
        sourceHash,
        actorEmail,
      ],
    )
    await client.query(
      `INSERT INTO operations_commerce_order_candidate_lines (
         id, global_id, organization_id, integration_account_id, pipeline_id,
         run_id, order_candidate_id, provider, external_line_id,
         sku_snapshot, product_title_snapshot, provider_status_raw,
         normalized_status, ordered_quantity, current_quantity,
         cancelled_quantity, fulfilled_quantity, unfulfilled_quantity,
         returned_quantity, unit_multiplier, physical_quantity,
         currency_code, unit_price_minor, subtotal_minor, discount_minor,
         brand_discount_minor, tax_minor, other_adjustment_minor, total_minor,
         price_resolution_state, requires_shipping, mapping_state,
         packaging_state, packaging_source, observed_at, source_revision,
         source_hash, provider_api_version, normalizer_version, workflow_state,
         blocking_codes, created_by, updated_by, expires_at
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, 'shopify', $8,
         'PB-BOX-12', 'Bakery Bites Provider Box', 'OPEN', 'open',
         2, 2, 0, 0, 2, 0, 1, 2, 'USD', 1250,
         2500, 0, 0, 0, 0, 2500, 'unresolved', true, 'unresolved',
         'unresolved', 'none', now(), $9, $10, '2026-07',
         'commerce-order-workbench-postgres-line-refresh-v1', 'held',
         ARRAY[
           'product_mapping_required', 'line_price_required',
           'packaging_required'
         ]::text[], $11, $11, now() + interval '7 days'
       )`,
      [
        lineId,
        lineGlobalId,
        fixture.organization,
        fixture.integration,
        fixture.pipeline,
        runId,
        candidateId,
        input.externalLineId,
        `workbench-line-refresh-${input.suffix}`,
        sourceHash,
        actorEmail,
      ],
    )
    if (Object.hasOwn(input, 'providerRequestedDeliveryAt')) {
      await client.query(
        `UPDATE operations_commerce_order_candidates
         SET provider_requested_delivery_at = $3::timestamptz
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organization, candidateId, input.providerRequestedDeliveryAt],
      )
    }
    return { candidateGlobalId, lineGlobalId }
  } finally {
    await client.query('SET session_replication_role = origin')
    client.release()
  }
}

function auditPersistence(pool) {
  return {
    async recordAuditEvent(input, client) {
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload,
           event_key, subject, organization_id, is_system
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, false
         )
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          input.actor || null,
          input.eventType,
          input.aggregateType || null,
          input.aggregateId || null,
          JSON.stringify(input.payload || {}),
          input.eventKey || null,
          input.subject || null,
          input.organizationId || null,
        ],
      )
    },
  }
}

function candidateResolverPersistence(pool) {
  const mustNotRun = (name) => () => {
    throw new Error(`${name} must not run during workbench handoff`)
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceIntake.ts',
    {
      '@/lib/auditWriter': auditPersistence(pool),
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError,
      },
      '@/lib/integrations/commerceProductMappingPolicy': loadTypeScriptModule(
        'app_src/lib/integrations/commerceProductMappingPolicy.ts',
      ),
      '@/lib/integrations/commerceProductNaming': {
        commerceProductDisplayName({ productTitle, variantTitle }) {
          return [productTitle, variantTitle].filter(Boolean).join(' · ')
        },
      },
      '@/lib/integrations/commerceProductLifecycle': {
        normalizeCommerceProductChannelStatus: mustNotRun(
          'normalizeCommerceProductChannelStatus',
        ),
      },
      '@/lib/integrations/commerceCanonicalProductIdentity': {
        selectCanonicalCommerceProductIdentity: mustNotRun(
          'selectCanonicalCommerceProductIdentity',
        ),
      },
      '@/lib/integrations/commerceProductChannelOffers': {
        selectCommerceProductChannelOffers: mustNotRun(
          'selectCommerceProductChannelOffers',
        ),
      },
      '@/lib/integrations/commercePackRuntime': loadTypeScriptModule(
        'app_src/lib/integrations/commercePackRuntime.ts',
      ),
      '@/lib/integrations/commerceOrderStaging': loadTypeScriptModule(
        'app_src/lib/integrations/commerceOrderStaging.ts',
      ),
      '@/lib/integrations/commerceFaireAutomaticPromotion':
        loadTypeScriptModule(
          'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
        ),
      '@/lib/integrations/commerceShopifyAutomaticPromotion':
        loadTypeScriptModule(
          'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
        ),
      '@/lib/operations/commerceNormalization': loadTypeScriptModule(
        'app_src/lib/operations/commerceNormalization.ts',
      ),
      '@/lib/persistence/commerceIntegrations': {},
      '@/lib/persistence/crm': {
        stageCrmRecordWithClient: mustNotRun('stageCrmRecordWithClient'),
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
      '@/lib/persistence/commerceStoreSync': {
        assertCommerceStoreSyncProviderReadLeaseCurrentWithClient:
          mustNotRun('assertCommerceStoreSyncProviderReadLeaseCurrentWithClient'),
      },
      '@/lib/persistence/commerceCatalogSync': {
        applyCommerceCatalogSyncPolicyWithClient:
          mustNotRun('applyCommerceCatalogSyncPolicyWithClient'),
        commerceCatalogCredentialSupportsProducts:
          mustNotRun('commerceCatalogCredentialSupportsProducts'),
        readCommerceCatalogSyncStateWithClient:
          mustNotRun('readCommerceCatalogSyncStateWithClient'),
      },
      '@/lib/persistence/productChannelStates': {
        linkProductChannelStateWithClient:
          mustNotRun('linkProductChannelStateWithClient'),
        upsertProductChannelStateWithClient:
          mustNotRun('upsertProductChannelStateWithClient'),
      },
      '@/lib/persistence/commerceProductImageImports': {
        reconcileCommerceProductImageSetWithClient:
          mustNotRun('reconcileCommerceProductImageSetWithClient'),
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        reconcileShopifyCheckoutRateForOrderCandidateWithClient:
          mustNotRun('reconcileShopifyCheckoutRateForOrderCandidateWithClient'),
        shopifyCheckoutRateLineageIsRequired: () => false,
        shopifyCheckoutRateOutcomeAllowsFulfillment: () => true,
      },
    },
  )
}

function workbenchPersistence(pool) {
  const orderShipTo = loadTypeScriptModule(
    'app_src/lib/operations/orderShipTo.ts',
  )
  const candidateResolver = candidateResolverPersistence(pool)
  const runtimePersistence = {
    async readCommerceRuntimeCredentialFromPostgres(input) {
      const selected = await pool.query(
        `SELECT id::text, global_id, organization_id::text, provider,
                environment, external_account_id, status, configuration,
                commerce_credential_generation
         FROM operations_integration_accounts
         WHERE organization_id = $1::uuid AND global_id = $2`,
        [input.organizationId, input.accountGlobalId],
      )
      const row = selected.rows[0]
      return row ? {
        organizationId: row.organization_id,
        integrationAccountId: row.id,
        globalId: row.global_id,
        provider: row.provider,
        environment: row.environment,
        externalAccountId: row.external_account_id,
        status: row.status,
        verificationStatus: 'verified',
        credentialVersion: row.commerce_credential_generation,
        authMode: 'shopify_client_credentials',
        configuration: row.configuration,
        encrypted: {
          ciphertext: Buffer.from('workbench-runtime'),
          iv: Buffer.alloc(12, 1),
          tag: Buffer.alloc(16, 2),
          encryptionVersion: 1,
        },
      } : null
    },
  }
  return loadTypeScriptModule(
    'app_src/lib/persistence/commerceOrderWorkbench.ts',
    {
      '@/lib/auditWriter': auditPersistence(pool),
      '@/lib/operations/orderShipTo': orderShipTo,
      '@/lib/persistence/commerceIntake': candidateResolver,
      '@/lib/persistence/commerceIntegrations': runtimePersistence,
      '@/lib/persistence/commerceOrderSync': {
        async readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres(
          input,
        ) {
          assert.deepEqual(
            Array.from(input.providerObservationKinds || []),
            ['manual_exact_read', 'webhook_exact_read'],
            'Workbench line history must request only exact provider evidence',
          )
          const observation = (await pool.query(
            `SELECT observation.id::text, observation.global_id,
                    observation.observed_at, observation.provider_updated_at
             FROM operations_commerce_order_observations observation
             JOIN operations_integration_accounts account
               ON account.organization_id = observation.organization_id
              AND account.id = observation.integration_account_id
              AND account.global_id = $2
             WHERE observation.organization_id = $1::uuid
               AND observation.external_order_id = $3
               AND observation.observation_kind = ANY($4::text[])
             ORDER BY COALESCE(
                        observation.provider_updated_at,
                        observation.observed_at
                      ) DESC,
                      observation.observed_at DESC,
                      observation.id DESC
             LIMIT 1`,
            [
              input.organizationId,
              input.accountGlobalId,
              input.externalOrderId,
              Array.from(input.providerObservationKinds),
            ],
          )).rows[0]
          if (!observation) {
            return {
              items: [],
              truncated: false,
              limit: 500,
              providerWrites: 0,
            }
          }
          const lines = (await pool.query(
            `SELECT external_line_id, external_product_id,
                    external_variant_id, sku, original_quantity::text,
                    current_quantity::text, unfulfilled_quantity::text,
                    fulfilled_quantity::text, returned_quantity::text,
                    requires_shipping
             FROM operations_commerce_order_observation_lines
             WHERE organization_id = $1::uuid
               AND observation_id = $2::uuid
             ORDER BY external_line_id`,
            [input.organizationId, observation.id],
          )).rows
          return {
            items: [{
              evidenceSource: 'provider',
              evidenceGlobalId: observation.global_id,
              eventKind: 'order_lines_snapshot',
              eventStatus: null,
              occurredAt: (
                observation.provider_updated_at || observation.observed_at
              ).toISOString(),
              attributionSource: 'provider_system',
              actorEmail: null,
              providerActorFingerprint: null,
              locationReference: null,
              payload: {
                observationGlobalId: observation.global_id,
                observedAt: observation.observed_at.toISOString(),
                inventorySemantics: 'order_demand',
                lines: lines.map((line) => ({
                  externalLineId: line.external_line_id,
                  externalProductId: line.external_product_id,
                  externalVariantId: line.external_variant_id,
                  sku: line.sku,
                  originalQuantity: Number(line.original_quantity),
                  currentQuantity: line.current_quantity === null
                    ? null
                    : Number(line.current_quantity),
                  unfulfilledQuantity: line.unfulfilled_quantity === null
                    ? null
                    : Number(line.unfulfilled_quantity),
                  fulfilledQuantity: line.fulfilled_quantity === null
                    ? null
                    : Number(line.fulfilled_quantity),
                  returnedQuantity: line.returned_quantity === null
                    ? null
                    : Number(line.returned_quantity),
                  requiresShipping: line.requires_shipping,
                })),
              },
            }],
            truncated: false,
            limit: 500,
            providerWrites: 0,
          }
        },
      },
      '@/lib/persistence/postgres': postgresAdapter(pool),
    },
  )
}

async function candidateSnapshot(pool, fixture) {
  const result = await pool.query(
    `SELECT source_hash, source_revision, row_version::text,
            ship_to_snapshot_state, ship_to_snapshot_source,
            encode(ship_to_snapshot_ciphertext, 'hex') AS ship_to_ciphertext,
            encode(ship_to_snapshot_iv, 'hex') AS ship_to_iv,
            encode(ship_to_snapshot_tag, 'hex') AS ship_to_tag,
            ship_to_snapshot_hash, ship_to_snapshot_encryption_version,
            workflow_state, blocking_codes,
            updated_at
     FROM operations_commerce_order_candidates
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.organization, fixture.candidate],
  )
  assert.equal(result.rowCount, 1)
  return plain(result.rows[0])
}

async function stateCounts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer
        FROM operations_commerce_order_workbench
        WHERE organization_id = $1::uuid) AS working_copies,
       (SELECT count(*)::integer
        FROM operations_command_receipts
        WHERE organization_id = $1::uuid
          AND command_type = $2) AS receipts,
       (SELECT count(*)::integer
        FROM audit_events
        WHERE organization_id = $1::uuid
          AND event_type =
            'operations.commerce_order_workbench.ship_to_updated') AS audits,
       (SELECT count(*)::integer
        FROM operations_commerce_external_effect_intents
        WHERE organization_id = $1::uuid) AS external_effect_intents`,
    [fixture.organization, commandType],
  )
  return plain(result.rows[0])
}

async function verifyAcceptance(
  databaseUrl,
  primary,
  other,
  readyFixture,
  needsInfoFixture,
  acceptFixture,
  refreshFixture,
  nonShippingFixture,
) {
  process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
    'commerce-order-workbench-postgres-encryption-key-material-0001'
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  try {
    await seedFixtures(
      pool,
      primary,
      other,
      readyFixture,
      needsInfoFixture,
      acceptFixture,
      refreshFixture,
      nonShippingFixture,
    )
    const terminalRaceFixture = ids('0009712')
    const failedRetainedFixture = ids('0009713')
    const lockOrderFixture = ids('0009714')
    const terminalRaceSeed = await pool.connect()
    try {
      await terminalRaceSeed.query('SET session_replication_role = replica')
      await seedTenant(
        terminalRaceSeed,
        terminalRaceFixture,
        'Terminal evidence race workbench',
      )
      await seedReadyFacts(terminalRaceSeed, terminalRaceFixture)
      await seedTenant(
        terminalRaceSeed,
        failedRetainedFixture,
        'Failed retained workbench',
      )
      await seedReadyFacts(terminalRaceSeed, failedRetainedFixture)
      await seedTenant(
        terminalRaceSeed,
        lockOrderFixture,
        'Promotion save lock order workbench',
      )
    } finally {
      await terminalRaceSeed.query('SET session_replication_role = origin')
        .catch(() => {})
      terminalRaceSeed.release()
    }
    const persistence = workbenchPersistence(pool)
    const candidatePersistence = candidateResolverPersistence(pool)
    const emptyAddress = {
      name: null,
      line1: null,
      line2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    }
    const mergeConflict = plain(
      persistence.mergeCommerceOrderWorkbenchProviderAddress({
        acceptedProvider: emptyAddress,
        local: { ...emptyAddress, city: 'Charlotte', region: 'NC' },
        latestProvider: { ...emptyAddress, city: 'Raleigh', line1: '20 New Way' },
      }),
    )
    assert.deepEqual(mergeConflict.conflicts, [{
      field: 'city',
      localValue: 'Charlotte',
      providerValue: 'Raleigh',
    }])
    assert.equal(mergeConflict.merged.line1, '20 New Way')
    assert.equal(mergeConflict.merged.region, 'NC')
    const resolvedMerge = plain(
      persistence.mergeCommerceOrderWorkbenchProviderAddress({
        acceptedProvider: emptyAddress,
        local: { ...emptyAddress, city: 'Charlotte', region: 'NC' },
        latestProvider: { ...emptyAddress, city: 'Raleigh', line1: '20 New Way' },
        resolutions: { city: 'local' },
      }),
    )
    assert.deepEqual(resolvedMerge.conflicts, [])
    assert.equal(resolvedMerge.merged.city, 'Charlotte')
    assert.equal(resolvedMerge.merged.line1, '20 New Way')
    assert.ok(resolvedMerge.preservedLocalFields.includes('city'))
    assert.ok(resolvedMerge.preservedLocalFields.includes('region'))
    const deliveryBase = '2026-08-25T12:00:00.123Z'
    const deliveryLocal = '2026-08-26T12:00:00.123Z'
    const deliveryLatest = '2026-08-27T12:00:00.123Z'
    assert.deepEqual(
      plain(persistence.mergeCommerceOrderWorkbenchRequestedDelivery({
        acceptedProvider: deliveryBase,
        local: deliveryBase,
        latestProvider: deliveryLatest,
      })),
      {
        merged: deliveryLatest,
        localChanged: false,
        providerChanged: true,
        requiresResolution: false,
        preservedLocal: false,
        conflict: null,
      },
      'provider-only requested-delivery changes must be adopted',
    )
    assert.equal(
      persistence.mergeCommerceOrderWorkbenchRequestedDelivery({
        acceptedProvider: deliveryBase,
        local: deliveryLocal,
        latestProvider: deliveryBase,
      }).merged,
      deliveryLocal,
      'local-only requested-delivery changes must be preserved',
    )
    const deliveryConflict = plain(
      persistence.mergeCommerceOrderWorkbenchRequestedDelivery({
        acceptedProvider: deliveryBase,
        local: deliveryLocal,
        latestProvider: deliveryLatest,
      }),
    )
    assert.deepEqual(deliveryConflict.conflict, {
      field: 'requestedDeliveryAt',
      localValue: deliveryLocal,
      providerValue: deliveryLatest,
    })
    assert.equal(
      persistence.mergeCommerceOrderWorkbenchRequestedDelivery({
        acceptedProvider: deliveryBase,
        local: deliveryLocal,
        latestProvider: deliveryLatest,
        resolution: 'provider',
      }).merged,
      deliveryLatest,
    )
    const savedLineDraft = {
      productGlobalId: 'gp0009701',
      unitPriceMinor: 1250,
      currency: 'USD',
      packageProfileGlobalId: 'gpp0009701',
    }
    const preservedLineMerge = plain(
      persistence.mergeCommerceOrderWorkbenchLineDrafts({
        acceptedLines: [{
          candidate_id: 'accepted',
          global_id: 'gcol0009701',
          external_line_id: 'provider-line-1',
          product_title_snapshot: 'Bakery bites',
          sku_snapshot: 'BITES-1',
        }],
        latestLines: [{
          candidate_id: 'latest',
          global_id: 'gcol0009702',
          external_line_id: 'provider-line-1',
          product_title_snapshot: 'Bakery bites updated',
          sku_snapshot: 'BITES-1',
        }],
        localDrafts: { gcol0009701: savedLineDraft },
      }),
    )
    assert.deepEqual(preservedLineMerge.drafts, {
      gcol0009702: savedLineDraft,
    })
    assert.deepEqual(preservedLineMerge.preservedLineDrafts, [{
      previousLineGlobalId: 'gcol0009701',
      lineGlobalId: 'gcol0009702',
      externalLineId: 'provider-line-1',
    }])
    assert.deepEqual(preservedLineMerge.conflicts, [])
    const changedLineIdentity = plain(
      persistence.mergeCommerceOrderWorkbenchLineDrafts({
        acceptedLines: [{
          candidate_id: 'accepted',
          global_id: 'gcol0009701',
          external_line_id: 'provider-line-1',
          product_title_snapshot: 'Bakery bites',
          sku_snapshot: 'BITES-1',
        }],
        latestLines: [{
          candidate_id: 'latest',
          global_id: 'gcol0009702',
          external_line_id: 'provider-line-2',
          product_title_snapshot: 'Replacement bites',
          sku_snapshot: 'BITES-2',
        }],
        localDrafts: { gcol0009701: savedLineDraft },
      }),
    )
    assert.equal(changedLineIdentity.conflicts.length, 1)
    assert.equal(changedLineIdentity.conflicts[0].reason, 'provider_line_missing')
    assert.deepEqual(changedLineIdentity.conflicts[0].localDraft, savedLineDraft)
    const providerBefore = await candidateSnapshot(pool, primary)
    const initialCounts = await stateCounts(pool, primary)

    const initial = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
      }))
    assert.equal(initial.length, 1, 'missing-address candidate appears in grid')
    assert.equal(initial[0].candidateGlobalId, primary.candidateGlobalId)
    assert.equal(initial[0].needsInfo, true)
    assert.equal(initial[0].rowVersion, 0)
    assert.equal(initial[0].shipTo.readiness, 'missing')
    assert.equal(initial[0].shipTo.provenance, 'provider')
    assert.equal(initial[0].shipTo.syncStatus, 'provider_snapshot')
    assert.equal(initial[0].providerWrites, 0)
    assert.equal(initial[0].providerVersionChanged, false)
    assert.deepEqual(initial[0].providerState, {
      lifecycle: 'open',
      fulfillment: 'unfulfilled',
      observedAt: initial[0].providerState.observedAt,
      source: 'operational',
    })
    assert.deepEqual(initial[0].shipTo.value, {
      name: null,
      line1: null,
      line2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    })
    const retainedDraft = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: failedRetainedFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-failed-retained-save-0001',
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Retained after failed provider row' },
      }))
    assert.equal(retainedDraft.rowVersion, 1)
    const failedRetainedSeed = await pool.connect()
    try {
      await failedRetainedSeed.query('SET session_replication_role = replica')
      await failedRetainedSeed.query(
        `UPDATE operations_commerce_order_candidates
         SET workflow_state = 'failed', updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [failedRetainedFixture.organization, failedRetainedFixture.candidate],
      )
    } finally {
      await failedRetainedSeed.query('SET session_replication_role = origin')
        .catch(() => {})
      failedRetainedSeed.release()
    }
    const failedRetained = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: failedRetainedFixture.organization,
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
      }))
    assert.equal(
      failedRetained.length,
      1,
      'a retained working copy must survive a failed latest provider row',
    )
    assert.deepEqual(failedRetained[0].providerState, {
      lifecycle: 'open',
      fulfillment: 'unfulfilled',
      observedAt: failedRetained[0].providerState.observedAt,
      source: 'retained',
    })
    assert.equal(failedRetained[0].workflowState, 'failed')
    assert.equal(
      failedRetained[0].actionAvailable,
      false,
      'a retained failed candidate must remain visible without looking ready',
    )
    const latestTerminalCandidate = await seedNewerTerminalProviderCandidate(
      pool,
      failedRetainedFixture,
    )
    const exactTerminalHistory = await seedExactTerminalProviderHistory(
      pool,
      failedRetainedFixture,
      latestTerminalCandidate,
    )
    const failedRetainedTerminalSummary = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: failedRetainedFixture.organization,
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
      }))
    assert.equal(
      failedRetainedTerminalSummary[0].providerHistory.observedAt,
      exactTerminalHistory.observedAt,
      'summary rows must expose the latest persisted exact-history observation marker',
    )
    assert.equal(
      failedRetainedTerminalSummary[0].orderNumber,
      latestTerminalCandidate.orderNumber,
      'terminal summary identity must use the same latest snapshot as display',
    )
    assert.equal(
      failedRetainedTerminalSummary[0].customerName,
      latestTerminalCandidate.customerName,
      'terminal customer sort and search identity must match the displayed snapshot',
    )
    assert.deepEqual(
      failedRetainedTerminalSummary[0].providerHistory.currentLines,
      [],
      'summary rows must not load exact-history line timelines',
    )
    assert.deepEqual(
      failedRetainedTerminalSummary[0].providerHistory.events,
      [],
      'summary rows must not load exact-history event timelines',
    )
    const failedRetainedTerminal = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: failedRetainedFixture.organization,
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(
      failedRetainedTerminal.length,
      1,
      'a newer terminal provider candidate must retain the accepted working copy',
    )
    assert.equal(
      failedRetainedTerminal[0].candidateGlobalId,
      failedRetainedFixture.candidateGlobalId,
      'terminal display facts must not replace the accepted command identity',
    )
    assert.deepEqual(failedRetainedTerminal[0].providerState, {
      lifecycle: 'closed',
      fulfillment: 'fulfilled',
      observedAt: failedRetainedTerminal[0].providerState.observedAt,
      source: 'history',
    }, 'a retained row must project the latest exact terminal provider state')
    assert.equal(failedRetainedTerminal[0].lineCount, 2)
    assert.equal(
      failedRetainedTerminal[0].providerHistory.currentLines.length,
      2,
      'the exact provider observation must retain its complete line snapshot',
    )
    assert.equal(
      failedRetainedTerminal[0].trackingNumber,
      exactTerminalHistory.trackingNumber,
      'the imported summary must expose current unredacted tracking evidence',
    )
    assert.equal(
      failedRetainedTerminal[0].updatedAt,
      exactTerminalHistory.trackingActivityAt,
      'imported activity time must include the latest provider tracking event',
    )
    const searchedExactSku = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: failedRetainedFixture.organization,
        search: 'EXACT-ONLY-SKU',
      }))
    assert.deepEqual(
      searchedExactSku.map((order) => order.candidateGlobalId),
      [failedRetainedFixture.candidateGlobalId],
      'imported search must include exact provider-history SKUs',
    )
    const searchedTracking = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: failedRetainedFixture.organization,
        search: exactTerminalHistory.trackingNumber,
      }))
    assert.deepEqual(
      searchedTracking.map((order) => order.candidateGlobalId),
      [failedRetainedFixture.candidateGlobalId],
      'imported search must include unredacted tracking evidence',
    )
    for (const displaySearch of [
      latestTerminalCandidate.orderNumber,
      latestTerminalCandidate.customerName,
    ]) {
      const searchedDisplayIdentity = plain(await persistence
        .readCommerceOrderWorkbenchFromPostgres({
          organizationId: failedRetainedFixture.organization,
          search: displaySearch,
        }))
      assert.deepEqual(
        searchedDisplayIdentity.map((order) => order.candidateGlobalId),
        [failedRetainedFixture.candidateGlobalId],
        'terminal search must use the same order and customer identity shown to users',
      )
    }
    const trackingPresent = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        tracking: 'present',
      }))
    assert.equal(trackingPresent.orders.length, 1)
    const trackingMissing = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        tracking: 'missing',
      }))
    assert.equal(trackingMissing.orders.length, 0)
    const shopifyOnly = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        provider: 'shopify',
      }))
    assert.equal(shopifyOnly.orders.length, 1)
    const faireOnly = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        provider: 'faire',
      }))
    assert.equal(faireOnly.orders.length, 0)
    const oneMillisecondBeforeActivity = new Date(
      Date.parse(failedRetainedTerminal[0].updatedAt) - 1,
    ).toISOString()
    const updatedAfterEarlier = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        updatedAfter: oneMillisecondBeforeActivity,
      }))
    assert.equal(updatedAfterEarlier.orders.length, 1)
    const updatedAfterExact = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        updatedAfter: failedRetainedTerminal[0].updatedAt,
      }))
    assert.equal(updatedAfterExact.orders.length, 0)
    const trackingRemovedAt = new Date(
      Date.parse(exactTerminalHistory.trackingActivityAt) + 86_400_000,
    ).toISOString()
    const trackingRemovalSeed = await pool.connect()
    try {
      await trackingRemovalSeed.query('SET session_replication_role = replica')
      await trackingRemovalSeed.query(
        `INSERT INTO operations_commerce_order_event_observations (
         organization_id, integration_account_id, observation_id,
         provider, external_order_id, external_event_id,
         external_subject_id, event_hash, event_kind, event_status,
         attribution_source, tracking_carrier, tracking_number,
         tracking_url, sensitive_evidence_expires_at,
         occurred_at, observed_at
       )
       SELECT $1::uuid, $2::uuid, observation.id, 'shopify', $3,
              'workbench-tracking-removed-0009715',
              'workbench-exact-shipment-0009715', $4,
              'tracking_updated', 'fulfilled', 'provider_system',
              NULL, NULL, NULL, $5::timestamptz + interval '30 days',
              $5::timestamptz, $5::timestamptz
       FROM operations_commerce_order_observations observation
       WHERE observation.organization_id = $1::uuid
         AND observation.global_id = $6`,
        [
          failedRetainedFixture.organization,
          failedRetainedFixture.integration,
          `gid://shopify/Order/${failedRetainedFixture.candidateGlobalId.slice(-7)}`,
          '3'.repeat(64),
          trackingRemovedAt,
          exactTerminalHistory.observationGlobalId,
        ],
      )
    } finally {
      await trackingRemovalSeed.query('SET session_replication_role = origin')
        .catch(() => {})
      trackingRemovalSeed.release()
    }
    const removedTrackingState = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: failedRetainedFixture.organization,
        tracking: 'missing',
      }))
    assert.equal(removedTrackingState.orders.length, 1)
    assert.equal(removedTrackingState.orders[0].trackingNumber, null)
    assert.equal(
      removedTrackingState.orders[0].updatedAt,
      trackingRemovedAt,
      'a newer no-tracking event must replace stale tracking and remain activity',
    )
    assert.deepEqual(
      Object.fromEntries(failedRetainedTerminal[0].lines.map((line) => [
        line.externalLineId,
        {
          title: line.title,
          sku: line.sku,
          quantity: line.quantity,
          orderedQuantity: line.orderedQuantity,
          currentQuantity: line.currentQuantity,
          cancelledOrRemovedQuantity: line.cancelledOrRemovedQuantity,
          fulfilledQuantity: line.fulfilledQuantity,
          unfulfilledQuantity: line.unfulfilledQuantity,
          returnedQuantity: line.returnedQuantity,
          providerStatus: line.providerStatus,
          blockerCodes: line.blockerCodes,
        },
      ])),
      {
        [latestTerminalCandidate.externalLineId]: {
          title: 'Latest externally fulfilled item',
          sku: 'EXACT-MATCHED',
          quantity: 0,
          orderedQuantity: 9,
          currentQuantity: 8,
          cancelledOrRemovedQuantity: 1,
          fulfilledQuantity: 8,
          unfulfilledQuantity: 0,
          returnedQuantity: 3,
          providerStatus: 'returned',
          blockerCodes: [],
        },
        [exactTerminalHistory.exactOnlyExternalLineId]: {
          title: 'EXACT-ONLY-SKU',
          sku: 'EXACT-ONLY-SKU',
          quantity: 0,
          orderedQuantity: 2,
          currentQuantity: 1,
          cancelledOrRemovedQuantity: 1,
          fulfilledQuantity: 1,
          unfulfilledQuantity: 0,
          returnedQuantity: 1,
          providerStatus: 'returned',
          blockerCodes: [],
        },
      },
      'terminal detail must prefer exact-observation adjustments and include history-only lines from the latest provider revision',
    )
    assert.equal(
      failedRetainedTerminal[0].blockerCodes.includes('packaging_required'),
      false,
      'terminal line history must not reintroduce active packaging blockers',
    )
    const failedRetainedTerminalState = await stateCounts(
      pool,
      failedRetainedFixture,
    )
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: failedRetainedFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-failed-retained-terminal-save-0001',
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
        expectedRowVersion: 1,
        changes: { name: 'Must not save a terminal retained order' },
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    await expectWorkbenchError(
      () => persistence.acceptCommerceOrderWorkbenchInPostgres({
        organizationId: failedRetainedFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-failed-retained-terminal-accept-0001',
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
        expectedRowVersion: 1,
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    assert.deepEqual(
      await stateCounts(pool, failedRetainedFixture),
      failedRetainedTerminalState,
      'terminal retained-row save and accept attempts must roll back completely',
    )
    const localDraftFacts = (await pool.query(
      `SELECT line.global_id AS line_global_id,
              product.reference_code AS product_global_id,
              customer.reference_code AS customer_global_id
       FROM operations_commerce_order_candidate_lines line
       JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id
        AND product.id = line.product_id
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = line.organization_id
        AND candidate.id = line.order_candidate_id
       JOIN crm_organizations customer
         ON customer.pipeline_id = candidate.pipeline_id
        AND customer.id = candidate.customer_id
       WHERE line.organization_id = $1::uuid
         AND line.order_candidate_id = $2::uuid
       LIMIT 1`,
      [failedRetainedFixture.organization, failedRetainedFixture.candidate],
    )).rows[0]
    const terminalDraftSeed = await pool.connect()
    try {
      await terminalDraftSeed.query('SET session_replication_role = replica')
      await terminalDraftSeed.query(
        `UPDATE operations_commerce_order_workbench
         SET customer_global_id_draft = $2,
             requested_delivery_at_draft =
               '2026-09-15T16:00:00.000Z'::timestamptz,
             line_resolution_drafts = jsonb_build_object(
               $3::text,
               jsonb_build_object(
                 'productGlobalId', $4::text,
                 'unitPriceMinor', 1000,
                 'currency', 'USD',
                 'packageProfileGlobalId', null
               )
             )
         WHERE organization_id = $1::uuid`,
        [
          failedRetainedFixture.organization,
          localDraftFacts.customer_global_id,
          localDraftFacts.line_global_id,
          localDraftFacts.product_global_id,
        ],
      )
    } finally {
      await terminalDraftSeed.query('SET session_replication_role = origin')
        .catch(() => {})
      terminalDraftSeed.release()
    }
    const terminalRebase = plain(await persistence
      .rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: failedRetainedFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-terminal-rebase-clears-drafts-0001',
        candidateGlobalId: failedRetainedFixture.candidateGlobalId,
        expectedRowVersion: 1,
      }))
    assert.deepEqual(terminalRebase, {
      previousCandidateGlobalId: failedRetainedFixture.candidateGlobalId,
      candidateGlobalId: latestTerminalCandidate.candidateGlobalId,
      rowVersion: 2,
      status: 'rebased',
      providerChangedFields: [],
      preservedLocalFields: [],
      preservedLineDrafts: [],
      providerWrites: 0,
      providerWriteIntentCreated: false,
      replayed: false,
    }, 'terminal refresh must rebase without irrelevant line conflicts')
    const terminalRebasedState = (await pool.query(
      `SELECT candidate.global_id AS candidate_global_id,
              workbench.ship_to_edit_state,
              workbench.ship_to_ciphertext,
              workbench.customer_global_id_draft,
              workbench.requested_delivery_at_draft,
              workbench.line_resolution_drafts,
              workbench.sync_state,
              workbench.row_version::integer,
              receipt.status AS receipt_status
       FROM operations_commerce_order_workbench workbench
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = workbench.organization_id
        AND candidate.id = workbench.candidate_id
       JOIN operations_command_receipts receipt
         ON receipt.organization_id = workbench.organization_id
        AND receipt.id = workbench.last_command_receipt_id
       WHERE workbench.organization_id = $1::uuid`,
      [failedRetainedFixture.organization],
    )).rows[0]
    assert.deepEqual(plain(terminalRebasedState), {
      candidate_global_id: latestTerminalCandidate.candidateGlobalId,
      ship_to_edit_state: 'provider_snapshot',
      ship_to_ciphertext: null,
      customer_global_id_draft: null,
      requested_delivery_at_draft: null,
      line_resolution_drafts: {},
      sync_state: 'provider_snapshot',
      row_version: 2,
      receipt_status: 'succeeded',
    }, 'terminal refresh must discard every stale editable draft')

    let reportPromotionCandidateLocked = () => {}
    const promotionCandidateLocked = new Promise((resolve) => {
      reportPromotionCandidateLocked = resolve
    })
    let allowPromotionToContinue = () => {}
    const promotionMayContinue = new Promise((resolve) => {
      allowPromotionToContinue = resolve
    })
    const promotionOutcomePromise = candidatePersistence
      .promoteCommerceCandidateInPostgres({
        runtime: {
          organizationId: lockOrderFixture.organization,
          integrationAccountId: lockOrderFixture.integration,
          globalId: lockOrderFixture.integrationGlobalId,
          provider: 'shopify',
          environment: 'sandbox',
          externalAccountId:
            `gid://shopify/Shop/${lockOrderFixture.integrationGlobalId.slice(-7)}`,
          status: 'active',
          verificationStatus: 'verified',
          credentialVersion: 1,
          authMode: 'shopify_client_credentials',
          configuration: {},
          encrypted: {},
        },
        actorEmail,
        idempotencyKey: 'workbench-lock-order-promote-0001',
        candidateGlobalId: lockOrderFixture.candidateGlobalId,
        candidateRowVersion: 0,
        requestHash: '8'.repeat(64),
        async afterCandidateLockBeforeProviderStateFence() {
          reportPromotionCandidateLocked()
          await promotionMayContinue
        },
      })
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      )
    await Promise.race([
      promotionCandidateLocked,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Promotion did not acquire the candidate row')),
        5_000,
      )),
    ])
    const saveOutcomePromise = persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: lockOrderFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-lock-order-save-0001',
        candidateGlobalId: lockOrderFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Serialized after promotion' },
      })
      .then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      )
    await waitForBlockedDatabaseLock(
      pool,
      'Concurrent workbench Save behind promotion',
    )
    let providerLocksAvailable = false
    try {
      providerLocksAvailable = await providerFenceLocksAreAvailable(
        pool,
        lockOrderFixture,
      )
    } finally {
      allowPromotionToContinue()
    }
    const [promotionOutcome, saveOutcome] = await Promise.all([
      promotionOutcomePromise,
      saveOutcomePromise,
    ])
    assert.equal(
      providerLocksAvailable,
      true,
      'Save must wait on the candidate row before taking provider identity locks',
    )
    assert.equal(promotionOutcome.status, 'rejected')
    assert.notEqual(
      promotionOutcome.reason?.code,
      '40P01',
      'promotion must not deadlock against a concurrent manager Save',
    )
    assert.equal(
      saveOutcome.status,
      'fulfilled',
      `manager Save must resume after promotion rolls back: ${
        saveOutcome.reason?.message || 'unknown failure'
      }`,
    )
    assert.equal(saveOutcome.value.rowVersion, 1)

    assert.ok(
      !initial.some((row) => row.candidateGlobalId === other.candidateGlobalId),
      'tenant list must not leak another organization candidate',
    )

    const providerStatusFixture = other
    const providerStatusClient = await pool.connect()
    try {
      await providerStatusClient.query('SET session_replication_role = replica')
      await providerStatusClient.query(
        `INSERT INTO operations_commerce_order_sync_policies (
           organization_id, integration_account_id,
           historical_observation_enabled, continuous_observation_enabled,
           continuous_transport, provider_event_processor_state, revision,
           created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, false, true,
           'scheduled_poll', 'processor_pending', 1, $3, $3
         )`,
        [
          providerStatusFixture.organization,
          providerStatusFixture.integration,
          actorEmail,
        ],
      )
      const providerStatusSession = (await providerStatusClient.query(
        `INSERT INTO operations_commerce_order_backfill_sessions (
           organization_id, integration_account_id, provider, session_kind,
           credential_generation, policy_revision, coverage_basis, status,
           requested_from, requested_through, locked_at, locked_by,
           lock_token, lease_expires_at, idempotency_key, request_hash,
           query_hash, requested_by, reason
         ) VALUES (
           $1::uuid, $2::uuid, 'shopify', 'continuous_poll', 1, 1,
           'shopify_updated_at_overlap', 'processing',
           now() - interval '1 day', now() + interval '2 seconds',
           now(), 'workbench-provider-status-fixture', gen_random_uuid(),
           now() + interval '5 minutes', $3, $4, $5, $6, $7
         ) RETURNING id::text`,
        [
          providerStatusFixture.organization,
          providerStatusFixture.integration,
          `workbench-provider-status-${providerStatusFixture.candidateGlobalId}`,
          'f'.repeat(64),
          '0'.repeat(64),
          actorEmail,
          'Workbench current provider status read fixture',
        ],
      )).rows[0]
      await providerStatusClient.query(
        `INSERT INTO operations_commerce_order_observations (
           organization_id, integration_account_id, backfill_session_id,
           provider,
           credential_generation, observation_kind, external_order_id,
           order_number, source_revision, source_hash,
           canonical_lifecycle_state, canonical_payment_state,
           canonical_fulfillment_state, canonical_return_state,
           provider_updated_at, observed_at, provider_read_count
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'shopify', 1, 'scheduled_poll',
           $4, $5, 'workbench-provider-status-v2', $6,
           'closed', 'paid', 'fulfilled', 'none',
           now() + interval '1 second', now() + interval '1 second', 1
         )`,
        [
          providerStatusFixture.organization,
          providerStatusFixture.integration,
          providerStatusSession.id,
          `gid://shopify/Order/${providerStatusFixture.candidateGlobalId.slice(-7)}`,
          `#${providerStatusFixture.candidateGlobalId.slice(-7)}`,
          'e'.repeat(64),
        ],
      )
    } finally {
      await providerStatusClient.query('SET session_replication_role = origin')
      providerStatusClient.release()
    }
    const [externallyFulfilled] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: providerStatusFixture.organization,
      }))
    assert.equal(
      externallyFulfilled.candidateGlobalId,
      providerStatusFixture.candidateGlobalId,
    )
    assert.deepEqual(externallyFulfilled.providerState, {
      lifecycle: 'closed',
      fulfillment: 'fulfilled',
      observedAt: externallyFulfilled.providerState.observedAt,
      source: 'history',
    })
    const providerTerminalStateBefore = await stateCounts(
      pool,
      providerStatusFixture,
    )
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: providerStatusFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-provider-terminal-save-0001',
        candidateGlobalId: providerStatusFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Must not create a terminal-order draft' },
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    await expectWorkbenchError(
      () => persistence.acceptCommerceOrderWorkbenchInPostgres({
        organizationId: providerStatusFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-provider-terminal-accept-0001',
        candidateGlobalId: providerStatusFixture.candidateGlobalId,
        expectedRowVersion: 0,
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    await expectWorkbenchError(
      () => candidatePersistence.promoteCommerceCandidateInPostgres({
        runtime: {
          organizationId: providerStatusFixture.organization,
          integrationAccountId: providerStatusFixture.integration,
          globalId: providerStatusFixture.integrationGlobalId,
          provider: 'shopify',
          environment: 'sandbox',
          externalAccountId:
            `gid://shopify/Shop/${providerStatusFixture.integrationGlobalId}`,
          status: 'active',
          verificationStatus: 'verified',
          credentialVersion: 1,
          authMode: 'shopify_client_credentials',
          configuration: {},
          encrypted: {},
        },
        actorEmail,
        idempotencyKey: 'workbench-provider-terminal-promote-0001',
        candidateGlobalId: providerStatusFixture.candidateGlobalId,
        candidateRowVersion: 0,
        requestHash: '9'.repeat(64),
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    assert.deepEqual(
      await stateCounts(pool, providerStatusFixture),
      providerTerminalStateBefore,
      'terminal provider evidence must roll back save and accept checkpoints',
    )
    assert.equal(Number((await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3`,
      [
        providerStatusFixture.organization,
        providerStatusFixture.integration,
        `gid://shopify/Order/${providerStatusFixture.candidateGlobalId.slice(-7)}`,
      ],
    )).rows[0].count), 0, 'terminal evidence must block canonical promotion')

    const terminalRaceDraft = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: terminalRaceFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-terminal-race-save-0001',
        candidateGlobalId: terminalRaceFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: {
          name: 'Terminal Race Receiving',
          line1: '22 Market Street',
          city: 'Charlotte',
          region: 'NC',
          postalCode: '28202',
          country: 'US',
        },
      }))
    assert.equal(terminalRaceDraft.rowVersion, 1)
    await expectWorkbenchError(
      () => persistence.acceptCommerceOrderWorkbenchInPostgres({
        organizationId: terminalRaceFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-terminal-race-accept-0002',
        candidateGlobalId: terminalRaceFixture.candidateGlobalId,
        expectedRowVersion: 1,
        async afterLocalSaveBeforeHandoff() {
          await seedTerminalProviderObservation(
            pool,
            terminalRaceFixture,
            'accept-race',
          )
        },
      }),
      'COMMERCE_INTAKE_PROVIDER_ORDER_TERMINAL',
      409,
    )
    const terminalRaceState = (await pool.query(
      `SELECT
         workbench.row_version::integer,
         workbench.canonical_order_id::text,
         receipt.status,
         (
           SELECT count(*)::integer
           FROM operations_orders canonical
           WHERE canonical.organization_id = $1::uuid
             AND canonical.integration_account_id = $2::uuid
             AND canonical.external_order_id = $4
         ) AS canonical_count
       FROM operations_commerce_order_workbench workbench
       JOIN operations_command_receipts receipt
         ON receipt.organization_id = workbench.organization_id
        AND receipt.id = workbench.last_command_receipt_id
       WHERE workbench.organization_id = $1::uuid
         AND receipt.idempotency_key = $3`,
      [
        terminalRaceFixture.organization,
        terminalRaceFixture.integration,
        'workbench-terminal-race-accept-0002',
        `gid://shopify/Order/${terminalRaceFixture.candidateGlobalId.slice(-7)}`,
      ],
    )).rows[0]
    assert.deepEqual(plain(terminalRaceState), {
      row_version: 2,
      canonical_order_id: null,
      status: 'processing',
      canonical_count: 0,
    }, 'terminal history arriving after the Accept checkpoint must fence promotion')

    const needsInfoBefore = await candidateSnapshot(pool, needsInfoFixture)
    const [needsInfoDetailed] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: needsInfoFixture.organization,
        candidateGlobalId: needsInfoFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(needsInfoDetailed.resolutionDetailsLoaded, true)
    assert.equal(needsInfoDetailed.customer.status, 'unresolved')
    assert.equal(needsInfoDetailed.customer.selectedCustomerGlobalId, null)
    assert.deepEqual(needsInfoDetailed.customer.options, [{
      globalId: needsInfoFixture.customerGlobalId,
      name: 'Pro Bakery Bites',
      email: 'orders@probakery.example',
    }])
    assert.ok(needsInfoDetailed.delivery.providerRequestedDeliveryAt)
    assert.equal(needsInfoDetailed.lines.length, 1)
    assert.equal(needsInfoDetailed.lines[0].globalId, needsInfoFixture.lineGlobalId)
    assert.equal(needsInfoDetailed.lines[0].sku, 'PB-BOX-12')
    assert.equal(needsInfoDetailed.lines[0].quantity, 2)
    assert.equal(needsInfoDetailed.lines[0].requiresShipping, true)
    assert.equal(needsInfoDetailed.lines[0].productGlobalId, null)
    assert.equal(needsInfoDetailed.lines[0].unitPriceMinor, 1250)
    assert.deepEqual(needsInfoDetailed.productOptions, [{
      globalId: needsInfoFixture.productGlobalId,
      name: 'Bakery Bites Variety Box',
      sku: 'BB-VARIETY',
      packageProfiles: [{
        globalId: needsInfoFixture.packageProfileGlobalId,
        name: 'Measured each',
      }],
    }])

    const needsInfoPartial = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: needsInfoFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-needs-info-partial-0001',
        candidateGlobalId: needsInfoFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Pro Bakery Receiving' },
        resolutionDraft: {
          customerGlobalId: needsInfoFixture.customerGlobalId,
          requestedDeliveryAt:
            needsInfoDetailed.delivery.providerRequestedDeliveryAt,
          lines: [{
            lineGlobalId: needsInfoFixture.lineGlobalId,
            productGlobalId: needsInfoFixture.productGlobalId,
            unitPriceMinor: null,
            currency: 'USD',
            packageProfileGlobalId: null,
          }],
        },
      }))
    assert.equal(needsInfoPartial.rowVersion, 1)
    assert.equal(needsInfoPartial.promotionStatus, 'not_ready')
    assert.deepEqual(
      await candidateSnapshot(pool, needsInfoFixture),
      needsInfoBefore,
      'partial Needs info edits must remain local',
    )
    const [savedNeedsInfo] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: needsInfoFixture.organization,
        candidateGlobalId: needsInfoFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(
      savedNeedsInfo.customer.selectedCustomerGlobalId,
      needsInfoFixture.customerGlobalId,
    )
    assert.equal(
      savedNeedsInfo.delivery.draftDeliveryAt,
      needsInfoDetailed.delivery.providerRequestedDeliveryAt,
    )
    assert.equal(
      savedNeedsInfo.lines[0].productGlobalId,
      needsInfoFixture.productGlobalId,
    )
    assert.equal(savedNeedsInfo.lines[0].unitPriceMinor, null)
    assert.equal(savedNeedsInfo.lines[0].packageProfileGlobalId, null)
    await expectDatabaseError(
      () => pool.query(
        `UPDATE operations_commerce_order_workbench
         SET customer_global_id_draft = 'ga9999999'
         WHERE organization_id = $1::uuid`,
        [needsInfoFixture.organization],
      ),
      /customer draft is invalid/iu,
    )
    await expectDatabaseError(
      () => pool.query(
        `UPDATE operations_commerce_order_workbench
         SET line_resolution_drafts = jsonb_build_object(
           $2::text,
           jsonb_build_object(
             'productGlobalId', 'gp9999999',
             'unitPriceMinor', 1250,
             'currency', 'USD',
             'packageProfileGlobalId', null
           )
         )
         WHERE organization_id = $1::uuid`,
        [needsInfoFixture.organization, needsInfoFixture.lineGlobalId],
      ),
      /line draft is invalid/iu,
    )

    const needsInfoCompletedDraft = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: needsInfoFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-needs-info-promote-0002',
        candidateGlobalId: needsInfoFixture.candidateGlobalId,
        expectedRowVersion: 1,
        changes: {
          line1: '12 Bakery Lane',
          city: 'Charlotte',
          region: 'NC',
          postalCode: '28202',
          country: 'US',
        },
        resolutionDraft: {
          customerGlobalId: needsInfoFixture.customerGlobalId,
          requestedDeliveryAt:
            needsInfoDetailed.delivery.providerRequestedDeliveryAt,
          lines: [{
            lineGlobalId: needsInfoFixture.lineGlobalId,
            productGlobalId: needsInfoFixture.productGlobalId,
            unitPriceMinor: 1250,
            currency: 'USD',
            packageProfileGlobalId: null,
          }],
        },
      }))
    assert.equal(needsInfoCompletedDraft.promotionStatus, 'needs_info')
    assert.equal(needsInfoCompletedDraft.canonicalOrderGlobalId, null)
    assert.ok(
      needsInfoCompletedDraft.remainingBlockerCodes.includes(
        'customer_resolution_required',
      ),
      'Save may report stale provider blockers but must remain local',
    )
    assert.deepEqual(
      await candidateSnapshot(pool, needsInfoFixture),
      needsInfoBefore,
      'a complete Save must not hand off or mutate the provider candidate',
    )
    const needsInfoPromoted = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres({
        organizationId: needsInfoFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-needs-info-accept-0003',
        candidateGlobalId: needsInfoFixture.candidateGlobalId,
        expectedRowVersion: 2,
      }))
    assert.equal(needsInfoPromoted.promotionStatus, 'promoted')
    assert.deepEqual(needsInfoPromoted.remainingBlockerCodes, [])
    assert.match(
      needsInfoPromoted.canonicalOrderGlobalId,
      /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u,
    )
    const needsInfoState = await pool.query(
      `SELECT candidate.customer_resolution_state,
              candidate.delivery_resolution_state,
              candidate.ship_to_snapshot_state,
              candidate.workflow_state,
              customer.reference_code AS customer_global_id,
              line.mapping_state, line.price_resolution_state,
              line.packaging_state,
              line.packaging_source,
              line.packaging_weight_source,
              line.weight_grams,
              line.length_mm,
              line.width_mm,
              line.height_mm,
              line.pack_profile_package_level,
              line.pack_profile_base_each_quantity,
              product.reference_code AS product_global_id,
              mapping.global_id AS pack_mapping_global_id,
              version.global_id AS pack_version_global_id,
              (line.package_profile_id IS NULL) AS legacy_override_cleared,
              (extract(microseconds FROM
                candidate.provider_requested_delivery_at)::bigint % 1000
              )::integer AS provider_submillisecond,
              (candidate.requested_delivery_at =
                candidate.provider_requested_delivery_at
              ) AS exact_provider_delivery,
              (SELECT count(*)::integer FROM crm_organizations scoped
               WHERE scoped.pipeline_id = $2::uuid
                 AND scoped.relationship_type = 'customer') AS customers,
              (SELECT count(*)::integer FROM crm_products scoped
               WHERE scoped.pipeline_id = $2::uuid) AS products,
              (SELECT count(*)::integer
               FROM operations_commerce_external_effect_intents effect
               WHERE effect.organization_id = $1::uuid) AS effects
       FROM operations_commerce_order_candidates candidate
       JOIN crm_organizations customer
         ON customer.pipeline_id = candidate.pipeline_id
        AND customer.id = candidate.customer_id
       JOIN operations_commerce_order_candidate_lines line
         ON line.organization_id = candidate.organization_id
        AND line.order_candidate_id = candidate.id
       JOIN crm_products product
         ON product.pipeline_id = line.pipeline_id
        AND product.id = line.product_id
       JOIN operations_commerce_variant_pack_mappings mapping
         ON mapping.organization_id = line.organization_id
        AND mapping.id = line.commerce_variant_pack_mapping_id
       JOIN operations_product_pack_profile_versions version
         ON version.organization_id = line.organization_id
        AND version.id = line.pack_profile_version_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.pipeline_id = $2::uuid
         AND candidate.id = $3::uuid`,
      [
        needsInfoFixture.organization,
        needsInfoFixture.pipeline,
        needsInfoFixture.candidate,
      ],
    )
    assert.deepEqual(plain(needsInfoState.rows[0]), {
      customer_resolution_state: 'resolved',
      delivery_resolution_state: 'provider',
      ship_to_snapshot_state: 'confirmed',
      workflow_state: 'promoted',
      customer_global_id: needsInfoFixture.customerGlobalId,
      mapping_state: 'resolved',
      price_resolution_state: 'provider',
      packaging_state: 'resolved',
      packaging_source: 'variant_pack_mapping',
      packaging_weight_source: 'profile_version',
      weight_grams: 907,
      length_mm: 254,
      width_mm: 203,
      height_mm: 152,
      pack_profile_package_level: 'each',
      pack_profile_base_each_quantity: 1,
      product_global_id: needsInfoFixture.productGlobalId,
      pack_mapping_global_id: needsInfoFixture.packMappingGlobalId,
      pack_version_global_id: needsInfoFixture.packVersionGlobalId,
      legacy_override_cleared: true,
      provider_submillisecond: 456,
      exact_provider_delivery: true,
      customers: 1,
      products: 1,
      effects: 0,
    })

    await seedSearchBoundaryCandidates(pool, primary)
    const boundaryCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid`,
      [primary.organization],
    )
    assert.ok(boundaryCount.rows[0].count > 1000)
    const pagedBoundary = []
    let boundaryCursor = null
    let firstBoundaryCursor = null
    let boundaryPages = 0
    do {
      const page = plain(await persistence
        .readCommerceOrderWorkbenchPageFromPostgres({
          organizationId: primary.organization,
          cursor: boundaryCursor,
          pageSize: 100,
        }))
      boundaryPages += 1
      assert.equal(page.page.total, boundaryCount.rows[0].count)
      assert.equal(page.page.returned, page.orders.length)
      assert.equal(page.page.pageSize, 100)
      assert.equal(page.page.complete, page.page.nextCursor === null)
      assert.equal(page.page.truncated, page.page.nextCursor !== null)
      pagedBoundary.push(...page.orders)
      boundaryCursor = page.page.nextCursor
      if (boundaryPages === 1) firstBoundaryCursor = boundaryCursor
    } while (boundaryCursor)
    assert.ok(boundaryPages > 10)
    assert.equal(pagedBoundary.length, boundaryCount.rows[0].count)
    assert.equal(
      new Set(pagedBoundary.map((order) => order.candidateGlobalId)).size,
      boundaryCount.rows[0].count,
      'keyset pages must include each current provider order exactly once',
    )
    assert.ok(firstBoundaryCursor)
    const yearZeroCursorPayload = JSON.parse(
      Buffer.from(firstBoundaryCursor, 'base64url').toString('utf8'),
    )
    yearZeroCursorPayload.sortValue = '0000-01-01T00:00:00.000Z'
    const yearZeroCursor = Buffer.from(
      JSON.stringify(yearZeroCursorPayload),
      'utf8',
    ).toString('base64url')
    await expectWorkbenchError(
      () => persistence.readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: primary.organization,
        cursor: yearZeroCursor,
        pageSize: 100,
      }),
      'OPERATIONS_PAGE_CURSOR_INVALID',
      400,
    )
    const orderNumberSorted = []
    let orderNumberCursor = null
    do {
      const page = plain(await persistence
        .readCommerceOrderWorkbenchPageFromPostgres({
          organizationId: primary.organization,
          sort: 'order_number',
          direction: 'asc',
          cursor: orderNumberCursor,
          pageSize: 250,
        }))
      orderNumberSorted.push(...page.orders)
      orderNumberCursor = page.page.nextCursor
    } while (orderNumberCursor)
    const expectedOrderNumberSort = await pool.query(
      `SELECT candidate.global_id
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = $1::uuid
         AND candidate.canonical_order_id IS NULL
         AND candidate.workflow_state IN ('held', 'resolving', 'ready')
         AND candidate.expires_at > now()
       ORDER BY lower(candidate.order_number_snapshot) ASC,
                candidate.id ASC`,
      [primary.organization],
    )
    assert.deepEqual(
      orderNumberSorted.map((order) => order.candidateGlobalId),
      expectedOrderNumberSort.rows.map((row) => row.global_id),
      'order-number keyset pages must use the selected sort tuple exactly once',
    )
    const missingCustomerSorted = []
    let missingCustomerCursor = null
    do {
      const page = plain(await persistence
        .readCommerceOrderWorkbenchPageFromPostgres({
          organizationId: primary.organization,
          sort: 'customer',
          direction: 'asc',
          cursor: missingCustomerCursor,
          pageSize: 250,
        }))
      missingCustomerSorted.push(...page.orders)
      missingCustomerCursor = page.page.nextCursor
    } while (missingCustomerCursor)
    assert.equal(
      missingCustomerSorted.length,
      boundaryCount.rows[0].count,
      'empty customer sort keys must remain valid across every keyset page',
    )
    assert.equal(
      new Set(missingCustomerSorted.map((order) => order.candidateGlobalId)).size,
      boundaryCount.rows[0].count,
      'customer sorting must not skip orders with missing customer names',
    )
    const longCustomerId = randomUUID()
    await pool.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, source_key, name, source_payload, source_hash,
         identity_key, relationship_type, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, '{}'::jsonb, $5,
         $6, 'customer', $7, $7
       )`,
      [
        longCustomerId,
        primary.pipeline,
        'workbench-long-cursor-customer',
        '客'.repeat(500),
        '9'.repeat(64),
        'customer:workbench-long-cursor',
        actorEmail,
      ],
    )
    await pool.query(
      `UPDATE operations_commerce_order_candidates
       SET customer_resolution_state = 'resolved',
           customer_match_method = 'exact_name', customer_id = $2::uuid,
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND external_order_id LIKE 'gid://shopify/Order/boundary-%'`,
      [primary.organization, longCustomerId],
    )
    const longCustomerFirstPage = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: primary.organization,
        search: '#BOUNDARY-',
        sort: 'customer',
        direction: 'asc',
        pageSize: 1,
      }))
    assert.ok(longCustomerFirstPage.page.nextCursor)
    assert.ok(
      longCustomerFirstPage.page.nextCursor.length > 2000,
      'multibyte customer evidence must exceed the former cursor envelope',
    )
    assert.ok(longCustomerFirstPage.page.nextCursor.length <= 4096)
    const longCustomerSecondPage = plain(await persistence
      .readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: primary.organization,
        search: '#BOUNDARY-',
        sort: 'customer',
        direction: 'asc',
        cursor: longCustomerFirstPage.page.nextCursor,
        pageSize: 1,
      }))
    assert.equal(longCustomerSecondPage.orders.length, 1)
    assert.notEqual(
      longCustomerSecondPage.orders[0].candidateGlobalId,
      longCustomerFirstPage.orders[0].candidateGlobalId,
    )
    const nulCustomerCursorPayload = JSON.parse(
      Buffer.from(
        longCustomerFirstPage.page.nextCursor,
        'base64url',
      ).toString('utf8'),
    )
    nulCustomerCursorPayload.sortValue = 'forged\u0000customer'
    const nulCustomerCursor = Buffer.from(
      JSON.stringify(nulCustomerCursorPayload),
      'utf8',
    ).toString('base64url')
    await expectWorkbenchError(
      () => persistence.readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: primary.organization,
        search: '#BOUNDARY-',
        sort: 'customer',
        direction: 'asc',
        cursor: nulCustomerCursor,
        pageSize: 1,
      }),
      'OPERATIONS_PAGE_CURSOR_INVALID',
      400,
    )
    await pool.query(
      `UPDATE operations_commerce_order_candidates
       SET customer_resolution_state = 'unresolved',
           customer_match_method = NULL, customer_id = NULL,
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND external_order_id LIKE 'gid://shopify/Order/boundary-%'`,
      [primary.organization],
    )
    await pool.query(
      `DELETE FROM crm_organizations
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [primary.pipeline, longCustomerId],
    )
    await expectWorkbenchError(
      () => persistence.readCommerceOrderWorkbenchPageFromPostgres({
        organizationId: primary.organization,
        search: 'different query',
        cursor: firstBoundaryCursor,
        pageSize: 100,
      }),
      'OPERATIONS_PAGE_CURSOR_INVALID',
      400,
    )
    for (const changedScope of [
      { sort: 'order_number' },
      { direction: 'asc' },
      { provider: 'shopify' },
      { tracking: 'missing' },
      { updatedAfter: '2026-09-01T00:00:00.000Z' },
    ]) {
      await expectWorkbenchError(
        () => persistence.readCommerceOrderWorkbenchPageFromPostgres({
          organizationId: primary.organization,
          cursor: firstBoundaryCursor,
          pageSize: 100,
          ...changedScope,
        }),
        'OPERATIONS_PAGE_CURSOR_INVALID',
        400,
      )
    }
    const unfilteredBoundary = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
      }))
    assert.equal(
      unfilteredBoundary.length,
      boundaryCount.rows[0].count,
      'the bounded Orders pane window must include the current provider set above the legacy 200-row cap',
    )
    assert.ok(
      unfilteredBoundary.some((order) => (
        order.orderNumber === '#NeedleBeyondLimit'
      )),
      'a current provider order beyond the legacy cap must remain visible',
    )
    const searchedBoundary = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        search: 'needlebeyondlimit',
      }))
    assert.equal(searchedBoundary.length, 1)
    assert.equal(searchedBoundary[0].orderNumber, '#NeedleBeyondLimit')
    const escapedWildcard = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        search: '%',
      }))
    assert.deepEqual(escapedWildcard, [], 'search wildcards are literal')

    const partialKey = 'workbench-partial-0001'
    const partial = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: partialKey,
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Vendor Receiving' },
      }))
    assert.equal(partial.rowVersion, 1)
    assert.equal(partial.readiness, 'incomplete')
    assert.equal(partial.syncStatus, 'local_only')
    assert.equal(partial.providerWrites, 0)
    assert.equal(partial.providerWriteIntentCreated, false)
    assert.equal(partial.replayed, false)
    assert.equal(partial.promotionStatus, 'not_ready')
    assert.equal(partial.canonicalOrderGlobalId, null)
    assert.deepEqual(
      await candidateSnapshot(pool, primary),
      providerBefore,
      'a partial local address must not mutate the provider candidate',
    )

    const encryptedBeforeCorruption = await pool.query(
      `SELECT ship_to_ciphertext
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid`,
      [primary.organization],
    )
    assert.equal(encryptedBeforeCorruption.rowCount, 1)
    const originalCiphertext = encryptedBeforeCorruption.rows[0]
      .ship_to_ciphertext
    await pool.query(
      `UPDATE operations_commerce_order_workbench
       SET ship_to_ciphertext = set_byte(
         ship_to_ciphertext,
         0,
         (get_byte(ship_to_ciphertext, 0) + 1) % 256
       )
       WHERE organization_id = $1::uuid`,
      [primary.organization],
    )
    const beforeProtectedFailures = await stateCounts(pool, primary)
    await expectWorkbenchError(
      () => persistence.readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        candidateGlobalId: primary.candidateGlobalId,
      }),
      'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
      500,
    )
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-corrupt-protected-0002',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 1,
        changes: { line1: 'Must not commit' },
      }),
      'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
      500,
    )
    assert.deepEqual(
      await stateCounts(pool, primary),
      beforeProtectedFailures,
      'protected-data failure must roll back its command receipt',
    )
    await pool.query(
      `UPDATE operations_commerce_order_workbench
       SET ship_to_ciphertext = $2
       WHERE organization_id = $1::uuid`,
      [primary.organization, originalCiphertext],
    )
    const correctEncryptionKey =
      process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
      'commerce-order-workbench-wrong-key-material-000000000001'
    try {
      await expectWorkbenchError(
        () => persistence.readCommerceOrderWorkbenchFromPostgres({
          organizationId: primary.organization,
          candidateGlobalId: primary.candidateGlobalId,
        }),
        'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
        500,
      )
      await expectWorkbenchError(
        () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
          organizationId: primary.organization,
          actorEmail,
          idempotencyKey: 'workbench-wrong-key-0003',
          candidateGlobalId: primary.candidateGlobalId,
          expectedRowVersion: 1,
          changes: { line1: 'Must not commit' },
        }),
        'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
        500,
      )
    } finally {
      process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = correctEncryptionKey
    }
    assert.deepEqual(
      await stateCounts(pool, primary),
      beforeProtectedFailures,
      'wrong-key failure must roll back its command receipt',
    )

    const empty = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-empty-0002',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 1,
        changes: { name: null },
      }))
    assert.equal(empty.rowVersion, 2)
    assert.equal(empty.readiness, 'missing')

    const incomplete = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-incomplete-0003',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 2,
        changes: {
          name: 'Vendor Receiving',
          line1: '10 Example Way',
          city: 'Charlotte',
          country: 'US',
        },
      }))
    assert.equal(incomplete.rowVersion, 3)
    assert.equal(incomplete.readiness, 'incomplete')
    assert.deepEqual(
      incomplete.issues.map((issue) => issue.field),
      ['region', 'postalCode'],
    )

    const readyInput = {
      organizationId: primary.organization,
      actorEmail,
      idempotencyKey: 'workbench-ready-0004',
      candidateGlobalId: primary.candidateGlobalId,
      expectedRowVersion: 3,
      changes: { region: 'NC', postalCode: '28202' },
    }
    const ready = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres(readyInput))
    assert.equal(ready.rowVersion, 4)
    assert.equal(ready.readiness, 'carrier_ready')
    assert.deepEqual(ready.issues, [])
    assert.equal(ready.providerWrites, 0)
    assert.equal(ready.providerWriteIntentCreated, false)
    assert.equal(ready.promotionStatus, 'needs_info')
    assert.equal(ready.canonicalOrderGlobalId, null)
    assert.deepEqual(
      ready.remainingBlockerCodes,
      [],
      'Save must not run provider-candidate preflight as a hidden handoff',
    )
    const addressConfirmed = await candidateSnapshot(pool, primary)
    assert.equal(
      addressConfirmed.ship_to_snapshot_state,
      'missing',
      'unrelated blockers must leave the provider refresh base untouched',
    )

    const acceptPreparation = {
      organizationId: acceptFixture.organization,
      actorEmail,
      idempotencyKey: 'workbench-accept-preparation-0001',
      candidateGlobalId: acceptFixture.candidateGlobalId,
      expectedRowVersion: 0,
      changes: {
        name: 'Vendor Paperwork Desk',
        line1: '22 Market Street',
        city: 'Charlotte',
        region: 'NC',
        postalCode: '28202',
        country: 'US',
      },
    }
    let saveTriedToHandoff = false
    const preparedForAccept = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        ...acceptPreparation,
        afterLocalSaveBeforeHandoff() {
          saveTriedToHandoff = true
        },
      }))
    assert.equal(saveTriedToHandoff, false)
    assert.equal(preparedForAccept.promotionStatus, 'needs_info')
    assert.equal(preparedForAccept.canonicalOrderGlobalId, null)
    const [unchangedReadyDraft] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: acceptFixture.organization,
        candidateGlobalId: acceptFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(unchangedReadyDraft.rowVersion, 1)
    assert.equal(unchangedReadyDraft.needsInfo, false)
    assert.equal(unchangedReadyDraft.shipTo.readiness, 'carrier_ready')
    assert.equal(unchangedReadyDraft.lines[0].unitMultiplier, 1)
    assert.equal(unchangedReadyDraft.lines[0].packageStatus, 'unresolved')
    assert.deepEqual(unchangedReadyDraft.lines[0].blockerCodes, [])
    const acceptInput = {
      organizationId: acceptFixture.organization,
      actorEmail,
      idempotencyKey: 'workbench-explicit-accept-0002',
      candidateGlobalId: acceptFixture.candidateGlobalId,
      expectedRowVersion: 1,
    }
    const explicitlyAccepted = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres(acceptInput))
    assert.equal(explicitlyAccepted.promotionStatus, 'promoted')
    assert.match(
      explicitlyAccepted.canonicalOrderGlobalId,
      /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u,
    )
    assert.deepEqual(explicitlyAccepted.changedFields, [])
    assert.equal(explicitlyAccepted.providerWrites, 0)
    assert.equal(explicitlyAccepted.providerWriteIntentCreated, false)
    const explicitlyAcceptedReplay = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres(acceptInput))
    assert.equal(explicitlyAcceptedReplay.replayed, true)
    assert.equal(
      explicitlyAcceptedReplay.canonicalOrderGlobalId,
      explicitlyAccepted.canonicalOrderGlobalId,
    )
    const acceptedCanonicalCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3`,
      [
        acceptFixture.organization,
        acceptFixture.integration,
        `gid://shopify/Order/${acceptFixture.candidateGlobalId.slice(-7)}`,
      ],
    )
    assert.equal(acceptedCanonicalCount.rows[0].count, 1)
    const acceptedUnitCartonization = await pool.query(
      `SELECT candidate_line.packaging_state,
              canonical_line.weight_grams,
              canonical_line.dimensions_mm
       FROM operations_commerce_order_candidates candidate
       JOIN operations_commerce_order_candidate_lines candidate_line
         ON candidate_line.organization_id = candidate.organization_id
        AND candidate_line.order_candidate_id = candidate.id
       JOIN operations_order_lines canonical_line
         ON canonical_line.organization_id = candidate_line.organization_id
        AND canonical_line.id = candidate_line.canonical_order_line_id
       WHERE candidate.organization_id = $1::uuid
         AND candidate.id = $2::uuid`,
      [acceptFixture.organization, acceptFixture.candidate],
    )
    assert.deepEqual(plain(acceptedUnitCartonization.rows[0]), {
      packaging_state: 'not_required',
      weight_grams: 0,
      dimensions_mm: {
        length: 1,
        width: 1,
        height: 1,
        source: 'cartonization_pending',
      },
    })

    const nonShippingBefore = await candidateSnapshot(pool, nonShippingFixture)
    assert.equal(nonShippingBefore.ship_to_snapshot_state, 'missing')
    const [nonShippingDetailed] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: nonShippingFixture.organization,
        candidateGlobalId: nonShippingFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(nonShippingDetailed.shipTo.readiness, 'missing')
    assert.equal(nonShippingDetailed.customer.selectedCustomerGlobalId,
      nonShippingFixture.customerGlobalId)
    assert.equal(nonShippingDetailed.lines.length, 1)
    assert.equal(nonShippingDetailed.lines[0].requiresShipping, false)
    assert.equal(nonShippingDetailed.lines[0].productGlobalId,
      nonShippingFixture.productGlobalId)
    assert.equal(nonShippingDetailed.lines[0].packageProfileGlobalId, null)
    assert.equal(nonShippingDetailed.delivery.status, 'not_required')
    assert.equal(nonShippingDetailed.delivery.draftDeliveryAt, null)
    const nonShippingAccepted = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres({
        organizationId: nonShippingFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-non-shipping-accept-0001',
        candidateGlobalId: nonShippingFixture.candidateGlobalId,
        expectedRowVersion: 0,
      }))
    assert.equal(nonShippingAccepted.promotionStatus, 'promoted')
    assert.equal(nonShippingAccepted.readiness, 'missing')
    assert.match(
      nonShippingAccepted.canonicalOrderGlobalId,
      /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u,
    )
    const nonShippingAfter = await candidateSnapshot(pool, nonShippingFixture)
    assert.equal(
      nonShippingAfter.ship_to_snapshot_state,
      'missing',
      'Accept must not fabricate or confirm an address for a non-shipping order',
    )
    assert.equal(nonShippingAfter.ship_to_ciphertext, null)
    const nonShippingDelivery = await pool.query(
      `SELECT delivery_resolution_state, requested_delivery_at
       FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [nonShippingFixture.organization, nonShippingFixture.candidate],
    )
    assert.deepEqual(plain(nonShippingDelivery.rows[0]), {
      delivery_resolution_state: 'not_required',
      requested_delivery_at: null,
    })

    const [refreshDetailed] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: refreshFixture.organization,
        candidateGlobalId: refreshFixture.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    const refreshDraft = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: refreshFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-line-draft-0001',
        candidateGlobalId: refreshFixture.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Bakery Receiving' },
        resolutionDraft: {
          customerGlobalId: refreshFixture.customerGlobalId,
          requestedDeliveryAt:
            refreshDetailed.delivery.providerRequestedDeliveryAt,
          lines: [{
            lineGlobalId: refreshFixture.lineGlobalId,
            productGlobalId: refreshFixture.productGlobalId,
            unitPriceMinor: 1250,
            currency: 'USD',
            packageProfileGlobalId:
              refreshFixture.packageProfileGlobalId,
          }],
        },
      }))
    assert.equal(refreshDraft.rowVersion, 1)
    const providerExternalLineId = (
      `gid://shopify/LineItem/${refreshFixture.lineGlobalId.slice(-7)}`
    )
    const stableProviderDelivery = '2026-09-01T16:30:00.456Z'
    const stableLineRevision = await seedProviderLineRevision(
      pool,
      refreshFixture,
      {
        suffix: '0009710',
        sourceCharacter: '7',
        order: 1,
        externalLineId: providerExternalLineId,
        providerRequestedDeliveryAt: stableProviderDelivery,
      },
    )
    const lineRebased = plain(await persistence
      .rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: refreshFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-line-rebase-0002',
        candidateGlobalId: refreshFixture.candidateGlobalId,
        expectedRowVersion: 1,
      }))
    assert.equal(lineRebased.candidateGlobalId, stableLineRevision.candidateGlobalId)
    assert.deepEqual(lineRebased.preservedLineDrafts, [{
      previousLineGlobalId: refreshFixture.lineGlobalId,
      lineGlobalId: stableLineRevision.lineGlobalId,
      externalLineId: providerExternalLineId,
    }])
    const [stableLineOrder] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: refreshFixture.organization,
        candidateGlobalId: stableLineRevision.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(stableLineOrder.lines[0].globalId, stableLineRevision.lineGlobalId)
    assert.equal(
      stableLineOrder.lines[0].productGlobalId,
      refreshFixture.productGlobalId,
    )
    assert.equal(stableLineOrder.lines[0].unitPriceMinor, 1250)
    assert.equal(
      stableLineOrder.lines[0].packageProfileGlobalId,
      refreshFixture.packageProfileGlobalId,
    )
    assert.equal(
      stableLineOrder.delivery.draftDeliveryAt,
      stableProviderDelivery,
      'provider-only requested-delivery changes must be adopted on refresh',
    )

    const localRequestedDelivery = '2026-09-02T17:45:00.789Z'
    const locallyRescheduled = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: refreshFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-delivery-local-0003',
        candidateGlobalId: stableLineRevision.candidateGlobalId,
        expectedRowVersion: 2,
        changes: {},
        resolutionDraft: {
          customerGlobalId: refreshFixture.customerGlobalId,
          requestedDeliveryAt: localRequestedDelivery,
          lines: [{
            lineGlobalId: stableLineRevision.lineGlobalId,
            productGlobalId: refreshFixture.productGlobalId,
            unitPriceMinor: 1250,
            currency: 'USD',
            packageProfileGlobalId: refreshFixture.packageProfileGlobalId,
          }],
        },
      }))
    assert.equal(locallyRescheduled.rowVersion, 3)

    const changedProviderDelivery = '2026-09-03T18:00:00.321Z'
    const changedLineRevision = await seedProviderLineRevision(
      pool,
      refreshFixture,
      {
        suffix: '0009711',
        sourceCharacter: '8',
        order: 2,
        externalLineId: `${providerExternalLineId}-replacement`,
        providerRequestedDeliveryAt: changedProviderDelivery,
      },
    )
    let lineConflict = null
    try {
      await persistence.rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: refreshFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-line-conflict-0003',
        candidateGlobalId: stableLineRevision.candidateGlobalId,
        expectedRowVersion: 3,
      })
    } catch (error) {
      lineConflict = error
    }
    assert.equal(lineConflict?.code, 'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT')
    assert.equal(lineConflict?.status, 409)
    assert.equal(lineConflict?.details?.latestCandidateGlobalId,
      changedLineRevision.candidateGlobalId)
    assert.deepEqual(plain(lineConflict?.details?.conflicts), [{
      field: 'requestedDeliveryAt',
      localValue: localRequestedDelivery,
      providerValue: changedProviderDelivery,
    }])
    assert.deepEqual(plain(lineConflict?.details?.lineConflicts), [{
      lineGlobalId: stableLineRevision.lineGlobalId,
      externalLineId: providerExternalLineId,
      title: 'Bakery Bites Provider Box',
      sku: 'PB-BOX-12',
      reason: 'provider_line_missing',
      localDraft: {
        productGlobalId: refreshFixture.productGlobalId,
        unitPriceMinor: 1250,
        currency: 'USD',
        packageProfileGlobalId: refreshFixture.packageProfileGlobalId,
      },
    }])
    const retainedLineDraft = await pool.query(
      `SELECT candidate.global_id AS candidate_global_id,
              workbench.line_resolution_drafts,
              workbench.requested_delivery_at_draft,
              workbench.row_version::integer
       FROM operations_commerce_order_workbench workbench
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = workbench.organization_id
        AND candidate.id = workbench.candidate_id
       WHERE workbench.organization_id = $1::uuid`,
      [refreshFixture.organization],
    )
    assert.equal(
      retainedLineDraft.rows[0].candidate_global_id,
      stableLineRevision.candidateGlobalId,
    )
    assert.ok(
      retainedLineDraft.rows[0].line_resolution_drafts[
        stableLineRevision.lineGlobalId
      ],
      'a changed provider line identity must not silently discard its draft',
    )
    assert.equal(
      retainedLineDraft.rows[0].requested_delivery_at_draft.toISOString(),
      localRequestedDelivery,
      'a requested-delivery conflict must preserve the database draft',
    )
    assert.equal(retainedLineDraft.rows[0].row_version, 3)
    const reviewedLineRebase = plain(await persistence
      .rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: refreshFixture.organization,
        actorEmail,
        idempotencyKey: 'workbench-line-review-0004',
        candidateGlobalId: stableLineRevision.candidateGlobalId,
        expectedRowVersion: 3,
        expectedLatestCandidateGlobalId:
          changedLineRevision.candidateGlobalId,
        resolutions: { requestedDeliveryAt: 'local' },
        lineResolutions: {
          [stableLineRevision.lineGlobalId]: 'provider',
        },
      }))
    assert.equal(
      reviewedLineRebase.candidateGlobalId,
      changedLineRevision.candidateGlobalId,
    )
    assert.deepEqual(reviewedLineRebase.preservedLineDrafts, [])
    const reviewedLineDraft = await pool.query(
      `SELECT line_resolution_drafts
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid`,
      [refreshFixture.organization],
    )
    assert.deepEqual(reviewedLineDraft.rows[0].line_resolution_drafts, {})
    const [reviewedLineOrder] = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: refreshFixture.organization,
        candidateGlobalId: changedLineRevision.candidateGlobalId,
        includeResolutionDetails: true,
      }))
    assert.equal(
      reviewedLineOrder.delivery.draftDeliveryAt,
      localRequestedDelivery,
      'the explicit local requested-delivery choice must survive rebase',
    )

    const readyCandidateBefore = await candidateSnapshot(pool, readyFixture)
    const promotableInput = {
      organizationId: readyFixture.organization,
      actorEmail,
      idempotencyKey: 'workbench-promotable-crash-0001',
      candidateGlobalId: readyFixture.candidateGlobalId,
      expectedRowVersion: 0,
      changes: {
        name: 'Vendor Paperwork Desk',
        line1: '22 Market Street',
        city: 'Charlotte',
        region: 'NC',
        postalCode: '28202',
        country: 'US',
      },
    }
    const promotableDraft = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres(promotableInput))
    assert.equal(promotableDraft.promotionStatus, 'needs_info')
    assert.equal(promotableDraft.canonicalOrderGlobalId, null)
    assert.deepEqual(
      await candidateSnapshot(pool, readyFixture),
      readyCandidateBefore,
      'Save must remain local even when every saved field is complete',
    )
    const interruptedAcceptInput = {
      organizationId: readyFixture.organization,
      actorEmail,
      idempotencyKey: 'workbench-promotable-accept-crash-0002',
      candidateGlobalId: readyFixture.candidateGlobalId,
      expectedRowVersion: 1,
    }
    await assert.rejects(
      () => persistence.acceptCommerceOrderWorkbenchInPostgres({
        ...interruptedAcceptInput,
        afterLocalSaveBeforeHandoff() {
          throw new Error('simulated workbench handoff interruption')
        },
      }),
      /simulated workbench handoff interruption/u,
    )
    assert.deepEqual(
      await candidateSnapshot(pool, readyFixture),
      readyCandidateBefore,
      'the explicit Accept checkpoint commits before candidate handoff begins',
    )
    const interrupted = await pool.query(
      `SELECT receipt.status, receipt.result_payload,
              workbench.row_version::integer,
              workbench.canonical_order_id::text
       FROM operations_command_receipts receipt
       JOIN operations_commerce_order_workbench workbench
         ON workbench.organization_id = receipt.organization_id
        AND workbench.last_command_receipt_id = receipt.id
       WHERE receipt.organization_id = $1::uuid
         AND receipt.command_type = $2
         AND receipt.idempotency_key = $3`,
      [
        readyFixture.organization,
        commandType,
        interruptedAcceptInput.idempotencyKey,
      ],
    )
    assert.equal(interrupted.rowCount, 1)
    assert.equal(interrupted.rows[0].status, 'processing')
    assert.equal(interrupted.rows[0].row_version, 2)
    assert.equal(interrupted.rows[0].canonical_order_id, null)
    assert.equal(interrupted.rows[0].result_payload.readiness, 'carrier_ready')

    const promoted = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres(interruptedAcceptInput))
    assert.equal(promoted.promotionStatus, 'promoted')
    assert.match(promoted.canonicalOrderGlobalId, /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u)
    assert.deepEqual(promoted.remainingBlockerCodes, [])
    assert.equal(promoted.providerWrites, 0)
    assert.equal(promoted.providerWriteIntentCreated, false)
    assert.equal(promoted.replayed, false)

    const canonicalState = await pool.query(
      `SELECT
         (SELECT count(*)::integer
          FROM operations_orders
          WHERE organization_id = $1::uuid
            AND integration_account_id = $2::uuid
            AND external_order_id = $3) AS canonical_orders,
         (SELECT count(*)::integer
          FROM operations_commerce_order_candidates
          WHERE organization_id = $1::uuid
            AND id = $4::uuid
            AND workflow_state = 'promoted'
            AND canonical_order_id IS NOT NULL) AS promoted_candidates,
         (SELECT count(*)::integer
          FROM operations_commerce_order_workbench workbench
          JOIN operations_orders canonical
            ON canonical.organization_id = workbench.organization_id
           AND canonical.id = workbench.canonical_order_id
          WHERE workbench.organization_id = $1::uuid
            AND workbench.candidate_id = $4::uuid
            AND canonical.global_id = $5) AS canonical_links,
         (SELECT count(*)::integer
          FROM operations_commerce_external_effect_intents
          WHERE organization_id = $1::uuid) AS external_effect_intents`,
      [
        readyFixture.organization,
        readyFixture.integration,
        `gid://shopify/Order/${readyFixture.candidateGlobalId.slice(-7)}`,
        readyFixture.candidate,
        promoted.canonicalOrderGlobalId,
      ],
    )
    assert.deepEqual(plain(canonicalState.rows[0]), {
      canonical_orders: 1,
      promoted_candidates: 1,
      canonical_links: 1,
      external_effect_intents: 0,
    })
    assert.deepEqual(
      plain(await persistence.readCommerceOrderWorkbenchFromPostgres({
        organizationId: readyFixture.organization,
      })),
      [],
      'a canonical-linked workbench row must not duplicate the canonical Orders row',
    )
    const promotedReplay = plain(await persistence
      .acceptCommerceOrderWorkbenchInPostgres(interruptedAcceptInput))
    assert.equal(promotedReplay.replayed, true)
    assert.equal(
      promotedReplay.canonicalOrderGlobalId,
      promoted.canonicalOrderGlobalId,
    )
    const savedReplay = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres(promotableInput))
    assert.equal(savedReplay.replayed, true)
    assert.equal(savedReplay.canonicalOrderGlobalId, null)
    const canonicalCountAfterReplay = await pool.query(
      `SELECT count(*)::integer AS count
       FROM operations_orders
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_order_id = $3`,
      [
        readyFixture.organization,
        readyFixture.integration,
        `gid://shopify/Order/${readyFixture.candidateGlobalId.slice(-7)}`,
      ],
    )
    assert.equal(canonicalCountAfterReplay.rows[0].count, 1)

    const replayed = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres(readyInput))
    assert.equal(replayed.rowVersion, 4)
    assert.equal(replayed.replayed, true)

    const beforeFailures = await stateCounts(pool, primary)
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        ...readyInput,
        expectedRowVersion: 4,
        changes: { line2: 'Dock 2' },
      }),
      'OPERATIONS_IDEMPOTENCY_CONFLICT',
      409,
    )
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-stale-version-0005',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 3,
        changes: { line2: 'Dock 2' },
      }),
      'OPERATIONS_IMPORTED_ORDER_VERSION_CONFLICT',
      409,
    )
    await expectWorkbenchError(
      () => persistence.updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-wrong-tenant-0006',
        candidateGlobalId: other.candidateGlobalId,
        expectedRowVersion: 0,
        changes: { name: 'Must not cross tenant' },
      }),
      'OPERATIONS_IMPORTED_ORDER_NOT_FOUND',
      404,
    )
    assert.deepEqual(
      await stateCounts(pool, primary),
      beforeFailures,
      'failed commands must roll back receipts, audits, drafts, and effects',
    )

    const after = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        candidateGlobalId: primary.candidateGlobalId,
      }))
    assert.equal(after.length, 1)
    assert.equal(after[0].rowVersion, 4)
    assert.equal(
      after[0].needsInfo,
      false,
      'provider blocker summaries may be stale; UI eligibility uses saved facts',
    )
    assert.equal(after[0].shipTo.readiness, 'carrier_ready')
    assert.equal(after[0].shipTo.provenance, 'local')
    assert.equal(after[0].shipTo.syncStatus, 'local_only')
    assert.equal(after[0].actionAvailable, true)
    assert.deepEqual(after[0].shipTo.value, {
      name: 'Vendor Receiving',
      line1: '10 Example Way',
      line2: null,
      city: 'Charlotte',
      region: 'NC',
      postalCode: '28202',
      country: 'US',
    })

    await expireAcceptedCandidate(pool, primary)
    const retainedAfterExpiry = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        candidateGlobalId: primary.candidateGlobalId,
      }))
    assert.equal(retainedAfterExpiry.length, 1)
    assert.equal(retainedAfterExpiry[0].rowVersion, 4)
    assert.equal(retainedAfterExpiry[0].shipTo.readiness, 'carrier_ready')
    assert.equal(retainedAfterExpiry[0].providerVersionChanged, false)
    assert.equal(
      retainedAfterExpiry[0].actionAvailable,
      false,
      'expired candidate or run evidence must never appear ready to fulfill',
    )
    const expiredSave = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-expired-draft-0007',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 4,
        changes: { line2: 'Dock 2' },
      }))
    assert.equal(expiredSave.rowVersion, 5)
    assert.equal(expiredSave.readiness, 'carrier_ready')
    assert.equal(expiredSave.providerVersionChanged, false)

    await seedNewerProviderRevision(pool, primary)
    const drifted = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        candidateGlobalId: primary.candidateGlobalId,
      }))
    assert.equal(drifted.length, 1)
    assert.equal(
      drifted[0].candidateGlobalId,
      primary.candidateGlobalId,
      'durable draft keeps its accepted provider candidate identity',
    )
    assert.equal(drifted[0].rowVersion, 5)
    assert.equal(drifted[0].providerVersionChanged, true)
    assert.equal(drifted[0].shipTo.value.line2, 'Dock 2')
    const driftedSave = plain(await persistence
      .updateCommerceOrderWorkbenchShipToInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-provider-drift-0008',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 5,
        changes: { line2: 'Dock 3' },
      }))
    assert.equal(driftedSave.rowVersion, 6)
    assert.equal(driftedSave.readiness, 'carrier_ready')
    assert.equal(driftedSave.providerVersionChanged, true)

    const rebased = plain(await persistence
      .rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-provider-rebase-0009',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 6,
      }))
    assert.equal(rebased.previousCandidateGlobalId, primary.candidateGlobalId)
    assert.equal(rebased.candidateGlobalId, 'gcoc0009703')
    assert.equal(rebased.rowVersion, 7)
    assert.equal(rebased.status, 'rebased')
    assert.equal(rebased.providerWrites, 0)
    assert.equal(rebased.providerWriteIntentCreated, false)
    assert.ok(rebased.preservedLocalFields.includes('line2'))
    const rebasedOrder = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
        candidateGlobalId: rebased.candidateGlobalId,
      }))
    assert.equal(rebasedOrder.length, 1)
    assert.equal(rebasedOrder[0].providerVersionChanged, false)
    assert.equal(rebasedOrder[0].shipTo.value.line2, 'Dock 3')
    const rebaseReplay = plain(await persistence
      .rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
        organizationId: primary.organization,
        actorEmail,
        idempotencyKey: 'workbench-provider-rebase-0009',
        candidateGlobalId: primary.candidateGlobalId,
        expectedRowVersion: 6,
      }))
    assert.equal(rebaseReplay.replayed, true)
    assert.equal(rebaseReplay.rowVersion, 7)

    await expectDatabaseError(
      () => pool.query(
        `UPDATE operations_commerce_order_candidates
         SET source_hash = $3, row_version = row_version + 1
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [primary.organization, primary.candidate, 'd'.repeat(64)],
      ),
      /provider source is immutable/iu,
    )
    await expectDatabaseError(
      () => pool.query(
        `UPDATE operations_commerce_order_workbench
         SET accepted_provider_source_hash = $2
         WHERE organization_id = $1::uuid`,
        [primary.organization, 'd'.repeat(64)],
      ),
      /accepted provider binding is immutable/iu,
    )
    const providerAfter = await candidateSnapshot(pool, primary)
    assert.equal(providerAfter.source_hash, providerBefore.source_hash)
    assert.equal(providerAfter.source_revision, providerBefore.source_revision)
    assert.equal(providerAfter.ship_to_snapshot_state, 'missing')
    assert.equal(
      providerAfter.row_version,
      providerBefore.row_version,
      'draft saves and refreshes must not mutate the accepted provider candidate',
    )
    const finalCounts = await stateCounts(pool, primary)
    assert.equal(finalCounts.working_copies, 1)
    assert.equal(finalCounts.receipts, 6)
    assert.equal(finalCounts.audits, 6)
    assert.equal(finalCounts.external_effect_intents, 0)
    assert.equal(initialCounts.external_effect_intents, 0)

    const retained = await pool.query(
      `SELECT candidate_id::text, ship_to_edit_state, sync_state,
              accepted_provider_source_hash, ship_to_source_hash,
              encode(ship_to_ciphertext, 'base64') AS ciphertext,
              row_version::integer
       FROM operations_commerce_order_workbench
       WHERE organization_id = $1::uuid`,
      [primary.organization],
    )
    assert.equal(retained.rowCount, 1)
    const latestCandidate = await pool.query(
      `SELECT id::text FROM operations_commerce_order_candidates
       WHERE organization_id = $1::uuid AND global_id = 'gcoc0009703'`,
      [primary.organization],
    )
    assert.equal(retained.rows[0].candidate_id, latestCandidate.rows[0].id)
    assert.equal(retained.rows[0].ship_to_edit_state, 'local_carrier_ready')
    assert.equal(retained.rows[0].sync_state, 'local_only')
    assert.equal(retained.rows[0].accepted_provider_source_hash, 'e'.repeat(64))
    assert.equal(retained.rows[0].ship_to_source_hash, 'e'.repeat(64))
    assert.equal(retained.rows[0].row_version, 7)
    const protectedText = JSON.stringify(retained.rows[0])
    for (const secret of [
      'Vendor Receiving',
      '10 Example Way',
      'Charlotte',
      '28202',
    ]) assert.ok(!protectedText.includes(secret), `database leaked ${secret}`)

    const metadata = await pool.query(
      `SELECT coalesce(jsonb_agg(result_payload), '[]'::jsonb) AS receipts
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid AND command_type = $2`,
      [primary.organization, commandType],
    )
    const audit = await pool.query(
      `SELECT coalesce(jsonb_agg(payload), '[]'::jsonb) AS events
       FROM audit_events
       WHERE organization_id = $1::uuid
         AND event_type =
           'operations.commerce_order_workbench.ship_to_updated'`,
      [primary.organization],
    )
    const metadataText = JSON.stringify([metadata.rows[0], audit.rows[0]])
    for (const secret of [
      'Vendor Receiving',
      '10 Example Way',
      'Charlotte',
      '28202',
    ]) assert.ok(!metadataText.includes(secret), `metadata leaked ${secret}`)

    const otherState = await stateCounts(pool, other)
    assert.equal(otherState.working_copies, 0)
    assert.equal(otherState.receipts, 0)
    assert.equal(otherState.audits, 0)
    assert.equal(otherState.external_effect_intents, 0)
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-commerce-order-workbench-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=commerce_order_workbench',
      '-e', 'POSTGRES_DB=commerce_order_workbench',
      '-p', '127.0.0.1::5432',
      process.env.CLAWPILOT_DISPOSABLE_POSTGRES_IMAGE
        || 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:commerce_order_workbench@127.0.0.1:'
      + `${port}/commerce_order_workbench`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrations()
      assert.ok(
        files.includes('0307_operations_commerce_order_workbench.sql'),
        '0307 workbench migration is missing',
      )
      const workbenchMigration =
        '0307_operations_commerce_order_workbench.sql'
      const unitCartonizationMigration =
        '0321_operations_unit_item_cartonization.sql'
      const workbenchIndex = files.indexOf(workbenchMigration)
      assert.ok(workbenchIndex > 0, '0307 workbench migration is missing')
      for (const file of files.slice(0, workbenchIndex)) {
        await applyMigration(client, file)
      }
      const before = await client.query(
        `SELECT to_regclass(
           'public.operations_commerce_order_workbench'
         )::text AS table_name`,
      )
      assert.equal(before.rows[0].table_name, null)
      await applyMigration(client, workbenchMigration)
      const installed = await client.query(
        `SELECT
           to_regclass(
             'public.operations_commerce_order_workbench'
           )::text AS table_name,
           EXISTS (
             SELECT 1 FROM pg_trigger
             WHERE tgrelid =
               'public.operations_commerce_order_workbench'::regclass
               AND tgname =
                 'validate_operations_commerce_order_workbench'
               AND NOT tgisinternal
           ) AS validation_trigger,
           EXISTS (
             SELECT 1 FROM pg_constraint
             WHERE conrelid =
               'public.operations_commerce_order_workbench'::regclass
               AND conname =
                 'operations_commerce_order_workbench_ship_to_valid'
           ) AS ship_to_constraint`,
      )
      assert.equal(
        installed.rows[0].table_name,
        'operations_commerce_order_workbench',
      )
      assert.equal(installed.rows[0].validation_trigger, true)
      assert.equal(installed.rows[0].ship_to_constraint, true)
      const migrationFixture = ids('0009799')
      for (const file of files.slice(workbenchIndex + 1)) {
        if (file === unitCartonizationMigration) {
          await seedUnitPackAssociationMigrationFixture(
            client,
            migrationFixture,
          )
        }
        await applyMigration(client, file)
        if (file === unitCartonizationMigration) {
          const migratedUnitAssociation = (await client.query(
            `SELECT packaging_state, packaging_source,
                    commerce_variant_pack_mapping_id IS NOT NULL
                      AS retained_pack_mapping,
                    pack_profile_version_id IS NOT NULL
                      AS retained_pack_version,
                    blocking_codes
             FROM operations_commerce_order_candidate_lines
             WHERE organization_id = $1::uuid
               AND order_candidate_id = $2::uuid`,
            [migrationFixture.organization, migrationFixture.candidate],
          )).rows[0]
          assert.deepEqual(plain(migratedUnitAssociation), {
            packaging_state: 'not_required',
            packaging_source: 'variant_pack_mapping',
            retained_pack_mapping: true,
            retained_pack_version: true,
            blocking_codes: [],
          })
        }
      }
    } finally {
      client.release()
      await pool.end()
    }
    await verifyAcceptance(
      databaseUrl,
      ids('0009701'),
      ids('0009702'),
      ids('0009704'),
      ids('0009705'),
      ids('0009706'),
      ids('0009707'),
      ids('0009708'),
    )
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Commerce order workbench disposable-PostgreSQL acceptance passed',
  )
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
