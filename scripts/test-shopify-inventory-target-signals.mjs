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

function includes(source, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(source.includes(fragment), `${label} missing ${fragment}`)
  }
}

function loadTypeScriptModule(path, { mocks = {} } = {}) {
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
    Array,
    Boolean,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
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
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const inventoryTopics = [
  'inventory_items/create',
  'inventory_items/delete',
  'inventory_items/update',
  'inventory_levels/connect',
  'inventory_levels/disconnect',
  'inventory_levels/update',
]
const parser = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyInventoryWebhook.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCapabilities': {
        SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS: inventoryTopics,
      },
    },
  },
).shopifyInventoryWebhookTargeting

function parseTarget({ topic, verifiedPayload, verifiedRawPayload }) {
  return parser({
    topic,
    verifiedPayload,
    verifiedRawPayload:
      verifiedRawPayload ?? JSON.stringify(verifiedPayload),
  })
}

const officialItemUpdateRaw = [
  '{"id":271878346596884015,',
  '"admin_graphql_api_id":',
  '"gid://shopify/InventoryItem/271878346596884015"}',
].join('')
const officialLevelUpdateRaw = [
  '{"inventory_item_id":271878346596884015,',
  '"location_id":24826418,"available":10,',
  '"admin_graphql_api_id":',
  '"gid://shopify/InventoryLevel/24826418',
  '?inventory_item_id=271878346596884015"}',
].join('')
const officialLevelDisconnectRaw = [
  '{"inventory_item_id":271878346596884015,',
  '"location_id":24826418}',
].join('')

const targetedFixtures = [
  {
    topic: 'inventory_items/create',
    payload: {
      id: 101,
      admin_graphql_api_id: 'gid://shopify/InventoryItem/101',
      available: -999999,
    },
    item: 'gid://shopify/InventoryItem/101',
    location: null,
  },
  {
    topic: 'inventory_items/delete',
    payload: { id: '102' },
    item: 'gid://shopify/InventoryItem/102',
    location: null,
  },
  {
    topic: 'inventory_items/update',
    payload: {
      id: '103',
      inventory_item_gid: 'gid://shopify/InventoryItem/103',
      inventory_item_admin_graphql_api_id:
        'gid://shopify/InventoryItem/103',
      committed: { deliberately: 'ignored' },
    },
    item: 'gid://shopify/InventoryItem/103',
    location: null,
  },
  {
    topic: 'inventory_levels/connect',
    payload: {
      inventory_item_id: 201,
      location_id: 301,
      admin_graphql_api_id:
        'gid://shopify/InventoryLevel/999001?inventory_item_id=201',
      available: 10,
    },
    item: 'gid://shopify/InventoryItem/201',
    location: 'gid://shopify/Location/301',
  },
  {
    topic: 'inventory_levels/disconnect',
    payload: {
      inventory_item_id: '202',
      location_id: '302',
    },
    item: 'gid://shopify/InventoryItem/202',
    location: 'gid://shopify/Location/302',
  },
  {
    topic: 'inventory_levels/update',
    payload: {
      inventory_item_id: '203',
      location_id: '303',
      inventory_item_gid: 'gid://shopify/InventoryItem/203',
      location_gid: 'gid://shopify/Location/303',
      inventory_level_gid:
        'gid://shopify/InventoryLevel/303?inventory_item_id=203',
      on_hand: Number.MAX_SAFE_INTEGER,
    },
    item: 'gid://shopify/InventoryItem/203',
    location: 'gid://shopify/Location/303',
  },
  {
    topic: 'inventory_items/update',
    payload: JSON.parse(officialItemUpdateRaw),
    rawPayload: officialItemUpdateRaw,
    item: 'gid://shopify/InventoryItem/271878346596884015',
    location: null,
  },
  {
    topic: 'inventory_levels/update',
    payload: JSON.parse(officialLevelUpdateRaw),
    rawPayload: officialLevelUpdateRaw,
    item: 'gid://shopify/InventoryItem/271878346596884015',
    location: 'gid://shopify/Location/24826418',
  },
  {
    topic: 'inventory_levels/disconnect',
    payload: JSON.parse(officialLevelDisconnectRaw),
    rawPayload: officialLevelDisconnectRaw,
    item: 'gid://shopify/InventoryItem/271878346596884015',
    location: 'gid://shopify/Location/24826418',
  },
]

