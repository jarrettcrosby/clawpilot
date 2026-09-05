import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'

import {
  IntegrationCredentialRuntimeGateError,
  isIntegrationCredentialRuntimeGateError,
} from './lib/integration-credential-runtime-test-double.mjs'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

async function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(await readFile(path, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Buffer,
    Error,
    Number,
    Object,
    Promise,
    RegExp,
    String,
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

const [
  migration,
  evidence,
  runtime,
  persistence,
  domain,
  route,
  ui,
  externalLabelMigration,
  externalLabelPersistence,
  externalLabelRoute,
  printDelivery,
  printRoute,
] = await Promise.all([
  readFile('db/migrations/0268_operations_shopify_external_fulfillment_reconciliation.sql', 'utf8'),
  readFile('app_src/lib/integrations/shopifyExternalFulfillmentEvidence.ts', 'utf8'),
  readFile('app_src/lib/integrations/shopifyExternalFulfillmentReconciliation.ts', 'utf8'),
  readFile('app_src/lib/persistence/operations.ts', 'utf8'),
  readFile('app_src/lib/operations/domain.ts', 'utf8'),
  readFile('app_src/app/api/operations/route.ts', 'utf8'),
  readFile('app_src/components/operations/OperationsSection.tsx', 'utf8'),
  readFile('db/migrations/0324_operations_external_fulfillment_label_artifacts.sql', 'utf8'),
  readFile('app_src/lib/persistence/operationExternalFulfillmentLabels.ts', 'utf8'),
  readFile('app_src/app/api/operations/external-label-artifacts/route.ts', 'utf8'),
  readFile('app_src/lib/persistence/operationPrintDelivery.ts', 'utf8'),
  readFile('app_src/app/api/operations/print-jobs/route.ts', 'utf8'),
])

assert.match(
  migration,
  /operations_shopify_external_fulfillment_reconciliations/,
)
assert.match(migration, /provider_write_count integer NOT NULL CHECK \(provider_write_count = 0\)/)
assert.match(migration, /rows are immutable/)
assert.match(
  migration,
  /operations_shopify_external_fulfillment_reconciliation_required/,
)
assert.match(migration, /operations_commerce_inventory_captures/)
assert.match(migration, /operations_fulfillment_allocations allocation/)

assert.match(evidence, /displayFulfillmentStatus !== 'FULFILLED'/)
assert.match(evidence, /order\.fulfillable !== false/)
assert.match(evidence, /exactFulfillment\.createdAt/)
assert.match(evidence, /SHOPIFY_EXTERNAL_FULFILLMENT_PREDATES_RELEASE/)
assert.match(evidence, /exact successful fulfillment/)
assert.match(evidence, /shopify-external-fulfillment-reconciliation-v2/)
assert.match(evidence, /tracking: Array/)

assert.match(runtime, /query ClawPilotExternalFulfillmentReconciliation/)
assert.match(runtime, /trackingInfo\(first: 11\) \{ company number url \}/)
assert.doesNotMatch(runtime, /\bmutation\b/)
assert.match(runtime, /providerWrites: 0/)

let runtimeGateChecks = 0
let runtimeGateFailureAt = null
let runtimeGateFailure = null
const providerCalls = []
const reconciliationRuntime = await loadTypeScriptModule(
  'app_src/lib/integrations/shopifyExternalFulfillmentReconciliation.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential() {
        throw runtimeGateFailure
      },
    },
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope() { return true },
    },
    '@/lib/integrations/integrationCredentialRuntimeGate.mjs': {
      assertIntegrationCredentialProviderIoReady() {
        runtimeGateChecks += 1
        if (runtimeGateChecks === runtimeGateFailureAt) {
          throw runtimeGateFailure
        }
        return { mode: 'test', status: 'verified', providerIoReady: true }
      },
      isIntegrationCredentialRuntimeGateError,
    },
    '@/lib/integrations/shopifyCommerceClient': {
      normalizeShopifyShopDomain(value) { return value },
      async probeShopifyConnection() {
        providerCalls.push('probe')
      },
      async requestShopifyAccessToken() {
        providerCalls.push('token')
      },
      async shopifyAdminGraphql() {
        providerCalls.push('order')
      },
      ShopifyCommerceClientError: class extends Error {},
    },
    '@/lib/integrations/shopifyExternalFulfillmentEvidence': {
      normalizeShopifyExternalFulfillmentEvidence() {
        throw new Error('normalization must not run during maintenance')
      },
      ShopifyExternalFulfillmentEvidenceError: class extends Error {},
    },
    '@/lib/persistence/commerceIntegrations': {
      async readCommerceRuntimeCredentialFromPostgres() {
        providerCalls.push('runtime')
        return {
          organizationId: '11111111-1111-4111-8111-111111111111',
          provider: 'shopify',
          environment: 'sandbox',
          externalAccountId: 'gid://shopify/Shop/1',
          status: 'active',
          verificationStatus: 'verified',
          configuration: { shopDomain: 'example.myshopify.com' },
          encrypted: {},
        }
      },
    },
  },
)

