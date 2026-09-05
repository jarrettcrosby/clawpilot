#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const commerceStorageMaintenanceTrace = []

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
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
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    ...globals,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      if (specifier === '@/lib/integrations/commerceReadRuntime') {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceReadRuntime.ts',
        )
      }
      if (specifier === '@/lib/operations/commerceStoreSync') {
        return loadTypeScriptModule(
          'app_src/lib/operations/commerceStoreSync.ts',
        )
      }
      if (specifier === '@/lib/persistence/commerceIntake') {
        return {
          async markAutomaticFaireOrderPromotionAttentionInPostgres() {
            return { marked: true }
          },
          async readAutomaticFaireExactRefreshTargetsInPostgres() {
            return []
          },
        }
      }
      if (specifier === '@/lib/persistence/commerceOrderRevisions') {
        return {
          async purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres() {
            return {
              schemaAvailable: false,
              skipped: true,
              limit: 250,
              purged: 0,
              expiredProtectedReadBacklog: null,
              backlogTruncated: false,
            }
          },
        }
      }
      if (specifier === '@/lib/persistence/commerceStorageMaintenance') {
        return {
          async maintainCommerceStorageInPostgres(input) {
            commerceStorageMaintenanceTrace.push(input)
            return {
              schemaAvailable: true,
              executed: false,
              status: 'not_due',
              errorCode: null,
              intakePayloads: { rows: 0, bytes: 0 },
              legacyInventoryCaptures: { rows: 0, bytes: 0 },
              inventorySnapshotPayloads: { rows: 0, bytes: 0 },
              inventoryObservationAliases: { rows: 0, bytes: 0 },
              inventoryLevels: { rows: 0, bytes: 0 },
            }
          },
          commerceStorageMaintenanceFailureResult(error) {
            return {
              schemaAvailable: false,
              executed: false,
              status: 'failed',
              errorCode: error?.code || 'COMMERCE_STORAGE_MAINTENANCE_FAILED',
              intakePayloads: { rows: 0, bytes: 0 },
              legacyInventoryCaptures: { rows: 0, bytes: 0 },
              inventorySnapshotPayloads: { rows: 0, bytes: 0 },
              inventoryObservationAliases: { rows: 0, bytes: 0 },
              inventoryLevels: { rows: 0, bytes: 0 },
            }
          },
        }
      }
      if (specifier === '@/lib/integrations/commerceIntegrations') {
        return {
          CommerceIntegrationRequestError: class CommerceIntegrationRequestError extends Error {
            constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
              super(message)
              this.status = status
              this.code = code
            }
          },
        }
      }
      if (
        specifier
        === '@/lib/integrations/commerceFaireAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
        )
      }
      if (
        specifier
        === '@/lib/integrations/commerceShopifyAutomaticPromotion'
      ) {
        return loadTypeScriptModule(
          'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
        )
      }
      if (specifier === '@/lib/commerceShopifyOrderRevisionWorker') {
        return {
          async processShopifyOrderRevisions() {
            return {
              provider: 'shopify',
              claimed: 0,
              captured: 0,
              changed: 0,
              failed: 0,
              failureCodes: {},
              providerWrites: 0,
              canonicalOrderWrites: 0,
              managerDispositionRequired: 0,
            }
          },
        }
      }
      if (specifier === '@/lib/commerceFaireOrderRevisionWorker') {
        return {
          async processFaireOrderRevisions() {
            return {
              provider: 'faire',
              claimed: 0,
              captured: 0,
              changed: 0,
              failed: 0,
              failureCodes: {},
              providerReadsPerCapture: 2,
              providerWrites: 0,
              canonicalOrderWrites: 0,
              managerDispositionRequired: 0,
            }
          },
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const persistence = read('app_src/lib/persistence/commerceOrderReconciliation.ts')
const fairePromotionPolicy = loadTypeScriptModule(
  'app_src/lib/integrations/commerceFaireAutomaticPromotion.ts',
)
assert.equal(
  fairePromotionPolicy.AUTOMATIC_FAIRE_LEGACY_UNATTRIBUTED_ATTENTION_MARKER,
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
)
assert.equal(
  fairePromotionPolicy.AUTOMATIC_FAIRE_ORDER_PROMOTION_ATTENTION_MARKER,
  'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED',
)
const shopifyPromotionPolicy = loadTypeScriptModule(
  'app_src/lib/integrations/commerceShopifyAutomaticPromotion.ts',
)
const shopifyCohortEnv =
  shopifyPromotionPolicy.SHOPIFY_AUTOMATIC_ORDER_PROMOTION_COHORT_ENV
const enabledShopifyAccount = 'gia0009201'
const secondShopifyAccount = 'gia0bcdefghjkmn'
const cohortOff = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: enabledShopifyAccount,
    environment: { CLAWPILOT_ENV: 'development' },
  })
assert.equal(cohortOff.accountEnabled, false)
assert.equal(cohortOff.disabledReason, 'account_cohort_not_configured')
const nonDevelopment = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: enabledShopifyAccount,
    environment: {
      CLAWPILOT_ENV: 'production',
      [shopifyCohortEnv]: enabledShopifyAccount,
    },
  })
assert.equal(nonDevelopment.accountEnabled, false)
assert.equal(nonDevelopment.disabledReason, 'development_runtime_required')
const contradictoryHostedProduction = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: enabledShopifyAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      RAILWAY_ENVIRONMENT_NAME: 'production',
      VERCEL_ENV: 'preview',
      [shopifyCohortEnv]: enabledShopifyAccount,
    },
  })
assert.equal(contradictoryHostedProduction.accountEnabled, false)
assert.equal(
  contradictoryHostedProduction.disabledReason,
  'hosted_production_runtime',
)
const malformedCohort = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionCohort({
    CLAWPILOT_ENV: 'development',
    [shopifyCohortEnv]: `${enabledShopifyAccount},not-an-account`,
  })
assert.equal(malformedCohort.valid, false)
assert.deepEqual([...malformedCohort.accountGlobalIds], [])
const duplicateCohort = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionCohort({
    CLAWPILOT_ENV: 'development',
    [shopifyCohortEnv]: `${enabledShopifyAccount},${enabledShopifyAccount}`,
  })
assert.equal(duplicateCohort.valid, false)
const exactCohortEnvironment = {
  CLAWPILOT_ENV: 'development',
  [shopifyCohortEnv]: `${secondShopifyAccount},${enabledShopifyAccount}`,
}
const accountMismatch = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: 'gia0009202',
    environment: exactCohortEnvironment,
  })
assert.equal(accountMismatch.accountEnabled, false)
assert.equal(accountMismatch.disabledReason, 'account_not_in_cohort')
const exactCohort = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: enabledShopifyAccount,
    environment: exactCohortEnvironment,
  })
assert.equal(exactCohort.accountEnabled, true)
assert.equal(exactCohort.cohortSize, 2)
assert.match(exactCohort.cohortHash, /^[a-f0-9]{64}$/u)
assert.deepEqual(
  [...exactCohort.accountGlobalIds],
  [enabledShopifyAccount, secondShopifyAccount].sort(),
)
const legacyOneAccountShopifyGate = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGate({
    accountGlobalId: enabledShopifyAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      [shopifyCohortEnv]: enabledShopifyAccount,
    },
  })
assert.equal(legacyOneAccountShopifyGate.accountEnabled, true)
assert.match(legacyOneAccountShopifyGate.cohortHash, /^[a-f0-9]{64}$/u)
const validDevelopmentShopifyHealth = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionGateHealth({
    CLAWPILOT_ENV: 'development',
    [shopifyCohortEnv]: enabledShopifyAccount,
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(validDevelopmentShopifyHealth)),
  {
    policyVersion: 'commerce-shopify-order-auto-promotion-v1',
    enabled: true,
    runtimeEligible: true,
    cohortConfigured: true,
    cohortValid: true,
    cohortSize: 1,
    disabledReason: null,
  },
)
assert.equal(
  Object.prototype.hasOwnProperty.call(
    validDevelopmentShopifyHealth,
    'cohortHash',
  ),
  false,
)
assert.equal(
  JSON.stringify(validDevelopmentShopifyHealth).includes(
    legacyOneAccountShopifyGate.cohortHash,
  ),
  false,
  'A legacy one-account Shopify cohort fingerprint must not be public',
)
const sanitizedShopifyHealth = shopifyPromotionPolicy
  .shopifyAutomaticOrderPromotionHealthSnapshot({
    environment: {
      CLAWPILOT_ENV: 'development',
      [shopifyCohortEnv]: enabledShopifyAccount,
    },
    heartbeat: {
      policyVersion: 'untrusted-old-policy',
      cohortHash: legacyOneAccountShopifyGate.cohortHash,
      accountGlobalIds: [enabledShopifyAccount],
      rawCohortConfiguration: enabledShopifyAccount,
      providerToken: 'must-not-leak',
      promoted: 2_000_000,
      held: 4,
      actionableHeld: 999,
      heldByReason: {
        checkout_rate_lineage_missing: 2,
        GIA0009201: 1,
        SECRETVALUE123: 1,
        ...Object.fromEntries(Array.from(
          { length: 1_000 },
          (_, index) => [`MALICIOUS_HOLD_${index}`, index + 1],
        )),
      },
      failed: 3,
      failedByCode: {
        COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED: 1,
        GIA0009201: 1,
        PROVIDER_TOKEN_SUPERSECRET: 1,
        ...Object.fromEntries(Array.from(
          { length: 1_000 },
          (_, index) => [`MALICIOUS_FAILURE_${index}`, index + 1],
        )),
      },
      rollbackFenced: 9,
      attentionRequiredAccounts: 2,
      operatorReviewRequired: 0,
      providerWrites: 0,
      canonicalOrderWrites: 2,
      inventoryWrites: 0,
      syncCursorAdvanced: false,
    },
  })
assert.equal(
  sanitizedShopifyHealth.policyVersion,
  validDevelopmentShopifyHealth.policyVersion,
)
assert.equal(sanitizedShopifyHealth.promoted, 1_000_000)
assert.equal(sanitizedShopifyHealth.actionableHeld, 4)
assert.deepEqual(
  JSON.parse(JSON.stringify(sanitizedShopifyHealth.heldByReason)),
  { checkout_rate_lineage_missing: 2, OTHER: 2 },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(sanitizedShopifyHealth.failedByCode)),
  {
    COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED: 1,
    OTHER: 2,
  },
)
assert.equal(sanitizedShopifyHealth.rollbackFenced, 3)
assert.equal(sanitizedShopifyHealth.operatorReviewRequired, 7)
assert.equal(
  Object.values(sanitizedShopifyHealth.heldByReason)
    .reduce((sum, count) => sum + count, 0),
  sanitizedShopifyHealth.held,
)
assert.equal(
  Object.values(sanitizedShopifyHealth.failedByCode)
    .reduce((sum, count) => sum + count, 0),
  sanitizedShopifyHealth.failed,
)
const serializedShopifyHealth = JSON.stringify(sanitizedShopifyHealth)
for (const sensitiveValue of [
  enabledShopifyAccount,
  legacyOneAccountShopifyGate.cohortHash,
  'must-not-leak',
  'GIA0009201',
  'SECRETVALUE123',
  'PROVIDER_TOKEN_SUPERSECRET',
  'MALICIOUS_HOLD_',
  'MALICIOUS_FAILURE_',
]) {
  assert.equal(
    serializedShopifyHealth.includes(sensitiveValue),
    false,
    `Shopify public health must not echo ${sensitiveValue}`,
  )
}
const faireCohortEnv = fairePromotionPolicy
  .AUTOMATIC_FAIRE_ORDER_PROMOTION_COHORT_ENV
const faireNotBeforeEnv = fairePromotionPolicy
  .AUTOMATIC_FAIRE_ORDER_PROMOTION_NOT_BEFORE_ENV
const enabledFaireAccount = 'gia0009202'
const secondFaireAccount = 'gia0bcdefghjkmn'
const faireNotBefore = '2026-08-04T12:00:00.000Z'
const faireGateOff = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: { CLAWPILOT_ENV: 'development' },
  })
assert.equal(faireGateOff.accountEnabled, false)
assert.equal(faireGateOff.disabledReason, 'cohort_and_not_before_required')
const invalidFaireBoundary = fairePromotionPolicy
  .faireAutomaticOrderPromotionCohort({
    CLAWPILOT_ENV: 'development',
    [faireCohortEnv]: enabledFaireAccount,
    [faireNotBeforeEnv]: '2026-08-04T12:00:00Z',
  })
assert.equal(invalidFaireBoundary.valid, false)
const faireProductionHostVeto = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      NODE_ENV: 'development',
      CLAWPILOT_PUBLIC_URL: 'https://aiapp.eigenracing.com',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
  })
