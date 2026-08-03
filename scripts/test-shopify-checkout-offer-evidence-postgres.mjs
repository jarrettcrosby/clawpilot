#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

const TRUSTED_PROJECT_ID = 'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
const TRUSTED_ENVIRONMENT_ID = 'e4abd95f-825c-4242-b37b-825a92597e98'
const TRUSTED_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
const TARGET_MIGRATION =
  '0164_shopify_checkout_offer_parcel_evidence.sql'

function fail(message) {
  throw new Error(message)
}

function requireTrustedEnvironment() {
  if (
    String(process.env.RAILWAY_PROJECT_ID || '') !== TRUSTED_PROJECT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_ID || '')
      !== TRUSTED_ENVIRONMENT_ID
    || String(process.env.RAILWAY_ENVIRONMENT_NAME || '') !== 'development'
  ) {
    fail(
      'Shopify offer-evidence acceptance is restricted to the trusted Railway development environment.',
    )
  }
}

function migrationSql() {
  return readFileSync(
    fileURLToPath(
      new URL(`../db/migrations/${TARGET_MIGRATION}`, import.meta.url),
    ),
    'utf8',
  )
}

let databaseUrl = String(
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '',
).trim()
if (!databaseUrl) {
  fail('DATABASE_PUBLIC_URL or DATABASE_URL is required.')
}
requireTrustedEnvironment()

