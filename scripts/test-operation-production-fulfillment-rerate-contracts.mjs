#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

const migration = readFileSync(
  resolve(
    process.cwd(),
    'db/migrations/0180_operations_production_fulfillment_rerates.sql',
  ),
  'utf8',
)
const application = readFileSync(
  resolve(
    process.cwd(),
    'app_src/lib/operations/productionFulfillmentRerates.ts',
  ),
  'utf8',
)
const execution = readFileSync(
  resolve(
    process.cwd(),
    'app_src/lib/operations/productionFulfillmentRerateExecution.ts',
  ),
  'utf8',
)
const operationsRoute = readFileSync(
  resolve(process.cwd(), 'app_src/app/api/operations/route.ts'),
  'utf8',
)
const carrierIntegrations = readFileSync(
  resolve(process.cwd(), 'app_src/lib/integrations/carrierIntegrations.ts'),
  'utf8',
)

function section(startMarker, endMarker, label) {
  const start = migration.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = migration.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return migration.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

const tables = [
  'runs',
  'packages',
  'attempts',
  'results',
  'offers',
  'selections',
]
for (const table of tables) {
  assertIncludes(migration, [
    `CREATE TRIGGER protect_operations_production_rerate_${table}_mutation`,
    `ON operations_production_fulfillment_rerate_${table}`,
    'FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only()',
  ], `${table} append-only ledger`)
}

const attemptTable = section(
  'CREATE TABLE IF NOT EXISTS\n  operations_production_fulfillment_rerate_attempts',
  'CREATE INDEX IF NOT EXISTS operations_production_rerate_attempts_run_idx',
  'Prepared provider-attempt table',
)
assertIncludes(attemptTable, [
  "state text NOT NULL DEFAULT 'prepared' CHECK (state = 'prepared')",
  "environment text NOT NULL DEFAULT 'production'",
  'carrier_account_configuration_revision integer NOT NULL',
  'account_number_fingerprint text NOT NULL',
  'registered_origin_fingerprint text NOT NULL',
  'credential_revision integer NOT NULL',
  'credential_fingerprint text NOT NULL',
  'origin_snapshot jsonb NOT NULL',
  'origin_fingerprint text NOT NULL',
  'billing_relationship text NOT NULL',
  'billing_snapshot jsonb NOT NULL',
  'billing_fingerprint text NOT NULL',
  'request_hash text NOT NULL',
  'operations_production_rerate_json_is_redacted(redacted_request)',
  'persisted_at timestamptz NOT NULL DEFAULT now()',
], 'Durable pre-network provider attempt')

const resultTable = section(
  'CREATE TABLE IF NOT EXISTS\n  operations_production_fulfillment_rerate_results',
  'CREATE TABLE IF NOT EXISTS\n  operations_production_fulfillment_rerate_offers',
  'Terminal provider-result table',
)
assertIncludes(resultTable, [
  "state IN ('succeeded', 'failed', 'unknown')",
  'UNIQUE (organization_id, attempt_id)',
  "state IN ('failed', 'unknown')",
  'AND expires_at IS NULL',
  'operations_production_rerate_json_is_redacted(redacted_response)',
  "expires_at <= completed_at + interval '15 minutes'",
], 'Append-only terminal result and unknown reconciliation')

const runTable = section(
  'CREATE TABLE IF NOT EXISTS\n  operations_production_fulfillment_rerate_runs',
  'CREATE INDEX IF NOT EXISTS operations_production_rerate_runs_group_idx',
  'Exact rerate-run binding',
)
assertIncludes(runTable, [
  'active_fulfillment_execution_id uuid NOT NULL',
  'active_shipment_group_id uuid NOT NULL',
  'order_id uuid NOT NULL',
  'plan_id uuid NOT NULL',
  'warehouse_id uuid NOT NULL',
  'source_fulfillment_pack_rate_run_id uuid NOT NULL',
  'activation_revision integer NOT NULL',
  'destination_snapshot jsonb NOT NULL',
  'destination_fingerprint text NOT NULL',
  'ordered_package_set_fingerprint text NOT NULL',
  'package_count integer NOT NULL',
], 'Exact Active execution and package-set binding')

const attemptValidator = section(
  'validate_operations_production_rerate_attempt_insert()',
  'CREATE TRIGGER validate_operations_production_rerate_attempt_insert_trigger',
  'Prepared-attempt validator',
)
assertIncludes(attemptValidator, [
  "activation.state = 'active'",
  'carrier_account.configuration_revision',
  'carrier_account.account_number_fingerprint',
  'carrier_account.registered_address_fingerprint',
  'carrier_credential.credential_version',
  'carrier_credential.credential_fingerprint',
  'orders.currency IS DISTINCT FROM rerate_run.currency',
  'destination or currency changed after run preparation',
  "prior_result_state IS DISTINCT FROM 'failed'",
  'Prepared, succeeded, or unknown production rerate attempt cannot be retried',
], 'Current revision and failed-only retry guard')

const resultValidator = section(
  'validate_operations_production_rerate_result_insert()',
  'CREATE TRIGGER validate_operations_production_rerate_result_insert_trigger',
  'Terminal-result validator',
)
assertIncludes(resultValidator, [
  'NEW.completed_at < prepared_at',
  'NEW.completed_at > clock_timestamp()',
  'result must follow its durable prepared attempt and cannot be future-dated',
], 'Server-clock-bounded provider result')

const selectionTable = section(
  'CREATE TABLE IF NOT EXISTS\n  operations_production_fulfillment_rerate_selections',
  '-- Every table above is append-only.',
  'Immutable whole-shipment selection',
)
assertIncludes(selectionTable, [
  'operations_production_rerate_selections_run_unique',
  'UNIQUE (organization_id, rerate_run_id)',
  'active_fulfillment_execution_id uuid NOT NULL',
  'active_shipment_group_id uuid NOT NULL',
  'attempt_id uuid NOT NULL',
  'result_id uuid NOT NULL',
  'offer_id uuid NOT NULL',
  'provider text NOT NULL',
  'service_code text NOT NULL',
  'expires_at timestamptz NOT NULL',
  'ordered_package_set_fingerprint text NOT NULL',
  'operations_production_rerate_selections_ttl_valid',
  "expires_at <= selected_at + interval '15 minutes'",
], 'Exactly one immutable service selection for the whole shipment')

const selectionValidator = section(
  'validate_operations_production_rerate_selection_insert()',
  'CREATE TRIGGER validate_operations_production_rerate_selection_insert_trigger',
  'Selection validator',
)
assertIncludes(selectionValidator, [
  "result_row.state IS DISTINCT FROM 'succeeded'",
  'NEW.active_fulfillment_execution_id',
  'NEW.active_shipment_group_id',
  'NEW.ordered_package_set_fingerprint',
  'NEW.selected_at >= NEW.expires_at',
  'NEW.selected_at > clock_timestamp()',
  'clock_timestamp() >= NEW.expires_at',
  'successful offer and cannot be future-dated',
  "activation.state = 'active'",
  "integration_account.integration_type IS DISTINCT FROM 'carrier'",
  'integration_account.provider IS DISTINCT FROM NEW.provider',
  "integration_account.environment IS DISTINCT FROM 'production'",
  "integration_account.status IS DISTINCT FROM 'active'",
  'Production fulfillment rerate selection integration, account, or credential revision is stale',
], 'Current unexpired exact-offer selection guard')

const packageCompletion = section(
  'validate_operations_production_rerate_complete()',
  'CREATE CONSTRAINT TRIGGER validate_operations_production_rerate_run_deferred',
  'Deferred package/result completeness validator',
)
assertIncludes(packageCompletion, [
  'operations_active_execution_packages',
  'package_mismatch_rows <> 0',
  'complete ordered Active package set',
  "result.state = 'succeeded' AND count(offer.id) < 1",
  "result.state IN ('failed', 'unknown') AND count(offer.id) <> 0",
], 'Exact package set and terminal-result completeness')

assertIncludes(migration, [
  'ADD COLUMN IF NOT EXISTS production_rerate_selection_id uuid',
  'ALTER COLUMN production_rerate_selection_id SET NOT NULL',
  'REFERENCES operations_production_fulfillment_rerate_selections(',
  'Active carrier attempt requires the exact current unexpired production rerate selection',
  'NEW.selected_provider IS DISTINCT FROM selection.provider',
  'NEW.selected_service_code IS DISTINCT FROM selection.service_code',
  'NEW.package_count IS DISTINCT FROM rerate_run.package_count',
  "integration_account.environment IS DISTINCT FROM 'production'",
  "integration_account.status IS DISTINCT FROM 'active'",
  'carrier_account.configuration_revision',
  "carrier_credential.verification_status IS DISTINCT FROM 'verified'",
  'current_order.currency IS DISTINCT FROM rerate_run.currency',
  'rerate_run.destination_snapshot',
  'current_order.ship_to',
], 'Active dispatch linkage to production authority')

for (const source of [attemptTable, resultTable, selectionTable]) {
  assert.doesNotMatch(
    source,
    /\b(access_token|refresh_token|client_secret|secret_id|password|api_key|private_key)\b/iu,
    'Production rerate evidence must not define plaintext secret columns',
  )
}
assertIncludes(migration, [
  'operations_production_rerate_json_is_redacted(value jsonb)',
  "'accountnumber'",
  "'payeraccountnumber'",
  "'credentialciphertext'",
  "'credentialiv'",
  "'credentialtag'",
  'octet_length(value::text) BETWEEN 2 AND 1048576',
  'operations_carrier_credential_fingerprint(',
  'input_ciphertext bytea',
  'input_iv bytea',
  'input_tag bytea',
  "'sha256'",
], 'Database-derived credential rotation fingerprint')

assertIncludes(application, [
  'preparedRequest: PreparedCarrierWholeShipmentRateRequest',
  'sealPreparedCarrierWholeShipmentRateRequest(',
  'carrierWholeShipmentRateParcelsFromRunPackages(',
  'weightGrams * 100_000_000',
  "description: `Fulfillment package ${entry.packageNumber}`",
  'carrierWholeShipmentRateAddressFingerprints({',
  '!exactJson(redactedRequest.shipment.parcels, carrierParcels)',
  'PRODUCTION_RERATE_RESULT_TTL_MS = 5 * 60 * 1000',
  'PRODUCTION_RERATE_MAX_TTL_MS = 15 * 60 * 1000',
  "'SELECT clock_timestamp() AS server_now'",
  'const serverTimestamp = new Date(',
  "'Provider requested at'",
  "'Provider completed at'",
  'clock_timestamp() AS server_now',
  'orders.currency AS current_order_currency',
  'orders.ship_to AS current_order_ship_to',
  '!sameOrderDestination(row.current_order_ship_to, destination)',
], 'Application-layer prepared-request, package, TTL, and dispatch authority')
assert.doesNotMatch(
  application,
  /\batInput\b|input\.outcome\.completedAt|input\.outcome\.expiresAt|input\.outcome\.resultHash/u,
  'Production authority must not accept caller-controlled clocks, TTLs, or result hashes',
)
const successfulResultHash = application.slice(
  application.indexOf(
    "resultHash = fingerprint('production-fulfillment-rerate-result-v1'",
  ),
  application.indexOf('normalizedOffers = normalizedRateEvidence.map'),
)
assert.doesNotMatch(
  successfulResultHash,
  /providerRequestedAt|providerCompletedAt/u,
  'Transient adapter clocks must not become unreconstructible result identity',
)
assertIncludes(successfulResultHash, [
  'providerPayloadHash',
  'completedAt',
  'expiresAt',
], 'Reconstructible database-clock result identity')

const transpiledApplication = ts.transpileModule(application, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2019,
    esModuleInterop: true,
  },
  fileName: 'app_src/lib/operations/productionFulfillmentRerates.ts',
}).outputText
const applicationModule = { exports: {} }
vm.runInNewContext(transpiledApplication, {
  Buffer,
  Date,
  Error,
  JSON,
  Math,
  Number,
  Object,
  RegExp,
  Set,
  String,
  console,
  exports: applicationModule.exports,
  module: applicationModule,
  require(identifier) {
    if (identifier === 'node:crypto') return requireFromApp(identifier)
    return {}
  },
}, { filename: 'app_src/lib/operations/productionFulfillmentRerates.ts' })
const { carrierWholeShipmentRateParcelsFromRunPackages } = applicationModule.exports
const convertedParcels = JSON.parse(JSON.stringify(
  carrierWholeShipmentRateParcelsFromRunPackages([
    {
      packageId: '11111111-1111-4111-8111-111111111111',
      packageGlobalId: 'gpa0009001',
      packageNumber: 1,
      dimensionsMm: { length: 279, width: 229, height: 178 },
      weightGrams: 2_500,
    },
    {
      packageId: '22222222-2222-4222-8222-222222222222',
      packageGlobalId: 'gpa0009002',
      packageNumber: 2,
      dimensionsMm: { length: 432, width: 229, height: 178 },
      weightGrams: 5_000,
    },
  ]),
))
assert.deepEqual(convertedParcels, [
  {
    description: 'Fulfillment package 1',
    length: 10.985,
    width: 9.016,
    height: 7.008,
    dimensionUnit: 'IN',
    weight: 5.512,
    weightUnit: 'LB',
  },
  {
    description: 'Fulfillment package 2',
    length: 17.008,
    width: 9.016,
    height: 7.008,
    dimensionUnit: 'IN',
    weight: 11.024,
    weightUnit: 'LB',
  },
], 'Immutable mm/g packages convert upward to exact ordered IN/LB evidence')
assert.throws(
  () => carrierWholeShipmentRateParcelsFromRunPackages([{
    packageId: '11111111-1111-4111-8111-111111111111',
    packageGlobalId: 'gpa0009002',
    packageNumber: 2,
    dimensionsMm: { length: 279, width: 229, height: 178 },
    weightGrams: 2_500,
  }]),
  /ordered contiguously/,
)