assert.equal(faireProductionHostVeto.accountEnabled, false)
assert.equal(
  faireProductionHostVeto.disabledReason,
  'hosted_production_runtime',
)
const faireVercelProductionHostVeto = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      NODE_ENV: 'development',
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'clawpilot-production.example.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL:
        'clawpilot-production.example.vercel.app',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
  })
assert.equal(faireVercelProductionHostVeto.accountEnabled, false)
assert.equal(
  faireVercelProductionHostVeto.disabledReason,
  'hosted_production_runtime',
)
const faireVercelPreviewHostAllowed = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      NODE_ENV: 'development',
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'clawpilot-preview.example.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL:
        'clawpilot-production.example.vercel.app',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
  })
assert.equal(faireVercelPreviewHostAllowed.accountEnabled, true)
const exactFaireGate = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      [faireCohortEnv]: `${secondFaireAccount},${enabledFaireAccount}`,
      [faireNotBeforeEnv]: faireNotBefore,
    },
  })
assert.equal(exactFaireGate.accountEnabled, true)
assert.equal(exactFaireGate.notBefore, faireNotBefore)
assert.match(exactFaireGate.cohortHash, /^[a-f0-9]{64}$/u)
assert.deepEqual(
  [...exactFaireGate.accountGlobalIds],
  [enabledFaireAccount, secondFaireAccount].sort(),
)
const changedFaireBoundary = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      [faireCohortEnv]: `${secondFaireAccount},${enabledFaireAccount}`,
      [faireNotBeforeEnv]: '2026-08-04T12:00:00.001Z',
    },
  })
assert.notEqual(changedFaireBoundary.cohortHash, exactFaireGate.cohortHash)
const faireGateHealthKeys = [
  'policyVersion',
  'runtimeEligible',
  'configured',
  'valid',
  'enabled',
  'disabledReason',
  'cohortSize',
  'notBefore',
]
const unconfiguredFaireHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionGateHealth({
    CLAWPILOT_ENV: 'development',
  })
assert.deepEqual(Object.keys(unconfiguredFaireHealth), faireGateHealthKeys)
assert.deepEqual(JSON.parse(JSON.stringify(unconfiguredFaireHealth)), {
  policyVersion: 'commerce-faire-order-auto-promotion-v1',
  runtimeEligible: true,
  configured: false,
  valid: false,
  enabled: false,
  disabledReason: 'cohort_and_not_before_required',
  cohortSize: 0,
  notBefore: null,
})
const validDevelopmentFaireHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionGateHealth({
    CLAWPILOT_ENV: 'development',
    [faireCohortEnv]: `${secondFaireAccount},${enabledFaireAccount}`,
    [faireNotBeforeEnv]: faireNotBefore,
  })
assert.deepEqual(Object.keys(validDevelopmentFaireHealth), faireGateHealthKeys)
assert.equal(validDevelopmentFaireHealth.runtimeEligible, true)
assert.equal(validDevelopmentFaireHealth.configured, true)
assert.equal(validDevelopmentFaireHealth.valid, true)
assert.equal(validDevelopmentFaireHealth.enabled, true)
assert.equal(validDevelopmentFaireHealth.disabledReason, null)
assert.equal(validDevelopmentFaireHealth.cohortSize, 2)
assert.equal(validDevelopmentFaireHealth.notBefore, faireNotBefore)
const legacyOneAccountFaireGate = fairePromotionPolicy
  .faireAutomaticOrderPromotionGate({
    accountGlobalId: enabledFaireAccount,
    environment: {
      CLAWPILOT_ENV: 'development',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
  })
assert.match(legacyOneAccountFaireGate.cohortHash, /^[a-f0-9]{64}$/u)
assert.equal(
  JSON.stringify(validDevelopmentFaireHealth).includes(enabledFaireAccount),
  false,
  'Health must never expose account Global IDs',
)
assert.equal(
  JSON.stringify(validDevelopmentFaireHealth).includes(
    exactFaireGate.cohortHash,
  ),
  false,
  'Health must never expose a reversible cohort fingerprint',
)
const malformedFaireHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionGateHealth({
    CLAWPILOT_ENV: 'development',
    [faireCohortEnv]: enabledFaireAccount,
    [faireNotBeforeEnv]: '2026-08-04T12:00:00Z',
  })
assert.deepEqual(JSON.parse(JSON.stringify(malformedFaireHealth)), {
  policyVersion: 'commerce-faire-order-auto-promotion-v1',
  runtimeEligible: true,
  configured: true,
  valid: false,
  enabled: false,
  disabledReason: 'cohort_or_not_before_invalid',
  cohortSize: 0,
  notBefore: null,
})
const hostedProductionFaireHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionGateHealth({
    CLAWPILOT_ENV: 'development',
    CLAWPILOT_PUBLIC_URL: 'https://aiapp.eigenracing.com',
    [faireCohortEnv]: enabledFaireAccount,
    [faireNotBeforeEnv]: faireNotBefore,
  })
assert.equal(hostedProductionFaireHealth.runtimeEligible, false)
assert.equal(hostedProductionFaireHealth.configured, true)
assert.equal(hostedProductionFaireHealth.valid, true)
assert.equal(hostedProductionFaireHealth.enabled, false)
assert.equal(
  hostedProductionFaireHealth.disabledReason,
  'hosted_production_runtime',
)
assert.equal(hostedProductionFaireHealth.cohortSize, 1)
assert.equal(hostedProductionFaireHealth.notBefore, faireNotBefore)
assert.equal(
  JSON.stringify(hostedProductionFaireHealth).includes(
    legacyOneAccountFaireGate.cohortHash,
  ),
  false,
  'A legacy one-account cohort fingerprint must not be publicly reversible',
)
const sanitizedFaireHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionHealthSnapshot({
    environment: {
      CLAWPILOT_ENV: 'development',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
    heartbeat: {
      policyVersion: 'untrusted-old-policy',
      cohortHash: 'untrusted-old-hash',
      accountGlobalIds: [enabledFaireAccount],
      providerToken: 'must-not-leak',
      promoted: 2,
      held: 3,
      failed: 1,
      failedByCode: {
        COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 2_000_000,
        GIA5156705: 17,
        SECRETVALUE123: 23,
        PROVIDER_TOKEN_SUPERSECRET: 29,
        'unsafe-code': 99,
        ...Object.fromEntries(Array.from(
          { length: 1_000 },
          (_, index) => [`MALICIOUS_${index}`, index + 1],
        )),
      },
      attentionRequiredAccounts: 1,
      operatorReviewRequired: 4,
      providerWrites: 0,
      canonicalOrderWrites: 2,
      inventoryWrites: 0,
      syncCursorAdvanced: false,
    },
  })
assert.equal(sanitizedFaireHealth.policyVersion, validDevelopmentFaireHealth.policyVersion)
assert.equal(
  Object.prototype.hasOwnProperty.call(sanitizedFaireHealth, 'cohortHash'),
  false,
)
assert.equal(sanitizedFaireHealth.promoted, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(sanitizedFaireHealth.failedByCode)),
  { COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1 },
)
assert.equal(
  JSON.stringify(sanitizedFaireHealth).includes('must-not-leak'),
  false,
)
assert.equal(JSON.stringify(sanitizedFaireHealth).includes('GIA5156705'), false)
assert.equal(JSON.stringify(sanitizedFaireHealth).includes('SECRETVALUE123'), false)
assert.equal(JSON.stringify(sanitizedFaireHealth).includes('MALICIOUS_'), false)
assert.equal(
  JSON.stringify(sanitizedFaireHealth).includes(
    legacyOneAccountFaireGate.cohortHash,
  ),
  false,
)
const unknownFaireFailureHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionHealthSnapshot({
    environment: { CLAWPILOT_ENV: 'development' },
    heartbeat: {
      failed: 4,
      failedByCode: {
        GIA5156705: 1,
        SECRETVALUE123: 1,
        PROVIDER_TOKEN_SUPERSECRET: 1,
        MALICIOUS_4: 1,
      },
    },
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(unknownFaireFailureHealth.failedByCode)),
  { OTHER: 4 },
  'Unknown failure keys must reconcile safely without echoing their names',
)
assert.equal(
  Object.values(unknownFaireFailureHealth.failedByCode)
    .reduce((sum, count) => sum + count, 0),
  unknownFaireFailureHealth.failed,
)
const actualPromotionFailureHealth = fairePromotionPolicy
  .faireAutomaticOrderPromotionHealthSnapshot({
    environment: { CLAWPILOT_ENV: 'development' },
    heartbeat: {
      failed: 1,
      failedByCode: { COMMERCE_INTAKE_PACK_MAPPING_STALE: 1 },
    },
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(actualPromotionFailureHealth.failedByCode)),
  { COMMERCE_INTAKE_PACK_MAPPING_STALE: 1 },
)
const cappedFaireFailureMap = fairePromotionPolicy
  .faireAutomaticOrderPromotionHealthSnapshot({
    environment: {
      CLAWPILOT_ENV: 'development',
      [faireCohortEnv]: enabledFaireAccount,
      [faireNotBeforeEnv]: faireNotBefore,
    },
    heartbeat: {
      failed: 17,
      failedByCode: Object.fromEntries([
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED',
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_SELECTION_FAILED',
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_AUTHORITY_STALE',
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_GATE_CLOSED',
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_INVARIANT_STALE',
        'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_PRODUCT_MAPPING_STALE',
        'COMMERCE_INTAKE_ADDRESS_INCOMPLETE',
        'COMMERCE_INTAKE_ADDRESS_NOT_REQUIRED',
        'COMMERCE_INTAKE_DEFAULT_SLA_UNAVAILABLE',
        'COMMERCE_INTAKE_DELIVERY_NOT_REQUIRED',
        'COMMERCE_INTAKE_MANUAL_DELIVERY_REQUIRED',
        'COMMERCE_INTAKE_PROVIDER_DELIVERY_UNAVAILABLE',
        'COMMERCE_INTAKE_CANDIDATE_NOT_FOUND',
        'COMMERCE_INTAKE_ROW_VERSION_CONFLICT',
        'COMMERCE_INTAKE_CREDENTIAL_GENERATION_STALE',
        'COMMERCE_INTAKE_CUSTOMER_REQUIRED',
        'COMMERCE_INTAKE_CUSTOMER_STALE',
      ].map((code) => [code, 1])),
    },
  }).failedByCode
assert.equal(Object.keys(cappedFaireFailureMap).length, 16)
assert.equal(
  Object.values(cappedFaireFailureMap).reduce(
    (sum, count) => sum + count,
    0,
  ),
  17,
  'A bounded public failure map must still reconcile to the failure total',
)
assert.equal(cappedFaireFailureMap.OTHER, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    fairePromotionPolicy.faireAutomaticExactRefreshHealthSnapshot({
      attempted: 2_000_000,
      succeeded: 2,
      rejected: 1,
      failed: 1,
      failedByCode: {
        COMMERCE_FAIRE_EXACT_REFRESH_FAILED: 1,
        GIA5156705: 17,
        SECRETVALUE123: 23,
        PROVIDER_TOKEN_SUPERSECRET: 29,
        ...Object.fromEntries(Array.from(
          { length: 1_000 },
          (_, index) => [`MALICIOUS_${index}`, index + 1],
        )),
      },
      operatorReviewRequired: 2,
      providerWrites: 0,
      inventoryWrites: 0,
      syncCursorAdvanced: false,
      providerToken: 'must-not-leak',
    }),
  )),
  {
    attempted: 1_000_000,
    succeeded: 2,
    rejected: 1,
    failed: 1,
    failedByCode: { COMMERCE_FAIRE_EXACT_REFRESH_FAILED: 1 },
    operatorReviewRequired: 2,
    providerWrites: 0,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
const actualExactRefreshFailureHealth = fairePromotionPolicy
  .faireAutomaticExactRefreshHealthSnapshot({
    failed: 3,
    failedByCode: {
      COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1,
      COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH: 1,
      COMMERCE_INTAKE_INTENT_TARGET_CHANGED: 1,
    },
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(actualExactRefreshFailureHealth.failedByCode)),
  {
    COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH: 1,
    COMMERCE_INTAKE_INTENT_TARGET_CHANGED: 1,
    COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1,
  },
)
assert.equal(
  Object.values(actualExactRefreshFailureHealth.failedByCode)
    .reduce((sum, count) => sum + count, 0),
  actualExactRefreshFailureHealth.failed,
)
const missingExactRefreshBreakdown = fairePromotionPolicy
  .faireAutomaticExactRefreshHealthSnapshot({ failed: 3 })
assert.deepEqual(
  JSON.parse(JSON.stringify(missingExactRefreshBreakdown.failedByCode)),
  { OTHER: 3 },
  'A nonzero failure total must never have an empty public breakdown',
)
assert.equal(
  shopifyPromotionPolicy.automaticShopifyPromotionHoldRequiresAttention(
    'canonical_order_exists',
  ),
  false,
  'Canonical-order dedupe is a benign automatic-promotion no-op',
)
assert.equal(
  shopifyPromotionPolicy.automaticShopifyPromotionHoldRequiresAttention(
    'checkout_rate_lineage_missing',
  ),
  true,
  'Missing checkout lineage must remain durable operator attention',
)
assert.equal(
  shopifyPromotionPolicy.SHOPIFY_AUTOMATIC_ORDER_PROMOTION_ATTENTION_MARKER,
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED',
)
const freshProviderCreatedAt = Date.parse('2026-08-01T12:00:00.000Z')
const freshObservedAt = freshProviderCreatedAt + 5 * 60_000
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshProviderCreatedAt + 48 * 60 * 60 * 1_000,
  }),
  true,
  'Exact 48-hour provider evidence remains eligible',
)
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshObservedAt + 48 * 60 * 60 * 1_000 + 1,
  }),
  false,
  'A retained intake replay after 48 hours must not promote stale Faire evidence',
)
assert.equal(
  fairePromotionPolicy.automaticFaireOrderSourceIsFresh({
    providerCreatedAt: new Date(freshObservedAt),
    observedAt: new Date(freshProviderCreatedAt),
    nowMs: freshObservedAt,
  }),
  false,
  'Faire provider creation must not postdate the captured observation',
)
assert.equal(
  shopifyPromotionPolicy.automaticShopifyOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshProviderCreatedAt + 48 * 60 * 60 * 1_000,
  }),
  true,
  'Fresh Shopify source evidence remains eligible at the exact boundary',
)
assert.equal(
  shopifyPromotionPolicy.automaticShopifyOrderSourceIsFresh({
    providerCreatedAt: new Date(freshProviderCreatedAt),
    observedAt: new Date(freshObservedAt),
    nowMs: freshObservedAt + 48 * 60 * 60 * 1_000 + 1,
  }),
  false,
  'Retained Shopify evidence must not become automatically promotable later',
)
const shippingServiceCodeMigration = read(
  'db/migrations/0173_operations_shopify_shipping_service_codes.sql',
)
const shopifyPreflightMigration = read(
  'db/migrations/0245_operations_shopify_checkout_rate_preflight.sql',
)
includes(shopifyPreflightMigration, [
  'operations_shopify_checkout_rate_match_candidate_facts_for_workflow',
  'require_promoted_candidate boolean',
  'operations_shopify_checkout_rate_match_candidate_facts(',
  'require_promoted_candidate',
  'operations_shopify_checkout_rate_preflight_match_candidates(',
  'enforce_reconciliation_deadline',
  'false',
  'true',
  'SECURITY INVOKER',
  'SET search_path = pg_catalog, public',
  'REVOKE EXECUTE ON FUNCTION',
  'FROM PUBLIC',
], 'Shopify held-candidate checkout preflight migration')
includes(persistence, [
  "const ORDER_RECONCILIATION_INTERVAL = '30 minutes'",
  "const ORDER_RECONCILIATION_LEASE = '10 minutes'",
  "? 'read_orders'",
  "credential.auth_mode = 'faire_brand_token'",
  "? 'READ_ORDERS'",
  'ORDER_READ_ACCOUNT_SQL',
  "const STORE_SYNC_RUNNING_SQL = commerceStoreSyncRunningSql('account')",
  "reconciliation_status = 'running'",
  "reconciliation_status = 'succeeded'",
  "reconciliation_status = 'failed'",
  'LEFT JOIN LATERAL',
  "continuation.cursor_state = 'available'",
  "continuation.resource = 'orders'",
  'continuation.provider = account.provider',
  'continuation.credential_version',
  "run.created_by = 'system:commerce-order-reconciliation'",
  'continuation_run_global_id',
  'continuation_idempotency_key',
  'continuation_batch_number',
  'records_seen',
  'records_held',
  "date_trunc('milliseconds', clock_timestamp())",
  'projectCommerceOrderReconciliationPageInPostgres',
  "run.created_by = 'system:commerce-order-reconciliation'",
  'cursor.last_started_at = $3::timestamptz',
  "cursor.last_started_at + interval '1 millisecond'",
  'prior_intent.continuation_cursor_hash',
  'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
  'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  "cursor.reconciliation_status IS DISTINCT FROM 'failed'",
  "active_intent.intent_state",
  'THEN 0',
  'durable_records_seen',
  'durable_records_held',
  'readCommerceOrderReconciliationStateInPostgres',
  'resetCommerceOrderReconciliationInPostgres',
  "eventType: 'commerce.orders.reconciliation.reset'",
  'providerWrites: 0',
  'canonicalOrderWrites: 0',
  'inventoryWrites: 0',
  'unresolved_shopify_promotion',
  "candidate.workflow_state IN ('held', 'resolving', 'ready')",
  'candidate.last_error_code =',
  'SHOPIFY_AUTOMATIC_ORDER_PROMOTION_ATTENTION_MARKER',
  "run.created_by = 'system:commerce-order-reconciliation'",
  "run.workflow_state <> 'expired'",
  'run.expires_at > now()',
  'canonical.external_order_id',
], 'Order reconciliation persistence')
includes(shippingServiceCodeMigration, [
  'operations_commerce_order_candidates_checkout_service_valid',
  'BETWEEN 1 AND 255',
  "checkout_shipping_service_code !~ '[[:cntrl:]]'",
  'Opaque Shopify ShippingLine.code',
], 'Shopify shipping-service-code migration')
assert.ok(
  !shippingServiceCodeMigration.includes('BETWEEN 3 AND 80'),
  'Shopify opaque shipping method codes must not inherit ClawPilot service-code length rules',
)
assert.ok(!persistence.includes('provider_cursor ='), 'Order reconciliation must not persist a provider cursor')
assert.ok(!persistence.includes("? 'read_all_orders'"), 'Current automatic order reconciliation must not require historical-order scope')
assert.ok(
  !persistence.includes('faire_updated_at_min')
    && !persistence.includes('high_watermark ='),
  'Faire automatic reconciliation must not use an unsafe live-cursor incremental checkpoint',
)
const completionPersistenceSource = persistence.slice(
  persistence.indexOf(
    'export async function completeCommerceOrderReconciliationInPostgres',
  ),
  persistence.indexOf(
    'export async function failCommerceOrderReconciliationInPostgres',
  ),
)
assert.doesNotMatch(
  completionPersistenceSource,
  /WHEN \$8::boolean/u,
  'Shopify and Faire continuation attention must be recomputed from active candidate markers',
)