let parsedUrl = new URL(databaseUrl)
if (parsedUrl.hostname.endsWith('.railway.internal')) {
  const databaseVariables = JSON.parse(execFileSync(
    'railway',
    [
      'variables',
      '--service',
      'Postgres',
      '--environment',
      'development',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  ))
  databaseUrl = String(databaseVariables.DATABASE_PUBLIC_URL || '').trim()
  if (!databaseUrl) {
    fail('The Railway Postgres public validation URL is unavailable.')
  }
  parsedUrl = new URL(databaseUrl)
}
parsedUrl.searchParams.delete('sslmode')
const pool = new Pool({
  connectionString: parsedUrl.toString(),
  ssl: parsedUrl.hostname.endsWith('rlwy.net')
    ? { rejectUnauthorized: false }
    : undefined,
  application_name: 'clawpilot-shopify-offer-evidence-rollback-acceptance',
  max: 2,
  connectionTimeoutMillis: 15_000,
  query_timeout: 120_000,
})

async function databaseFingerprint(client) {
  const result = await client.query(
    `SELECT (
       SELECT value ->> 'id'
       FROM app_settings
       WHERE key = 'deployment.database.identity'
     ) AS database_fingerprint`,
  )
  return result.rows[0]?.database_fingerprint || null
}

async function migrationApplied(client) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE filename = $1
     ) AS applied`,
    [TARGET_MIGRATION],
  )
  return result.rows[0]?.applied === true
}

async function repairObjectState(client) {
  const result = await client.query(
    `SELECT
       to_regprocedure(
         'operations_shopify_checkout_carrier_request_parcel_snapshot(text,integer,integer,integer,integer,integer)'
       )::text AS parcel_snapshot_function,
       to_regprocedure(
         'operations_shopify_checkout_carrier_parcels_match(uuid,uuid,jsonb)'
       )::text AS parcels_match_function,
       to_regprocedure(
         'protect_operations_shopify_checkout_rate_receipt_offer()'
       )::text AS offer_guard_function,
       (
         SELECT pg_get_triggerdef(trigger.oid)
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname =
             'operations_shopify_checkout_rate_receipt_offers'
           AND trigger.tgname =
             'protect_operations_shopify_checkout_rate_receipt_offer_write'
           AND NOT trigger.tgisinternal
       ) AS offer_trigger`,
  )
  return result.rows[0]
}

async function sourceReceipt(client) {
  const result = await client.query(
    `SELECT receipt.id::text, receipt.global_id
     FROM operations_shopify_checkout_rate_receipts receipt
     WHERE receipt.status = 'failed'
       AND receipt.error_code = 'P0001'
       AND receipt.line_count = 1
       AND (
         SELECT count(DISTINCT request.provider)
         FROM operations_carrier_rate_requests request
         WHERE request.organization_id = receipt.organization_id
           AND request.status = 'succeeded'
           AND request.purpose = 'cartonization_shipment_rate'
           AND request.requested_at >= receipt.created_at
           AND request.completed_at
             <= receipt.created_at + interval '30 seconds'
       ) = 2
     ORDER BY receipt.created_at DESC
     LIMIT 1`,
  )
  if (!result.rows[0]) {
    fail(
      'A retained failed checkout receipt with successful UPS and FedEx evidence is required.',
    )
  }
  return result.rows[0]
}

async function assertCanonicalParcelShapes(client) {
  const result = await client.query(
    `SELECT
       operations_shopify_checkout_carrier_request_parcel_snapshot(
         'approved_recipe', 1, 292, 229, 203, 261
       ) AS carton,
       operations_shopify_checkout_carrier_request_parcel_snapshot(
         'self_package', 2, 279, 229, 178, 2268
       ) AS sealed_case`,
  )
  assert.deepEqual(result.rows[0].carton, {
    description: 'ClawPilot carton 1',
    length: 12,
    width: 10,
    height: 8,
    dimensionUnit: 'IN',
    weight: 0.6,
    weightUnit: 'LB',
  })
  assert.deepEqual(result.rows[0].sealed_case, {
    description: 'ClawPilot sealed case 2',
    length: 11,
    width: 10,
    height: 8,
    dimensionUnit: 'IN',
    weight: 5.1,
    weightUnit: 'LB',
  })
}

async function cloneProcessingReceipt(client, sourceReceiptId) {
  const result = await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipts (
       organization_id,
       integration_account_id,
       config_id,
       config_row_version,
       credential_generation,
       activation_revision,
       activation_state,
       policy_revision,
       policy_hash,
       warehouse_id,
       algorithm_version,
       request_fingerprint,
       destination_fingerprint,
       carrier_destination_fingerprint,
       line_quantity_fingerprint,
       request_evidence_hash,
       redacted_request_snapshot,
       currency,
       idempotency_key,
       status,
       lease_token,
       lease_expires_at,
       claimed_by,
       attempt_count,
       line_count,
       inventory_snapshot_hash,
       inventory_snapshot_at,
       reconciliation_window_seconds,
       reconciliation_deadline_at,
       created_at,
       updated_at
     )
     SELECT
       source.organization_id,
       source.integration_account_id,
       source.config_id,
       source.config_row_version,
       source.credential_generation,
       source.activation_revision,
       source.activation_state,
       source.policy_revision,
       source.policy_hash,
       source.warehouse_id,
       source.algorithm_version,
       source.request_fingerprint,
       source.destination_fingerprint,
       source.carrier_destination_fingerprint,
       source.line_quantity_fingerprint,
       source.request_evidence_hash,
       source.redacted_request_snapshot,
       source.currency,
       'rollback-offer-evidence-' || gen_random_uuid()::text,
       'processing',
       gen_random_uuid(),
       now() + interval '5 minutes',
       'test:shopify-offer-evidence',
       1,
       source.line_count,
       encode(digest(gen_random_uuid()::text, 'sha256'), 'hex'),
       now(),
       source.reconciliation_window_seconds,
       source.created_at
         + make_interval(secs => source.reconciliation_window_seconds),
       source.created_at,
       source.created_at
     FROM operations_shopify_checkout_rate_receipts source
     WHERE source.id = $1::uuid
     RETURNING id::text, global_id, organization_id::text, config_id::text`,
    [sourceReceiptId],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function cloneReceiptLine(client, sourceReceiptId, receiptId) {
  const result = await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_lines (
       organization_id,
       receipt_id,
       line_key,
       provider_variant_id,
       sku,
       quantity,
       unit_weight_grams,
       requires_shipping,
       line_hash,
       line_snapshot
     )
     SELECT
       organization_id,
       $2::uuid,
       line_key,
       provider_variant_id,
       sku,
       quantity,
       unit_weight_grams,
       requires_shipping,
       line_hash,
       line_snapshot
     FROM operations_shopify_checkout_rate_receipt_lines
     WHERE receipt_id = $1::uuid`,
    [sourceReceiptId, receiptId],
  )
  assert.equal(result.rowCount, 1)
}

async function insertMatchingCarton(client, receiptId) {
  const result = await client.query(
    `WITH receipt AS (
       SELECT *
       FROM operations_shopify_checkout_rate_receipts
       WHERE id = $1::uuid
     ),
     retained_line AS (
       SELECT *
       FROM operations_shopify_checkout_rate_receipt_lines
       WHERE receipt_id = $1::uuid
     ),
     source_parcel AS (
       SELECT request.redacted_request #>
         '{shipment,parcels,0}' AS parcel
       FROM receipt
       JOIN operations_carrier_rate_requests request
         ON request.organization_id = receipt.organization_id
        AND request.provider = 'fedex_rest'
        AND request.status = 'succeeded'
        AND request.purpose = 'cartonization_shipment_rate'
        AND request.requested_at >= receipt.created_at
        AND request.completed_at
          <= receipt.created_at + interval '30 seconds'
       ORDER BY request.requested_at DESC
       LIMIT 1
     ),
     material AS (
       SELECT
         selected.packaging_material_id,
         selected.packaging_material_row_version,
         stock.id AS stock_id,
         stock.row_version AS stock_row_version,
         stock.on_hand_quantity,
         material.rated_outer_length_mm,
         material.rated_outer_width_mm,
         material.rated_outer_height_mm,
         material.tare_weight_grams
       FROM receipt
       JOIN operations_shopify_carrier_service_config_materials selected
         ON selected.organization_id = receipt.organization_id
        AND selected.config_id = receipt.config_id
       JOIN operations_packaging_materials material
         ON material.organization_id = selected.organization_id
        AND material.id = selected.packaging_material_id
       JOIN operations_packaging_material_stock stock
         ON stock.organization_id = material.organization_id
        AND stock.packaging_material_id = material.id
        AND stock.warehouse_id = receipt.warehouse_id
       CROSS JOIN retained_line
       CROSS JOIN source_parcel
       WHERE stock.is_available = true
         AND stock.on_hand_quantity > 0
         AND ceil(material.rated_outer_length_mm::numeric / 25.4)::integer
           = (source_parcel.parcel->>'length')::integer
         AND ceil(material.rated_outer_width_mm::numeric / 25.4)::integer
           = (source_parcel.parcel->>'width')::integer
         AND ceil(material.rated_outer_height_mm::numeric / 25.4)::integer
           = (source_parcel.parcel->>'height')::integer
         AND greatest(
           0.1::numeric,
           ceil(
             (
               (
                 retained_line.unit_weight_grams
                   * retained_line.quantity
                   + material.tare_weight_grams
               )::numeric / 453.59237::numeric
             ) * 10
           ) / 10
         ) = (source_parcel.parcel->>'weight')::numeric
       ORDER BY selected.selection_sequence
       LIMIT 1
     )
     INSERT INTO operations_shopify_checkout_rate_receipt_packages (
       organization_id,
       receipt_id,
       package_key,
       package_sequence,
       planning_method,
       packaging_material_id,
       packaging_material_row_version,
       packaging_material_stock_id,
       packaging_material_stock_row_version,
       packaging_material_stock_on_hand_quantity,
       rated_outer_length_mm,
       rated_outer_width_mm,
       rated_outer_height_mm,
       content_weight_grams,
       tare_weight_grams,
       gross_weight_grams,
       allocation_count,
       package_hash,
       package_snapshot
     )
     SELECT
       receipt.organization_id,
       receipt.id,
       'rollback-package-1',
       1,
       'approved_recipe',
       material.packaging_material_id,
       material.packaging_material_row_version,
       material.stock_id,
       material.stock_row_version,
       material.on_hand_quantity,
       material.rated_outer_length_mm,
       material.rated_outer_width_mm,
       material.rated_outer_height_mm,
       retained_line.unit_weight_grams * retained_line.quantity,
       material.tare_weight_grams,
       retained_line.unit_weight_grams * retained_line.quantity
         + material.tare_weight_grams,
       1,
       encode(digest('rollback-package-1', 'sha256'), 'hex'),
       jsonb_build_object('acceptanceFixture', true)
     FROM receipt
     CROSS JOIN retained_line
     CROSS JOIN material
     RETURNING organization_id::text`,
    [receiptId],
  )
  assert.equal(
    result.rowCount,
    1,
    'The retained carrier parcel must resolve to one selected current carton.',
  )
}

async function insertAllocation(client, receiptId) {
  const result = await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_allocations (
       organization_id,
       receipt_id,
       package_key,
       line_key,
       quantity,
       allocation_hash
     )
     SELECT
       package.organization_id,
       package.receipt_id,
       package.package_key,
       line.line_key,
       line.quantity,
       encode(digest('rollback-allocation-1', 'sha256'), 'hex')
     FROM operations_shopify_checkout_rate_receipt_packages package
     JOIN operations_shopify_checkout_rate_receipt_lines line
       ON line.organization_id = package.organization_id
      AND line.receipt_id = package.receipt_id
     WHERE package.receipt_id = $1::uuid`,
    [receiptId],
  )
  assert.equal(result.rowCount, 1)
}

