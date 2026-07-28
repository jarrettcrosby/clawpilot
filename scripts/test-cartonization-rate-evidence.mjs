#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${label} is missing ${startMarker}`)
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length
  assert.notEqual(end, -1, `${label} is missing ${endMarker}`)
  return source.slice(start, end)
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} is missing ${fragment}`)
  }
}

function loadPersistence() {
  const path = 'app_src/lib/persistence/cartonizationRateEvidence.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const requireModule = (specifier) => {
    if (specifier === '@/lib/auditWriter') {
      return { recordAuditEvent: async () => {} }
    }
    if (specifier === '@/lib/integrations/commerceCredentialCrypto') {
      return {
        decryptCommerceCandidateSnapshot: () => {
          throw new Error('not used by the hash contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/carrierSandboxRate') {
      return {
        carrierSandboxPartyFingerprint: () => {
          throw new Error('not used by the hash contract')
        },
        normalizeCarrierSandboxParty: (value) => value,
      }
    }
    if (specifier === '@/lib/persistence/postgres') {
      return {
        acquireTransactionAdvisoryLock: async () => {},
        getPostgresPool: () => {
          throw new Error('not used by the hash contract')
        },
        withTransaction: async () => {
          throw new Error('not used by the hash contract')
        },
      }
    }
    return requireFromApp(specifier)
  }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: requireModule,
  }, { filename: path })
  return module.exports
}

const migration = read(
  'db/migrations/0137_operations_cartonization_rate_evidence.sql',
)
const integrityMigration = read(
  'db/migrations/0138_operations_cartonization_rate_evidence_integrity.sql',
)
const persistence = read(
  'app_src/lib/persistence/cartonizationRateEvidence.ts',
)
const route = read(
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
)

assertIncludes(migration, [
  'request_hash text NOT NULL',
  'write_token_hash text NOT NULL',
  'sealed_at timestamptz',
  'UNIQUE (organization_id, idempotency_key)',
  'operations_cartonization_dimensions_mm_valid',
  'operations_cartonization_allocations_valid',
  "jsonb_typeof(value) IS DISTINCT FROM 'object'",
  ") IS DISTINCT FROM\n      ARRAY['height', 'length', 'width']::text[]",
  "jsonb_typeof(item) IS DISTINCT FROM 'object'",
  'FOREIGN KEY (organization_id, integration_account_id)',
  'FOREIGN KEY (\n      organization_id, integration_account_id, order_candidate_id',
  'organization_id, integration_account_id, warehouse_id,\n      inventory_sync_run_id',
  'UNIQUE (organization_id, id)',
], 'Evidence header database authority')

const packageTable = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_packages',
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_quotes',
  'Evidence package table',
)
assertIncludes(packageTable, [
  'organization_id uuid NOT NULL',
  'PRIMARY KEY (organization_id, evidence_id, package_key)',
  'FOREIGN KEY (organization_id, evidence_id)',
  'FOREIGN KEY (organization_id, packaging_material_id)',
  'organization_id, packaging_material_id, approved_pack_recipe_id',
  'UNIQUE (organization_id, evidence_id, package_sequence)',
  'rated_gross_weight_grams = content_weight_grams + tare_weight_grams',
], 'Tenant-scoped package evidence')

const quoteTable = section(
  migration,
  'CREATE TABLE IF NOT EXISTS operations_cartonization_rate_evidence_quotes',
  'CREATE OR REPLACE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
  'Evidence quote table',
)
assertIncludes(quoteTable, [
  "provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest'))",
  "rate_purpose text NOT NULL DEFAULT 'cartonization_package_rate'",
  "CHECK (rate_purpose = 'cartonization_package_rate')",
  'PRIMARY KEY (organization_id, evidence_id, package_key, provider)',
  'organization_id, provider, rate_purpose, carrier_rate_request_id',
  'organization_id, provider, purpose, id',
], 'Carrier quote evidence')

const sealingContract = section(
  migration,
  'CREATE OR REPLACE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
  'COMMENT ON TABLE operations_cartonization_rate_evidence',
  'Evidence sealing contract',
)
assertIncludes(sealingContract, [
  "current_setting(\n    'clawpilot.cartonization_evidence_write_token'",
  "encode(digest(supplied_token, 'sha256'), 'hex')",
  'evidence_sealed_at IS NOT NULL',
  "(to_jsonb(NEW) - 'sealed_at') = (to_jsonb(OLD) - 'sealed_at')",
  'package_count NOT BETWEEN 1 AND 8',
  'count(quote.provider) <> 2',
  "quote.provider = 'ups_rest'",
  "quote.provider = 'fedex_rest'",
  'quote.quote_status IS DISTINCT FROM rate.status',
  'quote.error_code IS DISTINCT FROM rate.error_code',
  'evidence_status = \'partial\'',
  'DEFERRABLE INITIALLY DEFERRED',
  'BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_packages',
  'BEFORE UPDATE OR DELETE ON operations_cartonization_rate_evidence_quotes',
], 'Sealed immutable aggregate')

assertIncludes(persistence, [
  'export function cartonizationRateEvidenceHash',
  'export function cartonizationRateEvidenceRequestHash',
  'const packages = [...input.packages].sort(',
  'export function cartonizationPackageRateContextHash',
  'claimCartonizationRateEvidenceCommandInPostgres',
  'failCartonizationRateEvidenceCommandInPostgres',
  'semantic_request_hash',
  'carrier_request_hash',
  'redacted_request',
  'const inputPlanResultHash = cartonizationRateEvidenceHash(input.planSnapshot)',
  'cartonizationRateEvidenceHash({',
  'CARTONIZATION_RATE_EVIDENCE_IDEMPOTENCY_CONFLICT',
  'evidence.sealed_at IS NOT NULL',
  'inventory_run.warehouse_id = warehouse.id',
  'recipe.packaging_material_id = $2::uuid',
  "'clawpilot.cartonization_evidence_write_token'",
  'SET sealed_at = now()',
  'Evidence status must be ${expectedStatus}',
], 'Persistence integrity contract')
assert.doesNotMatch(
  persistence,
  /\bcanonicalHash\(/,
  'The retired hash helper must not remain referenced',
)

assertIncludes(route, [
  'export async function POST(req: NextRequest)',
  'readHybridCartonizationInputFromPostgres',
  'readCartonizationRateCandidateContext',
  'planHybridCartonization',
  'claimCartonizationRateEvidenceCommandInPostgres',
  'semanticRequestHash',
  'carrierRateReads: 0',
  "(['ups_rest', 'fedex_rest'] as const)",
  'policyVersion: plan.policyVersion',
  'writeCartonizationRateEvidenceInPostgres',
  'inventoryWrites: 0',
  'shipmentWrites: 0',
  'labelCalls: 0',
  'postagePurchases: 0',
  'providerWrites: 0',
], 'Executable package-and-rate workflow')

assertIncludes(integrityMigration, [
  'operations_cartonization_rate_evidence_package_recipes',
  'operations_cartonization_rate_evidence_commands',
  'destination_fingerprint',
  'carrier_parcel_snapshot',
  'carrier_request_hash',
  'package_rate_context_hash',
  'operations_cartonization_carrier_parcel_valid',
  "rate.redacted_request #>>\n          '{shipment,destinationFingerprint}'",
  "rate.redacted_request #> '{shipment,parcel}'",
  'FOR EACH ROW EXECUTE FUNCTION\n  validate_operations_cartonization_rate_evidence_child_insert()',
], 'Additive evidence integrity migration')
assert.doesNotMatch(
  section(
    integrityMigration,
    'ALTER TABLE operations_cartonization_rate_evidence_packages\n  ALTER COLUMN carrier_parcel_snapshot',
    'ALTER TABLE operations_cartonization_rate_evidence_quotes',
    'Parcel table check',
  ),
  /\bSELECT\b/,
  'CHECK constraints must not contain PostgreSQL-forbidden subqueries',
)
assert.doesNotMatch(
  route,
  /createCarrierSandboxRateTestLabel|createOperationShipment|queuePrintJob/,
  'Package-and-rate evidence must not call label, shipment, or print paths',
)

const {
  cartonizationRateEvidenceHash,
  cartonizationRateEvidenceRequestHash,
  CartonizationRateEvidencePersistenceError,
} = loadPersistence()

assert.equal(
  cartonizationRateEvidenceHash({
    z: [3, { b: true, a: 'value' }],
    a: 1,
  }),
  cartonizationRateEvidenceHash({
    a: 1,
    z: [3, { a: 'value', b: true }],
  }),
  'Canonical hashing must ignore object-key insertion order',
)
assert.equal(
  cartonizationRateEvidenceHash({ value: -0 }),
  cartonizationRateEvidenceHash({ value: 0 }),
  'Canonical hashing must normalize negative zero',
)
assert.throws(
  () => cartonizationRateEvidenceHash({ value: Number.POSITIVE_INFINITY }),
  (error) => (
    error instanceof CartonizationRateEvidencePersistenceError
    && error.status === 400
  ),
  'Canonical hashing must reject non-finite numbers',
)
assert.throws(
  () => cartonizationRateEvidenceHash({ value: undefined }),
  /undefined value/,
  'Canonical hashing must reject undefined values',
)

const planSnapshot = {
  warehouseGlobalId: 'gwh0000001',
  packages: [{ packageKey: 'package-1' }],
}
const packageOne = {
  packageKey: 'package-1',
  packageSequence: 1,
  planningMethod: 'or_tools',
  packagingMaterialGlobalId: 'gmat0000001',
  materialRowVersion: 2,
  recipes: [],
  innerDimensionsMm: { length: 250, width: 200, height: 150 },
  ratedOuterDimensionsMm: { length: 260, width: 210, height: 160 },
  contentWeightGrams: 800,
  tareWeightGrams: 120,
  ratedGrossWeightGrams: 920,
  maxWeightGrams: 10_000,
  allocations: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    title: 'Measured product',
    quantity: 2,
  }],
  carrierParcel: {
    description: 'Exact package one',
    length: 10.236,
    width: 8.268,
    height: 6.299,
    dimensionUnit: 'IN',
    weight: 2.028,
    weightUnit: 'LB',
  },
}
const packageTwo = {
  ...packageOne,
  packageKey: 'package-2',
  packageSequence: 2,
  packagingMaterialGlobalId: 'gmat0000002',
}
const packages = [packageOne, packageTwo].map((value) => ({
  ...value,
  packageHash: cartonizationRateEvidenceHash(value),
}))
const quotes = packages.flatMap((item) => ([
  {
    packageKey: item.packageKey,
    provider: 'ups_rest',
    rateEvidenceGlobalId: 'grq0000001',
  },
  {
    packageKey: item.packageKey,
    provider: 'fedex_rest',
    rateEvidenceGlobalId: 'grq0000002',
  },
]))
const request = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  candidateRowVersion: 4,
  destinationFingerprint: 'd'.repeat(64),
  warehouseGlobalId: 'gwh0000001',
  inventorySyncRunGlobalId: 'gisr0000001',
  evidenceMode: 'operational',
  policyVersion: 'cartonization-rate-v1',
  algorithmVersion: 'or-tools-v1',
  planInputHash: 'a'.repeat(64),
  planResultHash: cartonizationRateEvidenceHash(planSnapshot),
  planSnapshot,
  assumptionSnapshot: {},
  status: 'succeeded',
  idempotencyKey: 'cartonization-demo-1',
  actorEmail: 'operator@example.com',
  packages,
  quotes,
}
const requestHash = cartonizationRateEvidenceRequestHash(request)
assert.equal(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    actorEmail: 'retrying-operator@example.com',
    idempotencyKey: 'another-command-key',
    packages: [...packages].reverse(),
    quotes: [...quotes].reverse(),
  }),
  'Semantic request hashing must ignore actor, command key, and edge ordering',
)
assert.notEqual(
  requestHash,
  cartonizationRateEvidenceRequestHash({
    ...request,
    packages: packages.map((item, index) => (
      index === 0
        ? { ...item, ratedGrossWeightGrams: item.ratedGrossWeightGrams + 1 }
        : item
    )),
  }),
  'Semantic request hashing must change when retained package evidence changes',
)

console.log('cartonization rate evidence contract tests passed')
