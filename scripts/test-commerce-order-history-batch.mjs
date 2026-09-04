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

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
      reportDiagnostics: true,
    },
  )
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile`)
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Buffer,
    Error,
    Headers,
    JSON,
    Number,
    Object,
    Promise,
    RegExp,
    Request,
    Response,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

class CommerceOrderHistoryBatchError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

class CommerceOrderSyncError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

class ShopifyCommerceClientError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

class FaireCommerceClientError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

const organizationId = '4cb57f55-5b3a-49ee-a62c-af9aee10d531'
const receiptId = '61002d2a-b600-41bb-9296-a8549f48b41f'
const attemptToken = '69db0879-7782-4c58-9cac-b0991e1643db'
const candidates = [
  {
    candidateGlobalId: 'gcoc0009901',
    accountGlobalId: 'gia0009901',
    integrationAccountId: '81087563-a685-4470-969a-5d0a899bb58a',
    provider: 'shopify',
    credentialGeneration: 1,
    externalOrderId: 'gid://shopify/Order/9901',
    previousEvidenceSourceHash: 'a'.repeat(64),
    terminal: true,
    totalEligible: 2,
  },
  {
    candidateGlobalId: 'gcoc0009902',
    accountGlobalId: 'gia0009902',
    integrationAccountId: '8310c34d-a44a-4776-aec9-005c9ceef95f',
    provider: 'faire',
    credentialGeneration: 1,
    externalOrderId: 'faire-order-9902',
    previousEvidenceSourceHash: 'b'.repeat(64),
    terminal: true,
    totalEligible: 2,
  },
]

let selectorCalls = 0
let replayedResult = null
let missingActiveOrganization = false
let exactReadErrorProvider = null
const exactReads = []
const appendCalls = []
const completionCalls = []
const selectorInputs = []
const preparationInputs = []

const route = loadTypeScriptModule(
  'app_src/app/api/operations/order-history-sync/route.ts',
  {
    'next/server': {
      NextResponse: {
        json(payload, init = {}) {
          return new Response(JSON.stringify(payload), {
            status: init.status || 200,
            headers: {
              'Content-Type': 'application/json',
              ...(init.headers || {}),
            },
          })
        },
      },
    },
    '@/lib/integrations/commerceOrderHistory': {
      exactFaireOrderHistoryProviderReads: (error) => (
        Number.isSafeInteger(error?.providerReads) ? error.providerReads : null
      ),
      exactShopifyOrderHistoryProviderReads: (error) => (
        Number.isSafeInteger(error?.providerReads) ? error.providerReads : null
      ),
      async readExactShopifyOrderHistoryObservation(input) {
        exactReads.push({ provider: 'shopify', ...input })
        if (exactReadErrorProvider === 'shopify') {
          const error = new CommerceOrderSyncError(
            'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
            'The exact order exceeds a bounded nested page',
          )
          error.providerReads = 3
          throw error
        }
        return {
          observation: {
            observationKind: 'manual_exact_read',
            externalOrderId: input.externalOrderId,
            providerReadCount: 3,
            sourceHash: 'c'.repeat(64),
          },
          providerReads: 3,
          providerWrites: 0,
        }
      },
      async readExactFaireOrderHistoryObservation(input) {
        exactReads.push({ provider: 'faire', ...input })
        if (exactReadErrorProvider === 'faire') {
          const error = new CommerceOrderSyncError(
            'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
            'The exact order exceeds a bounded nested page',
          )
          error.providerReads = 2
          throw error
        }
        return {
          observation: {
            observationKind: 'manual_exact_read',
            externalOrderId: input.externalOrderId,
            providerReadCount: 2,
            sourceHash: 'd'.repeat(64),
          },
          providerReads: 2,
          providerWrites: 0,
        }
      },
    },
    '@/lib/integrations/faireCommerceClient': { FaireCommerceClientError },
    '@/lib/integrations/shopifyCommerceClient': { ShopifyCommerceClientError },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId(actor) {
        if (missingActiveOrganization) {
          throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
        }
        return actor.organizationId
      },
      operationsCapabilities: (actor) => actor.capabilities,
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/persistence/commerceOrderHistoryBatch': {
      CommerceOrderHistoryBatchError,
      isCommerceOrderHistoryTerminalUnsupportedCode(code) {
        return [
          'FAIRE_RESOURCE_NOT_FOUND',
          'SHOPIFY_ORDER_HISTORY_EXACT_ORDER_UNAVAILABLE',
        ].includes(code)
      },
      async listCommerceOrderHistoryBatchCandidatesInPostgres(input) {
        assert.equal(input.organizationId, organizationId)
        selectorInputs.push(JSON.parse(JSON.stringify(input)))
        selectorCalls += 1
        if (selectorCalls % 2 === 0) {
          assert.deepEqual(
            JSON.parse(JSON.stringify(input.excludeProviderIdentities)),
            candidates.map((candidate) => ({
              integrationAccountId: candidate.integrationAccountId,
              provider: candidate.provider,
              externalOrderId: candidate.externalOrderId,
            })),
          )
        }
        return selectorCalls % 2 === 1 ? candidates : []
      },
      async prepareCommerceOrderHistoryBatchInPostgres(input) {
        assert.equal(input.batchLimit, 10)
        assert.deepEqual(JSON.parse(JSON.stringify(input.candidates)), candidates)
        preparationInputs.push(JSON.parse(JSON.stringify(input)))
        return replayedResult
          ? {
              receiptId,
              attemptToken: null,
              candidates: [],
              replayedResult,
            }
          : {
              receiptId,
              attemptToken,
              candidates,
              replayedResult: null,
            }
      },
      async completeCommerceOrderHistoryBatchInPostgres(input) {
        completionCalls.push(input)
      },
      async readLatestCommerceOrderExactHistorySourceHashInPostgres() {
        return 'c'.repeat(64)
      },
    },
    '@/lib/persistence/commerceOrderSync': {
      CommerceOrderSyncError,
      async readCommerceOrderWorkbenchExactReadReplayInPostgres() {
        return null
      },
      async appendCommerceOrderWorkbenchExactReadInPostgres(input) {
        appendCalls.push(input)
        return {
          providerReads: input.provider === 'shopify' ? 3 : 2,
          providerWrites: 0,
        }
      },
    },
    '@/lib/persistence/commerceStoreSync': {
      async withCommerceStoreSyncProviderReadFenceInPostgres(input) {
        return input.read({
          id: '1c15a045-283b-4ce9-ae80-fca14c337910',
          authorityKind: 'manual_read_only',
          readKind: 'order_history',
          intentFingerprintSha256: 'f'.repeat(64),
          controlRevision: 1,
          activationRevision: 1,
          expiresAt: '2026-09-01T20:00:00.000Z',
        })
      },
    },
    '@/lib/requestUser': {
      async requireRequestUser() {
        return {
          email: 'history-batch@clawpilot.com',
          organizationId,
          capabilities: { canManage: true },
        }
      },
    },
  },
)

function request(key, body = {}) {
  return {
    headers: new Headers({
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    }),
    nextUrl: { search: '' },
    async text() { return JSON.stringify(body) },
  }
}

const firstResponse = await route.POST(request('history-batch-ui-0001'))
assert.equal(firstResponse.status, 200)
const firstPayload = await firstResponse.json()
assert.equal(firstPayload.ok, true)
assert.equal(firstPayload.replayed, false)
assert.equal(firstPayload.result.counts.selected, 2)
assert.equal(firstPayload.result.counts.attempted, 2)
assert.equal(firstPayload.result.counts.refreshed, 2)
assert.equal(firstPayload.result.counts.changed, 2)
assert.equal(firstPayload.result.counts.providerReads, 5)
assert.equal(firstPayload.result.providerWrites, 0)
assert.equal(firstPayload.result.canonicalOrderWrites, 0)
assert.equal(firstPayload.result.remaining, 0)
assert.equal(firstPayload.result.continuation, null)
assert.deepEqual(
  new Set(exactReads.map((read) => read.provider)),
  new Set(['shopify', 'faire']),
)
assert.equal(appendCalls.length, 2)
assert.equal(completionCalls.length, 1)

selectorCalls = 0
selectorInputs.length = 0
const visibleOrderKeys = [
  'canonical:gor0009901',
  'imported:gcoc0009902',
]
const targetedResponse = await route.POST(request(
  'history-batch-targeted-0001',
  { orderKeys: visibleOrderKeys },
))
assert.equal(targetedResponse.status, 200)
assert.deepEqual(
  selectorInputs.map((input) => input.orderKeys),
  [visibleOrderKeys, visibleOrderKeys],
  'the visible-page target set must constrain selection and remaining-count reads',
)
assert.deepEqual(
  preparationInputs.at(-1).orderKeys,
  visibleOrderKeys,
  'the target set must participate in the retained idempotent request identity',
)

selectorCalls = 0
selectorInputs.length = 0
const maximumOrderKeys = Array.from({ length: 100 }, (_, index) => (
  `imported:gcoc${String(1_000_000 + index)}`
))
const maximumTargetsResponse = await route.POST(request(
  'history-batch-targeted-maximum-0001',
  { orderKeys: maximumOrderKeys },
))
assert.equal(maximumTargetsResponse.status, 200)
assert.equal(selectorInputs[0].orderKeys.length, 100)

for (const [key, body] of [
  [
    'history-batch-targeted-extra-0001',
    { orderKeys: visibleOrderKeys, extra: true },
  ],
  [
    'history-batch-targeted-malformed-0001',
    { orderKeys: ['imported:gcoc0009902 '] },
  ],
  [
    'history-batch-targeted-wrong-namespace-0001',
    { orderKeys: ['canonical:gcoc0009902'] },
  ],
  [
    'history-batch-targeted-not-an-array-0001',
    { orderKeys: 'imported:gcoc0009902' },
  ],
  [
    'history-batch-targeted-over-limit-0001',
    { orderKeys: [...maximumOrderKeys, 'canonical:gor0009901'] },
  ],
]) {
  const invalidResponse = await route.POST(request(key, body))
  assert.equal(invalidResponse.status, 400)
  assert.deepEqual(await invalidResponse.json(), {
    ok: false,
    code: 'COMMERCE_ORDER_HISTORY_BATCH_BODY_INVALID',
    error: 'Exact provider-history refresh input is invalid',
  })
}

replayedResult = firstPayload.result
selectorCalls = 0
const exactReadCount = exactReads.length
const replayResponse = await route.POST(request('history-batch-ui-0001'))
assert.equal(replayResponse.status, 200)
const replayPayload = await replayResponse.json()
assert.equal(replayPayload.ok, true)
assert.equal(replayPayload.replayed, true)
assert.deepEqual(replayPayload.result, firstPayload.result)
assert.equal(
  exactReads.length,
  exactReadCount,
  'a batch replay must not issue provider reads',
)

missingActiveOrganization = true
const missingOrganizationResponse = await route.POST(
  request('history-batch-no-organization-0001'),
)
assert.equal(missingOrganizationResponse.status, 409)
assert.deepEqual(await missingOrganizationResponse.json(), {
  ok: false,
  code: 'ACTIVE_ORGANIZATION_REQUIRED',
  error: 'Select an active organization first',
})
missingActiveOrganization = false

replayedResult = null
selectorCalls = 0
exactReadErrorProvider = 'shopify'
const completionsBeforeDegradedRead = completionCalls.length
const appendsBeforeDegradedRead = appendCalls.length
const degradedResponse = await route.POST(
  request('history-batch-nested-page-0001'),
)
assert.equal(degradedResponse.status, 200)
const degradedPayload = await degradedResponse.json()
assert.equal(degradedPayload.ok, true)
assert.equal(degradedPayload.replayed, false)
assert.equal(degradedPayload.result.status, 'partial')
assert.equal(degradedPayload.result.counts.attempted, 2)
assert.equal(degradedPayload.result.counts.refreshed, 1)
assert.equal(degradedPayload.result.counts.unavailable, 1)
assert.equal(degradedPayload.result.counts.providerReads, 5)
assert.deepEqual(degradedPayload.result.failedByCode, {
  COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT: 1,
})
assert.equal(
  completionCalls.length,
  completionsBeforeDegradedRead + 1,
  'a degradable nested-page outcome must complete the batch receipt',
)
assert.equal(
  appendCalls.length,
  appendsBeforeDegradedRead + 1,
  'only the successful exact observation may be appended',
)
exactReadErrorProvider = null

const routeSource = readFileSync(
  resolve(root, 'app_src/app/api/operations/order-history-sync/route.ts'),
  'utf8',
)
for (const fragment of [
  'const BATCH_LIMIT = 10',
  'providerWrites: 0',
  'canonicalOrderWrites: 0',
  'continuation:',
  "mode: 'refresh_again'",
  'readExactShopifyOrderHistoryObservation',
  'readExactFaireOrderHistoryObservation',
  'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
  "code: 'UNAUTHORIZED'",
]) {
  assert.ok(routeSource.includes(fragment), `batch route is missing ${fragment}`)
}

const uiSource = readFileSync(
  resolve(root, 'app_src/components/operations/OperationsSection.tsx'),
  'utf8',
)
assert.equal(
  uiSource.match(/fetch\('\/api\/operations\/order-history-sync'/gu)?.length,
  1,
  'one Refresh click must issue one bounded exact-history batch request',
)
for (const fragment of [
  'validOrderHistorySyncResult',
  'const historyTotals = historyResults.reduce',
  'historyTotals.refreshed',
  'Refreshed order details and activity for',
  'const historyRemaining = historyResults.at(-1)?.remaining || 0',
  'refresh again to continue.',
]) {
  assert.ok(uiSource.includes(fragment), `Refresh UI is missing ${fragment}`)
}

console.log('Commerce order exact-history batch route acceptance passed')