async function assertDynamicMultiPackageEvidence(
  client,
  organizationId,
  receiptId,
) {
  await client.query('SAVEPOINT multi_package_evidence')
  try {
    const inserted = await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
         organization_id,
         receipt_id,
         package_key,
         package_sequence,
         planning_method,
         packaging_material_id,
         packaging_material_row_version,
         packaging_material_stock_id,
         packaging_material_stock_row_version,
         packaging_material_stock_on_hand_quantity,
         rated_outer_length_mm,
         rated_outer_width_mm,
         rated_outer_height_mm,
         content_weight_grams,
         tare_weight_grams,
         gross_weight_grams,
         allocation_count,
         package_hash,
         package_snapshot
       )
       SELECT
         organization_id,
         receipt_id,
         'rollback-package-2',
         2,
         planning_method,
         packaging_material_id,
         packaging_material_row_version,
         packaging_material_stock_id,
         packaging_material_stock_row_version,
         packaging_material_stock_on_hand_quantity,
         rated_outer_length_mm,
         rated_outer_width_mm,
         rated_outer_height_mm,
         content_weight_grams,
         tare_weight_grams,
         gross_weight_grams,
         allocation_count,
         encode(digest('rollback-package-2', 'sha256'), 'hex'),
         jsonb_build_object('acceptanceFixture', true)
       FROM operations_shopify_checkout_rate_receipt_packages
       WHERE receipt_id = $1::uuid
         AND package_key = 'rollback-package-1'
       RETURNING package_key`,
      [receiptId],
    )
    assert.equal(inserted.rowCount, 1)
    const expectedParcels = [
      {
        description: 'ClawPilot carton 1',
        length: 12,
        width: 10,
        height: 8,
        dimensionUnit: 'IN',
        weight: 0.6,
        weightUnit: 'LB',
      },
      {
        description: 'ClawPilot carton 2',
        length: 12,
        width: 10,
        height: 8,
        dimensionUnit: 'IN',
        weight: 0.6,
        weightUnit: 'LB',
      },
    ]
    const matched = await client.query(
      `SELECT operations_shopify_checkout_carrier_parcels_match(
         $1::uuid,
         $2::uuid,
         $3::jsonb
       ) AS matches`,
      [organizationId, receiptId, JSON.stringify(expectedParcels)],
    )
    assert.equal(
      matched.rows[0].matches,
      true,
      'The exact checkout parcel array must scale with cartonization output.',
    )
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT multi_package_evidence')
  }
}

async function insertExactOffers(client, receiptId) {
  const result = await client.query(
    `WITH receipt AS (
       SELECT *
       FROM operations_shopify_checkout_rate_receipts
       WHERE id = $1::uuid
     ),
     evidence AS (
       SELECT DISTINCT ON (request.provider)
         request.*
       FROM receipt
       JOIN operations_carrier_rate_requests request
         ON request.organization_id = receipt.organization_id
        AND request.status = 'succeeded'
        AND request.purpose = 'cartonization_shipment_rate'
        AND request.requested_at >= receipt.created_at
        AND request.completed_at
          <= receipt.created_at + interval '30 seconds'
       ORDER BY request.provider, request.requested_at DESC
     ),
     selected_rate AS (
       SELECT
         evidence.*,
         rate.value
       FROM evidence
       JOIN LATERAL (
         SELECT rate.value
         FROM jsonb_array_elements(evidence.redacted_response->'rates')
           rate(value)
         ORDER BY (rate.value->>'amount')::numeric,
           rate.value->>'serviceCode'
         LIMIT 1
       ) rate ON true
     )
     INSERT INTO operations_shopify_checkout_rate_receipt_offers (
       organization_id,
       receipt_id,
       carrier_provider,
       carrier_account_id,
       carrier_rate_request_id,
       carrier_request_hash,
       carrier_response_rate_hash,
       shopify_service_code,
       service_code,
       service_name,
       carrier_cost_minor,
       customer_charge_minor,
       currency,
       package_count,
       package_plan_hash,
       offer_hash,
       offer_snapshot
     )
     SELECT
       receipt.organization_id,
       receipt.id,
       selected_rate.provider,
       selected_rate.carrier_account_id,
       selected_rate.id,
       selected_rate.request_hash,
       encode(digest(selected_rate.value::text, 'sha256'), 'hex'),
       'clawpilot:'
         || CASE selected_rate.provider
              WHEN 'ups_rest' THEN 'ups'
              ELSE 'fedex'
            END
         || ':' || lower(selected_rate.value->>'serviceCode'),
       lower(selected_rate.value->>'serviceCode'),
       selected_rate.value->>'serviceName',
       ((selected_rate.value->>'amount')::numeric * 100)::bigint,
       ((selected_rate.value->>'amount')::numeric * 100)::bigint,
       upper(selected_rate.value->>'currency'),
       1,
       encode(digest('rollback-package-plan', 'sha256'), 'hex'),
       encode(
         digest(
           'rollback-offer-' || selected_rate.provider,
           'sha256'
         ),
         'hex'
       ),
       jsonb_build_object(
         'acceptanceFixture', true,
         'rateEvidenceGlobalId', selected_rate.global_id
       )
     FROM receipt
     CROSS JOIN selected_rate
     RETURNING carrier_provider`,
    [receiptId],
  )
  assert.deepEqual(
    result.rows.map((row) => row.carrier_provider).sort(),
    ['fedex_rest', 'ups_rest'],
    'Both exact UPS and FedEx offers must pass the repaired trigger.',
  )
}

async function assertInvalidAmountFailsClosed(client, receiptId) {
  await client.query('SAVEPOINT expected_offer_rejection')
  try {
    await client.query(
      `WITH receipt AS (
         SELECT *
         FROM operations_shopify_checkout_rate_receipts
         WHERE id = $1::uuid
       ),
       evidence AS (
         SELECT request.*
         FROM receipt
         JOIN operations_carrier_rate_requests request
           ON request.organization_id = receipt.organization_id
          AND request.provider = 'ups_rest'
          AND request.status = 'succeeded'
          AND request.purpose = 'cartonization_shipment_rate'
          AND request.requested_at >= receipt.created_at
          AND request.completed_at
            <= receipt.created_at + interval '30 seconds'
         ORDER BY request.requested_at DESC
         LIMIT 1
       ),
       selected_rate AS (
         SELECT evidence.*, rate.value
         FROM evidence
         JOIN LATERAL (
           SELECT rate.value
           FROM jsonb_array_elements(evidence.redacted_response->'rates')
             rate(value)
           ORDER BY (rate.value->>'amount')::numeric
           LIMIT 1
         ) rate ON true
       )
       INSERT INTO operations_shopify_checkout_rate_receipt_offers (
         organization_id,
         receipt_id,
         carrier_provider,
         carrier_account_id,
         carrier_rate_request_id,
         carrier_request_hash,
         carrier_response_rate_hash,
         shopify_service_code,
         service_code,
         service_name,
         carrier_cost_minor,
         customer_charge_minor,
         currency,
         package_count,
         package_plan_hash,
         offer_hash,
         offer_snapshot
       )
       SELECT
         receipt.organization_id,
         receipt.id,
         selected_rate.provider,
         selected_rate.carrier_account_id,
         selected_rate.id,
         selected_rate.request_hash,
         encode(digest(selected_rate.value::text, 'sha256'), 'hex'),
         'clawpilot:ups:amount-mismatch',
         lower(selected_rate.value->>'serviceCode'),
         selected_rate.value->>'serviceName',
         ((selected_rate.value->>'amount')::numeric * 100)::bigint + 1,
         ((selected_rate.value->>'amount')::numeric * 100)::bigint + 1,
         upper(selected_rate.value->>'currency'),
         1,
         encode(digest('rollback-package-plan', 'sha256'), 'hex'),
         encode(digest('rollback-invalid-offer', 'sha256'), 'hex'),
         jsonb_build_object('acceptanceFixture', true)
       FROM receipt
       CROSS JOIN selected_rate`,
      [receiptId],
    )
    assert.fail('A carrier amount mismatch must fail closed.')
  } catch (error) {
    assert.equal(error.code, 'P0001')
    assert.match(
      error.message,
      /requires exact configured carrier and rate evidence/,
    )
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_offer_rejection')
  }
}

async function main() {
  const client = await pool.connect()
  let beforeObjects
  let source
  try {
    assert.equal(
      await databaseFingerprint(client),
      TRUSTED_DATABASE_FINGERPRINT,
      'connected database is not the trusted ClawPilot development database',
    )
    assert.equal(
      await migrationApplied(client),
      false,
      `${TARGET_MIGRATION} is already permanently applied`,
    )
    beforeObjects = await repairObjectState(client)
    assert.equal(beforeObjects.parcel_snapshot_function, null)
    assert.equal(beforeObjects.parcels_match_function, null)
    assert.equal(beforeObjects.offer_guard_function, null)
    assert.match(
      beforeObjects.offer_trigger,
      /protect_operations_shopify_checkout_rate_receipt_child/,
    )
    source = await sourceReceipt(client)

    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(migrationSql())
    await assertCanonicalParcelShapes(client)

    const cloned = await cloneProcessingReceipt(client, source.id)
    await cloneReceiptLine(client, source.id, cloned.id)
    await insertMatchingCarton(client, cloned.id)
    await insertAllocation(client, cloned.id)
    await assertDynamicMultiPackageEvidence(
      client,
      cloned.organization_id,
      cloned.id,
    )

    const exactProviderParcels = await client.query(
      `SELECT bool_and(
         operations_shopify_checkout_carrier_parcels_match(
           receipt.organization_id,
           receipt.id,
           request.redacted_request #> '{shipment,parcels}'
         )
       ) AS matches
       FROM operations_shopify_checkout_rate_receipts receipt
       JOIN operations_carrier_rate_requests request
         ON request.organization_id = receipt.organization_id
        AND request.status = 'succeeded'
        AND request.purpose = 'cartonization_shipment_rate'
        AND request.requested_at >= receipt.created_at
        AND request.completed_at
          <= receipt.created_at + interval '30 seconds'
       WHERE receipt.id = $1::uuid`,
      [cloned.id],
    )
    assert.equal(exactProviderParcels.rows[0].matches, true)
    const driftedProviderParcels = await client.query(
      `SELECT bool_or(
         operations_shopify_checkout_carrier_parcels_match(
           receipt.organization_id,
           receipt.id,
           jsonb_set(
             request.redacted_request #> '{shipment,parcels}',
             '{0,weight}',
             to_jsonb(
               (
                 request.redacted_request #>>
                   '{shipment,parcels,0,weight}'
               )::numeric + 0.1
             )
           )
         )
       ) AS matches
       FROM operations_shopify_checkout_rate_receipts receipt
       JOIN operations_carrier_rate_requests request
         ON request.organization_id = receipt.organization_id
        AND request.status = 'succeeded'
        AND request.purpose = 'cartonization_shipment_rate'
        AND request.requested_at >= receipt.created_at
        AND request.completed_at
          <= receipt.created_at + interval '30 seconds'
       WHERE receipt.id = $1::uuid`,
      [cloned.id],
    )
    assert.equal(
      driftedProviderParcels.rows[0].matches,
      false,
      'A one-tenth-pound package drift must fail the exact parcel match.',
    )

    await insertExactOffers(client, cloned.id)
    await assertInvalidAmountFailsClosed(client, cloned.id)
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  const verification = await pool.connect()
  try {
    assert.equal(
      await databaseFingerprint(verification),
      TRUSTED_DATABASE_FINGERPRINT,
    )
    assert.equal(await migrationApplied(verification), false)
    assert.deepEqual(
      await repairObjectState(verification),
      beforeObjects,
      'Rollback left checkout offer-evidence schema residue.',
    )
  } finally {
    verification.release()
    await pool.end()
  }

  console.log(JSON.stringify({
    ok: true,
    acceptance: 'rollback-only-postgres',
    databaseFingerprint: TRUSTED_DATABASE_FINGERPRINT,
    targetMigration: TARGET_MIGRATION,
    sourceReceiptGlobalId: source.global_id,
    exactProviderOffersAccepted: ['ups_rest', 'fedex_rest'],
    dynamicMultiPackageEvidenceAccepted: true,
    packageDriftRejected: true,
    invalidAmountRejected: true,
    retainedSchemaOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