let claimSql = ''
const claimStartedAt = new Date('2026-07-28T14:15:16.789Z')
const persistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql) {
              claimSql = sql
              return {
                rows: [{
                  organization_id:
                    '11111111-1111-4111-8111-111111111111',
                  integration_account_id:
                    '22222222-2222-4222-8222-222222222222',
                  account_global_id: 'gca0000001',
                  provider: 'faire',
                  credential_version: 2,
                  continuation_run_global_id: null,
                  continuation_idempotency_key: null,
                  continuation_batch_number: null,
                  last_started_at: claimStartedAt,
                  records_seen: '0',
                  records_held: '0',
                }],
              }
            },
          })
        },
      },
    },
  },
)
const claimedTargets = await persistenceModule
  .claimCommerceOrderReconciliationTargetsInPostgres({ limit: 1 })
assert.match(
  claimSql,
  /RETURNING[\s\S]*last_started_at/,
  'Claim SQL must return the persisted reconciliation lease timestamp',
)
assert.match(
  claimSql,
  /last_error_code IN \([\s\S]*COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED/,
  'Root claims must preserve durable automatic-promotion attention',
)
assert.equal(claimedTargets.length, 1)
assert.equal(
  claimedTargets[0].startedAt,
  claimStartedAt.toISOString(),
  'Claim mapping must use last_started_at returned by the sync cursor',
)
assert.equal(claimedTargets[0].recordsSeen, 0)
assert.equal(claimedTargets[0].recordsHeld, 0)
assert.equal(claimedTargets[0].continuationBatchNumber, null)

let projectionSql = ''
const renewedAt = new Date('2026-07-28T14:16:00.123Z')
const projectionPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async query(sql) {
          projectionSql = sql
          return {
            rows: [{
              last_started_at: renewedAt,
              records_seen: '42',
              records_held: '7',
              batch_number: 3,
              provider_cursor_repeated: false,
            }],
          }
        },
        async withTransaction() {
          throw new Error('Page projection must be one compare-and-swap query')
        },
      },
    },
  },
)
const projectedPage = await projectionPersistenceModule
  .projectCommerceOrderReconciliationPageInPostgres({
    target: claimedTargets[0],
    runGlobalId: 'gcir0000003',
  })
assert.equal(projectedPage.leaseLost, false)
assert.equal(projectedPage.startedAt, renewedAt.toISOString())
assert.equal(projectedPage.recordsSeen, 42)
assert.equal(projectedPage.recordsHeld, 7)
assert.equal(projectedPage.continuationBatchNumber, 3)
assert.match(
  projectionSql,
  /run\.global_id = \$4[\s\S]*reconciliation_status = 'running'[\s\S]*last_started_at = \$3::timestamptz[\s\S]*last_started_at > clock_timestamp\(\)/,
  'Durable page projection must compare-and-swap the exact still-live claim',
)

const healthQueries = []
const healthPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async query(sql, values) {
          healthQueries.push({ sql, values })
          if (sql.includes('SELECT value FROM app_settings')) {
            return {
              rows: [{
                value: {
                  checkedAt: '2026-08-01T16:30:00.000Z',
                  phase: 'completed',
                },
              }],
            }
          }
          if (sql.includes('WITH eligible AS')) {
            return {
              rows: [{
                eligible_accounts: '2',
                shopify_accounts: '1',
                faire_accounts: '1',
                never_run: '0',
                running: '0',
                failed: '1',
                stale_processing: '0',
                shopify_promotion_attention_required: '1',
                faire_promotion_attention_required: '0',
                faire_exact_refresh_attention_required: '0',
                faire_unattributed_attention_required: '1',
                operator_attention_required: '2',
                overdue: '1',
                resumable: '1',
                last_success_at: '2026-08-01T16:20:00.000Z',
              }],
            }
          }
          return { rows: [] }
        },
        async withTransaction() {
          throw new Error('Health reads must not open a transaction')
        },
      },
    },
  },
)
const orderHealth = await healthPersistenceModule
  .readCommerceOrderReconciliationHealthFromPostgres()
assert.deepEqual(JSON.parse(JSON.stringify(orderHealth)), {
  eligibleAccounts: 2,
  providerAccounts: { shopify: 1, faire: 1 },
  neverRun: 0,
  running: 0,
  failed: 1,
  staleProcessing: 0,
  promotionAttentionRequired: 1,
  providerPromotionAttentionRequired: { shopify: 1, faire: 0 },
  faireExactRefreshAttentionRequired: 0,
  faireUnattributedAttentionRequired: 1,
  operatorAttentionRequired: 2,
  overdue: 1,
  resumable: 1,
  lastSuccessAt: '2026-08-01T16:20:00.000Z',
  resource: 'orders',
})
const heartbeat = await healthPersistenceModule
  .readCommerceOrderReconciliationWorkerHeartbeatFromPostgres()
assert.equal(heartbeat.phase, 'completed')
const recordedHeartbeat = await healthPersistenceModule
  .recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId: 'worker-test',
    providerWrites: 0,
  })
assert.equal(recordedHeartbeat.resource, 'orders')
assert.equal(recordedHeartbeat.providerWrites, 0)
assert.ok(
  healthQueries.some(({ sql }) => sql.includes("account.provider IN ('shopify', 'faire')")),
  'Durable health must cover both Shopify and Faire order-readable accounts',
)
assert.ok(
  healthQueries.some(({ sql }) => sql.includes('INSERT INTO app_settings')),
  'Order-worker heartbeat must be durable',
)