for (const fixture of targetedFixtures) {
  const projection = parseTarget({
    topic: fixture.topic,
    verifiedPayload: fixture.payload,
    verifiedRawPayload: fixture.rawPayload,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), {
    targetingState: 'targeted',
    reasonCode: 'exact_identity',
    inventoryItemGid: fixture.item,
    sourceLocationGid: fixture.location,
  })
  assert.deepEqual(Object.keys(projection).sort(), [
    'inventoryItemGid',
    'reasonCode',
    'sourceLocationGid',
    'targetingState',
  ])
  assert.doesNotMatch(
    JSON.stringify(projection),
    /available|committed|on_hand|quantity|-999999/,
  )
}

const fullRequiredFixtures = [
  ['products/update', { id: 1 }, 'unsupported_topic'],
  ['inventory_items/create', null, 'payload_not_object'],
  ['inventory_items/create', [{ id: 1 }], 'multiple_identity'],
  [
    'inventory_items/create',
    { id: 1, inventory_item_ids: [1] },
    'multiple_identity',
  ],
  [
    'inventory_items/create',
    JSON.parse('{"id":1,"id":2}'),
    'multiple_identity',
    '{"id":1,"id":2}',
  ],
  [
    'inventory_items/update',
    JSON.parse(
      '{"id":1,"admin_graphql_api_id":'
      + '"gid://shopify/InventoryItem/1",'
      + '"admin_graphql_api_id":'
      + '"gid://shopify/InventoryItem/2"}',
    ),
    'multiple_identity',
    '{"id":1,"admin_graphql_api_id":'
      + '"gid://shopify/InventoryItem/1",'
      + '"admin_graphql_api_id":'
      + '"gid://shopify/InventoryItem/2"}',
  ],
  ['inventory_items/create', {}, 'inventory_item_identity_missing'],
  ['inventory_items/update', { id: ' 1' }, 'inventory_item_identity_malformed'],
  [
    'inventory_items/update',
    JSON.parse('{"id":123456789012345678901}'),
    'inventory_item_identity_oversized',
    '{"id":123456789012345678901}',
  ],
  [
    'inventory_items/update',
    { id: '123456789012345678901' },
    'inventory_item_identity_oversized',
  ],
  [
    'inventory_items/update',
    { id: 1, admin_graphql_api_id: 'gid://shopify/InventoryItem/2' },
    'inventory_item_identity_conflict',
  ],
  [
    'inventory_items/update',
    {
      id: 1,
      admin_graphql_api_id: 'gid://shopify/InventoryItem/1',
      inventory_item_gid: 'gid://shopify/InventoryItem/2',
    },
    'inventory_item_identity_conflict',
  ],
  [
    'inventory_levels/update',
    { inventory_item_id: 1 },
    'location_identity_missing',
  ],
  [
    'inventory_levels/update',
    { inventory_item_id: 1, location_id: [] },
    'multiple_identity',
  ],
  [
    'inventory_levels/update',
    { inventory_item_id: 1, location_id: '01' },
    'location_identity_malformed',
  ],
  [
    'inventory_levels/update',
    {
      inventory_item_id: 1,
      location_id: 2,
      location_gid: 'gid://shopify/Location/3',
    },
    'location_identity_conflict',
  ],
  [
    'inventory_levels/connect',
    {
      inventory_item_id: 1,
      location_id: 2,
      admin_graphql_api_id: 'gid://shopify/InventoryLevel/not-decimal',
    },
    'inventory_level_identity_malformed',
  ],
  [
    'inventory_levels/connect',
    {
      inventory_item_id: 1,
      location_id: 2,
      admin_graphql_api_id:
        'gid://shopify/InventoryLevel/2'
        + '?inventory_item_id=123456789012345678901',
    },
    'inventory_level_identity_oversized',
  ],
  [
    'inventory_levels/connect',
    {
      inventory_item_id: 1,
      location_id: 2,
      admin_graphql_api_id:
        'gid://shopify/InventoryLevel/2?inventory_item_id=9',
    },
    'inventory_item_identity_conflict',
  ],
  [
    'inventory_levels/update',
    {
      inventory_item_id: 1,
      location_id: 2,
      admin_graphql_api_id:
        'gid://shopify/InventoryLevel/1?location_id=2',
    },
    'inventory_level_identity_malformed',
  ],
]

for (const [
  topic,
  verifiedPayload,
  reasonCode,
  verifiedRawPayload,
] of fullRequiredFixtures) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseTarget({
      topic,
      verifiedPayload,
      verifiedRawPayload,
    }))),
    {
      targetingState: 'full_required',
      reasonCode,
      inventoryItemGid: null,
      sourceLocationGid: null,
    },
  )
}

