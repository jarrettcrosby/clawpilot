#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(diagnostics, [])
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Array,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED = '1'
process.env.CLAWPILOT_ENV = 'production'
const commerceReadRuntime = loadTypeScriptModule(
  'app_src/lib/integrations/commerceReadRuntime.ts',
)

const migration = read(
  'db/migrations/0223_operations_faire_inventory_observation_polling.sql',
)
includes(migration, [
  'operations_faire_inventory_poll_jobs',
  'operations_faire_inventory_observations',
  'idx_operations_faire_inventory_poll_active_account',
  "authority = 'faire_channel_listing_observation'",
  'wms_projection_applied = false',
  'provider_writes = 0',
  'protect_operations_faire_inventory_observation',
  'append-only',
], 'Faire inventory polling migration')
assert.ok(
  !migration.includes('operations_commerce_product_intake_policies'),
  'Faire inventory polling must not couple to the paused product policy',
)

const persistence = read(
  'app_src/lib/persistence/faireInventoryPolling.ts',
)
includes(persistence, [
  "const POLL_INTERVAL = '30 minutes'",
  "const POLL_LEASE = '10 minutes'",
  "credential.auth_mode = 'faire_brand_token'",
  "? 'READ_INVENTORIES'",
  'commerceStoreSyncRunningSql',
  'STORE_SYNC_RUNNING_SQL',
  'FOR UPDATE OF job SKIP LOCKED',
  'lease_expires_at <= clock_timestamp()',
  'FAIRE_INVENTORY_POLL_RETRY_LIMIT_EXCEEDED',
  'recoverFaireInventoryPollInPostgres',
  'managerRecoveryRequired',
  "eventTransport: 'scheduled_poll'",
  'webhookSupported: false',
  'wmsInventoryAuthoritySupported: false',
  'wmsProjectionApplied: false',
  'providerWrites: 0',
], 'Faire inventory polling persistence')
assert.ok(
  !persistence.includes('commerceCapabilities'),
  'Faire inventory polling must not overlap the shared capability file',
)
assert.ok(
  !persistence.includes('operations_inventory_positions')
    && !persistence.includes('operations_inventory_ledger'),
  'Faire channel observations must not project WMS inventory',
)

const workerSource = read('app_src/lib/faireInventoryPollingWorker.ts')
includes(workerSource, [
  'probeFaireBrandProfile',
  'listFaireInventory',
  "credential.scopes.includes('READ_INVENTORIES')",
  'faireInventoryPollingRuntimeAvailable',
  'withFaireInventoryPollProviderReadFenceInPostgres',
  'FAIRE_INVENTORY_RESPONSE_SCOPE_INVALID',
  'normalizeFaireInventoryObservation',
  'processFaireInventoryPollOutbox',
  'providerWrites: 0',
  'wmsProjectionApplied: false',
], 'Faire inventory polling worker')
assert.ok(
  !workerSource.includes('updateFaireInventory'),
  'Faire inventory polling must not import the provider write method',
)

const trace = {
  profiles: 0,
  inventory: [],
  completions: [],
  failures: [],
  heartbeats: [],
}
let claimed = false
const target = {
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
  accountGlobalId: 'gia0000001',
  externalAccountId: 'brand_123',
  credentialVersion: 4,
  activationRevision: 7,
  selectorAfter: null,
  lockToken: '44444444-4444-4444-8444-444444444444',
  leaseExpiresAt: '2026-08-02T18:10:00.000Z',
  attemptCount: 1,
  maxAttempts: 8,
  recoveredLease: false,
}
const selectors = [{
  channelStateId: '55555555-5555-4555-8555-555555555555',
  channelStateRowVersion: '7',
  channelStateSourceHash: 'a'.repeat(64),
  productMappingId: '66666666-6666-4666-8666-666666666666',
  externalVariantId: 'variant-one',
}, {
  channelStateId: '77777777-7777-4777-8777-777777777777',
  channelStateRowVersion: '2',
  channelStateSourceHash: 'b'.repeat(64),
  productMappingId: '88888888-8888-4888-8888-888888888888',
  externalVariantId: 'variant-missing',
}]