const persistedFailureCodes = []
const failurePersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent() {},
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(_sql, values) {
              persistedFailureCodes.push(values[3])
              return {
                rowCount: 1,
                rows: [{
                  consecutive_failures: 1,
                  last_error_code: values[3],
                }],
              }
            },
          })
        },
      },
    },
  },
)
const failureTarget = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId: 'gca0000001',
  provider: 'shopify',
  credentialVersion: 1,
  startedAt: '2026-07-27T12:00:00.000Z',
  recordsSeen: 0,
  recordsHeld: 0,
  continuationBatchNumber: null,
  continuationRunGlobalId: null,
  continuationIdempotencyKey: null,
}
const promotionCompletionQueries = []
const promotionCompletionAudits = []
const promotionCompletionModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          promotionCompletionAudits.push(event)
        },
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql, values) {
              promotionCompletionQueries.push({ sql, values })
              return {
                rowCount: 1,
                rows: [{
                  last_error_code: values[8] === 'shopify' && values[5] > 0
                    ? 'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'
                    : values[6] > 0 && values[7] > 0
                      ? 'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED'
                      : values[6] > 0
                        ? 'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED'
                        : values[7] > 0
                          ? 'COMMERCE_FAIRE_EXACT_REFRESH_ATTENTION_REQUIRED'
                          : null,
                  automatic_promotion_attention_required:
                    values[5] > 0 || values[6] > 0,
                  automatic_exact_refresh_attention_required:
                    values[7] > 0,
                  automatic_unattributed_attention_required: false,
                }],
              }
            },
          })
        },
      },
    },
  },
)
const promotionCompletion = await promotionCompletionModule
  .completeCommerceOrderReconciliationInPostgres({
    target: { ...failureTarget, provider: 'faire' },
    providerRecordsSeen: 1,
    ordersHeld: 1,
    recordsRejected: 0,
    pagesRead: 1,
    hasNextBatch: false,
    customersMatched: 1,
    customersCreated: 0,
    customersAmbiguous: 0,
    customersSkipped: 0,
    customerResolutionFailed: 0,
    customerResolutionFailureCodes: {},
    shopifyOrdersPromoted: 0,
    shopifyOrdersHeld: 0,
    shopifyPromotionActionableHeld: 0,
    shopifyPromotionHeldReasons: {},
    shopifyPromotionFailed: 0,
    shopifyPromotionFailureCodes: {},
    shopifyPromotionRollbackFenced: 0,
    faireOrdersPromoted: 0,
    faireOrdersHeld: 0,
    fairePromotionFailed: 1,
    fairePromotionFailureCodes: {
      COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
    },
    fairePromotionOperatorReviewRequired: 1,
    faireExactRefreshAttempted: 2,
    faireExactRefreshSucceeded: 0,
    faireExactRefreshRejected: 1,
    faireExactRefreshFailed: 1,
    faireExactRefreshOperatorReviewRequired: 1,
    faireExactRefreshFailureCodes: {
      COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1,
    },
  })
assert.equal(promotionCompletion.leaseLost, false)
assert.equal(promotionCompletionQueries.length, 1)
assert.match(
  promotionCompletionQueries[0].sql,
  /COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED/u,
  'Successful provider reads must durably retain local-promotion attention',
)
assert.equal(promotionCompletionQueries[0].values[5], 0)
assert.equal(promotionCompletionQueries[0].values[6], 1)
assert.equal(promotionCompletionQueries[0].values[7], 1)
assert.equal(promotionCompletionQueries[0].values[8], 'faire')
assert.equal(
  promotionCompletion.faireAutomaticPromotionAttentionRequired,
  true,
)
assert.equal(promotionCompletion.faireExactRefreshAttentionRequired, true)
assert.equal(promotionCompletion.faireUnattributedAttentionRequired, false)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticFaireOrderPromotion.failed,
  1,
)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticFaireOrderPromotion.operatorReviewRequired,
  1,
  'Promotion review count must exclude exact-refresh marker outcomes',
)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticFaireExactRefresh.operatorReviewRequired,
  1,
  'Exact-refresh review count must use durable marked:true outcomes',
)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticFaireExactRefresh.failed,
  1,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    promotionCompletionAudits[0].payload
      .automaticFaireExactRefresh.failedByCode,
  )),
  { COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1 },
)
promotionCompletionQueries.length = 0
promotionCompletionAudits.length = 0
await promotionCompletionModule.completeCommerceOrderReconciliationInPostgres({
  target: { ...failureTarget, provider: 'shopify' },
  providerRecordsSeen: 1,
  ordersHeld: 1,
  recordsRejected: 0,
  pagesRead: 1,
  hasNextBatch: false,
  customersMatched: 1,
  customersCreated: 0,
  customersAmbiguous: 0,
  customersSkipped: 0,
  customerResolutionFailed: 0,
  customerResolutionFailureCodes: {},
  shopifyOrdersPromoted: 0,
  shopifyOrdersHeld: 1,
  shopifyPromotionActionableHeld: 1,
  shopifyPromotionHeldReasons: { checkout_rate_lineage_missing: 1 },
  shopifyPromotionFailed: 0,
  shopifyPromotionFailureCodes: {},
  shopifyPromotionRollbackFenced: 0,
  faireOrdersPromoted: 0,
  faireOrdersHeld: 0,
  fairePromotionFailed: 0,
  fairePromotionFailureCodes: {},
})
assert.equal(
  promotionCompletionQueries[0].values[5],
  1,
  'An actionable Shopify hold must persist automatic-promotion attention',
)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticShopifyOrderPromotion.operatorReviewRequired,
  1,
)
promotionCompletionQueries.length = 0
promotionCompletionAudits.length = 0
await promotionCompletionModule.completeCommerceOrderReconciliationInPostgres({
  target: { ...failureTarget, provider: 'shopify' },
  providerRecordsSeen: 1,
  ordersHeld: 1,
  recordsRejected: 0,
  pagesRead: 1,
  hasNextBatch: false,
  customersMatched: 0,
  customersCreated: 0,
  customersAmbiguous: 0,
  customersSkipped: 0,
  customerResolutionFailed: 0,
  customerResolutionFailureCodes: {},
  shopifyOrdersPromoted: 0,
  shopifyOrdersHeld: 1,
  shopifyPromotionActionableHeld: 0,
  shopifyPromotionHeldReasons: { canonical_order_exists: 1 },
  shopifyPromotionFailed: 0,
  shopifyPromotionFailureCodes: {},
  shopifyPromotionRollbackFenced: 0,
  faireOrdersPromoted: 0,
  faireOrdersHeld: 0,
  fairePromotionFailed: 0,
  fairePromotionFailureCodes: {},
})
assert.equal(
  promotionCompletionQueries[0].values[5],
  0,
  'A canonical-order dedupe must not create durable operator attention',
)
assert.equal(
  promotionCompletionAudits[0].payload
    .automaticShopifyOrderPromotion.operatorReviewRequired,
  0,
)
const knownConstraintFailure = await failurePersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: '23514',
      constraint:
        'operations_commerce_order_candidates_checkout_service_valid',
    },
  })
assert.equal(
  knownConstraintFailure.errorCode,
  'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
)
const unknownConstraintFailure = await failurePersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: '23514',
      constraint: 'provider_or_customer_data_must_not_escape',
    },
  })
assert.equal(
  unknownConstraintFailure.errorCode,
  'COMMERCE_ORDER_RECONCILIATION_CHECK_CONSTRAINT_FAILED',
)
assert.deepEqual(persistedFailureCodes, [
  'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
  'COMMERCE_ORDER_RECONCILIATION_CHECK_CONSTRAINT_FAILED',
])

const terminalQueries = []
const terminalAudits = []
const terminalPersistenceModule = loadTypeScriptModule(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
  {
    mocks: {
      '@/lib/auditWriter': {
        async recordAuditEvent(event) {
          terminalAudits.push(event)
        },
      },
      '@/lib/persistence/postgres': {
        async withTransaction(callback) {
          return callback({
            async query(sql, values) {
              terminalQueries.push({ sql, values })
              if (sql.includes('UPDATE operations_commerce_sync_cursors')) {
                return {
                  rowCount: 1,
                  rows: [{
                    consecutive_failures: 1,
                    last_error_code:
                      'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
                  }],
                }
              }
              if (sql.includes('UPDATE operations_commerce_intake_continuations')) {
                return {
                  rowCount: 1,
                  rows: [{
                    id: '33333333-3333-4333-8333-333333333333',
                    session_id: '44444444-4444-4444-8444-444444444444',
                    batch_number: 2,
                  }],
                }
              }
              throw new Error(`Unexpected terminal SQL: ${sql}`)
            },
          })
        },
      },
    },
  },
)
const terminalFailure = await terminalPersistenceModule
  .failCommerceOrderReconciliationInPostgres({
    target: failureTarget,
    error: {
      code: 'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
    },
  })
assert.equal(terminalFailure.terminal, true)
assert.equal(terminalFailure.continuationTransition, 'invalid')
assert.equal(terminalFailure.continuationsRetired, 1)
const retirementQuery = terminalQueries.find(({ sql }) => (
  sql.includes('UPDATE operations_commerce_intake_continuations')
))
assert.deepEqual(JSON.parse(JSON.stringify(retirementQuery.values)), [
  failureTarget.organizationId,
  failureTarget.integrationAccountId,
  1,
  'shopify',
  'invalid',
])
assert.match(retirementQuery.sql, /cursor_state = \$5/)
assert.match(retirementQuery.sql, /continuation\.provider = \$4/)
assert.match(retirementQuery.sql, /credential_version = \$3::integer/)
assert.equal(terminalAudits.length, 1)
assert.equal(
  terminalAudits[0].eventType,
  'commerce.orders.reconciliation.terminal',
)