const integrationReceiptInputs = []
class StubProviderError extends Error {}
const webhookRuntime = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  globalId: 'gia1234567',
  provider: 'shopify',
  environment: 'sandbox',
  externalAccountId: 'gid://shopify/Shop/123456789',
  credentialVersion: 3,
  status: 'active',
  verificationStatus: 'verified',
  configuration: { shopDomain: 'target-signals.myshopify.com' },
  encrypted: {
    ciphertext: Buffer.from('credential'),
    iv: Buffer.alloc(12),
    tag: Buffer.alloc(16),
  },
}
const integrationService = loadTypeScriptModule(
  'app_src/lib/integrations/commerceIntegrations.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCredentialCrypto': {
        normalizeCommerceAccountGlobalId(value) {
          return String(value)
        },
        decryptCommerceCredential() {
          return {
            provider: 'shopify',
            clientId: 'target-signal-client',
            clientSecret: 'target-signal-secret',
          }
        },
        encryptCommerceWebhookPayload() {
          return {
            ciphertext: Buffer.from('encrypted-receipt'),
            iv: Buffer.alloc(12),
            tag: Buffer.alloc(16),
          }
        },
      },
      '@/lib/integrations/faireCommerceClient': {
        FAIRE_API_SCOPES: [],
        FaireCommerceClientError: StubProviderError,
      },
      '@/lib/integrations/commerceCapabilities': {
        auditShopifyScopeUpdatePayload() {
          return null
        },
        auditShopifyScopeRequirements() {
          return null
        },
        hasEffectiveShopifyScope() {
          return true
        },
        SHOPIFY_ADMIN_API_VERSION: '2026-07',
        SHOPIFY_CATALOG_REFRESH_WEBHOOK_TOPICS: [
          'products/create',
          'products/delete',
          'products/update',
        ],
        SHOPIFY_CONTROL_PLANE_WEBHOOK_TOPICS: [
          'app/scopes_update',
          ...inventoryTopics,
          'products/create',
          'products/delete',
          'products/update',
        ],
        SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES: [],
        SHOPIFY_INVENTORY_REFRESH_WEBHOOK_TOPICS: inventoryTopics,
        SHOPIFY_RECEIPT_PROOF_SCOPES: [],
        SHOPIFY_SCOPE_REFRESH_WEBHOOK_TOPICS: ['app/scopes_update'],
      },
      '@/lib/integrations/shopifyCommerceClient': {
        normalizeShopifyShopDomain(value) {
          return String(value)
        },
        verifyShopifyWebhookHmac() {
          return true
        },
        ShopifyCommerceClientError: StubProviderError,
      },
      '@/lib/integrations/shopifyCatalogWebhook': {
        shopifyDeletedProductEvidence() {
          return null
        },
      },
      '@/lib/integrations/shopifyInventoryWebhook': {
        shopifyInventoryWebhookTargeting: parser,
      },
      '@/lib/integrations/shopifyOrderWebhook': {
        async discoverShopifyOrderWebhookSubscriptions() {
          throw new Error('Order webhook discovery is outside this inventory test')
        },
        isShopifyOrderSignalWebhookTopic() {
          return false
        },
        shopifyOrderWebhookSignalEvidence() {
          throw new Error('Order webhook evidence is outside this inventory test')
        },
        SHOPIFY_ORDER_SIGNAL_INCLUDE_FIELDS: [
          'admin_graphql_api_id',
          'updated_at',
        ],
        SHOPIFY_ORDER_SIGNAL_WEBHOOK_TOPICS: [
          'orders/create',
          'orders/updated',
          'orders/edited',
          'orders/cancelled',
          'orders/paid',
          'orders/fulfilled',
          'orders/partially_fulfilled',
        ],
        ShopifyOrderWebhookError: StubProviderError,
      },
      '@/lib/integrations/shopifyOrderPreview': {
        SHOPIFY_ORDER_PREVIEW_MAX_ORDERS: 25,
        SHOPIFY_ORDER_PREVIEW_POLICY_VERSION: 'test-v1',
        ShopifyOrderPreviewError: StubProviderError,
      },
      '@/lib/persistence/commerceIntegrations': {
        async readCommerceWebhookCredentialFromPostgres() {
          return webhookRuntime
        },
        async recordShopifyWebhookReceiptInPostgres(input) {
          integrationReceiptInputs.push(input)
          return { globalId: `gcw${integrationReceiptInputs.length}` }
        },
        async markShopifyWebhookSecretVerifiedInPostgres() {},
      },
      '@/lib/persistence/commerceOrderPreviews': {},
      '@/lib/persistence/shopifyOrderWebhookSignals': {
        async recordShopifyOrderWebhookSignalInPostgres() {
          throw new Error('Order webhook persistence is outside this inventory test')
        },
        ShopifyOrderWebhookSignalPersistenceError: StubProviderError,
      },
      '@/lib/persistence/shopifyOrderWebhookReconciliation': {
        ShopifyOrderWebhookReconciliationPersistenceError: StubProviderError,
      },
      '@/lib/persistence/shopifyFulfillmentNotifications': {
        ShopifyFulfillmentNotificationPolicyError: StubProviderError,
      },
      '@/lib/publicUrl': {
        appPublicUrl() {
          return 'https://clawpilot.example'
        },
      },
    },
  },
)

