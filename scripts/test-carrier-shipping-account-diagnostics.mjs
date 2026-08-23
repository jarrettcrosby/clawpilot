#!/usr/bin/env node

import assert from 'node:assert/strict'
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

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks) {
  const source = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    Buffer,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

class MockOperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

class MockRateClientError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

let trustedRuntime = true
let productionRateExecutions = 0
const persistedRateEvidence = []

const runtime = {
  organizationId: '28600000-0000-4000-8000-000000000001',
  provider: 'ups_rest',
  environment: 'production',
  integrationAccountId: '28600000-0000-4000-8000-000000000010',
  integrationGlobalId: 'giah00000000010',
  carrierAccountId: '28600000-0000-4000-8000-000000000020',
  carrierAccountGlobalId: 'gach00000000020',
  carrierAccountDisplayName: 'UPS LIVE Bakery',
  senderName: 'Bakery Warehouse',
  credentialVersion: 7,
  credentialFingerprint: 'credential-v7',
  accountNumberFingerprint: 'a'.repeat(64),
  accountNumberLastFour: '1234',
  registeredAddressFingerprint: 'b'.repeat(64),
  registeredAddress: {
    line1: '100 Bakery Way',
    line2: null,
    city: 'Hartford',
    region: 'CT',
    postalCode: '06103',
    countryCode: 'US',
  },
  billingRelationship: 'sender',
  credential: {
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    accountNumber: 'mock-account',
  },
}

const diagnosticModule = loadTypeScriptModule(
  'app_src/lib/integrations/carrierShippingDiagnosticRate.ts',
  {
    '@/lib/integrations/carrierIntegrations': {
      carrierProductionLabelAuthorizationAllowed: () => trustedRuntime,
      resolveCarrierProductionRatingRuntime: async () => runtime,
      sanitizedCarrierIntegrationError(error) {
        return {
          code: error?.code || 'CARRIER_TEST_ERROR',
          message: error?.message || 'Carrier test error',
          status: error?.status || 500,
        }
      },
    },
    '@/lib/integrations/carrierWholeShipmentRateClient': {
      CarrierWholeShipmentRateClientError: MockRateClientError,
      async executeCarrierWholeShipmentRateRequest({ preparedRequest }) {
        productionRateExecutions += 1
        return {
          rates: [{
            serviceCode: '03',
            serviceName: 'UPS Ground',
            amount: '12.34',
            currency: 'USD',
            rateType: 'ACCOUNT',
            transitDays: 2,
            deliveryDate: null,
          }],
          evidence: {
            requestHash: preparedRequest.requestHash,
            redactedRequest: preparedRequest.redactedRequest,
            redactedResponse: { rates: [{ serviceCode: '03' }] },
            providerReference: 'mock-rate-reference',
            requestedAt: '2026-08-14T12:00:00.000Z',
            completedAt: '2026-08-14T12:00:01.000Z',
          },
        }
      },
    },
    '@/lib/integrations/carrierWholeShipmentRateFoundation': {
      prepareCarrierWholeShipmentRateRequest(input) {
        assert.equal(input.binding.environment, 'production')
        assert.equal(input.binding.carrierAccountId, runtime.carrierAccountId)
        assert.equal(input.billing.relationship, 'sender')
        assert.equal(input.parcels.length, 1)
        return {
          adapterVersion: 'mock-whole-shipment-v1',
          requestHash: 'c'.repeat(64),
          redactedRequest: {
            shipment: {
              destinationFingerprint: 'd'.repeat(64),
              packageCount: 1,
            },
          },
        }
      },
    },
    '@/lib/persistence/carrierIntegrations': {
      async writeCarrierProductionRateEvidenceInPostgres(input) {
        persistedRateEvidence.push(input)
        return 'grq0000286'
      },
    },
    '@/lib/persistence/operations': {
      OperationsRequestError: MockOperationsRequestError,
    },
  },
)

const input = {
  organizationId: runtime.organizationId,
  actorEmail: 'owner@example.com',
  provider: 'ups_rest',
  integrationAccountGlobalId: runtime.integrationGlobalId,
  carrierAccountGlobalId: runtime.carrierAccountGlobalId,
  destination: {
    name: 'Bakery Customer',
    line1: '200 Customer Road',
    line2: null,
    city: 'New Haven',
    region: 'CT',
    postalCode: '06510',
    countryCode: 'US',
    residential: true,
  },
  parcel: {
    description: 'Bakery assortment',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  },
}

const result = await diagnosticModule
  .testCarrierProductionShippingDiagnosticRate(input)
assert.equal(result.environment, 'production')
assert.equal(result.carrierAccountGlobalId, runtime.carrierAccountGlobalId)
assert.equal(result.evidenceGlobalId, 'grq0000286')
assert.equal(result.rates[0].amount, '12.34')
assert.equal(productionRateExecutions, 1)
assert.equal(persistedRateEvidence[0].purpose, 'shipping_account_diagnostic')
assert.equal(
  persistedRateEvidence[0].carrierAccountGlobalId,
  runtime.carrierAccountGlobalId,
)
assert.equal(persistedRateEvidence[0].credentialVersion, 7)

trustedRuntime = false
await assert.rejects(
  diagnosticModule.testCarrierProductionShippingDiagnosticRate(input),
  (error) => error.code === 'CARRIER_PRODUCTION_LABEL_ENVIRONMENT_FORBIDDEN',
)
assert.equal(
  productionRateExecutions,
  1,
  'Untrusted runtimes must fail before the mocked provider rate adapter',
)

const migration = read(
  'db/migrations/0286_carrier_shipping_account_diagnostics.sql',
)
for (const fragment of [
  "purpose IN (\n      'sandbox_rate_test',\n      'shipping_account_diagnostic'",
  "environment IN ('sandbox', 'production')",
  'validate_operations_carrier_shipping_diagnostic_lineage()',
  'operations_carrier_rate_test_attempts_health_recent_idx',
  "diagnostic_row->>'action' = 'create'",
  "NEW.environment = 'production'",
  "? 'production_rate'",
  "? 'production_label'",
  "activation.state = 'active'",
]) {
  assert.ok(migration.includes(fragment), `0286 migration missing ${fragment}`)
}

const actions = read(
  'app_src/lib/integrations/carrierRateTestLabelActions.ts',
)
for (const fragment of [
  'BUY REAL POSTAGE',
  'assertFreshProductionRate',
  'resolveCarrierProductionShippingRuntime',
  'productionLivePostageAuthorized',
  'Live-postage permission is required to buy REAL POSTAGE',
  'prepareCarrierRateTestLabelCreateInPostgres',
  'executeCarrierOneOffGroupShipment',
  "state: 'unknown'",
  'resolveCarrierOneOffVoidRuntime',
  'executeCarrierOneOffGroupVoid',
  'LIVE production postage can only be retired by a true provider void',
]) {
  assert.ok(actions.includes(fragment), `Diagnostic action missing ${fragment}`)
}
const productionCreate = actions.slice(
  actions.indexOf('async function createCarrierProductionDiagnosticLabel'),
  actions.indexOf('export async function createCarrierRateTestLabel'),
)
assert.ok(
  productionCreate.indexOf('await prepareCarrierRateTestLabelCreateInPostgres')
    < productionCreate.indexOf('await executeCarrierOneOffGroupShipment'),
  'The durable production attempt must precede the provider Ship call',
)

const route = read('app_src/app/api/integrations/carriers/route.ts')
for (const fragment of [
  "action === 'test-shipping-diagnostic-rate'",
  'integrationAccountGlobalId',
  'carrierAccountGlobalId',
  'destinationResidential',
  'diagnosticParcelInput',
  'productionAuthorizedByOwnerAdmin: canRevealCredential(actor)',
  'productionLivePostageAuthorized:',
  'shippingCapabilities(actor).canPurchaseLivePostage',
  "plainText(body.operatorConfirmation, 'REAL POSTAGE confirmation'",
  'requireExecutor(actor)',
]) {
  assert.ok(route.includes(fragment), `Carrier route missing ${fragment}`)
}
assert.ok(
  !read('app_src/lib/integrations/carrierShippingDiagnosticRate.ts')
    .includes('operations_activation_scopes'),
  'LIVE read-only rating must not require the global Operations activation profile',
)
assert.ok(
  !actions.includes('requireProductionShippingDiagnosticActive'),
  'LIVE label purchase must use exact carrier authority instead of global Operations Active',
)

const panel = read('app_src/components/settings/CarrierIntegrationPanel.tsx')
for (const fragment of [
  'LIVE production shipping account diagnostic',
  'LIVE production billing account',
  "const diagnosticCarrierAccounts = environment === 'production'",
  'Get {environment === \'production\' ? \'LIVE production\' : \'sandbox\'} rates',
  'Type the exact REAL POSTAGE confirmation',
  'Buy and store LIVE production label',
  'Print stored {environment === \'production\' ? \'LIVE label\' : \'test label\'}',
  'Void exact LIVE production label now',
  'label.carrierAccountGlobalId',
  'canPurchaseLivePostage',
]) {
  assert.ok(panel.includes(fragment), `Carrier diagnostic UI missing ${fragment}`)
}

const health = read('app_src/app/api/health/route.ts')
for (const fragment of [
  '0286_carrier_shipping_account_diagnostics.sql',
  'carrier_shipping_diagnostics_applied',
  'validate_operations_carrier_shipping_diagnostic_lineage()',
  'validate_operations_carrier_shipping_diagnostic_label',
  'validate_operations_carrier_shipping_diagnostic_attempt',
  'carrier_shipping_diagnostic_attempt_counts',
  'stalePrepared',
  'unknown provider outcomes requiring manual review; do not retry',
  'operations_shopify_carrier_service_config_carriers_pkey',
  'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
  'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)',
  'validate_operations_fulfillment_account_lineage_complete()',
]) {
  assert.ok(health.includes(fragment), `Carrier health missing ${fragment}`)
}
assert.ok(
  (health.match(/row\?\.carrier_shipping_diagnostics_applied/g) || [])
    .length >= 3,
  '0286 structure must gate migrationsCurrent, database detail, and health errors',
)

console.log('Carrier shipping-account diagnostic contracts passed.')