const worker = loadTypeScriptModule(
  'app_src/lib/faireInventoryPollingWorker.ts',
  {
    '@/lib/integrations/commerceReadRuntime': commerceReadRuntime,
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential() {
        return {
          provider: 'faire',
          authMode: 'faire_oauth',
          applicationId: 'application-id',
          applicationSecret: 'application-secret-long-enough',
          accessToken: 'faire-access-token',
          scopes: ['READ_INVENTORIES'],
        }
      },
    },
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError: class CommerceIntegrationRequestError extends Error {
        constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
          super(message)
          this.status = status
          this.code = code
        }
      },
    },
    '@/lib/integrations/faireCommerceClient': {
      async probeFaireBrandProfile() {
        trace.profiles += 1
        return { brand_id: 'brand_123' }
      },
      async listFaireInventory(_options, query) {
        trace.inventory.push(query)
        return {
          inventories: {
            'variant-one': {
              on_hand_quantity: { type: 'QUANTITY', quantity: 5 },
              committed_quantity: { type: 'QUANTITY', quantity: 9 },
              available_quantity: { type: 'QUANTITY', quantity: -4 },
            },
          },
        }
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      async readCommerceRuntimeCredentialFromPostgres() {
        return {
          organizationId: target.organizationId,
          integrationAccountId: target.integrationAccountId,
          globalId: target.accountGlobalId,
          provider: 'faire',
          environment: 'production',
          externalAccountId: target.externalAccountId,
          status: 'active',
          verificationStatus: 'verified',
          credentialVersion: target.credentialVersion,
          authMode: 'faire_oauth',
          configuration: { requestedScopes: ['READ_INVENTORIES'] },
          encrypted: {},
        }
      },
    },
    '@/lib/persistence/faireInventoryPolling': {
      async queueAutomaticFaireInventoryPollsInPostgres() {
        return { queued: 1, cancelled: 0 }
      },
      async claimFaireInventoryPollJobsInPostgres() {
        if (claimed) return []
        claimed = true
        return [target]
      },
      async readFaireInventoryPollSelectorsInPostgres() {
        return {
          selectors,
          hasMore: false,
          nextSelectorAfter: null,
        }
      },
      async withFaireInventoryPollProviderReadFenceInPostgres(input) {
        return input.read()
      },
      async completeFaireInventoryPollPageInPostgres(input) {
        trace.completions.push(input)
        return {
          leaseLost: false,
          completed: true,
          continued: false,
          variantsObserved: input.observations.length,
          quantityCount: 3,
          untrackedCount: 0,
          missingCount: 1,
        }
      },
      async failFaireInventoryPollJobInPostgres(input) {
        trace.failures.push(input)
        return { leaseLost: false, dead: true, retrying: false }
      },
      async recordFaireInventoryPollWorkerHeartbeatInPostgres(input) {
        trace.heartbeats.push(input)
      },
    },
  },
)

const result = await worker.processFaireInventoryPollOutbox({
  limit: 1,
  workerId: 'faire-inventory-contract',
})
assert.equal(result.autoQueued, 1)
assert.equal(result.claimed, 1)
assert.equal(result.completed, 1)
assert.equal(result.variantsObserved, 2)
assert.equal(result.quantityFactsObserved, 3)
assert.equal(result.missingVariantsObserved, 1)
assert.equal(result.providerWrites, 0)
assert.equal(result.wmsProjectionApplied, false)
assert.equal(result.webhookSupported, false)
assert.equal(trace.profiles, 1)
assert.deepEqual(
  JSON.parse(JSON.stringify(trace.inventory[0])),
  { productVariantIds: ['variant-one', 'variant-missing'] },
)
assert.equal(trace.completions.length, 1)
assert.equal(trace.failures.length, 0)
const [present, missing] = trace.completions[0].observations
assert.equal(present.onHandQuantity, 5)
assert.equal(present.committedQuantity, 9)
assert.equal(present.availableQuantity, -4)
assert.equal(present.providerRecordState, 'present')
assert.equal(missing.providerRecordState, 'missing')
assert.equal(missing.onHandState, 'missing')
assert.equal(missing.availableQuantity, null)
assert.match(present.sourceHash, /^[a-f0-9]{64}$/)

const untracked = worker.normalizeFaireInventoryObservation(selectors[0], {
  on_hand_quantity: { type: 'UNTRACKED' },
  committed_quantity: { type: 'UNTRACKED' },
  available_quantity: { type: 'UNTRACKED' },
})
assert.equal(untracked.onHandState, 'untracked')
assert.equal(untracked.committedQuantity, null)
assert.equal(untracked.availableState, 'untracked')

