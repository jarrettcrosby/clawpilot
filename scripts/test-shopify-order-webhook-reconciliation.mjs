#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptModule(path, mocks = {}) {
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
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
    Map,
    Math,
    Number,
    Object,
    Promise,
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

const source = readFileSync(
  resolve(root, 'app_src/lib/integrations/shopifyOrderWebhook.ts'),
  'utf8',
)
const route = readFileSync(
  resolve(root, 'app_src/app/api/integrations/commerce/route.ts'),
  'utf8',
)
const integration = readFileSync(
  resolve(root, 'app_src/lib/integrations/commerceIntegrations.ts'),
  'utf8',
)
const persistence = readFileSync(
  resolve(root, 'app_src/lib/persistence/shopifyOrderWebhookReconciliation.ts'),
  'utf8',
)
const ui = readFileSync(
  resolve(root, 'app_src/components/settings/CommerceIntegrationPanel.tsx'),
  'utf8',
)
const migration = readFileSync(
  resolve(root, 'db/migrations/0303_operations_shopify_order_webhook_reconciliation.sql'),
  'utf8',
)

for (const required of [
  "'orders/create'",
  "'orders/updated'",
  "'orders/edited'",
  "'orders/cancelled'",
  "'orders/paid'",
  "'orders/fulfilled'",
  "'orders/partially_fulfilled'",
  "'admin_graphql_api_id'",
  "'updated_at'",
  "format: 'JSON'",
  'webhookSubscriptionCreate',
  'webhookSubscriptionUpdate',
]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
assert.doesNotMatch(source, /webhookSubscriptionDelete|deleteShopify/u)
assert.match(route, /reconcile-shopify-order-webhooks/u)
assert.match(route, /requireShopifyOrderWebhookReconciler\(actor\)/u)
assert.match(route, /requireIdempotencyKey\(req\)/u)
assert.match(integration, /SHOPIFY_ORDER_WEBHOOK_OUTCOME_UNKNOWN/u)
assert.match(integration, /markStaleShopifyOrderWebhookAttemptUnknownInPostgres/u)
assert.match(integration, /revalidated\.credentialVersion !== runtime\.credentialVersion/u)
assert.match(integration, /probe\.shopId !== runtime\.externalAccountId/u)
assert.match(integration, /grant\.grantedScopes\.includes\('read_orders'\)/u)
assert.match(integration, /probe\.grantedScopes\.includes\('read_orders'\)/u)
assert.match(persistence, /operations_shopify_order_webhook_attempts/u)
assert.match(persistence, /operations_shopify_order_webhook_outcomes/u)
assert.match(integration, /read-only discovery/u)
assert.match(migration, /attempts are immutable/u)
assert.match(migration, /outcomes are immutable/u)
assert.match(migration, /credential cannot rotate during dispatch/u)
assert.doesNotMatch(migration, /DELETE FROM operations_shopify_order_webhook/u)
for (const label of ['Desired ·', 'Current ·', 'Effective ·']) {
  assert.match(ui, new RegExp(label, 'u'))
}
assert.match(ui, /Reconcile order webhooks/u)
assert.match(ui, /Idempotency-Key/u)
assert.match(ui, /window\.sessionStorage/u)
assert.match(ui, /Safe retry is retained for this tab/u)

const recovery = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyOrderWebhookRecovery.ts',
)
const recoveredValues = new Map()
const sessionStorage = {
  getItem(key) { return recoveredValues.get(key) ?? null },
  setItem(key, value) { recoveredValues.set(key, value) },
  removeItem(key) { recoveredValues.delete(key) },
}
const recoveryIdentity = {
  organizationId: '03030000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0303001',
}
const recoveryConfirmation =
  'RECONCILE 7 ORDER WEBHOOKS FOR gia0303001'