assertIncludes(execution, [
  'prepareProductionFulfillmentRerateInPostgres({',
  'resolveCarrierProductionRatingRuntime({',
  'prepareProductionFulfillmentRerateAttemptInPostgres({',
  'if (attempt.replayed)',
  'OPERATIONS_PRODUCTION_RERATE_RECONCILIATION_REQUIRED',
  'executeCarrierWholeShipmentRateRequest({',
  'finalizeProductionFulfillmentRerateAttemptInPostgres({',
  "accessMode: 'rate_read_only'",
  'providerMutationCount: 0',
], 'Executable read-only production rerate command')
assert.ok(
  execution.indexOf('prepareProductionFulfillmentRerateAttemptInPostgres({')
    < execution.indexOf('executeCarrierWholeShipmentRateRequest({'),
  'The durable provider attempt must be committed before carrier network I/O',
)
assert.ok(
  execution.indexOf('if (attempt.replayed)')
    < execution.indexOf('executeCarrierWholeShipmentRateRequest({'),
  'A replayed prepared attempt must fail closed before carrier network I/O',
)
assert.doesNotMatch(
  execution,
  /Date\.now|selectProductionFulfillmentRerateOffer|create.*Label|void.*Label/iu,
  'The rating command must not select services or mutate carrier shipments',
)

