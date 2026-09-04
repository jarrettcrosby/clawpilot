#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const workerSource = await readFile(
  path.join(root, 'app_src/lib/commerceOrderHistoryWorker.ts'),
  'utf8',
)

function loadWorker(mocks) {
  const output = ts.transpileModule(workerSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'app_src/lib/commerceOrderHistoryWorker.ts',
    reportDiagnostics: true,
  })
  const diagnostics = (output.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  assert.equal(diagnostics.length, 0)
  const loaded = { exports: {} }
  vm.runInNewContext(output.outputText, {
    exports: loaded.exports,
    module: loaded,
    require: (specifier) => mocks[specifier]
      || (specifier === '@/lib/integrations/commerceOrderHistoryReadLimits'
        ? { SHOPIFY_HISTORY_PAGE_MAX_PROVIDER_READS: 6 } : {}),
    Date,
    Error,
    Math,
    Number,
    Object,
    Promise,
  }, { filename: 'app_src/lib/commerceOrderHistoryWorker.ts' })
  return loaded.exports
}

function job(pageCount) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    globalId: 'gcob0000001',
    organizationId: '22222222-2222-4222-8222-222222222222',
    integrationAccountId: '33333333-3333-4333-8333-333333333333',
    accountGlobalId: 'gia0000001',
    provider: 'shopify',
    sessionKind: 'historical_backfill',
    credentialGeneration: 1,
    policyRevision: 1,
    requestedFrom: '2026-06-14T00:00:00.000Z',
    requestedThrough: '2026-08-13T00:00:00.000Z',
    queryHash: 'a'.repeat(64),
    pageCount,
    attemptCount: 1,
    maxAttempts: 8,
    maxPages: 10_000,
    lockToken: '44444444-4444-4444-8444-444444444444',
  }
}

