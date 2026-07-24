#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')
const contractsOnly = process.argv.includes('--contracts-only')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function assertSqlIncludes(sql, fragment, message) {
  const normalize = (value) => value
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  assert.ok(normalize(sql).includes(normalize(fragment)), message)
}

function loadTypeScriptModule(path, { mocks = {}, globals = {} } = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    BigInt,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    structuredClone,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function verifySourceContracts() {
  const migration = read('db/migrations/0081_distributed_operations_foundation.sql')
  for (const fragment of [
    "('gor', 'operations.order'",
    "('gwh', 'operations.warehouse'",
    "('giv', 'operations.inventory_position'",
    "('gld', 'operations.inventory_ledger'",
    "('gsh', 'operations.shipment'",
    "('gbe', 'operations.billable_event'",
    "('gev', 'operations.domain_event'",
    'CREATE TABLE IF NOT EXISTS operations_integration_accounts',
    'CREATE TABLE IF NOT EXISTS operations_inventory_positions',
    'CREATE TABLE IF NOT EXISTS operations_inventory_ledger',
    'CREATE TABLE IF NOT EXISTS operations_orders',
    'CREATE TABLE IF NOT EXISTS operations_fulfillment_plans',
    'CREATE TABLE IF NOT EXISTS operations_shipments',
    'CREATE TABLE IF NOT EXISTS operations_billable_events',
    'CREATE TABLE IF NOT EXISTS operations_domain_events',
    'operations_orders_external_unique',
    'operations_inventory_ledger_idempotency_unique',
    'protect_operations_append_only',
    'protect_operations_inventory_ledger_mutation',
    'protect_operations_domain_events_mutation',
    'protect_operations_billable_events_mutation',
  ]) assert.ok(migration.includes(fragment), `Operations migration missing ${fragment}`)

  for (const forbidden of ['client_secret', 'access_token', 'private_key']) {
    assert.ok(!migration.toLowerCase().includes(forbidden), `Operations migration must not persist ${forbidden}`)
  }

  const hardeningMigration = read('db/migrations/0082_operations_activation_and_command_safety.sql')
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS operations_activation_scopes',
    'CREATE TABLE IF NOT EXISTS operations_command_receipts',
    'operations_command_receipts_idempotency_unique',
    'operations_activation_scopes_pipeline_fkey',
    'match_method text',
    'match_evidence jsonb',
    'last_verified_at timestamptz',
  ]) assert.ok(hardeningMigration.includes(fragment), `Operations hardening migration missing ${fragment}`)
  assert.ok(
    !hardeningMigration.includes('actor_email text NOT NULL REFERENCES app_users'),
    'Background provider commands must support attributable service actors',
  )

  const commandResultsMigration = read('db/migrations/0084_operations_command_results.sql')
  assert.ok(
    commandResultsMigration.includes('ADD COLUMN IF NOT EXISTS result_payload jsonb'),
    'Operations command results migration must persist exact idempotent responses',
  )

  const packageWorkflowMigration = read('db/migrations/0085_operations_package_workflow.sql')
  assert.ok(
    packageWorkflowMigration.includes("ALTER COLUMN status SET DEFAULT 'planned'"),
    'Operations package workflow must require explicit pack verification',
  )

  const packagingMigration = read('db/migrations/0086_product_packaging_profiles.sql')
  for (const fragment of [
    "('gpp', 'operations.product_package_profile'",
    'CREATE TABLE IF NOT EXISTS operations_product_package_profiles',
    'operations_product_package_profiles_pipeline_scope_fkey',
    'operations_product_package_profiles_product_fkey',
    'operations_product_package_profiles_product_key_unique',
    "measurement_system text NOT NULL DEFAULT 'metric'",
    "source IN ('manual', 'csv_import', 'provider_sync')",
  ]) assert.ok(packagingMigration.includes(fragment), `Product packaging migration missing ${fragment}`)

  const sandboxRateMigration = read('db/migrations/0088_operations_sandbox_rating_and_mock_retirement.sql')
  for (const fragment of [
    'ADD COLUMN IF NOT EXISTS archived_at timestamptz',
    'CREATE TABLE IF NOT EXISTS operations_carrier_rate_requests',
    'protect_operations_carrier_rate_requests_mutation',
    "WHERE orders.source_provider = 'mock-commerce'",
    "SET status = 'cancelled'",
    "WHERE provider IN ('mock-commerce', 'mock-carrier', 'mock-printer')",
    "WHERE code = 'MOCK-01'",
  ]) assert.ok(sandboxRateMigration.includes(fragment), `Mock retirement migration missing ${fragment}`)

  const rateDelegationMigration = read('db/migrations/0089_operations_rate_delegation_and_carrier_settlement.sql')
  for (const table of [
    'operations_carrier_rate_networks',
    'operations_carrier_account_authorizations',
    'operations_carrier_rate_grants',
    'operations_carrier_quote_snapshots',
    'operations_settlement_entries',
    'operations_settlement_events',
    'operations_carrier_billing_statements',
    'operations_carrier_billing_account_resolutions',
    'operations_carrier_billing_charges',
    'operations_carrier_billing_matches',
    'operations_carrier_billing_reconciliations',
  ]) {
    assertSqlIncludes(
      rateDelegationMigration,
      `CREATE TABLE IF NOT EXISTS ${table}`,
      `Rate delegation migration missing ${table}`,
    )
  }
  for (const [fragment, message] of [
    [
      `FOREIGN KEY (account_owner_organization_id, integration_account_id)
       REFERENCES operations_integration_accounts(organization_id, id)`,
      'Carrier account authorizations must bind the exact owning organization and integration account',
    ],
    [
      `FOREIGN KEY (
         network_id, account_authorization_id,
         account_owner_organization_id, integration_account_id
       )
       REFERENCES operations_carrier_account_authorizations(
         network_id, id, account_owner_organization_id, integration_account_id
       )`,
      'Carrier quote snapshots must bind the exact account authorization path',
    ],
    [
      'party_path_snapshot jsonb NOT NULL',
      'Carrier quote snapshots must preserve party provenance',
    ],
    [
      'grant_path_snapshot jsonb NOT NULL',
      'Carrier quote snapshots must preserve grant provenance',
    ],
    [
      'directive_snapshot jsonb NOT NULL',
      'Carrier quote and settlement records must preserve pricing directive provenance',
    ],
    [
      `customer_charge_minor
       = quoted_carrier_cost_minor + platform_fee_minor + reseller_fee_minor`,
      'Carrier quote snapshots must reconcile the customer charge to carrier cost and fees',
    ],
    [
      `CONSTRAINT operations_settlement_entries_idempotency_unique
       UNIQUE (network_id, idempotency_key)`,
      'Carrier settlement writes must be idempotent within their rate network',
    ],
    [
      'variance_minor = actual_carrier_cost_minor - quoted_carrier_cost_minor',
      'Carrier reconciliation must preserve the exact quoted-to-actual variance',
    ],
    [
      'protect_operations_carrier_quote_snapshots_mutation',
      'Carrier quote snapshots must be append-only',
    ],
    [
      'protect_operations_settlement_entries_mutation',
      'Carrier settlement entries must be append-only',
    ],
    [
      'protect_operations_carrier_billing_reconciliations_mutation',
      'Carrier billing reconciliations must be append-only',
    ],
  ]) {
    assertSqlIncludes(rateDelegationMigration, fragment, message)
  }

  const carrierAccountsGlCodingMigration = read(
    'db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql',
  )
  for (const table of [
    'operations_carrier_accounts',
    'operations_gl_coding_runs',
    'operations_gl_coding_run_batches',
    'operations_gl_coding_run_items',
  ]) {
    assertSqlIncludes(
      carrierAccountsGlCodingMigration,
      `CREATE TABLE IF NOT EXISTS ${table}`,
      `Carrier accounts and GL coding migration missing ${table}`,
    )
  }
  for (const [fragment, message] of [
    [
      `CONSTRAINT operations_carrier_accounts_integration_fkey
       FOREIGN KEY (organization_id, integration_account_id)
       REFERENCES operations_integration_accounts(organization_id, id)`,
      'Carrier accounts must remain scoped to their owning integration account',
    ],
    [
      'account_number_ciphertext text NOT NULL',
      'Carrier account numbers must be encrypted at rest',
    ],
    [
      'account_number_fingerprint text NOT NULL',
      'Carrier accounts must retain a non-reversible account-number match key',
    ],
    [
      'registered_address_fingerprint text NOT NULL',
      'Carrier accounts must retain registered-address matching provenance',
    ],
    [
      "IF integration_type IS DISTINCT FROM 'carrier' THEN",
      'Carrier account rows must point to carrier provider connections',
    ],
    [
      `CONSTRAINT operations_carrier_account_authorizations_carrier_account_fkey
       FOREIGN KEY (
         account_owner_organization_id, integration_account_id, carrier_account_id
       )
       REFERENCES operations_carrier_accounts(
         organization_id, integration_account_id, id
      )`,
      'Carrier account authorizations must bind the exact carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_account_authorizations_explicit_account
       CHECK (carrier_account_id IS NOT NULL) NOT VALID`,
      'New carrier account authorizations must identify an explicit carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_quote_snapshots_carrier_account_fkey
       FOREIGN KEY (
         account_owner_organization_id, integration_account_id, carrier_account_id
       )
       REFERENCES operations_carrier_accounts(
         organization_id, integration_account_id, id
      )`,
      'Carrier quote snapshots must bind the exact carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_quote_snapshots_explicit_account
       CHECK (carrier_account_id IS NOT NULL) NOT VALID`,
      'New carrier quote snapshots must identify an explicit carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_billing_account_resolutions_carrier_account_fkey
       FOREIGN KEY (
         account_owner_organization_id, integration_account_id, carrier_account_id
       )
       REFERENCES operations_carrier_accounts(
         organization_id, integration_account_id, id
      )`,
      'Carrier billing account resolutions must bind the exact carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_billing_account_resolutions_explicit_account CHECK (
         decision <> 'matched' OR carrier_account_id IS NOT NULL
       ) NOT VALID`,
      'Matched carrier billing resolutions must identify an explicit carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_rate_requests_carrier_account_fkey
       FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
       REFERENCES operations_carrier_accounts(
         organization_id, integration_account_id, id
      )`,
      'Carrier rate requests must bind the exact carrier account',
    ],
    [
      `CONSTRAINT operations_carrier_rate_requests_explicit_account
       CHECK (carrier_account_id IS NOT NULL) NOT VALID`,
      'New carrier rate requests must identify an explicit carrier account',
    ],
    [
      "billing_relationship IN ('sender', 'recipient', 'third_party')",
      'Carrier tenders must preserve the selected billing relationship',
    ],
    [
      "selection_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb",
      'GL coding runs must preserve their input selection',
    ],
    [
      "rule_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb",
      'GL coding runs must preserve the rules used for coding',
    ],
    [
      `CONSTRAINT operations_gl_coding_runs_idempotency_unique
       UNIQUE (network_id, idempotency_key)`,
      'GL coding runs must be idempotent within their rate network',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_batches_batch_fkey
       FOREIGN KEY (network_id, batch_id)
       REFERENCES operations_carrier_billing_batches(network_id, id)`,
      'GL coding runs must preserve the exact selected billing batches',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_items_charge_fkey
       FOREIGN KEY (network_id, charge_id)
       REFERENCES operations_carrier_billing_charges(network_id, id)`,
      'GL coding items must preserve their exact source charge',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_items_match_fkey
       FOREIGN KEY (network_id, billing_match_id)
       REFERENCES operations_carrier_billing_matches(network_id, id)`,
      'GL coding items must preserve their exact shipment-match decision',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_items_assignment_fkey
       FOREIGN KEY (network_id, shipper_assignment_id)
       REFERENCES operations_carrier_billing_shipper_assignments(network_id, id)`,
      'GL coding items must preserve their exact shipper assignment',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_items_rule_fkey
       FOREIGN KEY (network_id, routing_rule_id)
       REFERENCES operations_carrier_billing_routing_rules(network_id, id)`,
      'GL coding items must preserve their exact routing rule',
    ],
    [
      `CONSTRAINT operations_gl_coding_run_items_rule_version_valid CHECK (
         (routing_rule_id IS NULL AND routing_rule_version IS NULL)
         OR (routing_rule_id IS NOT NULL AND routing_rule_version IS NOT NULL)
       )`,
      'GL coding items must preserve a routing-rule version with every rule link',
    ],
    [
      'selected.run_id = NEW.run_id',
      'GL coding items must originate from a batch selected by their run',
    ],
    [
      'matched_charge_id IS DISTINCT FROM NEW.charge_id',
      'GL coding shipment matches must belong to the coded charge',
    ],
    [
      'assigned_charge_id IS DISTINCT FROM NEW.charge_id',
      'GL coding shipper assignments must belong to the coded charge',
    ],
    [
      'rule_version IS DISTINCT FROM NEW.routing_rule_version',
      'GL coding items must preserve the exact routing-rule version used',
    ],
    [
      'protect_operations_gl_coding_run_items_mutation',
      'GL coding item evidence must be append-only',
    ],
    [
      `CONSTRAINT operations_carrier_billing_reconciliations_gl_run_fkey
       FOREIGN KEY (network_id, gl_coding_run_id)
       REFERENCES operations_gl_coding_runs(network_id, id)`,
      'Carrier reconciliations must preserve the GL coding run that produced them',
    ],
  ]) {
    assertSqlIncludes(carrierAccountsGlCodingMigration, fragment, message)
  }
  assert.ok(
    !/\baccount_number\s+text\b/i.test(carrierAccountsGlCodingMigration),
    'Carrier account schema must not persist plaintext account numbers',
  )

  const persistence = read('app_src/lib/persistence/operations.ts')
  for (const fragment of [
    'readOperationsWorkspaceFromPostgres',
    'resolveCommerceCustomerInPostgres',
    'runMockOperationsProofFromPostgres',
    'releaseOperationsOrderFromPostgres',
    'confirmOperationsOrderPicksFromPostgres',
    'updateOperationsActivationInPostgres',
    'updateOperationsExceptionInPostgres',
    'operations_command_receipts',
    'OPERATIONS_IDEMPOTENCY_CONFLICT',
    'operations.customer_resolution.review_required',
    "status: 'ambiguous'",
    'uniqueReferenceRows',
    'operations:exception:',
    "aggregateType: 'operations.exception'",
    'operations:proof-order:',
    'FOR UPDATE OF position',
    'OPERATIONS_FULFILLMENT_INFEASIBLE',
    'operations_inventory_ledger',
    'operations_billable_events',
    "target_system, idempotency_key",
    "eventType: 'operations.proof_order.completed'",
    "commandType: 'release_operations_order'",
    "eventType: 'operations.order.released'",
    'result_payload',
    "commandType: 'confirm_operations_order_picks'",
    "eventType: 'operations.pick.completed'",
    "eventType: 'operations.order.picks_confirmed'",
    'verifyOperationsOrderPackFromPostgres',
    'createOperationsWarehouseInPostgres',
    'createOperationsLocationInPostgres',
    "eventType: 'operations.warehouse.created'",
    "eventType: 'operations.location.created'",
    "commandType: 'verify_operations_order_pack'",
    "eventType: 'operations.package.packed'",
    "eventType: 'operations.order.pack_verified'",
    'readDefaultProductPackagingWithClient',
    'orders.archived_at IS NULL',
    "warehouse.code <> 'MOCK-01'",
  ]) assert.ok(persistence.includes(fragment), `Operations persistence missing ${fragment}`)
  assert.ok(!persistence.includes('console.'), 'Operations persistence must not log tenant data')

  const adapters = read('app_src/lib/operations/adapters.ts')
  for (const fragment of [
    'CommerceAdapter',
    'CarrierAdapter',
    'CarrierAdapterDescriptor',
    'supports(capability: CarrierCapability)',
    'validateAddress?',
    'estimateTransit?',
    'voidLabel?',
    'track?',
    'createManifest?',
    'createPickup?',
    'reconcileLabel?',
    'PrintAdapter',
    'MockCommerceAdapter',
    'MockCarrierAdapter',
    'MockPrintAdapter',
  ]) {
    assert.ok(adapters.includes(fragment), `Operations adapter boundary missing ${fragment}`)
  }

  const carrierTypes = read('app_src/lib/operations/types.ts')
  for (const fragment of [
    'CarrierProvider',
    'CarrierCapability',
    'CarrierAdapterDescriptor',
    'CarrierAddressValidationResult',
    'CarrierTransitEstimate',
    'CarrierTrackingResult',
    'CarrierLabelReconciliationResult',
  ]) assert.ok(carrierTypes.includes(fragment), `Carrier domain contract missing ${fragment}`)

  const rocketShipIt = read('app_src/lib/operations/carriers/rocketShipIt.ts')
  for (const fragment of [
    "'https://api.rocketship.it/v1'",
    "'UPS-REST'",
    "'FedEx-REST'",
    "'GetAllRates'",
    "'SubmitShipment'",
    "'VoidShipment'",
    "'GetTrackingDocuments'",
    'ROCKETSHIPIT_DEBUG_FORBIDDEN',
    'ROCKETSHIPIT_RESPONSE_TOO_LARGE',
    'RocketShipItCloudClient',
  ]) assert.ok(rocketShipIt.includes(fragment), `RocketShipIt transport missing ${fragment}`)
  assert.ok(!rocketShipIt.includes('console.'), 'RocketShipIt transport must not log credentials or shipment data')

  const domain = read('app_src/lib/operations/domain.ts')
  for (const fragment of [
    'availableOperationsOrderActions',
    'DeterministicFulfillmentOptimizer',
    'cartonizeSinglePackage',
    'selectPromiseRate',
    'priceContract',
    'unitsPerPackage',
    'packageQuantity',
  ]) {
    assert.ok(domain.includes(fragment), `Operations domain missing ${fragment}`)
  }

  const route = read('app_src/app/api/operations/route.ts')
  for (const fragment of [
    'requireRequestUser',
    'operationsCapabilities',
    'activeOperationsOrganizationId',
    'isPostgresStorageEnabled',
    'readOperationsWorkspaceFromPostgres',
    'runMockOperationsProofFromPostgres',
    'releaseOperationsOrderFromPostgres',
    'confirmOperationsOrderPicksFromPostgres',
    'verifyOperationsOrderPackFromPostgres',
    'createOperationsSandboxLabelInPostgres',
    'voidOperationsSandboxLabelInPostgres',
    'createOperationsWarehouseInPostgres',
    'createOperationsLocationInPostgres',
    'updateOperationsExceptionInPostgres',
    "'Cache-Control': 'private, no-store'",
    'MAX_REQUEST_BYTES',
    "action === 'run-proof-order'",
    "action === 'create-warehouse'",
    "action === 'create-location'",
    'CLAWPILOT_OPERATIONS_PROOF_ENABLED',
    'OPERATIONS_PROOF_DISABLED',
    "action === 'release-order'",
    "action === 'confirm-picks'",
    "action === 'verify-pack'",
    "action === 'create-sandbox-label'",
    "action === 'void-sandbox-label'",
    'Idempotency-Key',
    "action === 'update-exception'",
    "action === 'update-activation'",
  ]) assert.ok(route.includes(fragment), `Operations route missing ${fragment}`)
  assert.ok(!/clientSecret|accessToken|privateKey/i.test(route), 'Operations route must not handle credentials')

  const warehouseSetup = read('app_src/components/operations/WarehouseSetupPanel.tsx')
  for (const fragment of [
    'Warehouse setup',
    'Create starter locations',
    'Configure printers',
    'Import carrier billing',
    "action: 'create-warehouse'",
    "action: 'create-location'",
  ]) assert.ok(warehouseSetup.includes(fragment), `Warehouse setup UI missing ${fragment}`)

  const operationsSection = read('app_src/components/operations/OperationsSection.tsx')
  assert.ok(
    operationsSection.includes('<Tab value="warehouses"'),
    'Operations navigation must expose warehouse setup',
  )

  const health = read('app_src/app/api/health/route.ts')
  assert.ok(
    health.includes("WHERE filename = '0081_distributed_operations_foundation.sql'"),
    'Health must require the distributed operations migration',
  )
  assert.ok(
    health.includes('row?.distributed_operations_migration_applied'),
    'Health migration status must include distributed operations',
  )
  assert.ok(
    health.includes("WHERE filename = '0082_operations_activation_and_command_safety.sql'"),
    'Health must require the operations hardening migration',
  )
  assert.ok(
    health.includes('operationsCommands'),
    'Health must report operations command receipt state',
  )
  assert.ok(
    health.includes("WHERE filename = '0084_operations_command_results.sql'"),
    'Health must require the operations command results migration',
  )
  assert.ok(
    health.includes('row?.operations_command_results_migration_applied'),
    'Health migration status must include operations command result persistence',
  )
  assert.ok(
    health.includes("WHERE filename = '0085_operations_package_workflow.sql'"),
    'Health must require the operations package workflow migration',
  )
  assert.ok(
    health.includes("WHERE filename = '0086_product_packaging_profiles.sql'"),
    'Health must require the product packaging profiles migration',
  )
  assert.ok(
    health.includes("WHERE filename = '0087_operations_carrier_credentials.sql'"),
    'Health must require the operations carrier credential migration',
  )
  assert.ok(
    health.includes("WHERE filename = '0088_operations_sandbox_rating_and_mock_retirement.sql'"),
    'Health must require the sandbox rating and mock retirement migration',
  )
  assert.ok(
    health.includes("WHERE filename = '0089_operations_rate_delegation_and_carrier_settlement.sql'"),
    'Health must require the operations rate delegation and carrier settlement migration',
  )
  assert.ok(
    health.includes('row?.operations_rate_delegation_migration_applied'),
    'Health migration status must include operations rate delegation and carrier settlement',
  )
  assert.ok(
    health.includes("WHERE filename = '0090_operations_carrier_accounts_and_gl_coding.sql'"),
    'Health must require the operations carrier accounts and GL coding migration',
  )
  assert.ok(
    health.includes('row?.operations_carrier_accounts_gl_coding_migration_applied'),
    'Health migration status must include operations carrier accounts and GL coding',
  )
  assert.ok(
    health.includes("WHERE filename = '0091_operations_printer_configuration.sql'"),
    'Health must require the operations printer configuration migration',
  )
  assert.ok(
    health.includes('row?.operations_printer_configuration_migration_applied'),
    'Health migration status must include operations printer configuration',
  )
  assert.ok(
    health.includes("WHERE filename = '0092_operations_carrier_billing_integrity.sql'"),
    'Health must require the carrier billing integrity migration',
  )
  assert.ok(
    health.includes('row?.operations_carrier_billing_integrity_migration_applied'),
    'Health migration status must include carrier billing integrity',
  )
  assert.ok(
    health.includes("WHERE filename = '0093_operations_carrier_billing_import_and_review.sql'"),
    'Health must require carrier billing import and review',
  )
  assert.ok(
    health.includes('row?.operations_carrier_billing_review_migration_applied'),
    'Health migration status must include carrier billing import and review',
  )
  assert.ok(
    health.includes("WHERE filename = '0094_operations_print_delivery.sql'"),
    'Health must require print delivery',
  )
  assert.ok(
    health.includes('row?.operations_print_delivery_migration_applied'),
    'Health migration status must include print delivery',
  )
  assert.ok(
    health.includes("WHERE filename = '0097_operations_settlement_lifecycle.sql'"),
    'Health must require settlement lifecycle controls',
  )
  assert.ok(
    health.includes('row?.operations_settlement_lifecycle_migration_applied'),
    'Health migration status must include settlement lifecycle controls',
  )
  assert.ok(
    health.includes("WHERE filename = '0098_operations_label_execution.sql'"),
    'Health must require label execution persistence',
  )
  assert.ok(
    health.includes('row?.operations_label_execution_migration_applied'),
    'Health migration status must include label execution persistence',
  )

  const packaging = read('app_src/lib/persistence/productPackaging.ts')
  for (const fragment of [
    'upsertProductPackagingProfileWithClient',
    'readProductPackagingProfilesInPostgres',
    'readDefaultProductPackagingWithClient',
    "eventType: 'operations.product_packaging.updated'",
    'row_version = operations_product_package_profiles.row_version + 1',
    'measurementSystem',
  ]) assert.ok(packaging.includes(fragment), `Product packaging persistence missing ${fragment}`)

  const catalogRoute = read('app_src/app/api/pipeline/catalog/route.ts')
  for (const fragment of [
    'packageName',
    'packageType',
    'unitOfMeasure',
    'unitsPerPackage',
    'measurementSystem',
    'dimensionFactor',
    'weightFactor',
    '25.4',
    '453.59237',
    "}, 'csv_import')",
  ]) assert.ok(catalogRoute.includes(fragment), `Pipeline catalog package import missing ${fragment}`)

  const catalogDialog = read('app_src/components/pipeline/PipelineCatalogDialog.tsx')
  for (const fragment of [
    'Metric (cm / kg)',
    'Imperial (in / lb)',
    'measurementSystem,length,width,height,weight',
    'packageDisplayValues',
  ]) assert.ok(catalogDialog.includes(fragment), `Pipeline catalog unit UI missing ${fragment}`)

  const predeploy = read('scripts/verify-predeploy.mjs')
  assert.ok(
    predeploy.includes("'db/migrations/0081_distributed_operations_foundation.sql'"),
    'Predeploy must require the distributed operations migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0082_operations_activation_and_command_safety.sql'"),
    'Predeploy must require the operations hardening migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0084_operations_command_results.sql'"),
    'Predeploy must require the operations command results migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0085_operations_package_workflow.sql'"),
    'Predeploy must require the operations package workflow migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0086_product_packaging_profiles.sql'"),
    'Predeploy must require the product packaging profiles migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0087_operations_carrier_credentials.sql'"),
    'Predeploy must require the operations carrier credential migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0088_operations_sandbox_rating_and_mock_retirement.sql'"),
    'Predeploy must require the sandbox rating and mock retirement migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0089_operations_rate_delegation_and_carrier_settlement.sql'"),
    'Predeploy must require the operations rate delegation and carrier settlement migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql'"),
    'Predeploy must require the operations carrier accounts and GL coding migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0091_operations_printer_configuration.sql'"),
    'Predeploy must require the operations printer configuration migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0092_operations_carrier_billing_integrity.sql'"),
    'Predeploy must require the carrier billing integrity migration',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0093_operations_carrier_billing_import_and_review.sql'"),
    'Predeploy must require carrier billing import and review',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0094_operations_print_delivery.sql'"),
    'Predeploy must require print delivery',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0097_operations_settlement_lifecycle.sql'"),
    'Predeploy must require settlement lifecycle controls',
  )
  assert.ok(
    predeploy.includes("'db/migrations/0098_operations_label_execution.sql'"),
    'Predeploy must require label execution persistence',
  )
}

async function verifyCarrierTransport() {
  const requests = []
  const transport = loadTypeScriptModule('app_src/lib/operations/carriers/rocketShipIt.ts')
  const client = new transport.RocketShipItCloudClient({
    apiKey: 'rocketshipit-test-key',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/health')) return new Response('', { status: 200 })
      return new Response(JSON.stringify({
        meta: { code: 200 },
        data: { rates: [{ service_code: 'GROUND', rate: 12.34 }], errors: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const health = await client.health()
  assert.equal(health.healthy, true)
  assert.equal(health.status, 200)
  const result = await client.execute({
    carrier: 'UPS-REST',
    action: 'GetAllRates',
    params: { account_number: 'configured-in-secret-layer' },
  })
  assert.equal(result.meta.code, 200)
  assert.equal(result.data.rates[0].service_code, 'GROUND')
  assert.equal(requests[1].url, 'https://api.rocketship.it/v1')
  assert.equal(requests[1].init.method, 'POST')
  assert.equal(requests[1].init.headers['Content-Type'], 'application/json')
  assert.equal(requests[1].init.headers['x-api-key'], 'rocketshipit-test-key')
  const requestBody = JSON.parse(requests[1].init.body)
  assert.equal(requestBody.carrier, 'UPS-REST')
  assert.equal(requestBody.action, 'GetAllRates')
  assert.equal(requestBody.debug, undefined)

  await expectRejected(
    () => client.execute({
      carrier: 'UPS-REST',
      action: 'GetAllRates',
      params: { nested: { debug: true } },
    }),
    (error) => error.code === 'ROCKETSHIPIT_DEBUG_FORBIDDEN',
    'RocketShipIt production transport must reject debug payloads',
  )
  await expectRejected(
    () => client.execute({
      carrier: 'Unsupported',
      action: 'GetAllRates',
      params: {},
    }),
    (error) => error.code === 'ROCKETSHIPIT_CARRIER_UNSUPPORTED',
    'RocketShipIt transport must reject unapproved carriers',
  )

  const carrierErrorClient = new transport.RocketShipItCloudClient({
    apiKey: 'rocketshipit-test-key',
    fetch: async () => new Response(JSON.stringify({
      meta: { code: 200 },
      data: { errors: [{ message: 'provider response containing sensitive shipment detail' }] },
    }), { status: 200 }),
  })
  await expectRejected(
    () => carrierErrorClient.execute({
      carrier: 'FedEx-REST',
      action: 'SubmitShipment',
      params: { private_key: 'must-not-appear-in-errors' },
    }),
    (error) => (
      error.code === 'ROCKETSHIPIT_CARRIER_ERROR'
      && error.providerErrorCount === 1
      && !error.message.includes('sensitive shipment detail')
      && !error.message.includes('must-not-appear-in-errors')
    ),
    'RocketShipIt errors must remain bounded and redact request/provider payloads',
  )
}

async function verifyRouteBehavior() {
  delete process.env.CLAWPILOT_OPERATIONS_PROOF_ENABLED
  class OperationsRequestError extends Error {
    constructor(code, message, status = 400) {
      super(message)
      this.code = code
      this.status = status
    }
  }
  const calls = {
    reads: [],
    proofs: [],
    releases: [],
    picks: [],
    packs: [],
    labelCreates: [],
    labelVoids: [],
    exceptions: [],
    activations: [],
  }
  const route = loadTypeScriptModule('app_src/app/api/operations/route.ts', {
    mocks: {
      'next/server': {
        NextResponse: {
          json(payload, init = {}) {
            return new Response(JSON.stringify(payload), {
              status: init.status || 200,
              headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
            })
          },
        },
      },
      '@/lib/operations/authorization': {
        operationsCapabilities: (actor) => actor.capabilities,
        activeOperationsOrganizationId: (actor) => {
          if (!actor.organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
          return actor.organizationId
        },
      },
      '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
      '@/lib/persistence/operations': {
        OperationsRequestError,
        readOperationsWorkspaceFromPostgres: async (input) => {
          calls.reads.push(input)
          return { organizationId: input.organizationId, orders: [], capabilities: input.capabilities }
        },
        runMockOperationsProofFromPostgres: async (input) => {
          calls.proofs.push(input)
          return {
            orderGlobalId: 'gor1234567',
            orderStatus: 'planned',
            duplicate: input.proof.externalOrderId === 'duplicate-order',
            trackingNumber: null,
            steps: Array.from({ length: 11 }, (_, index) => `step-${index + 1}`),
          }
        },
        releaseOperationsOrderFromPostgres: async (input) => {
          calls.releases.push(input)
          return {
            orderGlobalId: input.orderGlobalId,
            orderStatus: 'released',
            rowVersion: input.expectedRowVersion + 1,
            replayed: false,
          }
        },
        confirmOperationsOrderPicksFromPostgres: async (input) => {
          calls.picks.push(input)
          return {
            orderGlobalId: input.orderGlobalId,
            orderStatus: 'picking',
            rowVersion: input.expectedRowVersion + 1,
            replayed: false,
          }
        },
        verifyOperationsOrderPackFromPostgres: async (input) => {
          calls.packs.push(input)
          return {
            orderGlobalId: input.orderGlobalId,
            orderStatus: 'packed',
            rowVersion: input.expectedRowVersion + 1,
            replayed: false,
          }
        },
        updateOperationsActivationInPostgres: async (input) => {
          calls.activations.push(input)
          return {
            state: input.state,
            revision: 2,
            reason: input.reason,
            updatedAt: new Date().toISOString(),
            dataPipeline: { id: randomUUID(), name: 'CRM pipeline' },
          }
        },
        updateOperationsExceptionInPostgres: async (input) => {
          calls.exceptions.push(input)
          return {
            changed: true,
            exception: {
              globalId: input.exceptionGlobalId,
              status: input.status,
              title: 'Inventory review',
            },
          }
        },
      },
      '@/lib/persistence/operationShipping': {
        createOperationsSandboxLabelInPostgres: async (input) => {
          calls.labelCreates.push(input)
          return {
            orderGlobalId: input.orderGlobalId,
            orderStatus: 'packed',
            rowVersion: input.expectedRowVersion + 1,
            packageGlobalId: 'gpk1234567',
            labelGlobalId: 'glb1234567',
            attemptGlobalId: 'gla1234567',
            trackingNumber: '1ZTEST1234567890',
            labelStatus: 'created',
            replayed: false,
            printJobGlobalId: 'gpj1234567',
            printWarning: null,
          }
        },
        voidOperationsSandboxLabelInPostgres: async (input) => {
          calls.labelVoids.push(input)
          return {
            orderGlobalId: input.orderGlobalId,
            orderStatus: 'packed',
            rowVersion: input.expectedRowVersion + 1,
            packageGlobalId: 'gpk1234567',
            labelGlobalId: 'glb1234567',
            attemptGlobalId: 'gla7654321',
            trackingNumber: '1ZTEST1234567890',
            labelStatus: 'voided',
            replayed: false,
            printJobGlobalId: null,
            printWarning: null,
          }
        },
      },
      '@/lib/requestUser': {
        requireRequestUser: async (request) => request.actor,
      },
    },
  })

  const actor = {
    email: 'operator@example.com',
    organizationId: randomUUID(),
    capabilities: { canView: true, canManage: true, canExecute: true, canActivate: true },
  }
  const request = (url, options = {}) => ({
    actor: options.actor || actor,
    nextUrl: new URL(url),
    headers: new Headers(options.headers || {}),
    text: async () => options.body || '',
  })
  const payload = async (response) => JSON.parse(await response.text())

  const deniedRead = await route.GET(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: false, canManage: false, canExecute: false, canActivate: false } },
  }))
  assert.equal(deniedRead.status, 403)
  assert.equal((await payload(deniedRead)).code, 'OPERATIONS_VIEW_REQUIRED')

  const invalidStatus = await route.GET(request('http://localhost/api/operations?status=unknown'))
  assert.equal(invalidStatus.status, 400)
  assert.equal((await payload(invalidStatus)).code, 'OPERATIONS_STATUS_INVALID')

  const validRead = await route.GET(request('http://localhost/api/operations?status=shipped&exceptionStatus=open&search=proof&order=gor1234567'))
  assert.equal(validRead.status, 200)
  assert.equal(validRead.headers.get('cache-control'), 'private, no-store')
  assert.equal(calls.reads.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.reads[0])), {
    organizationId: actor.organizationId,
    capabilities: actor.capabilities,
    search: 'proof',
    status: 'shipped',
    exceptionStatus: 'open',
    selectedOrderGlobalId: 'gor1234567',
  })

  const requested = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const proof = {
    customerGlobalId: 'ga1234567',
    productGlobalId: 'gp1234567',
    externalOrderId: 'route-proof',
    orderNumber: 'ROUTE-1',
    quantity: 2,
    openingQuantity: 12,
    requestedDeliveryAt: requested,
    shipTo: {
      name: 'Receiving',
      line1: '200 Customer Lane',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'us',
    },
  }
  const disabledProof = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(disabledProof.status, 404)
  assert.equal((await payload(disabledProof)).code, 'OPERATIONS_PROOF_DISABLED')
  assert.equal(calls.proofs.length, 0)

  process.env.CLAWPILOT_OPERATIONS_PROOF_ENABLED = 'true'
  const deniedWrite = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(deniedWrite.status, 403)
  assert.equal((await payload(deniedWrite)).code, 'OPERATIONS_EXECUTE_REQUIRED')

  const validWrite = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(validWrite.status, 201)
  assert.equal(calls.proofs.length, 1)
  assert.equal(calls.proofs[0].organizationId, actor.organizationId)
  assert.equal(calls.proofs[0].actorEmail, actor.email)
  assert.equal(calls.proofs[0].proof.executionMode, 'planned')
  assert.equal(calls.proofs[0].proof.shipTo.country, 'US')
  assert.deepEqual(JSON.parse(JSON.stringify(calls.proofs[0].proof.lines)), [{
    productGlobalId: 'gp1234567',
    quantity: 2,
    openingQuantity: 12,
  }])

  const { productGlobalId: _productGlobalId, quantity: _quantity, openingQuantity: _openingQuantity, ...proofBase } = proof
  const multiLineWrite = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'run-proof-order',
      proof: {
        ...proofBase,
        externalOrderId: 'route-proof-multi',
        orderNumber: 'ROUTE-2',
        lines: [
          { productGlobalId: 'gp1234567', quantity: 2, openingQuantity: 12 },
          { productGlobalId: 'gp7654321', quantity: 3, openingQuantity: 9 },
        ],
      },
    }),
  }))
  assert.equal(multiLineWrite.status, 201)
  assert.equal(calls.proofs.length, 2)
  assert.equal(calls.proofs[1].proof.lines.length, 2)
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.proofs[1].proof.lines.map((line) => line.productGlobalId))),
    ['gp1234567', 'gp7654321'],
  )

  const deniedRelease = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: false, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'release-denied-1' },
    body: JSON.stringify({
      action: 'release-order',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 4,
      reason: 'Reviewed plan',
    }),
  }))
  assert.equal(deniedRelease.status, 403)
  assert.equal((await payload(deniedRelease)).code, 'OPERATIONS_EXECUTE_REQUIRED')

  const releaseWithoutKey = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'release-order',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 4,
      reason: 'Reviewed plan',
    }),
  }))
  assert.equal(releaseWithoutKey.status, 400)
  assert.equal((await payload(releaseWithoutKey)).code, 'OPERATIONS_IDEMPOTENCY_KEY_INVALID')

  const validRelease = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'release-route-proof-1' },
    body: JSON.stringify({
      action: 'release-order',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 4,
      reason: 'Reviewed plan',
    }),
  }))
  assert.equal(validRelease.status, 200)
  assert.equal(calls.releases.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.releases[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    orderGlobalId: 'gor1234567',
    expectedRowVersion: 4,
    reason: 'Reviewed plan',
    idempotencyKey: 'release-route-proof-1',
  })

  const deniedPickConfirmation = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'picks-route-denied-1' },
    body: JSON.stringify({
      action: 'confirm-picks',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 5,
      reason: 'Picker verified every ready task',
    }),
  }))
  assert.equal(deniedPickConfirmation.status, 403)
  assert.equal((await payload(deniedPickConfirmation)).code, 'OPERATIONS_EXECUTE_REQUIRED')

  const pickConfirmationWithoutKey = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'confirm-picks',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 5,
      reason: 'Picker verified every ready task',
    }),
  }))
  assert.equal(pickConfirmationWithoutKey.status, 400)
  assert.equal((await payload(pickConfirmationWithoutKey)).code, 'OPERATIONS_IDEMPOTENCY_KEY_INVALID')

  const validPickConfirmation = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'picks-route-proof-1' },
    body: JSON.stringify({
      action: 'confirm-picks',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 5,
      reason: 'Picker verified every ready task',
    }),
  }))
  assert.equal(validPickConfirmation.status, 200)
  assert.equal(calls.picks.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.picks[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    orderGlobalId: 'gor1234567',
    expectedRowVersion: 5,
    reason: 'Picker verified every ready task',
    idempotencyKey: 'picks-route-proof-1',
  })

  const deniedPackVerification = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pack-route-denied-1' },
    body: JSON.stringify({
      action: 'verify-pack',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 6,
      reason: 'Packer verified the carton',
    }),
  }))
  assert.equal(deniedPackVerification.status, 403)
  assert.equal((await payload(deniedPackVerification)).code, 'OPERATIONS_EXECUTE_REQUIRED')

  const packVerificationWithoutKey = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'verify-pack',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 6,
      reason: 'Packer verified the carton',
    }),
  }))
  assert.equal(packVerificationWithoutKey.status, 400)
  assert.equal((await payload(packVerificationWithoutKey)).code, 'OPERATIONS_IDEMPOTENCY_KEY_INVALID')

  const validPackVerification = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'pack-route-proof-1' },
    body: JSON.stringify({
      action: 'verify-pack',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 6,
      reason: 'Packer verified the carton',
    }),
  }))
  assert.equal(validPackVerification.status, 200)
  assert.equal(calls.packs.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.packs[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    orderGlobalId: 'gor1234567',
    expectedRowVersion: 6,
    reason: 'Packer verified the carton',
    idempotencyKey: 'pack-route-proof-1',
  })

  const deniedLabelCreate = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'label-create-denied-1' },
    body: JSON.stringify({
      action: 'create-sandbox-label',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 7,
      reason: 'Sandbox proof label',
      carrierRateGlobalId: 'grt1234567',
      carrierAccountGlobalId: 'gac1234567',
    }),
  }))
  assert.equal(deniedLabelCreate.status, 403)
  assert.equal((await payload(deniedLabelCreate)).code, 'OPERATIONS_EXECUTE_REQUIRED')
  assert.equal(calls.labelCreates.length, 0)

  const labelCreateWithoutKey = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create-sandbox-label',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 7,
      reason: 'Sandbox proof label',
      carrierRateGlobalId: 'grt1234567',
      carrierAccountGlobalId: 'gac1234567',
    }),
  }))
  assert.equal(labelCreateWithoutKey.status, 400)
  assert.equal((await payload(labelCreateWithoutKey)).code, 'OPERATIONS_IDEMPOTENCY_KEY_INVALID')

  const validLabelCreate = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'label-create-route-proof-1' },
    body: JSON.stringify({
      action: 'create-sandbox-label',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 7,
      reason: 'Sandbox proof label',
      carrierRateGlobalId: 'grt1234567',
      carrierAccountGlobalId: 'gac1234567',
      preferredPrinterGlobalId: 'gpr1234567',
    }),
  }))
  assert.equal(validLabelCreate.status, 200)
  assert.equal(calls.labelCreates.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.labelCreates[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    orderGlobalId: 'gor1234567',
    expectedRowVersion: 7,
    reason: 'Sandbox proof label',
    carrierRateGlobalId: 'grt1234567',
    carrierAccountGlobalId: 'gac1234567',
    preferredPrinterGlobalId: 'gpr1234567',
    idempotencyKey: 'label-create-route-proof-1',
  })

  const validLabelVoid = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'label-void-route-proof-1' },
    body: JSON.stringify({
      action: 'void-sandbox-label',
      orderGlobalId: 'gor1234567',
      expectedRowVersion: 8,
      reason: 'Sandbox proof complete',
    }),
  }))
  assert.equal(validLabelVoid.status, 200)
  assert.equal(calls.labelVoids.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.labelVoids[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    orderGlobalId: 'gor1234567',
    expectedRowVersion: 8,
    reason: 'Sandbox proof complete',
    idempotencyKey: 'label-void-route-proof-1',
  })

  const validExceptionUpdate = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-exception', exceptionGlobalId: 'gex1234567', status: 'acknowledged' }),
  }))
  assert.equal(validExceptionUpdate.status, 200)
  assert.equal(calls.exceptions.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.exceptions[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    exceptionGlobalId: 'gex1234567',
    status: 'acknowledged',
  })

  const deniedExceptionUpdate = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: false, canExecute: false, canActivate: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-exception', exceptionGlobalId: 'gex1234567', status: 'resolved' }),
  }))
  assert.equal(deniedExceptionUpdate.status, 403)
  assert.equal((await payload(deniedExceptionUpdate)).code, 'OPERATIONS_MANAGE_REQUIRED')

  const validActivation = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-activation', state: 'read_only', reason: 'Provider reconciliation only' }),
  }))
  assert.equal(validActivation.status, 200)
  assert.equal(calls.activations.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.activations[0])), {
    organizationId: actor.organizationId,
    actorEmail: actor.email,
    state: 'read_only',
    reason: 'Provider reconciliation only',
  })

  const deniedActivation = await route.POST(request('http://localhost/api/operations', {
    actor: { ...actor, capabilities: { canView: true, canManage: true, canExecute: true, canActivate: false } },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-activation', state: 'active', reason: 'Unauthorized change' }),
  }))
  assert.equal(deniedActivation.status, 403)
  assert.equal((await payload(deniedActivation)).code, 'OPERATIONS_ACTIVATION_REQUIRED')

  const invalidProduct = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'run-proof-order', proof: { ...proof, productGlobalId: 'gp1' } }),
  }))
  assert.equal(invalidProduct.status, 400)
  assert.equal((await payload(invalidProduct)).code, 'OPERATIONS_REQUEST_INVALID')

  const duplicateProduct = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'run-proof-order',
      proof: {
        ...proofBase,
        lines: [
          { productGlobalId: 'gp1234567', quantity: 1, openingQuantity: 10 },
          { productGlobalId: 'gp1234567', quantity: 2, openingQuantity: 10 },
        ],
      },
    }),
  }))
  assert.equal(duplicateProduct.status, 400)
  assert.equal((await payload(duplicateProduct)).code, 'OPERATIONS_REQUEST_INVALID')

  const invalidContentType = await route.POST(request('http://localhost/api/operations', {
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'run-proof-order', proof }),
  }))
  assert.equal(invalidContentType.status, 415)
  assert.equal((await payload(invalidContentType)).code, 'OPERATIONS_CONTENT_TYPE_INVALID')

  const noWorkspace = await route.GET(request('http://localhost/api/operations', {
    actor: { ...actor, organizationId: '' },
  }))
  assert.equal(noWorkspace.status, 409)
  assert.equal((await payload(noWorkspace)).code, 'ACTIVE_ORGANIZATION_REQUIRED')
  delete process.env.CLAWPILOT_OPERATIONS_PROOF_ENABLED
}

function postgresMock(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
    acquireTransactionAdvisoryLock: (client, key) => client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [key],
    ),
    withTransaction: async (work) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

function auditWriterMock() {
  return {
    recordAuditEvent: async (input, client) => {
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, aggregate_type, aggregate_id, payload, event_key,
           subject, organization_id, is_system
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
         ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
        [
          input.actor || null,
          input.eventType,
          input.aggregateType || null,
          input.aggregateId || null,
          JSON.stringify(input.payload || {}),
          input.eventKey || null,
          input.subject || input.actor || null,
          input.organizationId || null,
          input.isSystem === true,
        ],
      )
    },
  }
}

async function seedWorkspace(pool, label) {
  const suffix = randomUUID().slice(0, 8)
  const email = `operations-${label}-${suffix}@example.com`
  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', $2)`,
    [email, `Operations ${label}`],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (name, organization_type, created_by, updated_by)
     VALUES ($1, 'root', $2, $2)
     RETURNING id::text, reference_code`,
    [`Operations ${label} ${suffix}`, email],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `UPDATE app_users SET organization_id = $2::uuid, organization_name = $3 WHERE email = $1`,
    [email, organizationId, `Operations ${label} ${suffix}`],
  )
  const pipeline = await pool.query(
    `INSERT INTO pipeline_spaces (name, owner_email, is_default, workspace_organization_id)
     VALUES ($1, $2, true, $3::uuid)
     RETURNING id::text`,
    [`${label} pipeline`, email, organizationId],
  )
  const pipelineId = pipeline.rows[0].id
  const customer = await pool.query(
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key, workspace_organization_id,
       relationship_type, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $2, $4::uuid, 'customer', $2, $5, $5)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `operations-${label}-customer-${suffix}`, `${label} Customer ${suffix}`, organizationId, email],
  )
  const product = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, 'Good', 24.50, 9.25, 'USD', $2, $5, $5)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `operations-${label}-product-${suffix}`, `${label} Product ${suffix}`, `OPS-${label}-${suffix}`, email],
  )
  const secondProduct = await pool.query(
    `INSERT INTO crm_products (
       pipeline_id, source_key, name, sku, product_type, price, cost,
       currency, source_hash, created_by, updated_by
     ) VALUES ($1::uuid, $2, $3, $4, 'Good', 18.00, 6.50, 'USD', $2, $5, $5)
     RETURNING id::text, reference_code, name`,
    [pipelineId, `operations-${label}-product-2-${suffix}`, `${label} Product Two ${suffix}`, `OPS2-${label}-${suffix}`, email],
  )
  return {
    email,
    organizationId,
    organizationGlobalId: organization.rows[0].reference_code,
    pipelineId,
    customer: customer.rows[0],
    product: product.rows[0],
    secondProduct: secondProduct.rows[0],
  }
}

async function stageCommerceCustomerForAcceptance(client, input) {
  assert.equal(input.entity, 'organizations')
  const fields = input.fields || {}
  const result = await client.query(
    `INSERT INTO crm_organizations (
       pipeline_id, suitecrm_id, source_key, identity_key,
       parent_organization_id, relationship_type, name, website, phone, email,
       billing_address_street, billing_address_city, billing_address_state,
       billing_address_postal_code, billing_address_country, description,
       source_payload, source_hash, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, $3,
       $4::uuid, 'customer', $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14,
       $15::jsonb, $3, $16, $16
     )
     ON CONFLICT (pipeline_id, identity_key) DO UPDATE SET
       name = EXCLUDED.name,
       website = EXCLUDED.website,
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING id::text, suitecrm_id, reference_code`,
    [
      input.pipelineId,
      `acceptance-${randomUUID()}`,
      input.sourceKey,
      fields.parentOrganizationId || null,
      fields.name,
      fields.website || null,
      fields.phone || null,
      fields.email || null,
      fields.address || null,
      fields.city || null,
      fields.state || null,
      fields.postalCode || null,
      fields.country || null,
      fields.description || null,
      JSON.stringify(input.sourcePayload || {}),
      input.actorEmail,
    ],
  )
  return {
    id: result.rows[0].id,
    suiteCrmId: result.rows[0].suitecrm_id,
    referenceCode: result.rows[0].reference_code,
    shortUrl: null,
    sourceHash: input.sourceKey,
  }
}

function proofInput(fixture, externalOrderId, overrides = {}) {
  const requested = new Date()
  requested.setUTCDate(requested.getUTCDate() + 10)
  return {
    customerGlobalId: fixture.customer.reference_code,
    productGlobalId: fixture.product.reference_code,
    externalOrderId,
    orderNumber: `ORDER-${externalOrderId.slice(-8)}`,
    quantity: 2,
    openingQuantity: 12,
    requestedDeliveryAt: requested.toISOString(),
    shipTo: {
      name: 'Receiving',
      line1: '200 Customer Lane',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    },
    ...overrides,
  }
}

async function expectRejected(work, predicate, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (predicate) assert.ok(predicate(error), `${message}: ${String(error?.message || error)}`)
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000 })
  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
      }
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function verifyPostgresAcceptance(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 20_000,
  })
  try {
    await pool.query('SELECT 1')
    const postgres = postgresMock(pool)
    const auditWriter = auditWriterMock()
    const domain = loadTypeScriptModule('app_src/lib/operations/domain.ts')
    const adapters = loadTypeScriptModule('app_src/lib/operations/adapters.ts', {
      mocks: { '@/lib/operations/domain': domain },
    })
    const stableId = loadTypeScriptModule('app_src/lib/crm/stableId.ts')
    const packingSlip = loadTypeScriptModule('app_src/lib/operations/packingSlip.ts')
    const productPackaging = loadTypeScriptModule('app_src/lib/persistence/productPackaging.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/persistence/postgres': postgres,
      },
    })
    const persistence = loadTypeScriptModule('app_src/lib/persistence/operations.ts', {
      mocks: {
        '@/lib/auditWriter': auditWriter,
        '@/lib/crm/stableId': stableId,
        '@/lib/operations/adapters': adapters,
        '@/lib/operations/domain': domain,
        '@/lib/operations/packingSlip': packingSlip,
        '@/lib/persistence/crm': {
          stageCrmRecordWithClient: stageCommerceCustomerForAcceptance,
        },
        '@/lib/persistence/operationPrintDelivery': {
          enqueueOperationsPrintJobInPostgres: async () => ({
            printJobGlobalId: null,
            printJobStatus: null,
            printWarning: 'No printer configured in distributed operations acceptance.',
          }),
        },
        '@/lib/persistence/postgres': postgres,
        '@/lib/persistence/productPackaging': productPackaging,
      },
    })
    const primary = await seedWorkspace(pool, 'primary')
    const other = await seedWorkspace(pool, 'other')
    const firstPackageProfile = await postgres.withTransaction((client) => (
      productPackaging.upsertProductPackagingProfileWithClient(client, {
        organizationId: primary.organizationId,
        pipelineId: primary.pipelineId,
        productId: primary.product.id,
        actorEmail: primary.email,
        profile: {
          profileName: 'Default case',
          packageType: 'case',
          unitOfMeasure: 'case',
          unitsPerPackage: 2,
          measurementSystem: 'metric',
          lengthMm: 410,
          widthMm: 310,
          heightMm: 205,
          weightGrams: 1100,
          active: true,
          source: 'csv_import',
        },
      })
    ))
    assert.match(firstPackageProfile.globalId, /^gpp\d{7}$/)
    assert.equal(firstPackageProfile.rowVersion, 0)
    assert.equal(firstPackageProfile.source, 'csv_import')
    assert.equal(firstPackageProfile.measurementSystem, 'metric')

    const updatedPackageProfile = await postgres.withTransaction((client) => (
      productPackaging.upsertProductPackagingProfileWithClient(client, {
        organizationId: primary.organizationId,
        pipelineId: primary.pipelineId,
        productId: primary.product.id,
        actorEmail: primary.email,
        profile: {
          profileName: 'Team-managed case',
          packageType: 'case',
          unitOfMeasure: 'case',
          unitsPerPackage: 2,
          measurementSystem: 'imperial',
          lengthMm: 420,
          widthMm: 320,
          heightMm: 210,
          weightGrams: 1200,
          active: true,
          source: 'manual',
        },
      })
    ))
    assert.equal(updatedPackageProfile.globalId, firstPackageProfile.globalId)
    assert.equal(updatedPackageProfile.rowVersion, 1)
    assert.equal(updatedPackageProfile.source, 'manual')
    assert.equal(updatedPackageProfile.measurementSystem, 'imperial')
    const packageProfileEvidence = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_product_package_profiles
          WHERE organization_id = $1::uuid AND product_id = $2::uuid)::int AS profiles,
         (SELECT count(*) FROM audit_events
          WHERE organization_id = $1::uuid
            AND aggregate_id = $3
            AND event_type = 'operations.product_packaging.updated')::int AS audits`,
      [primary.organizationId, primary.product.id, firstPackageProfile.globalId],
    )
    assert.deepEqual(packageProfileEvidence.rows[0], { profiles: 1, audits: 2 })
    await expectRejected(
      () => postgres.withTransaction((client) => (
        productPackaging.upsertProductPackagingProfileWithClient(client, {
          organizationId: other.organizationId,
          pipelineId: primary.pipelineId,
          productId: primary.product.id,
          actorEmail: other.email,
          profile: {
            profileName: 'Cross-workspace case',
            packageType: 'case',
            unitOfMeasure: 'case',
            unitsPerPackage: 1,
            measurementSystem: 'metric',
            lengthMm: 100,
            widthMm: 100,
            heightMm: 100,
            weightGrams: 100,
            active: true,
            source: 'manual',
          },
        })
      )),
      (error) => error.code === '23503',
      'Cross-workspace package profile writes must fail',
    )
    const externalOrderId = `mock-${randomUUID()}`
    const primaryProof = proofInput(primary, externalOrderId, { executionMode: 'shipped' })
    const first = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: primaryProof,
    })
    assert.match(first.orderGlobalId, /^gor\d{7}$/)
    assert.equal(first.orderStatus, 'shipped')
    assert.equal(first.duplicate, false)
    assert.match(first.trackingNumber, /^MOCK[A-F0-9]{18}$/)
    assert.equal(first.steps.length, 20)

    const commerceIntegration = await pool.query(
      `SELECT global_id
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid
         AND provider = 'mock-commerce'
         AND integration_type = 'commerce'
         AND status = 'active'`,
      [primary.organizationId],
    )
    assert.equal(commerceIntegration.rowCount, 1)
    await pool.query(
      `UPDATE crm_organizations
       SET email = $3, phone = $4, website = $5, updated_at = now()
       WHERE pipeline_id = $1::uuid AND id = $2::uuid`,
      [
        primary.pipelineId,
        primary.customer.id,
        `buyer-${primary.organizationId}@example.com`,
        '+1 (203) 555-0188',
        'https://existing-customer.example.com',
      ],
    )
    const existingExternalId = `existing-${randomUUID()}`
    const matchedCustomer = await persistence.resolveCommerceCustomerInPostgres({
      organizationId: primary.organizationId,
      integrationAccountGlobalId: commerceIntegration.rows[0].global_id,
      actorEmail: `system:mock-commerce`,
      identity: {
        provider: 'mock-commerce',
        externalCustomerId: existingExternalId,
        companyName: 'Provider display name does not control identity',
        email: `buyer-${primary.organizationId}@example.com`,
      },
    })
    assert.equal(matchedCustomer.status, 'matched')
    assert.equal(matchedCustomer.method, 'email')
    assert.equal(matchedCustomer.customer.globalId, primary.customer.reference_code)
    const matchedAgain = await persistence.resolveCommerceCustomerInPostgres({
      organizationId: primary.organizationId,
      integrationAccountGlobalId: commerceIntegration.rows[0].global_id,
      actorEmail: `system:mock-commerce`,
      identity: {
        provider: 'mock-commerce',
        externalCustomerId: existingExternalId,
        companyName: 'Renamed at provider',
      },
    })
    assert.equal(matchedAgain.status, 'matched')
    assert.equal(matchedAgain.method, 'external_id')
    assert.equal(matchedAgain.customer.globalId, primary.customer.reference_code)

    const createdExternalId = `new-customer-${randomUUID()}`
    const createdCustomer = await persistence.resolveCommerceCustomerInPostgres({
      organizationId: primary.organizationId,
      integrationAccountGlobalId: commerceIntegration.rows[0].global_id,
      actorEmail: `system:mock-commerce`,
      identity: {
        provider: 'mock-commerce',
        externalCustomerId: createdExternalId,
        companyName: `New Provider Customer ${randomUUID().slice(0, 8)}`,
        email: `new-provider-${randomUUID().slice(0, 8)}@example.net`,
      },
    })
    assert.equal(createdCustomer.status, 'created')
    assert.equal(createdCustomer.method, 'created')
    assert.match(createdCustomer.customer.globalId, /^ga\d{7}$/)
    const createdAgain = await persistence.resolveCommerceCustomerInPostgres({
      organizationId: primary.organizationId,
      integrationAccountGlobalId: commerceIntegration.rows[0].global_id,
      actorEmail: `system:mock-commerce`,
      identity: {
        provider: 'mock-commerce',
        externalCustomerId: createdExternalId,
        companyName: 'Provider later changed the company name',
      },
    })
    assert.equal(createdAgain.status, 'matched')
    assert.equal(createdAgain.method, 'external_id')
    assert.equal(createdAgain.customer.globalId, createdCustomer.customer.globalId)
    const customerCount = await pool.query(
      `SELECT count(*)::int AS count
       FROM crm_organizations
       WHERE pipeline_id = $1::uuid`,
      [primary.pipelineId],
    )
    assert.equal(customerCount.rows[0].count, 2)

    const baseline = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid)::int AS orders,
         (SELECT count(*) FROM operations_order_lines WHERE organization_id = $1::uuid)::int AS lines,
         (SELECT count(*) FROM operations_reservations WHERE organization_id = $1::uuid)::int AS reservations,
         (SELECT count(*) FROM operations_shipments WHERE organization_id = $1::uuid)::int AS shipments,
         (SELECT count(*) FROM operations_billable_events WHERE organization_id = $1::uuid)::int AS billables,
         (SELECT count(*) FROM operations_domain_events WHERE organization_id = $1::uuid)::int AS events,
         (SELECT count(*) FROM sync_outbox WHERE aggregate_type = 'operations.order' AND aggregate_id = $2)::int AS outbox,
         (SELECT count(*) FROM audit_events WHERE organization_id = $1::uuid AND event_type = 'operations.proof_order.completed')::int AS audits`,
      [primary.organizationId, first.orderGlobalId],
    )
    assert.equal(baseline.rows[0].orders, 1)
    assert.equal(baseline.rows[0].lines, 1)
    assert.equal(baseline.rows[0].reservations, 1)
    assert.equal(baseline.rows[0].shipments, 1)
    assert.equal(baseline.rows[0].billables, 4)
    assert.ok(baseline.rows[0].events >= 14)
    assert.equal(baseline.rows[0].outbox, 1)
    assert.equal(baseline.rows[0].audits, 1)

    const duplicate = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: primaryProof,
    })
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.orderGlobalId, first.orderGlobalId)
    assert.equal(duplicate.trackingNumber, first.trackingNumber)
    const afterRetry = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_orders WHERE organization_id = $1::uuid)::int AS orders,
         (SELECT count(*) FROM operations_shipments WHERE organization_id = $1::uuid)::int AS shipments,
         (SELECT count(*) FROM operations_billable_events WHERE organization_id = $1::uuid)::int AS billables,
         (SELECT count(*) FROM operations_domain_events WHERE organization_id = $1::uuid)::int AS events`,
      [primary.organizationId],
    )
    assert.deepEqual(afterRetry.rows[0], {
      orders: baseline.rows[0].orders,
      shipments: baseline.rows[0].shipments,
      billables: baseline.rows[0].billables,
      events: baseline.rows[0].events,
    })

    const inventory = await pool.query(
      `SELECT position.id::text, position.on_hand_quantity::text, position.reserved_quantity::text,
              pool.owner_customer_id::text,
              COALESCE(sum(ledger.on_hand_delta), 0)::text AS ledger_on_hand,
              COALESCE(sum(ledger.reserved_delta), 0)::text AS ledger_reserved,
              count(ledger.id)::int AS ledger_entries
       FROM operations_inventory_positions position
       JOIN operations_inventory_pools pool ON pool.organization_id = position.organization_id AND pool.id = position.pool_id
       LEFT JOIN operations_inventory_ledger ledger ON ledger.organization_id = position.organization_id AND ledger.position_id = position.id
       WHERE position.organization_id = $1::uuid
       GROUP BY position.id, pool.owner_customer_id`,
      [primary.organizationId],
    )
    assert.equal(inventory.rows.length, 1)
    assert.equal(inventory.rows[0].on_hand_quantity, '10.000000')
    assert.equal(inventory.rows[0].reserved_quantity, '0.000000')
    assert.equal(inventory.rows[0].ledger_on_hand, '10.000000')
    assert.equal(inventory.rows[0].ledger_reserved, '0.000000')
    assert.equal(inventory.rows[0].ledger_entries, 4)
    assert.equal(inventory.rows[0].owner_customer_id, primary.customer.id)

    const money = await pool.query(
      `SELECT plan.estimated_revenue_minor::text,
              sum(billable.amount_minor)::text AS billable_total,
              count(*)::int AS billable_count
       FROM operations_orders orders
       JOIN operations_fulfillment_plans plan ON plan.organization_id = orders.organization_id AND plan.order_id = orders.id
       JOIN operations_billable_events billable ON billable.organization_id = orders.organization_id AND billable.order_id = orders.id
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       GROUP BY plan.id`,
      [primary.organizationId, first.orderGlobalId],
    )
    assert.equal(money.rows[0].estimated_revenue_minor, money.rows[0].billable_total)
    assert.equal(money.rows[0].billable_total, '1472')
    assert.equal(money.rows[0].billable_count, 4)

    const workspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: first.orderGlobalId,
    })
    assert.equal(workspace.orders.length, 1)
    assert.equal(workspace.selectedOrder.globalId, first.orderGlobalId)
    assert.equal(workspace.selectedOrder.lines[0].reservedQuantity, 0)
    assert.equal(workspace.selectedOrder.packages[0].status, 'shipped')
    assert.equal(workspace.selectedOrder.rates.filter((rate) => rate.selected).length, 1)
    assert.equal(workspace.selectedOrder.billableEvents.length, 4)
    assert.equal(workspace.summary.openOrders, 0)
    assert.equal(workspace.summary.shippedToday, 1)
    // Test-only MOCK-01 stock remains available to the internal harness but is
    // deliberately absent from hosted workbench inventory projections.
    assert.equal(workspace.summary.availableUnits, 0)
    assert.equal(workspace.summary.reservedUnits, 0)
    assert.equal(workspace.summary.unbilledMinor, '1472')

    const multiExternalOrderId = `multi-${randomUUID()}`
    const multiProof = proofInput(primary, multiExternalOrderId, { executionMode: 'shipped' })
    delete multiProof.productGlobalId
    delete multiProof.quantity
    delete multiProof.openingQuantity
    multiProof.lines = [
      { productGlobalId: primary.product.reference_code, quantity: 2, openingQuantity: 12 },
      { productGlobalId: primary.secondProduct.reference_code, quantity: 3, openingQuantity: 9 },
    ]
    const multi = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: multiProof,
    })
    assert.equal(multi.orderStatus, 'shipped')
    assert.equal(multi.duplicate, false)

    const multiEvidence = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_order_lines line
           WHERE line.organization_id = orders.organization_id AND line.order_id = orders.id)::int AS lines,
         (SELECT count(*) FROM operations_reservations reservation
           JOIN operations_order_lines line ON line.organization_id = reservation.organization_id
            AND line.id = reservation.order_line_id
          WHERE line.organization_id = orders.organization_id AND line.order_id = orders.id)::int AS reservations,
         (SELECT count(*) FROM operations_fulfillment_allocations allocation
           JOIN operations_order_lines line ON line.organization_id = allocation.organization_id
            AND line.id = allocation.order_line_id
          WHERE line.organization_id = orders.organization_id AND line.order_id = orders.id)::int AS allocations,
         (SELECT count(*) FROM operations_pick_tasks pick
           JOIN operations_fulfillment_allocations allocation ON allocation.organization_id = pick.organization_id
            AND allocation.id = pick.allocation_id
           JOIN operations_order_lines line ON line.organization_id = allocation.organization_id
            AND line.id = allocation.order_line_id
          WHERE line.organization_id = orders.organization_id AND line.order_id = orders.id)::int AS picks,
         (SELECT count(*) FROM operations_shipments shipment
           WHERE shipment.organization_id = orders.organization_id AND shipment.order_id = orders.id)::int AS shipments
       FROM operations_orders orders
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2`,
      [primary.organizationId, multi.orderGlobalId],
    )
    assert.deepEqual(multiEvidence.rows[0], {
      lines: 2,
      reservations: 2,
      allocations: 2,
      picks: 2,
      shipments: 1,
    })
    const multiWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: multi.orderGlobalId,
    })
    assert.equal(multiWorkspace.selectedOrder.lines.length, 2)
    assert.deepEqual(
      multiWorkspace.selectedOrder.lines.map((line) => line.productGlobalId).sort(),
      [primary.product.reference_code, primary.secondProduct.reference_code].sort(),
    )
    assert.equal(multiWorkspace.selectedOrder.lines.every((line) => line.reservedQuantity === 0), true)
    assert.equal(multiWorkspace.selectedOrder.packages.length, 1)
    assert.equal(multiWorkspace.selectedOrder.packages[0].status, 'shipped')

    const multiDuplicate = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: multiProof,
    })
    assert.equal(multiDuplicate.duplicate, true)
    assert.equal(multiDuplicate.orderGlobalId, multi.orderGlobalId)
    const multiAfterRetry = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_order_lines line
           JOIN operations_orders orders ON orders.organization_id = line.organization_id AND orders.id = line.order_id
          WHERE orders.organization_id = $1::uuid AND orders.global_id = $2)::int AS lines,
         (SELECT count(*) FROM operations_shipments shipment
           JOIN operations_orders orders ON orders.organization_id = shipment.organization_id AND orders.id = shipment.order_id
          WHERE orders.organization_id = $1::uuid AND orders.global_id = $2)::int AS shipments`,
      [primary.organizationId, multi.orderGlobalId],
    )
    assert.deepEqual(multiAfterRetry.rows[0], { lines: 2, shipments: 1 })

    const plannedExternalOrderId = `planned-${randomUUID()}`
    const planned = await persistence.runMockOperationsProofFromPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      proof: proofInput(primary, plannedExternalOrderId, {
        executionMode: 'planned',
        quantity: 1,
      }),
    })
    assert.equal(planned.orderStatus, 'planned')
    assert.equal(planned.duplicate, false)
    assert.equal(planned.trackingNumber, null)
    assert.equal(planned.steps.length, 11)

    const plannedWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: planned.orderGlobalId,
    })
    assert.equal(plannedWorkspace.selectedOrder.status, 'planned')
    assert.equal(plannedWorkspace.selectedOrder.planStatus, 'planned')
    assert.equal(plannedWorkspace.selectedOrder.waveStatus, null)
    assert.equal(plannedWorkspace.selectedOrder.lines.length, 1)
    assert.equal(plannedWorkspace.selectedOrder.lines[0].reservedQuantity, 1)
    assert.equal(plannedWorkspace.selectedOrder.lines[0].pickStatus, null)
    assert.equal(plannedWorkspace.selectedOrder.packages[0].status, 'planned')
    assert.equal(plannedWorkspace.selectedOrder.packages[0].weightGrams, 1200)
    assert.deepEqual(
      JSON.parse(JSON.stringify(plannedWorkspace.selectedOrder.packages[0].dimensionsMm)),
      { length: 420, width: 320, height: 210 },
    )
    assert.equal(plannedWorkspace.selectedOrder.pickTaskCount, 0)
    assert.equal(plannedWorkspace.selectedOrder.readyPickTaskCount, 0)
    const plannedReleaseAction = plannedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'release_to_warehouse',
    )
    const plannedPickAction = plannedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'confirm_picks',
    )
    const plannedPackAction = plannedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'verify_pack',
    )
    assert.equal(plannedReleaseAction.enabled, true)
    assert.equal(plannedPickAction.enabled, false)
    assert.equal(plannedPackAction.enabled, false)

    const expectedRowVersion = plannedWorkspace.selectedOrder.rowVersion
    const releaseInput = {
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      orderGlobalId: planned.orderGlobalId,
      expectedRowVersion,
      reason: 'Acceptance review completed',
      idempotencyKey: `release-acceptance-${randomUUID()}`,
    }
    const released = await persistence.releaseOperationsOrderFromPostgres(releaseInput)
    assert.equal(released.orderGlobalId, planned.orderGlobalId)
    assert.equal(released.orderStatus, 'released')
    assert.equal(released.rowVersion, expectedRowVersion + 1)
    assert.equal(released.replayed, false)

    const replayedRelease = await persistence.releaseOperationsOrderFromPostgres(releaseInput)
    assert.deepEqual(JSON.parse(JSON.stringify(replayedRelease)), {
      ...JSON.parse(JSON.stringify(released)),
      replayed: true,
    })

    const releaseEvidence = await pool.query(
      `SELECT orders.status, orders.row_version::int,
              plan.status AS plan_status,
              count(DISTINCT wave.id)::int AS waves,
              min(wave.status) AS wave_status,
              count(DISTINCT pick.id)::int AS picks,
              min(pick.status) AS pick_status,
              (SELECT count(*) FROM operations_domain_events event
               WHERE event.organization_id = orders.organization_id
                 AND event.aggregate_global_id = orders.global_id
                 AND event.event_type = 'operations.wave.released')::int AS release_events,
              (SELECT count(*) FROM audit_events audit
               WHERE audit.organization_id = orders.organization_id
                 AND audit.aggregate_id = orders.global_id
                 AND audit.event_type = 'operations.order.released')::int AS release_audits
       FROM operations_orders orders
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = orders.organization_id AND plan.order_id = orders.id
       JOIN operations_pick_tasks pick
         ON pick.organization_id = plan.organization_id AND pick.plan_id = plan.id
       JOIN operations_waves wave
         ON wave.organization_id = pick.organization_id AND wave.id = pick.wave_id
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       GROUP BY orders.id, plan.id`,
      [primary.organizationId, planned.orderGlobalId],
    )
    assert.deepEqual(releaseEvidence.rows[0], {
      status: 'released',
      row_version: expectedRowVersion + 1,
      plan_status: 'released',
      waves: 1,
      wave_status: 'released',
      picks: 1,
      pick_status: 'ready',
      release_events: 1,
      release_audits: 1,
    })

    const releasedWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: planned.orderGlobalId,
    })
    assert.equal(releasedWorkspace.selectedOrder.status, 'released')
    assert.equal(releasedWorkspace.selectedOrder.planStatus, 'released')
    assert.equal(releasedWorkspace.selectedOrder.waveStatus, 'released')
    assert.equal(releasedWorkspace.selectedOrder.lines[0].pickStatus, 'ready')
    assert.equal(releasedWorkspace.selectedOrder.pickTaskCount, 1)
    assert.equal(releasedWorkspace.selectedOrder.readyPickTaskCount, 1)
    const releasedReleaseAction = releasedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'release_to_warehouse',
    )
    const releasedPickAction = releasedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'confirm_picks',
    )
    assert.equal(releasedReleaseAction.enabled, false)
    assert.match(releasedReleaseAction.blockedReason, /already released/i)
    assert.equal(releasedPickAction.enabled, true)

    const pickInput = {
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      orderGlobalId: planned.orderGlobalId,
      expectedRowVersion: released.rowVersion,
      reason: 'Acceptance picker verified the released wave',
      idempotencyKey: `picks-acceptance-${randomUUID()}`,
    }
    const picked = await persistence.confirmOperationsOrderPicksFromPostgres(pickInput)
    assert.equal(picked.orderGlobalId, planned.orderGlobalId)
    assert.equal(picked.orderStatus, 'picking')
    assert.equal(picked.rowVersion, released.rowVersion + 1)
    assert.equal(picked.replayed, false)

    const replayedPicks = await persistence.confirmOperationsOrderPicksFromPostgres(pickInput)
    assert.deepEqual(JSON.parse(JSON.stringify(replayedPicks)), {
      ...JSON.parse(JSON.stringify(picked)),
      replayed: true,
    })

    const releaseReplayAfterPick = await persistence.releaseOperationsOrderFromPostgres(releaseInput)
    assert.deepEqual(JSON.parse(JSON.stringify(releaseReplayAfterPick)), {
      ...JSON.parse(JSON.stringify(released)),
      replayed: true,
    })

    const pickEvidence = await pool.query(
      `SELECT orders.status, orders.row_version::int,
              plan.status AS plan_status,
              count(DISTINCT wave.id)::int AS waves,
              min(wave.status) AS wave_status,
              count(DISTINCT pick.id)::int AS picks,
              min(pick.status) AS pick_status,
              bool_and(pick.picked_quantity = pick.quantity) AS picks_complete,
              (SELECT count(*) FROM operations_domain_events event
               WHERE event.organization_id = orders.organization_id
                 AND event.aggregate_global_id = orders.global_id
                 AND event.event_type = 'operations.pick.completed')::int AS pick_events,
              (SELECT count(*) FROM audit_events audit
               WHERE audit.organization_id = orders.organization_id
                 AND audit.aggregate_id = orders.global_id
                 AND audit.event_type = 'operations.order.picks_confirmed')::int AS pick_audits,
              (SELECT count(*) FROM operations_inventory_ledger ledger
               JOIN operations_pick_tasks ledger_pick
                 ON ledger_pick.organization_id = ledger.organization_id
                AND ledger_pick.global_id = ledger.source_global_id
               WHERE ledger.organization_id = orders.organization_id
                 AND ledger_pick.plan_id = plan.id
                 AND ledger.event_type = 'pick')::int AS pick_ledger_events,
              (SELECT count(*) FROM operations_reservations reservation
               JOIN operations_order_lines line
                 ON line.organization_id = reservation.organization_id
                AND line.id = reservation.order_line_id
               WHERE line.organization_id = orders.organization_id
                 AND line.order_id = orders.id
                 AND reservation.status = 'active')::int AS active_reservations,
              (SELECT sum(position.reserved_quantity)::text
               FROM operations_inventory_positions position
               JOIN operations_fulfillment_allocations allocation
                 ON allocation.organization_id = position.organization_id
                AND allocation.position_id = position.id
               JOIN operations_order_lines line
                 ON line.organization_id = allocation.organization_id
                AND line.id = allocation.order_line_id
               WHERE line.organization_id = orders.organization_id
                 AND line.order_id = orders.id) AS reserved_quantity
       FROM operations_orders orders
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = orders.organization_id AND plan.order_id = orders.id
       JOIN operations_pick_tasks pick
         ON pick.organization_id = plan.organization_id AND pick.plan_id = plan.id
       JOIN operations_waves wave
         ON wave.organization_id = pick.organization_id AND wave.id = pick.wave_id
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       GROUP BY orders.id, plan.id`,
      [primary.organizationId, planned.orderGlobalId],
    )
    assert.deepEqual(pickEvidence.rows[0], {
      status: 'picking',
      row_version: released.rowVersion + 1,
      plan_status: 'released',
      waves: 1,
      wave_status: 'completed',
      picks: 1,
      pick_status: 'picked',
      picks_complete: true,
      pick_events: 1,
      pick_audits: 1,
      pick_ledger_events: 1,
      active_reservations: 1,
      reserved_quantity: '1.000000',
    })

    const pickingWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: planned.orderGlobalId,
    })
    assert.equal(pickingWorkspace.selectedOrder.status, 'picking')
    assert.equal(pickingWorkspace.selectedOrder.planStatus, 'released')
    assert.equal(pickingWorkspace.selectedOrder.waveStatus, 'completed')
    assert.equal(pickingWorkspace.selectedOrder.lines[0].pickStatus, 'picked')
    assert.equal(pickingWorkspace.selectedOrder.pickTaskCount, 1)
    assert.equal(pickingWorkspace.selectedOrder.readyPickTaskCount, 0)
    const pickingPickAction = pickingWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'confirm_picks',
    )
    const pickingPackAction = pickingWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'verify_pack',
    )
    assert.equal(pickingPickAction.enabled, false)
    assert.match(pickingPickAction.blockedReason, /already confirmed/i)
    assert.equal(pickingPackAction.enabled, true)

    const packInput = {
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      orderGlobalId: planned.orderGlobalId,
      expectedRowVersion: picked.rowVersion,
      reason: 'Acceptance packer verified the planned carton',
      idempotencyKey: `pack-acceptance-${randomUUID()}`,
    }
    const packed = await persistence.verifyOperationsOrderPackFromPostgres(packInput)
    assert.equal(packed.orderGlobalId, planned.orderGlobalId)
    assert.equal(packed.orderStatus, 'packed')
    assert.equal(packed.rowVersion, picked.rowVersion + 1)
    assert.equal(packed.replayed, false)

    const replayedPack = await persistence.verifyOperationsOrderPackFromPostgres(packInput)
    assert.deepEqual(JSON.parse(JSON.stringify(replayedPack)), {
      ...JSON.parse(JSON.stringify(packed)),
      replayed: true,
    })
    const pickReplayAfterPack = await persistence.confirmOperationsOrderPicksFromPostgres(pickInput)
    assert.deepEqual(JSON.parse(JSON.stringify(pickReplayAfterPack)), {
      ...JSON.parse(JSON.stringify(picked)),
      replayed: true,
    })
    const releaseReplayAfterPack = await persistence.releaseOperationsOrderFromPostgres(releaseInput)
    assert.deepEqual(JSON.parse(JSON.stringify(releaseReplayAfterPack)), {
      ...JSON.parse(JSON.stringify(released)),
      replayed: true,
    })

    const packEvidence = await pool.query(
      `SELECT orders.status, orders.row_version::int,
              min(package.status) AS package_status,
              (SELECT count(*) FROM operations_domain_events event
               WHERE event.organization_id = orders.organization_id
                 AND event.aggregate_global_id = orders.global_id
                 AND event.event_type = 'operations.package.packed')::int AS pack_events,
              (SELECT count(*) FROM audit_events audit
               WHERE audit.organization_id = orders.organization_id
                 AND audit.aggregate_id = orders.global_id
                 AND audit.event_type = 'operations.order.pack_verified')::int AS pack_audits,
              (SELECT count(*) FROM operations_billable_events billable
               WHERE billable.organization_id = orders.organization_id
                 AND billable.order_id = orders.id
                 AND billable.event_type = 'pack')::int AS pack_billables,
              (SELECT count(*) FROM operations_reservations reservation
               JOIN operations_order_lines line
                 ON line.organization_id = reservation.organization_id
                AND line.id = reservation.order_line_id
               WHERE line.organization_id = orders.organization_id
                 AND line.order_id = orders.id
                 AND reservation.status = 'active')::int AS active_reservations,
              (SELECT count(*) FROM operations_shipments shipment
               WHERE shipment.organization_id = orders.organization_id
                 AND shipment.order_id = orders.id)::int AS shipments,
              (SELECT count(*) FROM operations_labels label
               WHERE label.organization_id = orders.organization_id
                 AND label.package_id IN (
                   SELECT package_filter.id
                   FROM operations_packages package_filter
                   WHERE package_filter.organization_id = orders.organization_id
                     AND package_filter.plan_id = plan.id
                 ))::int AS labels,
              (SELECT count(*) FROM operations_print_jobs print_job
               WHERE print_job.organization_id = orders.organization_id
                 AND print_job.label_id IN (
                   SELECT label_filter.id
                   FROM operations_labels label_filter
                   JOIN operations_packages package_filter
                     ON package_filter.organization_id = label_filter.organization_id
                    AND package_filter.id = label_filter.package_id
                   WHERE package_filter.organization_id = orders.organization_id
                     AND package_filter.plan_id = plan.id
                 ))::int AS print_jobs
       FROM operations_orders orders
       JOIN operations_fulfillment_plans plan
         ON plan.organization_id = orders.organization_id AND plan.order_id = orders.id
       JOIN operations_packages package
         ON package.organization_id = plan.organization_id AND package.plan_id = plan.id
       WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       GROUP BY orders.id, plan.id`,
      [primary.organizationId, planned.orderGlobalId],
    )
    assert.deepEqual(packEvidence.rows[0], {
      status: 'packed',
      row_version: picked.rowVersion + 1,
      package_status: 'packed',
      pack_events: 1,
      pack_audits: 1,
      pack_billables: 1,
      active_reservations: 1,
      shipments: 0,
      labels: 0,
      print_jobs: 0,
    })

    const packedWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      selectedOrderGlobalId: planned.orderGlobalId,
    })
    assert.equal(packedWorkspace.selectedOrder.status, 'packed')
    assert.equal(packedWorkspace.selectedOrder.packages[0].status, 'packed')
    const packedPackAction = packedWorkspace.selectedOrder.availableActions.find(
      (action) => action.action === 'verify_pack',
    )
    assert.equal(packedPackAction.enabled, false)
    assert.match(packedPackAction.blockedReason, /already complete/i)

    await expectRejected(
      () => persistence.verifyOperationsOrderPackFromPostgres({
        ...packInput,
        idempotencyKey: `pack-stale-${randomUUID()}`,
      }),
      (error) => error.code === 'OPERATIONS_ORDER_VERSION_CONFLICT',
      'A stale order version must not verify warehouse packages twice',
    )

    await expectRejected(
      () => persistence.confirmOperationsOrderPicksFromPostgres({
        ...pickInput,
        idempotencyKey: `picks-stale-${randomUUID()}`,
      }),
      (error) => error.code === 'OPERATIONS_ORDER_VERSION_CONFLICT',
      'A stale order version must not confirm warehouse picks twice',
    )

    await expectRejected(
      () => persistence.releaseOperationsOrderFromPostgres({
        ...releaseInput,
        idempotencyKey: `release-stale-${randomUUID()}`,
      }),
      (error) => error.code === 'OPERATIONS_ORDER_VERSION_CONFLICT',
      'A stale order version must not release warehouse work twice',
    )

    const exceptionSeed = await pool.query(
      `INSERT INTO operations_exceptions (
         organization_id, order_id, exception_type, severity, title, details, assigned_to
       ) SELECT $1::uuid, orders.id, 'inventory_variance', 'high',
           'Verify reserved inventory', $3::jsonb, $4
         FROM operations_orders orders
        WHERE orders.organization_id = $1::uuid AND orders.global_id = $2
       RETURNING global_id`,
      [
        primary.organizationId,
        first.orderGlobalId,
        JSON.stringify({ recommendedAction: 'Reconcile the location count.', evidence: { expected: 12, observed: 10 } }),
        primary.email,
      ],
    )
    assert.match(exceptionSeed.rows[0].global_id, /^gex\d{7}$/)
    const exceptionWorkspace = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: primary.organizationId,
      capabilities: { canView: true, canManage: true, canExecute: true },
      exceptionStatus: 'open',
    })
    assert.equal(exceptionWorkspace.exceptions.length, 1)
    assert.equal(exceptionWorkspace.exceptions[0].orderGlobalId, first.orderGlobalId)
    assert.equal(exceptionWorkspace.exceptions[0].customerGlobalId, primary.customer.reference_code)
    assert.equal(exceptionWorkspace.exceptions[0].details.recommendedAction, 'Reconcile the location count.')
    assert.equal(exceptionWorkspace.summary.exceptions, 1)

    const acknowledged = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'acknowledged',
    })
    assert.equal(acknowledged.changed, true)
    assert.equal(acknowledged.exception.status, 'acknowledged')
    const acknowledgedAgain = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'acknowledged',
    })
    assert.equal(acknowledgedAgain.changed, false)
    const resolved = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'resolved',
    })
    assert.equal(resolved.exception.status, 'resolved')
    assert.ok(resolved.exception.resolvedAt)
    await expectRejected(
      () => persistence.updateOperationsExceptionInPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        exceptionGlobalId: exceptionSeed.rows[0].global_id,
        status: 'dismissed',
      }),
      (error) => error.code === 'OPERATIONS_EXCEPTION_TRANSITION_INVALID',
      'Resolved exceptions must be reopened before a new disposition',
    )
    const reopened = await persistence.updateOperationsExceptionInPostgres({
      organizationId: primary.organizationId,
      actorEmail: primary.email,
      exceptionGlobalId: exceptionSeed.rows[0].global_id,
      status: 'open',
    })
    assert.equal(reopened.exception.status, 'open')
    assert.equal(reopened.exception.resolvedAt, null)
    const exceptionEvidence = await pool.query(
      `SELECT
         (SELECT count(*) FROM operations_domain_events
          WHERE organization_id = $1::uuid AND aggregate_global_id = $2)::int AS domain_events,
         (SELECT count(*) FROM audit_events
          WHERE organization_id = $1::uuid AND aggregate_id = $2)::int AS audit_events`,
      [primary.organizationId, exceptionSeed.rows[0].global_id],
    )
    assert.deepEqual(exceptionEvidence.rows[0], { domain_events: 3, audit_events: 3 })

    await expectRejected(
      () => persistence.updateOperationsExceptionInPostgres({
        organizationId: other.organizationId,
        actorEmail: other.email,
        exceptionGlobalId: exceptionSeed.rows[0].global_id,
        status: 'acknowledged',
      }),
      (error) => error.code === 'OPERATIONS_EXCEPTION_NOT_FOUND',
      'Cross-workspace exception updates must fail',
    )

    const isolated = await persistence.readOperationsWorkspaceFromPostgres({
      organizationId: other.organizationId,
      capabilities: { canView: true, canManage: false, canExecute: false },
    })
    assert.equal(isolated.orders.length, 0)
    assert.equal(isolated.catalog.customers.length, 1)
    assert.equal(isolated.catalog.products.length, 2)
    assert.equal(JSON.stringify(isolated).includes(first.orderGlobalId), false)

    await expectRejected(
      () => persistence.runMockOperationsProofFromPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        proof: proofInput(primary, `wrong-tenant-${randomUUID()}`, {
          customerGlobalId: other.customer.reference_code,
        }),
      }),
      (error) => error.code === 'OPERATIONS_CUSTOMER_NOT_FOUND',
      'Cross-workspace customer lookup must fail',
    )

    const failedExternalOrderId = `infeasible-${randomUUID()}`
    await expectRejected(
      () => persistence.runMockOperationsProofFromPostgres({
        organizationId: primary.organizationId,
        actorEmail: primary.email,
        proof: proofInput(primary, failedExternalOrderId, { quantity: 1000, openingQuantity: 1 }),
      }),
      (error) => error.code === 'OPERATIONS_FULFILLMENT_INFEASIBLE',
      'Infeasible fulfillment must fail',
    )
    const rolledBack = await pool.query(
      `SELECT count(*)::int AS count FROM operations_orders
       WHERE organization_id = $1::uuid AND external_order_id = $2`,
      [primary.organizationId, failedExternalOrderId],
    )
    assert.equal(rolledBack.rows[0].count, 0, 'Failed order left partial state')

    await expectRejected(
      () => pool.query(
        `INSERT INTO operations_product_mappings (
           organization_id, integration_account_id, pipeline_id, product_id,
           channel_sku, external_product_id, created_by
         ) SELECT $1::uuid, integration.id, $2::uuid, $3::uuid, $4, $4, $5
           FROM operations_integration_accounts integration
          WHERE integration.organization_id = $1::uuid LIMIT 1`,
        [primary.organizationId, other.pipelineId, other.product.id, `INVALID-${randomUUID()}`, primary.email],
      ),
      (error) => error.code === '23503',
      'Cross-workspace product mapping must violate tenant foreign keys',
    )

    const ledgerId = await pool.query(
      `SELECT id::text FROM operations_inventory_ledger WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    const eventId = await pool.query(
      `SELECT id::text FROM operations_domain_events WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    const billableId = await pool.query(
      `SELECT id::text FROM operations_billable_events WHERE organization_id = $1::uuid LIMIT 1`,
      [primary.organizationId],
    )
    for (const [table, id] of [
      ['operations_inventory_ledger', ledgerId.rows[0].id],
      ['operations_domain_events', eventId.rows[0].id],
      ['operations_billable_events', billableId.rows[0].id],
    ]) {
      await expectRejected(
        () => pool.query(`UPDATE ${table} SET global_id = global_id WHERE id = $1::uuid`, [id]),
        (error) => error.code === 'P0001' && /append-only/.test(error.message),
        `${table} must reject updates`,
      )
      await expectRejected(
        () => pool.query(`DELETE FROM ${table} WHERE id = $1::uuid`, [id]),
        (error) => error.code === 'P0001' && /append-only/.test(error.message),
        `${table} must reject deletes`,
      )
    }
  } finally {
    await pool.end()
  }
}

async function verifyDisposablePostgres() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-operations-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_operations',
      '-e', 'POSTGRES_DB=clawpilot_operations',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)
    const databaseUrl = `postgresql://postgres:clawpilot_operations@127.0.0.1:${port}/clawpilot_operations`
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyPostgresAcceptance(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

async function main() {
  verifySourceContracts()
  await verifyCarrierTransport()
  await verifyRouteBehavior()
  if (!contractsOnly) await verifyDisposablePostgres()
  console.log(`Distributed operations contracts passed${contractsOnly ? '' : ' with disposable PostgreSQL acceptance'}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