assertIncludes(carrierIntegrations, [
  "capability: 'sandbox_rate' | 'sandbox_label' | 'production_rate'",
  'export async function resolveCarrierProductionRatingRuntime(',
  "environment: 'production'",
  "requiresConfiguredCapability(runtime, 'production_rate')",
  'runtime.integrationGlobalId !== integrationAccountGlobalId',
  "billingRelationship: 'sender'",
], 'Exact active production carrier runtime binding')

assertIncludes(operationsRoute, [
  "if (action === 'execute-production-rerate')",
  '!capabilities.canManage || !capabilities.canExecute',
  'executeProductionFulfillmentRerate({',
  'expectedActivationRevision:',
  'idempotencyKey: idempotencyKeyValue(req)',
], 'Authenticated Operations production-rerate route')

assertIncludes(operationsRoute, [
  'selectProductionFulfillmentRerateOfferInPostgres,',
  'const PRODUCTION_RERATE_RUN_GLOBAL_ID = /^gafr\\d{7}$/',
  'const PRODUCTION_RERATE_OFFER_GLOBAL_ID = /^garo\\d{7}$/',
  "if (action === 'select-production-rerate-offer')",
  '!capabilities.canManage || !capabilities.canExecute',
  "code: 'OPERATIONS_EXECUTE_REQUIRED'",
  "'rerateRunGlobalId'",
  "'offerGlobalId'",
  "'selectionReason'",
  'selectProductionFulfillmentRerateOfferInPostgres({',
  'organizationId: activeOperationsOrganizationId(actor)',
  'idempotencyKey: idempotencyKeyValue(req)',
  'selectedBy: actor.email',
  'result.replayed ? 200 : 201',
], 'Authenticated immutable production-rerate offer-selection route')