assert.equal(recovery.saveShopifyOrderWebhookRecoveryDraft(sessionStorage, {
  ...recoveryIdentity,
  confirmation: recoveryConfirmation,
  idempotencyKey: 'order-webhooks-remount-03030001',
}), true)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    recovery.loadShopifyOrderWebhookRecoveryDraft(
      sessionStorage,
      recoveryIdentity,
    ),
  )),
  {
    confirmation: recoveryConfirmation,
    idempotencyKey: 'order-webhooks-remount-03030001',
  },
  'a remounted setup panel must recover the exact provider-attempt key',
)
assert.equal(recovery.clearShopifyOrderWebhookRecoveryDraft(
  sessionStorage,
  recoveryIdentity,
), true)
assert.equal(recovery.loadShopifyOrderWebhookRecoveryDraft(
  sessionStorage,
  recoveryIdentity,
), null)

class MockCommerceRequestError extends Error {
  constructor(message, status = 400, code = 'COMMERCE_REQUEST_INVALID') {
    super(message)
    this.status = status
    this.code = code
  }
}
let apiActorRole = 'owner'
const apiCalls = []
const apiRoute = loadTypeScriptModule(
  'app_src/app/api/integrations/commerce/route.ts',
  {
    'next/server': {
      NextResponse: {
        json(payload, options = {}) {
          return { payload, status: options.status || 200, headers: options.headers }
        },
      },
    },
    '@/lib/integrations/commerceIntegrations': {
      CommerceIntegrationRequestError: MockCommerceRequestError,
      createCommerceIntegrationsStateProjector: () => (state) => state,
      faireOAuthCallbackUrl: () => 'https://clawpilot.test/faire/callback',
      sanitizedCommerceIntegrationError(error) {
        return error instanceof MockCommerceRequestError
          ? error
          : new MockCommerceRequestError('Unexpected failure', 500, 'INTERNAL_ERROR')
      },
      async reconcileShopifyOrderWebhookSetup(input) {
        apiCalls.push(JSON.parse(JSON.stringify(input)))
        return { accounts: [], organizationId: input.organizationId }
      },
    },
    '@/lib/integrations/commerceCapabilities': {
      COMMERCE_CUSTOM_INTEGRATION_ONBOARDING: { faire: {} },
      COMMERCE_CAPABILITY_DEFINITIONS: {},
      FAIRE_PROVIDER_AVAILABLE_CAPABILITIES: [],
      SHOPIFY_PROVIDER_AVAILABLE_CAPABILITIES: [],
      CLAWPILOT_FAIRE_CAPABILITY_IMPLEMENTATION: {},
      CLAWPILOT_SHOPIFY_CAPABILITY_IMPLEMENTATION: {},
      FAIRE_CAPABILITY_SCOPES: {},
      SHOPIFY_CAPABILITY_SCOPES: {},
      SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS: [],
      SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES: [],
      SHOPIFY_RESTRICTED_ACCESS_SCOPES: [],
      SHOPIFY_ADMIN_API_VERSION: '2026-07',
    },
    '@/lib/integrations/faireCommerceClient': {
      FAIRE_API_SCOPES: [],
      FAIRE_COMMERCE_CAPABILITIES: { classification: 'sales_channel' },
    },
    '@/lib/integrations/commerceIntake': {
      commerceIntakeRuntimeAvailable: () => true,
      commerceReadRuntimeAvailable: () => true,
    },
    '@/lib/operations/authorization': {
      operationsCapabilities: () => ({ canManage: true, canActivate: true }),
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/requestUser': {
      async requireRequestUser() {
        return {
          email: 'owner@clawpilot.test',
          organizationId: recoveryIdentity.organizationId,
          role: apiActorRole,
        }
      },
    },
    '@/lib/users': { effectiveAuthorizationRole: (actor) => actor.role },
  },
)

function patchRequest(body, idempotencyKey = 'api-order-webhooks-03030001') {
  const bytes = Buffer.from(JSON.stringify(body))
  let read = false
  return {
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-length') return String(bytes.length)
        if (name.toLowerCase() === 'idempotency-key') return idempotencyKey
        return null
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined }
            read = true
            return { done: false, value: bytes }
          },
          async cancel() {},
        }
      },
    },
  }
}

