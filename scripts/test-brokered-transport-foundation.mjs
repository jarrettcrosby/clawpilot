#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const { Pool } = requireFromApp('pg')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function clone(value) {
  return plain(value)
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => {})
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw lastError ?? new Error('Disposable PostgreSQL did not become ready')
}

function loadTransportFoundation() {
  const path = 'app_src/lib/operations/transport.ts'
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], 'The transport foundation must transpile')
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: nodeRequire,
  }, { filename: path })
  return module.exports
}

function assertDeepFrozen(value, label = 'value') {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`)
  for (const [key, nested] of Object.entries(value)) {
    assertDeepFrozen(nested, `${label}.${key}`)
  }
}

const source = read('app_src/lib/operations/transport.ts')
assert.deepEqual(
  [...source.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)]
    .map((match) => match[1]),
  ['node:crypto'],
  'The pure transport contract may import only deterministic hashing support',
)
assert.doesNotMatch(source, /\bfetch\s*\(/)
assert.doesNotMatch(source, /process\.env|DATABASE_URL|credential_ciphertext/)

const transport = loadTransportFoundation()
assert.deepEqual(
  Object.keys(transport).sort(),
  [
    'MAX_TRANSPORT_PLAN_PACKAGES',
    'MAX_TRANSPORT_PLAN_PALLETS',
    'TRANSPORT_CAPABILITIES',
    'TRANSPORT_PLAN_CONTRACT_VERSION',
    'loosePackagePlanHash',
    'ltlPalletPlanHash',
    'mapRlCarriersExecutingCarrierIdentity',
    'mapWwexExecutingCarrierIdentity',
    'normalizeExecutingCarrierIdentity',
    'normalizeLoosePackagePlan',
    'normalizeLtlPalletPlan',
    'normalizeTransportCapability',
    'normalizeTransportHandlingPlan',
    'normalizeTransportProvider',
    'normalizeTransportSelection',
    'transportHandlingPlanHash',
    'transportRequestProfileHash',
  ].sort(),
)

const {
  TRANSPORT_CAPABILITIES,
  TRANSPORT_PLAN_CONTRACT_VERSION,
  loosePackagePlanHash,
  ltlPalletPlanHash,
  mapRlCarriersExecutingCarrierIdentity,
  mapWwexExecutingCarrierIdentity,
  normalizeLoosePackagePlan,
  normalizeLtlPalletPlan,
  normalizeTransportCapability,
  normalizeTransportHandlingPlan,
  normalizeTransportSelection,
  transportHandlingPlanHash,
  transportRequestProfileHash,
} = transport

assert.equal(TRANSPORT_PLAN_CONTRACT_VERSION, 'operations.transport_plan.v1')
assert.deepEqual(plain(TRANSPORT_CAPABILITIES), [
  'small_parcel_rate',
  'small_parcel_tender',
  'small_parcel_void',
  'small_parcel_tracking',
  'small_parcel_documents',
  'small_parcel_pickup',
  'ltl_rate',
  'ltl_tender',
  'ltl_cancel',
  'ltl_bol',
  'ltl_documents',
  'ltl_pickup',
  'ltl_pickup_cancel',
  'ltl_tracking',
])
assert.equal(normalizeTransportCapability('small_parcel_pickup'), 'small_parcel_pickup')
assert.throws(
  () => normalizeTransportCapability('small_parcel_cancel'),
  /capability must be one of/,
)

const packageHashA = 'a'.repeat(64)
const packageHashB = 'b'.repeat(64)
const packageHashC = 'c'.repeat(64)

const loosePlanInput = {
  contractVersion: 'operations.transport_plan.v1',
  planVersion: 3,
  transportMode: 'small_parcel',
  handlingUnitMode: 'loose_packages',
  requestProfile: {
    hazardousMaterials: false,
    declaredValue: null,
    accessorials: [],
    pickupRequired: false,
  },
  packages: [{
    packageSequence: 2,
    packageForm: 'poly_bag',
    packageReference: {
      referenceType: 'quote_package',
      packageGlobalId: null,
      quotePackageKey: 'poly-bag-2',
    },
    packageSnapshotHash: packageHashB,
    dimensionsMm: { length: 400, width: 300, height: 40 },
    grossWeightGrams: 850,
  }, {
    packageSequence: 1,
    packageForm: 'carton',
    packageReference: {
      referenceType: 'operations_package',
      packageGlobalId: 'gpa1234567',
      quotePackageKey: null,
    },
    packageSnapshotHash: packageHashA,
    dimensionsMm: { length: 460, width: 330, height: 250 },
    grossWeightGrams: 8_500,
  }],
}

const loosePlan = normalizeLoosePackagePlan(loosePlanInput)
assert.deepEqual(
  plain(loosePlan.packages.map((item) => item.packageSequence)),
  [1, 2],
)
assertDeepFrozen(loosePlan, 'loosePlan')
assert.match(loosePackagePlanHash(loosePlanInput), /^[a-f0-9]{64}$/)
assert.equal(
  loosePackagePlanHash(loosePlanInput),
  loosePackagePlanHash({
    ...clone(loosePlanInput),
    packages: clone(loosePlanInput.packages).reverse(),
  }),
)
assert.equal(
  loosePackagePlanHash(loosePlanInput),
  transportHandlingPlanHash(loosePlanInput),
)
assert.deepEqual(
  plain(normalizeTransportHandlingPlan(loosePlanInput)),
  plain(loosePlan),
)

const operatorClassification = {
  freightClass: '70',
  nmfcCode: null,
  source: 'operator_attested',
  reference: 'operator:jane@example.test:2026-08-11',
  description: 'Operator attested class from current product profile',
  capturedAt: '2026-08-11T12:34:56.000Z',
}
const providerClassification = {
  freightClass: 92.5,
  nmfcCode: '123456-01',
  source: 'provider_returned',
  reference: 'wwex:offer:415cb526',
  description: 'Class and NMFC returned for the selected commodity',
  capturedAt: '2026-08-11T12:35:00.000Z',
}

const ltlPlanInput = {
  contractVersion: 'operations.transport_plan.v1',
  planVersion: 4,
  transportMode: 'ltl',
  handlingUnitMode: 'palletized_handling_units',
  requestProfile: {
    hazardousMaterials: false,
    declaredValue: null,
    accessorials: ['RESIDENTIAL_DELIVERY', 'LIFTGATE_DELIVERY'],
    pickupRequired: true,
  },
  pallets: [{
    palletKey: 'pallet-1',
    palletSequence: 1,
    dimensionsMm: { length: 1_220, width: 1_020, height: 1_400 },
    tareWeightGrams: 18_000,
    grossWeightGrams: 45_000,
    stackability: 'non_stackable',
    mixedCommodities: true,
    memberships: [{
      membershipSequence: 3,
      packageSequence: 3,
      packageForm: 'carton',
      packageReference: {
        referenceType: 'quote_package',
        packageGlobalId: null,
        quotePackageKey: 'carton-3',
      },
      packageSnapshotHash: packageHashC,
      packageGrossWeightGrams: 6_000,
    }, {
      membershipSequence: 1,
      packageSequence: 1,
      packageForm: 'carton',
      packageReference: {
        referenceType: 'operations_package',
        packageGlobalId: 'gpa1234567',
        quotePackageKey: null,
      },
      packageSnapshotHash: packageHashA,
      packageGrossWeightGrams: 12_000,
    }, {
      membershipSequence: 2,
      packageSequence: 2,
      packageForm: 'carton',
      packageReference: {
        referenceType: 'quote_package',
        packageGlobalId: null,
        quotePackageKey: 'carton-2',
      },
      packageSnapshotHash: packageHashB,
      packageGrossWeightGrams: 9_000,
    }],
    commodities: [{
      commoditySequence: 2,
      description: 'Fragile consumer goods',
      pieces: 1,
      weightGrams: 6_000,
      classification: providerClassification,
      membershipSequences: [3],
    }, {
      commoditySequence: 1,
      description: 'Boxed metal fixtures',
      pieces: 2,
      weightGrams: 21_000,
      classification: operatorClassification,
      membershipSequences: [2, 1],
    }],
  }],
}

const ltlPlan = normalizeLtlPalletPlan(ltlPlanInput)
assert.deepEqual(
  plain(ltlPlan.pallets[0].memberships.map((item) => item.membershipSequence)),
  [1, 2, 3],
)
assert.deepEqual(
  plain(ltlPlan.pallets[0].commodities.map((item) => item.commoditySequence)),
  [1, 2],
)
assert.deepEqual(
  plain(ltlPlan.pallets[0].commodities[0].membershipSequences),
  [1, 2],
)
assert.equal(ltlPlan.pallets[0].commodities[0].classification.nmfcCode, null)
assert.equal(ltlPlan.pallets[0].mixedCommodities, true)
assert.deepEqual(plain(ltlPlan.requestProfile.accessorials), [
  'LIFTGATE_DELIVERY',
  'RESIDENTIAL_DELIVERY',
])
assert.match(
  transportRequestProfileHash(ltlPlanInput.requestProfile),
  /^[a-f0-9]{64}$/,
)
assertDeepFrozen(ltlPlan, 'ltlPlan')
assert.match(ltlPalletPlanHash(ltlPlanInput), /^[a-f0-9]{64}$/)
assert.equal(
  ltlPalletPlanHash(ltlPlanInput),
  ltlPalletPlanHash({
    ...clone(ltlPlanInput),
    pallets: clone(ltlPlanInput.pallets).map((pallet) => ({
      ...pallet,
      memberships: pallet.memberships.reverse(),
      commodities: pallet.commodities.reverse().map((commodity) => ({
        ...commodity,
        membershipSequences: commodity.membershipSequences.reverse(),
      })),
    })),
  }),
)
assert.equal(
  ltlPalletPlanHash(ltlPlanInput),
  transportHandlingPlanHash(ltlPlanInput),
)

const changedClass = clone(ltlPlanInput)
changedClass.pallets[0].commodities[0].classification.freightClass = '100'
assert.notEqual(ltlPalletPlanHash(changedClass), ltlPalletPlanHash(ltlPlanInput))

const underweightCommodity = clone(ltlPlanInput)
underweightCommodity.pallets[0].commodities[0].weightGrams -= 1
assert.throws(
  () => normalizeLtlPalletPlan(underweightCommodity),
  /commodity weights must equal member package gross weight/,
)
const unmodeledPalletWeight = clone(ltlPlanInput)
unmodeledPalletWeight.pallets[0].grossWeightGrams += 1
assert.throws(
  () => normalizeLtlPalletPlan(unmodeledPalletWeight),
  /grossWeightGrams must equal pallet tare plus member packages/,
)
const understatedPieces = clone(ltlPlanInput)
understatedPieces.pallets[0].commodities[1].pieces = 1
assert.throws(
  () => normalizeLtlPalletPlan(understatedPieces),
  /pieces must equal its classified package memberships/,
)
const duplicateCommodityMembership = clone(ltlPlanInput)
duplicateCommodityMembership.pallets[0].commodities[0].membershipSequences.push(2)
duplicateCommodityMembership.pallets[0].commodities[0].pieces = 2
assert.throws(
  () => normalizeLtlPalletPlan(duplicateCommodityMembership),
  /classify every pallet membership exactly once/,
)
const uncoveredMembership = clone(ltlPlanInput)
uncoveredMembership.pallets[0].commodities[0].membershipSequences = [1]
assert.throws(
  () => normalizeLtlPalletPlan(uncoveredMembership),
  /classify every pallet membership exactly once/,
)
const wrongMixedFlag = clone(ltlPlanInput)
wrongMixedFlag.pallets[0].mixedCommodities = false
assert.throws(
  () => normalizeLtlPalletPlan(wrongMixedFlag),
  /mixedCommodities must match the commodity count/,
)
const invalidClass = clone(ltlPlanInput)
invalidClass.pallets[0].commodities[0].classification.freightClass = '72'
assert.throws(
  () => normalizeLtlPalletPlan(invalidClass),
  /not a standard freight class/,
)
const hazardousPlan = clone(ltlPlanInput)
hazardousPlan.requestProfile.hazardousMaterials = true
assert.throws(
  () => normalizeLtlPalletPlan(hazardousPlan),
  /hazardousMaterials must be false in contract v1/,
)
const declaredValuePlan = clone(ltlPlanInput)
declaredValuePlan.requestProfile.declaredValue = { amountMinor: 1000, currency: 'USD' }
assert.throws(
  () => normalizeLtlPalletPlan(declaredValuePlan),
  /declaredValue must be null in contract v1/,
)
const unsupportedField = clone(ltlPlanInput)
unsupportedField.pallets[0].freightClass = '70'
assert.throws(
  () => normalizeLtlPalletPlan(unsupportedField),
  /freightClass is not supported/,
)
const polyBagOnPallet = clone(ltlPlanInput)
polyBagOnPallet.pallets[0].memberships[0].packageForm = 'poly_bag'
assert.throws(
  () => normalizeLtlPalletPlan(polyBagOnPallet),
  /packageForm must be one of carton/,
)

assert.deepEqual(
  plain(mapWwexExecutingCarrierIdentity({
    vendorId: 'ups',
    name: 'United Parcel Service',
    scac: 'upsn',
  }, 'small_parcel')),
  { code: 'UPS', name: 'United Parcel Service', scac: 'UPSN' },
)
assert.deepEqual(
  plain(mapWwexExecutingCarrierIdentity({
    vendorId: 'saia',
    name: 'Saia LTL Freight',
    scac: 'saia',
  }, 'ltl')),
  { code: 'SAIA', name: 'Saia LTL Freight', scac: 'SAIA' },
)
assert.deepEqual(plain(mapRlCarriersExecutingCarrierIdentity()), {
  code: 'RL_CARRIERS',
  name: 'R+L Carriers',
  scac: null,
})
assert.throws(
  () => mapWwexExecutingCarrierIdentity({
    vendorId: 'FEDEX',
    name: 'FedEx',
    scac: 'FDEG',
  }, 'small_parcel'),
  /WWEX small parcel must retain UPS/,
)

assert.deepEqual(
  plain(normalizeTransportSelection({
    provider: 'WWEX_SPEEDSHIP',
    transportMode: 'ltl',
    handlingUnitMode: 'palletized_handling_units',
    executingCarrier: { code: 'SAIA', name: 'Saia', scac: 'SAIA' },
  })),
  {
    provider: 'wwex_speedship',
    transportMode: 'ltl',
    handlingUnitMode: 'palletized_handling_units',
    executingCarrier: { code: 'SAIA', name: 'Saia', scac: 'SAIA' },
  },
)
assert.deepEqual(
  plain(normalizeTransportSelection({
    provider: 'rl_carriers',
    transportMode: 'ltl',
    handlingUnitMode: 'palletized_handling_units',
    executingCarrier: mapRlCarriersExecutingCarrierIdentity(),
  })).executingCarrier,
  { code: 'RL_CARRIERS', name: 'R+L Carriers', scac: null },
)
assert.throws(
  () => normalizeTransportSelection({
    provider: 'rl_carriers',
    transportMode: 'small_parcel',
    handlingUnitMode: 'loose_packages',
    executingCarrier: { code: 'RL_CARRIERS', name: 'R+L Carriers', scac: null },
  }),
  /rl_carriers is LTL only/,
)
assert.throws(
  () => normalizeTransportSelection({
    provider: 'ups_rest',
    transportMode: 'ltl',
    handlingUnitMode: 'palletized_handling_units',
    executingCarrier: { code: 'UPS', name: 'UPS', scac: 'UPSN' },
  }),
  /small-parcel only/,
)

const migration = read('db/migrations/0270_operations_brokered_transport_and_ltl.sql')
for (const table of [
  'operations_outbound_handling_unit_plans',
  'operations_outbound_handling_units',
  'operations_outbound_handling_unit_memberships',
  'operations_outbound_handling_unit_commodities',
  'operations_one_off_parcel_pickup_attempts',
  'operations_freight_tender_attempts',
  'operations_freight_tender_documents',
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`))
}
for (const expected of [
  "credential_kind IN ('oauth_client_credentials', 'api_key')",
  'credential_identifier_last_four = COALESCE',
  'NEW.client_id_last_four IS DISTINCT FROM OLD.client_id_last_four',
  "provider IN ('wwex_speedship', 'rl_carriers')",
  "transport_mode = 'small_parcel'",
  "transport_mode = 'ltl'",
  "handling_unit_mode = 'loose_packages'",
  "handling_unit_mode = 'palletized_handling_units'",
  'provider_offer_id text',
  'provider_product_id text',
  'provider_transaction_id text',
  'pickup_offer_id text',
  'pickup_product_id text',
  'pickup_transaction_id text',
  'pickup_order_reference text',
  'pickup_transaction_reference text',
  "pickup_binding IN ('none', 'embedded_bol', 'integrated_order')",
  'validate_operations_freight_provider_operation_capability_write',
  'allowedCapabilities":["ltl_bol"]',
  "retained_rate->>'productTransactionId'",
  'request_profile jsonb NOT NULL',
  "package_form text NOT NULL CHECK (package_form IN ('carton', 'poly_bag'))",
  'LTL handling plans may palletize cartons only',
  'request_profile_hash text NOT NULL',
  'operations_transport_json_sha256(plan_snapshot)',
  'operations_transport_json_sha256(request_profile)',
  'unit.unit_snapshot_hash IS DISTINCT FROM',
  "current_plan.plan_snapshot->'pallets'",
  'credential_fingerprint text',
  'required_transport_sources text[]',
  'transport_results_snapshot jsonb',
  "source = 'packed_rerate'",
  'commodity_stats.commodity_weight_grams',
  '<> membership_stats.membership_weight_grams',
  "integration.configuration->>'activationStatus' = 'active'",
  "integration.configuration->'activationBlockers'",
  'credential.credential_version = NEW.credential_version',
  'credential.credential_fingerprint = NEW.credential_fingerprint',
  'protect_operations_outbound_handling_commodity_write',
]) {
  assert.ok(migration.includes(expected), `Migration must include ${expected}`)
}
assert.match(
  migration,
  /provider = 'rl_carriers'[\s\S]{0,500}provider_offer_id IS NULL/,
)
assert.match(
  migration,
  /provider = 'wwex_speedship'[\s\S]{0,500}executing_carrier_scac IS NOT NULL/,
)
assert.match(
  migration,
  /operations_carrier_rate_requests_provider_account_valid[\s\S]{0,500}\) NOT VALID;/,
  'Legacy append-only direct-carrier evidence may remain account-null while the stricter provider/account rule is enforced for new writes',
)