assertIncludes(application, [
  'idempotencyKey: unknown',
  "const commandType = 'select-production-rerate-offer'",
  "'production-fulfillment-rerate-selection-command-v1'",
  'FROM operations_command_receipts',
  'INSERT INTO operations_command_receipts',
  'UPDATE operations_command_receipts',
  "'OPERATIONS_PRODUCTION_RERATE_SELECTION_IDEMPOTENCY_CONFLICT'",
  "'OPERATIONS_PRODUCTION_RERATE_SELECTION_DESTINATION_OR_CURRENCY_STALE'",
  "'OPERATIONS_PRODUCTION_RERATE_SELECTION_AUTHORITY_STALE'",
  'result_global_id = $2',
  'This is a historical command replay, not fresh dispatch authority.',
  'Lock every mutable row used as current selection authority in one',
  'FROM operations_activation_scopes',
  'FROM operations_orders orders',
  'FROM operations_integration_accounts',
  'FROM operations_carrier_accounts',
  'FROM operations_carrier_credentials',
], 'Durable idempotent production-rerate offer selection')

const selectionImplementation = application.slice(
  application.indexOf(
    'export async function selectProductionFulfillmentRerateOfferInPostgres',
  ),
  application.indexOf('type DispatchSelectionRow'),
)
assert.ok(
  selectionImplementation.indexOf(
    'FROM operations_production_fulfillment_rerate_selections selection',
  ) < selectionImplementation.indexOf(
    'const candidateResult = await client.query<SelectableOfferRow>',
  ),
  'Same-offer immutable replay must precede expiration and current-authority validation',
)
const mutableAuthorityLockOrder = [
  'FROM operations_activation_scopes',
  'FROM operations_orders orders',
  'FROM operations_integration_accounts',
  'FROM operations_carrier_accounts',
  'FROM operations_carrier_credentials',
]
for (let index = 1; index < mutableAuthorityLockOrder.length; index += 1) {
  assert.ok(
    selectionImplementation.indexOf(mutableAuthorityLockOrder[index - 1])
      < selectionImplementation.indexOf(mutableAuthorityLockOrder[index]),
    'Mutable selection-authority rows must be locked in stable table order',
  )
}
assert.equal(
  (selectionImplementation.match(/LIMIT 1\n         FOR SHARE/g) || []).length,
  7,
  'Selection must lock historical/candidate evidence plus all five mutable authority rows',
)

console.log('Production fulfillment rerate static contracts passed')