const apiBody = {
  action: 'reconcile-shopify-order-webhooks',
  accountGlobalId: recoveryIdentity.accountGlobalId,
  confirmation: recoveryConfirmation,
}
const apiSuccess = await apiRoute.PATCH(patchRequest(apiBody))
assert.equal(apiSuccess.status, 200)
assert.deepEqual(apiCalls[0], {
  organizationId: recoveryIdentity.organizationId,
  accountGlobalId: recoveryIdentity.accountGlobalId,
  actorEmail: 'owner@clawpilot.test',
  idempotencyKey: 'api-order-webhooks-03030001',
  confirmation: recoveryConfirmation,
})
const missingKey = await apiRoute.PATCH(patchRequest(apiBody, null))
assert.equal(missingKey.status, 400)
assert.equal(missingKey.payload.code, 'SHOPIFY_ORDER_WEBHOOK_IDEMPOTENCY_KEY_REQUIRED')
apiActorRole = 'member'
const forbidden = await apiRoute.PATCH(patchRequest(apiBody))
assert.equal(forbidden.status, 403)
assert.equal(forbidden.payload.code, 'SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_FORBIDDEN')
apiActorRole = 'owner'
const broadBody = await apiRoute.PATCH(patchRequest({ ...apiBody, delete: true }))
assert.equal(broadBody.status, 400)
assert.equal(apiCalls.length, 1)

const providerState = {
  subscriptions: [],
  operations: [],
  mutationCalls: 0,
  rejectMutationAt: null,
  timeoutMutationAt: null,
}
const topicEnums = {
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/edited': 'ORDERS_EDITED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'orders/paid': 'ORDERS_PAID',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/partially_fulfilled': 'ORDERS_PARTIALLY_FULFILLED',
}
const topicByEnum = Object.fromEntries(
  Object.entries(topicEnums).map(([topic, providerTopic]) => [providerTopic, topic]),
)
const topics = Object.keys(topicEnums)
let providerSequence = 30300

const webhook = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyOrderWebhook.ts',
  {
    '@/lib/integrations/shopifyCommerceClient': {
      async shopifyAdminGraphql(_credential, request) {
        providerState.operations.push(JSON.parse(JSON.stringify(request)))
        if (request.operationName === 'ClawPilotOrderWebhookSubscriptions') {
          return {
            webhookSubscriptions: {
              nodes: providerState.subscriptions.map((entry) => ({ ...entry })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          }
        }
        const input = request.variables.subscription
        providerState.mutationCalls += 1
        assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(input).sort())), [
          'format', 'includeFields', 'uri',
        ])
        assert.equal(input.format, 'JSON')
        assert.deepEqual(JSON.parse(JSON.stringify(input.includeFields)), [
          'admin_graphql_api_id', 'updated_at',
        ])
        if (providerState.rejectMutationAt === providerState.mutationCalls) {
          const key = request.operationName
            === 'ClawPilotOrderWebhookSubscriptionCreate'
            ? 'webhookSubscriptionCreate'
            : 'webhookSubscriptionUpdate'
          return {
            [key]: {
              webhookSubscription: null,
              userErrors: [{
                field: ['topic'],
                message: 'Access denied for orders topic',
              }],
            },
          }
        }
        if (providerState.timeoutMutationAt === providerState.mutationCalls) {
          throw new Error('simulated transport timeout before response')
        }
        if (request.operationName === 'ClawPilotOrderWebhookSubscriptionCreate') {
          providerSequence += 1
          const node = {
            id: `gid://shopify/WebhookSubscription/${providerSequence}`,
            topic: request.variables.topic,
            uri: input.uri,
            format: input.format,
            includeFields: [...input.includeFields],
          }
          providerState.subscriptions.push(node)
          return {
            webhookSubscriptionCreate: {
              webhookSubscription: node,
              userErrors: [],
            },
          }
        }
        if (request.operationName === 'ClawPilotOrderWebhookSubscriptionUpdate') {
          const index = providerState.subscriptions.findIndex(
            (entry) => entry.id === request.variables.id,
          )
          assert.ok(index >= 0)
          providerState.subscriptions[index] = {
            ...providerState.subscriptions[index],
            uri: input.uri,
            format: input.format,
            includeFields: [...input.includeFields],
          }
          return {
            webhookSubscriptionUpdate: {
              webhookSubscription: providerState.subscriptions[index],
              userErrors: [],
            },
          }
        }
        throw new Error(`Unexpected operation ${request.operationName}`)
      },
    },
  },
)