const workerSource = read('app_src/lib/commerceOrderReconciliationWorker.ts')
includes(workerSource, [
  'MAX_PAGES_PER_RECONCILIATION = 5',
  "'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_PAGES'",
  '2_000',
  'MAX_PROVIDER_RECORDS_PER_RECONCILIATION = 250',
  "'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_RECORDS'",
  '100_000',
  'MAX_RECONCILIATION_RUNTIME_MS = 180_000',
  'MIN_REMAINING_RUNTIME_FOR_EXACT_REFRESH_MS = 30_000',
  "'CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES'",
  'deterministicFaireExactRefreshUuid',
  'readAutomaticFaireExactRefreshTargetsInPostgres',
  'targetFaireExactRefreshAttemptedCandidates',
  'excludedCandidateGlobalIds',
  'executeCommerceFaireOrderExactRefresh',
  'COMMERCE_FAIRE_AUTO_PROMOTION_ATTENTION_PERSIST_FAILED',
  'assertReconciliationFence(exactCommand)',
  "budgetStopReason = 'exact-refresh'",
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
  'projectCommerceOrderReconciliationPageInPostgres',
  'automaticShopifyOrderPromotion',
  'shopifyAutomaticOrderPromotionHealthSnapshot',
  'rollbackFenced',
  'canonicalOrderWrites: shopifyOrdersPromoted + faireOrdersPromoted',
  'processShopifyOrderRevisions',
  'processFaireOrderRevisions',
  'MAX_PROVIDER_REVISION_TARGETS_PER_RECONCILIATION = 2',
  'canonicalOrderRevisions',
], 'Bounded order reconciliation worker')
assert.ok(
  workerSource.includes('permits a bounded')
    && workerSource.includes('local-only')
    && workerSource.includes('never derives packages or shipments'),
  'Order reconciliation must permit only bounded local promotion while remaining package, shipment, inventory, and provider-write fenced',
)
const intakeSource = read('app_src/lib/integrations/commerceIntake.ts')
includes(intakeSource, [
  'export async function executeCommerceOrderPage',
  "action: input.continuationRunGlobalId ? 'fetch-next' : 'fetch'",
  'includeIntakeState: false',
  'hydrateProductInventory: false',
  "| 'reset-order-reconciliation'",
  'confirmResetOrderReconciliation',
  'expectedLastErrorCode',
  'expectedLastStartedAt',
  'resetCommerceOrderReconciliationInPostgres',
], 'Order-page execution path')
includes(intakeSource, [
  'withAutomaticShopifyOrderPromotion',
  'shopifyAutomaticOrderPromotionGate',
  'worker_actor_required',
  'sandbox_account_required',
  'requiredCheckoutRateOutcome: \'matched\'',
  'automaticShopifyPromotion',
  'markAutomaticShopifyOrderPromotionAttentionInPostgres',
  'attention:${target.reasonCode}',
  'rollbackFenced',
], 'Shopify clean-path automatic promotion service')
const intakePersistenceSource = read(
  'app_src/lib/persistence/commerceIntake.ts',
)
includes(intakePersistenceSource, [
  'readAutomaticShopifyOrderPromotionTargetsForRunInPostgres',
  "run.created_by = 'system:commerce-order-reconciliation'",
  "account.environment !== 'sandbox'",
  "candidate.normalized_payment_status !== 'paid'",
  "candidate.normalized_return_status !== 'none'",
  "line.packaging_source !== 'variant_pack_mapping'",
  'physical_shipping_required',
  'operations_shopify_checkout_rate_preflight_match_candidates',
  'exactMatches.rowCount !== 1',
  'prior_candidate_requires_review',
  'canonical_order_exists',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED',
  "checkoutRateReconciliation?.outcome !== 'matched'",
  'markAutomaticShopifyOrderPromotionAttentionInPostgres',
  'commerce.intake.mark_shopify_auto_promotion_attention',
  'commerce.intake.shopify_auto_promotion.attention_marked',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_NOT_REQUIRED',
  'SHOPIFY_AUTOMATIC_ORDER_PROMOTION_ATTENTION_MARKER',
  'last_error_code = NULL',
  'no partial local order survives',
], 'Shopify clean-path selector and atomic rollback fence')
const strictPromotionSource = intakePersistenceSource.slice(
  intakePersistenceSource.indexOf(
    'export async function promoteCommerceCandidateInPostgres',
  ),
  intakePersistenceSource.indexOf(
    'export async function\nreconcilePromotedCommerceCandidateCheckoutRateInPostgres',
  ),
)
const canonicalInsertIndex = strictPromotionSource.indexOf(
  'INSERT INTO operations_orders',
)
const reconciliationIndex = strictPromotionSource.indexOf(
  'reconcileShopifyCheckoutRateForOrderCandidateWithClient',
)
const strictMatchFenceIndex = strictPromotionSource.indexOf(
  "checkoutRateReconciliation?.outcome !== 'matched'",
)
assert.ok(canonicalInsertIndex > 0)
assert.ok(reconciliationIndex > canonicalInsertIndex)
assert.ok(strictMatchFenceIndex > reconciliationIndex)
assert.match(
  strictPromotionSource,
  /return withTransaction\(async \(client\) => \{[\s\S]*COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED/u,
  'The strict matched-lineage failure must throw inside the same canonical-order transaction',
)
const intakeWorkflowSource = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
includes(intakeWorkflowSource, [
  'resetRequired: boolean',
  'automaticPromotionAttentionRequired: boolean',
  'automatic local ${providerLabel(provider)} order promotion needs attention',
  'provider order rows scanned',
  'eligible order rows in latest page',
  'ClawPilot orders added',
  'new rows held/rejected in this scan',
  'retained order',
  'retained provider',
  'Order candidates (',
  'Needs action (',
  'Observed history',
  'No import records need action',
  'commerceIntakeCandidateIsHistoricalOutcome',
  'Scanned rows are provider order rows checked, not ClawPilot',
  'filters ineligible rows and',
  'deduplicates already-known orders',
  'with one matched',
  'ClawPilot checkout quote',
  'Provider reads remain read-only.',
  'This step does not reserve',
  'order promotion was held or',
  "'reset-order-reconciliation'",
  'Restart automatic staging',
  'ClawPilot will not reuse the terminal continuation.',
], 'Order-reconciliation operator recovery')
assert.ok(
  !intakeWorkflowSource.includes('provider records read'),
  'Order reconciliation must not present scanned provider rows as orders added',
)
assert.ok(
  intakeSource.includes('updatedAtMin: page.windowStart'),
  'Faire automatic polls must carry the immutable first-admission boundary',
)
assert.ok(
  intakeSource.includes('Shopify must grant read_orders for current operational intake'),
  'Current order reads must require only read_orders',
)
assert.ok(
  intakeSource.includes('currentOrderWindow')
    && intakeSource.includes("updated_at:>='${page.windowStart}'"),
  'Current Shopify reads must stay inside the provider default-order window',
)

const trace = { claims: 0, complete: [], failed: [] }
let disabledRuntimePurgeCalls = 0
const disabledWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => false,
        async executeCommerceOrderPage() {
          assert.fail('A disabled runtime must not read a provider page')
        },
        async executeCommerceFaireOrderExactRefresh() {
          assert.fail('A disabled runtime must not execute an exact read')
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          assert.fail('A disabled runtime must not claim reconciliation work')
        },
        async completeCommerceOrderReconciliationInPostgres() {
          assert.fail('A disabled runtime must not complete reconciliation work')
        },
        async failCommerceOrderReconciliationInPostgres() {
          assert.fail('A disabled runtime must not fail reconciliation work')
        },
        async projectCommerceOrderReconciliationPageInPostgres() {
          assert.fail('A disabled runtime must not project reconciliation work')
        },
      },
      '@/lib/persistence/commerceOrderRevisions': {
        async purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres(input) {
          disabledRuntimePurgeCalls += 1
          assert.equal(input.limit, 250)
          return {
            schemaAvailable: true,
            skipped: false,
            limit: 250,
            purged: 1,
            expiredProtectedReadBacklog: 0,
            backlogTruncated: false,
          }
        },
      },
    },
  },
)
const disabledSummary = await disabledWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(
  disabledRuntimePurgeCalls,
  1,
  'Protected snapshot retention must run even when commerce intake is disabled',
)
assert.equal(disabledSummary.protectedSnapshotPurge.purged, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(commerceStorageMaintenanceTrace.at(-1))),
  {
    intakeLimit: 1000,
    legacyCaptureLimit: 25,
    inventorySnapshotLimit: 250,
    inventoryAliasLimit: 5000,
    inventoryLevelLimit: 10000,
    workerId: 'commerce-order-reconciliation',
  },
  'Permanent commerce storage maintenance must run every reconciliation cycle',
)
assert.equal(disabledSummary.commerceStorageMaintenance.schemaAvailable, true)
const currentFaireGateHealth = JSON.parse(JSON.stringify(
  fairePromotionPolicy.faireAutomaticOrderPromotionGateHealth(),
))
for (const key of faireGateHealthKeys) {
  assert.deepEqual(
    disabledSummary.automaticFaireOrderPromotion[key],
    currentFaireGateHealth[key],
    `Disabled worker summary must include current Faire gate field ${key}`,
  )
}
assert.deepEqual(
  JSON.parse(JSON.stringify(disabledSummary.automaticFaireExactRefresh)),
  {
    attempted: 0,
    succeeded: 0,
    rejected: 0,
    failed: 0,
    failedByCode: {},
    operatorReviewRequired: 0,
    providerWrites: 0,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
const revisionCompositionCalls = []
const revisionPurgeCalls = []
const revisionCompositionWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        commerceReadRuntimeMode: () => 'production',
        async executeCommerceOrderPage() {
          assert.fail('No provider page should run without a root claim')
        },
        async executeCommerceFaireOrderExactRefresh() {
          assert.fail('No candidate exact refresh should run without a root claim')
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return []
        },
      },
      '@/lib/persistence/commerceOrderRevisions': {
        async purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres(input) {
          revisionPurgeCalls.push(input)
          return {
            schemaAvailable: true,
            skipped: false,
            limit: input.limit,
            purged: 2,
            expiredProtectedReadBacklog: 1,
            backlogTruncated: false,
          }
        },
      },
      '@/lib/commerceShopifyOrderRevisionWorker': {
        async processShopifyOrderRevisions(input) {
          revisionCompositionCalls.push({ provider: 'shopify', input })
          return {
            provider: 'shopify',
            claimed: 2,
            captured: 2,
            changed: 2,
            failed: 0,
            failureCodes: {},
            providerWrites: 0,
            canonicalOrderWrites: 0,
            managerDispositionRequired: 2,
          }
        },
      },
      '@/lib/commerceFaireOrderRevisionWorker': {
        async processFaireOrderRevisions(input) {
          revisionCompositionCalls.push({ provider: 'faire', input })
          return {
            provider: 'faire',
            claimed: 1,
            captured: 1,
            changed: 1,
            failed: 0,
            failureCodes: {},
            providerReadsPerCapture: 2,
            providerWrites: 0,
            canonicalOrderWrites: 0,
            managerDispositionRequired: 1,
          }
        },
      },
    },
  },
)
const revisionComposition = await revisionCompositionWorker
  .processCommerceOrderReconciliation({ limit: 9 })
