#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  '0174_operations_shopify_checkout_provider_attempts.sql'
const ACCEPTANCE_ACTOR =
  'test:shopify-checkout-provider-attempts'
const ACCEPTANCE_ADAPTER =
  'shopify-provider-attempt-rollback-acceptance'
const DEGRADED_FAILURE_CODE = 'CHECKOUT_RATE_DEADLINE_EXCEEDED'
const PACKAGE_PLAN_HASH = createHash('sha256')
  .update('shopify-provider-attempt-rollback-package-plan')
  .digest('hex')

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
      'Shopify provider-attempt acceptance is restricted to the trusted Railway development environment.',
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

function migrationChecksum() {
  return createHash('sha256').update(migrationSql()).digest('hex')
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
  application_name:
    'clawpilot-shopify-provider-attempt-rollback-acceptance',
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

async function migrationObjectState(client) {
  const result = await client.query(
    `SELECT
       to_regclass(
         'operations_shopify_checkout_rate_receipt_provider_attempts'
       )::text AS attempt_table,
       to_regprocedure(
         'protect_op_shopify_checkout_provider_attempt()'
       )::text AS attempt_guard_function,
       to_regprocedure(
         'validate_op_shopify_checkout_attempt_finalization()'
       )::text AS finalization_guard_function,
       (
         SELECT pg_get_triggerdef(trigger.oid)
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname =
             'operations_shopify_checkout_rate_receipt_provider_attempts'
           AND trigger.tgname =
             'protect_op_shopify_checkout_provider_attempt_write'
           AND NOT trigger.tgisinternal
       ) AS attempt_trigger,
       (
         SELECT pg_get_triggerdef(trigger.oid)
         FROM pg_trigger trigger
         JOIN pg_class relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname =
             'operations_shopify_checkout_rate_receipts'
           AND trigger.tgname =
             'validate_op_shopify_checkout_attempt_finalization'
           AND NOT trigger.tgisinternal
       ) AS finalization_trigger`,
  )
  return result.rows[0]
}

async function acceptanceResidue(client) {
  const result = await client.query(
    `SELECT
       (
         SELECT count(*)::integer
         FROM operations_shopify_checkout_rate_receipts
         WHERE claimed_by = $1
       ) AS receipt_count,
       (
         SELECT count(*)::integer
         FROM operations_carrier_rate_requests
         WHERE adapter_version = $2
       ) AS carrier_evidence_count`,
    [ACCEPTANCE_ACTOR, ACCEPTANCE_ADAPTER],
  )
  return result.rows[0]
}

async function sourceReceipt(client) {
  const prerequisite = await client.query(
    `SELECT
       to_regprocedure(
         'operations_shopify_checkout_carrier_parcels_match(uuid,uuid,jsonb)'
       )::text AS parcels_match_function`,
  )
  assert.ok(
    prerequisite.rows[0]?.parcels_match_function,
    'Migration 0164 exact carrier-parcel evidence must already be applied.',
  )
  const result = await client.query(
    `SELECT
       receipt.id::text,
       receipt.global_id,
       receipt.created_at
     FROM operations_shopify_checkout_rate_receipts receipt
     WHERE receipt.status = 'failed'
       AND receipt.error_code = 'P0001'
       AND receipt.line_count = 1
       AND operations_shopify_carrier_service_config_is_ready(
         receipt.organization_id,
         receipt.config_id
       )
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
      'A retained failed checkout receipt with exact successful UPS and FedEx evidence is required.',
    )
  }
  return result.rows[0]
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
       config.integration_account_id,
       source.config_id,
       config.row_version,
       config.credential_generation,
       activation.revision,
       activation.state,
       config.policy_revision,
       config.policy_hash,
       config.warehouse_id,
       config.algorithm_version,
       source.request_fingerprint,
       source.destination_fingerprint,
       source.carrier_destination_fingerprint,
       source.line_quantity_fingerprint,
       source.request_evidence_hash,
       source.redacted_request_snapshot,
       source.currency,
       'rollback-provider-attempt-' || gen_random_uuid()::text,
       'processing',
       gen_random_uuid(),
       now() + interval '5 minutes',
       $2,
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
     JOIN operations_shopify_carrier_service_configs config
       ON config.organization_id = source.organization_id
      AND config.id = source.config_id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = source.organization_id
     WHERE source.id = $1::uuid
     RETURNING
       id::text,
       global_id,
       organization_id::text,
       config_id::text`,
    [sourceReceiptId, ACCEPTANCE_ACTOR],
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
       'rollback-provider-attempt-package-1',
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
       encode(
         digest('rollback-provider-attempt-package-1', 'sha256'),
         'hex'
       ),
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
    'The retained provider parcel must resolve to one current selected carton.',
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
       encode(
         digest('rollback-provider-attempt-allocation-1', 'sha256'),
         'hex'
       )
     FROM operations_shopify_checkout_rate_receipt_packages package
     JOIN operations_shopify_checkout_rate_receipt_lines line
       ON line.organization_id = package.organization_id
      AND line.receipt_id = package.receipt_id
     WHERE package.receipt_id = $1::uuid`,
    [receiptId],
  )
  assert.equal(result.rowCount, 1)
}

async function assertExactProviderParcels(client, receiptId) {
  const result = await client.query(
    `SELECT
       count(DISTINCT request.provider)::integer AS provider_count,
       bool_and(
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
    [receiptId],
  )
  assert.equal(result.rows[0].provider_count, 2)
  assert.equal(
    result.rows[0].matches,
    true,
    'Both retained carrier requests must match the exact cloned parcel.',
  )
}

async function createFailedFedExEvidence(client, receiptId) {
  const result = await client.query(
    `WITH receipt AS (
       SELECT *
       FROM operations_shopify_checkout_rate_receipts
       WHERE id = $1::uuid
     ),
     source AS (
       SELECT request.*
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
     )
     INSERT INTO operations_carrier_rate_requests (
       organization_id,
       integration_account_id,
       carrier_account_id,
       provider,
       environment,
       purpose,
       adapter_version,
       credential_version,
       request_hash,
       billing_relationship,
       billing_selection_snapshot,
       redacted_request,
       redacted_response,
       status,
       provider_reference,
       error_code,
       actor_email,
       requested_at,
       completed_at
     )
     SELECT
       source.organization_id,
       source.integration_account_id,
       source.carrier_account_id,
       source.provider,
       source.environment,
       source.purpose,
       $2,
       source.credential_version,
       source.request_hash,
       source.billing_relationship,
       source.billing_selection_snapshot,
       source.redacted_request,
       jsonb_build_object(
         'rateScope', 'multi_package_shipment',
         'packageCount',
           source.redacted_request #> '{shipment,packageCount}',
         'errorCode', $3::text
       ),
       'failed',
       NULL,
       $3::text,
       NULL,
       source.requested_at,
       source.completed_at
     FROM source
     RETURNING id::text, global_id`,
    [receiptId, ACCEPTANCE_ADAPTER, DEGRADED_FAILURE_CODE],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function carrierEvidence(client, receiptId, provider) {
  const result = await client.query(
    `SELECT request.id::text, request.global_id
     FROM operations_shopify_checkout_rate_receipts receipt
     JOIN operations_carrier_rate_requests request
       ON request.organization_id = receipt.organization_id
      AND request.provider = $2
      AND request.status = 'succeeded'
      AND request.purpose = 'cartonization_shipment_rate'
      AND request.requested_at >= receipt.created_at
      AND request.completed_at
        <= receipt.created_at + interval '30 seconds'
     WHERE receipt.id = $1::uuid
     ORDER BY request.requested_at DESC
     LIMIT 1`,
    [receiptId, provider],
  )
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function insertProviderAttempt(client, {
  receiptId,
  evidenceGlobalId,
  status,
  failureCode,
}) {
  return client.query(
    `INSERT INTO
       operations_shopify_checkout_rate_receipt_provider_attempts (
         organization_id,
         receipt_id,
         carrier_provider,
         carrier_account_id,
         carrier_rate_request_id,
         carrier_rate_purpose,
         carrier_request_hash,
         attempt_status,
         failure_code,
         attempt_hash,
         attempt_snapshot
       )
     SELECT
       receipt.organization_id,
       receipt.id,
       evidence.provider,
       evidence.carrier_account_id,
       evidence.id,
       evidence.purpose,
       evidence.request_hash,
       $3::text,
       $4::text,
       encode(
         digest(
           'rollback-provider-attempt-' || evidence.provider || '-' || $3::text,
           'sha256'
         ),
         'hex'
       ),
       jsonb_build_object(
         'acceptanceFixture', true,
         'rateEvidenceGlobalId', evidence.global_id,
         'status', $3::text,
         'failureCode', $4::text
       )
     FROM operations_shopify_checkout_rate_receipts receipt
     JOIN operations_carrier_rate_requests evidence
       ON evidence.organization_id = receipt.organization_id
      AND evidence.global_id = $2
     WHERE receipt.id = $1::uuid
     RETURNING carrier_provider, attempt_status, failure_code`,
    [receiptId, evidenceGlobalId, status, failureCode],
  )
}

async function insertOffer(client, receiptId, provider) {
  const result = await client.query(
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
        AND request.provider = $2
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
       $3,
       encode(
         digest(
           'rollback-provider-attempt-offer-'
             || selected_rate.provider,
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
    [receiptId, provider, PACKAGE_PLAN_HASH],
  )
  assert.equal(result.rowCount, 1)
  assert.equal(result.rows[0].carrier_provider, provider)
}

async function finalizeReceipt(client, receiptId, offerCount = 1) {
  return client.query(
    `UPDATE operations_shopify_checkout_rate_receipts receipt
     SET status = 'succeeded',
         lease_token = NULL,
         lease_expires_at = NULL,
         package_count = 1,
         offer_count = $3::integer,
         package_plan_hash = $2,
         result_hash = encode(
           digest('rollback-provider-attempt-result', 'sha256'),
           'hex'
         ),
         result_snapshot = jsonb_build_object(
           'protocolVersion',
             'shopify-carrier-service-response-v3-acceptance',
           'acceptanceFixture', true
         ),
         error_code = NULL,
         completed_at = now(),
         expires_at = now() + interval '5 minutes',
         updated_at = now()
     WHERE receipt.id = $1::uuid
     RETURNING receipt.global_id, receipt.status`,
    [receiptId, PACKAGE_PLAN_HASH, offerCount],
  )
}

async function expectDatabaseRejection(
  client,
  savepoint,
  action,
  messagePattern,
) {
  await client.query(`SAVEPOINT ${savepoint}`)
  try {
    await action()
    assert.fail(`Expected ${savepoint} to fail closed.`)
  } catch (error) {
    assert.equal(error.code, 'P0001')
    assert.match(error.message, messagePattern)
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  }
}

async function assertSuccessfulDegradedReceipt(client, receiptId) {
  const result = await client.query(
    `SELECT
       receipt.status,
       receipt.package_count,
       receipt.offer_count,
       jsonb_agg(
         jsonb_build_object(
           'provider', attempt.carrier_provider,
           'status', attempt.attempt_status,
           'failureCode', attempt.failure_code,
           'rateEvidenceStatus', evidence.status,
           'rateEvidenceErrorCode', evidence.error_code
         )
         ORDER BY attempt.carrier_provider
       ) AS attempts,
       (
         SELECT jsonb_agg(offer.carrier_provider)
         FROM operations_shopify_checkout_rate_receipt_offers offer
         WHERE offer.organization_id = receipt.organization_id
           AND offer.receipt_id = receipt.id
       ) AS offer_providers
     FROM operations_shopify_checkout_rate_receipts receipt
     JOIN operations_shopify_checkout_rate_receipt_provider_attempts attempt
       ON attempt.organization_id = receipt.organization_id
      AND attempt.receipt_id = receipt.id
     JOIN operations_carrier_rate_requests evidence
       ON evidence.organization_id = attempt.organization_id
      AND evidence.id = attempt.carrier_rate_request_id
     WHERE receipt.id = $1::uuid
     GROUP BY receipt.id`,
    [receiptId],
  )
  assert.equal(result.rowCount, 1)
  assert.equal(result.rows[0].status, 'succeeded')
  assert.equal(result.rows[0].package_count, 1)
  assert.equal(result.rows[0].offer_count, 1)
  assert.deepEqual(result.rows[0].attempts, [
    {
      provider: 'fedex_rest',
      status: 'degraded',
      failureCode: DEGRADED_FAILURE_CODE,
      rateEvidenceStatus: 'failed',
      rateEvidenceErrorCode: DEGRADED_FAILURE_CODE,
    },
    {
      provider: 'ups_rest',
      status: 'succeeded',
      failureCode: null,
      rateEvidenceStatus: 'succeeded',
      rateEvidenceErrorCode: null,
    },
  ])
  assert.deepEqual(result.rows[0].offer_providers, ['ups_rest'])
}

async function main() {
  const client = await pool.connect()
  let beforeObjects
  let beforeResidue
  let source
  let cloned
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
    beforeObjects = await migrationObjectState(client)
    assert.deepEqual(beforeObjects, {
      attempt_table: null,
      attempt_guard_function: null,
      finalization_guard_function: null,
      attempt_trigger: null,
      finalization_trigger: null,
    })
    beforeResidue = await acceptanceResidue(client)
    assert.deepEqual(beforeResidue, {
      receipt_count: 0,
      carrier_evidence_count: 0,
    })
    source = await sourceReceipt(client)

    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '120s'`)
    await client.query(`SET LOCAL lock_timeout = '15s'`)
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('clawpilot-schema-migrations')
       )`,
    )
    await client.query(migrationSql())
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [TARGET_MIGRATION, migrationChecksum()],
    )
    assert.equal(
      await migrationApplied(client),
      true,
      'The target migration history row must exist inside acceptance.',
    )
    const appliedObjects = await migrationObjectState(client)
    assert.equal(
      appliedObjects.attempt_table,
      'operations_shopify_checkout_rate_receipt_provider_attempts',
    )
    assert.ok(appliedObjects.attempt_guard_function)
    assert.ok(appliedObjects.finalization_guard_function)
    assert.match(
      appliedObjects.attempt_trigger,
      /protect_op_shopify_checkout_provider_attempt/,
    )
    assert.match(
      appliedObjects.finalization_trigger,
      /validate_op_shopify_checkout_attempt_finalization/,
    )

    cloned = await cloneProcessingReceipt(client, source.id)
    await cloneReceiptLine(client, source.id, cloned.id)
    await insertMatchingCarton(client, cloned.id)
    await insertAllocation(client, cloned.id)
    await assertExactProviderParcels(client, cloned.id)

    const upsEvidence = await carrierEvidence(
      client,
      cloned.id,
      'ups_rest',
    )
    const fedexSuccessEvidence = await carrierEvidence(
      client,
      cloned.id,
      'fedex_rest',
    )
    const fedexFailedEvidence = await createFailedFedExEvidence(
      client,
      cloned.id,
    )

    const upsAttempt = await insertProviderAttempt(client, {
      receiptId: cloned.id,
      evidenceGlobalId: upsEvidence.global_id,
      status: 'succeeded',
      failureCode: null,
    })
    assert.equal(upsAttempt.rowCount, 1)
    await insertOffer(client, cloned.id, 'ups_rest')

    await expectDatabaseRejection(
      client,
      'missing_provider_attempt',
      () => finalizeReceipt(client, cloned.id),
      /provider-attempt evidence is incomplete/,
    )

    await expectDatabaseRejection(
      client,
      'mismatched_failure_evidence',
      () => insertProviderAttempt(client, {
        receiptId: cloned.id,
        evidenceGlobalId: fedexFailedEvidence.global_id,
        status: 'degraded',
        failureCode: 'CHECKOUT_RATE_WRONG_FAILURE',
      }),
      /requires exact configured carrier and rate evidence/,
    )

    await client.query('SAVEPOINT mismatched_offer_linkage')
    try {
      const degradedAttempt = await insertProviderAttempt(client, {
        receiptId: cloned.id,
        evidenceGlobalId: fedexFailedEvidence.global_id,
        status: 'degraded',
        failureCode: DEGRADED_FAILURE_CODE,
      })
      assert.equal(degradedAttempt.rowCount, 1)
      await insertOffer(client, cloned.id, 'fedex_rest')
      await assert.rejects(
        finalizeReceipt(client, cloned.id, 2),
        (error) => (
          error.code === 'P0001'
          && /provider-attempt evidence is incomplete/.test(error.message)
        ),
      )
    } finally {
      await client.query(
        'ROLLBACK TO SAVEPOINT mismatched_offer_linkage',
      )
      await client.query('RELEASE SAVEPOINT mismatched_offer_linkage')
    }

    const degradedAttempt = await insertProviderAttempt(client, {
      receiptId: cloned.id,
      evidenceGlobalId: fedexFailedEvidence.global_id,
      status: 'degraded',
      failureCode: DEGRADED_FAILURE_CODE,
    })
    assert.equal(degradedAttempt.rowCount, 1)
    const finalized = await finalizeReceipt(client, cloned.id)
    assert.equal(finalized.rowCount, 1)
    await assertSuccessfulDegradedReceipt(client, cloned.id)

    assert.notEqual(
      fedexSuccessEvidence.global_id,
      fedexFailedEvidence.global_id,
      'Degraded and successful FedEx evidence must remain distinct.',
    )
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
    assert.equal(
      await migrationApplied(verification),
      false,
      'Rollback retained the target migration history row.',
    )
    assert.deepEqual(
      await migrationObjectState(verification),
      beforeObjects,
      'Rollback left provider-attempt schema residue.',
    )
    assert.deepEqual(
      await acceptanceResidue(verification),
      beforeResidue,
      'Rollback left provider-attempt acceptance data residue.',
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
    acceptanceReceiptGlobalId: cloned.global_id,
    successfulProvider: 'ups_rest',
    degradedProvider: 'fedex_rest',
    missingAttemptRejected: true,
    mismatchedFailureEvidenceRejected: true,
    mismatchedOfferLinkageRejected: true,
    successfulDegradedReceiptAccepted: true,
    retainedSchemaHistoryOrData: false,
  }, null, 2))
}

main().catch(async (error) => {
  await pool.end().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
