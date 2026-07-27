#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0108_operations_slotting_and_replenishment.sql')
const types = read('app_src/lib/operations/types.ts')
const persistence = read('app_src/lib/persistence/operations.ts')
const route = read('app_src/app/api/operations/route.ts')
const panel = read('app_src/components/operations/WarehouseSetupPanel.tsx')
const health = read('app_src/app/api/health/route.ts')
const predeploy = read('scripts/verify-predeploy.mjs')
const simulation = read('scripts/seed-wms-development-simulation.mjs')
const simulationRunbook = read('docs/modules/wms-development-simulation.md')
const normalization = read(
  'scripts/normalize-express-parcel-development-warehouse.mjs',
)
const normalizationRunbook = read(
  'docs/operations/express-parcel-development-warehouse-normalization.md',
)
const rootPackage = read('package.json')
const crmPersistence = read('app_src/lib/persistence/crm.ts')

for (const fragment of [
  'ADD COLUMN IF NOT EXISTS carrier_cutoffs jsonb',
  'ADD COLUMN IF NOT EXISTS storage_function text',
  "'work_area', 'reserve', 'bulk', 'forward_pick', 'mezzanine_pick'",
  'ADD COLUMN IF NOT EXISTS replenishment_mode text',
  'replenishment_source_location_id uuid',
  'operations_location_product_rules_replenishment_thresholds_valid',
  'operations_location_product_rules_replenishment_source_not_self',
]) {
  assert.ok(migration.includes(fragment), `Slotting migration missing ${fragment}`)
}

for (const fragment of [
  'carrierCutoffs: Record<string, string>',
  "storageFunction: 'work_area' | 'reserve' | 'bulk' | 'forward_pick'",
  "replenishmentMode: 'disabled' | 'min_max' | 'order_demand'",
  'replenishmentRecommendations: Array<{',
  'inventoryPoolGlobalId: string',
  'releasedDemand: number',
]) {
  assert.ok(types.includes(fragment), `Operations workspace types missing ${fragment}`)
}

for (const fragment of [
  'carrier_cutoffs',
  'storage_function',
  'replenishmentRecommendationResult',
  "rule.replenishment_mode IN ('min_max', 'order_demand')",
  'GROUP BY position.pool_id',
  'source_balance.pool_id',
  'position.pool_id = source_balance.pool_id',
  "demand_order.status IN ('planned', 'released', 'picking')",
  'allocation_position.pool_id = source_balance.pool_id',
  "address->>'state' = 'retired'",
  "pool.name = '[DEV WMS] Shared Simulation Pool'",
  "customer.source_payload->>'state' = 'retired'",
  "['reserve', 'bulk'].includes(source.storage_function)",
  'OPERATIONS_LOCATION_REPLENISHMENT_INVALID',
  "{ code: 'RESERVE-01'",
  "{ code: 'PICKFACE-01'",
]) {
  assert.ok(persistence.includes(fragment), `Operations persistence missing ${fragment}`)
}

for (const fragment of [
  'carrierCutoffsValue',
  "'dailyOrderCapacity', 'carrierCutoffs', 'createStarterLocations'",
  "'maxWeightKg', 'allowMixedProducts', 'storageFunction', 'notes', 'productRules'",
  'replenishmentSourceLocationGlobalId',
  'targetQuantity',
]) {
  assert.ok(route.includes(fragment), `Operations API missing ${fragment}`)
}

for (const fragment of [
  'Forward pick face',
  'Mezzanine pick face',
  'Reserve storage',
  'Min / target',
  'Released order demand',
  'Reserve source',
  'Forward-pick shortages calculated within the same inventory owner and pool.',
  'UPS trailer cutoff',
  'FedEx trailer cutoff',
  'Pick route order controls task traversal inside released waves.',
]) {
  assert.ok(panel.includes(fragment), `Warehouse setup UI missing ${fragment}`)
}

for (const fileText of [health, predeploy]) {
  assert.ok(
    fileText.includes('0108_operations_slotting_and_replenishment.sql'),
    'Migration 0108 must be required by health and predeploy checks',
  )
}

