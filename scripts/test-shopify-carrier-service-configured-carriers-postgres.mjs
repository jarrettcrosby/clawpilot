#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const migration = '0285_shopify_carrier_service_configured_carriers.sql'
const diagnosticMigration = '0286_carrier_shipping_account_diagnostics.sql'
const registeredRateSourceMigration =
  '0292_shopify_registered_rate_source_refresh.sql'
const checkoutRateControlMigration =
  '0299_operations_shopify_checkout_rate_control.sql'

const repeatHex = (digit) => String(digit).repeat(64)

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
      `INSERT INTO app_users (email, role, status)
       VALUES ('carrier-fixture@example.com', 'owner', 'active')`,
    )
    await client.query(
      `INSERT INTO workspace_organizations (
         id, name, organization_type, created_by, updated_by
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         'Carrier fixture organization', 'root',
         'carrier-fixture@example.com', 'carrier-fixture@example.com'
       )`,
    )
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
         'active', '{"allowedCapabilities":["sandbox_rate"]}'::jsonb,
         NULL, 0
       ),
       (
         '28500000-0000-4000-8000-000000000030'::uuid,
         'giah00000000003',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'fedex_rest', 'carrier', 'sandbox', 'Carrier fixture FedEx',
         'active', '{"allowedCapabilities":["sandbox_rate"]}'::jsonb,
         NULL, 0
       ),
       (
         '28500000-0000-4000-8000-000000000025'::uuid,
         'giah00000000004',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'ups_rest', 'carrier', 'production',
         'Carrier fixture UPS production', 'active',
         '{"allowedCapabilities":["production_rate"]}'::jsonb,
         NULL, 0
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
       ),
       (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000025'::uuid,
         decode('03', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex'), 1, '0025', '0025',
         'verified', now(),
         operations_carrier_credential_fingerprint(
           1, decode('03', 'hex'), decode(repeat('00', 12), 'hex'),
           decode(repeat('00', 16), 'hex')
         ), 'oauth_client_credentials', '0025'
       )`,
    )
    await client.query(
      `INSERT INTO operations_warehouses (
         id, global_id, organization_id, code, name, address, status
       ) VALUES (
         '28500000-0000-4000-8000-000000000040'::uuid,
         'gwhh00000000001',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'CS-READY', 'Carrier readiness warehouse',
         '{
           "line1":"1 Test Street",
           "city":"Hartford",
           "region":"CT",
           "postalCode":"06103",
           "countryCode":"US"
         }'::jsonb,
         'active'
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
       ),
       (
         '28500000-0000-4000-8000-000000000071'::uuid,
         'gach00000000003',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         'Carrier fixture UPS 2', 'Carrier fixture UPS 2',
         'ciphertext', 'iv', 'tag', '0012',
         repeat('e', 64), $1::jsonb, repeat('1', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000072'::uuid,
         'gach00000000004',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         'Carrier fixture UPS 3', 'Carrier fixture UPS 3',
         'ciphertext', 'iv', 'tag', '0022',
         repeat('1', 64), $1::jsonb, repeat('2', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000073'::uuid,
         'gach00000000005',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         'Carrier fixture UPS 4', 'Carrier fixture UPS 4',
         'ciphertext', 'iv', 'tag', '0032',
         repeat('3', 64), $1::jsonb, repeat('3', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000074'::uuid,
         'gach00000000006',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000030'::uuid,
         'Carrier fixture FedEx 2', 'Carrier fixture FedEx 2',
         'ciphertext', 'iv', 'tag', '0013',
         repeat('f', 64), $1::jsonb, repeat('4', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000075'::uuid,
         'gach00000000007',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000030'::uuid,
         'Carrier fixture FedEx 3', 'Carrier fixture FedEx 3',
         'ciphertext', 'iv', 'tag', '0023',
         repeat('2', 64), $1::jsonb, repeat('5', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000076'::uuid,
         'gach00000000008',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000030'::uuid,
         'Carrier fixture FedEx 4', 'Carrier fixture FedEx 4',
         'ciphertext', 'iv', 'tag', '0033',
         repeat('4', 64), $1::jsonb, repeat('6', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000077'::uuid,
         'gach00000000009',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         'Carrier fixture UPS 5', 'Carrier fixture UPS 5',
         'ciphertext', 'iv', 'tag', '0042',
         repeat('5', 64), $1::jsonb, repeat('7', 64), 'active'
       ),
       (
         '28500000-0000-4000-8000-000000000078'::uuid,
         'gach00000000010',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000025'::uuid,
         'Carrier fixture UPS production',
         'Carrier fixture UPS production',
         'ciphertext', 'iv', 'tag', '0025',
         repeat('6', 64), $1::jsonb, repeat('8', 64), 'active'
       )`,
      [registeredAddress],
    )
    await client.query(
      `INSERT INTO operations_carrier_accounts (
         id, global_id, organization_id, integration_account_id,
         display_name, sender_name,
         account_number_ciphertext, account_number_iv,
         account_number_tag, account_number_last_four,
         account_number_fingerprint, registered_address,
         registered_address_fingerprint, status
       )
       SELECT
         (
           '28500000-0000-4000-8000-'
           || lpad((100 + series)::text, 12, '0')
         )::uuid,
         'gac' || lpad((100 + series)::text, 12, '0'),
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000025'::uuid,
         'Carrier fixture UPS production ' || series,
         'Carrier fixture UPS production ' || series,
         'ciphertext-' || series,
         'iv-' || series,
         'tag-' || series,
         lpad((100 + series)::text, 4, '0'),
         md5('production-account-a-' || series)
           || md5('production-account-b-' || series),
         $1::jsonb,
         md5('production-address-a-' || series)
           || md5('production-address-b-' || series),
         'active'
       FROM generate_series(1, 8) AS generated(series)`,
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
           },
           "checkoutRateControl": {
             "version": "shopify-checkout-rate-control-v1",
             "audience": "restricted_customers",
             "rateSource": "sandbox"
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

async function seedHistoricalPre0285Fixture(client) {
  const createdAt = new Date(Date.now() - 60_000)
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipts (
         id, global_id, organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, policy_revision, policy_hash, warehouse_id,
         algorithm_version, request_fingerprint, destination_fingerprint,
         carrier_destination_fingerprint, line_quantity_fingerprint,
         request_evidence_hash, redacted_request_snapshot, currency,
         idempotency_key, status, line_count, package_count, offer_count,
         package_plan_hash, result_hash, result_snapshot,
         inventory_snapshot_hash, inventory_snapshot_at,
         reconciliation_window_seconds, reconciliation_deadline_at,
         expires_at, completed_at, created_at, updated_at
       ) VALUES (
         '28500000-0000-4000-8000-000000000200'::uuid,
         'gsqr2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         1, 1, 1, 'shadow', 1, repeat('f', 64),
         '28500000-0000-4000-8000-000000000040'::uuid,
         'disposable-one-or-two-carriers-v1', repeat('1', 64),
         repeat('2', 64), repeat('3', 64), repeat('4', 64),
         repeat('5', 64), '{}'::jsonb, 'USD',
         'historical-pre-0285-receipt', 'succeeded', 1, 1, 2,
         repeat('6', 64), repeat('7', 64), '{}'::jsonb,
         repeat('8', 64), $1::timestamptz,
         86400, $1::timestamptz + interval '86400 seconds',
         $1::timestamptz + interval '15 minutes',
         $1::timestamptz + interval '5 seconds',
         $1::timestamptz, $1::timestamptz + interval '5 seconds'
       )`,
      [createdAt],
    )
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_offers (
         organization_id, receipt_id, carrier_provider,
         carrier_account_id, carrier_rate_request_id,
         carrier_rate_purpose, carrier_request_hash,
         carrier_response_rate_hash, shopify_service_code,
         service_code, service_name, carrier_cost_minor,
         customer_charge_minor, checkout_adjustment_minor,
         checkout_adjustment_kind, currency, package_count,
         package_plan_hash, offer_hash, offer_snapshot
       ) VALUES
       (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000200'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000070'::uuid,
         '28500000-0000-4000-8000-000000000210'::uuid,
         'cartonization_shipment_rate', repeat('a', 64), repeat('b', 64),
         'clawpilot:ups:03', '03', 'UPS Ground',
         1000, 1000, 0, 'none', 'USD', 1, repeat('6', 64),
         repeat('c', 64), '{}'::jsonb
       ),
       (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000200'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000070'::uuid,
         '28500000-0000-4000-8000-000000000211'::uuid,
         'cartonization_shipment_rate', repeat('d', 64), repeat('e', 64),
         'clawpilot:ups:02', '02', 'UPS 2nd Day Air',
         1100, 1100, 0, 'none', 'USD', 1, repeat('6', 64),
         repeat('9', 64), '{}'::jsonb
       )`,
    )
    await client.query(
      `INSERT INTO operations_pack_rate_runs (
         id, global_id, organization_id, replay_group_key, scenario_id,
         source_kind, source_reference, provider, checkout_source, purpose,
         prior_checkout_run_id, customer_resolution_outcome, status,
         policy_version, algorithm_version, input_hash, result_hash,
         input_snapshot, result_snapshot, stage_snapshot,
         line_count, package_count, rate_choice_count, currency,
         selected_provider, selected_service_code, selected_service_name,
         selected_carrier_cost_minor, customer_charge_minor,
         mud_markup_minor, margin_minor, idempotency_key, actor_email,
         expires_at, created_at
       ) VALUES
       (
         '28500000-0000-4000-8000-000000000220'::uuid,
         'gprr2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'historical-pre-0285-checkout', 'historical-pre-0285',
         'provider_checkout', 'gsqr2850100', 'shopify',
         'live_callback_recorded', 'checkout_quote', NULL,
         'not_attempted', 'succeeded', 'policy-v1', 'algorithm-v1',
         repeat('1', 64), repeat('2', 64), '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, 1, 1, 2, 'USD', 'ups_rest', '03', 'UPS Ground',
         1000, 1000, NULL, 0, 'historical-pre-0285-checkout',
         'carrier-fixture@example.com',
         $1::timestamptz + interval '15 minutes', $1::timestamptz
       ),
       (
         '28500000-0000-4000-8000-000000000221'::uuid,
         'gprr2850101',
         '28500000-0000-4000-8000-000000000001'::uuid,
         'historical-pre-0285-fulfillment', 'historical-pre-0285',
         'provider_checkout', 'gsqr2850100', 'shopify',
         'live_callback_recorded', 'fulfillment_execution',
         '28500000-0000-4000-8000-000000000220'::uuid,
         'not_attempted', 'succeeded', 'policy-v1', 'algorithm-v1',
         repeat('3', 64), repeat('4', 64), '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, 1, 1, 2, 'USD', 'ups_rest', '02',
         'UPS 2nd Day Air', 1100, 1000, NULL, -100,
         'historical-pre-0285-fulfillment',
         'carrier-fixture@example.com', NULL, $1::timestamptz
       )`,
      [createdAt],
    )
    await client.query(
      `INSERT INTO operations_pack_rate_run_rate_choices (
         organization_id, run_id, provider, service_code, service_name,
         carrier_cost_minor, currency, selected, recorded_fact_version,
         normalized_response
       ) VALUES
       ('28500000-0000-4000-8000-000000000001'::uuid,
        '28500000-0000-4000-8000-000000000220'::uuid,
        'ups_rest', '03', 'UPS Ground', 1000, 'USD', true,
        'historical-v1', '{}'::jsonb),
       ('28500000-0000-4000-8000-000000000001'::uuid,
        '28500000-0000-4000-8000-000000000220'::uuid,
        'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD', false,
        'historical-v1', '{}'::jsonb),
       ('28500000-0000-4000-8000-000000000001'::uuid,
        '28500000-0000-4000-8000-000000000221'::uuid,
        'ups_rest', '03', 'UPS Ground', 1000, 'USD', false,
        'historical-v1', '{}'::jsonb),
       ('28500000-0000-4000-8000-000000000001'::uuid,
        '28500000-0000-4000-8000-000000000221'::uuid,
        'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD', true,
        'historical-v1', '{}'::jsonb)`,
    )
    await client.query(
      `INSERT INTO operations_orders (
         id, global_id, organization_id, pipeline_id, customer_id,
         integration_account_id, source_provider, external_order_id,
         order_number, status, currency, merchandise_total_minor,
         ship_to, source_payload
       ) VALUES (
         '28500000-0000-4000-8000-000000000231'::uuid,
         'gor2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000281'::uuid,
         '28500000-0000-4000-8000-000000000282'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         'shopify', 'historical-order-2850100', 'HIST-2850100',
         'packed', 'USD', 1000,
         '{"line1":"10 Destination Street","city":"Hartford","region":"CT","postalCode":"06103","country":"US"}'::jsonb,
         '{}'::jsonb
       )`,
    )
    await client.query(
      `INSERT INTO operations_fulfillment_plans (
         id, global_id, organization_id, order_id, warehouse_id,
         status, method, solver_status, estimated_cost_minor,
         promised_delivery_at, explanation
       ) VALUES (
         '28500000-0000-4000-8000-000000000232'::uuid,
         'gfp2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000231'::uuid,
         '28500000-0000-4000-8000-000000000040'::uuid,
         'released', 'optimizer', 'optimal', 1100,
         $1::timestamptz + interval '3 days', '{}'::jsonb
       )`,
      [createdAt],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_executions (
         id, global_id, organization_id, order_id, plan_id,
         checkout_pack_rate_run_id, fulfillment_pack_rate_run_id,
         shopify_checkout_receipt_id, authority_mode, state,
         idempotency_key, request_hash, prepared_by, prepared_at,
         updated_at, completed_at
       ) VALUES (
         '28500000-0000-4000-8000-000000000230'::uuid,
         'gofe2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000231'::uuid,
         '28500000-0000-4000-8000-000000000232'::uuid,
         '28500000-0000-4000-8000-000000000220'::uuid,
         '28500000-0000-4000-8000-000000000221'::uuid,
         '28500000-0000-4000-8000-000000000200'::uuid,
         'shadow', 'shadow_prepared', 'historical-pre-0285-execution',
         repeat('5', 64), 'carrier-fixture@example.com',
         $1::timestamptz, $1::timestamptz, $1::timestamptz
       )`,
      [createdAt],
    )
    await client.query(
      `INSERT INTO operations_carrier_rate_requests (
         id, global_id, organization_id, integration_account_id,
         carrier_account_id, provider, environment, purpose,
         adapter_version, credential_version, request_hash,
         billing_relationship, billing_selection_snapshot,
         redacted_request, redacted_response, status, provider_reference,
         error_code, actor_email, requested_at, completed_at
       ) VALUES (
         '28500000-0000-4000-8000-000000000233'::uuid,
         'grq2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         '28500000-0000-4000-8000-000000000070'::uuid,
         'ups_rest', 'sandbox', 'cartonization_shipment_rate',
         'historical-v1', 1, repeat('6', 64), 'sender', '{}'::jsonb,
         '{}'::jsonb, '{}'::jsonb, 'succeeded',
         'historical-provider-reference', NULL,
         'carrier-fixture@example.com', $1::timestamptz,
         $1::timestamptz + interval '1 second'
       )`,
      [createdAt],
    )
    await client.query(
      `INSERT INTO operations_fulfillment_execution_rate_attempts (
         organization_id, execution_id, carrier_provider,
         fulfillment_pack_rate_run_id, carrier_account_id,
         carrier_rate_request_id, carrier_rate_purpose,
         carrier_request_hash, environment, attempt_status,
         failure_code, selected
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000230'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000221'::uuid,
         '28500000-0000-4000-8000-000000000070'::uuid,
         '28500000-0000-4000-8000-000000000233'::uuid,
         'cartonization_shipment_rate', repeat('6', 64),
         'sandbox', 'succeeded', NULL, true
       )`,
    )
    await client.query(
      `INSERT INTO operations_shipment_groups (
         id, global_id, organization_id, fulfillment_execution_id,
         order_id, plan_id, warehouse_id, fulfillment_pack_rate_run_id,
         selected_provider, selected_service_code, selected_service_name,
         selected_carrier_cost_minor, currency, state,
         prepared_at, updated_at, completed_at
       ) VALUES (
         '28500000-0000-4000-8000-000000000240'::uuid,
         'gshg2850100',
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000230'::uuid,
         '28500000-0000-4000-8000-000000000231'::uuid,
         '28500000-0000-4000-8000-000000000232'::uuid,
         '28500000-0000-4000-8000-000000000040'::uuid,
         '28500000-0000-4000-8000-000000000221'::uuid,
         'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD',
         'shadow_prepared', $1::timestamptz, $1::timestamptz,
         $1::timestamptz
       )`,
      [createdAt],
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

async function isEnvironmentReady(client, environment) {
  const result = await client.query(
    `SELECT
       operations_shopify_carrier_service_config_environment_is_ready(
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         $1
       ) AS ready`,
    [environment],
  )
  return result.rows[0]?.ready === true
}

function checkoutCarrierSelectionKey(receiptGlobalId, accountGlobalId) {
  return crypto.createHash('sha256').update(
    `shopify-checkout-carrier-selection-v1|${receiptGlobalId}|${accountGlobalId}`,
  ).digest('hex')
}

async function seedProcessingReceipt(client, {
  id,
  globalId,
  activationState,
  rateSource = activationState === 'active' ? 'production' : 'sandbox',
  carrierDestinationFingerprint,
  idempotencyKey,
}) {
  const createdAt = new Date()
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipts (
         id, global_id, organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, rate_source, policy_revision, policy_hash, warehouse_id,
         algorithm_version, request_fingerprint, destination_fingerprint,
         carrier_destination_fingerprint, line_quantity_fingerprint,
         request_evidence_hash, redacted_request_snapshot, currency,
         idempotency_key, status, lease_token, lease_expires_at, claimed_by,
         line_count, inventory_snapshot_hash, inventory_snapshot_at,
         reconciliation_window_seconds, reconciliation_deadline_at,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2,
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         1, 1, 1, $3, $7, 1, repeat('f', 64),
         '28500000-0000-4000-8000-000000000040'::uuid,
         'disposable-one-or-two-carriers-v1', repeat('1', 64),
         repeat('2', 64), $4, repeat('3', 64), repeat('4', 64),
         '{}'::jsonb, 'USD', $5, 'processing', gen_random_uuid(),
         $6::timestamptz + interval '5 minutes',
         'disposable-postgres-acceptance', 1, repeat('5', 64),
         $6::timestamptz, 86400,
         $6::timestamptz + interval '86400 seconds',
         $6::timestamptz, $6::timestamptz
       )`,
      [
        id,
        globalId,
        activationState,
        carrierDestinationFingerprint,
        idempotencyKey,
        createdAt,
        rateSource,
      ],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  return createdAt
}

async function runLegacyReceiptInsertCompatibilityAcceptance(client) {
  const receiptId = '28500000-0000-4000-8000-000000000099'
  const createdAt = new Date()
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET registration_state = 'registered',
           service_gid = 'gid://shopify/DeliveryCarrierService/299'
       WHERE organization_id =
           '28500000-0000-4000-8000-000000000001'::uuid
         AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  try {
    const inserted = await client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipts (
         id, organization_id, integration_account_id, config_id,
         config_row_version, credential_generation, activation_revision,
         activation_state, policy_revision, policy_hash, warehouse_id,
         algorithm_version, request_fingerprint, destination_fingerprint,
         carrier_destination_fingerprint, line_quantity_fingerprint,
         request_evidence_hash, redacted_request_snapshot, currency,
         idempotency_key, status, lease_token, lease_expires_at, claimed_by,
         line_count, inventory_snapshot_hash, inventory_snapshot_at,
         reconciliation_window_seconds, reconciliation_deadline_at,
         created_at, updated_at
       ) VALUES (
         $1::uuid, '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000010'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         1, 1, 1, 'shadow', 1, repeat('f', 64),
         '28500000-0000-4000-8000-000000000040'::uuid,
         'disposable-one-or-two-carriers-v1', repeat('1', 64),
         repeat('2', 64), repeat('9', 64), repeat('3', 64), repeat('4', 64),
         '{}'::jsonb, 'USD', 'configured-carrier-legacy-writer-receipt',
         'processing', gen_random_uuid(),
         $2::timestamptz + interval '5 minutes',
         'legacy-disposable-postgres-acceptance', 1, repeat('5', 64),
         $2::timestamptz, 86400,
         $2::timestamptz + interval '86400 seconds',
         $2::timestamptz, $2::timestamptz
       )
       RETURNING rate_source, status`,
      [receiptId, createdAt],
    )
    assert.deepEqual(
      inserted.rows,
      [{ rate_source: 'sandbox', status: 'processing' }],
      'The actual receipt table must accept an old callback shape and derive the exact saved TEST source',
    )
  } finally {
    await client.query('SET session_replication_role = replica')
    try {
      await client.query(
        `DELETE FROM operations_shopify_checkout_rate_receipts
         WHERE id = $1::uuid`,
        [receiptId],
      )
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET registration_state = 'shadow_simulated', service_gid = NULL
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      )
    } finally {
      await client.query('SET session_replication_role = origin')
    }
  }
}

async function insertCallbackRateEvidence(client, {
  provider = 'ups_rest',
  environment,
  integrationAccountId,
  carrierAccountId,
  carrierDestinationFingerprint,
  requestedAt,
  carrierSelectionKey = null,
  actorEmail = null,
  requestSuffix,
}) {
  const requestHash = crypto.createHash('sha256')
    .update(`configured-carrier-${requestSuffix}`)
    .digest('hex')
  const result = await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       organization_id, integration_account_id, carrier_account_id,
       provider, environment, purpose, adapter_version,
       credential_version, request_hash, billing_relationship,
       billing_selection_snapshot, redacted_request, redacted_response,
       status, provider_reference, error_code, actor_email,
       requested_at, completed_at, carrier_selection_key
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, $2::uuid, $3, $4, 'cartonization_shipment_rate',
       'configured-carrier-postgres-v1', 1, $5, 'sender', '{}'::jsonb,
       jsonb_build_object(
         'shipment', jsonb_build_object(
           'destinationFingerprint', $6::text,
           'rateScope', 'multi_package_shipment',
           'packageCount', 1,
           'parcels', jsonb_build_array()
         )
       ),
       jsonb_build_object(
         'rateScope', 'multi_package_shipment',
         'packageCount', 1,
         'rates', jsonb_build_array()
       ),
       'succeeded', $7, NULL, $8,
       $9::timestamptz, $9::timestamptz + interval '1 second', $10
     )
     RETURNING id::text, global_id, request_hash, carrier_selection_key`,
    [
      integrationAccountId,
      carrierAccountId,
      provider,
      environment,
      requestHash,
      carrierDestinationFingerprint,
      `configured-carrier-${requestSuffix}`,
      actorEmail,
      new Date(requestedAt.getTime() + 1_000),
      carrierSelectionKey,
    ],
  )
  return result.rows[0]
}

async function runReceiptAttemptAcceptance(client, {
  receiptId,
  receiptGlobalId,
  activationState,
  rateSource,
  environment,
  integrationAccountId,
  carrierAccountId,
  carrierAccountGlobalId,
  provider,
  packageCode,
  serviceCode,
  serviceName,
  amountMinor,
  destinationFingerprint,
  idempotencyKey,
}) {
  const createdAt = await seedProcessingReceipt(client, {
    id: receiptId,
    globalId: receiptGlobalId,
    activationState,
    rateSource,
    carrierDestinationFingerprint: destinationFingerprint,
    idempotencyKey,
  })
  const parcel = {
    description: 'ClawPilot carton 1',
    length: 9,
    width: 7,
    height: 5,
    dimensionUnit: 'IN',
    weight: 2.5,
    weightUnit: 'LB',
    packageCode,
  }
  const rate = {
    serviceCode,
    serviceName,
    amount: (amountMinor / 100).toFixed(2),
    currency: 'USD',
  }
  const requestHash = crypto.createHash('sha256')
    .update(`receipt-attempt:${receiptGlobalId}:${carrierAccountGlobalId}`)
    .digest('hex')
  const evidence = await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       organization_id, integration_account_id, carrier_account_id,
       provider, environment, purpose, adapter_version,
       credential_version, request_hash, billing_relationship,
       billing_selection_snapshot, redacted_request, redacted_response,
       status, provider_reference, error_code, actor_email,
       requested_at, completed_at, carrier_selection_key
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, $2::uuid, $3, $4, 'cartonization_shipment_rate',
       'configured-carrier-postgres-v1', 1, $5, 'sender', '{}'::jsonb,
       jsonb_build_object(
         'shipment', jsonb_build_object(
           'destinationFingerprint', $6::text,
           'rateScope', 'multi_package_shipment',
           'packageCount', 1,
           'parcels', $7::jsonb
         )
       ),
       jsonb_build_object(
         'rateScope', 'multi_package_shipment',
         'packageCount', 1,
         'rates', $8::jsonb
       ),
       'succeeded', $9, NULL, NULL,
       $10::timestamptz, $10::timestamptz + interval '1 second', NULL
     )
     RETURNING id::text, global_id, request_hash, carrier_selection_key`,
    [
      integrationAccountId,
      carrierAccountId,
      provider,
      environment,
      requestHash,
      destinationFingerprint,
      JSON.stringify([parcel]),
      JSON.stringify([rate]),
      `receipt-attempt-${receiptGlobalId}`,
      new Date(createdAt.getTime() + 1_000),
    ],
  )
  const retainedEvidence = evidence.rows[0]
  assert.equal(
    retainedEvidence.carrier_selection_key,
    checkoutCarrierSelectionKey(receiptGlobalId, carrierAccountGlobalId),
    `${environment} evidence must retain its exact receipt/account key`,
  )

  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
       organization_id, receipt_id, package_key, package_sequence,
       packaging_material_id, packaging_material_row_version,
       packaging_material_stock_id, packaging_material_stock_row_version,
       packaging_material_stock_on_hand_quantity,
       rated_outer_length_mm, rated_outer_width_mm, rated_outer_height_mm,
       content_weight_grams, tare_weight_grams, gross_weight_grams,
       allocation_count, package_hash, package_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'package-1', 1,
       '28500000-0000-4000-8000-000000000050'::uuid, 1,
       '28500000-0000-4000-8000-000000000060'::uuid, 1, 10,
       210, 160, 110, 1000, 100, 1100, 1, repeat('a', 64),
       '{}'::jsonb
     )`,
    [receiptId],
  )
  const parcelMatches = await client.query(
    `SELECT
       operations_shopify_checkout_carrier_parcels_match(
         '28500000-0000-4000-8000-000000000001'::uuid,
         $1::uuid, $2::jsonb
       ) AS provider_match,
       operations_shopify_checkout_carrier_parcels_match(
         '28500000-0000-4000-8000-000000000001'::uuid,
         $1::uuid, $3::jsonb
       ) AS alternate_provider_match,
       operations_shopify_checkout_carrier_parcels_match(
         '28500000-0000-4000-8000-000000000001'::uuid,
         $1::uuid, $4::jsonb
       ) AS altered_dimensions_match,
       operations_shopify_checkout_carrier_parcels_match(
         '28500000-0000-4000-8000-000000000001'::uuid,
         $1::uuid, $5::jsonb
       ) AS altered_weight_match`,
    [
      receiptId,
      JSON.stringify([parcel]),
      JSON.stringify([{
        ...parcel,
        packageCode: packageCode === '02' ? 'YOUR_PACKAGING' : '02',
      }]),
      JSON.stringify([{ ...parcel, length: parcel.length + 1 }]),
      JSON.stringify([{ ...parcel, weight: parcel.weight + 0.1 }]),
    ],
  )
  assert.deepEqual(
    parcelMatches.rows[0],
    {
      provider_match: true,
      alternate_provider_match: true,
      altered_dimensions_match: false,
      altered_weight_match: false,
    },
    'UPS and FedEx package codes may differ, but dimensions and weight must remain exact',
  )

  const responseRateHash = await client.query(
    `SELECT encode(digest(($1::jsonb)::text, 'sha256'), 'hex') AS hash`,
    [JSON.stringify(rate)],
  )
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_offers (
       organization_id, receipt_id, carrier_provider,
       carrier_account_id, carrier_rate_request_id,
       carrier_rate_purpose, carrier_request_hash,
       carrier_response_rate_hash, shopify_service_code,
       service_code, service_name, carrier_cost_minor,
       customer_charge_minor, checkout_adjustment_minor,
       checkout_adjustment_kind, currency, package_count,
       package_plan_hash, offer_hash, offer_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, $2, $3::uuid, $4::uuid,
       'cartonization_shipment_rate', $5, $6,
       $7, $8, $9, $10::bigint, $10::bigint, 0, 'none',
       'USD', 1, repeat('b', 64), repeat('c', 64), '{}'::jsonb
     )`,
    [
      receiptId,
      provider,
      carrierAccountId,
      retainedEvidence.id,
      retainedEvidence.request_hash,
      responseRateHash.rows[0].hash,
      `clawpilot:${provider === 'ups_rest' ? 'ups' : 'fedex'}:${serviceCode}`,
      serviceCode,
      serviceName,
      amountMinor,
    ],
  )
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_provider_attempts (
       organization_id, receipt_id, carrier_provider, carrier_account_id,
       carrier_rate_request_id, carrier_rate_purpose,
       carrier_request_hash, attempt_status, failure_code,
       attempt_hash, attempt_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, $2, $3::uuid, $4::uuid,
       'cartonization_shipment_rate', $5, 'succeeded', NULL,
       repeat('d', 64), '{}'::jsonb
     )`,
    [
      receiptId,
      provider,
      carrierAccountId,
      retainedEvidence.id,
      retainedEvidence.request_hash,
    ],
  )
  await client.query(
    `ALTER TABLE operations_shopify_checkout_rate_receipts
       ENABLE ALWAYS TRIGGER
       validate_op_shopify_checkout_attempt_finalization`,
  )
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `UPDATE operations_shopify_checkout_rate_receipts
       SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
           package_count = 1, offer_count = 1,
           package_plan_hash = repeat('b', 64),
           result_hash = repeat('e', 64), result_snapshot = '{}'::jsonb,
           expires_at = now() + interval '15 minutes',
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [receiptId],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
  return {
    receiptId,
    receiptGlobalId,
    evidenceId: retainedEvidence.id,
    evidenceGlobalId: retainedEvidence.global_id,
  }
}