let deniedClaimed = false
const deniedTrace = { completions: 0, failures: [] }
const deniedWorker = loadTypeScriptModule(
  'app_src/lib/faireInventoryPollingWorker.ts',
  {
    '@/lib/integrations/commerceReadRuntime': commerceReadRuntime,
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential() {
        return {
          provider: 'faire',
          authMode: 'faire_oauth',
          applicationId: 'application-id',
          applicationSecret: 'application-secret-long-enough',
          accessToken: 'faire-access-token',
          // This records the requested scope; it is not provider grant proof.
          scopes: ['READ_INVENTORIES'],
        }
      },
    },
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError: class CommerceIntegrationRequestError extends Error {
        constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
          super(message)
          this.status = status
          this.code = code
        }
      },
    },
    '@/lib/integrations/faireCommerceClient': {
      async probeFaireBrandProfile() {
        return { brand_id: target.externalAccountId }
      },
      async listFaireInventory() {
        throw Object.assign(new Error('Provider denied requested scope'), {
          code: 'FAIRE_ACCESS_DENIED',
        })
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      async readCommerceRuntimeCredentialFromPostgres() {
        return {
          organizationId: target.organizationId,
          integrationAccountId: target.integrationAccountId,
          globalId: target.accountGlobalId,
          provider: 'faire',
          environment: 'production',
          externalAccountId: target.externalAccountId,
          status: 'active',
          verificationStatus: 'verified',
          credentialVersion: target.credentialVersion,
          authMode: 'faire_oauth',
          configuration: { requestedScopes: ['READ_INVENTORIES'] },
          encrypted: {},
        }
      },
    },
    '@/lib/persistence/faireInventoryPolling': {
      async queueAutomaticFaireInventoryPollsInPostgres() {
        return { queued: 0, cancelled: 0 }
      },
      async claimFaireInventoryPollJobsInPostgres() {
        if (deniedClaimed) return []
        deniedClaimed = true
        return [target]
      },
      async readFaireInventoryPollSelectorsInPostgres() {
        return { selectors, hasMore: false, nextSelectorAfter: null }
      },
      async withFaireInventoryPollProviderReadFenceInPostgres(input) {
        return input.read()
      },
      async completeFaireInventoryPollPageInPostgres() {
        deniedTrace.completions += 1
        return { leaseLost: false, completed: true, continued: false }
      },
      async failFaireInventoryPollJobInPostgres(input) {
        deniedTrace.failures.push(input.error.code)
        return { leaseLost: false, dead: true, retrying: false }
      },
      async recordFaireInventoryPollWorkerHeartbeatInPostgres() {},
    },
  },
)
const deniedResult = await deniedWorker.processFaireInventoryPollOutbox({
  limit: 1,
  workerId: 'faire-inventory-denied-contract',
})
assert.equal(deniedResult.dead, 1)
assert.equal(deniedTrace.completions, 0)
assert.deepEqual(deniedTrace.failures, ['FAIRE_ACCESS_DENIED'])

includes(
  read('app_src/app/api/integrations/commerce/inventory/process/route.ts'),
  [
    'processFaireInventoryPollOutbox',
    'recordFaireInventoryPollWorkerHeartbeatInPostgres',
    'faireInventoryPollingRuntimeAvailable',
    'Promise.allSettled',
    'runShopifyLane',
    'runFaireLane',
    '...faire',
    'shopify,',
    'faire,',
  ],
  'Shared inventory process route',
)
includes(
  read('app_src/app/api/integrations/commerce/faire/inventory/route.ts'),
  [
    'readFaireInventoryPollStateFromPostgres',
    'recoverFaireInventoryPollInPostgres',
    'confirmReviewedRecovery',
    'private, no-store',
  ],
  'Faire inventory recovery route',
)
includes(read('app_src/app/api/health/route.ts'), [
  'operations_faire_inventory_polling_applied',
  'readFaireInventoryPollHealthFromPostgres',
  'faireInventoryPollWorker',
  'Faire OAuth accounts that did not request READ_INVENTORIES',
], 'Faire inventory health')

console.log('Faire inventory polling contract tests passed')