for (const fragment of [
  "const ALLOWED_ENVIRONMENTS = new Set(['dev', 'development', 'local'])",
  "const SIMULATOR_LINEAGE_LOCK_PREFIX = 'clawpilot:wms-development-simulator-lineage'",
  'WMS_SIM_ORGANIZATION_ID must be an explicitly supplied UUID',
  'UPS',
  'FEDEX',
  '21:00',
  '[DEV WMS] Synthetic Fast Mover',
  "mode: 'min_max'",
  "mode: 'order_demand'",
  'storage_function',
  'carrier_cutoffs',
  '--cleanup',
  'async function assertSimulatorLineageSeedable(',
  'The WMS development simulator lineage is retired for this organization',
  'No scenario version can reseed that lineage afterward.',
  'async function resolveScenarioRetirementTarget(',
  'requires exactly one marked integration',
  'requires exactly one marked warehouse',
  'requires exactly one named simulator pool',
  'pool has inventory positions outside the marked warehouse',
  'Scenario simulator pool must have exactly one link to the marked',
  'inventory position from another pool',
  'inventory position outside exact fixture products or locations',
  'active location rule outside the exact fixture',
  'function scenarioCustomerIdentities(',
  'function isAllowedScenarioCustomerIdentity(',
  'orders.customer_id::text',
  'Scenario cleanup orders span ${customerIds.length} customers',
  'Scenario cleanup orders are bound to another marked customer',
  'Scenario cleanup marked customer belongs to another pipeline',
  'Scenario cleanup marked customer metadata is not exact',
  'Scenario cleanup marked customer identity is not an allowed exact pair',
  'Scenario generation found ${existing.rowCount} conflicting customer identities',
  'Scenario generation found a conflicting or repurposed customer identity',
  'poolCustomerResult.rowCount !== 1',
  'unrelatedReservationResult',
  'unrelatedAllocationResult',
  'unrelatedPlanResult',
  'nonterminalReceiptResult',
  'nonterminalReplenishmentResult',
  "receipt.status NOT IN ('completed', 'cancelled')",
  "task.status NOT IN ('completed', 'cancelled')",
  'Scenario cleanup refused active unrelated warehouse or pool dependents',
  'expectedExternalOrderIds',
  'Scenario cleanup orders span ${pipelineIds.length} pipelines',
  'WMS_SIM_PIPELINE_ID=${configuration.pipelineId}',
  'AS contaminated',
  'Scenario cleanup refused contaminated wave(s)',
  'reservation.order_id = ANY($2::uuid[])',
  'wave.id = ANY($2::uuid[])',
  "archive_reason = COALESCE(",
  "'wms_development_simulation_retired'",
  "'state', 'retired'",
  "exception.status IN ('open', 'acknowledged')",
  'async function assertScenarioRetired(',
  'integration_count_invalid',
  'product_count_invalid',
  'order_count_invalid',
  'warehouse_count_invalid',
  'inventory_pool_count_invalid',
  'scenario_customer_candidates AS',
  'customer_count_invalid',
  'customer_identity_invalid',
  'orders_customer_invalid',
  'pool_customer_links_invalid',
  'pool_owner_invalid',
  'claimable_suitecrm_outbox',
  'active_crm_short_links',
  'processing SuiteCRM projection(s)',
  'WMS development simulator retired before SuiteCRM delivery',
  'unrelated_active_reservations',
  'unrelated_active_allocations',
  'unrelated_non_cancelled_plans',
  'unrelated_nonterminal_receipts',
  'unrelated_nonterminal_replenishment_tasks',
  'foreign_pool_positions_in_warehouse',
  'foreign_product_or_location_positions',
  'simulator_pool_positions_outside_warehouse',
  'unrelated_active_waves',
  'unrelated_active_printers',
  'unrelated_active_print_agents',
  'postflightPassed: true',
]) {
  assert.ok(simulation.includes(fragment), `Development simulation missing ${fragment}`)
}
for (const fragment of [
  'retire-wms-simulation-preserve-printing-v1',
  '--cleanup-preserve-warehouse',
  'assertPreservedPrintingRetained',
  'assertExpectedDatabaseFingerprint',
  'PRESERVE_DISPOSABLE_REHEARSAL_CONFIRMATION',
  'TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID',
  'WMS_SIM_EXPECTED_DATABASE_FINGERPRINT',
  'WMS_SIM_PRESERVE_FOREIGN_POSITION_GLOBAL_ID',
]) {
  assert.ok(
    simulation.includes(fragment),
    `Development preserve cleanup missing ${fragment}`,
  )
}
for (const fragment of [
  'prepare-express-parcel-dev-warehouse-v1',
  'finalize-express-parcel-dev-warehouse-v1',
  'EXPRESS_PARCEL_DEV_PLAN_DIGEST',
  'operations_inventory_ledger',
  'MAX_PRINT_AGENT_AGE_MINUTES = 15',
  'assertSourceLocationsMovable',
  'DISPOSABLE_REHEARSAL_CONFIRMATION',
  'TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID',
  'TRUSTED_RAILWAY_PROJECT_ID',
  'WMS_SIM_EXPECTED_DATABASE_FINGERPRINT',
  'WMS_SIM_PRESERVE_PRINTER_GLOBAL_ID',
  "'supersededBy', $5::text",
  "'formerScenarioKey', $6::text",
]) {
  assert.ok(
    normalization.includes(fragment),
    `Express Parcel normalization missing ${fragment}`,
  )
}
assert.equal(
  /\b(?:UPDATE|DELETE\s+FROM)\s+operations_contract_versions\b/i
    .test(normalization),
  false,
  'Normalization must preserve immutable operations contract-version evidence',
)
const joinedLocationUpdates = [
  ...normalization.matchAll(
    /`UPDATE operations_locations location[\s\S]*?FROM operations_warehouses warehouse[\s\S]*?`/g,
  ),
]
assert.equal(
  joinedLocationUpdates.length,
  2,
  'Expected both joined location updates to remain covered',
)
for (const [joinedLocationUpdate] of joinedLocationUpdates) {
  assert.ok(
    joinedLocationUpdate.includes(
      'row_version = location.row_version + 1',
    ),
    'Joined location updates must qualify the target row_version column',
  )
}
const joinedSimulationLocationUpdates = [
  ...simulation.matchAll(
    /`UPDATE operations_locations location[\s\S]*?FROM operations_warehouses warehouse[\s\S]*?`/g,
  ),
]
assert.equal(
  joinedSimulationLocationUpdates.length,
  1,
  'Expected the joined simulation location update to remain covered',
)
assert.ok(
  joinedSimulationLocationUpdates[0][0].includes(
    'row_version = location.row_version + 1',
  ),
  'Joined simulation location updates must qualify the target row_version column',
)
const simulationMain = simulation.slice(
  simulation.indexOf('async function main()'),
)
assert.ok(
  simulationMain.indexOf('assertExpectedDatabaseFingerprint(')
    < simulationMain.indexOf('await cleanupScenario('),
  'Preserve cleanup must verify the expected database identity before its transaction',
)
assert.equal(
  (
    simulation.match(
      /simulatorLineageLockKey\(configuration\.organizationId\)/g,
    ) || []
  ).length,
  2,
  'Seed and cleanup must share one organization-scoped simulator lineage lock',
)
const seedScenario = simulation.slice(
  simulation.indexOf('async function seedScenario('),
  simulation.indexOf('async function releaseScenarioReservations('),
)
assert.ok(
  seedScenario.indexOf('assertSimulatorLineageSeedable(')
    < seedScenario.indexOf('upsertActor('),
  'Simulator lineage retirement must be checked before any fixture can be reactivated',
)
const lineageGuard = simulation.slice(
  simulation.indexOf('async function assertSimulatorLineageSeedable('),
  simulation.indexOf('async function resolveScenarioRetirementTarget('),
)
assert.equal(
  lineageGuard.includes("configuration->>'scenarioKey'"),
  false,
  'Retired simulator integration lineage must block every later scenario version',
)
assert.equal(
  lineageGuard.includes("orders.source_payload->>'scenarioKey'"),
  false,
  'Retired simulator order lineage must block every later scenario version',
)
assert.equal(
  lineageGuard.includes("warehouse.address->>'scenarioKey'"),
  false,
  'The retired simulator warehouse singleton must block every later scenario version',
)
const cleanupScenario = simulation.slice(
  simulation.indexOf('async function cleanupScenario('),
  simulation.indexOf('function runSelfTest('),
)
assert.ok(
  cleanupScenario.indexOf('resolveScenarioRetirementTarget(')
    < cleanupScenario.indexOf('releaseScenarioReservations('),
  'Exact target and wave contamination checks must finish before releasing reservations',
)
assert.equal(
  /\bUPDATE\s+operations_(?:receipts|replenishment_tasks|printers|print_agents)\b/i
    .test(cleanupScenario),
  false,
  'Cleanup must abort rather than mutate unrelated active warehouse dependents',
)
const cleanupPostflight = simulation.slice(
  simulation.indexOf('async function assertScenarioRetired('),
  simulation.indexOf('async function cleanupScenario('),
)
assert.equal(
  /\b(?:integrationIds|orderIds|waveIds)\b/.test(cleanupPostflight),
  false,
  'Cleanup postflight must independently rediscover scenario markers',
)
assert.equal(
  /\bDELETE\s+FROM\s+(?:operations_|crm_|app_)/i.test(simulation),
  false,
  'Development simulation cleanup must preserve fixture evidence and tombstones',
)
assert.equal(
  /\bDELETE\s+FROM\s+(?:sync_outbox|short_links)\b/i.test(cleanupScenario),
  false,
  'Cleanup must preserve SuiteCRM outbox and short-link evidence',
)
assert.equal(
  cleanupScenario.includes("'delete_record'"),
  false,
  'Cleanup must not enqueue or issue a SuiteCRM record deletion',
)
assert.equal(
  (cleanupScenario.match(/'archived', true/g) || []).length,
  2,
  'Cleanup must archive both synthetic CRM customers and products locally',
)
assert.ok(
  cleanupScenario.includes('AND id = ANY($2::uuid[])'),
  'Cleanup must archive only the exact locked synthetic product IDs',
)
assert.ok(
  cleanupScenario.includes(
    "source_payload->>'retirementReason'\n             IS DISTINCT FROM 'wms_development_simulation_retired'",
  ),
  'Cleanup must upgrade partially retired CRM fixtures idempotently',
)
assert.equal(
  (crmPersistence.match(/activeCrmRecordSql\('organization'\)/g) || []).length,
  5,
  'CRM organization list, summary, sync summary, and links must exclude archives',
)
assert.equal(
  (crmPersistence.match(/activeCrmRecordSql\('product'\)/g) || []).length,
  5,
  'CRM product list, summary, sync summary, and links must exclude archives',
)
assert.equal(
  (crmPersistence.match(/activeCrmRecordSql\('customer'\)/g) || []).length,
  1,
  'CRM hierarchy repair must exclude archived customers',
)
for (const fragment of [
  'Generation is idempotent only before retirement.',
  'generation is blocked for every scenario version',
  "Cleanup is one-way and terminal for this organization's WMS simulator lineage.",
  'Rerunning cleanup is idempotent',
  'evidence tombstones are intentionally preserved',
  'It never mutates those',
  'unrelated records',
  'marked archived and retired in the',
  'terminally neutralizes only',
  'separately authorized SuiteCRM cleanup',
]) {
  assert.ok(
    simulationRunbook.includes(fragment),
    `WMS development simulation runbook missing ${fragment}`,
  )
}
for (const fragment of [
  'There is no production override.',
  'compensating inventory-ledger entries',
  'after.phase` as `wms_cleanup',
  'immutable Zebra proof lineage',
  'normalize-express-parcel-disposable-rehearsal-v1',
  'retire-wms-simulation-disposable-rehearsal-v1',
  'restores Operations to `read_only`',
]) {
  assert.ok(
    normalizationRunbook.includes(fragment),
    `Express Parcel normalization runbook missing ${fragment}`,
  )
}
assert.equal(
  simulationRunbook.includes('A later generation run reactivates the same scenario'),
  false,
  'Runbook must not claim retired simulator fixtures can be reactivated',
)
assert.ok(
  predeploy.includes("'docs/modules/wms-development-simulation.md'"),
  'Predeploy manifest must require the WMS development simulation runbook',
)
assert.ok(
  rootPackage.includes(
    'node scripts/seed-wms-development-simulation.mjs --self-test',
  ),
  'Aggregate Operations tests must execute the simulator identity self-test',
)
assert.ok(
  rootPackage.includes(
    'node scripts/normalize-express-parcel-development-warehouse.mjs --self-test',
  ),
  'Aggregate Operations tests must execute the warehouse normalization self-test',
)

console.log('Operations slotting, replenishment, and development-simulation contracts passed.')