async function runDegradedReceiptAttemptAcceptance(client) {
  const receiptId = '28500000-0000-4000-8000-000000000095'
  const receiptGlobalId = 'gsqr2850005'
  const destinationFingerprint = repeatHex('a')
  const createdAt = await seedProcessingReceipt(client, {
    id: receiptId,
    globalId: receiptGlobalId,
    activationState: 'shadow',
    carrierDestinationFingerprint: destinationFingerprint,
    idempotencyKey: 'configured-carrier-degraded-shadow',
  })
  const parcel = {
    description: 'ClawPilot carton 1',
    length: 9,
    width: 7,
    height: 5,
    dimensionUnit: 'IN',
    weight: 2.5,
    weightUnit: 'LB',
    packageCode: '02',
  }
  const successfulRate = {
    serviceCode: '03',
    serviceName: 'UPS Ground',
    amount: '10.00',
    currency: 'USD',
  }
  const insertEvidence = async ({
    carrierAccountId,
    carrierAccountGlobalId,
    status,
    errorCode,
  }) => {
    const requestHash = crypto.createHash('sha256').update(
      `degraded:${receiptGlobalId}:${carrierAccountGlobalId}`,
    ).digest('hex')
    const redactedResponse = status === 'succeeded'
      ? {
          rateScope: 'multi_package_shipment',
          packageCount: 1,
          rates: [successfulRate],
        }
      : {
          rateScope: 'multi_package_shipment',
          packageCount: 1,
          errorCode,
        }
    const result = await client.query(
      `INSERT INTO operations_carrier_rate_requests (
         organization_id, integration_account_id, carrier_account_id,
         provider, environment, purpose, adapter_version,
         credential_version, request_hash, billing_relationship,
         billing_selection_snapshot, redacted_request, redacted_response,
         status, provider_reference, error_code, actor_email,
         requested_at, completed_at, carrier_selection_key
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000020'::uuid,
         $1::uuid, 'ups_rest', 'sandbox',
         'cartonization_shipment_rate', 'configured-carrier-postgres-v1',
         1, $2, 'sender', '{}'::jsonb,
         jsonb_build_object(
           'shipment', jsonb_build_object(
             'destinationFingerprint', $3::text,
             'rateScope', 'multi_package_shipment',
             'packageCount', 1,
             'parcels', $4::jsonb
           )
         ),
         $5::jsonb, $6, $7, $8, NULL,
         $9::timestamptz, $9::timestamptz + interval '1 second', NULL
       )
       RETURNING id::text, global_id, request_hash, carrier_selection_key`,
      [
        carrierAccountId,
        requestHash,
        destinationFingerprint,
        JSON.stringify([parcel]),
        JSON.stringify(redactedResponse),
        status,
        status === 'succeeded' ? 'degraded-success-account' : null,
        errorCode,
        new Date(createdAt.getTime() + 1_000),
      ],
    )
    assert.equal(
      result.rows[0].carrier_selection_key,
      checkoutCarrierSelectionKey(receiptGlobalId, carrierAccountGlobalId),
      `${status} account evidence must derive the exact receipt/account key before package preparation`,
    )
    return result.rows[0]
  }
  const succeeded = await insertEvidence({
    carrierAccountId: '28500000-0000-4000-8000-000000000070',
    carrierAccountGlobalId: 'gach00000000001',
    status: 'succeeded',
    errorCode: null,
  })
  const degraded = await insertEvidence({
    carrierAccountId: '28500000-0000-4000-8000-000000000071',
    carrierAccountGlobalId: 'gach00000000003',
    status: 'failed',
    errorCode: 'UPS_RATE_TIMEOUT',
  })

  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
       organization_id, receipt_id, package_key, package_sequence,
       packaging_material_id, packaging_material_row_version,
       packaging_material_stock_id, packaging_material_stock_row_version,
       packaging_material_stock_on_hand_quantity,
       rated_outer_length_mm, rated_outer_width_mm, rated_outer_height_mm,
       content_weight_grams, tare_weight_grams, gross_weight_grams,
       allocation_count, package_hash, package_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'package-1', 1,
       '28500000-0000-4000-8000-000000000050'::uuid, 1,
       '28500000-0000-4000-8000-000000000060'::uuid, 1, 10,
       210, 160, 110, 1000, 100, 1100, 1, repeat('a', 64),
       '{}'::jsonb
     )`,
    [receiptId],
  )
  const responseRateHash = await client.query(
    `SELECT encode(digest(($1::jsonb)::text, 'sha256'), 'hex') AS hash`,
    [JSON.stringify(successfulRate)],
  )
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_offers (
       organization_id, receipt_id, carrier_provider,
       carrier_account_id, carrier_rate_request_id,
       carrier_rate_purpose, carrier_request_hash,
       carrier_response_rate_hash, shopify_service_code,
       service_code, service_name, carrier_cost_minor,
       customer_charge_minor, checkout_adjustment_minor,
       checkout_adjustment_kind, currency, package_count,
       package_plan_hash, offer_hash, offer_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'ups_rest',
       '28500000-0000-4000-8000-000000000070'::uuid, $2::uuid,
       'cartonization_shipment_rate', $3, $4,
       'clawpilot:ups:03', '03', 'UPS Ground', 1000, 1000, 0,
       'none', 'USD', 1, repeat('b', 64), repeat('c', 64), '{}'::jsonb
     )`,
    [receiptId, succeeded.id, succeeded.request_hash,
      responseRateHash.rows[0].hash],
  )
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_provider_attempts (
       organization_id, receipt_id, carrier_provider, carrier_account_id,
       carrier_rate_request_id, carrier_rate_purpose,
       carrier_request_hash, attempt_status, failure_code,
       attempt_hash, attempt_snapshot
     ) VALUES
     (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'ups_rest',
       '28500000-0000-4000-8000-000000000070'::uuid, $2::uuid,
       'cartonization_shipment_rate', $3, 'succeeded', NULL,
       repeat('d', 64), '{}'::jsonb
     ),
     (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'ups_rest',
       '28500000-0000-4000-8000-000000000071'::uuid, $4::uuid,
       'cartonization_shipment_rate', $5, 'degraded',
       'UPS_RATE_TIMEOUT', repeat('e', 64), '{}'::jsonb
     )`,
    [
      receiptId,
      succeeded.id,
      succeeded.request_hash,
      degraded.id,
      degraded.request_hash,
    ],
  )
  await client.query(
    `ALTER TABLE operations_shopify_checkout_rate_receipts
       ENABLE ALWAYS TRIGGER
       validate_op_shopify_checkout_attempt_finalization`,
  )
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `UPDATE operations_shopify_checkout_rate_receipts
       SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
           package_count = 1, offer_count = 1,
           package_plan_hash = repeat('b', 64),
           result_hash = repeat('f', 64), result_snapshot = '{}'::jsonb,
           expires_at = now() + interval '15 minutes',
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [receiptId],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function runConcurrentReceiptIsolationAcceptance(client) {
  const firstReceiptId = '28500000-0000-4000-8000-000000000096'
  const secondReceiptId = '28500000-0000-4000-8000-000000000097'
  const firstReceiptGlobalId = 'gsqr2850006'
  const destinationFingerprint = repeatHex('b')
  const firstCreatedAt = await seedProcessingReceipt(client, {
    id: firstReceiptId,
    globalId: firstReceiptGlobalId,
    activationState: 'shadow',
    carrierDestinationFingerprint: destinationFingerprint,
    idempotencyKey: 'configured-carrier-concurrent-first',
  })
  const secondCreatedAt = await seedProcessingReceipt(client, {
    id: secondReceiptId,
    globalId: 'gsqr2850007',
    activationState: 'shadow',
    carrierDestinationFingerprint: destinationFingerprint,
    idempotencyKey: 'configured-carrier-concurrent-second',
  })
  await assert.rejects(
    insertCallbackRateEvidence(client, {
      environment: 'sandbox',
      integrationAccountId: '28500000-0000-4000-8000-000000000020',
      carrierAccountId: '28500000-0000-4000-8000-000000000070',
      carrierDestinationFingerprint: destinationFingerprint,
      requestedAt: firstCreatedAt,
      requestSuffix: 'ambiguous-concurrent-receipts',
    }),
    /matches multiple processing receipts/u,
    'legacy evidence must fail closed when two otherwise-identical processing receipts are candidates',
  )

  const parcel = {
    description: 'ClawPilot carton 1',
    length: 9,
    width: 7,
    height: 5,
    dimensionUnit: 'IN',
    weight: 2.5,
    weightUnit: 'LB',
    packageCode: '02',
  }
  const requestHash = crypto.createHash('sha256').update(
    'cross-receipt-explicit-evidence',
  ).digest('hex')
  const evidence = await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       organization_id, integration_account_id, carrier_account_id,
       provider, environment, purpose, adapter_version,
       credential_version, request_hash, billing_relationship,
       billing_selection_snapshot, redacted_request, redacted_response,
       status, provider_reference, error_code, actor_email,
       requested_at, completed_at, carrier_selection_key
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       '28500000-0000-4000-8000-000000000020'::uuid,
       '28500000-0000-4000-8000-000000000070'::uuid,
       'ups_rest', 'sandbox', 'cartonization_shipment_rate',
       'configured-carrier-postgres-v1', 1, $1, 'sender', '{}'::jsonb,
       jsonb_build_object(
         'shipment', jsonb_build_object(
           'destinationFingerprint', $2::text,
           'rateScope', 'multi_package_shipment',
           'packageCount', 1,
           'parcels', $3::jsonb
         )
       ),
       jsonb_build_object(
         'rateScope', 'multi_package_shipment',
         'packageCount', 1,
         'rates', jsonb_build_array(jsonb_build_object(
           'serviceCode', '03', 'serviceName', 'UPS Ground',
           'amount', '10.00', 'currency', 'USD'
         ))
       ),
       'succeeded', 'cross-receipt-evidence', NULL, NULL,
       $4::timestamptz, $4::timestamptz + interval '1 second', $5
     )
     RETURNING id::text, request_hash`,
    [
      requestHash,
      destinationFingerprint,
      JSON.stringify([parcel]),
      new Date(Math.max(
        firstCreatedAt.getTime(),
        secondCreatedAt.getTime(),
      ) + 1_000),
      checkoutCarrierSelectionKey(
        firstReceiptGlobalId,
        'gach00000000001',
      ),
    ],
  )
  await client.query(
    `INSERT INTO operations_shopify_checkout_rate_receipt_packages (
       organization_id, receipt_id, package_key, package_sequence,
       packaging_material_id, packaging_material_row_version,
       packaging_material_stock_id, packaging_material_stock_row_version,
       packaging_material_stock_on_hand_quantity,
       rated_outer_length_mm, rated_outer_width_mm, rated_outer_height_mm,
       content_weight_grams, tare_weight_grams, gross_weight_grams,
       allocation_count, package_hash, package_snapshot
     ) VALUES (
       '28500000-0000-4000-8000-000000000001'::uuid,
       $1::uuid, 'package-1', 1,
       '28500000-0000-4000-8000-000000000050'::uuid, 1,
       '28500000-0000-4000-8000-000000000060'::uuid, 1, 10,
       210, 160, 110, 1000, 100, 1100, 1, repeat('a', 64),
       '{}'::jsonb
     )`,
    [secondReceiptId],
  )
  await assert.rejects(
    client.query(
      `INSERT INTO operations_shopify_checkout_rate_receipt_provider_attempts (
         organization_id, receipt_id, carrier_provider, carrier_account_id,
         carrier_rate_request_id, carrier_rate_purpose,
         carrier_request_hash, attempt_status, failure_code,
         attempt_hash, attempt_snapshot
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         $1::uuid, 'ups_rest',
         '28500000-0000-4000-8000-000000000070'::uuid, $2::uuid,
         'cartonization_shipment_rate', $3, 'succeeded', NULL,
         repeat('d', 64), '{}'::jsonb
       )`,
      [secondReceiptId, evidence.rows[0].id, evidence.rows[0].request_hash],
    ),
    /requires exact configured carrier, environment, and rate evidence/u,
    'rate evidence keyed to one receipt must not be attached to an otherwise-identical concurrent receipt',
  )
  await client.query('SET session_replication_role = replica')
  try {
    await client.query(
      `DELETE FROM operations_shopify_checkout_rate_receipt_packages
       WHERE receipt_id = $1::uuid`,
      [secondReceiptId],
    )
    await client.query(
      `DELETE FROM operations_carrier_rate_requests WHERE id = $1::uuid`,
      [evidence.rows[0].id],
    )
    await client.query(
      `DELETE FROM operations_shopify_checkout_rate_receipts
       WHERE id = ANY($1::uuid[])`,
      [[firstReceiptId, secondReceiptId]],
    )
  } finally {
    await client.query('SET session_replication_role = origin')
  }
}

async function runRollingMigrationAcceptance(databaseUrl) {
  const legacyPool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    max: 2,
  })
  await waitForPostgres(legacyPool)
  const migrationChecksum = crypto.createHash('sha256').update(
    readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url)),
  ).digest('hex')
  const diagnosticChecksum = crypto.createHash('sha256').update(
    readFileSync(
      new URL(`../db/migrations/${diagnosticMigration}`, import.meta.url),
    ),
  ).digest('hex')
  const registeredRateSourceChecksum = crypto.createHash('sha256').update(
    readFileSync(
      new URL(
        `../db/migrations/${registeredRateSourceMigration}`,
        import.meta.url,
      ),
    ),
  ).digest('hex')
  const checkoutRateControlChecksum = crypto.createHash('sha256').update(
    readFileSync(
      new URL(
        `../db/migrations/${checkoutRateControlMigration}`,
        import.meta.url,
      ),
    ),
  ).digest('hex')
  await legacyPool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       checksum text,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await legacyPool.query(
    `INSERT INTO schema_migrations (filename, checksum)
     VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      migration,
      migrationChecksum,
      diagnosticMigration,
      diagnosticChecksum,
      registeredRateSourceMigration,
      registeredRateSourceChecksum,
      checkoutRateControlMigration,
      checkoutRateControlChecksum,
    ],
  )
  command('node', ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
    timeout: 240_000,
  })

  const client = await legacyPool.connect()
  try {
    await seedFixture(client)
    await seedHistoricalPre0285Fixture(client)
    await client.query(
      `DELETE FROM schema_migrations
       WHERE filename = ANY($1::text[])`,
      [[
        migration,
        diagnosticMigration,
        registeredRateSourceMigration,
      ]],
    )
  } finally {
    client.release()
  }

  command('node', ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
    timeout: 240_000,
  })

  const preRateControl = await legacyPool.connect()
  let preRateControlConfig = null
  try {
    await preRateControl.query('BEGIN')
    await preRateControl.query('SET LOCAL session_replication_role = replica')
    await preRateControl.query(
      `UPDATE operations_activation_scopes
       SET revision = revision + 1
       WHERE organization_id =
         '28500000-0000-4000-8000-000000000001'::uuid`,
    )
    await preRateControl.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_snapshot = policy_snapshot - 'checkoutRateControl',
           policy_hash = encode(
             digest(
               canonical_operations_shopify_checkout_policy_jsonb(
                 policy_snapshot - 'checkoutRateControl'
               ),
               'sha256'
             ),
             'hex'
           )
       WHERE organization_id =
         '28500000-0000-4000-8000-000000000001'::uuid
         AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
    )
    const snapshot = await preRateControl.query(
      `SELECT to_jsonb(config) - ARRAY[
         'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
         'updated_by', 'updated_at'
       ]::text[] AS provider_authority,
       row_version::text AS row_version,
       policy_revision AS policy_revision
       FROM operations_shopify_carrier_service_configs config
       WHERE organization_id =
         '28500000-0000-4000-8000-000000000001'::uuid
         AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
    )
    preRateControlConfig = snapshot.rows[0]
    await preRateControl.query(
      `DELETE FROM schema_migrations WHERE filename = $1`,
      [checkoutRateControlMigration],
    )
    await preRateControl.query('COMMIT')
  } catch (error) {
    await preRateControl.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    preRateControl.release()
  }

  command('node', ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
    timeout: 240_000,
  })

  const migrated = await legacyPool.connect()
  try {
    const migratedRateControlConfig = await migrated.query(
      `SELECT to_jsonb(config) - ARRAY[
         'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
         'updated_by', 'updated_at'
       ]::text[] AS provider_authority,
       row_version::text AS row_version,
       policy_revision AS policy_revision,
       policy_snapshot #>> '{checkoutRateControl,rateSource}' AS rate_source
       FROM operations_shopify_carrier_service_configs config
       WHERE organization_id =
         '28500000-0000-4000-8000-000000000001'::uuid
         AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
    )
    assert.deepEqual(
      migratedRateControlConfig.rows[0]?.provider_authority,
      preRateControlConfig?.provider_authority,
      '0299 must preserve every provider-authority field while backfilling a stale config',
    )
    assert.equal(
      migratedRateControlConfig.rows[0]?.row_version,
      String(Number(preRateControlConfig?.row_version || '0') + 1),
      '0299 must advance the config row version exactly once',
    )
    assert.equal(
      migratedRateControlConfig.rows[0]?.policy_revision,
      String(Number(preRateControlConfig?.policy_revision || '0') + 1),
      '0299 must advance the policy revision exactly once',
    )
    assert.equal(
      migratedRateControlConfig.rows[0]?.rate_source,
      'sandbox',
      '0299 must derive the legacy Shadow config sandbox source despite activation-revision drift',
    )

    const savedPolicy = await migrated.query(
      `UPDATE operations_shopify_carrier_service_configs
       SET policy_snapshot = jsonb_set(
             policy_snapshot,
             '{checkoutRateControl,audience}',
             '"off"'::jsonb
           ),
           policy_hash = encode(
             digest(
               canonical_operations_shopify_checkout_policy_jsonb(
                 jsonb_set(
                   policy_snapshot,
                   '{checkoutRateControl,audience}',
                   '"off"'::jsonb
                 )
               ),
               'sha256'
             ),
             'hex'
           ),
           policy_revision = policy_revision + 1,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id =
         '28500000-0000-4000-8000-000000000001'::uuid
         AND id = '28500000-0000-4000-8000-000000000090'::uuid
       RETURNING policy_snapshot #>> '{checkoutRateControl,audience}' AS audience`,
    )
    assert.equal(
      savedPolicy.rows[0]?.audience,
      'off',
      'a strictly local policy update must remain editable while activation evidence is stale',
    )
    await assert.rejects(
      migrated.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET service_gid = 'gid://shopify/CarrierService/drifted',
             row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id =
           '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      ),
      /not callback-ready|revision fence is stale/u,
      'a non-policy config mutation must retain the stale readiness fence',
    )

    const historicalRuns = await migrated.query(
      `SELECT id::text, selected_carrier_account_id::text
       FROM operations_pack_rate_runs
       WHERE id IN (
         '28500000-0000-4000-8000-000000000220'::uuid,
         '28500000-0000-4000-8000-000000000221'::uuid
       )
       ORDER BY id`,
    )
    assert.deepEqual(
      historicalRuns.rows,
      [
        {
          id: '28500000-0000-4000-8000-000000000220',
          selected_carrier_account_id:
            '28500000-0000-4000-8000-000000000070',
        },
        {
          id: '28500000-0000-4000-8000-000000000221',
          selected_carrier_account_id:
            '28500000-0000-4000-8000-000000000070',
        },
      ],
      '0285 must backfill checkout from immutable receipt offers and fulfillment from immutable execution attempts',
    )
    const historicalChoices = await migrated.query(
      `SELECT count(*)::integer AS retained
       FROM operations_pack_rate_run_rate_choices
       WHERE run_id IN (
         '28500000-0000-4000-8000-000000000220'::uuid,
         '28500000-0000-4000-8000-000000000221'::uuid
       )
         AND carrier_account_id =
           '28500000-0000-4000-8000-000000000070'::uuid`,
    )
    assert.equal(
      historicalChoices.rows[0]?.retained,
      4,
      'all uniquely provable historical choices must retain exact account lineage',
    )
    const historicalReplayLineage = await migrated.query(
      `SELECT carrier_account.global_id AS carrier_account_global_id
       FROM operations_fulfillment_executions execution
       JOIN operations_pack_rate_runs fulfillment_run
         ON fulfillment_run.organization_id = execution.organization_id
        AND fulfillment_run.id = execution.fulfillment_pack_rate_run_id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = fulfillment_run.organization_id
        AND carrier_account.id = fulfillment_run.selected_carrier_account_id
       JOIN operations_shipment_groups shipment_group
         ON shipment_group.organization_id = execution.organization_id
        AND shipment_group.fulfillment_execution_id = execution.id
        AND shipment_group.selected_carrier_account_id
          = fulfillment_run.selected_carrier_account_id
       WHERE execution.global_id = 'gofe2850100'
         AND shipment_group.global_id = 'gshg2850100'`,
    )
    assert.deepEqual(
      historicalReplayLineage.rows,
      [{ carrier_account_global_id: 'gach00000000001' }],
      'a migrated legacy completed receipt must be able to rehydrate one exact execution account',
    )

    await migrated.query('SET session_replication_role = replica')
    await migrated.query(
      `INSERT INTO operations_shopify_carrier_service_config_carriers (
         organization_id, config_id, carrier_provider, carrier_account_id
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000078'::uuid
       )`,
    )
    await migrated.query('SET session_replication_role = origin')
    const historicalShadowAccountSet = await migrated.query(
      `WITH expected_accounts AS (
         SELECT configured.carrier_provider,
                configured.carrier_account_id
         FROM operations_shopify_checkout_rate_receipts receipt
         JOIN operations_shopify_carrier_service_config_carriers configured
           ON configured.organization_id = receipt.organization_id
          AND configured.config_id = receipt.config_id
         JOIN operations_carrier_accounts carrier_account
           ON carrier_account.organization_id = configured.organization_id
          AND carrier_account.id = configured.carrier_account_id
         JOIN operations_integration_accounts integration
           ON integration.organization_id = carrier_account.organization_id
          AND integration.id = carrier_account.integration_account_id
         WHERE receipt.organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND receipt.id =
             '28500000-0000-4000-8000-000000000200'::uuid
           AND integration.environment = CASE receipt.activation_state
             WHEN 'shadow' THEN 'sandbox'
             WHEN 'active' THEN 'production'
             ELSE '__invalid__'
           END
       ), retained_attempts AS (
         SELECT attempt.carrier_provider,
                attempt.carrier_account_id
         FROM operations_fulfillment_execution_rate_attempts attempt
         WHERE attempt.organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND attempt.execution_id =
             '28500000-0000-4000-8000-000000000230'::uuid
       )
       SELECT
         (SELECT count(*)::integer FROM expected_accounts) AS expected,
         (SELECT count(*)::integer FROM retained_attempts) AS retained,
         (SELECT count(*)::integer FROM (
            (SELECT * FROM expected_accounts
             EXCEPT SELECT * FROM retained_attempts)
            UNION ALL
            (SELECT * FROM retained_attempts
             EXCEPT SELECT * FROM expected_accounts)
          ) mismatch) AS mismatches`,
    )
    assert.deepEqual(
      historicalShadowAccountSet.rows[0],
      { expected: 1, retained: 1, mismatches: 0 },
      'a coexisting LIVE binding must not alter a historical Shadow execution account set',
    )

    await migrated.query(
      `ALTER TABLE operations_pack_rate_runs ENABLE ALWAYS TRIGGER
         a_derive_operations_legacy_pack_rate_run_account;
       ALTER TABLE operations_pack_rate_run_rate_choices ENABLE ALWAYS TRIGGER
         a_derive_operations_legacy_pack_rate_choice_account;
       ALTER TABLE operations_shipment_groups ENABLE ALWAYS TRIGGER
         a_derive_operations_legacy_shipment_group_account`,
    )
    await migrated.query('BEGIN')
    try {
      await migrated.query('SET LOCAL session_replication_role = replica')
      await migrated.query(
        `INSERT INTO operations_pack_rate_runs (
           id, global_id, organization_id, replay_group_key, scenario_id,
           source_kind, source_reference, provider, checkout_source, purpose,
           prior_checkout_run_id, customer_resolution_outcome, status,
           policy_version, algorithm_version, input_hash, result_hash,
           input_snapshot, result_snapshot, stage_snapshot,
           line_count, package_count, rate_choice_count, currency,
           selected_provider, selected_service_code, selected_service_name,
           selected_carrier_cost_minor, customer_charge_minor,
           mud_markup_minor, margin_minor, idempotency_key, actor_email,
           expires_at
         ) VALUES
         (
           '28500000-0000-4000-8000-000000000250'::uuid,
           'gprr2850250',
           '28500000-0000-4000-8000-000000000001'::uuid,
           'rolling-old-writer-checkout', 'rolling-old-writer',
           'provider_checkout', 'gsqr2850100', 'shopify',
           'live_callback_recorded', 'checkout_quote', NULL,
           'not_attempted', 'succeeded', 'policy-v1', 'algorithm-v1',
           repeat('1', 64), repeat('2', 64), '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, 1, 1, 2, 'USD', 'ups_rest', '03', 'UPS Ground',
           1000, 1000, NULL, 0, 'rolling-old-writer-checkout',
           'carrier-fixture@example.com', now() + interval '15 minutes'
         ),
         (
           '28500000-0000-4000-8000-000000000251'::uuid,
           'gprr2850251',
           '28500000-0000-4000-8000-000000000001'::uuid,
           'rolling-old-writer-fulfillment', 'rolling-old-writer',
           'provider_checkout', 'gsqr2850100', 'shopify',
           'live_callback_recorded', 'fulfillment_execution',
           '28500000-0000-4000-8000-000000000250'::uuid,
           'not_attempted', 'succeeded', 'policy-v1', 'algorithm-v1',
           repeat('3', 64), repeat('4', 64), '{}'::jsonb, '{}'::jsonb,
           '{}'::jsonb, 1, 1, 2, 'USD', 'ups_rest', '02',
           'UPS 2nd Day Air', 1100, 1000, NULL, -100,
           'rolling-old-writer-fulfillment',
           'carrier-fixture@example.com', NULL
         )`,
      )
      await migrated.query(
        `INSERT INTO operations_pack_rate_run_rate_choices (
           organization_id, run_id, provider, service_code, service_name,
           carrier_cost_minor, currency, selected, recorded_fact_version,
           normalized_response
         ) VALUES
         ('28500000-0000-4000-8000-000000000001'::uuid,
          '28500000-0000-4000-8000-000000000250'::uuid,
          'ups_rest', '03', 'UPS Ground', 1000, 'USD', true,
          'rolling-old-v1', '{}'::jsonb),
         ('28500000-0000-4000-8000-000000000001'::uuid,
          '28500000-0000-4000-8000-000000000250'::uuid,
          'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD', false,
          'rolling-old-v1', '{}'::jsonb),
         ('28500000-0000-4000-8000-000000000001'::uuid,
          '28500000-0000-4000-8000-000000000251'::uuid,
          'ups_rest', '03', 'UPS Ground', 1000, 'USD', false,
          'rolling-old-v1', '{}'::jsonb),
         ('28500000-0000-4000-8000-000000000001'::uuid,
          '28500000-0000-4000-8000-000000000251'::uuid,
          'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD', true,
          'rolling-old-v1', '{}'::jsonb)`,
      )
      await migrated.query(
        `INSERT INTO operations_shipment_groups (
           id, global_id, organization_id, fulfillment_execution_id,
           order_id, plan_id, warehouse_id, fulfillment_pack_rate_run_id,
           selected_provider, selected_service_code, selected_service_name,
           selected_carrier_cost_minor, currency, state
         ) VALUES (
           '28500000-0000-4000-8000-000000000252'::uuid,
           'gshg2850250',
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000253'::uuid,
           '28500000-0000-4000-8000-000000000254'::uuid,
           '28500000-0000-4000-8000-000000000255'::uuid,
           '28500000-0000-4000-8000-000000000040'::uuid,
           '28500000-0000-4000-8000-000000000251'::uuid,
           'ups_rest', '02', 'UPS 2nd Day Air', 1100, 'USD',
           'shadow_prepared'
         )`,
      )
      const rollingDerived = await migrated.query(
        `SELECT
           (SELECT count(*)::integer FROM operations_pack_rate_runs
            WHERE id IN (
              '28500000-0000-4000-8000-000000000250'::uuid,
              '28500000-0000-4000-8000-000000000251'::uuid
            ) AND selected_carrier_account_id =
              '28500000-0000-4000-8000-000000000070'::uuid) AS runs,
           (SELECT count(*)::integer
            FROM operations_pack_rate_run_rate_choices
            WHERE run_id IN (
              '28500000-0000-4000-8000-000000000250'::uuid,
              '28500000-0000-4000-8000-000000000251'::uuid
            ) AND carrier_account_id =
              '28500000-0000-4000-8000-000000000070'::uuid) AS choices,
           (SELECT count(*)::integer FROM operations_shipment_groups
            WHERE id = '28500000-0000-4000-8000-000000000252'::uuid
              AND selected_carrier_account_id =
                '28500000-0000-4000-8000-000000000070'::uuid) AS groups`,
      )
      assert.deepEqual(
        rollingDerived.rows[0],
        { runs: 2, choices: 4, groups: 1 },
        'old checkout, fulfillment, choice, and shipment-group writers must derive exact lineage after 0285',
      )
    } finally {
      await migrated.query('ROLLBACK')
    }

    await migrated.query('SET session_replication_role = replica')
    await migrated.query(
      `INSERT INTO operations_shopify_carrier_service_config_carriers (
         organization_id, config_id, carrier_provider, carrier_account_id
       ) VALUES (
         '28500000-0000-4000-8000-000000000001'::uuid,
         '28500000-0000-4000-8000-000000000090'::uuid,
         'ups_rest', '28500000-0000-4000-8000-000000000071'::uuid
       )`,
    )
    await migrated.query('SET session_replication_role = origin')
    await migrated.query('BEGIN')
    try {
      await migrated.query('SET LOCAL session_replication_role = replica')
      await assert.rejects(
        migrated.query(
          `INSERT INTO operations_pack_rate_runs (
             id, global_id, organization_id, replay_group_key, scenario_id,
             source_kind, source_reference, provider, checkout_source,
             purpose, prior_checkout_run_id, customer_resolution_outcome,
             status, policy_version, algorithm_version, input_hash,
             result_hash, input_snapshot, result_snapshot, stage_snapshot,
             line_count, package_count, rate_choice_count, currency,
             selected_provider, selected_service_code,
             selected_service_name, selected_carrier_cost_minor,
             customer_charge_minor, mud_markup_minor, margin_minor,
             idempotency_key
           ) VALUES (
             '28500000-0000-4000-8000-000000000260'::uuid,
             'gprr2850260',
             '28500000-0000-4000-8000-000000000001'::uuid,
             'rolling-ambiguous-fulfillment', 'rolling-ambiguous',
             'provider_checkout', 'gsqr2850100', 'shopify',
             'live_callback_recorded', 'fulfillment_execution',
             '28500000-0000-4000-8000-000000000220'::uuid,
             'not_attempted', 'succeeded', 'policy-v1', 'algorithm-v1',
             repeat('a', 64), repeat('b', 64), '{}'::jsonb, '{}'::jsonb,
             '{}'::jsonb, 1, 1, 2, 'USD', 'ups_rest', '02',
             'UPS 2nd Day Air', 1100, 1000, NULL, -100,
             'rolling-ambiguous-fulfillment'
           )`,
        ),
        /ambiguous across accounts/u,
        'a same-provider multi-account config must reject a provider-only legacy fulfillment writer',
      )
    } finally {
      await migrated.query('ROLLBACK')
    }
  } finally {
    await migrated.query('SET session_replication_role = origin')
      .catch(() => undefined)
    migrated.release()
    await legacyPool.end()
  }
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
    await pool.query('CREATE DATABASE clawpilot_carriers_rolling')
    await runRollingMigrationAcceptance(
      databaseUrl.replace(
        /\/clawpilot_carriers$/u,
        '/clawpilot_carriers_rolling',
      ),
    )
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })

    const applied = await pool.query(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS applied',
      [migration],
    )
    assert.equal(applied.rows[0]?.applied, true, `${migration} was not applied`)

    const identityConstraints = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = ANY($1::text[])
       ORDER BY conname`,
      [[
        'operations_shopify_carrier_service_config_carriers_pkey',
        'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
      ]],
    )
    assert.deepEqual(
      identityConstraints.rows,
      [
        {
          conname:
            'operations_shopify_carrier_service_config_carriers_pkey',
          definition:
            'PRIMARY KEY (organization_id, config_id, carrier_account_id)',
        },
        {
          conname:
            'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
          definition:
            'PRIMARY KEY (organization_id, receipt_id, carrier_account_id)',
        },
      ],
      'config bindings and durable attempts must be account-keyed',
    )
    const obsoleteAccountUnique = await pool.query(
      `SELECT count(*)::integer AS retained
       FROM pg_constraint
       WHERE conname = ANY($1::text[])`,
      [[
        'operations_shopify_carrier_service_config_carriers_unique',
        'op_shopify_checkout_provider_attempts_account_unique',
      ]],
    )
    assert.equal(
      obsoleteAccountUnique.rows[0]?.retained,
      0,
      'redundant legacy account unique constraints must be replaced by account-keyed primary keys',
    )
    const finalizer = await pool.query(
      `SELECT pg_get_functiondef(
         'validate_op_shopify_checkout_attempt_finalization()'::regprocedure
       ) AS definition`,
    )
    assert.match(
      finalizer.rows[0]?.definition || '',
      /expected_account_count NOT BETWEEN 1 AND 8/u,
      'attempt finalization must use the bounded runtime account set',
    )
    assert.match(
      finalizer.rows[0]?.definition || '',
      /new\.rate_source/iu,
      'attempt finalization must select only the immutable receipt rate source',
    )
    assert.doesNotMatch(
      finalizer.rows[0]?.definition || '',
      /successful_attempt_without_offer_count/u,
      'a successful losing account may retain no deduplicated public offer',
    )

    const client = await pool.connect()
    try {
      await seedFixture(client)
      assert.equal(
        await isReady(client),
        true,
        'one verified UPS binding must be callback-ready',
      )
      await runLegacyReceiptInsertCompatibilityAcceptance(client)

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET configuration = '{}'::jsonb
         WHERE id = '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'a verified legacy TEST connection without allowedCapabilities must retain runtime-compatible sandbox rating readiness',
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET configuration =
           '{"allowedCapabilities":["sandbox_rate"]}'::jsonb
         WHERE id = '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query(
        `UPDATE operations_carrier_accounts
         SET allow_sender_billing = false
         WHERE id = '28500000-0000-4000-8000-000000000070'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'a selected account that cannot bill the sender must fail callback readiness',
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_carrier_accounts
         SET allow_sender_billing = true
         WHERE id = '28500000-0000-4000-8000-000000000070'::uuid`,
      )
      await client.query('SET session_replication_role = origin')

      const shadowDestinationFingerprint = repeatHex('6')
      const shadowReceiptGlobalId = 'gsqr2850001'
      const shadowReceiptCreatedAt = await seedProcessingReceipt(client, {
        id: '28500000-0000-4000-8000-000000000091',
        globalId: shadowReceiptGlobalId,
        activationState: 'shadow',
        carrierDestinationFingerprint: shadowDestinationFingerprint,
        idempotencyKey: 'configured-carrier-shadow-receipt',
      })
      const legacyShadowEvidence = await insertCallbackRateEvidence(client, {
        environment: 'sandbox',
        integrationAccountId: '28500000-0000-4000-8000-000000000020',
        carrierAccountId: '28500000-0000-4000-8000-000000000070',
        carrierDestinationFingerprint: shadowDestinationFingerprint,
        requestedAt: shadowReceiptCreatedAt,
        requestSuffix: 'legacy-shadow',
      })
      assert.equal(
        legacyShadowEvidence.carrier_selection_key,
        checkoutCarrierSelectionKey(
          shadowReceiptGlobalId,
          'gach00000000001',
        ),
        'a pre-0285 writer must derive the exact TEST receipt/account key before package children exist',
      )
      const actorOwnedEvidence = await insertCallbackRateEvidence(client, {
        environment: 'sandbox',
        integrationAccountId: '28500000-0000-4000-8000-000000000020',
        carrierAccountId: '28500000-0000-4000-8000-000000000070',
        carrierDestinationFingerprint: shadowDestinationFingerprint,
        requestedAt: shadowReceiptCreatedAt,
        actorEmail: 'carrier-fixture@example.com',
        requestSuffix: 'actor-owned-not-callback',
      })
      assert.equal(
        actorOwnedEvidence.carrier_selection_key,
        null,
        'an otherwise-matching actor-owned rate request must remain outside the callback receipt bridge',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000078'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      const liveDestinationFingerprint = repeatHex('7')
      const liveReceiptGlobalId = 'gsqr2850002'
      const liveReceiptCreatedAt = await seedProcessingReceipt(client, {
        id: '28500000-0000-4000-8000-000000000092',
        globalId: liveReceiptGlobalId,
        activationState: 'active',
        carrierDestinationFingerprint: liveDestinationFingerprint,
        idempotencyKey: 'configured-carrier-live-receipt',
      })
      const liveSelectionKey = checkoutCarrierSelectionKey(
        liveReceiptGlobalId,
        'gach00000000010',
      )
      const liveEvidence = await insertCallbackRateEvidence(client, {
        environment: 'production',
        integrationAccountId: '28500000-0000-4000-8000-000000000025',
        carrierAccountId: '28500000-0000-4000-8000-000000000078',
        carrierDestinationFingerprint: liveDestinationFingerprint,
        requestedAt: liveReceiptCreatedAt,
        carrierSelectionKey: liveSelectionKey,
        requestSuffix: 'explicit-live',
      })
      assert.equal(
        liveEvidence.carrier_selection_key,
        liveSelectionKey,
        'an explicit LIVE receipt/account key must pass the mutually exclusive callback contract',
      )

      await assert.rejects(
        insertCallbackRateEvidence(client, {
          environment: 'sandbox',
          integrationAccountId: '28500000-0000-4000-8000-000000000020',
          carrierAccountId: '28500000-0000-4000-8000-000000000070',
          carrierDestinationFingerprint: shadowDestinationFingerprint,
          requestedAt: shadowReceiptCreatedAt,
          carrierSelectionKey: checkoutCarrierSelectionKey(
            shadowReceiptGlobalId,
            'gach00000000001',
          ),
          actorEmail: 'carrier-fixture@example.com',
          requestSuffix: 'shopify-key-in-one-off-context',
        }),
        /must bind exact active small-parcel account/u,
        'a Shopify receipt/account key must not authorize operator one-off evidence',
      )
      await assert.rejects(
        insertCallbackRateEvidence(client, {
          environment: 'sandbox',
          integrationAccountId: '28500000-0000-4000-8000-000000000020',
          carrierAccountId: '28500000-0000-4000-8000-000000000070',
          carrierDestinationFingerprint: shadowDestinationFingerprint,
          requestedAt: shadowReceiptCreatedAt,
          carrierSelectionKey:
            'ups_rest:giah00000000002:gach00000000001:v1',
          requestSuffix: 'one-off-key-in-shopify-context',
        }),
        /must bind one exact processing receipt/u,
        'an operator one-off key must not authorize system Shopify callback evidence',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `DELETE FROM operations_carrier_rate_requests
         WHERE id = ANY($1::uuid[])`,
        [[
          legacyShadowEvidence.id,
          actorOwnedEvidence.id,
          liveEvidence.id,
        ]],
      )
      await client.query(
        `DELETE FROM operations_shopify_checkout_rate_receipts
         WHERE id IN (
           '28500000-0000-4000-8000-000000000091'::uuid,
           '28500000-0000-4000-8000-000000000092'::uuid
         )`,
      )
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_account_id =
             '28500000-0000-4000-8000-000000000078'::uuid`,
      )
      await client.query('SET session_replication_role = origin')

      await runConcurrentReceiptIsolationAcceptance(client)
      await runReceiptAttemptAcceptance(client, {
        receiptId: '28500000-0000-4000-8000-000000000093',
        receiptGlobalId: 'gsqr2850003',
        activationState: 'shadow',
        environment: 'sandbox',
        integrationAccountId: '28500000-0000-4000-8000-000000000020',
        carrierAccountId: '28500000-0000-4000-8000-000000000070',
        carrierAccountGlobalId: 'gach00000000001',
        provider: 'ups_rest',
        packageCode: '02',
        serviceCode: '03',
        serviceName: 'UPS Ground',
        amountMinor: 1000,
        destinationFingerprint: repeatHex('8'),
        idempotencyKey: 'configured-carrier-full-shadow',
      })
      await runReceiptAttemptAcceptance(client, {
        receiptId: '28500000-0000-4000-8000-000000000096',
        receiptGlobalId: 'gsqr2850006',
        activationState: 'active',
        rateSource: 'sandbox',
        environment: 'sandbox',
        integrationAccountId: '28500000-0000-4000-8000-000000000020',
        carrierAccountId: '28500000-0000-4000-8000-000000000070',
        carrierAccountGlobalId: 'gach00000000001',
        provider: 'ups_rest',
        packageCode: '02',
        serviceCode: '03',
        serviceName: 'UPS Ground',
        amountMinor: 1000,
        destinationFingerprint: repeatHex('d'),
        idempotencyKey: 'configured-carrier-decoupled-sandbox-source',
      })

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000078'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      await runReceiptAttemptAcceptance(client, {
        receiptId: '28500000-0000-4000-8000-000000000094',
        receiptGlobalId: 'gsqr2850004',
        activationState: 'active',
        environment: 'production',
        integrationAccountId: '28500000-0000-4000-8000-000000000025',
        carrierAccountId: '28500000-0000-4000-8000-000000000078',
        carrierAccountGlobalId: 'gach00000000010',
        provider: 'ups_rest',
        packageCode: '02',
        serviceCode: '03',
        serviceName: 'UPS Ground',
        amountMinor: 1200,
        destinationFingerprint: repeatHex('9'),
        idempotencyKey: 'configured-carrier-full-live',
      })
      await client.query('SET session_replication_role = replica')
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_account_id =
             '28500000-0000-4000-8000-000000000078'::uuid`,
      )
      await client.query('SET session_replication_role = origin')

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000071'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'two verified accounts for the same UPS provider must be callback-ready',
      )
      await runDegradedReceiptAttemptAcceptance(client)

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
        'verified multi-account UPS and FedEx bindings must remain callback-ready',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES
         (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000072'::uuid
         ),
         (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000073'::uuid
         ),
         (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'fedex_rest', '28500000-0000-4000-8000-000000000074'::uuid
         ),
         (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'fedex_rest', '28500000-0000-4000-8000-000000000075'::uuid
         ),
         (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'fedex_rest', '28500000-0000-4000-8000-000000000076'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'eight verified direct carrier accounts must be callback-ready',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000077'::uuid
         )`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'a ninth selected direct carrier account must fail readiness',
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_account_id =
             '28500000-0000-4000-8000-000000000077'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'removing the ninth account must restore max-eight readiness',
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
        'remaining verified FedEx account bindings must be callback-ready',
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

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET registration_state = 'unconfigured', service_gid = NULL
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', '28500000-0000-4000-8000-000000000070'::uuid
         )`,
      )
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_carriers (
           organization_id, config_id, carrier_provider, carrier_account_id
         )
         SELECT
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           'ups_rest', carrier_account.id
         FROM operations_carrier_accounts carrier_account
         WHERE carrier_account.organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND carrier_account.id IN (
             '28500000-0000-4000-8000-000000000078'::uuid,
             '28500000-0000-4000-8000-000000000101'::uuid,
             '28500000-0000-4000-8000-000000000102'::uuid,
             '28500000-0000-4000-8000-000000000103'::uuid,
             '28500000-0000-4000-8000-000000000104'::uuid,
             '28500000-0000-4000-8000-000000000105'::uuid,
             '28500000-0000-4000-8000-000000000106'::uuid,
             '28500000-0000-4000-8000-000000000107'::uuid
           )
         ORDER BY carrier_account.global_id`,
      )
      await assert.rejects(
        client.query(
          `INSERT INTO operations_shopify_carrier_service_config_carriers (
             organization_id, config_id, carrier_provider,
             carrier_account_id
           ) VALUES (
             '28500000-0000-4000-8000-000000000001'::uuid,
             '28500000-0000-4000-8000-000000000090'::uuid,
             'ups_rest',
             '28500000-0000-4000-8000-000000000108'::uuid
           )`,
        ),
        /at most eight carrier accounts per environment/u,
        'a ninth production account must be rejected while eight TEST accounts remain independently allowed',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET registration_state = 'shadow_simulated', service_gid = NULL
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'Shadow runtime must use the TEST set while eight LIVE accounts coexist',
      )
      assert.equal(
        await isEnvironmentReady(client, 'production'),
        true,
        'the future Active LIVE set must be independently ready in Shadow',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_carrier_accounts
         SET registered_address = jsonb_set(
           registered_address, '{line1}', '"2 Test Street"'::jsonb
         )
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000078'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'a future LIVE origin mismatch must not block Shadow TEST rating',
      )
      assert.equal(
        await isEnvironmentReady(client, 'production'),
        false,
        'every future LIVE account origin must match the configured warehouse',
      )
      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_carrier_accounts
         SET registered_address = jsonb_set(
           registered_address, '{line1}', '"1 Test Street"'::jsonb
         )
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000078'::uuid`,
      )
      await client.query('SET session_replication_role = origin')

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = 'disabled'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000025'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'a stale future LIVE set must not block current Shadow TEST rating',
      )
      assert.equal(
        await isEnvironmentReady(client, 'production'),
        false,
        'a stale LIVE set must fail explicit Active authorization readiness',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = 'active'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000025'::uuid`,
      )
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET registration_state = 'registered',
             service_gid = 'gid://shopify/DeliveryCarrierService/285'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query(
        `UPDATE operations_packaging_materials
         SET row_version = 2,
             updated_at = now()
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000050'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'a registered config must fail closed after a selected material revision changes',
      )
      await assert.rejects(
        client.query(
          `DELETE FROM operations_shopify_carrier_service_config_materials
           WHERE organization_id =
               '28500000-0000-4000-8000-000000000001'::uuid
             AND config_id =
               '28500000-0000-4000-8000-000000000090'::uuid
             AND packaging_material_id =
               '28500000-0000-4000-8000-000000000050'::uuid`,
        ),
        /Disable the provider CarrierService/u,
        'registered material bindings must reject unfenced direct edits',
      )
      await assert.rejects(
        client.query(
          `DELETE FROM operations_shopify_carrier_service_config_carriers
           WHERE organization_id =
               '28500000-0000-4000-8000-000000000001'::uuid
             AND config_id =
               '28500000-0000-4000-8000-000000000090'::uuid
             AND carrier_account_id =
               '28500000-0000-4000-8000-000000000070'::uuid`,
        ),
        /Disable the provider CarrierService/u,
        'registered carrier bindings must reject unfenced direct edits',
      )

      await client.query('BEGIN')
      await client.query(
        `SELECT set_config(
           'clawpilot.shopify_carrier_binding_write_token',
           '28500000-0000-4000-8000-000000000090:1',
           true
         )`,
      )
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_materials
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query(
        `INSERT INTO operations_shopify_carrier_service_config_materials (
           organization_id, config_id, selection_sequence,
           packaging_material_id, packaging_material_row_version
         ) VALUES (
           '28500000-0000-4000-8000-000000000001'::uuid,
           '28500000-0000-4000-8000-000000000090'::uuid,
           1, '28500000-0000-4000-8000-000000000050'::uuid, 2
         )`,
      )
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_account_id =
             '28500000-0000-4000-8000-000000000070'::uuid`,
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
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET row_version = row_version + 1,
             updated_at = now()
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid
           AND row_version = 1`,
      )
      await client.query('COMMIT')
      const refreshedMaterial = await client.query(
        `SELECT packaging_material_row_version::text AS row_version
         FROM operations_shopify_carrier_service_config_materials
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      assert.equal(refreshedMaterial.rows[0]?.row_version, '2')
      assert.equal(
        await isReady(client),
        true,
        'an exact token-fenced material and carrier refresh must restore registered readiness',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_activation_scopes
         SET state = 'active', revision = 2
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid`,
      )
      await client.query(
        `UPDATE operations_shopify_carrier_service_configs
         SET activation_revision = 2
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000090'::uuid`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        true,
        'Active runtime must select the coexisting LIVE set only',
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
        true,
        'a stale TEST set must not block current Active LIVE rating',
      )

      await client.query('SET session_replication_role = replica')
      await client.query(
        `UPDATE operations_integration_accounts
         SET status = 'active'
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND id = '28500000-0000-4000-8000-000000000020'::uuid`,
      )
      await client.query(
        `DELETE FROM operations_shopify_carrier_service_config_carriers
         WHERE organization_id =
             '28500000-0000-4000-8000-000000000001'::uuid
           AND config_id =
             '28500000-0000-4000-8000-000000000090'::uuid
           AND carrier_account_id IN (
             SELECT carrier_account.id
             FROM operations_carrier_accounts carrier_account
             WHERE carrier_account.integration_account_id =
               '28500000-0000-4000-8000-000000000025'::uuid
           )`,
      )
      await client.query('SET session_replication_role = origin')
      assert.equal(
        await isReady(client),
        false,
        'zero LIVE accounts must fail Active runtime even when TEST remains configured',
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
