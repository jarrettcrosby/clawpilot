#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

function loadTypeScriptModule(path, mocks) {
  const source = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
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

class MockOneOffGroupError extends Error {
  constructor(message, status, code, uncertain = false, redactedResponse = {}) {
    super(message)
    this.status = status
    this.code = code
    this.uncertain = uncertain
    this.redactedResponse = redactedResponse
  }
}

class MockSandboxLabelError extends Error {
  constructor(message, status, code, uncertain = false, redactedResponse = {}) {
    super(message)
    this.status = status
    this.code = code
    this.uncertain = uncertain
    this.redactedResponse = redactedResponse
  }
}

const events = []
let productionActiveChecks = 0
const organizationId = '28600000-0000-4000-8000-000000000001'
const integrationAccountId = '28600000-0000-4000-8000-000000000010'
const carrierAccountId = '28600000-0000-4000-8000-000000000020'
const rateHash = 'a'.repeat(64)
const destinationHash = 'b'.repeat(64)
const accountNumberFingerprint = 'c'.repeat(64)
const labelBytes = Buffer.from('^XA^FO30,30^FDLIVE DIAGNOSTIC^FS^XZ', 'utf8')
const labelHash = createHash('sha256').update(labelBytes).digest('hex')

const runtime = {
  organizationId,
  integrationAccountId,
  integrationGlobalId: 'giah00000000010',
  credentialVersion: 7,
  credentialFingerprint: 'd'.repeat(64),
  provider: 'ups_rest',
  environment: 'production',
  credential: {
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    accountNumber: 'mock-account',
  },
  carrierAccountId,
  carrierAccountGlobalId: 'gach00000000020',
  carrierAccountDisplayName: 'UPS LIVE Bakery',
  senderName: 'Bakery Warehouse',
  registeredAddress: {
    line1: '100 Bakery Way',
    line2: null,
    city: 'Hartford',
    region: 'CT',
    postalCode: '06103',
    countryCode: 'US',
  },
  registeredAddressFingerprint: 'e'.repeat(64),
  accountNumberLastFour: '1234',
  accountNumberFingerprint,
  billingRelationship: 'sender',
  billingSelectionSnapshot: {
    mode: 'original_one_off_shipment_account',
    carrierAccountGlobalId: 'gach00000000020',
    registeredAddressFingerprint: 'e'.repeat(64),
  },
}

const selectedRate = {
  serviceCode: '03',
  serviceName: 'UPS Ground',
  rateType: 'NEGOTIATED',
  amount: '12.34',
  currency: 'USD',
}
const context = {
  rateRequestId: '28600000-0000-4000-8000-000000000040',
  rateEvidenceGlobalId: 'grq2860001',
  integrationAccountId,
  integrationGlobalId: runtime.integrationGlobalId,
  carrierAccountId,
  carrierAccountGlobalId: runtime.carrierAccountGlobalId,
  provider: 'ups_rest',
  environment: 'production',
  purpose: 'shipping_account_diagnostic',
  credentialVersion: runtime.credentialVersion,
  requestHash: rateHash,
  billingRelationship: 'sender',
  billingSelectionSnapshot: {
    mode: 'explicit_shipping_account_diagnostic',
    integrationAccountGlobalId: runtime.integrationGlobalId,
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    accountNumberFingerprint: runtime.accountNumberFingerprint,
    credentialFingerprint: runtime.credentialFingerprint,
    registeredAddressFingerprint: runtime.registeredAddressFingerprint,
    senderName: runtime.senderName,
  },
  redactedRequest: {
    shipment: { destinationFingerprint: destinationHash },
  },
  redactedResponse: { rates: [selectedRate] },
  completedAt: new Date().toISOString(),
}

const sandboxRuntime = {
  ...runtime,
  environment: 'sandbox',
  credentialVersion: 8,
  billingSelectionSnapshot: {
    selectionMode: 'explicit',
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    registeredAddressFingerprint: runtime.registeredAddressFingerprint,
    senderName: runtime.senderName,
    registeredAddress: runtime.registeredAddress,
  },
}
const sandboxContext = {
  ...context,
  environment: 'sandbox',
  purpose: 'sandbox_rate_test',
  credentialVersion: 8,
  requestHash: 'sandbox-selection',
  billingSelectionSnapshot: {
    selectionMode: 'explicit',
    carrierAccountGlobalId: runtime.carrierAccountGlobalId,
    registeredAddressFingerprint: runtime.registeredAddressFingerprint,
  },
  redactedRequest: {
    shipment: {
      originFingerprint: 'f'.repeat(64),
      destinationFingerprint: destinationHash,
    },
  },
}
let currentRateContext = context
let sandboxCreateImplementation = async () => {
  throw new Error('Sandbox label adapter must not execute')
}
let sandboxVoidImplementation = async () => {
  throw new Error('Sandbox void adapter must not execute')
}
let finalizedFailureInput = null

const storedLabel = {
  labelId: '28600000-0000-4000-8000-000000000060',
  labelGlobalId: 'gsl2860001',
  rateRequestId: context.rateRequestId,
  rateEvidenceGlobalId: context.rateEvidenceGlobalId,
  integrationAccountId,
  integrationGlobalId: runtime.integrationGlobalId,
  carrierAccountId,
  carrierAccountGlobalId: runtime.carrierAccountGlobalId,
  provider: 'ups_rest',
  environment: 'production',
  credentialVersion: runtime.credentialVersion,
  accountNumberFingerprint,
  rateRequestHash: rateHash,
  destinationFingerprint: destinationHash,
  serviceCode: selectedRate.serviceCode,
  serviceName: selectedRate.serviceName,
  rateType: selectedRate.rateType,
  ratedAmount: selectedRate.amount,
  ratedCurrency: selectedRate.currency,
  providerLabelId: 'provider-shipment-1',
  trackingNumber: '1ZMOCKTRACKING',
  status: 'created',
}
let currentStoredLabel = storedLabel
let preparedVoidInput = null

const actions = loadTypeScriptModule(
  'app_src/lib/integrations/carrierRateTestLabelActions.ts',
  {
    '@/lib/integrations/carrierIntegrations': {
      async resolveCarrierProductionShippingRuntime() {
        events.push('resolve-create-runtime')
        return runtime
      },
      async resolveCarrierOneOffVoidRuntime() {
        events.push('resolve-void-runtime')
        return runtime
      },
      resolveCarrierSandboxShippingRuntime: async () => sandboxRuntime,
      assertCarrierRateTestArtifactCapability: async () => undefined,
      carrierSandboxRateSelectionRequestHash: () => 'sandbox-selection',
      sanitizedCarrierIntegrationError(error) {
        return {
          code: error?.code || 'CARRIER_TEST_ERROR',
          message: error?.message || 'Carrier test error',
          status: error?.status || 500,
        }
      },
    },
    '@/lib/integrations/carrierSandboxLabel': {
      CARRIER_SANDBOX_LABEL_ADAPTER_VERSION: 'sandbox-label-v1',
      CarrierSandboxLabelError: MockSandboxLabelError,
      carrierSandboxLabelLifecycleMode: () => 'carrier_void',
      createCarrierSandboxLabel: (...args) => sandboxCreateImplementation(...args),
      voidCarrierSandboxLabel: (...args) => sandboxVoidImplementation(...args),
    },
    '@/lib/integrations/carrierOneOffGroupShipment': {
      CARRIER_ONE_OFF_GROUP_ADAPTER_VERSION: 'carrier-one-off-group-v1',
      CarrierOneOffGroupError: MockOneOffGroupError,
      prepareCarrierOneOffGroupRequest() {
        events.push('prepare-provider-create')
        return {
          requestHash: 'f'.repeat(64),
          redactedRequest: { action: 'ship', environment: 'production' },
        }
      },
      async executeCarrierOneOffGroupShipment() {
        events.push('execute-provider-create')
        return {
          provider: 'ups_rest',
          environment: 'production',
          providerShipmentId: storedLabel.providerLabelId,
          masterTrackingNumber: storedLabel.trackingNumber,
          lifecycleMode: 'carrier_void',
          labels: [{
            trackingNumber: storedLabel.trackingNumber,
            format: 'ZPL',
            labelPayload: labelBytes.toString('utf8'),
            payloadEncoding: 'utf8',
            labelByteLength: labelBytes.length,
            labelContentSha256: labelHash,
            providerImageType: 'ZPL',
            providerStockType: 'HEIGHT_6_WIDTH_4',
          }],
          quotedCharge: {
            amountMinor: 1234,
            currency: 'USD',
            rateType: 'negotiated',
          },
          evidence: {
            providerReference: storedLabel.providerLabelId,
            redactedRequest: { action: 'ship' },
            redactedResponse: { shipment: storedLabel.providerLabelId },
          },
        }
      },
      prepareCarrierOneOffGroupVoidRequest() {
        events.push('prepare-provider-void')
        return {
          requestHash: '1'.repeat(64),
          redactedRequest: { action: 'void', environment: 'production' },
        }
      },
      async executeCarrierOneOffGroupVoid() {
        events.push('execute-provider-void')
        return {
          evidence: {
            providerReference: storedLabel.providerLabelId,
            redactedResponse: { voided: true },
          },
        }
      },
    },
    '@/lib/integrations/carrierWholeShipmentRateFoundation': {
      prepareCarrierWholeShipmentRateRequest() {
        events.push('rebuild-rate-request')
        return { requestHash: rateHash }
      },
      carrierWholeShipmentRateAddressFingerprints() {
        return { destinationFingerprint: destinationHash }
      },
    },
    '@/lib/integrations/carrierShippingDiagnosticRate': {
      async requireProductionShippingDiagnosticActive() {
        productionActiveChecks += 1
        events.push('require-active')
      },
    },
    '@/lib/integrations/carrierSandboxRate': {
      buildCarrierSandboxRateFixture: () => ({ shipment: 'fixture' }),
      carrierSandboxPartyFingerprint: () => destinationHash,
      carrierSandboxRateRequestEvidence: () => ({
        requestHash: rateHash,
        redactedRequest: {
          shipment: {
            originFingerprint: 'f'.repeat(64),
            destinationFingerprint: destinationHash,
          },
        },
      }),
      normalizeCarrierSandboxParty: (value) => value,
    },
    '@/lib/persistence/carrierRateTestLabels': {
      carrierRateTestLabelFingerprint: () => '2'.repeat(64),
      async readCarrierRateTestCreateContextInPostgres() {
        events.push('read-rate-evidence')
        return currentRateContext
      },
      async prepareCarrierRateTestLabelCreateInPostgres(input) {
        events.push('persist-create-attempt')
        if (input.environment === 'production') {
          assert.equal(input.operatorConfirmation.includes('REAL POSTAGE'), true)
        }
        return { disposition: 'prepared', attemptGlobalId: 'gsa2860001' }
      },
      async finalizeCarrierRateTestLabelCreateInPostgres(input) {
        events.push('finalize-create')
        assert.equal(input.contentSha256, labelHash)
        assert.deepEqual(Buffer.from(input.labelPayload), labelBytes)
        return storedLabel
      },
      async readCarrierRateTestLabelProviderContextInPostgres() {
        events.push('read-label')
        return currentStoredLabel
      },
      async replayCarrierRateTestLabelVoidInPostgres() {
        return null
      },
      async prepareCarrierRateTestLabelVoidInPostgres(input) {
        events.push('persist-void-attempt')
        preparedVoidInput = input
        return { disposition: 'prepared', attemptGlobalId: 'gsa2860002' }
      },
      async finalizeCarrierRateTestLabelVoidInPostgres() {
        events.push('finalize-void')
        return { ...currentStoredLabel, status: 'voided' }
      },
      finalizeCarrierRateTestLabelAttemptFailureInPostgres: async (input) => {
        events.push('finalize-failure')
        finalizedFailureInput = input
      },
      closeCarrierRateTestSampleLabelInPostgres: async () => undefined,
      listCarrierRateTestLabelAttemptsInPostgres: async () => [],
      listCarrierRateTestLabelsInPostgres: async () => [],
      queueCarrierRateTestLabelPrintInPostgres: async () => undefined,
      reconcileCarrierRateTestLabelAttemptInPostgres: async () => undefined,
    },
    '@/lib/persistence/operations': {
      OperationsRequestError: MockOperationsRequestError,
    },
  },
)

const confirmation = actions.carrierProductionDiagnosticConfirmation({
  provider: 'ups_rest',
  carrierAccountGlobalId: runtime.carrierAccountGlobalId,
  selectedRate,
})
assert.equal(
  confirmation,
  'BUY REAL POSTAGE | UPS | gach00000000020 | 03 | USD 12.34',
)

const destination = {
  name: 'Bakery Customer',
  line1: '200 Customer Road',
  line2: null,
  city: 'New Haven',
  region: 'CT',
  postalCode: '06510',
  countryCode: 'US',
}
const parcel = {
  description: 'Bakery assortment',
  length: 12,
  width: 10,
  height: 6,
  dimensionUnit: 'IN',
  weight: 5,
  weightUnit: 'LB',
}

const created = await actions.createCarrierRateTestLabel({
  organizationId,
  actorEmail: 'owner@example.com',
  rateEvidenceGlobalId: context.rateEvidenceGlobalId,
  selectedRate,
  destination,
  destinationResidential: true,
  parcel,
  shipFromPhone: '8605550100',
  shipToPhone: '2035550100',
  operatorConfirmation: confirmation,
  productionAuthorizedByOwnerAdmin: true,
  outputFormat: 'ZPL',
  reason: 'Verify live production account then void',
  idempotencyKey: 'diagnostic-create-0001',
})
assert.equal(created.labelGlobalId, storedLabel.labelGlobalId)
assert.ok(
  events.indexOf('persist-create-attempt')
    < events.indexOf('execute-provider-create'),
  'The durable create attempt must precede the mocked provider adapter',
)
assert.equal(
  productionActiveChecks,
  2,
  'Production create must recheck Active before and after durable preparation',
)

const activeChecksBeforeVoid = productionActiveChecks
const voided = await actions.voidCarrierRateTestLabel({
  organizationId,
  actorEmail: 'owner@example.com',
  labelGlobalId: storedLabel.labelGlobalId,
  reason: 'Immediate provider void after production test',
  idempotencyKey: 'diagnostic-void-0001',
})
assert.equal(voided.status, 'voided')
assert.ok(
  events.indexOf('persist-void-attempt')
    < events.indexOf('execute-provider-void'),
  'The durable void attempt must precede the mocked provider adapter',
)
assert.equal(
  productionActiveChecks,
  activeChecksBeforeVoid,
  'Production void must not recheck Operations Active or purchase capability',
)

await assert.rejects(
  actions.closeCarrierRateTestSampleLabel({
    organizationId,
    actorEmail: 'owner@example.com',
    labelGlobalId: storedLabel.labelGlobalId,
    reason: 'Must be rejected',
    idempotencyKey: 'diagnostic-close-0001',
  }),
  (error) => error.code === 'CARRIER_RATE_TEST_SAMPLE_CLOSE_UNAVAILABLE',
)

currentStoredLabel = {
  ...storedLabel,
  environment: 'sandbox',
  credentialVersion: 7,
}
sandboxVoidImplementation = async (input) => {
  assert.equal(
    input.credentialVersion,
    8,
    'Sandbox void must execute with the currently verified rotated credential',
  )
  return {
    evidence: {
      providerReference: 'sandbox-void-reference',
      redactedResponse: { voided: true },
    },
  }
}
const sandboxVoidedAfterRotation = await actions.voidCarrierRateTestLabel({
  organizationId,
  actorEmail: 'owner@example.com',
  labelGlobalId: currentStoredLabel.labelGlobalId,
  reason: 'Void sandbox label after verified credential rotation',
  idempotencyKey: 'sandbox-rotated-void-0001',
})
assert.equal(sandboxVoidedAfterRotation.status, 'voided')
assert.equal(preparedVoidInput.label.credentialVersion, 7)
assert.equal(
  preparedVoidInput.credentialVersion,
  8,
  'The durable sandbox void attempt must record the exact current credential generation',
)

currentRateContext = sandboxContext
sandboxCreateImplementation = async () => {
  throw new MockSandboxLabelError(
    'The carrier sandbox label request ended with an uncertain result',
    503,
    'CARRIER_PROVIDER_RESULT_UNKNOWN',
    true,
    {
      clientTransactionId: 'a'.repeat(32),
      operationStage: 'provider_response_read',
      providerRequestDispatchAttempted: true,
      providerResponseReceived: true,
      httpStatus: 200,
      exceptionName: 'TypeError',
      exceptionCode: 'UND_ERR_SOCKET',
    },
  )
}
await assert.rejects(
  actions.createCarrierRateTestLabel({
    organizationId,
    actorEmail: 'owner@example.com',
    rateEvidenceGlobalId: sandboxContext.rateEvidenceGlobalId,
    selectedRate,
    destination,
    outputFormat: 'ZPL',
    reason: 'Hermetic body-stream failure',
    idempotencyKey: 'sandbox-unknown-0001',
  }),
  (error) => error.code === 'CARRIER_PROVIDER_RESULT_UNKNOWN',
)
assert.equal(finalizedFailureInput.state, 'unknown')
assert.equal(finalizedFailureInput.errorCode, 'CARRIER_PROVIDER_RESULT_UNKNOWN')
assert.deepEqual(
  finalizedFailureInput.redactedResponse,
  {
    clientTransactionId: 'a'.repeat(32),
    operationStage: 'provider_response_read',
    providerRequestDispatchAttempted: true,
    providerResponseReceived: true,
    httpStatus: 200,
    exceptionName: 'TypeError',
    exceptionCode: 'UND_ERR_SOCKET',
  },
  'An unknown adapter result must be durably finalized with only safe stage and correlation evidence',
)

console.log('Carrier shipping diagnostic provider-action contracts passed.')
