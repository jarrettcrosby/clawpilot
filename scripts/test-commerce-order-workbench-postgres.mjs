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
    await seedReadyFacts(client, accept)
    await seedNeedsInfoFacts(client, refresh)
    await seedNonShippingReadyFacts(client, nonShipping)
  } finally {
    await client.query('SET session_replication_role = origin')
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
       FROM generate_series(1, 205) AS ordinal`,
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
    const persistence = workbenchPersistence(pool)
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
    assert.deepEqual(initial[0].shipTo.value, {
      name: null,
      line1: null,
      line2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    })
    assert.ok(
      !initial.some((row) => row.candidateGlobalId === other.candidateGlobalId),
      'tenant list must not leak another organization candidate',
    )

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
            packageProfileGlobalId:
              needsInfoFixture.packageProfileGlobalId,
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
    assert.equal(
      savedNeedsInfo.lines[0].packageProfileGlobalId,
      needsInfoFixture.packageProfileGlobalId,
    )
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
            packageProfileGlobalId:
              needsInfoFixture.packageProfileGlobalId,
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
              product.reference_code AS product_global_id,
              profile.global_id AS package_profile_global_id,
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
       JOIN operations_product_package_profiles profile
         ON profile.organization_id = line.organization_id
        AND profile.id = line.package_profile_id
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
      product_global_id: needsInfoFixture.productGlobalId,
      package_profile_global_id: needsInfoFixture.packageProfileGlobalId,
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
    assert.ok(boundaryCount.rows[0].count > 200)
    const unfilteredBoundary = plain(await persistence
      .readCommerceOrderWorkbenchFromPostgres({
        organizationId: primary.organization,
      }))
    assert.ok(
      !unfilteredBoundary.some((order) => (
        order.orderNumber === '#NeedleBeyondLimit'
      )),
      'boundary fixture must fall beyond the unfiltered result cap',
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
      for (const file of files.slice(workbenchIndex + 1)) {
        await applyMigration(client, file)
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
