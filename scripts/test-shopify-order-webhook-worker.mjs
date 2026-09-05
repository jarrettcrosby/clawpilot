#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(output, {
    Date,
    Error,
    Math,
    Number,
    Object,
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
      if (specifier === '@/lib/integrations/commerceOrderHistoryReadLimits') {
        return loadTypeScriptModule('app_src/lib/integrations/commerceOrderHistoryReadLimits.ts')
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

const claims = [{
  id: '00000000-0000-4000-8000-000000000010',
  organizationId: '00000000-0000-4000-8000-000000000001',
  integrationAccountId: '00000000-0000-4000-8000-000000000002',
  accountGlobalId: 'gia0009301',
  credentialGeneration: 1,
  policyRevision: 1,
  externalOrderId: 'gid://shopify/Order/9301',
  capturedDirtyVersion: 1,
  signalGlobalId: 'gos0009301',
  claimedProviderUpdatedAt: '2026-08-13T17:00:00.000Z',
  lockToken: '00000000-0000-4000-8000-000000000011',
  attemptCount: 1,
}, {
  id: '00000000-0000-4000-8000-000000000020',
  organizationId: '00000000-0000-4000-8000-000000000001',
  integrationAccountId: '00000000-0000-4000-8000-000000000002',
  accountGlobalId: 'gia0009301',
  credentialGeneration: 1,
  policyRevision: 1,
  externalOrderId: 'gid://shopify/Order/9302',
  capturedDirtyVersion: 1,
  signalGlobalId: 'gos0009302',
  claimedProviderUpdatedAt: '2026-08-13T17:00:00.000Z',
  lockToken: '00000000-0000-4000-8000-000000000021',
  attemptCount: 1,
}]
const reads = []
const revalidations = []
const appends = []
const failures = []
const worker = loadTypeScriptModule(
  'app_src/lib/shopifyOrderWebhookWorker.ts',
  {
    '@/lib/integrations/commerceOrderHistory': {
      async readExactShopifyOrderHistoryObservation(input) {
        reads.push(input)
        if (input.externalOrderId.endsWith('/9302')) {
          const error = new Error('provider unavailable')
          error.code = 'SHOPIFY_ORDER_PROVIDER_UNAVAILABLE'
          throw error
        }
        return {
          provider: 'shopify',
          observation: {
            observationKind: 'webhook_exact_read',
            externalOrderId: input.externalOrderId,
          },
          providerReads: 3,
          providerWrites: 0,
          readAllOrdersScopeObserved: true,
          returnHistoryScopeObserved: true,
        }
      },
    },
    '@/lib/persistence/shopifyOrderWebhookSignals': {
      async claimShopifyOrderWebhookTargetsInPostgres(input) {
        assert.equal(input.workerId, 'webhook-worker-test')
        assert.equal(input.limit, 2)
        return claims
      },
      async assertShopifyOrderWebhookClaimCurrentForProviderReadInPostgres(claim) {
        revalidations.push(claim.id)
      },
      async appendShopifyOrderWebhookExactReadInPostgres(input) {
        appends.push(input)
        return {
          appended: 1,
          preserved: 0,
          linesAppended: 1,
          eventsAppended: 2,
          providerReads: 3,
          providerWrites: 0,
        }
      },
      async failShopifyOrderWebhookExactReadInPostgres(input) {
        failures.push(input)
        return { status: 'failed', providerWrites: 0 }
      },
      async parkShopifyOrderWebhookExactReadForStoreSyncPauseInPostgres() {
        return { parked: true }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
        return input.read({
          id: '00000000-0000-4000-8000-000000000298',
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          authorityKind: input.authorityKind,
          readKind: input.readKind,
          controlRevision: 1,
          activationRevision: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      },
    },
  },
)

const result = await worker.processShopifyOrderWebhookSignals({
  workerId: 'webhook-worker-test',
  limit: 2,
})
assert.equal(reads.length, 2)
assert.deepEqual(revalidations, claims.map((claim) => claim.id))
assert.equal(appends.length, 1)
assert.equal(failures.length, 1)
assert.equal(result.claimed, 2)
assert.equal(result.succeeded, 1)
assert.equal(result.failed, 1)
assert.equal(result.providerReads, 3)
assert.equal(result.providerReadReservations, 10)
assert.equal(result.providerWrites, 0)
assert.equal(result.operationsOrderWrites, 0)
assert.equal(result.eventDrivenDrainCadenceSeconds, 60)
assert.equal(result.scheduledPollBackstopMinutes, 30)
assert.equal(result.limits.maxProviderReadReservationsPerRun, 25)

const route = readFileSync(
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
  'utf8',
)
assert.match(route, /processShopifyOrderWebhookSignalsIsolated/u)
assert.match(route, /shopifyOrderWebhooks/u)
assert.match(route, /Promise\.all\(\[/u)
assert.ok(
  route.indexOf('processCommerceOrderHistoryIsolated({')
    < route.indexOf('await processShopifyOrderWebhookSignalsIsolated({'),
  'The bounded history phase must finish before exact webhook claims start.',
)
const poller = readFileSync('scripts/pipeline-outbox-poller.mjs', 'utf8')
assert.match(
  poller,
  /COMMERCE_ORDER_RECONCILIATION_POLL_MS \|\| 60000/u,
)
assert.match(
  poller,
  /runLoop\('commerce-order-reconciliation', '\/api\/integrations\/commerce\/orders\/process'/u,
)

console.log('Shopify order webhook exact-read worker contract checks passed')