const runtimeOutage = new IntegrationCredentialRuntimeGateError(
  'INTEGRATION_CREDENTIAL_RUNTIME_PROOF_STALE',
)
runtimeGateFailure = runtimeOutage
runtimeGateFailureAt = 1
await assert.rejects(
  () => reconciliationRuntime.inspectShopifyExternalFulfillment({
    organizationId: '11111111-1111-4111-8111-111111111111',
    accountGlobalId: 'gia0000001',
    target: {},
  }),
  (error) => error === runtimeOutage,
)
assert.deepEqual(providerCalls, [])

runtimeGateChecks = 0
runtimeGateFailureAt = null
await assert.rejects(
  () => reconciliationRuntime.inspectShopifyExternalFulfillment({
    organizationId: '11111111-1111-4111-8111-111111111111',
    accountGlobalId: 'gia0000001',
    target: {},
  }),
  (error) => error === runtimeOutage,
  'credential-gate loss must not be relabeled as stored credential corruption',
)
assert.deepEqual(providerCalls, ['runtime'])

const commandStart = persistence.indexOf(
  'export async function reconcileShopifyExternalFulfillmentFromPostgres',
)
const commandEnd = persistence.indexOf(
  'export async function confirmOperationsOrderPicksFromPostgres',
  commandStart,
)
assert.ok(commandStart >= 0 && commandEnd > commandStart)
const command = persistence.slice(commandStart, commandEnd)
assert.match(command, /inspectShopifyExternalFulfillment/)
assert.match(command, /status = 'cancelled'/)
assert.match(command, /reservation_authority = 'provider_commitment'/)
assert.match(command, /status = 'released'/)
assert.match(command, /customerNotificationSent: false/)
assert.match(command, /providerWrites: 0/)
assert.doesNotMatch(command, /executeShopifyFulfillmentWriteback/)
assert.doesNotMatch(command, /INSERT INTO operations_shipments/)
assert.doesNotMatch(command, /INSERT INTO operations_commerce_fulfillment_exports/)