async function receiveWebhook(rawPayload, topic, providerEventId) {
  return integrationService.receiveShopifyWebhook({
    accountGlobalId: webhookRuntime.globalId,
    rawBody: Buffer.from(rawPayload),
    hmac: 'valid-test-hmac',
    providerEventId,
    topic,
    sourceDomain: webhookRuntime.configuration.shopDomain,
    providerApiVersion: '2026-07',
    providerTriggeredAt: '2026-08-11T12:00:00.000Z',
  })
}

await receiveWebhook('[]', 'inventory_levels/update', 'event-array-0001')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    integrationReceiptInputs.at(-1).inventoryTargeting,
  )),
  {
    targetingState: 'full_required',
    reasonCode: 'multiple_identity',
    inventoryItemGid: null,
    sourceLocationGid: null,
  },
  'A signed inventory array must persist full-required evidence',
)
await receiveWebhook('42', 'inventory_items/update', 'event-scalar-0002')
assert.equal(
  integrationReceiptInputs.at(-1).inventoryTargeting.reasonCode,
  'payload_not_object',
  'A signed inventory scalar must persist full-required evidence',
)
const duplicateGidRaw = [
  '{"id":1,',
  '"admin_graphql_api_id":"gid://shopify/InventoryItem/1",',
  '"admin_graphql_api_id":"gid://shopify/InventoryItem/2"}',
].join('')
await receiveWebhook(
  duplicateGidRaw,
  'inventory_items/update',
  'event-duplicate-gid-0003',
)
assert.equal(
  integrationReceiptInputs.at(-1).inventoryTargeting.reasonCode,
  'multiple_identity',
  'Duplicate raw GID keys must not collapse into one target',
)
await assert.rejects(
  () => receiveWebhook('[]', 'products/update', 'event-product-array-0004'),
  (error) => error?.code === 'SHOPIFY_WEBHOOK_JSON_INVALID',
  'Non-inventory webhook topics must retain the object-only boundary',
)

const migration = read(
  'db/migrations/0269_operations_shopify_inventory_target_signals.sql',
)
includes(migration, [
  'operations_shopify_inventory_target_signals',
  'credential_generation integer NOT NULL',
  'receipt_id uuid NOT NULL',
  'receipt_global_id text NOT NULL',
  'dirty_version bigint NOT NULL CHECK (dirty_version > 0)',
  'targeting_state IN (\'targeted\', \'full_required\')',
  'UNIQUE (receipt_global_id)',
  'UNIQUE (organization_id, integration_account_id, dirty_version)',
  'operations_shopify_inventory_target_signals_receipt_fkey',
  'receipt.provider_triggered_at',
  'IS NOT DISTINCT FROM NEW.provider_triggered_at',
  'receipt.received_at = NEW.received_at',
  'watermark.dirty_version = NEW.dirty_version',
  'watermark.last_receipt_global_id = NEW.receipt_global_id',
  'Shopify inventory target signals are append-only',
  'operations_shopify_inventory_target_signal_metrics',
  'average_delivery_lag_seconds',
  'metrics only and never select worker execution',
], 'Shopify inventory target-signal migration')
assert.doesNotMatch(migration, /ON DELETE CASCADE/)

const signalQueries = []
const signalPersistence = loadTypeScriptModule(
  'app_src/lib/persistence/shopifyInventoryTargetSignals.ts',
)
const inserted = await signalPersistence
  .recordShopifyInventoryTargetSignalWithClient(
    {
      async query(sql, values) {
        signalQueries.push({ sql, values })
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }
      },
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
      credentialGeneration: 4,
      receiptId: '33333333-3333-4333-8333-333333333333',
      receiptGlobalId: 'gcw1234567',
      dirtyVersion: 11,
      topic: 'inventory_levels/update',
      targeting: parseTarget({
        topic: 'inventory_levels/update',
        verifiedPayload: { inventory_item_id: 203, location_id: 303 },
      }),
    },
  )