async function runDrainScenario({ finalPage }) {
  let pageCount = 0
  let completed = false
  let claimCalls = 0
  let readCalls = 0
  let appendCalls = 0
  const runtime = loadWorker({
    '@/lib/integrations/commerceOrderHistory': {
      async readCommerceOrderHistoryPage(input) {
        readCalls += 1
        assert.equal(
          input.providerCursor,
          pageCount === 0 ? null : `sealed-cursor-${pageCount}`,
        )
        const succeeds = pageCount + 1 === finalPage
        return {
          provider: 'shopify',
          observations: [],
          nextProviderCursor: succeeds
            ? null
            : `sealed-cursor-${pageCount + 1}`,
          providerRowsSeen: 0,
          providerReads: 6,
          providerWrites: 0,
          readAllOrdersScopeObserved: true,
          returnHistoryScopeObserved: false,
        }
      },
    },
    '@/lib/persistence/commerceOrderSync': {
      async redactExpiredCommerceOrderSensitiveEvidenceInPostgres() {
        return { redacted: 0, providerWrites: 0 }
      },
      async materializeDeferredCommerceOrderHistoryRefreshesInPostgres() {
        return { materialized: 0, skipped: 0, providerWrites: 0 }
      },
      async ensureContinuousCommerceOrderPollsInPostgres() {
        return { scheduled: 0, providerWrites: 0 }
      },
      async claimCommerceOrderBackfillsInPostgres(input) {
        claimCalls += 1
        assert.equal(input.limit, 1)
        return completed ? [] : [job(pageCount)]
      },
      async readCommerceOrderBackfillCursorFromPostgres(claimedJob) {
        assert.equal(claimedJob.pageCount, pageCount)
        return pageCount === 0 ? null : `sealed-cursor-${pageCount}`
      },
      async appendCommerceOrderBackfillPageInPostgres(input) {
        appendCalls += 1
        assert.equal(input.pageNumber, pageCount + 1)
        assert.equal(input.hasNextPage, pageCount + 1 !== finalPage)
        pageCount += 1
        completed = pageCount === finalPage
        return {
          status: completed ? 'succeeded' : 'pending',
          appended: 0,
          preserved: 0,
        }
      },
      async failCommerceOrderBackfillInPostgres() {
        assert.fail('bounded valid pages must not enter failure persistence')
      },
      async readCommerceOrderSyncHealthFromPostgres() {
        return { failed: 0, providerWrites: 0 }
      },
      async readCommerceOrderSyncCursorKeyReadinessFromPostgres() {
        return { ready: true, referencedKeyIds: [] }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      withCommerceStoreSyncProviderReadFenceInPostgres: (input) => input.read(),
    },
  })
  const result = await runtime.processCommerceOrderHistory({
    workerId: 'multi-page-drain-test',
    limit: 1,
  })
  return { runtime, result, pageCount, claimCalls, readCalls, appendCalls }
}

const completedDrain = await runDrainScenario({ finalPage: 12 })
assert.equal(completedDrain.pageCount, 12)
assert.equal(completedDrain.claimCalls, 12)
assert.equal(completedDrain.readCalls, 12)
assert.equal(completedDrain.appendCalls, 12)
assert.equal(completedDrain.result.claimed, 12)
assert.equal(completedDrain.result.claimWaves, 12)
assert.equal(completedDrain.result.pageAttempts, 12)
assert.equal(completedDrain.result.continued, 11)
assert.equal(completedDrain.result.succeeded, 1)
assert.equal(completedDrain.result.providerReads, 72)
assert.equal(completedDrain.result.providerReadReservations, 72)
assert.equal(completedDrain.result.drainStopReason, 'terminal')
assert.equal(completedDrain.result.providerWrites, 0)
assert.equal(completedDrain.result.operationsOrderWrites, 0)
assert.deepEqual(
  JSON.parse(JSON.stringify(completedDrain.result.deferredHistoricalRefreshes)),
  {
    beforeClaim: 0,
    afterDrain: 0,
    materialized: 0,
    skipped: 0,
    providerWrites: 0,
  },
)
assert.equal(
  completedDrain.runtime.commerceOrderHistoryWorkerLimits
    .providerDrainClaimWindowMs,
  90_000,
)
assert.equal(
  completedDrain.runtime.commerceOrderHistoryWorkerLimits
    .maxPageAttemptsPerRun,
  24,
)

// A never-ending continuation is released back to pending on every append and
// stops before another lease is claimed once the absolute page/read envelope
// is consumed.
const boundedDrain = await runDrainScenario({ finalPage: Number.MAX_SAFE_INTEGER })
assert.equal(boundedDrain.pageCount, 24)
assert.equal(boundedDrain.claimCalls, 24)
assert.equal(boundedDrain.result.claimed, 24)
assert.equal(boundedDrain.result.continued, 24)
assert.equal(boundedDrain.result.succeeded, 0)
assert.equal(boundedDrain.result.providerReads, 144)
assert.equal(boundedDrain.result.providerReadReservations, 144)
assert.equal(boundedDrain.result.drainStopReason, 'page_limit')
assert.equal(boundedDrain.result.providerWrites, 0)

// A failure-persistence outage for one lease does not prevent the worker from
// resolving another lease that was already claimed in the same wave.
let failureWaveClaimed = false
let secondLeaseAppended = false
const isolatedFailureRuntime = loadWorker({
  '@/lib/integrations/commerceOrderHistory': {
    async readCommerceOrderHistoryPage(input) {
      if (input.accountGlobalId === 'gia0000001') {
        throw new Error('first provider read failed')
      }
      return {
        provider: 'shopify',
        observations: [],
        nextProviderCursor: null,
        providerRowsSeen: 0,
        providerReads: 3,
        providerWrites: 0,
        readAllOrdersScopeObserved: true,
        returnHistoryScopeObserved: false,
      }
    },
  },
  '@/lib/persistence/commerceOrderSync': {
    async redactExpiredCommerceOrderSensitiveEvidenceInPostgres() {
      return { redacted: 0, providerWrites: 0 }
    },
    async materializeDeferredCommerceOrderHistoryRefreshesInPostgres() {
      return { materialized: 0, skipped: 0, providerWrites: 0 }
    },
    async ensureContinuousCommerceOrderPollsInPostgres() {
      return { scheduled: 0, providerWrites: 0 }
    },
    async claimCommerceOrderBackfillsInPostgres(input) {
      assert.equal(input.limit, 2)
      if (failureWaveClaimed) return []
      failureWaveClaimed = true
      return [
        job(0),
        {
          ...job(0),
          id: '55555555-5555-4555-8555-555555555555',
          globalId: 'gcob0000002',
          accountGlobalId: 'gia0000002',
          lockToken: '66666666-6666-4666-8666-666666666666',
        },
      ]
    },
    async readCommerceOrderBackfillCursorFromPostgres() {
      return null
    },
    async appendCommerceOrderBackfillPageInPostgres(input) {
      assert.equal(input.job.accountGlobalId, 'gia0000002')
      secondLeaseAppended = true
      return { status: 'succeeded', appended: 0, preserved: 0 }
    },
    async failCommerceOrderBackfillInPostgres(input) {
      assert.equal(input.job.accountGlobalId, 'gia0000001')
      throw new Error('failure persistence unavailable')
    },
    async readCommerceOrderSyncHealthFromPostgres() {
      return { failed: 0, providerWrites: 0 }
    },
    async readCommerceOrderSyncCursorKeyReadinessFromPostgres() {
      return { ready: true, referencedKeyIds: [] }
    },
  },
  '@/lib/persistence/commerceStoreSync': {
    withCommerceStoreSyncProviderReadFenceInPostgres: (input) => input.read(),
  },
})
const isolatedFailure = await isolatedFailureRuntime.processCommerceOrderHistory({
  workerId: 'failure-isolation-test',
  limit: 2,
})
assert.equal(secondLeaseAppended, true)
assert.equal(isolatedFailure.claimed, 2)
assert.equal(isolatedFailure.pageAttempts, 2)
assert.equal(isolatedFailure.succeeded, 1)
assert.equal(isolatedFailure.failurePersistenceErrors, 1)
assert.equal(isolatedFailure.providerReads, 3)
assert.equal(isolatedFailure.providerReadReservations, 12)
assert.equal(isolatedFailure.drainStopReason, 'terminal')
assert.equal(isolatedFailure.providerWrites, 0)

console.log('Commerce order history worker multi-page drain checks passed')