assert.match(
  persistence,
  /OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED/,
)
assert.match(domain, /reconcile_external_fulfillment/)
assert.match(route, /action === 'reconcile-external-fulfillment'/)
assert.match(
  route,
  /action === 'reconcile-external-fulfillment'[\s\S]*?!capabilities\.canManage \|\| !capabilities\.canExecute/,
)
assert.match(ui, /shopifyExternalFulfillmentReconciliationRequired/)
assert.match(ui, /does not write to Shopify/)
assert.match(ui, /sent no customer notification/)
assert.match(persistence, /externalFulfillmentTracking/)
assert.match(persistence, /provider_fulfillment_created_at/)
assert.match(ui, /order-external-fulfillment-evidence/)
assert.match(ui, /orderDisplayStatus/)
assert.match(ui, /Fulfilled externally/)
assert.match(ui, /order-derived-fulfillment-status/)
assert.match(persistence, /AS externally_fulfilled/)
assert.match(
  persistence,
  /providerFulfillmentStateResult\.rows\[0\]\?\.externally_fulfilled === true/,
)
assert.match(
  persistence,
  /#>> '\{order,canonicalStates,fulfillment\}' = 'fulfilled'/,
)
assert.match(persistence, /provider_read\.provider_write_count = 0/)
assert.match(ui, /Shopify did not supply tracking details/)
assert.match(ui, /ClawPilot will not buy replacement postage automatically/)
assert.match(externalLabelMigration, /clawpilot-external-label/)
assert.match(
  externalLabelMigration,
  /source_external_fulfillment_reconciliation_id/,
)
assert.match(externalLabelPersistence, /providerWrites: 0/)
assert.match(externalLabelPersistence, /postagePurchases: 0/)
assert.match(externalLabelPersistence, /validateExternalFulfillmentLabelBytes/)
assert.match(externalLabelPersistence, /immutable Shopify fulfillment evidence/)
assert.match(externalLabelRoute, /multipart\/form-data/)
assert.match(externalLabelRoute, /capabilities\.canManage/)
assert.match(externalLabelRoute, /capabilities\.canExecute/)
assert.match(printDelivery, /external_shipping_label_artifact/)
assert.match(printDelivery, /assertExternalLabelArtifactCanBeEnqueued/)
assert.match(printRoute, /enqueue-external-label-artifact/)
assert.match(ui, /Upload original label/)
assert.match(ui, /onPrintExternalLabel/)
assert.match(ui, /No postage was purchased and Shopify was not changed/)
assert.match(ui, /const bundledAgentCompatible = artifact\?\.format === 'ZPL'/)
assert.match(ui, /artifact && bundledAgentCompatible/)
assert.match(ui, /bundled print agent accepts ZPL labels only/)
assert.match(ui, /Download label/)

class OperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}
const externalLabelModule = await loadTypeScriptModule(
  'app_src/lib/persistence/operationExternalFulfillmentLabels.ts',
  {
    '@/lib/auditWriter': { async recordAuditEvent() {} },
    '@/lib/persistence/operations': { OperationsRequestError },
    '@/lib/persistence/postgres': {
      async acquireTransactionAdvisoryLock() {},
      async withTransaction() {
        throw new Error('Persistence is not used by payload validation tests')
      },
    },
  },
)
const validateLabel = externalLabelModule.validateExternalFulfillmentLabelBytes
assert.deepEqual(
  Buffer.from(validateLabel({ format: 'ZPL', payload: Buffer.from('^XA\n^XZ') })),
  Buffer.from('^XA\n^XZ'),
)
assert.deepEqual(
  Buffer.from(validateLabel({
    format: 'PDF',
    payload: Buffer.from('%PDF-1.7\n%%EOF\n'),
  })),
  Buffer.from('%PDF-1.7\n%%EOF\n'),
)
assert.doesNotThrow(() => validateLabel({
  format: 'PNG',
  payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
}))
assert.throws(
  () => validateLabel({ format: 'PDF', payload: Buffer.from('^XA^XZ') }),
  (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_PAYLOAD_INVALID',
)
assert.throws(
  () => validateLabel({
    format: 'ZPL',
    payload: Buffer.from('^XA\u0000^FO20,20^FDunsafe^FS^XZ'),
  }),
  (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_PAYLOAD_INVALID',
)
assert.throws(
  () => validateLabel({ format: 'PNG', payload: Buffer.from('%PDF-1.7\n%%EOF\n') }),
  (error) => error?.code === 'OPERATIONS_EXTERNAL_LABEL_PAYLOAD_INVALID',
)

console.log('Shopify external-fulfillment reconciliation contract checks passed')
