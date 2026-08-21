#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

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
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    URL,
    console,
    exports: loaded.exports,
    module: loaded,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return loaded.exports
}

const read = (path) => readFileSync(path, 'utf8')
const integrationSource = read(
  'app_src/lib/integrations/shopifyOrderWebhook.ts',
)
const serviceSource = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
const persistenceSource = read(
  'app_src/lib/persistence/shopifyOrderWebhookSignals.ts',
)
const routeSource = read(
  'app_src/app/api/integrations/commerce/shopify/webhooks/[accountGlobalId]/route.ts',
)
const migration = read(
  'db/migrations/0278_operations_shopify_order_webhook_signals.sql',
)

const workerCalls = []
let workerReadShouldFail = false
let workerStoreSyncPaused = false
const worker = loadTypeScriptModule(
  'app_src/lib/shopifyOrderWebhookWorker.ts',
  {
    '@/lib/integrations/commerceOrderHistory': {
      async readExactShopifyOrderHistoryObservation(input) {
        workerCalls.push(['read', input])
        if (workerReadShouldFail) {
          throw Object.assign(new Error('sanitized provider failure'), {
            code: 'SHOPIFY_ORDER_WEBHOOK_PROVIDER_READ_FAILED',
          })
        }
        return {
          provider: 'shopify',
          providerReads: 3,
          providerWrites: 0,
          readAllOrdersScopeObserved: true,
          returnHistoryScopeObserved: true,
          observation: {
            externalOrderId: input.externalOrderId,
            observationKind: 'webhook_exact_read',
          },
        }
      },
    },
    '@/lib/persistence/shopifyOrderWebhookSignals': {
      async assertShopifyOrderWebhookClaimCurrentForProviderReadInPostgres(
        input,
      ) {
        workerCalls.push(['assert-current', input])
        if (workerStoreSyncPaused) {
          throw Object.assign(new Error('Store sync paused'), {
            code: 'SHOPIFY_ORDER_WEBHOOK_PROVIDER_READ_FENCE_CHANGED',
          })
        }
      },
      async claimShopifyOrderWebhookTargetsInPostgres(input) {
        workerCalls.push(['claim', input])
        return [{
          id: 'target-id',
          organizationId: 'org-id',
          integrationAccountId: 'account-id',
          accountGlobalId: 'gia1234567',
          credentialGeneration: 1,
          policyRevision: 1,
          externalOrderId: 'gid://shopify/Order/9301',
          capturedDirtyVersion: 1,
          signalGlobalId: 'gos1234567',
          claimedProviderUpdatedAt: '2026-08-13T17:00:00.000Z',
          lockToken: 'lock-token',
          attemptCount: 1,
        }]
      },
      async appendShopifyOrderWebhookExactReadInPostgres(input) {
        workerCalls.push(['append', input])
        return {
          providerReads: 3,
          appended: 1,
          preserved: 0,
          linesAppended: 1,
          eventsAppended: 2,
        }
      },
      async failShopifyOrderWebhookExactReadInPostgres(input) {
        workerCalls.push(['fail', input])
        return { status: 'failed' }
      },
      async parkShopifyOrderWebhookExactReadForStoreSyncPauseInPostgres(input) {
        workerCalls.push(['park', input])
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
const workerSuccess = await worker.processShopifyOrderWebhookSignals({
  workerId: 'order-webhook-test',
  limit: 1,
})
assert.equal(workerSuccess.claimed, 1)
assert.equal(workerSuccess.succeeded, 1)
assert.equal(workerSuccess.providerReads, 3)
assert.equal(workerSuccess.observationsAppended, 1)
assert.equal(workerSuccess.operationsOrderWrites, 0)
assert.equal(workerSuccess.providerWrites, 0)
assert.equal(workerCalls.filter(([kind]) => kind === 'append').length, 1)
assert.equal(workerCalls.filter(([kind]) => kind === 'fail').length, 0)

workerReadShouldFail = true
const workerFailure = await worker.processShopifyOrderWebhookSignals({
  workerId: 'order-webhook-test',
  limit: 1,
})
workerReadShouldFail = false
assert.equal(workerFailure.claimed, 1)
assert.equal(workerFailure.succeeded, 0)
assert.equal(workerFailure.failed, 1)
assert.equal(workerFailure.providerWrites, 0)
assert.equal(workerCalls.filter(([kind]) => kind === 'fail').length, 1)

const readsBeforePause = workerCalls.filter(([kind]) => kind === 'read').length
workerStoreSyncPaused = true
const workerPaused = await worker.processShopifyOrderWebhookSignals({
  workerId: 'order-webhook-test',
  limit: 1,
})
workerStoreSyncPaused = false
assert.equal(workerPaused.claimed, 1)
assert.equal(workerPaused.succeeded, 0)
assert.equal(workerPaused.failed, 0)
assert.equal(workerPaused.parked, 1)
assert.equal(workerCalls.filter(([kind]) => kind === 'park').length, 1)
assert.equal(
  workerCalls.filter(([kind]) => kind === 'read').length,
  readsBeforePause,
  'a pause after claim must stop the Shopify provider read',
)

let providerData = {
  webhookSubscriptions: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}
let providerRequest = null
const module = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyOrderWebhook.ts',
  {
    '@/lib/integrations/shopifyCommerceClient': {
      async shopifyAdminGraphql(_credential, request) {
        providerRequest = request
        return providerData
      },
    },
  },
)

const exactBody = Buffer.from(JSON.stringify({
  admin_graphql_api_id: 'gid://shopify/Order/9301',
  updated_at: '2026-08-13T17:00:00Z',
}))

for (const topic of module.SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS) {
  const evidence = module.shopifyOrderWebhookSignalEvidence({
    topic,
    verifiedRawBody: exactBody,
    now: '2026-08-13T17:01:00Z',
  })
  assert.equal(evidence.topic, topic)
  assert.equal(evidence.externalOrderId, 'gid://shopify/Order/9301')
  assert.equal(evidence.providerUpdatedAt, '2026-08-13T17:00:00.000Z')
  assert.match(evidence.payloadHash, /^[a-f0-9]{64}$/u)
  assert.equal(evidence.payloadBytes, exactBody.byteLength)
}

for (const invalid of [
  Buffer.from(JSON.stringify({
    admin_graphql_api_id: 'gid://shopify/Order/9301',
    updated_at: '2026-08-13T17:00:00Z',
    email: 'must-not-enter-signal-lane@example.com',
  })),
  Buffer.from(
    '{"admin_graphql_api_id":"gid://shopify/Order/9301",'
    + '"admin_graphql_api_id":"gid://shopify/Order/9302",'
    + '"updated_at":"2026-08-13T17:00:00Z"}',
  ),
  Buffer.from(JSON.stringify({
    admin_graphql_api_id: '9301',
    updated_at: '2026-08-13T17:00:00Z',
  })),
  Buffer.from(JSON.stringify({
    admin_graphql_api_id: 'gid://shopify/Order/9301',
    updated_at: 'not-a-time',
  })),
]) {
  assert.throws(
    () => module.shopifyOrderWebhookSignalEvidence({
      topic: 'orders/updated',
      verifiedRawBody: invalid,
      now: '2026-08-13T17:01:00Z',
    }),
    (error) => /^SHOPIFY_ORDER_WEBHOOK_/u.test(error?.code || ''),
  )
}

assert.throws(
  () => module.shopifyOrderWebhookSignalEvidence({
    topic: 'orders/delete',
    verifiedRawBody: exactBody,
    now: '2026-08-13T17:01:00Z',
  }),
  (error) => error?.code === 'SHOPIFY_ORDER_WEBHOOK_TOPIC_UNSUPPORTED',
)
assert.throws(
  () => module.shopifyOrderWebhookSignalEvidence({
    topic: 'orders/updated',
    verifiedRawBody: Buffer.alloc(4_097, 1),
    now: '2026-08-13T17:01:00Z',
  }),
  (error) => error?.code === 'SHOPIFY_ORDER_WEBHOOK_TOO_LARGE',
)

const callback = (
  'https://clawpilot.example/api/integrations/commerce/shopify/webhooks/'
  + 'gia0009301'
)
const enumByTopic = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/edited': 'ORDERS_EDITED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'orders/paid': 'ORDERS_PAID',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/partially_fulfilled': 'ORDERS_PARTIALLY_FULFILLED',
}
providerData = {
  webhookSubscriptions: {
    nodes: Object.entries(enumByTopic).map(([topic, providerTopic], index) => ({
      id: `gid://shopify/WebhookSubscription/${9301 + index}`,
      topic: providerTopic,
      uri: callback,
      format: 'JSON',
      includeFields: ['updated_at', 'admin_graphql_api_id'],
    })),
    pageInfo: { hasNextPage: false, endCursor: 'complete-page' },
  },
}
const ready = await module.discoverShopifyOrderWebhookSubscriptions(
  { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
  { desiredUri: callback },
)
assert.equal(ready.ready, true)
assert.equal(ready.matchingTopics.length, 7)
assert.equal(ready.missingTopics.length, 0)
assert.equal(ready.conflictingTopics.length, 0)
assert.equal(ready.providerWrites, 0)
assert.match(providerRequest.query, /includeFields/u)
assert.doesNotMatch(providerRequest.query, /mutation/u)
assert.deepEqual(
  JSON.parse(JSON.stringify(providerRequest.variables.topics)).sort(),
  Object.values(enumByTopic).sort(),
)

const storedReady = {
  accountGlobalId: 'gia0009301',
  credentialGeneration: 1,
  desiredUri: callback,
  requiredTopics: Object.keys(enumByTopic),
  requiredIncludeFields: ['admin_graphql_api_id', 'updated_at'],
  observedCount: 7,
  matchingCount: 7,
  missingTopics: [],
  conflictingTopics: [],
  subscriptionReady: true,
  processorState: 'available',
  exactReadProcessorReady: true,
  scheduledPollBackstop: true,
  ready: true,
  observedAt: '2026-08-13T17:00:00.000Z',
  discoveryState: 'succeeded',
  discoveryErrorCode: null,
  providerWrites: 0,
}
assert.equal(module.shopifyOrderWebhookSubscriptionEvidenceReady(
  storedReady,
  {
    accountGlobalId: 'gia0009301',
    credentialGeneration: 1,
    now: '2026-08-13T17:01:00Z',
  },
), true)
for (const invalid of [
  { ...storedReady, accountGlobalId: 'gia0009302' },
  { ...storedReady, credentialGeneration: 2 },
  { ...storedReady, desiredUri: `${callback}?unexpected=true` },
  { ...storedReady, requiredTopics: Object.keys(enumByTopic).slice(1) },
  { ...storedReady, requiredIncludeFields: ['admin_graphql_api_id'] },
  { ...storedReady, conflictingTopics: ['orders/updated'] },
  { ...storedReady, observedCount: 6 },
  { ...storedReady, observedAt: '2026-08-12T16:59:59.999Z' },
  { ...storedReady, discoveryState: 'failed' },
  { ...storedReady, providerWrites: 1 },
]) {
  assert.equal(module.shopifyOrderWebhookSubscriptionEvidenceReady(
    invalid,
    {
      accountGlobalId: 'gia0009301',
      credentialGeneration: 1,
      now: '2026-08-13T17:01:00Z',
    },
  ), false)
}
const olderThan24Hours = {
  ...storedReady,
  observedAt: '2026-08-11T17:00:00.000Z',
}
assert.equal(module.shopifyOrderWebhookSubscriptionEvidenceReady(
  olderThan24Hours,
  {
    accountGlobalId: 'gia0009301',
    credentialGeneration: 1,
    desiredUri: callback,
    now: '2026-08-13T17:01:00Z',
  },
), false, 'operational readiness retains the 24-hour freshness signal')
assert.equal(module.shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery(
  olderThan24Hours,
  {
    accountGlobalId: 'gia0009301',
    credentialGeneration: 1,
    desiredUri: callback,
  },
), true, 'an exact signed delivery is not rejected only because discovery is old')
for (const drifted of [
  { ...olderThan24Hours, credentialGeneration: 2 },
  {
    ...olderThan24Hours,
    desiredUri: callback.replace('clawpilot.example', 'drift.example'),
  },
  {
    ...olderThan24Hours,
    requiredIncludeFields: ['admin_graphql_api_id'],
  },
]) {
  assert.equal(module.shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery(
    drifted,
    {
      accountGlobalId: 'gia0009301',
      credentialGeneration: 1,
      desiredUri: callback,
    },
  ), false)
}

providerData = {
  webhookSubscriptions: {
    nodes: [{
      id: 'gid://shopify/WebhookSubscription/9991',
      topic: 'ORDERS_UPDATED',
      uri: 'https://wrong.example/webhook',
      format: 'JSON',
      includeFields: ['admin_graphql_api_id'],
    }],
    pageInfo: { hasNextPage: false, endCursor: 'wrong-profile-page' },
  },
}
const notReady = await module.discoverShopifyOrderWebhookSubscriptions(
  { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
  { desiredUri: callback },
)
assert.equal(notReady.ready, false)
assert.ok(notReady.missingTopics.includes('orders/updated'))
assert.ok(notReady.conflictingTopics.includes('orders/updated'))

providerData = {
  webhookSubscriptions: {
    nodes: [{
      id: 'gid://shopify/WebhookSubscription/9992',
      topic: 'ORDERS_UPDATED',
      uri: callback,
      format: 'JSON',
      includeFields: [
        'admin_graphql_api_id', 'updated_at', 'updated_at',
      ],
    }],
    pageInfo: { hasNextPage: false, endCursor: 'duplicate-fields-page' },
  },
}
await assert.rejects(
  module.discoverShopifyOrderWebhookSubscriptions(
    { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
    { desiredUri: callback },
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
)

providerData = {
  webhookSubscriptions: {
    nodes: Object.entries(enumByTopic).flatMap(
      ([topic, providerTopic], index) => [
        {
          id: `gid://shopify/WebhookSubscription/${10_001 + index}`,
          topic: providerTopic,
          uri: callback,
          format: 'JSON',
          includeFields: ['admin_graphql_api_id', 'updated_at'],
        },
        ...(topic === 'orders/updated'
          ? [{
              id: 'gid://shopify/WebhookSubscription/10999',
              topic: providerTopic,
              uri: callback,
              format: 'JSON',
              includeFields: ['admin_graphql_api_id', 'updated_at'],
            }]
          : []),
      ],
    ),
    pageInfo: { hasNextPage: false, endCursor: 'duplicate-topic-page' },
  },
}
const duplicateTopic = await module.discoverShopifyOrderWebhookSubscriptions(
  { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
  { desiredUri: callback },
)
assert.equal(duplicateTopic.ready, false)
assert.ok(duplicateTopic.conflictingTopics.includes('orders/updated'))

providerData = { webhookSubscriptions: { nodes: [] } }
await assert.rejects(
  module.discoverShopifyOrderWebhookSubscriptions(
    { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
    { desiredUri: callback },
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_INVALID',
)

providerData = {
  webhookSubscriptions: {
    nodes: [],
    pageInfo: { hasNextPage: true, endCursor: 'next-page' },
  },
}
await assert.rejects(
  module.discoverShopifyOrderWebhookSubscriptions(
    { shopDomain: 'revision-acceptance.myshopify.com', accessToken: 'token-9301' },
    { desiredUri: callback },
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_WEBHOOK_DISCOVERY_TRUNCATED',
)

assert.match(serviceSource, /isShopifyOrderSignalWebhookTopic\(topic\)/u)
assert.match(
  serviceSource,
  /recordShopifyOrderWebhookSignalInPostgres\([\s\S]+?markShopifyWebhookSecretVerifiedInPostgres/u,
)
const orderBranch = serviceSource.slice(
  serviceSource.indexOf('if (isOrderSignalTopic)'),
  serviceSource.indexOf('let payload: unknown'),
)
assert.doesNotMatch(orderBranch, /encryptCommerceWebhookPayload/u)
assert.doesNotMatch(orderBranch, /recordShopifyWebhookReceiptInPostgres/u)
assert.match(routeSource, /SHOPIFY_ORDER_SIGNAL_MAX_BYTES/u)
assert.match(routeSource, /boundedRequestBody\(req, maximumBytes\)/u)
assert.equal(module.SHOPIFY_ORDER_WEBHOOK_DISCOVERY_MAX_AGE_SECONDS, 86_400)
assert.match(providerRequest.query, /pageInfo\s*\{\s*hasNextPage\s*endCursor/u)
assert.match(persistenceSource, /providerWrites: 0 as const/u)
assert.match(persistenceSource, /commerceOrderSyncAccountLockKey/u)
assert.match(
  persistenceSource,
  /account\.configuration->'orderWebhookSubscriptions'[\s\S]+?shopifyOrderWebhookSubscriptionEvidenceAcceptsDelivery\([\s\S]+?current\.order_webhook_subscriptions/u,
)
assert.ok(
  serviceSource.indexOf('verifyShopifyWebhookHmac({')
    < serviceSource.indexOf('recordShopifyOrderWebhookSignalInPostgres({'),
  'HMAC verification must precede the age-independent structural delivery fence',
)
assert.match(
  persistenceSource,
  /downgradeShopifyOrderWebhookPolicyAfterDiscoveryWithClient[\s\S]+?continuous_transport = 'scheduled_poll'[\s\S]+?provider_event_processor_state = 'processor_pending'/u,
)
assert.match(
  persistenceSource,
  /commerce-order-observation:[\s\S]+?ORDER BY observed_at DESC, id DESC[\s\S]+?external_order_id, observed_at, source_hash/u,
)
assert.match(
  persistenceSource,
  /continuous_high_watermark, created_by, updated_by[\s\S]+?COALESCE\([\s\S]+?account\.updated_by[\s\S]+?credential\.created_by/u,
)
assert.match(persistenceSource, /policy\.revision >= target\.policy_revision/u)
assert.doesNotMatch(persistenceSource, /fetch\(|shopifyAdminGraphql|webhookSubscriptionCreate/u)
assert.match(migration, /payload_bytes integer NOT NULL CHECK \(payload_bytes BETWEEN 2 AND 4096\)/u)
assert.doesNotMatch(migration, /payload_ciphertext/u)
assert.doesNotMatch(
  migration,
  /\n\s+(?:customer\w*|email\w*|phone\w*|billing_address|shipping_address)\s+(?:text|jsonb|bytea)/u,
)
assert.match(migration, /provider_write_count integer NOT NULL DEFAULT 0/u)
assert.match(migration, /Shopify order webhook signals are immutable/u)
assert.match(migration, /exact-read worker acknowledges captured dirty versions/u)
assert.equal(
  (migration.match(/policy\.revision >= target\.policy_revision/gu) || [])
    .length,
  3,
)
assert.equal(
  (
    migration.match(
      /credential\.external_account_id = account\.external_account_id/gu,
    ) || []
  ).length,
  7,
  'Every replaced session and target lineage guard must retain exact provider identity',
)

console.log('Shopify payload-free order webhook signal static and pure tests passed')