const accountGlobalId = 'gia0303001'
const desiredUri = (
  `https://development.clawpilot.test/api/integrations/commerce/`
  + `shopify/webhooks/${accountGlobalId}`
)
assert.equal(
  webhook.shopifyOrderWebhookReconciliationConfirmation(accountGlobalId),
  `RECONCILE 7 ORDER WEBHOOKS FOR ${accountGlobalId}`,
)
const requestFacts = {
  organizationId: '03030000-0000-4000-8000-000000000001',
  accountGlobalId,
  integrationAccountId: '03030000-0000-4000-8000-000000000002',
  credentialGeneration: 1,
  externalAccountId: 'gid://shopify/Shop/303001',
  shopDomain: 'pro-bakery-bites.myshopify.com',
  desiredUri,
  actorEmail: 'owner@clawpilot.test',
}
const firstHash = webhook.shopifyOrderWebhookReconciliationRequestHash(requestFacts)
assert.match(firstHash, /^[a-f0-9]{64}$/u)
assert.notEqual(
  firstHash,
  webhook.shopifyOrderWebhookReconciliationRequestHash({
    ...requestFacts,
    credentialGeneration: 2,
  }),
  'credential rotation must change the command request hash',
)
assert.notEqual(
  firstHash,
  webhook.shopifyOrderWebhookReconciliationRequestHash({
    ...requestFacts,
    desiredUri: desiredUri.replace('development.', 'changed.'),
  }),
  'callback-origin drift must change the command request hash',
)

const credential = {
  shopDomain: requestFacts.shopDomain,
  accessToken: 'test-token-0303',
}
const created = await webhook.reconcileShopifyOrderWebhookSubscriptions(
  credential,
  { desiredUri },
)
assert.equal(created.providerWrites, 7)
assert.equal(created.after.ready, true)
assert.equal(providerState.subscriptions.length, 7)
assert.equal(
  providerState.operations.filter((operation) =>
    operation.operationName === 'ClawPilotOrderWebhookSubscriptionCreate').length,
  7,
)
assert.equal(
  providerState.operations.some((operation) =>
    /delete/iu.test(operation.query)),
  false,
)

providerState.operations = []
providerState.subscriptions[0].uri = 'https://stale.example.test/webhook'
providerState.subscriptions[0].includeFields = ['id', 'email']
const updated = await webhook.reconcileShopifyOrderWebhookSubscriptions(
  credential,
  { desiredUri },
)
assert.equal(updated.providerWrites, 1)
assert.equal(updated.after.ready, true)
assert.equal(
  providerState.operations.filter((operation) =>
    operation.operationName === 'ClawPilotOrderWebhookSubscriptionUpdate').length,
  1,
)

providerState.operations = []
providerState.subscriptions.push({ ...providerState.subscriptions[0], id:
  'gid://shopify/WebhookSubscription/39999' })
const duplicated = await webhook.discoverShopifyOrderWebhookSubscriptions(
  credential,
  { desiredUri },
)
assert.throws(
  () => webhook.planShopifyOrderWebhookReconciliation(duplicated),
  (error) => error.code === 'SHOPIFY_ORDER_WEBHOOK_DUPLICATE_REVIEW_REQUIRED',
)
assert.equal(
  providerState.operations.filter((operation) => /Mutation/u.test(
    operation.operationName,
  )).length,
  0,
  'duplicate discovery must not mutate or delete subscriptions',
)