assert.deepEqual(JSON.parse(JSON.stringify(inserted)), {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
})
assert.equal(signalQueries.length, 1)
includes(signalQueries[0].sql, [
  'INSERT INTO operations_shopify_inventory_target_signals',
  'receipt_id',
  'receipt_global_id',
  'dirty_version',
  'inventory_item_gid',
  'source_location_gid',
  'targeting_state',
  'reason_code',
  'provider_triggered_at',
  'received_at',
  'FROM operations_commerce_webhook_receipts receipt',
  "'system'",
], 'Shopify target-signal persistence')
assert.equal(signalQueries[0].values[5], 11)
assert.equal(signalQueries[0].values[7], 'gid://shopify/InventoryItem/203')
assert.equal(signalQueries[0].values[8], 'gid://shopify/Location/303')
assert.equal(signalQueries[0].values[9], 'targeted')

const integrationSource = read(
  'app_src/lib/integrations/commerceIntegrations.ts',
)
const receiveWebhookSource = integrationSource.slice(
  integrationSource.indexOf('export async function receiveShopifyWebhook'),
)
assert.ok(
  receiveWebhookSource.indexOf('verifyShopifyWebhookHmac({')
    < receiveWebhookSource.indexOf('shopifyInventoryWebhookTargeting({'),
  'Target identity must be derived only after the raw body HMAC is verified',
)
assert.ok(
  receiveWebhookSource.indexOf('shopifyInventoryWebhookTargeting({')
    < receiveWebhookSource.indexOf('encryptCommerceWebhookPayload(')
    && receiveWebhookSource.indexOf('encryptCommerceWebhookPayload(')
      < receiveWebhookSource.indexOf('recordShopifyWebhookReceiptInPostgres({'),
  'Target classification and encrypted receipt must share one persistence call',
)

const receiptPersistence = read(
  'app_src/lib/persistence/commerceIntegrations.ts',
)
const receiptFunction = receiptPersistence.slice(
  receiptPersistence.indexOf(
    'export async function recordShopifyWebhookReceiptInPostgres',
  ),
  receiptPersistence.indexOf(
    'export async function replayHeldShopifyProductDeletionsInPostgres',
  ),
)
assert.ok(
  receiptFunction.indexOf('INSERT INTO operations_commerce_webhook_receipts')
    < receiptFunction.indexOf('signalShopifyInventoryRefreshWithClient(')
    && receiptFunction.indexOf('signalShopifyInventoryRefreshWithClient(')
      < receiptFunction.indexOf(
        'recordShopifyInventoryTargetSignalWithClient(client,',
      ),
  'Receipt, dirty watermark, and target signal must commit in one transaction',
)
includes(receiptFunction, [
  'RETURNING',
  'id::text',
  'provider_triggered_at',
  'targetingState: input.inventoryTargeting.targetingState',
  "refreshExecutionMode: 'full_authoritative'",
  'webhookQuantityApplied: false',
  'providerWrites: 0',
], 'Shopify receipt shadow targeting boundary')

const workerPersistence = read(
  'app_src/lib/persistence/shopifyInventoryRefresh.ts',
)
assert.doesNotMatch(
  workerPersistence,
  /operations_shopify_inventory_target_signals|targetingState|inventoryItemGid/,
  'Phase-one target evidence must not select inventory worker execution',
)

const packageManifest = JSON.parse(read('package.json'))
assert.equal(
  packageManifest.scripts['test:shopify-inventory-target-signals'],
  'node scripts/test-shopify-inventory-target-signals.mjs',
)

const predeploy = read('scripts/verify-predeploy.mjs')
includes(predeploy, [
  "'db/migrations/0269_operations_shopify_inventory_target_signals.sql'",
  "'app_src/lib/integrations/shopifyInventoryWebhook.ts'",
  "'app_src/lib/persistence/shopifyInventoryTargetSignals.ts'",
  "'scripts/test-shopify-inventory-target-signals.mjs'",
], 'Shopify target-signal predeploy manifest')

console.log(
  'Shopify inventory target-signal tests passed '
  + '(six signed topics, strict one-target parsing, full-read fallback, '
  + 'atomic append-only evidence, metrics-only shadow mode).',
)
