#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'db/migrations/0177_operations_fulfillment_executions.sql'),
  'utf8',
)

function section(startMarker, endMarker, label) {
  const start = migration.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing start marker: ${startMarker}`)
  const end = endMarker
    ? migration.indexOf(endMarker, start + startMarker.length)
    : migration.length
  assert.notEqual(end, -1, `${label} is missing end marker: ${endMarker}`)
  return migration.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

const executionTable = section(
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_executions',
  'CREATE INDEX IF NOT EXISTS operations_fulfillment_executions_order_idx',
  'Fulfillment-execution table',
)
const shipmentGroupTable = section(
  'CREATE TABLE IF NOT EXISTS operations_shipment_groups',
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_lines',
  'Shipment-group table',
)
const executionLineTable = section(
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_lines',
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_packages',
  'Execution-line table',
)
const executionPackageTable = section(
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_packages',
  'CREATE TABLE IF NOT EXISTS\n  operations_fulfillment_execution_rate_attempts',
  'Execution-package table',
)
const rateAttemptTable = section(
  'CREATE TABLE IF NOT EXISTS\n  operations_fulfillment_execution_rate_attempts',
  'CREATE UNIQUE INDEX IF NOT EXISTS\n  operations_fulfillment_rate_attempts_selected_unique',
  'Execution-rate-attempt table',
)
const packValidation = section(
  'CREATE OR REPLACE FUNCTION validate_operations_pack_rate_run_complete()',
  'CREATE TABLE IF NOT EXISTS operations_fulfillment_executions',
  'Pack-rate completion validator',
)
const varianceValidation = section(
  'CREATE OR REPLACE FUNCTION validate_operations_pack_rate_variance_insert()',
  'DROP INDEX IF EXISTS operations_print_artifacts_package_packing_list_unique',
  'Pack-rate variance validator',
)
const shadowLinkGuard = section(
  'CREATE OR REPLACE FUNCTION\n  protect_operations_shadow_fulfillment_link()',
  'CREATE OR REPLACE FUNCTION\n  protect_operations_fulfillment_preparation_immutable()',
  'Immediate Shadow carrier-write guard',
)
const immutableGuard = section(
  'CREATE OR REPLACE FUNCTION\n  protect_operations_fulfillment_preparation_immutable()',
  'CREATE OR REPLACE FUNCTION validate_operations_fulfillment_execution()',
  'Immutable fulfillment-preparation guard',
)
const validation = section(
  'CREATE OR REPLACE FUNCTION validate_operations_fulfillment_execution()',
  'CREATE CONSTRAINT TRIGGER validate_operations_fulfillment_execution_deferred',
  'Fulfillment-execution validator',
)

const checks = [
  ['required durable tables', () => {
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS operations_fulfillment_executions\s*\(/,
    )
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS operations_shipment_groups\s*\(/,
    )
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_lines\s*\(/,
    )
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS operations_fulfillment_execution_packages\s*\(/,
    )
    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS\s+operations_fulfillment_execution_rate_attempts\s*\(/,
    )
  }],

  ['strict Shadow terminal zero-write counters', () => {
    assertIncludes(executionTable, [
      "authority_mode text NOT NULL CHECK (authority_mode = 'shadow')",
      "state text NOT NULL CHECK (state = 'shadow_prepared')",
      "state = 'shadow_prepared'",
      'provider_write_count = 0',
      'postage_purchase_count = 0',
      'label_write_count = 0',
      'commerce_write_count = 0',
      'row_version = 0',
      'completed_at timestamptz NOT NULL DEFAULT now()',
    ], 'Shadow authority constraint')
    assert.doesNotMatch(
      executionTable,
      /'active'/,
      'Migration 0177 must not admit Active authority',
    )
    assertIncludes(validation, [
      "execution.authority_mode = 'shadow'",
      'FROM operations_label_attempts attempt',
      'attempt.fulfillment_execution_id = execution.id',
      'FROM operations_labels label',
      'label.fulfillment_execution_id = execution.id',
      'FROM operations_shipments shipment',
      'shipment.fulfillment_execution_id = execution.id',
      'Shadow fulfillment execution cannot retain carrier labels or shipments',
    ], 'Shadow carrier-write validator')
  }],

  ['one whole-shipment carrier and service selection', () => {
    assertIncludes(shipmentGroupTable, [
      "selected_provider IN ('ups_rest', 'fedex_rest')",
      'selected_service_code text NOT NULL',
      'selected_service_name text NOT NULL',
      'selected_carrier_cost_minor bigint NOT NULL',
      "currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$')",
      "state text NOT NULL CHECK (state = 'shadow_prepared')",
      'row_version bigint NOT NULL DEFAULT 0 CHECK (row_version = 0)',
      'operations_shipment_groups_execution_unique UNIQUE',
      'organization_id, fulfillment_execution_id',
    ], 'Shipment-group selection')
    assertIncludes(validation, [
      'group_count <> 1',
      'group_row.selected_provider IS DISTINCT FROM run.selected_provider',
      'group_row.selected_service_code',
      'IS DISTINCT FROM run.selected_service_code',
      'group_row.selected_service_name',
      'IS DISTINCT FROM run.selected_service_name',
      'group_row.selected_carrier_cost_minor',
      'IS DISTINCT FROM run.selected_carrier_cost_minor',
      'group_row.currency IS DISTINCT FROM run.currency',
      'NOT attempt.selected',
      'attempt.carrier_provider = run.selected_provider',
      'selected_attempt_count <> 1',
      "selected_rate_attempt_status IS DISTINCT FROM 'succeeded'",
    ], 'Whole-shipment selection validator')
    assert.doesNotMatch(
      executionPackageTable,
      /\bselected_(?:provider|service_code)\b|\bcarrier_provider\b/,
      'Packages must not select independent carriers or services',
    )
  }],

  ['exact order, released-plan, and fulfillment-run bindings', () => {
    assertIncludes(executionTable, [
      'FOREIGN KEY (organization_id, order_id)',
      'REFERENCES operations_orders(organization_id, id)',
      'FOREIGN KEY (organization_id, plan_id)',
      'REFERENCES operations_fulfillment_plans(organization_id, id)',
      'FOREIGN KEY (organization_id, checkout_pack_rate_run_id)',
      'REFERENCES operations_pack_rate_runs(organization_id, id)',
      'FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id)',
      'REFERENCES operations_pack_rate_runs(organization_id, id)',
      'operations_fulfillment_executions_run_lineage_unique UNIQUE',
      'organization_id, id, fulfillment_pack_rate_run_id',
      'operations_fulfillment_executions_order_unique UNIQUE',
      'organization_id, order_id',
    ], 'Execution lineage')
    assertIncludes(shipmentGroupTable, [
      'FOREIGN KEY (organization_id, fulfillment_execution_id)',
      'REFERENCES operations_fulfillment_executions(organization_id, id)',
      'FOREIGN KEY (organization_id, order_id)',
      'FOREIGN KEY (organization_id, plan_id)',
      'REFERENCES operations_fulfillment_plans(organization_id, id)',
      'FOREIGN KEY (organization_id, warehouse_id)',
      'REFERENCES operations_warehouses(organization_id, id)',
      'FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id)',
      'operations_shipment_groups_execution_run_unique UNIQUE',
      'organization_id, fulfillment_execution_id, id,',
      'fulfillment_pack_rate_run_id',
    ], 'Shipment-group lineage')
    assertIncludes(validation, [
      "run.purpose <> 'fulfillment_execution'",
      "run.status <> 'succeeded'",
      "run.source_kind <> 'provider_checkout'",
      'run.prior_checkout_run_id',
      'IS DISTINCT FROM execution.checkout_pack_rate_run_id',
      'group_row.warehouse_id IS DISTINCT FROM plan_warehouse_id',
      "checkout_run.purpose <> 'checkout_quote'",
      "checkout_run.status <> 'succeeded'",
      "order_status <> 'packed'",
      "plan_status <> 'released'",
      'plan_order_id IS DISTINCT FROM execution.order_id',
      'group_row.warehouse_id IS DISTINCT FROM plan_warehouse_id',
      'group_row.fulfillment_pack_rate_run_id',
      'IS DISTINCT FROM execution.fulfillment_pack_rate_run_id',
    ], 'Execution aggregate validator')
  }],

  ['variance derives canonical causes from immutable run children', () => {
    assertIncludes(varianceValidation, [
      'operations_pack_rate_run_allocations',
      'operations_pack_rate_run_packages',
      'comparison_product_key IS NULL',
      'Pack-and-rate variance requires canonical comparison product identities',
      'package_key,',
      'comparison_product_key,',
      'sum(quantity)::bigint AS quantity',
      'GROUP BY package_key, comparison_product_key',
      'package_key, material_code, length_mm, width_mm,',
      'height_mm, gross_weight_grams',
      'selected_provider',
      'selected_service_code',
      "'allocation_changed'::text",
      "'material_changed'::text",
      "'service_changed'::text",
      "'recorded_rate_changed'::text",
      'NEW.causes IS DISTINCT FROM derived_causes',
    ], 'Canonical variance comparison')
    assert.ok(
      (varianceValidation.match(/\bEXCEPT\b/g) || []).length >= 4,
      'Variance validation must compare both sides of allocations and materials',
    )
    for (const forbidden of [
      "result_snapshot->>'allocationHash'",
      "result_snapshot->>'materialHash'",
      "result_snapshot->>'serviceHash'",
    ]) {
      assert.equal(
        varianceValidation.includes(forbidden),
        false,
        `Variance validation must not trust ${forbidden}`,
      )
    }
  }],

  ['legacy pre-label artifacts coexist with warned work instructions', () => {
    assertIncludes(migration, [
      'DROP INDEX IF EXISTS operations_print_artifacts_package_packing_list_unique',
      'operations_print_artifacts_package_legacy_prelabel_unique',
      'operations_print_artifacts_package_work_instruction_unique',
      "storage_reference NOT LIKE\n    'clawpilot-document:%:pack-work-instruction:%'",
      "storage_reference LIKE\n    'clawpilot-document:%:pack-work-instruction:%'",
    ], 'Pre-label artifact compatibility indexes')
  }],

  ['exact canonical line, package, and allocation bindings', () => {
    assertIncludes(migration, [
      'ADD COLUMN IF NOT EXISTS comparison_product_key text',
      'operations_pack_rate_run_allocations_comparison_product_key_valid',
      'length(btrim(comparison_product_key)) BETWEEN 1 AND 512',
    ], 'Canonical comparison identity column')
    assertIncludes(executionLineTable, [
      'PRIMARY KEY (organization_id, execution_id, order_line_id)',
      'required_quantity numeric(20,6) NOT NULL',
      'REFERENCES operations_pack_rate_run_lines(',
      'organization_id, run_id, line_key, product_key',
      'REFERENCES operations_order_lines(organization_id, id)',
      'operations_fulfillment_execution_lines_execution_run_fkey',
      'organization_id, execution_id, fulfillment_pack_rate_run_id',
    ], 'Execution-line lineage')
    assertIncludes(executionPackageTable, [
      'PRIMARY KEY (organization_id, execution_id, package_id)',
      'operations_fulfillment_execution_packages_lineage_fkey',
      'REFERENCES operations_pack_rate_run_packages(',
      'organization_id, run_id, package_key',
      'REFERENCES operations_packages(organization_id, id)',
      'organization_id, execution_id, shipment_group_id,',
      'fulfillment_pack_rate_run_id',
    ], 'Execution-package lineage')
    assertIncludes(validation, [
      'line_mismatch_count',
      'package_mismatch_count',
      'allocation_mismatch_count',
      'comparison_product_mismatch_count',
      'order_line.global_id,',
      'product.reference_code,',
      'order_line.quantity',
      'run_line.required_quantity::numeric',
      'edge.required_quantity',
      'package.evidence_package_key,',
      'package.package_number,',
      'evidence_package.content_weight_grams,',
      'evidence_package.tare_weight_grams,',
      'run_package.material_code,',
      'run_package.content_weight_grams,',
      'run_package.tare_weight_grams,',
      'run_package.gross_weight_grams',
      'run_allocation.package_key',
      'run_allocation.line_key',
      'run_allocation.product_key',
      'run_allocation.comparison_product_key',
      'product.reference_code',
      'run_allocation.quantity::numeric',
      'operations_commerce_order_candidates order_candidate',
      'operations_commerce_order_candidate_lines candidate_line',
      'candidate_line.external_variant_id',
      "order_candidate.workflow_state = 'promoted'",
      "candidate_line.workflow_state = 'promoted'",
    ], 'Exact canonical child validator')
    assert.ok(
      (validation.match(/\bEXCEPT\b/g) || []).length >= 18,
      'Exact child validation must compare both sides of checkout, execution, line, package, allocation, and carrier evidence',
    )
  }],

  ['selected provider attempt retains exact carrier-rate evidence', () => {
    assertIncludes(rateAttemptTable, [
      "carrier_provider IN ('ups_rest', 'fedex_rest')",
      'fulfillment_pack_rate_run_id uuid NOT NULL',
      'carrier_account_id uuid NOT NULL',
      'carrier_rate_request_id uuid NOT NULL',
      "carrier_rate_purpose = 'cartonization_shipment_rate'",
      "carrier_request_hash ~ '^[a-f0-9]{64}$'",
      "environment text NOT NULL CHECK (environment = 'sandbox')",
      "attempt_status IN ('succeeded', 'degraded')",
      'PRIMARY KEY (organization_id, execution_id, carrier_provider)',
      'REFERENCES operations_carrier_accounts(organization_id, id)',
      'operations_fulfillment_rate_attempts_execution_run_fkey',
      'organization_id, execution_id, fulfillment_pack_rate_run_id',
      'operations_fulfillment_rate_attempts_rate_fkey',
      'organization_id, carrier_provider, carrier_rate_purpose,',
      'carrier_rate_request_id',
      'organization_id, provider, purpose, id',
      "attempt_status = 'degraded'",
      'AND NOT selected',
    ], 'Rate-attempt evidence')
    assert.match(
      migration,
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+operations_fulfillment_rate_attempts_selected_unique\s+ON operations_fulfillment_execution_rate_attempts\s*\(\s*organization_id,\s*execution_id\s*\)\s*WHERE selected = true;/s,
      'Only one whole-shipment provider attempt may be selected',
    )
    assertIncludes(validation, [
      'rate_evidence.integration_account_id',
      'IS DISTINCT FROM carrier_account.integration_account_id',
      'rate_evidence.carrier_account_id',
      'IS DISTINCT FROM attempt.carrier_account_id',
      'rate_evidence.provider IS DISTINCT FROM attempt.carrier_provider',
      'rate_evidence.purpose IS DISTINCT FROM attempt.carrier_rate_purpose',
      'rate_evidence.request_hash',
      'IS DISTINCT FROM attempt.carrier_request_hash',
      "rate_evidence.environment IS DISTINCT FROM 'sandbox'",
      "'{shipment,destinationFingerprint}'",
      "'{shipment,rateScope}'",
      "'multi_package_shipment'",
      "'{shipment,packageCount}'",
      "'{shipment,parcels}'",
      'IS DISTINCT FROM ordered_fulfillment_parcels',
      "rate_evidence.status IS DISTINCT FROM 'succeeded'",
      "rate_evidence.status IS DISTINCT FROM 'failed'",
      'IS DISTINCT FROM attempt.failure_code',
    ], 'Exact carrier-rate request and response evidence')
  }],

  ['every configured carrier is attempted and one success is selected', () => {
    assertIncludes(validation, [
      'operations_shopify_carrier_service_config_carriers',
      'configured.carrier_provider',
      'configured.carrier_account_id::text',
      "run.input_snapshot->'configuredCarriers'",
      "configured.value->>'provider'",
      "configured.value->>'carrierAccountId'",
      'configured_attempt_mismatch_count <> 0',
      'selected_attempt_count <> 1',
      "selected_rate_attempt_status IS DISTINCT FROM 'succeeded'",
      'selected_rate_evidence_count <> 1',
      'choice.normalized_response',
      "response_rate.value->>'serviceCode'",
      "response_rate.value->>'serviceName'",
      "response_rate.value->>'currency'",
      'choice.carrier_cost_minor',
      "attempt.attempt_status = 'degraded'",
    ], 'Configured-carrier and selected-rate validator')
  }],

  ['Shopify preparation requires one exact current receipt and variance', () => {
    assertIncludes(executionTable, [
      'shopify_checkout_reconciliation_id uuid',
      'shopify_checkout_receipt_id uuid',
      'operations_fulfillment_executions_receipt_fkey',
      'operations_shopify_checkout_rate_receipts(',
      'organization_id, id',
    ], 'Shopify execution lineage columns')
    assertIncludes(validation, [
      'operations_shopify_checkout_rate_current_reconciliations',
      'execution.shopify_checkout_reconciliation_id IS NULL',
      'execution.shopify_checkout_receipt_id IS NULL',
      "reconciliation.outcome = 'matched'",
      "receipt.status = 'succeeded'",
      'receipt.global_id = checkout_run.source_reference',
      'receipt.line_count = checkout_run.line_count',
      'receipt.package_count = checkout_run.package_count',
      'receipt.offer_count = checkout_run.rate_choice_count',
      'reconciliation.selected_carrier_provider',
      '= checkout_run.selected_provider',
      'reconciliation.selected_service_code',
      '= checkout_run.selected_service_code',
      'reconciliation.selected_customer_charge_minor',
      '= checkout_run.customer_charge_minor',
      'operations_pack_rate_variances variance',
      'variance.checkout_run_id = execution.checkout_pack_rate_run_id',
      'variance.fulfillment_run_id',
      '= execution.fulfillment_pack_rate_run_id',
      'shopify_current_match_count <> 1',
      'variance_count <> 1',
    ], 'Shopify current-match and variance validator')
  }],

  ['Shopify receipt children exactly equal the checkout pack-rate run', () => {
    assertIncludes(validation, [
      'operations_shopify_checkout_rate_receipt_lines',
      'line.provider_variant_id',
      'run_line.product_key',
      'operations_shopify_checkout_rate_receipt_packages',
      'package.rated_outer_length_mm',
      'package.content_weight_grams',
      'package.tare_weight_grams',
      'operations_shopify_checkout_rate_receipt_allocations',
      'allocation.line_key',
      'line.provider_variant_id',
      'run_allocation.comparison_product_key',
      'operations_shopify_checkout_rate_receipt_offers',
      'offer.carrier_provider',
      'offer.service_code',
      'offer.service_name',
      'offer.carrier_cost_minor',
      'checkout_line_mismatch_count <> 0',
      'checkout_package_mismatch_count <> 0',
      'checkout_allocation_mismatch_count <> 0',
      'checkout_rate_mismatch_count <> 0',
    ], 'Exact Shopify receipt child validator')
  }],

  ['label-attempt, label, and shipment links use composite package lineage', () => {
    for (const table of [
      'operations_label_attempts',
      'operations_labels',
      'operations_shipments',
    ]) {
      const tableAlter = section(
        `ALTER TABLE ${table}`,
        table === 'operations_label_attempts'
          ? 'ALTER TABLE operations_labels'
          : table === 'operations_labels'
            ? 'ALTER TABLE operations_shipments'
            : 'CREATE OR REPLACE FUNCTION\n  protect_operations_shadow_fulfillment_link()',
        `${table} execution links`,
      )
      assertIncludes(tableAlter, [
        'ADD COLUMN IF NOT EXISTS fulfillment_execution_id uuid',
        'ADD COLUMN IF NOT EXISTS shipment_group_id uuid',
        'FOREIGN KEY (organization_id, fulfillment_execution_id)',
        'REFERENCES operations_fulfillment_executions(organization_id, id)',
        'FOREIGN KEY (organization_id, shipment_group_id)',
        'REFERENCES operations_shipment_groups(organization_id, id)',
        'execution_package_fkey',
        'organization_id, fulfillment_execution_id, package_id',
        'REFERENCES operations_fulfillment_execution_packages(',
        'organization_id, execution_id, package_id',
        'fulfillment_execution_id IS NULL',
        'shipment_group_id IS NULL',
        'fulfillment_execution_id IS NOT NULL',
        'shipment_group_id IS NOT NULL',
      ], `${table} execution links`)
    }
  }],

  ['carrier-write links are rejected immediately and remain immutable', () => {
    assertIncludes(shadowLinkGuard, [
      "IF TG_OP = 'UPDATE'",
      'NEW.fulfillment_execution_id',
      'IS DISTINCT FROM OLD.fulfillment_execution_id',
      'NEW.shipment_group_id IS DISTINCT FROM OLD.shipment_group_id',
      'Fulfillment execution carrier-write links are immutable',
      'Migration 0177 fulfillment executions are Shadow-only',
    ], 'Immediate Shadow link guard')
    for (const [trigger, table] of [
      [
        'protect_operations_label_attempt_shadow_execution_link',
        'operations_label_attempts',
      ],
      [
        'protect_operations_label_shadow_execution_link',
        'operations_labels',
      ],
      [
        'protect_operations_shipment_shadow_execution_link',
        'operations_shipments',
      ],
    ]) {
      assert.match(
        shadowLinkGuard,
        new RegExp(
          `CREATE TRIGGER ${trigger}\\s+` +
          `BEFORE INSERT OR UPDATE\\s+ON ${table}\\s+` +
          'FOR EACH ROW EXECUTE FUNCTION\\s+' +
          'protect_operations_shadow_fulfillment_link\\(\\);',
          's',
        ),
        `${table} must fail Shadow execution links before a write occurs`,
      )
    }
  }],

  ['all Shadow preparation rows are append-only', () => {
    assertIncludes(immutableGuard, [
      'Shadow fulfillment preparation evidence is immutable',
    ], 'Immutable preparation function')
    for (const [trigger, table] of [
      [
        'protect_operations_fulfillment_execution_mutation',
        'operations_fulfillment_executions',
      ],
      [
        'protect_operations_shipment_group_mutation',
        'operations_shipment_groups',
      ],
      [
        'protect_operations_fulfillment_line_mutation',
        'operations_fulfillment_execution_lines',
      ],
      [
        'protect_operations_fulfillment_package_mutation',
        'operations_fulfillment_execution_packages',
      ],
      [
        'protect_operations_fulfillment_attempt_mutation',
        'operations_fulfillment_execution_rate_attempts',
      ],
    ]) {
      assert.match(
        immutableGuard,
        new RegExp(
          `CREATE TRIGGER ${trigger}\\s+` +
          `BEFORE UPDATE OR DELETE\\s+ON ${table}\\s+` +
          'FOR EACH ROW EXECUTE FUNCTION\\s+' +
          'protect_operations_fulfillment_preparation_immutable\\(\\);',
          's',
        ),
        `${table} must be append-only`,
      )
    }
  }],

  ['deferred aggregate and evidence validation triggers', () => {
    for (const [trigger, table] of [
      ['validate_operations_fulfillment_execution_deferred', 'operations_fulfillment_executions'],
      ['validate_operations_fulfillment_group_deferred', 'operations_shipment_groups'],
      ['validate_operations_fulfillment_lines_deferred', 'operations_fulfillment_execution_lines'],
      ['validate_operations_fulfillment_packages_deferred', 'operations_fulfillment_execution_packages'],
      ['validate_operations_fulfillment_attempts_deferred', 'operations_fulfillment_execution_rate_attempts'],
    ]) {
      assert.match(
        migration,
        new RegExp(
          `CREATE CONSTRAINT TRIGGER ${trigger}\\s+` +
          `AFTER INSERT OR UPDATE\\s+ON ${table}\\s+` +
          'DEFERRABLE INITIALLY DEFERRED\\s+FOR EACH ROW EXECUTE FUNCTION ' +
          'validate_operations_fulfillment_execution\\(\\);',
          's',
        ),
        `${table} must participate in deferred execution validation`,
      )
    }
  }],

  ['Shadow carrier-write links revalidate the execution', () => {
    for (const table of [
      'operations_label_attempts',
      'operations_labels',
      'operations_shipments',
    ]) {
      assert.match(
        migration,
        new RegExp(
          `CREATE CONSTRAINT TRIGGER [a-z0-9_]+\\s+` +
          `AFTER INSERT OR UPDATE(?: OR DELETE)?\\s+ON ${table}\\s+` +
          'DEFERRABLE INITIALLY DEFERRED',
          's',
        ),
        `${table} mutations must revalidate strict Shadow zero-write semantics`,
      )
    }
  }],

  ['blocked and failed pack-rate runs cannot retain child rows', () => {
    assertIncludes(packValidation, [
      "IF NEW.status <> 'succeeded' THEN",
      'FROM operations_pack_rate_run_lines line',
      'FROM operations_pack_rate_run_packages package',
      'FROM operations_pack_rate_run_allocations allocation',
      'FROM operations_pack_rate_run_rate_choices rate',
      'Blocked pack-and-rate runs cannot retain execution children',
    ], 'Blocked pack-rate child guard')
  }],

  ['provider-checkout permits one usable carrier without weakening fixtures', () => {
    assert.match(
      migration,
      /source_kind = 'provider_checkout'\s+AND rate_choice_count BETWEEN 1 AND 100/s,
      'Live provider checkout must allow one to one hundred retained services',
    )
    assert.match(
      migration,
      /source_kind <> 'provider_checkout'\s+AND rate_choice_count BETWEEN 2 AND 50/s,
      'Non-provider fixtures must retain the two-carrier regression oracle',
    )
    assertIncludes(packValidation, [
      "NEW.source_kind <> 'provider_checkout'",
      "rate.provider = 'ups_rest'",
      "rate.provider = 'fedex_rest'",
      'operations_shopify_checkout_rate_receipt_provider_attempts',
      'operations_shopify_carrier_service_config_carriers',
      'attempt.carrier_account_id',
      'configured.carrier_account_id',
    ], 'Pack-rate completion carrier policy')
  }],

  ['migration does not relax global package tare integrity', () => {
    assert.doesNotMatch(
      migration,
      /operations_pack_rate_run_packages_tare_weight_grams_check/,
      'Migration must not replace the global positive-tare package constraint',
    )
    assert.doesNotMatch(
      migration,
      /ALTER TABLE operations_pack_rate_run_packages[\s\S]*tare_weight_grams >= 0/,
      'Migration must not permit zero-tare packages globally',
    )
  }],
]

const failures = []
for (const [name, check] of checks) {
  try {
    check()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`✗ ${name}`)
    console.error(`  ${error.message}`)
  }
}

assert.equal(
  failures.length,
  0,
  `${failures.length} fulfillment-execution migration contract check(s) failed`,
)

console.log('Operation fulfillment execution migration contracts passed.')