assert.deepEqual(
  JSON.parse(JSON.stringify(revisionPurgeCalls)),
  [{ limit: 250 }],
  'Protected revision snapshots must be purged once with a bounded cycle limit',
)
assert.equal(revisionComposition.protectedSnapshotPurge.purged, 2)
assert.equal(
  revisionComposition.protectedSnapshotPurge.expiredProtectedReadBacklog,
  1,
)
assert.deepEqual(
  revisionCompositionCalls.map(({ provider, input }) => ({
    provider,
    limit: input.limit,
  })),
  [
    { provider: 'shopify', limit: 2 },
    { provider: 'faire', limit: 2 },
  ],
  'One bounded exact-read backstop per provider must follow every order poll',
)
assert.equal(revisionComposition.canonicalOrderRevisions.providerWrites, 0)
assert.equal(
  revisionComposition.canonicalOrderRevisions.canonicalOrderWrites,
  0,
)
assert.equal(
  revisionComposition.canonicalOrderRevisions.managerDispositionRequired,
  3,
)
let page = 0
const worker = loadTypeScriptModule('app_src/lib/commerceOrderReconciliationWorker.ts', {
  mocks: {
    '@/lib/integrations/commerceIntake': {
      commerceReadRuntimeAvailable: () => true,
      async executeCommerceOrderPage(input) {
        assert.equal(input.actorEmail, 'system:commerce-order-reconciliation')
        assert.ok(
          !Object.prototype.hasOwnProperty.call(input, 'initialWindowStart'),
          'Faire polling must not inject an unsafe incremental lower bound',
        )
        if (page === 0) {
          assert.equal(input.continuationRunGlobalId, null)
          page += 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 3,
              recordsRejected: 1,
              automaticCustomerResolution: {
                matched: 2,
                created: 1,
                ambiguous: 1,
                skipped: 0,
                failed: 0,
                failedByCode: {},
                providerWrites: 0,
                syncCursorAdvanced: false,
              },
              automaticFaireOrderPromotion: {
                promoted: 1,
                held: 1,
                failed: 0,
                failedByCode: {},
                operatorReviewRequired: 1,
                providerWrites: 0,
                canonicalOrderWrites: 1,
                inventoryWrites: 0,
                syncCursorAdvanced: false,
              },
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000001',
                providerRowsSeen: 4,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000001',
                windowEnd: '2026-07-27T12:00:01.000Z',
              },
            },
          }
        }
        assert.equal(input.continuationRunGlobalId, 'gcir0000001')
        page += 1
        return {
          command: {
            providerWrites: 0,
            syncCursorAdvanced: false,
            ordersStaged: 2,
            recordsRejected: 0,
            automaticCustomerResolution: {
              matched: 1,
              created: 0,
              ambiguous: 0,
              skipped: 1,
              failed: 1,
              failedByCode: {
                COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1,
              },
              providerWrites: 0,
              syncCursorAdvanced: false,
            },
            automaticFaireOrderPromotion: {
              promoted: 0,
              held: 1,
              failed: 1,
              failedByCode: {
                COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
              },
              operatorReviewRequired: 2,
              providerWrites: 0,
              canonicalOrderWrites: 0,
              inventoryWrites: 0,
              syncCursorAdvanced: false,
            },
            pagination: {
              batchNumber: 2,
              runGlobalId: 'gcir0000002',
              providerRowsSeen: 2,
              hasNextBatch: false,
              windowEnd: '2026-07-27T12:00:01.000Z',
            },
          },
        }
      },
    },
    '@/lib/persistence/commerceOrderReconciliation': {
      async claimCommerceOrderReconciliationTargetsInPostgres() {
        trace.claims += 1
        return [{
          organizationId: '11111111-1111-4111-8111-111111111111',
          integrationAccountId: '22222222-2222-4222-8222-222222222222',
          accountGlobalId: 'gca0000001',
          provider: 'faire',
          credentialVersion: 1,
          startedAt: '2026-07-27T12:00:00.000Z',
          recordsSeen: 0,
          recordsHeld: 0,
          continuationBatchNumber: null,
          continuationRunGlobalId: null,
          continuationIdempotencyKey: null,
        }]
      },
      async completeCommerceOrderReconciliationInPostgres(input) {
        trace.complete.push(input)
        return { leaseLost: false }
      },
      async projectCommerceOrderReconciliationPageInPostgres({ target }) {
        return {
          leaseLost: false,
          startedAt: new Date(
            Date.parse(target.startedAt) + 1_000,
          ).toISOString(),
          recordsSeen: page === 1 ? 4 : 6,
          recordsHeld: page === 1 ? 4 : 6,
          continuationBatchNumber: page,
          providerCursorRepeated: false,
        }
      },
      async failCommerceOrderReconciliationInPostgres(input) {
        trace.failed.push(input)
        return { leaseLost: false, errorCode: 'COMMERCE_ORDER_RECONCILIATION_FAILED' }
      },
    },
  },
})
const completed = await worker.processCommerceOrderReconciliation({ limit: 1 })
assert.equal(trace.claims, 1)
assert.equal(completed.claimed, 1)
assert.equal(page, 2, 'worker must consume the continuation page before completion')
assert.equal(completed.pagesRead, 2)
assert.equal(completed.staged, 5)
assert.equal(completed.rejected, 1)
assert.equal(completed.providerWrites, 0)
assert.equal(completed.canonicalOrderWrites, 1)
assert.equal(completed.inventoryWrites, 0)
assert.deepEqual(
  JSON.parse(JSON.stringify(completed.automaticCustomerResolution)),
  {
    matched: 3,
    created: 1,
    ambiguous: 1,
    skipped: 1,
    failed: 1,
    failedByCode: {
      COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1,
    },
    operatorReviewRequired: 3,
    providerWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(completed.automaticFaireOrderPromotion)),
  {
    ...currentFaireGateHealth,
    promoted: 1,
    held: 2,
    failed: 1,
    failedByCode: {
      COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1,
    },
    attentionRequiredAccounts: 0,
    operatorReviewRequired: 3,
    providerWrites: 0,
    canonicalOrderWrites: 1,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.equal(trace.complete.length, 1)
assert.equal(trace.complete[0].pagesRead, 2)
assert.equal(trace.complete[0].hasNextBatch, false)
assert.equal(trace.complete[0].customersMatched, 3)
assert.equal(trace.complete[0].customersCreated, 1)
assert.equal(trace.complete[0].customersAmbiguous, 1)
assert.equal(trace.complete[0].customersSkipped, 1)
assert.equal(trace.complete[0].customerResolutionFailed, 1)
assert.equal(trace.complete[0].faireOrdersPromoted, 1)
assert.equal(trace.complete[0].faireOrdersHeld, 2)
assert.equal(trace.complete[0].fairePromotionFailed, 1)
assert.deepEqual(
  { ...trace.complete[0].fairePromotionFailureCodes },
  { COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED: 1 },
)
assert.deepEqual(
  { ...trace.complete[0].customerResolutionFailureCodes },
  { COMMERCE_CUSTOMER_AUTO_RESOLUTION_FAILED: 1 },
)
assert.equal(trace.failed.length, 0)
assert.deepEqual(
  { ...completed.failureCodes },
  {},
  'Successful order reconciliation must report no failure categories',
)

let shopifyCompletionInput = null
const shopifyWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 4,
              ordersPreserved: 2,
              ordersSkippedCanonical: 1,
              recordsRejected: 0,
              automaticCustomerResolution: {
                matched: 1,
                created: 0,
                ambiguous: 0,
                skipped: 0,
                failed: 0,
                failedByCode: {},
                providerWrites: 0,
                syncCursorAdvanced: false,
              },
              automaticShopifyOrderPromotion: {
                promoted: 1,
                held: 2,
                actionableHeld: 2,
                heldByReason: {
                  checkout_rate_lineage_missing: 1,
                  physical_shipping_required: 1,
                },
                failed: 1,
                failedByCode: {
                  COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED: 1,
                },
                rollbackFenced: 1,
                providerWrites: 0,
                canonicalOrderWrites: 1,
                inventoryWrites: 0,
                syncCursorAdvanced: false,
              },
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000200',
                providerRowsSeen: 7,
                hasNextBatch: false,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            organizationId: '11111111-1111-4111-8111-111111111111',
            integrationAccountId: '22222222-2222-4222-8222-222222222222',
            accountGlobalId: 'gia0009201',
            provider: 'shopify',
            credentialVersion: 3,
            startedAt: '2026-08-01T12:00:00.000Z',
            recordsSeen: 0,
            recordsHeld: 0,
            continuationBatchNumber: null,
            continuationRunGlobalId: null,
            continuationIdempotencyKey: null,
          }]
        },
        async projectCommerceOrderReconciliationPageInPostgres() {
          return {
            leaseLost: false,
            startedAt: '2026-08-01T12:00:01.000Z',
            recordsSeen: 7,
            recordsHeld: 4,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          shopifyCompletionInput = input
          return {
            leaseLost: false,
            shopifyAutomaticPromotionAttentionRequired: true,
          }
        },
        async failCommerceOrderReconciliationInPostgres() {
          assert.fail('Shopify clean-path counters must complete successfully')
        },
      },
    },
  },
)
const shopifySummary = await shopifyWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(shopifySummary.canonicalOrderWrites, 1)
assert.equal(shopifySummary.providerRecordsSeen, 7)
assert.equal(shopifySummary.staged, 4)
assert.equal(shopifySummary.preserved, 2)
assert.equal(shopifySummary.skippedCanonical, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    shopifySummary.automaticShopifyOrderPromotion,
  )),
  {
    policyVersion: 'commerce-shopify-order-auto-promotion-v1',
    enabled: false,
    runtimeEligible: false,
    cohortConfigured: false,
    cohortValid: false,
    cohortSize: 0,
    disabledReason: 'development_runtime_required',
    promoted: 1,
    held: 2,
    actionableHeld: 2,
    heldByReason: {
      checkout_rate_lineage_missing: 1,
      physical_shipping_required: 1,
    },
    failed: 1,
    failedByCode: {
      COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED: 1,
    },
    rollbackFenced: 1,
    attentionRequiredAccounts: 1,
    operatorReviewRequired: 3,
    providerWrites: 0,
    canonicalOrderWrites: 1,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.equal(shopifyCompletionInput.shopifyOrdersPromoted, 1)
assert.equal(shopifyCompletionInput.shopifyOrdersHeld, 2)
assert.equal(shopifyCompletionInput.shopifyPromotionActionableHeld, 2)
assert.equal(shopifyCompletionInput.shopifyPromotionFailed, 1)
assert.equal(shopifyCompletionInput.shopifyPromotionRollbackFenced, 1)
assert.deepEqual(
  { ...shopifyCompletionInput.shopifyPromotionHeldReasons },
  {
    checkout_rate_lineage_missing: 1,
    physical_shipping_required: 1,
  },
)

const recoveredIntentKey = '018f0f50-28ec-7af5-a3fb-9bcbe43ea204'
const recoveredTrace = { requestedKeys: [], complete: 0, failed: 0 }
const recoveredWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage(input) {
          recoveredTrace.requestedKeys.push(input.idempotencyKey)
          assert.equal(input.continuationRunGlobalId, 'gcir0000099')
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 1,
              recordsRejected: 0,
              pagination: {
                batchNumber: 2,
                runGlobalId: 'gcir0000100',
                providerRowsSeen: 1,
                hasNextBatch: false,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            ...failureTarget,
            continuationBatchNumber: 1,
            continuationRunGlobalId: 'gcir0000099',
            continuationIdempotencyKey: recoveredIntentKey,
          }]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          recoveredTrace.complete += 1
          return { leaseLost: false }
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: 1,
            recordsHeld: 1,
            continuationBatchNumber: 2,
            providerCursorRepeated: false,
          }
        },
        async failCommerceOrderReconciliationInPostgres() {
          recoveredTrace.failed += 1
          return {
            leaseLost: false,
            errorCode: 'COMMERCE_ORDER_RECONCILIATION_FAILED',
          }
        },
      },
    },
  },
)
const recovered = await recoveredWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.deepEqual(recoveredTrace.requestedKeys, [recoveredIntentKey])
assert.equal(recoveredTrace.complete, 1)
assert.equal(recoveredTrace.failed, 0)
assert.equal(recovered.staged, 1)
assert.equal(recovered.providerWrites, 0)

const priorExactRefreshLimit =
  process.env.CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES
process.env.CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES = '3'
const exactRefreshTrace = {
  listPages: 0,
  selections: [],
  reads: [],
  attention: [],
  attentionResults: [],
  complete: [],
  failed: 0,
}
const exactRefreshCohortHash = 'd'.repeat(64)
const exactRefreshNotBefore = '2026-08-04T12:00:00.000Z'
const exactRefreshWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          exactRefreshTrace.listPages += 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 2,
              recordsRejected: 0,
              automaticFaireOrderPromotion: {
                promoted: 0,
                held: 2,
                failed: 0,
                failedByCode: {},
                operatorReviewRequired: 0,
                providerWrites: 0,
                canonicalOrderWrites: 0,
                inventoryWrites: 0,
                syncCursorAdvanced: false,
              },
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000201',
                providerRowsSeen: 2,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000201',
              },
            },
          }
        },
        async executeCommerceFaireOrderExactRefresh(input) {
          exactRefreshTrace.reads.push(input)
          if (input.candidateGlobalId === 'gcoc0000102') {
            return {
              command: {
                providerWrites: 0,
                syncCursorAdvanced: false,
                ordersStaged: 0,
                recordsRejected: 1,
              },
            }
          }
          if (input.candidateGlobalId === 'gcoc0000103') {
            const error = new Error('simulated exact-refresh target race')
            error.code = 'COMMERCE_INTAKE_REFRESH_TARGET_MISSING'
            throw error
          }
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 1,
              recordsRejected: 0,
              automaticCustomerResolution: {
                matched: 1,
                created: 0,
                ambiguous: 0,
                skipped: 0,
                failed: 0,
                failedByCode: {},
                providerWrites: 0,
                syncCursorAdvanced: false,
              },
              automaticFaireOrderPromotion: {
                promoted: 1,
                held: 0,
                failed: 0,
                failedByCode: {},
                operatorReviewRequired: 0,
                providerWrites: 0,
                canonicalOrderWrites: 1,
                inventoryWrites: 0,
                syncCursorAdvanced: false,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceIntake': {
        async markAutomaticFaireOrderPromotionAttentionInPostgres(input) {
          exactRefreshTrace.attention.push(input)
          const result = {
            marked: input.candidateGlobalId !== 'gcoc0000103',
          }
          exactRefreshTrace.attentionResults.push(result)
          return result
        },
        async readAutomaticFaireExactRefreshTargetsInPostgres(input) {
          exactRefreshTrace.selections.push(input)
          return [
            {
              candidateGlobalId: 'gcoc0000101',
              candidateRowVersion: 4,
              sourceHash: 'a'.repeat(64),
              originatingRunGlobalId: 'gcir0000201',
              cohortHash: exactRefreshCohortHash,
              notBefore: exactRefreshNotBefore,
            },
            {
              candidateGlobalId: 'gcoc0000102',
              candidateRowVersion: 5,
              sourceHash: 'b'.repeat(64),
              originatingRunGlobalId: 'gcir0000201',
              cohortHash: exactRefreshCohortHash,
              notBefore: exactRefreshNotBefore,
            },
            {
              candidateGlobalId: 'gcoc0000103',
              candidateRowVersion: 6,
              sourceHash: 'c'.repeat(64),
              originatingRunGlobalId: 'gcir0000100',
              cohortHash: exactRefreshCohortHash,
              notBefore: exactRefreshNotBefore,
            },
          ].slice(0, input.limit)
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            ...failureTarget,
            provider: 'faire',
            accountGlobalId: 'gca0000201',
            continuationBatchNumber: null,
            continuationRunGlobalId: null,
            continuationIdempotencyKey: null,
          }]
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          exactRefreshTrace.complete.push(input)
          return {
            leaseLost: false,
            faireAutomaticPromotionAttentionRequired: false,
            faireExactRefreshAttentionRequired: true,
          }
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: 2,
            recordsHeld: 2,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
        async failCommerceOrderReconciliationInPostgres() {
          exactRefreshTrace.failed += 1
          return {
            leaseLost: false,
            errorCode: 'COMMERCE_ORDER_RECONCILIATION_FAILED',
          }
        },
      },
    },
  },
)
if (priorExactRefreshLimit === undefined) {
  delete process.env.CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES
} else {
  process.env.CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES =
    priorExactRefreshLimit
}
const exactRefreshSummary = await exactRefreshWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(exactRefreshTrace.listPages, 1)
assert.equal(exactRefreshTrace.failed, 0)
assert.equal(exactRefreshTrace.selections.length, 1)
assert.equal(exactRefreshTrace.selections[0].preferredRunGlobalId, 'gcir0000201')
assert.equal(exactRefreshTrace.selections[0].limit, 3)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    exactRefreshTrace.selections[0].excludedCandidateGlobalIds,
  )),
  [],
)
assert.deepEqual(
  exactRefreshTrace.reads.map((read) => read.candidateGlobalId),
  ['gcoc0000101', 'gcoc0000102', 'gcoc0000103'],
  'The count budget must process current-run targets before retained backlog',
)
assert.equal(new Set(
  exactRefreshTrace.reads.map((read) => read.idempotencyKey),
).size, 3)
for (const read of exactRefreshTrace.reads) {
  assert.match(
    read.idempotencyKey,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
  assert.equal(read.actorEmail, 'system:commerce-order-reconciliation')
  assert.equal(read.expectedCredentialVersion, failureTarget.credentialVersion)
  assert.equal(read.cohortHash, exactRefreshCohortHash)
  assert.equal(read.notBefore, exactRefreshNotBefore)
}
assert.deepEqual(
  exactRefreshTrace.attention.map((entry) => ({
    candidateGlobalId: entry.candidateGlobalId,
    candidateRowVersion: entry.candidateRowVersion,
    sourceHash: entry.sourceHash,
    runGlobalId: entry.runGlobalId,
    reasonCode: entry.reasonCode,
    cohortHash: entry.cohortHash,
    notBefore: entry.notBefore,
  })),
  [
    {
      candidateGlobalId: 'gcoc0000102',
      candidateRowVersion: 5,
      sourceHash: 'b'.repeat(64),
      runGlobalId: 'gcir0000201',
      reasonCode: 'COMMERCE_FAIRE_EXACT_REFRESH_NORMALIZATION_REJECTED',
      cohortHash: exactRefreshCohortHash,
      notBefore: exactRefreshNotBefore,
    },
    {
      candidateGlobalId: 'gcoc0000103',
      candidateRowVersion: 6,
      sourceHash: 'c'.repeat(64),
      runGlobalId: 'gcir0000100',
      reasonCode: 'COMMERCE_INTAKE_REFRESH_TARGET_MISSING',
      cohortHash: exactRefreshCohortHash,
      notBefore: exactRefreshNotBefore,
    },
  ],
  'Each exact rejection or failure marks only its original stale candidate',
)
assert.ok(
  exactRefreshTrace.attention.every(
    (entry) => entry.attentionKind === 'exact_refresh',
  ),
  'Exact-refresh markers must retain exact-refresh provenance',
)
assert.deepEqual(
  exactRefreshTrace.attentionResults.map((result) => result.marked),
  [true, false],
  'A resolved marker race must remain marked:false and non-actionable',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(exactRefreshSummary.automaticFaireExactRefresh)),
  {
    attempted: 3,
    succeeded: 1,
    rejected: 1,
    failed: 1,
    failedByCode: {
      COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1,
    },
    operatorReviewRequired: 1,
    providerWrites: 0,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  },
)
assert.equal(exactRefreshSummary.canonicalOrderWrites, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(exactRefreshSummary.budgetStops)),
  { pages: 0, records: 0, time: 0, exactRefreshes: 1 },
)
assert.equal(exactRefreshSummary.resumable, 1)
assert.equal(
  exactRefreshSummary.automaticFaireOrderPromotion.operatorReviewRequired,
  0,
  'Exact-refresh markers must not inflate promotion-only review counts',
)
assert.equal(
  Object.values(exactRefreshSummary.automaticFaireExactRefresh.failedByCode)
    .reduce((sum, count) => sum + count, 0),
  exactRefreshSummary.automaticFaireExactRefresh.failed,
  'Exact-refresh failure codes must reconcile to failures, not rejections',
)
assert.equal(
  exactRefreshTrace.complete[0].fairePromotionOperatorReviewRequired,
  0,
)
assert.equal(
  exactRefreshTrace.complete[0].faireExactRefreshOperatorReviewRequired,
  1,
  'Only marked:true durable attention outcomes require operator review',
)
assert.equal(exactRefreshTrace.complete[0].faireExactRefreshAttempted, 3)
assert.equal(exactRefreshTrace.complete[0].faireExactRefreshRejected, 1)
assert.equal(exactRefreshTrace.complete[0].faireExactRefreshFailed, 1)
assert.deepEqual(
  { ...exactRefreshTrace.complete[0].faireExactRefreshFailureCodes },
  { COMMERCE_INTAKE_REFRESH_TARGET_MISSING: 1 },
  'Completion must exclude normalization rejections from failure codes',
)
assert.equal(exactRefreshTrace.complete[0].hasNextBatch, true)

