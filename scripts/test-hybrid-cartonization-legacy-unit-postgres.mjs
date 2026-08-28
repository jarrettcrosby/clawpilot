#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  applyMigration,
  command,
  loadTypeScriptModule,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const migrationName =
  '0327_operations_legacy_unit_pack_compatibility.sql'
const firstPostLegacyMigration =
  '0328_operations_shopify_reversal_fixture_provider_errors.sql'
const orderUnitWeightRepairMigration =
  '0336_operations_order_unit_physical_facts.sql'
const exactLineGlobalId = 'gcol1vbvhkqodkjl'
const exactCandidateGlobalId = 'gcocq1570l31rv1l'
const exactLineSourceRevision = '2026-08-15T00:14:33.000Z'
const exactLineSourceHash =
  'bcf500459545d85e24aef8dae7d91c39e577560f008246ff317e65d061ecb4f0'
const exactCandidateSourceHash =
  'a9dca21bcac92d3dc79f3bee8fd13e798213e2bf1983a433cf2ee01108fc95b3'

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function createProcessingUnitWeightReceipt(client, fixture, marker) {
  const idempotencyKey = `legacy-unit-weight-${marker}-${randomUUID()}`
  const requestHash = hash(idempotencyKey)
  const result = await client.query(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, target_global_id
     ) VALUES (
       $1::uuid, 'operations.record_order_unit_weights', $2, $3,
       $4, 'processing', $5::uuid, $6
     ) RETURNING id::text`,
    [
      fixture.organizationId,
      idempotencyKey,
      requestHash,
      fixture.actorEmail,
      randomUUID(),
      exactCandidateGlobalId,
    ],
  )
  return { id: result.rows[0].id, requestHash }
}

async function insertFirstUnitWeightFact(
  client,
  fixture,
  receipt,
  unitWeightGrams,
  unitDimensionsMm = { length: 100, width: 100, height: 50 },
) {
  const allocated = await client.query(
    `SELECT allocate_global_reference('gouw') AS global_id`,
  )
  const globalId = allocated.rows[0].global_id
  return client.query(
    `INSERT INTO operations_order_unit_weight_facts (
       global_id, organization_id, integration_account_id, pipeline_id,
       candidate_id, candidate_row_version, order_id, order_line_id,
       planning_line_id, planning_line_global_id,
       candidate_line_id, revision_application_line_id,
       line_source_revision, line_source_hash, fact_version,
       supersedes_fact_id, unit_weight_grams,
       unit_length_mm, unit_width_mm, unit_height_mm,
       dimension_evidence_basis,
       reason, request_hash, fact_hash,
       command_receipt_id, recorded_by
     )
     SELECT $1::text, line.organization_id, line.integration_account_id,
            line.pipeline_id, line.order_candidate_id, candidate.row_version,
            candidate.canonical_order_id, line.canonical_order_line_id,
            line.id, line.global_id, line.id, NULL,
            line.source_revision, line.source_hash, 1, NULL,
            $2::integer, $7::integer, $8::integer, $9::integer,
            CASE WHEN $7::integer IS NULL THEN NULL
              ELSE 'operator_recorded_order_dimensions'
            END, $3, $4,
            encode(digest(convert_to(jsonb_build_object(
              'candidateGlobalId', candidate.global_id,
              'candidateRowVersion', candidate.row_version,
              'factGlobalId', $1::text,
              'factVersion', 1,
              'lineGlobalId', line.global_id,
              'lineSourceHash', line.source_hash,
              'lineSourceRevision', line.source_revision,
              'unitDimensionsMm', CASE
                WHEN $7::integer IS NULL THEN NULL
                ELSE jsonb_build_object(
                  'height', $9::integer,
                  'length', $7::integer,
                  'width', $8::integer
                )
              END,
              'unitWeightGrams', $2::integer
            )::text, 'UTF8'), 'sha256'), 'hex'),
            $5::uuid, $6
     FROM operations_commerce_current_planning_lines line
     JOIN operations_commerce_order_candidates candidate
       ON candidate.organization_id = line.organization_id
      AND candidate.id = line.order_candidate_id
     WHERE line.organization_id = $10::uuid
       AND line.global_id = $11
       AND candidate.global_id = $12
       AND candidate.accepted_revision_application_id IS NULL
     RETURNING id::text, global_id, fact_version, unit_weight_grams,
               unit_length_mm, unit_width_mm, unit_height_mm,
               request_hash, fact_hash,
               candidate_line_id::text, revision_application_line_id::text`,
    [
      globalId,
      unitWeightGrams,
      'Measured for null-safe unit-weight trigger regression',
      receipt.requestHash,
      receipt.id,
      fixture.actorEmail,
      unitDimensionsMm?.length ?? null,
      unitDimensionsMm?.width ?? null,
      unitDimensionsMm?.height ?? null,
      fixture.organizationId,
      exactLineGlobalId,
      exactCandidateGlobalId,
    ],
  )
}

function runtimeModules() {
  const hybrid = loadTypeScriptModule(
    'app_src/lib/operations/hybridCartonization.ts',
  )
  const persistence = loadTypeScriptModule(
    'app_src/lib/persistence/hybridCartonization.ts',
    {
      '@/lib/integrations/shopifyCheckoutChannelEligibility': {
        isShopifyRatingCheckoutChannelEligible: () => true,
      },
      '@/lib/persistence/postgres': {
        getPostgresPool() {
          throw new Error('The focused test calls the exported row mapper')
        },
      },
      '@/lib/persistence/shopifyCheckoutRating': {
        shopifyCheckoutRateLineageIsRequired: () => false,
        shopifyCheckoutRatingHash: (value) => hash(JSON.stringify(value)),
      },
    },
  )
  const unitMaterial = loadTypeScriptModule(
    'app_src/lib/operations/operationalUnitMaterialCartonization.ts',
  )
  return { hybrid, persistence, unitMaterial }
}

async function seedLegacyFixture(pool) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const actorEmail = `legacy-unit-${suffix}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Legacy unit cartonization test')`,
    [actorEmail],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id::text`,
    [`Legacy unit compatibility ${suffix}`, actorEmail],
  )
  const organizationId = organization.rows[0].id
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ('Legacy unit pipeline', $1, true, $2::uuid)
     RETURNING id::text`,
    [actorEmail, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key,
       workspace_organization_id, relationship_type, source_hash,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'Snowdevil', $2,
       $3::uuid, 'customer', $4, $5, $5
     ) RETURNING id::text`,
    [
      pipelineId,
      `legacy-unit-customer-${suffix}`,
      organizationId,
      hash(`legacy-unit-customer-${suffix}`),
      actorEmail,
    ],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, 'The 3p Fulfilled Snowboard', 'sku-hosted-1',
       'Good', 699.95, 300.00, 'USD', $3, $4, $4
     ) RETURNING id::text, reference_code`,
    [
      pipelineId,
      `legacy-unit-product-${suffix}`,
      hash(`legacy-unit-product-${suffix}`),
      actorEmail,
    ],
  )
  const productId = product.rows[0].id
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       $1::uuid, 'shopify', 'commerce', 'sandbox',
       'Test Pro Bakery Bites', 'active',
       jsonb_build_object('shopDomain', $2::text),
       $3, 1, $4, $4
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      `legacy-unit-${suffix}.myshopify.com`,
      `gid://shopify/Shop/${BigInt(`0x${suffix}`).toString()}`,
      actorEmail,
    ],
  )
  const accountId = account.rows[0].id
  const mapping = await pool.query(
    `INSERT INTO operations_product_mappings (
       organization_id, integration_account_id, pipeline_id,
       product_id, channel_sku, external_product_id,
       external_variant_id, external_inventory_item_id,
       mapping_method, mapping_source_revision, active, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'sku-hosted-1', 'gid://shopify/Product/10054534529271',
       'gid://shopify/ProductVariant/51028106576119',
       'gid://shopify/InventoryItem/51028106576119',
       'exact_variant', $5, true, $6
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      accountId,
      pipelineId,
      productId,
      exactLineSourceRevision,
      actorEmail,
    ],
  )
  const productMappingId = mapping.rows[0].id
  const channelSourceRevision = '2026-08-15T00:49:42.000Z'
  const channelSourceHash =
    '1384325941fd1978da2c9cf3978f598166e469cdf39f849354b087dbc568914d'
  await pool.query(
    `INSERT INTO operations_product_channel_states (
       organization_id, integration_account_id, pipeline_id, provider,
       external_product_id, external_variant_id,
       external_inventory_item_id, product_id, product_mapping_id,
       provider_product_title, provider_variant_title, provider_sku,
       provider_status_raw, normalized_status, provider_active,
       requires_shipping, weight_grams, observed_at, source_revision,
       source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'shopify',
       'gid://shopify/Product/10054534529271',
       'gid://shopify/ProductVariant/51028106576119',
       'gid://shopify/InventoryItem/51028106576119',
       $4::uuid, $5::uuid,
       'The 3p Fulfilled Snowboard', NULL, 'sku-hosted-1',
       'ACTIVE', 'active', true, true, NULL, now(), $6, $7, $8, $8
     )`,
    [
      organizationId,
      accountId,
      pipelineId,
      productId,
      productMappingId,
      channelSourceRevision,
      channelSourceHash,
      actorEmail,
    ],
  )
  const legacyProfile = await pool.query(
    `INSERT INTO operations_product_package_profiles (
       organization_id, pipeline_id, product_id,
       profile_key, profile_name, package_type, unit_of_measure,
       units_per_package, measurement_system, length_mm, width_mm,
       height_mm, weight_grams, is_default, active, source,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       'approved-each', 'Approved each', 'each', 'each',
       1, 'imperial', 1524, 254, 254, 2268,
       true, true, 'manual', $4, $4
     ) RETURNING id::text`,
    [organizationId, pipelineId, productId, actorEmail],
  )
  const order = await pool.query(
    `INSERT INTO operations_orders (
       organization_id, pipeline_id, customer_id, integration_account_id,
       source_provider, external_order_id, order_number, status, currency,
       merchandise_total_minor, ship_to, source_payload,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'shopify', $5, '#1001', 'imported', 'USD', 69995,
       $6::jsonb, '{}'::jsonb, $7, $7
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      pipelineId,
      customer.rows[0].id,
      accountId,
      `gid://shopify/Order/${BigInt(`0x${suffix}`).toString()}`,
      JSON.stringify({
        name: 'Snowdevil',
        line1: '35 Saxony Drive',
        city: 'Trumbull',
        region: 'CT',
        postalCode: '06611',
        country: 'US',
      }),
      actorEmail,
    ],
  )
  const canonicalLine = await pool.query(
    `INSERT INTO operations_order_lines (
       organization_id, order_id, pipeline_id, product_id,
       external_line_id, channel_sku, description, quantity,
       unit_price_minor, weight_grams, dimensions_mm
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'gid://shopify/LineItem/19786681221367', 'sku-hosted-1',
       'The 3p Fulfilled Snowboard', 1, 69995, 2268,
       '{"length":1524,"width":254,"height":254}'::jsonb
     ) RETURNING id::text`,
    [organizationId, order.rows[0].id, pipelineId, productId],
  )
  const promotionReceipt = await pool.query(
    `INSERT INTO operations_command_receipts (
       organization_id, command_type, idempotency_key, request_hash,
       actor_email, status, correlation_id, result_global_id,
       result_payload, completed_at
     ) VALUES (
       $1::uuid, 'promote_commerce_order', $2, $3,
       $4, 'succeeded', $5::uuid, $6, '{}'::jsonb, now()
     ) RETURNING id::text`,
    [
      organizationId,
      `legacy-unit-promote-${suffix}`,
      hash(`legacy-unit-promote-${suffix}`),
      actorEmail,
      randomUUID(),
      order.rows[0].global_id,
    ],
  )
  const run = await pool.query(
    `INSERT INTO operations_commerce_intake_runs (
       organization_id, integration_account_id, pipeline_id,
       provider, resource, credential_version, provider_api_version,
       normalizer_version, idempotency_key, request_hash, window_end,
       workflow_state, records_seen, records_staged, records_promoted,
       canonical_orders_created, completed_at, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       'shopify', 'orders', 1, '2026-07', 'legacy-unit-test-v1',
       $4, $5, now(), 'promoted', 1, 1, 1, 1, now(), $6, $6
     ) RETURNING id::text, global_id`,
    [
      organizationId,
      accountId,
      pipelineId,
      `legacy-unit-run-${suffix}`,
      hash(`legacy-unit-run-${suffix}`),
      actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO crm_reference_number_registry (number_value)
     VALUES ($1), ($2)
     ON CONFLICT (number_value) DO NOTHING`,
    [
      exactCandidateGlobalId.slice('gcoc'.length),
      exactLineGlobalId.slice('gcol'.length),
    ],
  )
  await pool.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, entity_type
     ) VALUES
       ($1, 'gcoc', $1, 'active', 'operations.commerce_order_candidate'),
       ($2, 'gcol', $2, 'active', 'operations.commerce_order_candidate_line')`,
    [exactCandidateGlobalId, exactLineGlobalId],
  )
  const candidate = await pool.query(
    `INSERT INTO operations_commerce_order_candidates (
       global_id, organization_id, integration_account_id, pipeline_id,
       run_id, provider, external_order_id, order_number_snapshot,
       source_channel, provider_order_status_raw,
       provider_financial_status_raw, provider_fulfillment_status_raw,
       provider_return_status_raw, normalized_order_status,
       normalized_payment_status, normalized_fulfillment_status,
       normalized_return_status, test_order, requires_shipping,
       currency_code, subtotal_minor, discount_minor,
       brand_discount_minor, shipping_minor, tax_minor,
       other_adjustment_minor, total_minor, party_kind,
       party_snapshot_state, customer_resolution_state,
       customer_match_method, customer_id, ship_to_snapshot_state,
       ship_to_snapshot_source, ship_to_snapshot_ciphertext,
       ship_to_snapshot_iv, ship_to_snapshot_tag, ship_to_snapshot_hash,
       ship_to_snapshot_encryption_version, delivery_resolution_state,
       observed_at, source_revision, source_hash,
       provider_api_version, normalizer_version, workflow_state,
       blocking_codes, canonical_order_id, promotion_command_receipt_id,
       promotion_idempotency_key, promotion_request_hash, promoted_at,
       row_version, created_by, updated_by, expires_at
     ) VALUES (
       $1, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, 'shopify', $6, '#1001', 'online_store',
       'open', 'paid', 'unfulfilled', 'none',
       'open', 'paid', 'unfulfilled', 'none', false, true,
       'USD', 69995, 0, 0, 0, 0, 0, 69995, 'consumer',
       'missing', 'resolved', 'exact_email', $7::uuid,
       'confirmed', 'manual', $8, $9, $10, $11, 1, 'not_supplied',
       now(), $12, $13, '2026-07', 'legacy-unit-test-v1',
       'promoted', '{}'::text[], $14::uuid, $15::uuid,
       $16, $17, now(), 10, $18, $18, now() + interval '7 days'
     ) RETURNING id::text, global_id`,
    [
      exactCandidateGlobalId,
      organizationId,
      accountId,
      pipelineId,
      run.rows[0].id,
      `gid://shopify/Order/${BigInt(`0x${suffix}`).toString()}`,
      customer.rows[0].id,
      Buffer.from('legacy unit confirmed ship-to'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      hash(`legacy-unit-ship-to-${suffix}`),
      exactLineSourceRevision,
      exactCandidateSourceHash,
      order.rows[0].id,
      promotionReceipt.rows[0].id,
      `legacy-unit-promote-${suffix}`,
      hash(`legacy-unit-promote-request-${suffix}`),
      actorEmail,
    ],
  )
  const candidateId = candidate.rows[0].id

  async function insertLine({
    globalId = null,
    externalLineId,
    unitMultiplier,
    workflowState,
    packagingSource,
    packageProfileId = null,
    canonicalOrderLineId = null,
    rowVersion,
  }) {
    const result = await pool.query(
      `INSERT INTO operations_commerce_order_candidate_lines (
         global_id, organization_id, integration_account_id, pipeline_id,
         run_id, order_candidate_id, provider, external_line_id,
         external_product_id, external_variant_id,
         external_inventory_item_id, sku_snapshot,
         product_title_snapshot, provider_status_raw, normalized_status,
         ordered_quantity, current_quantity, unfulfilled_quantity,
         unit_multiplier, physical_quantity, currency_code,
         unit_price_minor, subtotal_minor, discount_minor,
         brand_discount_minor, tax_minor, other_adjustment_minor,
         total_minor, price_resolution_state, resolved_currency_code,
         resolved_unit_price_minor, resolved_subtotal_minor,
         resolved_discount_minor, resolved_brand_discount_minor,
         resolved_tax_minor, resolved_other_adjustment_minor,
         resolved_total_minor, requires_shipping, mapping_state,
         product_id, product_mapping_id, packaging_state,
         package_profile_id, packaging_source, packaging_weight_source,
         weight_grams, length_mm, width_mm, height_mm,
         observed_at, source_revision, source_hash,
         provider_api_version, normalizer_version, workflow_state,
         blocking_codes, canonical_order_line_id, promoted_at,
         row_version, created_by, updated_by, expires_at
       ) VALUES (
         COALESCE($1, allocate_global_reference('gcol')),
         $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         'shopify', $7,
         'gid://shopify/Product/10054534529271',
         'gid://shopify/ProductVariant/51028106576119',
         'gid://shopify/InventoryItem/51028106576119',
         'sku-hosted-1', 'The 3p Fulfilled Snowboard', 'open', 'open',
         1, 1, 1, $8, $8, 'USD',
         69995, 69995, 0, 0, 0, 0, 69995,
         'provider', 'USD', 69995, 69995, 0, 0, 0, 0, 69995,
         true, 'resolved', $9::uuid, $10::uuid, 'resolved',
         $11::uuid, $12, NULL,
         2268, 1524, 254, 254,
         now(), $13, $14, '2026-07', 'legacy-unit-test-v1', $15,
         '{}'::text[], $16::uuid,
         CASE WHEN $15 = 'promoted' THEN now() ELSE NULL END,
         $17, $18, $18, now() + interval '7 days'
       ) RETURNING id::text, global_id, row_version::text`,
      [
        globalId,
        organizationId,
        accountId,
        pipelineId,
        run.rows[0].id,
        candidateId,
        externalLineId,
        unitMultiplier,
        productId,
        productMappingId,
        packageProfileId,
        packagingSource,
        exactLineSourceRevision,
        exactLineSourceHash,
        workflowState,
        canonicalOrderLineId,
        rowVersion,
        actorEmail,
      ],
    )
    return result.rows[0]
  }

  const exactLine = await insertLine({
    globalId: exactLineGlobalId,
    externalLineId: 'gid://shopify/LineItem/19786681221367',
    unitMultiplier: 1,
    workflowState: 'promoted',
    packagingSource: 'manual',
    canonicalOrderLineId: canonicalLine.rows[0].id,
    rowVersion: 10,
  })
  const multipackLine = await insertLine({
    externalLineId: `gid://shopify/LineItem/multipack-${suffix}`,
    unitMultiplier: 6,
    workflowState: 'ready',
    packagingSource: 'manual',
    rowVersion: 3,
  })
  const unprovenManualLine = await insertLine({
    externalLineId: `gid://shopify/LineItem/unproven-${suffix}`,
    unitMultiplier: 1,
    workflowState: 'ready',
    packagingSource: 'manual',
    rowVersion: 6,
  })
  const conflictingManualLine = await insertLine({
    externalLineId: `gid://shopify/LineItem/conflicting-${suffix}`,
    unitMultiplier: 1,
    workflowState: 'ready',
    packagingSource: 'manual',
    rowVersion: 7,
  })
  const malformedManualLine = await insertLine({
    externalLineId: `gid://shopify/LineItem/malformed-${suffix}`,
    unitMultiplier: 1,
    workflowState: 'ready',
    packagingSource: 'manual',
    rowVersion: 8,
  })
  const approvedProfileLine = await insertLine({
    externalLineId: `gid://shopify/LineItem/profile-${suffix}`,
    unitMultiplier: 1,
    workflowState: 'ready',
    packagingSource: 'profile',
    packageProfileId: legacyProfile.rows[0].id,
    rowVersion: 4,
  })
  async function recordManualResolution({
    line,
    marker,
    weightGrams = 2268,
    dimensionsMm = { width: 254, height: 254, length: 1524 },
    omitDimensions = false,
  }) {
    const idempotencyKey = `legacy-unit-package-${marker}-${suffix}`
    const requestHash = hash(idempotencyKey)
    const resultPayload = {
      action: 'resolve-package',
      replayed: false,
      rowVersion: 4,
      weightGrams,
      dimensionsMm,
      lineGlobalId: line.global_id,
      packageSource: 'manual',
      workflowState: 'resolving',
      providerWrites: 0,
      candidateGlobalId: exactCandidateGlobalId,
      syncCursorAdvanced: false,
      packageProfileGlobalId: null,
    }
    if (omitDimensions) delete resultPayload.dimensionsMm
    const receipt = await pool.query(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, result_global_id,
         result_payload, completed_at
       ) VALUES (
         $1::uuid, 'commerce.intake.resolve_package', $2, $3,
         $4, 'succeeded', $5::uuid, $6, $7::jsonb, now()
       ) RETURNING id::text`,
      [
        organizationId,
        idempotencyKey,
        requestHash,
        actorEmail,
        randomUUID(),
        exactCandidateGlobalId,
        JSON.stringify(resultPayload),
      ],
    )
    const decision = await pool.query(
      `INSERT INTO operations_commerce_resolution_decisions (
         organization_id, integration_account_id, pipeline_id,
         intake_run_global_id, target_type, target_global_id,
         target_source_revision, target_source_hash,
         decision_type, outcome, resulting_workflow_state,
         reason_code, policy_version, product_id,
         command_receipt_id, idempotency_key, request_hash,
         actor_email, correlation_id
       ) SELECT
         $1::uuid, $2::uuid, $3::uuid,
         $4, 'order_candidate_line', $5,
         $6, $7, 'package_resolution', 'applied', 'resolving',
         'manual_package_recorded', 'commerce-intake-resolution-v1',
         $8::uuid, $9::uuid, $10, $11,
         receipt.actor_email, receipt.correlation_id
       FROM operations_command_receipts receipt
       WHERE receipt.organization_id = $1::uuid
         AND receipt.id = $9::uuid
       RETURNING id::text, global_id`,
      [
        organizationId,
        accountId,
        pipelineId,
        run.rows[0].global_id,
        line.global_id,
        exactLineSourceRevision,
        exactLineSourceHash,
        productId,
        receipt.rows[0].id,
        idempotencyKey,
        requestHash,
      ],
    )
    return {
      decision: decision.rows[0],
      receipt: receipt.rows[0],
    }
  }

  const exactManualResolutions = [
    await recordManualResolution({
      line: exactLine,
      marker: 'exact-a',
    }),
    await recordManualResolution({
      line: exactLine,
      marker: 'exact-b',
    }),
  ]
  await recordManualResolution({
    line: conflictingManualLine,
    marker: 'conflict-matching',
  })
  await recordManualResolution({
    line: conflictingManualLine,
    marker: 'conflict-weight',
    weightGrams: 2269,
  })
  await recordManualResolution({
    line: malformedManualLine,
    marker: 'malformed-matching',
  })
  await recordManualResolution({
    line: malformedManualLine,
    marker: 'malformed-missing-dimensions',
    omitDimensions: true,
  })
  return {
    accountEnvironment: 'sandbox',
    accountId,
    actorEmail,
    approvedProfileLine,
    candidateId,
    channelSourceHash,
    channelSourceRevision,
    conflictingManualLine,
    exactLine,
    exactManualResolutions,
    malformedManualLine,
    multipackLine,
    organizationId,
    productGlobalId: product.rows[0].reference_code,
    unprovenManualLine,
  }
}

async function verify(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const fixture = await seedLegacyFixture(pool)
    const before = await pool.query(
      `SELECT line.global_id, line.row_version::integer,
              line.packaging_state, line.packaging_source,
              line.packaging_weight_source, line.weight_grams,
              line.length_mm, line.width_mm, line.height_mm,
              line.source_revision, line.source_hash,
              candidate.source_hash AS candidate_source_hash
       FROM operations_commerce_current_planning_lines line
       JOIN operations_commerce_order_candidates candidate
         ON candidate.id = line.order_candidate_id
       WHERE line.global_id = $1`,
      [exactLineGlobalId],
    )
    assert.deepEqual(plain(before.rows[0]), {
      global_id: exactLineGlobalId,
      row_version: 10,
      packaging_state: 'resolved',
      packaging_source: 'manual',
      packaging_weight_source: null,
      weight_grams: 2268,
      length_mm: 1524,
      width_mm: 254,
      height_mm: 254,
      source_revision: exactLineSourceRevision,
      source_hash: exactLineSourceHash,
      candidate_source_hash: exactCandidateSourceHash,
    })

    const migrationSql = readFileSync(
      resolve(root, 'db/migrations', migrationName),
      'utf8',
    )
    const legacyUnitHealth = loadTypeScriptModule(
      'app_src/lib/persistence/operationsLegacyUnitMeasurementHealth.ts',
    )
    const healthSql =
      legacyUnitHealth.OPERATIONS_LEGACY_UNIT_MEASUREMENT_HEALTH_SQL
    const client = await pool.connect()
    try {
      await applyMigration(client, migrationName)
      const catalogDigests = await client.query(`
        SELECT
          (
            SELECT pg_catalog.count(attribute.attnum)::integer
            FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          ) AS column_count,
          (
            SELECT pg_catalog.encode(public.digest(
              pg_catalog.convert_to(pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                  attribute.attnum::text,
                  attribute.attname,
                  pg_catalog.format_type(
                    attribute.atttypid,
                    attribute.atttypmod
                  ),
                  attribute.attnotnull::text,
                  COALESCE(pg_catalog.pg_get_expr(
                    attribute_default.adbin,
                    attribute_default.adrelid
                  ), '')
                ), E'\\n' ORDER BY attribute.attnum
              ), 'UTF8'), 'sha256'
            ), 'hex')
            FROM pg_catalog.pg_attribute attribute
            LEFT JOIN pg_catalog.pg_attrdef attribute_default
              ON attribute_default.adrelid = attribute.attrelid
             AND attribute_default.adnum = attribute.attnum
            WHERE attribute.attrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          ) AS column_hash,
          (
            SELECT pg_catalog.count(installed.oid)::integer
            FROM pg_catalog.pg_constraint installed
            WHERE installed.conrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
              AND installed.contype <> 'n'
          ) AS constraint_count,
          (
            SELECT pg_catalog.encode(public.digest(
              pg_catalog.convert_to(pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                  installed_namespace.nspname,
                  table_row.relname,
                  installed.conname,
                  installed.contype::text,
                  installed.convalidated::text,
                  installed.connoinherit::text,
                  pg_catalog.pg_get_constraintdef(installed.oid, true)
                ), E'\\n' ORDER BY installed.conname
              ), 'UTF8'), 'sha256'
            ), 'hex')
            FROM pg_catalog.pg_constraint installed
            JOIN pg_catalog.pg_class table_row
              ON table_row.oid = installed.conrelid
            JOIN pg_catalog.pg_namespace installed_namespace
              ON installed_namespace.oid = installed.connamespace
            WHERE installed.conrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
              AND installed.contype <> 'n'
          ) AS constraint_hash,
          (
            SELECT pg_catalog.count(installed.indexrelid)::integer
            FROM pg_catalog.pg_index installed
            WHERE installed.indrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
          ) AS index_count,
          (
            SELECT pg_catalog.encode(public.digest(
              pg_catalog.convert_to(pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                  index_row.relname,
                  installed.indisunique::text,
                  installed.indisprimary::text,
                  installed.indisvalid::text,
                  installed.indisready::text,
                  pg_catalog.btrim(pg_catalog.regexp_replace(
                    pg_catalog.pg_get_indexdef(installed.indexrelid),
                    '[[:space:]]+', ' ', 'g'
                  ))
                ), E'\\n' ORDER BY index_row.relname
              ), 'UTF8'), 'sha256'
            ), 'hex')
            FROM pg_catalog.pg_index installed
            JOIN pg_catalog.pg_class index_row
              ON index_row.oid = installed.indexrelid
            WHERE installed.indrelid = pg_catalog.to_regclass(
              'public.operations_commerce_legacy_unit_measurement_evidence'
            )
          ) AS index_hash,
          (
            SELECT pg_catalog.count(installed.oid)::integer
            FROM (VALUES
              ('validate_operations_commerce_legacy_unit_measurement_evidence()'),
              ('protect_operations_commerce_legacy_unit_measurement_evidence()'),
              ('protect_operations_commerce_legacy_unit_measurement_receipt()')
            ) required(signature)
            LEFT JOIN pg_catalog.pg_proc installed
              ON installed.oid = pg_catalog.to_regprocedure(
                'public.' || required.signature
              )
          ) AS function_count,
          (
            SELECT pg_catalog.encode(public.digest(
              pg_catalog.convert_to(pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                  required.signature,
                  installed_namespace.nspname,
                  language.lanname,
                  installed.prokind::text,
                  installed.provolatile::text,
                  installed.proparallel::text,
                  installed.proisstrict::text,
                  installed.prosecdef::text,
                  installed.proleakproof::text,
                  pg_catalog.format_type(installed.prorettype, NULL),
                  installed.pronargs::text,
                  installed.pronargdefaults::text,
                  COALESCE(pg_catalog.array_to_string(
                    installed.proconfig, ','
                  ), ''),
                  pg_catalog.btrim(pg_catalog.regexp_replace(
                    installed.prosrc, '[[:space:]]+', ' ', 'g'
                  ))
                ), E'\\n' ORDER BY required.signature
              ), 'UTF8'), 'sha256'
            ), 'hex')
            FROM (VALUES
              ('validate_operations_commerce_legacy_unit_measurement_evidence()'),
              ('protect_operations_commerce_legacy_unit_measurement_evidence()'),
              ('protect_operations_commerce_legacy_unit_measurement_receipt()')
            ) required(signature)
            LEFT JOIN pg_catalog.pg_proc installed
              ON installed.oid = pg_catalog.to_regprocedure(
                'public.' || required.signature
              )
            LEFT JOIN pg_catalog.pg_namespace installed_namespace
              ON installed_namespace.oid = installed.pronamespace
            LEFT JOIN pg_catalog.pg_language language
              ON language.oid = installed.prolang
          ) AS function_hash,
          (
            SELECT pg_catalog.count(installed.oid)::integer
            FROM (VALUES
              (
                'operations_commerce_legacy_unit_measurement_evidence',
                'validate_operations_commerce_legacy_unit_measurement_evidence'
              ),
              (
                'operations_commerce_legacy_unit_measurement_evidence',
                'protect_operations_commerce_legacy_unit_measurement_evidence'
              ),
              (
                'operations_command_receipts',
                'protect_operations_commerce_legacy_unit_measurement_receipt'
              )
            ) required(table_name, trigger_name)
            LEFT JOIN pg_catalog.pg_trigger installed
              ON installed.tgrelid = pg_catalog.to_regclass(
                'public.' || required.table_name
              )
             AND installed.tgname = required.trigger_name
          ) AS trigger_count,
          (
            SELECT pg_catalog.encode(public.digest(
              pg_catalog.convert_to(pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                  required.table_name,
                  table_namespace.nspname,
                  installed.tgname,
                  installed.tgtype::text,
                  installed.tgenabled::text,
                  installed.tgisinternal::text,
                  function_namespace.nspname || '.' ||
                    trigger_function.proname || '(' ||
                    pg_catalog.pg_get_function_identity_arguments(
                      trigger_function.oid
                    ) || ')',
                  COALESCE(pg_catalog.pg_get_expr(
                    installed.tgqual, installed.tgrelid
                  ), ''),
                  pg_catalog.btrim(pg_catalog.regexp_replace(
                    pg_catalog.pg_get_triggerdef(installed.oid),
                    '[[:space:]]+', ' ', 'g'
                  ))
                ), E'\\n' ORDER BY required.table_name,
                  required.trigger_name
              ), 'UTF8'), 'sha256'
            ), 'hex')
            FROM (VALUES
              (
                'operations_commerce_legacy_unit_measurement_evidence',
                'validate_operations_commerce_legacy_unit_measurement_evidence'
              ),
              (
                'operations_commerce_legacy_unit_measurement_evidence',
                'protect_operations_commerce_legacy_unit_measurement_evidence'
              ),
              (
                'operations_command_receipts',
                'protect_operations_commerce_legacy_unit_measurement_receipt'
              )
            ) required(table_name, trigger_name)
            LEFT JOIN pg_catalog.pg_trigger installed
              ON installed.tgrelid = pg_catalog.to_regclass(
                'public.' || required.table_name
              )
             AND installed.tgname = required.trigger_name
            LEFT JOIN pg_catalog.pg_class table_row
              ON table_row.oid = installed.tgrelid
            LEFT JOIN pg_catalog.pg_namespace table_namespace
              ON table_namespace.oid = table_row.relnamespace
            LEFT JOIN pg_catalog.pg_proc trigger_function
              ON trigger_function.oid = installed.tgfoid
            LEFT JOIN pg_catalog.pg_namespace function_namespace
              ON function_namespace.oid = trigger_function.pronamespace
          ) AS trigger_hash
      `)
      assert.deepEqual(plain(catalogDigests.rows[0]), {
        column_count: 17,
        column_hash:
          'bd1fe5bc733b4abe6ea1f8cc02e21fd862c4d0d126b8f063d3be963e8f40da3a',
        constraint_count: 15,
        constraint_hash:
          '50f7a63234f9a8598d950419200ae090b3a7d802904062119fd0e264483413a2',
        index_count: 2,
        index_hash:
          '18131dcc43f74c35d5abafa5ef0a7ad8baa692014875e8171e785e65543976da',
        function_count: 3,
        function_hash:
          '7579fc4cb426e8b1e07a41ead2d9dba971fde0e63fb6d8bec7547a0952fe482f',
        trigger_count: 3,
        trigger_hash:
          '1ddc53f5259f2b297017ace3572d1efcc608bb1484c1c0bb3406ecb9cbb8020e',
      }, '0327 runtime catalog digests must remain exact')
      const currentHealth = await client.query(
        `SELECT (${healthSql}) AS applied`,
      )
      assert.equal(
        currentHealth.rows[0]?.applied,
        true,
        'Hosted health must attest the exact 0327 ledger and runtime structure',
      )

      await client.query('BEGIN')
      try {
        await client.query(
          `UPDATE schema_migrations
           SET checksum = repeat('0', 64)
           WHERE filename = $1`,
          [migrationName],
        )
        const driftedLedger = await client.query(
          `SELECT (${healthSql}) AS applied`,
        )
        assert.equal(
          driftedLedger.rows[0]?.applied,
          false,
          'Hosted health must reject a drifted 0327 ledger checksum',
        )
      } finally {
        await client.query('ROLLBACK')
      }

      await client.query('BEGIN')
      try {
        await client.query(
          `ALTER TABLE operations_command_receipts DISABLE TRIGGER
             protect_operations_commerce_legacy_unit_measurement_receipt`,
        )
        const driftedStructure = await client.query(
          `SELECT (${healthSql}) AS applied`,
        )
        assert.equal(
          driftedStructure.rows[0]?.applied,
          false,
          'Hosted health must reject disabled 0327 integrity structure',
        )
      } finally {
        await client.query('ROLLBACK')
      }
    } finally {
      client.release()
    }

    const rows = await pool.query(
      `SELECT global_id, row_version::integer, unit_multiplier::integer,
              packaging_state, packaging_source, packaging_weight_source,
              package_profile_id::text, weight_grams,
              length_mm, width_mm, height_mm, source_revision, source_hash
       FROM operations_commerce_order_candidate_lines
       WHERE id = ANY($1::uuid[])
       ORDER BY global_id`,
      [[
        fixture.exactLine.id,
        fixture.multipackLine.id,
        fixture.unprovenManualLine.id,
        fixture.conflictingManualLine.id,
        fixture.malformedManualLine.id,
        fixture.approvedProfileLine.id,
      ]],
    )
    const byId = new Map(rows.rows.map((row) => [row.global_id, row]))
    assert.deepEqual(
      plain(byId.get(exactLineGlobalId)),
      {
        global_id: exactLineGlobalId,
        row_version: 11,
        unit_multiplier: 1,
        packaging_state: 'not_required',
        packaging_source: 'none',
        packaging_weight_source: null,
        package_profile_id: null,
        weight_grams: 2268,
        length_mm: 1524,
        width_mm: 254,
        height_mm: 254,
        source_revision: exactLineSourceRevision,
        source_hash: exactLineSourceHash,
      },
      '0327 must normalize only the legacy no-profile one-each projection while retaining exact order evidence',
    )
    const multipack = byId.get(fixture.multipackLine.global_id)
    assert.equal(multipack.row_version, 3)
    assert.equal(multipack.packaging_state, 'resolved')
    assert.equal(multipack.packaging_source, 'manual')
    assert.equal(multipack.packaging_weight_source, null)
    const unproven = byId.get(fixture.unprovenManualLine.global_id)
    assert.equal(unproven.row_version, 6)
    assert.equal(unproven.packaging_state, 'resolved')
    assert.equal(unproven.packaging_source, 'manual')
    assert.equal(unproven.packaging_weight_source, null)
    const conflicting = byId.get(fixture.conflictingManualLine.global_id)
    assert.equal(conflicting.row_version, 7)
    assert.equal(conflicting.packaging_state, 'resolved')
    assert.equal(conflicting.packaging_source, 'manual')
    assert.equal(conflicting.packaging_weight_source, null)
    const malformed = byId.get(fixture.malformedManualLine.global_id)
    assert.equal(malformed.row_version, 8)
    assert.equal(malformed.packaging_state, 'resolved')
    assert.equal(malformed.packaging_source, 'manual')
    assert.equal(malformed.packaging_weight_source, null)
    const approved = byId.get(fixture.approvedProfileLine.global_id)
    assert.equal(approved.row_version, 4)
    assert.equal(approved.packaging_state, 'resolved')
    assert.equal(approved.packaging_source, 'profile')
    assert.equal(approved.package_profile_id !== null, true)

    const retainedEvidence = await pool.query(
      `SELECT
         evidence.id::text,
         evidence.candidate_line_id::text,
         evidence.resolution_decision_id::text,
         evidence.command_receipt_id::text,
         evidence.measurement_source,
         evidence.weight_grams,
         evidence.length_mm,
         evidence.width_mm,
         evidence.height_mm,
         evidence.line_source_revision,
         evidence.line_source_hash,
         evidence.request_hash,
         evidence.result_payload_hash,
         decision.global_id AS decision_global_id,
         decision.request_hash AS decision_request_hash,
         receipt.request_hash AS receipt_request_hash,
         pg_catalog.encode(
           digest(
             pg_catalog.convert_to(receipt.result_payload::text, 'UTF8'),
             'sha256'
           ),
           'hex'
         ) AS computed_result_payload_hash
       FROM operations_commerce_legacy_unit_measurement_evidence evidence
       JOIN operations_commerce_resolution_decisions decision
         ON decision.id = evidence.resolution_decision_id
       JOIN operations_command_receipts receipt
         ON receipt.organization_id = evidence.organization_id
        AND receipt.id = evidence.command_receipt_id
       WHERE evidence.candidate_line_id = ANY($1::uuid[])
       ORDER BY evidence.candidate_line_id`,
      [[
        fixture.exactLine.id,
        fixture.unprovenManualLine.id,
        fixture.conflictingManualLine.id,
        fixture.malformedManualLine.id,
      ]],
    )
    assert.equal(
      retainedEvidence.rowCount,
      1,
      'Only the unambiguous #1001-shaped manual measurement may be retained',
    )
    const evidence = retainedEvidence.rows[0]
    assert.equal(evidence.candidate_line_id, fixture.exactLine.id)
    assert.equal(evidence.measurement_source, 'manual_package_resolution')
    assert.equal(evidence.weight_grams, 2268)
    assert.equal(evidence.length_mm, 1524)
    assert.equal(evidence.width_mm, 254)
    assert.equal(evidence.height_mm, 254)
    assert.equal(evidence.line_source_revision, exactLineSourceRevision)
    assert.equal(evidence.line_source_hash, exactLineSourceHash)
    assert.equal(evidence.request_hash, evidence.decision_request_hash)
    assert.equal(evidence.request_hash, evidence.receipt_request_hash)
    assert.equal(
      evidence.result_payload_hash,
      evidence.computed_result_payload_hash,
    )
    assert.ok(
      fixture.exactManualResolutions.some((resolution) => (
        resolution.decision.id === evidence.resolution_decision_id
        && resolution.decision.global_id === evidence.decision_global_id
      )),
      'The retained evidence must reference one of the agreeing immutable decisions',
    )

    await pool.query(migrationSql)
    const rerun = await pool.query(
      `SELECT line.row_version::integer, line.source_revision,
              line.source_hash, candidate.source_hash AS candidate_source_hash,
              count(evidence.id)::integer AS evidence_count
       FROM operations_commerce_order_candidate_lines line
       JOIN operations_commerce_order_candidates candidate
         ON candidate.id = line.order_candidate_id
       LEFT JOIN operations_commerce_legacy_unit_measurement_evidence evidence
         ON evidence.candidate_line_id = line.id
       WHERE line.global_id = $1
       GROUP BY line.id, candidate.source_hash`,
      [exactLineGlobalId],
    )
    assert.deepEqual(plain(rerun.rows[0]), {
      row_version: 11,
      source_revision: exactLineSourceRevision,
      source_hash: exactLineSourceHash,
      candidate_source_hash: exactCandidateSourceHash,
      evidence_count: 1,
    }, '0327 must be idempotent and must not rewrite provider signatures')

    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_legacy_unit_measurement_evidence
         SET weight_grams = weight_grams
         WHERE id = $1::uuid`,
        [evidence.id],
      ),
      /Legacy unit measurement evidence is append-only/,
      'Retained manual measurement evidence must be immutable',
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_command_receipts
         SET result_payload = result_payload
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, evidence.command_receipt_id],
      ),
      /referenced by immutable evidence cannot change/,
      'The exact command result supporting retained weight must be immutable',
    )
    const agreeingReceipt = fixture.exactManualResolutions.find(
      (resolution) => (
        resolution.receipt.id !== evidence.command_receipt_id
      ),
    )?.receipt
    assert.ok(agreeingReceipt)
    await assert.rejects(
      pool.query(
        `UPDATE operations_command_receipts
         SET result_payload = result_payload
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [fixture.organizationId, agreeingReceipt.id],
      ),
      /referenced by immutable evidence cannot change/,
      'Every agreeing receipt used to establish consensus must remain immutable',
    )
    await assert.rejects(
      pool.query(
        `UPDATE operations_commerce_resolution_decisions
         SET reason_code = reason_code
         WHERE id = $1::uuid`,
        [evidence.resolution_decision_id],
      ),
      /Commerce resolution decisions are append-only/,
      'Existing resolution-decision protection must preserve the exact manual decision',
    )

    const migrationFiles = migrations()
    const firstPostLegacyIndex = migrationFiles.indexOf(
      firstPostLegacyMigration,
    )
    const orderUnitWeightRepairIndex = migrationFiles.indexOf(
      orderUnitWeightRepairMigration,
    )
    assert.ok(
      firstPostLegacyIndex > migrationFiles.indexOf(migrationName),
      `${firstPostLegacyMigration} must follow ${migrationName}`,
    )
    assert.ok(
      orderUnitWeightRepairIndex >= firstPostLegacyIndex,
      `${orderUnitWeightRepairMigration} must follow ${firstPostLegacyMigration}`,
    )
    const migrationClient = await pool.connect()
    try {
      for (const file of migrationFiles.slice(
        firstPostLegacyIndex,
        orderUnitWeightRepairIndex + 1,
      )) {
        await applyMigration(migrationClient, file)
      }
    } finally {
      migrationClient.release()
    }

    const unitWeightHealth = loadTypeScriptModule(
      'app_src/lib/persistence/operationsOrderUnitWeightHealth.ts',
    )
    const unitWeightHealthResult = await pool.query(
      `SELECT (
         ${unitWeightHealth.OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL}
       ) AS applied`,
    )
    assert.equal(
      unitWeightHealthResult.rows[0]?.applied,
      true,
      'Hosted health must require order-specific ordinary-item physical facts',
    )
    const healthTamperClient = await pool.connect()
    try {
      const assertHealthRejectsTamper = async (sql, message) => {
        await healthTamperClient.query('BEGIN')
        try {
          await healthTamperClient.query(sql)
          const result = await healthTamperClient.query(
            `SELECT (
               ${unitWeightHealth.OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL}
             ) AS applied`,
          )
          assert.equal(result.rows[0]?.applied, false, message)
        } finally {
          await healthTamperClient.query('ROLLBACK')
        }
      }
      await assertHealthRejectsTamper(
        `UPDATE public.schema_migrations
         SET checksum = repeat('0', 64)
         WHERE filename = '0336_operations_order_unit_physical_facts.sql'`,
        '0336 health must reject a drifted migration ledger checksum',
      )
      await assertHealthRejectsTamper(
        `ALTER TABLE public.operations_order_unit_weight_facts
         ALTER COLUMN unit_length_mm TYPE bigint`,
        '0336 health must reject column type drift',
      )
      await assertHealthRejectsTamper(
        `ALTER TABLE public.operations_order_unit_weight_facts
         DROP CONSTRAINT operations_order_unit_weight_facts_dimensions_valid`,
        '0336 health must reject constraint drift',
      )
      await assertHealthRejectsTamper(
        `ALTER INDEX public.operations_order_unit_weight_facts_latest_idx
         RENAME TO operations_order_unit_weight_facts_latest_drifted_idx`,
        '0336 health must reject index drift',
      )
      await assertHealthRejectsTamper(
        `CREATE OR REPLACE FUNCTION
           public.protect_operations_order_unit_weight_fact()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $$ BEGIN RETURN OLD; END; $$`,
        '0336 health must reject integrity-function body drift',
      )
      await assertHealthRejectsTamper(
        `ALTER TABLE public.operations_cartonization_rate_evidence_packages
         DISABLE TRIGGER
           validate_operations_cartonization_unit_material_package`,
        '0336 health must reject a disabled cartonization trigger',
      )
      await assertHealthRejectsTamper(
        `DROP TRIGGER validate_operations_cartonization_unit_material_package
           ON public.operations_cartonization_rate_evidence_packages;
         CREATE TRIGGER
           validate_operations_cartonization_unit_material_package
         AFTER INSERT OR UPDATE
           ON public.operations_cartonization_rate_evidence_packages
         FOR EACH ROW EXECUTE FUNCTION
           public.validate_operations_cartonization_unit_material_package()`,
        '0336 health must reject trigger type and deferrability drift',
      )
    } finally {
      healthTamperClient.release()
    }

    const ordinaryUnitContext = await pool.query(
      `SELECT line.packaging_state, line.packaging_source,
              line.packaging_weight_source, line.weight_grams,
              channel.weight_grams AS channel_weight_grams
       FROM operations_commerce_current_planning_lines line
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = line.organization_id
        AND candidate.id = line.order_candidate_id
       LEFT JOIN operations_product_channel_states channel
         ON channel.organization_id = line.organization_id
        AND channel.integration_account_id = line.integration_account_id
        AND channel.pipeline_id = line.pipeline_id
        AND channel.provider = line.provider
        AND channel.external_product_id = line.external_product_id
        AND channel.external_variant_id = line.external_variant_id
        AND channel.product_id = line.product_id
        AND channel.product_mapping_id = line.product_mapping_id
       WHERE candidate.global_id = $1
         AND line.global_id = $2`,
      [exactCandidateGlobalId, exactLineGlobalId],
    )
    assert.deepEqual(plain(ordinaryUnitContext.rows[0]), {
      packaging_state: 'not_required',
      packaging_source: 'none',
      packaging_weight_source: null,
      weight_grams: 2268,
      channel_weight_grams: null,
    }, 'The regression fixture must retain a NULL provider-weight source')

    const weightOnlyClient = await pool.connect()
    try {
      await weightOnlyClient.query('BEGIN')
      const weightOnlyReceipt = await createProcessingUnitWeightReceipt(
        weightOnlyClient,
        fixture,
        'weight-only-fallback',
      )
      const weightOnlyFact = await insertFirstUnitWeightFact(
        weightOnlyClient,
        fixture,
        weightOnlyReceipt,
        3000,
        null,
      )
      assert.deepEqual(
        plain(weightOnlyFact.rows[0]),
        {
          id: weightOnlyFact.rows[0].id,
          global_id: weightOnlyFact.rows[0].global_id,
          fact_version: 1,
          unit_weight_grams: 3000,
          unit_length_mm: null,
          unit_width_mm: null,
          unit_height_mm: null,
          request_hash: weightOnlyReceipt.requestHash,
          fact_hash: weightOnlyFact.rows[0].fact_hash,
          candidate_line_id: fixture.exactLine.id,
          revision_application_line_id: null,
        },
        'Weight-only evidence must remain available for truthful one-unit fallback',
      )
    } finally {
      await weightOnlyClient.query('ROLLBACK')
      weightOnlyClient.release()
    }

    const acceptedReceipt = await createProcessingUnitWeightReceipt(
      pool,
      fixture,
      'accepted',
    )
    const acceptedFact = await insertFirstUnitWeightFact(
      pool,
      fixture,
      acceptedReceipt,
      3000,
    )
    assert.equal(
      acceptedFact.rowCount,
      1,
      'A NULL provider-weight source must permit the first operator fact',
    )
    assert.deepEqual(plain(acceptedFact.rows[0]), {
      id: acceptedFact.rows[0].id,
      global_id: acceptedFact.rows[0].global_id,
      fact_version: 1,
      unit_weight_grams: 3000,
      unit_length_mm: 100,
      unit_width_mm: 100,
      unit_height_mm: 50,
      request_hash: acceptedReceipt.requestHash,
      fact_hash: acceptedFact.rows[0].fact_hash,
      candidate_line_id: fixture.exactLine.id,
      revision_application_line_id: null,
    })

    const rejectionClient = await pool.connect()
    try {
      await rejectionClient.query('BEGIN')
      try {
        await rejectionClient.query(
          `SET LOCAL session_replication_role = replica`,
        )
        await rejectionClient.query(
          `DELETE FROM operations_order_unit_weight_facts
           WHERE id = $1::uuid`,
          [acceptedFact.rows[0].id],
        )
        await rejectionClient.query(
          `UPDATE operations_commerce_order_candidate_lines
           SET packaging_weight_source = 'provider_order',
               weight_grams = 2268
           WHERE id = $1::uuid`,
          [fixture.exactLine.id],
        )
        await rejectionClient.query(
          `SET LOCAL session_replication_role = origin`,
        )
        const providerReceipt = await createProcessingUnitWeightReceipt(
          rejectionClient,
          fixture,
          'provider-order-dimensions-accepted',
        )
        const providerFact = await insertFirstUnitWeightFact(
          rejectionClient,
          fixture,
          providerReceipt,
          2268,
        )
        assert.equal(
          providerFact.rowCount,
          1,
          'An unchanged provider weight must allow separate item dimensions',
        )
        await rejectionClient.query(
          `SET LOCAL session_replication_role = replica`,
        )
        await rejectionClient.query(
          `DELETE FROM operations_order_unit_weight_facts
           WHERE id = $1::uuid`,
          [providerFact.rows[0].id],
        )
        await rejectionClient.query(
          `SET LOCAL session_replication_role = origin`,
        )
        const rejectedReceipt = await createProcessingUnitWeightReceipt(
          rejectionClient,
          fixture,
          'provider-order-rejected',
        )
        await assert.rejects(
          insertFirstUnitWeightFact(
            rejectionClient,
            fixture,
            rejectedReceipt,
            3000,
          ),
          /Order unit facts require one current exact ordinary-unit line/,
          'A positive provider-order weight must remain read-only',
        )
      } finally {
        await rejectionClient.query('ROLLBACK')
      }
    } finally {
      rejectionClient.release()
    }

    const restoredUnitWeightState = await pool.query(
      `SELECT line.packaging_weight_source,
              count(fact.id)::integer AS fact_count
       FROM operations_commerce_order_candidate_lines line
       LEFT JOIN operations_order_unit_weight_facts fact
         ON fact.organization_id = line.organization_id
        AND fact.candidate_line_id = line.id
       WHERE line.id = $1::uuid
       GROUP BY line.id`,
      [fixture.exactLine.id],
    )
    assert.deepEqual(plain(restoredUnitWeightState.rows[0]), {
      packaging_weight_source: null,
      fact_count: 1,
    }, 'The rejection probe must roll back without changing the accepted fact')

    const runtimeRows = await pool.query(
      `SELECT
         line.global_id, line.provider,
         account.environment AS account_environment,
         line.product_id::text, product.reference_code AS product_global_id,
         line.product_title_snapshot, line.variant_title_snapshot,
         line.external_product_id, line.external_variant_id,
         line.requires_shipping, line.ordered_quantity::text,
         line.unfulfilled_quantity::text, line.unit_multiplier::text,
         line.mapping_state, line.packaging_state, line.packaging_source,
         line.packaging_weight_source, line.weight_grams,
         line.length_mm, line.width_mm, line.height_mm,
         line.source_revision AS line_source_revision,
         line.source_hash AS line_source_hash,
         manual_measurement.id::text AS manual_measurement_evidence_id,
         manual_measurement.measurement_source AS manual_measurement_source,
         manual_measurement.weight_grams AS manual_measurement_weight_grams,
         manual_measurement.length_mm AS manual_measurement_length_mm,
         manual_measurement.width_mm AS manual_measurement_width_mm,
         manual_measurement.height_mm AS manual_measurement_height_mm,
         manual_measurement.line_source_revision
           AS manual_measurement_line_source_revision,
         manual_measurement.line_source_hash
           AS manual_measurement_line_source_hash,
         manual_measurement.request_hash
           AS manual_measurement_request_hash,
         manual_measurement.result_payload_hash
           AS manual_measurement_result_payload_hash,
         manual_decision.global_id
           AS manual_measurement_decision_global_id,
         manual_decision.created_at
           AS manual_measurement_decision_created_at,
         order_unit_weight.global_id AS order_unit_weight_fact_global_id,
         order_unit_weight.fact_version AS order_unit_weight_fact_version,
         order_unit_weight.unit_weight_grams AS order_unit_weight_grams,
         order_unit_weight.unit_length_mm AS order_unit_length_mm,
         order_unit_weight.unit_width_mm AS order_unit_width_mm,
         order_unit_weight.unit_height_mm AS order_unit_height_mm,
         order_unit_weight.line_source_revision
           AS order_unit_weight_line_source_revision,
         order_unit_weight.line_source_hash
           AS order_unit_weight_line_source_hash,
         order_unit_weight.request_hash AS order_unit_weight_request_hash,
         order_unit_weight.fact_hash AS order_unit_weight_fact_hash,
         order_unit_weight.recorded_at AS order_unit_weight_recorded_at,
         channel.source_revision AS channel_source_revision,
         channel.source_hash AS channel_source_hash,
         channel.weight_grams AS channel_weight_grams,
         channel.provider_status_raw AS channel_provider_status_raw,
         channel.normalized_status AS channel_normalized_status,
         channel.provider_active AS channel_provider_active,
         channel.requires_shipping AS channel_requires_shipping
       FROM operations_commerce_current_planning_lines line
       JOIN operations_integration_accounts account
         ON account.id = line.integration_account_id
       JOIN crm_products product ON product.id = line.product_id
       LEFT JOIN operations_commerce_legacy_unit_measurement_evidence
         manual_measurement
         ON manual_measurement.organization_id = line.organization_id
        AND manual_measurement.integration_account_id =
              line.integration_account_id
        AND manual_measurement.pipeline_id = line.pipeline_id
        AND manual_measurement.candidate_line_id = line.id
       LEFT JOIN operations_commerce_resolution_decisions manual_decision
         ON manual_decision.organization_id =
              manual_measurement.organization_id
        AND manual_decision.id = manual_measurement.resolution_decision_id
       LEFT JOIN LATERAL (
         SELECT fact.global_id, fact.fact_version, fact.unit_weight_grams,
                fact.unit_length_mm, fact.unit_width_mm, fact.unit_height_mm,
                fact.line_source_revision, fact.line_source_hash,
                fact.request_hash, fact.fact_hash, fact.recorded_at
         FROM operations_order_unit_weight_facts fact
         WHERE fact.organization_id = line.organization_id
           AND fact.candidate_id = line.order_candidate_id
           AND fact.planning_line_id = line.id
           AND fact.planning_line_global_id = line.global_id
           AND fact.line_source_revision = line.source_revision
           AND fact.line_source_hash = line.source_hash
         ORDER BY fact.fact_version DESC, fact.id DESC
         LIMIT 1
       ) order_unit_weight ON true
       LEFT JOIN operations_product_channel_states channel
         ON channel.organization_id = line.organization_id
        AND channel.integration_account_id = line.integration_account_id
        AND channel.pipeline_id = line.pipeline_id
        AND channel.provider = line.provider
        AND channel.external_product_id = line.external_product_id
        AND channel.external_variant_id = line.external_variant_id
        AND channel.product_id = line.product_id
        AND channel.product_mapping_id = line.product_mapping_id
       WHERE line.global_id = ANY($1::text[])`,
      [[
        exactLineGlobalId,
        fixture.conflictingManualLine.global_id,
        fixture.malformedManualLine.global_id,
      ]],
    )
    function mappedInput(row) {
      return {
        ...row,
        pack_mapping_id: null,
        pack_mapping_global_id: null,
        captured_pack_mapping_row_version: null,
        current_pack_mapping_row_version: null,
        pack_mapping_is_current: null,
        pack_mapping_projection_state: null,
        pack_mapping_source_revision: null,
        pack_mapping_source_hash: null,
        pack_mapping_pack_evidence_hash: null,
        pack_mapping_purpose: null,
        channel_pack_evidence_hash: null,
        pack_profile_version_id: null,
        pack_profile_version_global_id: null,
        captured_pack_profile_row_version: null,
        current_pack_profile_row_version: null,
        pack_profile_is_current: null,
        pack_profile_lifecycle_state: null,
        pack_profile_fit_model: null,
        pack_profile_evidence_type: null,
        pack_profile_evidence_reference: null,
        pack_profile_confirmed_at: null,
        pack_profile_status: null,
        pack_profile_base_each_quantity: null,
        current_pack_profile_base_each_quantity: null,
        current_pack_profile_length_mm: null,
        current_pack_profile_width_mm: null,
        current_pack_profile_height_mm: null,
        current_pack_profile_dimension_basis: null,
        current_pack_profile_package_level: null,
        current_pack_profile_ships_as_own_package: null,
        current_pack_profile_gross_weight_grams: null,
        current_pack_profile_weight_basis: null,
        pack_lineage_source: 'order_candidate_capture',
        checkout_receipt_global_id: null,
        fulfillment_pack_source: 'candidate_capture',
        checkout_pack_baseline: null,
      }
    }
    const { hybrid, persistence, unitMaterial } = runtimeModules()
    const runtimeById = new Map(runtimeRows.rows.map((row) => [
      row.global_id,
      row,
    ]))
    const mapped = persistence.mapCandidateLines(
      { mode: 'production' },
      [mappedInput(runtimeById.get(exactLineGlobalId))],
    )[0]
    const orderFactRow = {
      ...runtimeById.get(exactLineGlobalId),
      manual_measurement_evidence_id: null,
      manual_measurement_source: null,
      manual_measurement_weight_grams: null,
      manual_measurement_length_mm: null,
      manual_measurement_width_mm: null,
      manual_measurement_height_mm: null,
      manual_measurement_line_source_revision: null,
      manual_measurement_line_source_hash: null,
      manual_measurement_request_hash: null,
      manual_measurement_result_payload_hash: null,
      manual_measurement_decision_global_id: null,
      manual_measurement_decision_created_at: null,
    }
    const factMapped = persistence.mapCandidateLines(
      { mode: 'production' },
      [mappedInput(orderFactRow)],
    )[0]
    assert.throws(
      () => persistence.mapCandidateLines(
        { mode: 'production' },
        [mappedInput(
          runtimeById.get(fixture.conflictingManualLine.global_id),
        )],
      ),
      (error) => (
        error?.code === 'HYBRID_CARTONIZATION_PACK_EVIDENCE_REQUIRED'
      ),
      'Conflicting manual results must remain fail-closed at runtime',
    )
    assert.throws(
      () => persistence.mapCandidateLines(
        { mode: 'production' },
        [mappedInput(
          runtimeById.get(fixture.malformedManualLine.global_id),
        )],
      ),
      (error) => (
        error?.code === 'HYBRID_CARTONIZATION_PACK_EVIDENCE_REQUIRED'
      ),
      'A malformed successful manual result must remain fail-closed at runtime',
    )
    assert.equal(mapped.line.profile.fitModel, 'unconstrained_unit')
    assert.equal(mapped.line.unitWeightGrams, 2268)
    assert.equal(mapped.evidence.weightSource, 'manual_resolution')
    assert.equal(
      mapped.evidence.weightEvidenceReference,
      evidence.decision_global_id,
    )
    assert.equal(
      mapped.evidence.weightEvidenceHash,
      evidence.result_payload_hash,
    )
    assert.equal(
      mapped.evidence.weightEvidenceRequestHash,
      evidence.request_hash,
    )
    assert.equal(factMapped.evidence.weightSource, 'order_specific')
    assert.equal(factMapped.evidence.dimensionSource, 'order_specific')
    assert.deepEqual(plain(factMapped.line.unitDimensionsMm), {
      length: 100,
      width: 100,
      height: 50,
    })
    assert.equal(
      factMapped.evidence.dimensionEvidenceHash,
      acceptedFact.rows[0].fact_hash,
    )

    const packageFixtureSuffix = randomUUID().slice(0, 8).toUpperCase()
    const packageWarehouse = (await pool.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, timezone, address, status,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'Ordinary-unit cartonization acceptance',
         'America/New_York', $3::jsonb, 'active', $4, $4
       ) RETURNING id::text, global_id`,
      [
        fixture.organizationId,
        `UNIT-${packageFixtureSuffix}`,
        JSON.stringify({
          name: 'Ordinary-unit cartonization acceptance',
          line1: '35 Saxony Drive',
          city: 'Trumbull',
          region: 'CT',
          postalCode: '06611',
          country: 'US',
        }),
        fixture.actorEmail,
      ],
    )).rows[0]
    const packageMaterial = (await pool.query(
      `INSERT INTO operations_packaging_materials (
         organization_id, code, name, material_type,
         inner_length_mm, inner_width_mm, inner_height_mm,
         tare_weight_grams, max_weight_grams, unit_cost_minor,
         currency, status, source, dimension_basis,
         dimension_evidence_type, dimension_evidence_reference,
         dimension_confirmed_at, dimension_confirmed_by,
         rated_outer_length_mm, rated_outer_width_mm,
         rated_outer_height_mm, rated_outer_dimension_evidence_type,
         rated_outer_dimension_evidence_reference,
         rated_outer_dimension_confirmed_at,
         rated_outer_dimension_confirmed_by, created_by, updated_by
       ) VALUES (
         $1::uuid, $2, 'Ordinary-unit acceptance carton', 'carton',
         1600, 350, 350, 200, 10000, 125,
         'USD', 'active', 'manual', 'inner',
         'measured', $3, now(), $4,
         1620, 370, 370, 'measured', $3, now(), $4, $4, $4
       ) RETURNING id::text, global_id, row_version::text`,
      [
        fixture.organizationId,
        `UNIT-BOX-${packageFixtureSuffix}`,
        `ordinary-unit-measurement-${packageFixtureSuffix}`,
        fixture.actorEmail,
      ],
    )).rows[0]

    const hybridPlan = hybrid.planHybridCartonization({
      mode: 'production',
      lines: [{ ...factMapped.line, quantity: 3 }],
      recipes: [],
      materials: [],
    })
    assert.deepEqual(plain(hybridPlan.geometryFallbackLines), [{
      lineGlobalId: exactLineGlobalId,
      productGlobalId: fixture.productGlobalId,
      quantity: 3,
      fitModel: 'unconstrained_unit',
    }])
    const materialPlan = unitMaterial.planOperationalUnitMaterialPackages({
      provider: 'shopify',
      lines: [{ ...factMapped.line, quantity: 3 }],
      fallbackLines: hybridPlan.geometryFallbackLines,
      recipePackages: [],
      materials: [{
        materialGlobalId: packageMaterial.global_id,
        materialType: 'carton',
        capturedRowVersion: Number(packageMaterial.row_version),
        currentRowVersion: Number(packageMaterial.row_version),
        isCurrent: true,
        status: 'active',
        innerDimensionsMm: { length: 1600, width: 350, height: 350 },
        dimensionBasis: 'inner',
        dimensionEvidenceType: 'measured',
        dimensionEvidenceReference: 'exact #1001 material fixture',
        dimensionConfirmedAt: '2026-08-15T00:00:00.000Z',
        tareWeightGrams: 200,
        unitCostMinor: 125,
        currency: 'USD',
        maximumGrossWeightGrams: 10000,
        availableQuantity: 1,
        ratedOuterDimensionsMm: {
          length: 1620,
          width: 370,
          height: 370,
        },
      }],
      inventoryProducts: [{
        productGlobalId: fixture.productGlobalId,
        availabilityAuthority: 'shopify_provider_commitment',
        providerCommittedQuantity: 3,
        activeReservedQuantity: 0,
        effectiveAvailableQuantity: 3,
        sourceLevelGlobalIds: ['gcil1vbvhkqodkj'],
        sourcePositionGlobalIds: ['gip1vbvhkqodkjl'],
        sourcePositionVersion: 0,
      }],
      startingSequence: 1,
      maximumPackages: 8,
    })
    assert.equal(materialPlan.status, 'ready')
    assert.equal(materialPlan.packages.length, 1)
    assert.equal(materialPlan.packages[0].allocations[0].quantity, 3)
    assert.equal(materialPlan.packages[0].contentWeightGrams, 9000)
    assert.equal(
      materialPlan.packages[0].unitMaterialEvidence.fitModel,
      'fixed_axis_regular_grid',
    )
    assert.deepEqual(
      plain(materialPlan.packages[0].innerDimensionsMm),
      { length: 1600, width: 350, height: 350 },
      'Unit-material planning must use the selected factual material dimensions',
    )
    assert.deepEqual(
      plain(materialPlan.packages[0].ratedOuterDimensionsMm),
      { length: 1620, width: 370, height: 370 },
      'Carrier dimensions must come from the material, not legacy item dimensions',
    )
    assert.equal(
      mapped.line.profile.outerDimensionsMm,
      null,
      'Legacy manual item dimensions must not become invented Product-pack geometry',
    )
    assert.equal(
      materialPlan.packages[0].planningMethod,
      'unit_material_selection',
    )

    const packageEvidenceClient = await pool.connect()
    try {
      await packageEvidenceClient.query('BEGIN')
      const writeToken = `unit-material-evidence-${randomUUID()}`
      await packageEvidenceClient.query(
        `SELECT set_config(
           'clawpilot.cartonization_evidence_write_token', $1, true
         )`,
        [writeToken],
      )
      const evidence = (await packageEvidenceClient.query(
        `INSERT INTO operations_cartonization_rate_evidence (
           organization_id, integration_account_id, order_candidate_id,
           candidate_row_version, candidate_source_hash,
           destination_fingerprint, warehouse_id, inventory_sync_run_id,
           evidence_mode, policy_version, algorithm_version,
           request_hash, plan_input_hash, plan_result_hash,
           plan_snapshot, assumption_snapshot, status,
           idempotency_key, actor_email, write_token_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           10, $4, $5, $6::uuid, NULL,
           'operational', 'ordinary-unit-postgres-acceptance-v1',
           'operational-unit-material-shared-stock-v3',
           $7, $8, $9, $10::jsonb, '{}'::jsonb, 'succeeded',
           $11, $12, $13
         ) RETURNING id::text`,
        [
          fixture.organizationId,
          fixture.accountId,
          fixture.candidateId,
          exactCandidateSourceHash,
          hash(`unit-material-destination-${packageFixtureSuffix}`),
          packageWarehouse.id,
          hash(`unit-material-request-${packageFixtureSuffix}`),
          hash(`unit-material-input-${packageFixtureSuffix}`),
          hash(`unit-material-result-${packageFixtureSuffix}`),
          JSON.stringify({ operationalUnitMaterialPlan: materialPlan }),
          `unit-material-evidence-${packageFixtureSuffix}`,
          fixture.actorEmail,
          hash(writeToken),
        ],
      )).rows[0]
      const retainedPackage = materialPlan.packages[0]
      await packageEvidenceClient.query(
        `INSERT INTO operations_cartonization_rate_evidence_packages (
           organization_id, evidence_id, package_key, package_sequence,
           planning_method, packaging_material_id, material_row_version,
           inner_dimensions_mm, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, max_weight_grams,
           allocations, carrier_parcel_snapshot, package_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4,
           'unit_material_selection', $5::uuid, $6,
           $7::jsonb, $8::jsonb, $9, $10, $11, $12,
           $13::jsonb, $14::jsonb, $15
         )`,
        [
          fixture.organizationId,
          evidence.id,
          retainedPackage.packageKey,
          retainedPackage.packageSequence,
          packageMaterial.id,
          Number(packageMaterial.row_version),
          JSON.stringify(retainedPackage.innerDimensionsMm),
          JSON.stringify(retainedPackage.ratedOuterDimensionsMm),
          retainedPackage.contentWeightGrams,
          retainedPackage.tareWeightGrams,
          retainedPackage.ratedGrossWeightGrams,
          retainedPackage.maxWeightGrams,
          JSON.stringify(retainedPackage.allocations),
          JSON.stringify({
            description: 'Ordinary-unit acceptance carton',
            dimensionUnit: 'IN',
            length: 63.78,
            width: 14.57,
            height: 14.57,
            weight: 20.28,
            weightUnit: 'LB',
          }),
          hash(JSON.stringify(retainedPackage)),
        ],
      )
      await packageEvidenceClient.query(
        `SET CONSTRAINTS
           validate_operations_cartonization_unit_material_package IMMEDIATE`,
      )
      const retained = await packageEvidenceClient.query(
        `SELECT allocations, content_weight_grams
         FROM operations_cartonization_rate_evidence_packages
         WHERE organization_id = $1::uuid
           AND evidence_id = $2::uuid
           AND package_key = $3`,
        [fixture.organizationId, evidence.id, retainedPackage.packageKey],
      )
      assert.equal(retained.rowCount, 1)
      assert.equal(retained.rows[0].allocations[0].quantity, 3)
      assert.equal(retained.rows[0].content_weight_grams, 9000)
      await packageEvidenceClient.query('SAVEPOINT line_count_tamper')
      await packageEvidenceClient.query(
        `SET CONSTRAINTS
           validate_operations_cartonization_unit_material_package DEFERRED`,
      )
      const tamperedEvidence = (await packageEvidenceClient.query(
        `INSERT INTO operations_cartonization_rate_evidence (
           organization_id, integration_account_id, order_candidate_id,
           candidate_row_version, candidate_source_hash,
           destination_fingerprint, warehouse_id, inventory_sync_run_id,
           evidence_mode, policy_version, algorithm_version,
           request_hash, plan_input_hash, plan_result_hash,
           plan_snapshot, assumption_snapshot, status,
           idempotency_key, actor_email, write_token_hash
         )
         SELECT organization_id, integration_account_id, order_candidate_id,
                candidate_row_version, candidate_source_hash,
                destination_fingerprint, warehouse_id, inventory_sync_run_id,
                evidence_mode, policy_version, algorithm_version,
                $2, $3, $4,
                pg_catalog.jsonb_set(
                  plan_snapshot,
                  '{operationalUnitMaterialPlan,evidence,dimensionedLineCount}',
                  '0'::jsonb,
                  false
                ), assumption_snapshot, status,
                $5, actor_email, write_token_hash
         FROM operations_cartonization_rate_evidence
         WHERE organization_id = $1::uuid AND id = $6::uuid
         RETURNING id::text`,
        [
          fixture.organizationId,
          hash(`unit-material-count-tamper-request-${packageFixtureSuffix}`),
          hash(`unit-material-count-tamper-input-${packageFixtureSuffix}`),
          hash(`unit-material-count-tamper-result-${packageFixtureSuffix}`),
          `unit-material-count-tamper-${packageFixtureSuffix}`,
          evidence.id,
        ],
      )).rows[0]
      await packageEvidenceClient.query(
        `INSERT INTO operations_cartonization_rate_evidence_packages (
           organization_id, evidence_id, package_key, package_sequence,
           planning_method, packaging_material_id, material_row_version,
           inner_dimensions_mm, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, max_weight_grams,
           allocations, carrier_parcel_snapshot, package_hash
         )
         SELECT organization_id, $3::uuid, package_key, package_sequence,
                planning_method, packaging_material_id, material_row_version,
                inner_dimensions_mm, rated_outer_dimensions_mm,
                content_weight_grams, tare_weight_grams,
                rated_gross_weight_grams, max_weight_grams,
                allocations, carrier_parcel_snapshot, $4
         FROM operations_cartonization_rate_evidence_packages
         WHERE organization_id = $1::uuid
           AND evidence_id = $2::uuid
           AND package_key = $5`,
        [
          fixture.organizationId,
          evidence.id,
          tamperedEvidence.id,
          hash(`unit-material-count-tamper-package-${packageFixtureSuffix}`),
          retainedPackage.packageKey,
        ],
      )
      await assert.rejects(
        packageEvidenceClient.query(
          `SET CONSTRAINTS
             validate_operations_cartonization_unit_material_package IMMEDIATE`,
        ),
        /exact retained operational evidence/,
        'PostgreSQL must derive line counts from retained package fit models',
      )
      await packageEvidenceClient.query('ROLLBACK TO SAVEPOINT line_count_tamper')
      await packageEvidenceClient.query(
        `SET CONSTRAINTS
           validate_operations_cartonization_unit_material_package IMMEDIATE`,
      )

      const assertFitEvidenceTamperRejected = async ({
        field,
        kind,
        value = null,
      }) => {
        const marker = `${field}-${kind}`
        await packageEvidenceClient.query('SAVEPOINT fit_evidence_tamper')
        try {
          await packageEvidenceClient.query(
            `SET CONSTRAINTS
               validate_operations_cartonization_unit_material_package DEFERRED`,
          )
          const tampered = (await packageEvidenceClient.query(
            `INSERT INTO operations_cartonization_rate_evidence (
               organization_id, integration_account_id, order_candidate_id,
               candidate_row_version, candidate_source_hash,
               destination_fingerprint, warehouse_id, inventory_sync_run_id,
               evidence_mode, policy_version, algorithm_version,
               request_hash, plan_input_hash, plan_result_hash,
               plan_snapshot, assumption_snapshot, status,
               idempotency_key, actor_email, write_token_hash
             )
             SELECT organization_id, integration_account_id,
                    order_candidate_id, candidate_row_version,
                    candidate_source_hash, destination_fingerprint,
                    warehouse_id, inventory_sync_run_id, evidence_mode,
                    policy_version, algorithm_version, $2, $3, $4,
                    CASE WHEN $7::boolean
                      THEN plan_snapshot #- $6::text[]
                      ELSE pg_catalog.jsonb_set(
                        plan_snapshot, $6::text[], $8::jsonb, false
                      )
                    END,
                    assumption_snapshot, status, $5,
                    actor_email, write_token_hash
             FROM operations_cartonization_rate_evidence
             WHERE organization_id = $1::uuid AND id = $9::uuid
             RETURNING id::text`,
            [
              fixture.organizationId,
              hash(`unit-material-${marker}-request-${packageFixtureSuffix}`),
              hash(`unit-material-${marker}-input-${packageFixtureSuffix}`),
              hash(`unit-material-${marker}-result-${packageFixtureSuffix}`),
              `unit-material-${marker}-${packageFixtureSuffix}`,
              [
                'operationalUnitMaterialPlan',
                'packages',
                '0',
                'unitMaterialEvidence',
                field,
              ],
              kind === 'missing',
              kind === 'null' ? 'null' : JSON.stringify(value),
              evidence.id,
            ],
          )).rows[0]
          await packageEvidenceClient.query(
            `INSERT INTO operations_cartonization_rate_evidence_packages (
               organization_id, evidence_id, package_key, package_sequence,
               planning_method, packaging_material_id, material_row_version,
               inner_dimensions_mm, rated_outer_dimensions_mm,
               content_weight_grams, tare_weight_grams,
               rated_gross_weight_grams, max_weight_grams,
               allocations, carrier_parcel_snapshot, package_hash
             )
             SELECT organization_id, $3::uuid, package_key,
                    package_sequence, planning_method, packaging_material_id,
                    material_row_version, inner_dimensions_mm,
                    rated_outer_dimensions_mm, content_weight_grams,
                    tare_weight_grams, rated_gross_weight_grams,
                    max_weight_grams, allocations,
                    carrier_parcel_snapshot, $4
             FROM operations_cartonization_rate_evidence_packages
             WHERE organization_id = $1::uuid
               AND evidence_id = $2::uuid
               AND package_key = $5`,
            [
              fixture.organizationId,
              evidence.id,
              tampered.id,
              hash(`unit-material-${marker}-package-${packageFixtureSuffix}`),
              retainedPackage.packageKey,
            ],
          )
          await assert.rejects(
            packageEvidenceClient.query(
              `SET CONSTRAINTS
                 validate_operations_cartonization_unit_material_package IMMEDIATE`,
            ),
            /unit-material .*evidence is invalid/i,
            `PostgreSQL 18 must reject ${kind} ${field} fit evidence`,
          )
        } finally {
          await packageEvidenceClient.query(
            'ROLLBACK TO SAVEPOINT fit_evidence_tamper',
          )
          await packageEvidenceClient.query(
            'RELEASE SAVEPOINT fit_evidence_tamper',
          )
        }
      }
      for (const field of [
        'unitWeightGrams',
        'weightCapacityUnits',
        'spatialCapacityUnits',
        'effectiveCapacityUnits',
      ]) {
        for (const kind of ['missing', 'null', 'wrong-type']) {
          await assertFitEvidenceTamperRejected({
            field,
            kind,
            value: String(retainedPackage.unitMaterialEvidence[field]),
          })
        }
      }
    } finally {
      await packageEvidenceClient.query('ROLLBACK')
      packageEvidenceClient.release()
    }
  } finally {
    await pool.end()
  }
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container =
    `clawpilot-legacy-unit-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=legacy_unit',
      '-e', 'POSTGRES_DB=legacy_unit',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg18',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:legacy_unit@127.0.0.1:${port}/legacy_unit`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrations()
      const migrationIndex = files.indexOf(migrationName)
      assert.ok(migrationIndex > 0, `${migrationName} is missing`)
      for (const file of files.slice(0, migrationIndex)) {
        await applyMigration(client, file)
      }
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
    'Legacy #1001 material cartonization and unit-weight trigger PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
