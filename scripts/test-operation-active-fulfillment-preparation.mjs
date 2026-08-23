#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const root = process.cwd()
const application = readFileSync(
  resolve(
    root,
    'app_src/lib/operations/activeFulfillmentExecutionPreparation.ts',
  ),
  'utf8',
)
const domain = readFileSync(
  resolve(root, 'app_src/lib/operations/activeFulfillmentExecution.ts'),
  'utf8',
)
const route = readFileSync(
  resolve(root, 'app_src/app/api/operations/route.ts'),
  'utf8',
)
const guardMigration = readFileSync(
  resolve(
    root,
    'db/migrations/0182_operations_active_preparation_guards.sql',
  ),
  'utf8',
)
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
)

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

const transpiled = ts.transpileModule(application, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
  },
  reportDiagnostics: true,
})
assert.deepEqual(
  (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  ),
  [],
  'Active preparation TypeScript must transpile without syntax errors',
)

assertIncludes(application, [
  "const COMMAND_TYPE = 'prepare-active-fulfillment-execution'",
  'prepareActiveFulfillmentExecutionFromShadowInPostgres(',
  'acquireTransactionAdvisoryLock(',
  'operations:command-receipt:',
  'operations:active-preparation:',
  'FROM operations_command_receipts',
  'receipt.request_hash !== receiptRequestHash',
  "receipt.status !== 'succeeded'",
  'OPERATIONS_ACTIVE_PREPARATION_IDEMPOTENCY_CONFLICT',
  'OPERATIONS_ACTIVE_PREPARATION_SHADOW_ALREADY_BOUND',
  'expectedOrderRowVersion',
  "requiredText(input.reason, 'Active preparation reason', 500)",
  'expected_order_row_version',
  'reason,',
  'active-fulfillment-execution-preparation-persisted-v2',
  'INSERT INTO operations_command_receipts',
  "SET status = 'succeeded', result_global_id = $2",
], 'Transactional command receipt and exact replay')
assert.ok(
  application.indexOf('`operations:command-receipt:')
    < application.indexOf('`operations:active-preparation:'),
  'The idempotency-key lock must be acquired before the Shadow-source lock',
)

assertIncludes(application, [
  "context.shadow_authority_mode !== 'shadow'",
  "context.shadow_state !== 'shadow_prepared'",
  'context.provider_write_count',
  'context.postage_purchase_count',
  'context.label_write_count',
  'context.commerce_write_count',
  'linked_label_attempt_count',
  'linked_label_count',
  'linked_shipment_count',
  "String(context.order_source_provider).toLowerCase() !== 'shopify'",
  "context.order_status !== 'packed'",
  "context.plan_status !== 'released'",
  "context.warehouse_status !== 'active'",
  'context.group_currency !== context.order_currency',
  'OPERATIONS_ACTIVE_PREPARATION_ORDER_VERSION_CHANGED',
  'OPERATIONS_ACTIVE_PREPARATION_ORDER_BLOCKED',
  "exception.status = 'open'",
  "exception.severity IN ('high', 'critical')",
], 'Immutable Shopify Shadow source guards')
assert.doesNotMatch(
  application,
  /operations_activation_scopes|current_activation_state|current_activation_revision/u,
  'Production carrier preparation must be independent of the legacy Operations profile',
)
assert.doesNotMatch(
  domain,
  /input\.activationState !== 'active'|OPERATIONS_ACTIVE_AUTHORITY_REQUIRED/u,
  'Pure carrier-lineage preparation must accept every legacy profile',
)

assertIncludes(application, [
  'packageResult.rows.length < 1',
  'packageResult.rows.length > 50',
  'packageResult.rows.length !== Number(context.source_package_count)',
  'Number(packageRow.package_number) !== index + 1',
  'packageRow.package_plan_id !== context.plan_id',
  "packageRow.package_status !== 'packed'",
  'packageRow.package_length_mm',
  'packageRow.package_width_mm',
  'packageRow.package_height_mm',
  'packageRow.package_weight_grams',
  'packageRow.source_length_mm',
  'packageRow.source_width_mm',
  'packageRow.source_height_mm',
  'packageRow.source_gross_weight_grams',
  'OPERATIONS_ACTIVE_PREPARATION_PACKAGE_EVIDENCE_DRIFT',
  'prepareActiveFulfillmentExecution({',
  'INSERT INTO operations_active_fulfillment_executions',
  "'active', 'prepared'",
  'INSERT INTO operations_active_shipment_groups',
  'INSERT INTO operations_active_execution_packages',
  'insertedPackages.rowCount !== prepared.packageCount',
], 'Exact Shadow-derived Active execution, group, and package set')

assert.doesNotMatch(
  application,
  /from ['"]@\/lib\/integrations\/(?:ups|fedex|shopify|faire)/u,
  'Active preparation must not import a carrier or commerce provider client',
)
assert.doesNotMatch(
  application,
  /INSERT INTO operations_(?:labels|label_attempts|shipments|print_jobs|inventory_positions|reservations)/u,
  'Active preparation must not create labels, shipments, print jobs, or inventory writes',
)
assert.doesNotMatch(
  application,
  /\b(fetch|axios)\s*\(/u,
  'Active preparation must not perform network I/O',
)

assertIncludes(route, [
  "action === 'prepare-active-fulfillment-execution'",
  '!capabilities.canManage || !capabilities.canExecute',
  "'shadowExecutionGlobalId'",
  "'expectedActivationRevision'",
  "'expectedOrderRowVersion'",
  "'reason'",
  'prepareActiveFulfillmentExecutionFromShadowInPostgres({',
  'idempotencyKey: idempotencyKeyValue(req)',
  'result.replayed ? 200 : 201',
  'error instanceof ActiveFulfillmentExecutionPreparationError',
], 'Authenticated manage-plus-execute API boundary')

assertIncludes(guardMigration, [
  'ALTER TABLE operations_active_fulfillment_executions',
  'ADD COLUMN IF NOT EXISTS expected_order_row_version bigint',
  'ADD COLUMN IF NOT EXISTS reason text',
  'Legacy Active preparation created before operator reasons were captured',
  'NOT NULL DEFAULT 0',
  "'Legacy Active preparation created before operator reasons were captured'",
  'ALTER COLUMN expected_order_row_version DROP DEFAULT',
  'ALTER COLUMN reason DROP DEFAULT',
  'expected_order_row_version >= 0',
  'length(btrim(reason)) BETWEEN 1 AND 500',
  "reason !~ '[[:cntrl:]]'",
], 'Durable Active-preparation reason and order-version migration')

assert.equal(
  packageJson.scripts['test:operation-active-preparation'],
  'node scripts/test-operation-active-fulfillment-preparation.mjs',
  'Focused Active preparation contract command',
)
assert.equal(
  packageJson.scripts['test:operation-active-preparation-postgres'],
  'node scripts/test-operation-active-execution-preparation-postgres.mjs',
  'Disposable-Postgres Active preparation acceptance command',
)
assert.ok(
  packageJson.scripts['test:operations'].includes(
    'npm run test:operation-active-preparation',
  ),
  'Operations suite must include Active preparation contracts',
)
assert.ok(
  packageJson.scripts['test:operations'].includes(
    'npm run test:operation-active-preparation-postgres',
  ),
  'Operations suite must include disposable-Postgres Active preparation acceptance',
)

console.log('Active fulfillment execution preparation contracts passed.')