providerState.operations = []
providerState.subscriptions = []
providerState.mutationCalls = 0
providerState.rejectMutationAt = 1
await assert.rejects(
  () => webhook.reconcileShopifyOrderWebhookSubscriptions(
    credential,
    { desiredUri },
  ),
  (error) => error.code === 'SHOPIFY_ORDER_WEBHOOK_MUTATION_REJECTED'
    && error.stopClassification === 'deterministic_rejection'
    && error.completedMutations.length === 0,
  'Shopify scope/userErrors must fail without accepting mutation evidence',
)
assert.equal(providerState.subscriptions.length, 0)

providerState.operations = []
providerState.subscriptions = []
providerState.mutationCalls = 0
providerState.rejectMutationAt = 4
let deterministicStop
try {
  await webhook.reconcileShopifyOrderWebhookSubscriptions(
    credential,
    { desiredUri },
  )
  assert.fail('the deterministic fourth mutation rejection must surface')
} catch (error) {
  deterministicStop = error
}
assert.equal(deterministicStop.stopClassification, 'deterministic_rejection')
assert.equal(deterministicStop.stoppedMutation.topic, 'orders/cancelled')
assert.equal(deterministicStop.completedMutations.length, 3)
assert.equal(providerState.subscriptions.length, 3)
const deterministicDiscovery = await webhook
  .discoverShopifyOrderWebhookSubscriptions(credential, { desiredUri })
const remountedDecision = webhook.decideShopifyOrderWebhookRecovery(
  'recoverable',
  deterministicDiscovery,
)
assert.equal(remountedDecision.action, 'dispatch')
assert.deepEqual(
  JSON.parse(JSON.stringify(remountedDecision.plan.map((item) => item.topic))),
  topics.slice(3),
  'remount may dispatch only the four deterministically unattempted topics',
)
providerState.rejectMutationAt = null
const residualResult = await webhook.reconcileShopifyOrderWebhookSubscriptions(
  credential,
  {
    desiredUri,
    expectedPlan: remountedDecision.plan,
    preparedReadiness: deterministicDiscovery,
  },
)
assert.equal(residualResult.providerWrites, 4)
assert.equal(residualResult.after.ready, true)
assert.equal(providerState.subscriptions.length, 7)

providerState.operations = []
providerState.subscriptions = []
providerState.mutationCalls = 0
providerState.rejectMutationAt = null
providerState.timeoutMutationAt = 4
let ambiguousStop
try {
  await webhook.reconcileShopifyOrderWebhookSubscriptions(
    credential,
    { desiredUri },
  )
  assert.fail('the ambiguous fourth mutation timeout must surface')
} catch (error) {
  ambiguousStop = error
}
assert.equal(ambiguousStop.stopClassification, 'ambiguous')
assert.equal(ambiguousStop.stoppedMutation.topic, 'orders/cancelled')
assert.equal(ambiguousStop.completedMutations.length, 3)
const ambiguousDiscovery = await webhook
  .discoverShopifyOrderWebhookSubscriptions(credential, { desiredUri })
const writesBeforeAmbiguousRecovery = providerState.operations.filter(
  (operation) => /Mutation/u.test(operation.operationName),
).length
const ambiguousDecision = webhook.decideShopifyOrderWebhookRecovery(
  'unknown',
  ambiguousDiscovery,
)
assert.equal(ambiguousDecision.action, 'manual_review')
assert.equal(ambiguousDecision.plan.length, 0)
assert.equal(
  providerState.operations.filter(
    (operation) => /Mutation/u.test(operation.operationName),
  ).length,
  writesBeforeAmbiguousRecovery,
  'ambiguous missing discovery must issue zero residual provider writes',
)

console.log('Shopify order webhook reconciliation domain/provider/UI/API checks passed')