const markerFailureTrace = { markerCalls: 0, complete: 0, failed: [] }
const markerFailureWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 1,
              recordsRejected: 0,
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000301',
                providerRowsSeen: 1,
                hasNextBatch: false,
                continuationRunGlobalId: null,
              },
            },
          }
        },
        async executeCommerceFaireOrderExactRefresh() {
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 1,
            },
          }
        },
      },
      '@/lib/persistence/commerceIntake': {
        async readAutomaticFaireExactRefreshTargetsInPostgres() {
          return [{
            candidateGlobalId: 'gcoc0000301',
            candidateRowVersion: 2,
            sourceHash: 'e'.repeat(64),
            originatingRunGlobalId: 'gcir0000301',
            cohortHash: exactRefreshCohortHash,
            notBefore: exactRefreshNotBefore,
          }]
        },
        async markAutomaticFaireOrderPromotionAttentionInPostgres() {
          markerFailureTrace.markerCalls += 1
          throw new Error('simulated durable marker outage')
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: 1,
            recordsHeld: 1,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres() {
          markerFailureTrace.complete += 1
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          markerFailureTrace.failed.push(input)
          return {
            leaseLost: false,
            errorCode: input.error.code,
          }
        },
      },
    },
  },
)
const markerFailureSummary = await markerFailureWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(markerFailureTrace.markerCalls, 1)
assert.equal(markerFailureTrace.complete, 0)
assert.equal(markerFailureTrace.failed.length, 1)
assert.equal(
  markerFailureTrace.failed[0].error.code,
  'COMMERCE_FAIRE_AUTO_PROMOTION_ATTENTION_PERSIST_FAILED',
)
assert.equal(markerFailureSummary.failed, 1)
assert.ok(
  !workerSource.includes('.catch(() => ({ marked: true }))'),
  'A marker failure must fail and retry the reconciliation target, never synthesize durable attention',
)

const boundedTrace = { pages: 0, complete: [], failed: [] }
const boundedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          boundedTrace.pages += 1
          const batchNumber = boundedTrace.pages
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber,
                runGlobalId: `gcir00001${String(batchNumber).padStart(2, '0')}`,
                providerRowsSeen: 50,
                hasNextBatch: true,
                continuationRunGlobalId:
                  `gcir00001${String(batchNumber).padStart(2, '0')}`,
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: boundedTrace.pages * 50,
            recordsHeld: 0,
            continuationBatchNumber: boundedTrace.pages,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          boundedTrace.complete.push(input)
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          boundedTrace.failed.push(input)
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const boundedSummary = await boundedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(boundedTrace.pages, 5)
assert.equal(boundedTrace.complete.length, 1)
assert.equal(boundedTrace.complete[0].hasNextBatch, true)
assert.equal(boundedTrace.failed.length, 0)
assert.equal(boundedSummary.pagesRead, 5)
assert.equal(boundedSummary.resumable, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(boundedSummary.budgetStops)),
  { pages: 1, records: 0, time: 0, exactRefreshes: 0 },
  'A long chain must yield its encrypted continuation at the page budget',
)

const timeTrace = { pages: 0, complete: [] }
const timeWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          timeTrace.pages += 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber: 1,
                runGlobalId: 'gcir0000201',
                providerRowsSeen: 1,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000201',
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres() {
          return {
            leaseLost: false,
            startedAt: '2026-07-27T12:00:01.000Z',
            recordsSeen: 1,
            recordsHeld: 0,
            continuationBatchNumber: 1,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres(input) {
          timeTrace.complete.push(input)
          return { leaseLost: false }
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
let clockCalls = 0
const timeSummary = await timeWorker.processCommerceOrderReconciliation({
  limit: 1,
  clock: () => clockCalls++ === 0 ? 0 : 150_000,
})
assert.equal(timeTrace.pages, 1)
assert.equal(timeTrace.complete[0].hasNextBatch, true)
assert.deepEqual(
  JSON.parse(JSON.stringify(timeSummary.budgetStops)),
  { pages: 0, records: 0, time: 1, exactRefreshes: 0 },
  'A near-deadline worker must persist its continuation without another read',
)

const repeatedTrace = { pages: 0, failureCode: null }
const repeatedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          repeatedTrace.pages += 1
          const first = repeatedTrace.pages === 1
          return {
            command: {
              providerWrites: 0,
              syncCursorAdvanced: false,
              ordersStaged: 0,
              recordsRejected: 0,
              pagination: {
                batchNumber: first ? 1 : 2,
                runGlobalId: first ? 'gcir0000301' : 'gcir0000302',
                providerRowsSeen: 1,
                hasNextBatch: true,
                continuationRunGlobalId: 'gcir0000301',
              },
            },
          }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{ ...failureTarget, provider: 'faire' }]
        },
        async projectCommerceOrderReconciliationPageInPostgres({ target }) {
          return {
            leaseLost: false,
            startedAt: new Date(
              Date.parse(target.startedAt) + 1_000,
            ).toISOString(),
            recordsSeen: repeatedTrace.pages,
            recordsHeld: 0,
            continuationBatchNumber: repeatedTrace.pages,
            providerCursorRepeated: false,
          }
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('Repeated continuation must fail closed')
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          repeatedTrace.failureCode = input.error.code
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const repeatedSummary = await repeatedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(repeatedTrace.pages, 2)
assert.equal(
  repeatedTrace.failureCode,
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
)
assert.deepEqual(
  { ...repeatedSummary.failureCodes },
  { COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED: 1 },
)

let oversizedProviderCalls = 0
const oversizedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          oversizedProviderCalls += 1
          throw new Error('The terminal budget must stop before provider I/O')
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [{
            ...failureTarget,
            provider: 'faire',
            recordsSeen: 100_000,
            continuationBatchNumber: 1_999,
            continuationRunGlobalId: 'gcir0000405',
          }]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('Terminal session budget must not complete')
        },
        async failCommerceOrderReconciliationInPostgres(input) {
          return { leaseLost: false, errorCode: input.error.code }
        },
      },
    },
  },
)
const oversizedSummary = await oversizedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(oversizedProviderCalls, 0)
assert.deepEqual(
  { ...oversizedSummary.failureCodes },
  { COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED: 1 },
  'An oversized session must enter a deterministic terminal state',
)

const failedWorker = loadTypeScriptModule(
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  {
    mocks: {
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
        async executeCommerceOrderPage() {
          const error = new Error('sensitive provider response omitted')
          error.code = '23514'
          throw error
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async claimCommerceOrderReconciliationTargetsInPostgres() {
          return [failureTarget]
        },
        async completeCommerceOrderReconciliationInPostgres() {
          throw new Error('completion must not run after failure')
        },
        async failCommerceOrderReconciliationInPostgres() {
          return {
            leaseLost: false,
            errorCode: 'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID',
          }
        },
      },
    },
  },
)
const failedSummary = await failedWorker
  .processCommerceOrderReconciliation({ limit: 1 })
assert.equal(failedSummary.failed, 1)
assert.deepEqual(
  { ...failedSummary.failureCodes },
  { COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID: 1 },
  'Worker summary must expose only the stable allowlisted failure category',
)

const completedRouteHeartbeats = []
let completedRouteReconciliationCalls = 0
const completedRouteWorkerOrder = []
let completedRouteHistoryShouldFail = false
const completedRouteRunResult = {
  automaticShopifyOrderPromotion:
    shopifyPromotionPolicy.shopifyAutomaticOrderPromotionHealthSnapshot({
      heartbeat: {
        attentionRequiredAccounts: 1,
        operatorReviewRequired: 1,
      },
    }),
  automaticFaireOrderPromotion:
    fairePromotionPolicy.faireAutomaticOrderPromotionHealthSnapshot({
      heartbeat: {
        attentionRequiredAccounts: 1,
        operatorReviewRequired: 1,
      },
    }),
  automaticFaireExactRefresh:
    fairePromotionPolicy.faireAutomaticExactRefreshHealthSnapshot({
      operatorReviewRequired: 1,
    }),
  automaticFaireUnattributedAttention:
    fairePromotionPolicy.faireUnattributedAttentionHealthSnapshot({
      attentionRequiredAccounts: 1,
      operatorReviewRequired: 1,
    }),
}
const completedRouteModule = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
  {
    mocks: {
      'next/server': {
        NextRequest: class NextRequest {},
        NextResponse: {
          json(body, init = {}) {
            return { body, status: init.status || 200 }
          },
        },
      },
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => true,
      },
      '@/lib/commerceOrderReconciliationWorker': {
        async processCommerceOrderReconciliation() {
          completedRouteReconciliationCalls += 1
          return completedRouteRunResult
        },
      },
      '@/lib/commerceOrderHistoryWorker': {
        async processCommerceOrderHistory() {
          completedRouteWorkerOrder.push('history:start')
          if (completedRouteHistoryShouldFail) {
            const error = new Error('provider secret response must not escape')
            error.code = 'COMMERCE_ORDER_HISTORY_CURSOR_INVALID'
            throw error
          }
          completedRouteWorkerOrder.push('history:complete')
          return {
            claimed: 0,
            providerReads: 0,
            providerReadOnly: true,
            operationsOrderWrites: 0,
            providerWrites: 0,
          }
        },
      },
      '@/lib/shopifyOrderWebhookWorker': {
        async processShopifyOrderWebhookSignals() {
          completedRouteWorkerOrder.push('webhook:start')
          return {
            claimed: 0,
            providerReads: 0,
            providerReadOnly: true,
            operationsOrderWrites: 0,
            providerWrites: 0,
          }
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled: () => true,
      },
      '@/lib/persistence/commerceOrderSync': {
        async redactExpiredCommerceOrderSensitiveEvidenceInPostgres() {
          return { redacted: 0, providerWrites: 0 }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async readCommerceOrderReconciliationHealthFromPostgres() {
          return {
            providerPromotionAttentionRequired: {
              shopify: 2,
              faire: 3,
            },
            faireExactRefreshAttentionRequired: 4,
            faireUnattributedAttentionRequired: 5,
            operatorAttentionRequired: 8,
          }
        },
        async recordCommerceOrderReconciliationWorkerHeartbeatInPostgres(
          input,
        ) {
          completedRouteHeartbeats.push(input)
          return { checkedAt: '2026-08-04T22:45:00.000Z' }
        },
      },
    },
  },
)
const priorWorkerSecret = process.env.PIPELINE_OUTBOX_WORKER_SECRET
const completedRouteSecret = 's'.repeat(40)
process.env.PIPELINE_OUTBOX_WORKER_SECRET = completedRouteSecret
let completedRouteResponse
try {
  completedRouteResponse = await completedRouteModule.POST({
    headers: {
      get(name) {
        return name === 'authorization'
          ? `Bearer ${completedRouteSecret}`
          : null
      },
    },
    async json() {
      return { limit: 1 }
    },
  })
} finally {
  if (priorWorkerSecret === undefined) {
    delete process.env.PIPELINE_OUTBOX_WORKER_SECRET
  } else {
    process.env.PIPELINE_OUTBOX_WORKER_SECRET = priorWorkerSecret
  }
}
assert.equal(completedRouteResponse.status, 200)
assert.ok(
  completedRouteWorkerOrder.indexOf('webhook:start')
    > completedRouteWorkerOrder.indexOf('history:complete'),
  'Webhook exact reads must start after history policy transitions complete',
)
assert.equal(completedRouteHeartbeats.length, 2)
assert.equal(completedRouteReconciliationCalls, 1)
const completedRouteHeartbeat = completedRouteHeartbeats[1]
assert.equal(completedRouteHeartbeat.phase, 'completed')
assert.equal(
  completedRouteHeartbeat.automaticShopifyOrderPromotion
    .attentionRequiredAccounts,
  2,
  'A completed limited batch must retain durable attention on unclaimed Shopify accounts',
)
assert.equal(
  completedRouteHeartbeat.automaticFaireOrderPromotion
    .attentionRequiredAccounts,
  3,
  'A completed limited batch must retain durable promotion attention on unclaimed Faire accounts',
)
assert.equal(
  completedRouteHeartbeat.automaticFaireExactRefresh.operatorReviewRequired,
  4,
  'A completed limited batch must retain durable exact-refresh attention on unclaimed Faire accounts',
)
assert.equal(
  completedRouteResponse.body.automaticFaireExactRefresh
    .operatorReviewRequired,
  4,
)
assert.equal(
  completedRouteHeartbeat.automaticFaireUnattributedAttention
    .attentionRequiredAccounts,
  5,
  'Legacy unattributed attention must survive a completed limited batch',
)