function configuredCapabilityAllowlist(provider) {
  const marker = `input_provider = '${provider}'\n         AND capability #>> '{}' NOT IN (`
  const start = migration.indexOf(marker)
  assert.notEqual(start, -1, `${provider} must have an executable capability allowlist`)
  const listStart = start + marker.length
  const end = migration.indexOf('\n         )', listStart)
  assert.notEqual(end, -1, `${provider} capability allowlist must terminate`)
  return [...migration.slice(listStart, end).matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
}

assert.deepEqual(configuredCapabilityAllowlist('wwex_speedship'), [
  'small_parcel_rate',
  'small_parcel_tender',
  'small_parcel_pickup',
  'ltl_rate',
  'ltl_tender',
])
assert.deepEqual(configuredCapabilityAllowlist('rl_carriers'), [
  'ltl_rate',
  'ltl_tender',
  'ltl_bol',
  'ltl_pickup',
])
for (const disabledCapability of [
  'small_parcel_void',
  'small_parcel_tracking',
  'small_parcel_documents',
  'ltl_cancel',
  'ltl_documents',
  'ltl_pickup_cancel',
  'ltl_tracking',
]) {
  assert.equal(
    configuredCapabilityAllowlist('wwex_speedship').includes(disabledCapability),
    false,
    `WWEX must reject non-executable ${disabledCapability} activation`,
  )
}
for (const disabledCapability of [
  'small_parcel_rate',
  'small_parcel_tender',
  'small_parcel_pickup',
  'ltl_cancel',
  'ltl_documents',
  'ltl_pickup_cancel',
  'ltl_tracking',
]) {
  assert.equal(
    configuredCapabilityAllowlist('rl_carriers').includes(disabledCapability),
    false,
    `R+L must reject non-executable ${disabledCapability} activation`,
  )
}
assert.ok(
  migration.indexOf('DROP TRIGGER IF EXISTS protect_operations_one_off_quote_offers_mutation')
    < migration.indexOf('UPDATE operations_one_off_shipment_quote_offers'),
  'Offer backfill must temporarily remove the append-only trigger',
)
assert.ok(
  migration.indexOf('UPDATE operations_one_off_shipment_quote_offers')
    < migration.indexOf('CREATE TRIGGER protect_operations_one_off_quote_offers_mutation'),
  'Offer append-only protection must be restored after backfill',
)

function pickupScope(hashCharacter) {
  return {
    organizationId: randomUUID(),
    orderId: randomUUID(),
    fulfillmentPlanId: randomUUID(),
    quoteId: randomUUID(),
    offerId: randomUUID(),
    handlingPlanId: randomUUID(),
    integrationId: randomUUID(),
    credentialVersion: 7,
    credentialFingerprint: 'c'.repeat(64),
    providerOfferId: `shipment-offer-${hashCharacter}`,
    providerProductId: `shipment-product-${hashCharacter}`,
    providerTransactionId: `shipment-transaction-${hashCharacter}`,
    billingFingerprint: 'b'.repeat(64),
    pickupQuoteRequestHash: hashCharacter.repeat(64),
    requestHash: hashCharacter.repeat(64),
  }
}

let pickupGlobalSequence = 1
async function insertPreparedPickup(client, scope, options = {}) {
  const action = options.action ?? 'schedule'
  const globalId = `gtpa${String(pickupGlobalSequence).padStart(7, '0')}`
  const idempotencyKey = `pickup-${pickupGlobalSequence}-idempotency`
  pickupGlobalSequence += 1
  const result = await client.query(
    `INSERT INTO operations_one_off_parcel_pickup_attempts (
       global_id, organization_id, order_id, fulfillment_plan_id,
       one_off_quote_id, one_off_offer_id, handling_unit_plan_id,
       integration_account_id, credential_version, credential_fingerprint,
       schedule_attempt_id, action, environment,
       provider_offer_id, provider_product_id, provider_transaction_id,
       provider_billing_account_fingerprint, pickup_quote_request_hash,
       adapter_version, idempotency_key, request_hash,
       redacted_request, reason
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, 'sandbox', $13, $14, $15, $16, $17,
       'wwex-speedship-foundation-v1', $18, $19, '{}'::jsonb,
       'Executable pickup persistence contract'
     ) RETURNING id`,
    [
      globalId,
      scope.organizationId,
      scope.orderId,
      scope.fulfillmentPlanId,
      scope.quoteId,
      scope.offerId,
      scope.handlingPlanId,
      scope.integrationId,
      scope.credentialVersion,
      scope.credentialFingerprint,
      options.scheduleAttemptId ?? null,
      action,
      scope.providerOfferId,
      scope.providerProductId,
      scope.providerTransactionId,
      scope.billingFingerprint,
      scope.pickupQuoteRequestHash,
      idempotencyKey,
      scope.requestHash,
    ],
  )
  return result.rows[0].id
}

let groupGlobalSequence = 1
async function insertWwexGroup(client, scope, pickupAttemptId, overrides = {}) {
  const sequence = groupGlobalSequence
  groupGlobalSequence += 1
  return client.query(
    `INSERT INTO operations_one_off_carrier_group_attempts (
       global_id, organization_id, order_id, plan_id,
       planning_quote_id, planning_offer_id,
       purchase_quote_id, purchase_offer_id, carrier_rate_id,
       integration_account_id, carrier_account_id, action, environment,
       provider, service_code, package_count, selected_amount_minor,
       currency, adapter_version, idempotency_key, request_hash,
       redacted_request, reason, transport_mode, handling_unit_mode,
       executing_carrier_code, executing_carrier_name,
       provider_offer_id, provider_product_id, provider_transaction_id,
       provider_billing_account_fingerprint, credential_version,
       credential_fingerprint, handling_unit_plan_id, pickup_attempt_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL,
       'create', 'sandbox', 'wwex_speedship', 'GROUND', 1, 1000,
       'USD', 'wwex-speedship-foundation-v1', $11, $12,
       '{}'::jsonb, 'Executable integrated-order pickup binding',
       'small_parcel', 'loose_packages', 'UPS',
       'United Parcel Service', $13, $14, $15, $16, $17, $18, $19, $20
     )`,
    [
      `gocg${String(sequence).padStart(7, '0')}`,
      scope.organizationId,
      overrides.orderId ?? scope.orderId,
      overrides.fulfillmentPlanId ?? scope.fulfillmentPlanId,
      randomUUID(),
      randomUUID(),
      overrides.quoteId ?? scope.quoteId,
      overrides.offerId ?? scope.offerId,
      randomUUID(),
      scope.integrationId,
      `wwex-group-${sequence}-idempotency`,
      String((sequence % 9) + 1).repeat(64),
      scope.providerOfferId,
      scope.providerProductId,
      scope.providerTransactionId,
      scope.billingFingerprint,
      overrides.credentialVersion ?? scope.credentialVersion,
      scope.credentialFingerprint,
      overrides.handlingPlanId ?? scope.handlingPlanId,
      pickupAttemptId,
    ],
  )
}

let freightGlobalSequence = 1
async function insertPreparedRlEmbeddedPickupTender(client, options = {}) {
  const sequence = freightGlobalSequence
  freightGlobalSequence += 1
  const result = await client.query(
    `INSERT INTO operations_freight_tender_attempts (
       global_id, organization_id, order_id, fulfillment_plan_id,
       one_off_quote_id, one_off_offer_id, handling_unit_plan_id,
       integration_account_id, carrier_account_id, credential_version,
       credential_fingerprint, action, environment, provider,
       provider_operation, pickup_binding, executing_carrier_code,
       executing_carrier_name, service_code, provider_quote_reference,
       selected_amount_minor, currency, adapter_version, idempotency_key,
       request_hash, redacted_request, reason
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, NULL, 3, $9,
       'tender', 'sandbox', 'rl_carriers', 'bill_of_lading',
       $10, 'RL_CARRIERS', 'R+L Carriers', 'LTL_STANDARD',
       $11, 25000, 'USD', 'rl-carriers-foundation-v1', $12, $13,
       '{}'::jsonb, 'Executable embedded BOL pickup outcome'
     ) RETURNING id`,
    [
      `gfta${String(sequence).padStart(7, '0')}`,
      options.organizationId ?? randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      options.integrationId ?? randomUUID(),
      'd'.repeat(64),
      options.pickupBinding ?? 'embedded_bol',
      `rl-quote-${sequence}`,
      `rl-tender-${sequence}-idempotency`,
      String((sequence % 8) + 1).repeat(64),
    ],
  )
  return result.rows[0].id
}

async function insertPreparedWwexLtlTender(client) {
  const sequence = freightGlobalSequence
  freightGlobalSequence += 1
  const result = await client.query(
    `INSERT INTO operations_freight_tender_attempts (
       global_id, organization_id, order_id, fulfillment_plan_id,
       one_off_quote_id, one_off_offer_id, handling_unit_plan_id,
       integration_account_id, carrier_account_id, credential_version,
       credential_fingerprint, action, environment, provider,
       provider_operation, pickup_binding, executing_carrier_code,
       executing_carrier_name, executing_carrier_scac, service_code,
       provider_quote_reference, provider_offer_id, provider_product_id,
       provider_transaction_id, provider_billing_account_fingerprint,
       selected_amount_minor, currency, adapter_version, idempotency_key,
       request_hash, redacted_request, reason
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, NULL, 4, $9,
       'tender', 'sandbox', 'wwex_speedship', 'quote_order',
       'integrated_order', 'RLCA', 'R+L Carriers', 'RLCA', 'STANDARD',
       $10, $11, $12, $13, $14, 28742, 'USD',
       'wwex-speedship-foundation-v1', $15, $16, '{}'::jsonb,
       'Executable WWEX LTL pickup outcome'
     ) RETURNING id`,
    [
      `gfta${String(sequence).padStart(7, '0')}`,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      'e'.repeat(64),
      `wwex-quote-${sequence}`,
      `wwex-offer-${sequence}`,
      `wwex-product-${sequence}`,
      `wwex-transaction-${sequence}`,
      'b'.repeat(64),
      `wwex-ltl-${sequence}-idempotency`,
      String((sequence % 7) + 1).repeat(64),
    ],
  )
  return result.rows[0].id
}

let ltlAssessmentSequence = 1
async function insertLtlDensityAssessment(client, fixture, options = {}) {
  const sequence = ltlAssessmentSequence
  ltlAssessmentSequence += 1
  const identity = await client.query(
    `SELECT gen_random_uuid()::text AS id,
            allocate_global_reference('gfca') AS global_id`,
  )
  const dimensionsMm = options.dimensionsMm ?? {
    length: 1_000,
    width: 1_000,
    height: 1_000,
  }
  const grossWeightGrams = options.grossWeightGrams ?? 250_000
  const volumeCubicFeet = (
    dimensionsMm.length * dimensionsMm.width * dimensionsMm.height
  ) / 28_316_846.592
  const densityPcf = (
    grossWeightGrams / 453.59237
  ) / volumeCubicFeet
  const recommendedFreightClass = (
    options.recommendedFreightClass ?? '70'
  )
  const nmfcCode = options.nmfcCode ?? null
  const evidence = {
    freightClass: String(recommendedFreightClass),
    nmfcCode,
    source: 'density_calculation',
    reference: identity.rows[0].global_id,
    description: (
      'Exact operator-attested density evidence for the disposable PostgreSQL fixture'
    ),
    capturedAt: fixture.capturedAt,
  }
  const retainedEvidence = options.evidenceTransform
    ? options.evidenceTransform(evidence)
    : evidence
  const inserted = await client.query(
    `INSERT INTO operations_ltl_freight_class_assessments (
       id, global_id, organization_id, idempotency_key,
       request_hash, input_hash, contract_version,
       handling_unit_key, description,
       length_mm, width_mm, height_mm, gross_weight_grams,
       volume_cubic_feet, density_pcf, recommended_freight_class,
       full_density_scale_confirmed, mixed_commodities,
       handling_concern, stowability_concern, liability_concern,
       classification_reference, nmfc_code, attestation,
       classification_evidence, created_by, created_at
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4,
       $5, $6, 'clawpilot.ltl_density_classification.v1',
       $7, $8,
       $9, $10, $11, $12,
       $13, $14, $15,
       $16, $17, $18, $19, $20,
       $21, $22, $23,
       $24::jsonb, $25, $26::timestamptz
     ) RETURNING id::text, global_id`,
    [
      identity.rows[0].id,
      identity.rows[0].global_id,
      fixture.organizationId,
      `ltl-density-assessment-${sequence}-${randomUUID()}`,
      String((sequence % 8) + 1).repeat(64),
      String((sequence % 7) + 2).repeat(64),
      options.handlingUnitKey ?? `density-pallet-${sequence}`,
      options.description ?? 'Density classified single commodity pallet',
      dimensionsMm.length,
      dimensionsMm.width,
      dimensionsMm.height,
      grossWeightGrams,
      Number(volumeCubicFeet.toFixed(6)),
      Number(densityPcf.toFixed(6)),
      recommendedFreightClass,
      options.fullDensityScaleConfirmed ?? true,
      options.mixedCommodities ?? false,
      options.handlingConcern ?? false,
      options.stowabilityConcern ?? false,
      options.liabilityConcern ?? false,
      options.classificationReference ?? 'nmfta-full-density-scale-confirmed',
      nmfcCode,
      options.attestation ?? 'I verified this exact as-tendered handling unit',
      JSON.stringify(retainedEvidence),
      fixture.actorEmail,
      fixture.capturedAt,
    ],
  )
  return {
    id: inserted.rows[0].id,
    globalId: inserted.rows[0].global_id,
    dimensionsMm,
    grossWeightGrams,
    classificationEvidence: retainedEvidence,
  }
}

async function verifyDatabaseTransitions(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    const looseHash = await client.query(
      'SELECT operations_transport_json_sha256($1::jsonb) AS value',
      [JSON.stringify(plain(loosePlan))],
    )
    assert.equal(looseHash.rows[0].value, loosePackagePlanHash(loosePlan))
    const ltlHash = await client.query(
      'SELECT operations_transport_json_sha256($1::jsonb) AS value',
      [JSON.stringify(plain(ltlPlan))],
    )
    assert.equal(ltlHash.rows[0].value, ltlPalletPlanHash(ltlPlan))
    const requestProfile = await client.query(
      `SELECT operations_transport_request_profile_is_valid($1::jsonb) AS valid,
              operations_transport_json_sha256($1::jsonb) AS hash`,
      [JSON.stringify(plain(ltlPlan.requestProfile))],
    )
    assert.equal(requestProfile.rows[0].valid, true)
    assert.equal(
      requestProfile.rows[0].hash,
      transportRequestProfileHash(ltlPlan.requestProfile),
    )

    const classificationActor = (
      `brokered-transport-density-${process.pid}@example.test`
    )
    await client.query(
      `INSERT INTO app_users (email, role, status)
       VALUES ($1, 'owner', 'active')`,
      [classificationActor],
    )
    const classificationOrganization = await client.query(
      `INSERT INTO workspace_organizations (
         name, organization_type, created_by, updated_by
       ) VALUES (
         'Brokered transport density fixture', 'member', $1, $1
       ) RETURNING id::text`,
      [classificationActor],
    )
    const classificationFixture = {
      actorEmail: classificationActor,
      organizationId: classificationOrganization.rows[0].id,
      capturedAt: '2026-08-11T12:00:00.000Z',
    }
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid,
           organization_name = 'Brokered transport density fixture'
       WHERE email = $1`,
      [classificationActor, classificationFixture.organizationId],
    )

    const eligibleAssessment = await insertLtlDensityAssessment(
      client,
      classificationFixture,
      { handlingUnitKey: 'density-pallet-exact' },
    )
    const retainedAssessment = await client.query(
      `SELECT global_id, recommended_freight_class::text AS freight_class,
              classification_evidence
       FROM operations_ltl_freight_class_assessments
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [classificationFixture.organizationId, eligibleAssessment.id],
    )
    assert.equal(retainedAssessment.rows[0].global_id, eligibleAssessment.globalId)
    assert.equal(Number(retainedAssessment.rows[0].freight_class), 70)
    assert.deepEqual(
      retainedAssessment.rows[0].classification_evidence,
      eligibleAssessment.classificationEvidence,
    )

    await assert.rejects(
      insertLtlDensityAssessment(client, classificationFixture, {
        recommendedFreightClass: '65',
        evidenceTransform: (evidence) => ({
          ...evidence,
          freightClass: '70',
        }),
      }),
      /operations_ltl_freight_class_assessment_evidence_valid/iu,
    )
    await assert.rejects(
      insertLtlDensityAssessment(client, classificationFixture, {
        evidenceTransform: (evidence) => ({
          ...evidence,
          reference: 'gfca0000000',
        }),
      }),
      /operations_ltl_freight_class_assessment_evidence_valid/iu,
    )
    await assert.rejects(
      insertLtlDensityAssessment(client, classificationFixture, {
        evidenceTransform: (evidence) => {
          const withoutSource = { ...evidence }
          delete withoutSource.source
          return withoutSource
        },
      }),
      /operations_ltl_freight_class_assessment_evidence_valid/iu,
    )
    for (const ineligibleFlags of [
      { fullDensityScaleConfirmed: false },
      { mixedCommodities: true },
      { handlingConcern: true },
      { stowabilityConcern: true },
      { liabilityConcern: true },
    ]) {
      await assert.rejects(
        insertLtlDensityAssessment(
          client,
          classificationFixture,
          ineligibleFlags,
        ),
        /operations_ltl_freight_class_assessment_eligibility_valid/iu,
      )
    }
    await assert.rejects(
      client.query(
        `UPDATE operations_ltl_freight_class_assessments
         SET description = 'Tampered density assessment'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [classificationFixture.organizationId, eligibleAssessment.id],
      ),
      /LTL freight-class assessments are immutable/iu,
    )
    await assert.rejects(
      client.query(
        `DELETE FROM operations_ltl_freight_class_assessments
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [classificationFixture.organizationId, eligibleAssessment.id],
      ),
      /LTL freight-class assessments are immutable/iu,
    )

    const quoteId = randomUUID()
    const quoteIdentity = await client.query(
      `SELECT allocate_global_reference('goq') AS global_id`,
    )
    const quotePackages = [{
      packageKey: 'density-carton-1',
      dimensionsMm: { length: 800, width: 600, height: 500 },
      grossWeightGrams: 230_000,
      allocations: [{ lineKey: 'density-line-1', quantity: 1 }],
    }]
    await client.query('SET session_replication_role = replica')
    try {
      await client.query(
        `INSERT INTO operations_one_off_shipment_quotes (
           id, global_id, organization_id, pipeline_id, customer_id,
           warehouse_id, inventory_pool_id, receiving_location_id,
           rate_environment, execution_mode, reference_number, currency,
           destination_snapshot, destination_hash,
           lines_snapshot, lines_hash, packages_snapshot, packages_hash,
           required_carrier_providers, provider_results_snapshot,
           request_hash, status, idempotency_key, actor_email,
           expires_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, $8::uuid,
           'sandbox', 'test', 'DENSITY-POSTGRES-1', 'USD',
           '{}'::jsonb, $9, '[{"lineKey":"density-line-1"}]'::jsonb,
           $10, $11::jsonb, $12,
           ARRAY['ups_rest']::text[], '{"ups_rest":{"status":"failed"}}'::jsonb,
           $13, 'failed', $14, $15,
           clock_timestamp() + interval '1 hour'
         )`,
        [
          quoteId,
          quoteIdentity.rows[0].global_id,
          classificationFixture.organizationId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          '1'.repeat(64),
          '2'.repeat(64),
          JSON.stringify(quotePackages),
          '3'.repeat(64),
          '4'.repeat(64),
          `density-quote-${randomUUID()}`,
          classificationActor,
        ],
      )
    } finally {
      await client.query('SET session_replication_role = origin')
    }

    const densityPlan = normalizeLtlPalletPlan({
      contractVersion: 'operations.transport_plan.v1',
      planVersion: 1,
      transportMode: 'ltl',
      handlingUnitMode: 'palletized_handling_units',
      requestProfile: {
        hazardousMaterials: false,
        declaredValue: null,
        accessorials: [],
        pickupRequired: false,
      },
      pallets: [{
        palletKey: 'density-pallet-exact',
        palletSequence: 1,
        dimensionsMm: eligibleAssessment.dimensionsMm,
        tareWeightGrams: 20_000,
        grossWeightGrams: eligibleAssessment.grossWeightGrams,
        stackability: 'stackable',
        mixedCommodities: false,
        memberships: [{
          membershipSequence: 1,
          packageSequence: 1,
          packageForm: 'carton',
          packageReference: {
            referenceType: 'quote_package',
            packageGlobalId: null,
            quotePackageKey: 'density-carton-1',
          },
          packageSnapshotHash: '5'.repeat(64),
          packageGrossWeightGrams: 230_000,
        }],
        commodities: [{
          commoditySequence: 1,
          description: 'Density classified single commodity pallet',
          pieces: 1,
          weightGrams: 230_000,
          classification: eligibleAssessment.classificationEvidence,
          membershipSequences: [1],
        }],
      }],
    })
    const densityPallet = densityPlan.pallets[0]
    const densityUnitHash = await client.query(
      `SELECT operations_transport_json_sha256($1::jsonb) AS value`,
      [JSON.stringify(plain(densityPallet))],
    )
    let densityPlanId
    let densityUnitId
    await client.query('BEGIN')
    try {
      const insertedPlan = await client.query(
        `INSERT INTO operations_outbound_handling_unit_plans (
           organization_id, one_off_quote_id, contract_version,
           version_number, transport_mode, handling_unit_mode, source,
           handling_unit_count, package_count, total_gross_weight_grams,
           request_profile, request_profile_hash, plan_hash, plan_snapshot,
           created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, 'ltl',
           'palletized_handling_units', 'operator_explicit',
           1, 1, $5, $6::jsonb, $7, $8, $9::jsonb, $10
         ) RETURNING id::text`,
        [
          classificationFixture.organizationId,
          quoteId,
          densityPlan.contractVersion,
          densityPlan.planVersion,
          densityPallet.grossWeightGrams,
          JSON.stringify(plain(densityPlan.requestProfile)),
          transportRequestProfileHash(densityPlan.requestProfile),
          ltlPalletPlanHash(densityPlan),
          JSON.stringify(plain(densityPlan)),
          classificationActor,
        ],
      )
      densityPlanId = insertedPlan.rows[0].id
      const insertedUnit = await client.query(
        `INSERT INTO operations_outbound_handling_units (
           organization_id, handling_unit_plan_id, unit_key, unit_sequence,
           unit_type, length_mm, width_mm, height_mm,
           tare_weight_grams, gross_weight_grams, stackability,
           mixed_commodities, unit_snapshot_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, 1, 'pallet', $4, $5, $6,
           $7, $8, $9, false, $10
         ) RETURNING id::text`,
        [
          classificationFixture.organizationId,
          densityPlanId,
          densityPallet.palletKey,
          densityPallet.dimensionsMm.length,
          densityPallet.dimensionsMm.width,
          densityPallet.dimensionsMm.height,
          densityPallet.tareWeightGrams,
          densityPallet.grossWeightGrams,
          densityPallet.stackability,
          densityUnitHash.rows[0].value,
        ],
      )
      densityUnitId = insertedUnit.rows[0].id
      await client.query('SAVEPOINT reject_ltl_poly_bag')
      await assert.rejects(
        client.query(
          `INSERT INTO operations_outbound_handling_unit_memberships (
             organization_id, handling_unit_plan_id, handling_unit_id,
             membership_sequence, package_sequence, package_form,
             quote_package_key, package_snapshot_hash,
             allocated_gross_weight_grams
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 1, 1, 'poly_bag', $4, $5, $6
           )`,
          [
            classificationFixture.organizationId,
            densityPlanId,
            densityUnitId,
            densityPallet.memberships[0].packageReference.quotePackageKey,
            densityPallet.memberships[0].packageSnapshotHash,
            densityPallet.memberships[0].packageGrossWeightGrams,
          ],
        ),
        /LTL handling plans may palletize cartons only/iu,
      )
      await client.query('ROLLBACK TO SAVEPOINT reject_ltl_poly_bag')
      await client.query('RELEASE SAVEPOINT reject_ltl_poly_bag')
      await client.query(
        `INSERT INTO operations_outbound_handling_unit_memberships (
           organization_id, handling_unit_plan_id, handling_unit_id,
           membership_sequence, package_sequence, package_form,
           quote_package_key,
           package_snapshot_hash, allocated_gross_weight_grams
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1, 1, 'carton', $4, $5, $6
         )`,
        [
          classificationFixture.organizationId,
          densityPlanId,
          densityUnitId,
          densityPallet.memberships[0].packageReference.quotePackageKey,
          densityPallet.memberships[0].packageSnapshotHash,
          densityPallet.memberships[0].packageGrossWeightGrams,
        ],
      )
      await client.query(
        `INSERT INTO operations_outbound_handling_unit_commodities (
           organization_id, handling_unit_plan_id, handling_unit_id,
           commodity_sequence, description, pieces, weight_grams,
           freight_class, nmfc_code, classification_evidence,
           membership_sequences, classification_assessment_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 1, $4, 1, $5,
           70, NULL, $6::jsonb, ARRAY[1]::integer[], $7::uuid
         )`,
        [
          classificationFixture.organizationId,
          densityPlanId,
          densityUnitId,
          densityPallet.commodities[0].description,
          densityPallet.commodities[0].weightGrams,
          JSON.stringify(densityPallet.commodities[0].classification),
          eligibleAssessment.id,
        ],
      )
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }

    async function insertRejectedDensityCommodity(
      classificationAssessmentId,
      classificationEvidence,
    ) {
      return client.query(
        `INSERT INTO operations_outbound_handling_unit_commodities (
           organization_id, handling_unit_plan_id, handling_unit_id,
           commodity_sequence, description, pieces, weight_grams,
           freight_class, nmfc_code, classification_evidence,
           membership_sequences, classification_assessment_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 2,
           'Rejected density commodity candidate', 1, 230000,
           70, NULL, $4::jsonb, ARRAY[1]::integer[], $5::uuid
         )`,
        [
          classificationFixture.organizationId,
          densityPlanId,
          densityUnitId,
          JSON.stringify(classificationEvidence),
          classificationAssessmentId,
        ],
      )
    }

    await assert.rejects(
      insertRejectedDensityCommodity(
        null,
        eligibleAssessment.classificationEvidence,
      ),
      /operations_outbound_handling_commodity_class_assessment_require/iu,
    )
    const mismatchedDimensionAssessment = await insertLtlDensityAssessment(
      client,
      classificationFixture,
      {
        handlingUnitKey: 'density-pallet-wrong-dimensions',
        dimensionsMm: { length: 999, width: 1_000, height: 1_000 },
      },
    )
    await assert.rejects(
      insertRejectedDensityCommodity(
        mismatchedDimensionAssessment.id,
        mismatchedDimensionAssessment.classificationEvidence,
      ),
      /Density classification must bind the exact attested single-commodity pallet/iu,
    )
    await assert.rejects(
      insertRejectedDensityCommodity(
        eligibleAssessment.id,
        {
          ...eligibleAssessment.classificationEvidence,
          description: 'Tampered density evidence description',
        },
      ),
      /Density classification must bind the exact attested single-commodity pallet/iu,
    )

    await client.query(
      'ALTER TABLE operations_one_off_parcel_pickup_attempts DISABLE TRIGGER ALL',
    )
    await client.query(
      `ALTER TABLE operations_one_off_parcel_pickup_attempts
         ENABLE TRIGGER validate_operations_one_off_parcel_pickup_attempt_write`,
    )
    await client.query(
      `ALTER TABLE operations_one_off_parcel_pickup_attempts
         ENABLE TRIGGER protect_operations_one_off_parcel_pickup_attempt_write`,
    )

    const succeededScope = pickupScope('a')
    await client.query('SET session_replication_role = replica')
    const succeededPickupId = await insertPreparedPickup(client, succeededScope)
    await client.query('SET session_replication_role = origin')
    await client.query(
      `UPDATE operations_one_off_parcel_pickup_attempts
       SET state = 'succeeded', completed_at = now(),
           pickup_offer_id = 'pickup-offer-a',
           pickup_product_id = 'pickup-product-a',
           pickup_transaction_id = 'pickup-transaction-a',
           pickup_quote_response_hash = $2,
           redacted_response = '{"status":"succeeded"}'::jsonb
       WHERE id = $1`,
      [succeededPickupId, 'f'.repeat(64)],
    )

    const missingIdentifierScope = pickupScope('e')
    await client.query('SET session_replication_role = replica')
    const missingIdentifierId = await insertPreparedPickup(
      client,
      missingIdentifierScope,
    )
    await client.query('SET session_replication_role = origin')
    await assert.rejects(
      client.query(
        `UPDATE operations_one_off_parcel_pickup_attempts
         SET state = 'succeeded', completed_at = now(),
             pickup_offer_id = 'pickup-offer-e',
             pickup_product_id = 'pickup-product-e',
             pickup_quote_response_hash = $2
         WHERE id = $1`,
        [missingIdentifierId, 'e'.repeat(64)],
      ),
      /operations_one_off_parcel_pickup_completion_valid/iu,
    )

    const unknownScope = pickupScope('8')
    await client.query('SET session_replication_role = replica')
    const unknownPickupId = await insertPreparedPickup(client, unknownScope)
    await client.query('SET session_replication_role = origin')
    await client.query(
      `UPDATE operations_one_off_parcel_pickup_attempts
       SET state = 'unknown', completed_at = now(), error_code = 'TIMEOUT'
       WHERE id = $1`,
      [unknownPickupId],
    )
    await client.query('SET session_replication_role = replica')
    await assert.rejects(
      insertPreparedPickup(client, unknownScope),
      /operations_one_off_parcel_pickup_active_schedule_unique|duplicate key/iu,
    )
    await client.query('SET session_replication_role = origin')
    const reconcilePickupId = await insertPreparedPickup(client, unknownScope, {
      action: 'reconcile',
      scheduleAttemptId: unknownPickupId,
    })
    await client.query(
      `UPDATE operations_one_off_parcel_pickup_attempts
       SET state = 'succeeded', completed_at = now(),
           pickup_offer_id = 'pickup-offer-8',
           pickup_product_id = 'pickup-product-8',
           pickup_transaction_id = 'pickup-transaction-8',
           pickup_quote_response_hash = $2
       WHERE id = $1`,
      [reconcilePickupId, '7'.repeat(64)],
    )

    await client.query(
      'ALTER TABLE operations_one_off_carrier_group_attempts DISABLE TRIGGER ALL',
    )
    await client.query(
      `ALTER TABLE operations_one_off_carrier_group_attempts
         ENABLE TRIGGER validate_operations_one_off_group_pickup_write`,
    )
    await insertWwexGroup(client, succeededScope, succeededPickupId)
    await assert.rejects(
      insertWwexGroup(client, succeededScope, succeededPickupId, {
        credentialVersion: succeededScope.credentialVersion + 1,
      }),
      /exact succeeded pre-tender pickup attempt/iu,
    )
    await assert.rejects(
      insertWwexGroup(client, succeededScope, succeededPickupId, {
        quoteId: randomUUID(),
      }),
      /exact succeeded pre-tender pickup attempt/iu,
    )
    await assert.rejects(
      insertWwexGroup(client, succeededScope, succeededPickupId, {
        handlingPlanId: randomUUID(),
      }),
      /exact succeeded pre-tender pickup attempt/iu,
    )
    await assert.rejects(
      insertWwexGroup(
        client,
        missingIdentifierScope,
        missingIdentifierId,
      ),
      /exact succeeded pre-tender pickup attempt/iu,
    )

    const rlAuthorityOrganizationId = randomUUID()
    const rlAuthorityIntegrationId = randomUUID()
    const rlTenderOnlyConfiguration = {
      transportModes: ['ltl'],
      allowedCapabilities: ['ltl_rate', 'ltl_tender'],
      transportActivation: {
        small_parcel: { ratingEnabled: false, tenderEnabled: false },
        ltl: { ratingEnabled: true, tenderEnabled: true },
      },
      activationStatus: 'active',
      activationBlockers: [],
    }
    await client.query(
      'ALTER TABLE operations_integration_accounts DISABLE TRIGGER ALL',
    )
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id, global_id, organization_id, provider, integration_type,
         environment, display_name, status, configuration
       ) VALUES (
         $1, 'gia0999999', $2, 'rl_carriers', 'carrier', 'sandbox',
         'R+L executable BOL authority fixture', 'active', $3::jsonb
       )`,
      [
        rlAuthorityIntegrationId,
        rlAuthorityOrganizationId,
        JSON.stringify(rlTenderOnlyConfiguration),
      ],
    )
    await client.query(
      'ALTER TABLE operations_freight_tender_attempts DISABLE TRIGGER ALL',
    )
    await client.query(
      `ALTER TABLE operations_freight_tender_attempts
         ENABLE TRIGGER
           validate_operations_freight_provider_operation_capability_write`,
    )
    await assert.rejects(
      insertPreparedRlEmbeddedPickupTender(client, {
        organizationId: rlAuthorityOrganizationId,
        integrationId: rlAuthorityIntegrationId,
        pickupBinding: 'none',
      }),
      /independent ltl_bol/iu,
    )
    await client.query(
      `UPDATE operations_integration_accounts
       SET configuration = $2::jsonb
       WHERE id = $1`,
      [
        rlAuthorityIntegrationId,
        JSON.stringify({
          ...rlTenderOnlyConfiguration,
          allowedCapabilities: ['ltl_rate', 'ltl_tender', 'ltl_bol'],
        }),
      ],
    )
    await insertPreparedRlEmbeddedPickupTender(client, {
      organizationId: rlAuthorityOrganizationId,
      integrationId: rlAuthorityIntegrationId,
      pickupBinding: 'none',
    })
    await client.query(
      'ALTER TABLE operations_freight_tender_attempts DISABLE TRIGGER ALL',
    )
    await client.query(
      `ALTER TABLE operations_freight_tender_attempts
         ENABLE TRIGGER protect_operations_freight_tender_attempt_write`,
    )
    const rlSuccessId = await insertPreparedRlEmbeddedPickupTender(client)
    await client.query(
      `UPDATE operations_freight_tender_attempts
       SET state = 'succeeded', completed_at = now(),
           pro_number = 'PRO-100', pickup_request_id = 'PICKUP-100'
       WHERE id = $1`,
      [rlSuccessId],
    )
    const missingPickupId = await insertPreparedRlEmbeddedPickupTender(client)
    await assert.rejects(
      client.query(
        `UPDATE operations_freight_tender_attempts
         SET state = 'succeeded', completed_at = now(),
             pro_number = 'PRO-101'
         WHERE id = $1`,
        [missingPickupId],
      ),
      /operations_freight_tender_attempt_completion_valid/iu,
    )
    const missingProId = await insertPreparedRlEmbeddedPickupTender(client)
    await assert.rejects(
      client.query(
        `UPDATE operations_freight_tender_attempts
         SET state = 'succeeded', completed_at = now(),
             pickup_request_id = 'PICKUP-102'
         WHERE id = $1`,
        [missingProId],
      ),
      /operations_freight_tender_attempt_completion_valid/iu,
    )
    const wwexLtlSuccessId = await insertPreparedWwexLtlTender(client)
    await client.query(
      `UPDATE operations_freight_tender_attempts
       SET state = 'succeeded', completed_at = now(),
           provider_tender_reference = 'shipment-order-ltl-2001',
           pickup_order_reference = 'pickup-order-ltl-2001',
           pickup_transaction_reference = 'pickup-txn-ltl-2001',
           bol_number = 'WWE12502469'
       WHERE id = $1`,
      [wwexLtlSuccessId],
    )
    const wwexLtlSuccess = await client.query(
      `SELECT provider_tender_reference, pro_number, bol_number,
              pickup_order_reference, pickup_transaction_reference
       FROM operations_freight_tender_attempts WHERE id = $1`,
      [wwexLtlSuccessId],
    )
    assert.deepEqual(wwexLtlSuccess.rows[0], {
      provider_tender_reference: 'shipment-order-ltl-2001',
      pro_number: null,
      bol_number: 'WWE12502469',
      pickup_order_reference: 'pickup-order-ltl-2001',
      pickup_transaction_reference: 'pickup-txn-ltl-2001',
    })
    const wwexMissingPickupTransactionId = await insertPreparedWwexLtlTender(
      client,
    )
    await assert.rejects(
      client.query(
        `UPDATE operations_freight_tender_attempts
         SET state = 'succeeded', completed_at = now(),
             provider_tender_reference = 'shipment-order-ltl-2002',
             pickup_order_reference = 'pickup-order-ltl-2002'
         WHERE id = $1`,
        [wwexMissingPickupTransactionId],
      ),
      /operations_freight_tender_attempt_completion_valid/iu,
    )
    const proOnlyUnknownId = await insertPreparedRlEmbeddedPickupTender(client)
    await client.query(
      `UPDATE operations_freight_tender_attempts
       SET state = 'unknown', completed_at = now(),
           error_code = 'PARTIAL_PROVIDER_OUTCOME', pro_number = 'PRO-103'
       WHERE id = $1`,
      [proOnlyUnknownId],
    )
    const proOnlyUnknown = await client.query(
      `SELECT state, pro_number, pickup_request_id
       FROM operations_freight_tender_attempts WHERE id = $1`,
      [proOnlyUnknownId],
    )
    assert.deepEqual(proOnlyUnknown.rows[0], {
      state: 'unknown',
      pro_number: 'PRO-103',
      pickup_request_id: null,
    })
    const pickupOnlyUnknownId = await insertPreparedRlEmbeddedPickupTender(client)
    await client.query(
      `UPDATE operations_freight_tender_attempts
       SET state = 'unknown', completed_at = now(),
           error_code = 'PARTIAL_PROVIDER_OUTCOME',
           pickup_request_id = 'PICKUP-104'
       WHERE id = $1`,
      [pickupOnlyUnknownId],
    )
    const pickupOnlyUnknown = await client.query(
      `SELECT state, pro_number, pickup_request_id
       FROM operations_freight_tender_attempts WHERE id = $1`,
      [pickupOnlyUnknownId],
    )
    assert.deepEqual(pickupOnlyUnknown.rows[0], {
      state: 'unknown',
      pro_number: null,
      pickup_request_id: 'PICKUP-104',
    })
  } finally {
    client.release()
    await pool.end()
  }
}

async function runDatabaseContract() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-brokered-transport-${process.pid}-${randomUUID().slice(0, 8)}`
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_brokered_transport',
      '-e', 'POSTGRES_DB=clawpilot_brokered_transport',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      `postgresql://postgres:clawpilot_brokered_transport@127.0.0.1:${port}`
      + '/clawpilot_brokered_transport'
    )
    await waitForPostgres(databaseUrl)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
      timeout: 180_000,
    })
    await verifyDatabaseTransitions(databaseUrl)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

await runDatabaseContract()
console.log('Brokered transport foundation and PostgreSQL transition tests passed.')