completedRouteHistoryShouldFail = true
process.env.PIPELINE_OUTBOX_WORKER_SECRET = completedRouteSecret
let isolatedHistoryFailureResponse
try {
  isolatedHistoryFailureResponse = await completedRouteModule.POST({
    headers: {
      get(name) {
        return name === 'authorization'
          ? `Bearer ${completedRouteSecret}`
          : null
      },
    },
    async json() {
      return { limit: 1 }
    },
  })
} finally {
  completedRouteHistoryShouldFail = false
  if (priorWorkerSecret === undefined) {
    delete process.env.PIPELINE_OUTBOX_WORKER_SECRET
  } else {
    process.env.PIPELINE_OUTBOX_WORKER_SECRET = priorWorkerSecret
  }
}
assert.equal(isolatedHistoryFailureResponse.status, 200)
assert.equal(completedRouteReconciliationCalls, 2)
assert.equal(isolatedHistoryFailureResponse.body.orderHistory.degraded, true)
assert.equal(
  isolatedHistoryFailureResponse.body.orderHistory.errorCode,
  'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
)
assert.equal(isolatedHistoryFailureResponse.body.orderHistory.providerWrites, 0)
assert.equal(
  isolatedHistoryFailureResponse.body.orderHistory.operationsOrderWrites,
  0,
)
assert.equal(
  JSON.stringify(isolatedHistoryFailureResponse.body).includes(
    'provider secret response must not escape',
  ),
  false,
)
assert.equal(completedRouteHeartbeats.at(-1).phase, 'completed')

let disabledRoutePurgeCalls = 0
let disabledRouteRedactionCalls = 0
let disabledRouteWorkerCalls = 0
const disabledRouteMaintenanceCallsBefore =
  commerceStorageMaintenanceTrace.length
const disabledRouteModule = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
  {
    mocks: {
      'next/server': {
        NextRequest: class NextRequest {},
        NextResponse: {
          json(body, init = {}) {
            return { body, status: init.status || 200 }
          },
        },
      },
      '@/lib/integrations/commerceIntake': {
        commerceReadRuntimeAvailable: () => false,
      },
      '@/lib/commerceOrderReconciliationWorker': {
        async processCommerceOrderReconciliation() {
          disabledRouteWorkerCalls += 1
          assert.fail('disabled commerce intake must not start provider reconciliation')
        },
      },
      '@/lib/commerceOrderHistoryWorker': {
        async processCommerceOrderHistory() {
          disabledRouteWorkerCalls += 1
          assert.fail('disabled commerce intake must not start order history')
        },
      },
      '@/lib/shopifyOrderWebhookWorker': {
        async processShopifyOrderWebhookSignals() {
          disabledRouteWorkerCalls += 1
          assert.fail('disabled commerce intake must not start Shopify order webhook reads')
        },
      },
      '@/lib/persistence/config': {
        isPostgresStorageEnabled: () => true,
      },
      '@/lib/persistence/commerceOrderRevisions': {
        async purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres() {
          disabledRoutePurgeCalls += 1
          return {
            schemaAvailable: true,
            skipped: false,
            limit: 250,
            purged: 1,
            expiredProtectedReadBacklog: 0,
            backlogTruncated: false,
          }
        },
      },
      '@/lib/persistence/commerceOrderSync': {
        async redactExpiredCommerceOrderSensitiveEvidenceInPostgres() {
          disabledRouteRedactionCalls += 1
          return { redacted: 2, providerWrites: 0 }
        },
      },
      '@/lib/persistence/commerceOrderReconciliation': {
        async readCommerceOrderReconciliationHealthFromPostgres() {
          assert.fail('disabled retention-only route must not read reconciliation health')
        },
        async recordCommerceOrderReconciliationWorkerHeartbeatInPostgres() {
          assert.fail('disabled retention-only route must not write a reconciliation heartbeat')
        },
      },
    },
  },
)
process.env.PIPELINE_OUTBOX_WORKER_SECRET = completedRouteSecret
let disabledRouteResponse
try {
  disabledRouteResponse = await disabledRouteModule.POST({
    headers: {
      get(name) {
        return name === 'authorization'
          ? `Bearer ${completedRouteSecret}`
          : null
      },
    },
  })
} finally {
  if (priorWorkerSecret === undefined) {
    delete process.env.PIPELINE_OUTBOX_WORKER_SECRET
  } else {
    process.env.PIPELINE_OUTBOX_WORKER_SECRET = priorWorkerSecret
  }
}
assert.equal(disabledRouteResponse.status, 200)
assert.equal(disabledRouteResponse.body.skipped, true)
assert.equal(disabledRouteResponse.body.protectedSnapshotPurge.purged, 1)
assert.equal(
  disabledRouteResponse.body.orderSensitiveEvidenceRedaction.redacted,
  2,
)
assert.equal(disabledRoutePurgeCalls, 1)
assert.equal(disabledRouteRedactionCalls, 1)
assert.equal(disabledRouteWorkerCalls, 0)
assert.equal(
  commerceStorageMaintenanceTrace.length,
  disabledRouteMaintenanceCallsBefore + 1,
  'Disabled order processing must still offer permanent storage maintenance',
)
assert.equal(
  commerceStorageMaintenanceTrace.at(-1)?.workerId,
  'commerce-orders-process-route',
)
assert.equal(
  disabledRouteResponse.body.commerceStorageMaintenance.status,
  'not_due',
)
assert.equal(
  disabledRouteResponse.body.orderSensitiveEvidenceRedaction.providerWrites,
  0,
)
assert.notEqual(
  completedRouteHeartbeat.automaticFaireExactRefresh.operatorReviewRequired,
  8,
  'Aggregate account attention must not be projected back into an exact subtype',
)

const route = read('app_src/app/api/integrations/commerce/orders/process/route.ts')
includes(route, [
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'timingSafeEqual',
  'commerceReadRuntimeAvailable()',
  'isPostgresStorageEnabled()',
  'processCommerceOrderReconciliation',
  'processShopifyOrderWebhookSignals',
  'recordCommerceOrderReconciliationWorkerHeartbeatInPostgres',
  'readCommerceOrderReconciliationHealthFromPostgres',
  'durableAutomaticAttentionHealth',
  'mergeDurableAutomaticAttentionHealth',
  'health?.providerPromotionAttentionRequired.shopify',
  'health?.providerPromotionAttentionRequired.faire',
  'health?.faireExactRefreshAttentionRequired',
  'health?.faireUnattributedAttentionRequired',
  "phase: 'started'",
  "phase: 'completed'",
  "phase: 'maintenance'",
  "phase: 'failed'",
  'await Promise.allSettled([(async () => {',
  'return maintenance',
  'isIntegrationCredentialRuntimeGateError(error)',
  'status: 503',
  "'Retry-After': '60'",
  'providerReadOnly: true',
  "commerceReadRuntimeMode?.() === 'development'",
  'shopifyAutomaticOrderPromotionHealthSnapshot',
  'faireAutomaticOrderPromotionHealthSnapshot',
  'faireAutomaticExactRefreshHealthSnapshot',
  'faireUnattributedAttentionHealthSnapshot',
], 'Order reconciliation route')
assert.ok(
  !route.includes('readOnly: true'),
  'The order worker must not claim that local canonical promotion is read-only',
)
assert.ok(
  !route.includes('health?.operatorAttentionRequired'),
  'Aggregate attention must not feed back into a classified subtype',
)
const poller = read('scripts/pipeline-outbox-poller.mjs')
includes(poller, [
  "runLoop('commerce-order-reconciliation'",
  '/api/integrations/commerce/orders/process',
], 'Order reconciliation poller')
assert.ok(
  !/commerceOrderReconciliationEnabled[\s\S]{0,2000}runLoop\('commerce-order-reconciliation'/u.test(poller),
  'retention maintenance must schedule independently of commerce intake',
)
const proxy = read('app_src/proxy.ts')
includes(proxy, ['/api/integrations/commerce/orders/process'], 'Order reconciliation proxy allowlist')
const health = read('app_src/app/api/health/route.ts')
includes(health, [
  "WHERE filename = '0122_operations_commerce_incomplete_header_money.sql'",
  'row?.operations_commerce_incomplete_header_money_migration_applied',
  "'0173_operations_shopify_shipping_service_codes.sql'",
  "'0251_operations_commerce_order_attention_kinds.sql'",
  'row?.operations_shopify_shipping_service_codes_applied',
  'commerceOrderReconciliationWorker',
  'readCommerceOrderReconciliationHealthFromPostgres',
  'Commerce order reconciliation worker heartbeat is missing or stale.',
  'orderState.operatorAttentionRequired > 0',
  'automatic local order promotion needs operator attention',
  'shopifyAutomaticOrderPromotionHealthSnapshot',
  'faireAutomaticOrderPromotionHealthSnapshot',
  'faireAutomaticExactRefreshHealthSnapshot',
  'faireUnattributedAttentionHealthSnapshot',
  'orderHeartbeat?.automaticFaireExactRefresh',
  'orderHeartbeat?.automaticFaireUnattributedAttention',
  'Legacy Faire order attention needs operator review',
], 'Order reconciliation health migration gate')
const reconciliationPersistence = read(
  'app_src/lib/persistence/commerceOrderReconciliation.ts',
)
includes(reconciliationPersistence, [
  'commerce_order_reconciliation_worker_heartbeat',
  'readCommerceOrderReconciliationHealthFromPostgres',
  "account.provider IN ('shopify', 'faire')",
  "cursor.resource = 'orders'",
  'stale_processing',
  'automatic_promotion_attention_required',
  'automatic_exact_refresh_attention_required',
  'automatic_unattributed_attention_required',
  'promotion_attention_required',
  'overdue',
  'providerAccounts',
  'promotionAttentionRequired',
  'faireExactRefreshAttentionRequired',
  'faireUnattributedAttentionRequired',
  'operatorAttentionRequired',
  'automaticPromotionAttentionRequired',
], 'Order reconciliation durable health')
const predeploy = read('scripts/verify-predeploy.mjs')
includes(predeploy, [
  "'db/migrations/0122_operations_commerce_incomplete_header_money.sql'",
  "'db/migrations/0173_operations_shopify_shipping_service_codes.sql'",
  "'db/migrations/0251_operations_commerce_order_attention_kinds.sql'",
  "'scripts/test-commerce-order-reconciliation.mjs'",
], 'Order reconciliation predeploy gate')

console.log('Commerce order reconciliation contract tests passed.')
