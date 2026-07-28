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
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Headers,
    Map,
    Object,
    Promise,
    RangeError,
    Request,
    Response,
    Set,
    TextDecoder,
    TextEncoder,
    TypeError,
    URL,
    URLSearchParams,
    Uint8Array,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
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

class ShopifyCommerceClientError extends Error {
  constructor(
    message,
    status = 502,
    code = 'SHOPIFY_UPSTREAM_FAILED',
    retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyCommerceClientError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

const projection = loadTypeScriptModule(
  'app_src/lib/operations/shopifyInventoryProjection.ts',
)
const stateNames = Array.from(projection.SHOPIFY_INVENTORY_STATE_NAMES)
assert.deepEqual(stateNames, [
  'available',
  'incoming',
  'committed',
  'damaged',
  'on_hand',
  'quality_control',
  'reserved',
  'safety_stock',
])

const projected = projection.projectShopifyInventoryBalance({
  mapped: true,
  tracked: true,
  quantities: {
    available: 7,
    incoming: 4,
    committed: 3,
    damaged: 0,
    on_hand: 10,
    quality_control: 0,
    reserved: 0,
    safety_stock: 0,
  },
})
assert.equal(projected.state, 'projected')
assert.equal(projected.operationalOnHand, 10)
assert.equal(projected.operationalReserved, 3)
assert.equal(projected.operationalAvailable, 7)
assert.equal(
  projected.operationalAvailable,
  7,
  'Shopify available is already ATP and must not be reduced by imported orders',
)
assert.equal(
  projection.shopifyPhysicalStateTotal({
    available: 7,
    incoming: 4,
    committed: 3,
    damaged: 1,
    on_hand: 14,
    quality_control: 1,
    reserved: 1,
    safety_stock: 1,
  }),
  14,
  'Incoming inventory must not be counted as physical on-hand inventory',
)
assert.equal(
  projection.projectShopifyInventoryBalance({
    mapped: true,
    tracked: true,
    quantities: {
      available: 7,
      incoming: 0,
      committed: 3,
      damaged: 0,
      on_hand: 11,
      quality_control: 0,
      reserved: 0,
      safety_stock: 0,
    },
  }).state,
  'inconsistent',
)

const location = Object.freeze({
  id: 'gid://shopify/Location/1',
  name: 'AG Alchemy',
  isActive: true,
  shipsInventory: true,
  fulfillsOnlineOrders: true,
  hasActiveInventory: true,
  addressVerified: true,
  isFulfillmentService: false,
  fulfillmentService: null,
  address: {
    line1: '7009 S 108th St',
    line2: '',
    city: 'La Vista',
    region: 'Nebraska',
    regionCode: 'NE',
    postalCode: '68128',
    country: 'United States',
    countryCode: 'US',
  },
})

function definition(input) {
  return {
    id: `gid://shopify/MetafieldDefinition/${input.id}`,
    namespace: input.namespace,
    key: input.key,
    name: input.name,
    description: input.description || '',
    ownerType: input.ownerType,
    type: {
      name: input.type,
      category: input.type === 'dimension'
        ? 'MEASUREMENT'
        : 'LIST',
    },
  }
}

const variantDimensionDefinitions = [
  definition({
    id: 1,
    namespace: 'custom',
    key: 'package_length',
    name: 'Package length',
    ownerType: 'PRODUCTVARIANT',
    type: 'dimension',
  }),
  definition({
    id: 2,
    namespace: 'legacy',
    key: 'case_length',
    name: 'Case length',
    ownerType: 'PRODUCTVARIANT',
    type: 'dimension',
  }),
  definition({
    id: 3,
    namespace: 'custom',
    key: 'package_width',
    name: 'Package width',
    ownerType: 'PRODUCTVARIANT',
    type: 'dimension',
  }),
  definition({
    id: 4,
    namespace: 'custom',
    key: 'package_height',
    name: 'Package height',
    ownerType: 'PRODUCTVARIANT',
    type: 'dimension',
  }),
]
const variantListDefinitions = [
  definition({
    id: 5,
    namespace: 'custom',
    key: 'alternate_lengths',
    name: 'Alternate lengths',
    ownerType: 'PRODUCTVARIANT',
    type: 'list.dimension',
  }),
]
const productDimensionDefinitions = [
  definition({
    id: 6,
    namespace: 'shipping',
    key: 'length',
    name: 'Shipping length',
    ownerType: 'PRODUCT',
    type: 'dimension',
  }),
  definition({
    id: 7,
    namespace: 'shipping',
    key: 'width',
    name: 'Shipping width',
    ownerType: 'PRODUCT',
    type: 'dimension',
  }),
  definition({
    id: 8,
    namespace: 'shipping',
    key: 'height',
    name: 'Shipping height',
    ownerType: 'PRODUCT',
    type: 'dimension',
  }),
]

function connection(nodes, hasNextPage = false, endCursor = null) {
  return {
    nodes,
    pageInfo: { hasNextPage, endCursor },
  }
}

function physicalMetafields(prefix, values) {
  return connection(Object.entries(values).map(([axis, value]) => ({
    namespace: prefix,
    key: axis,
    type: 'dimension',
    value: JSON.stringify(value),
    jsonValue: value,
    updatedAt: '2026-07-28T12:00:00.000Z',
    definition: {
      id: `gid://shopify/MetafieldDefinition/${prefix}-${axis}`,
      name: `${prefix} ${axis}`,
      ownerType: 'PRODUCT',
      type: { name: 'dimension', category: 'MEASUREMENT' },
    },
  })))
}

function inventoryLevel(id, quantities) {
  const productFields = physicalMetafields('shipping', {
    length: { value: 10, unit: 'INCHES' },
    width: { value: 8, unit: 'INCHES' },
    height: { value: 6, unit: 'INCHES' },
  })
  const variantFields = physicalMetafields('custom', {
    package_width: { value: 8, unit: 'INCHES' },
    package_height: { value: 6, unit: 'INCHES' },
  })
  return {
    id: `gid://shopify/InventoryLevel/${id}?location_id=1`,
    isActive: true,
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    item: {
      id: `gid://shopify/InventoryItem/${id}`,
      legacyResourceId: String(id),
      sku: `SKU-${id}`,
      duplicateSkuCount: 0,
      tracked: true,
      requiresShipping: true,
      createdAt: '2026-07-01T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
      measurement: {
        id: `gid://shopify/InventoryItemMeasurement/${id}`,
        weight: { value: 1, unit: 'POUNDS' },
      },
      unitCost: { amount: '3.50', currencyCode: 'USD' },
      countryCodeOfOrigin: 'US',
      provinceCodeOfOrigin: 'NE',
      harmonizedSystemCode: '190590',
      countryHarmonizedSystemCodes: connection([
        { countryCode: 'CA', harmonizedSystemCode: '19059090' },
      ]),
      variants: connection([{
        id: `gid://shopify/ProductVariant/${id}`,
        legacyResourceId: String(id),
        sku: `SKU-${id}`,
        barcode: `BAR-${id}`,
        title: 'Default Title',
        displayName: `Product ${id}`,
        position: 1,
        selectedOptions: [{ name: 'Title', value: 'Default Title' }],
        price: '12.00',
        compareAtPrice: null,
        taxable: true,
        inventoryPolicy: 'DENY',
        inventoryQuantity: quantities.available,
        sellableOnlineQuantity: quantities.available,
        availableForSale: quantities.available > 0,
        requiresComponents: false,
        createdAt: '2026-07-01T12:00:00.000Z',
        updatedAt: '2026-07-28T12:00:00.000Z',
        physicalVariantFields: variantFields,
        product: {
          id: `gid://shopify/Product/${id}`,
          legacyResourceId: String(id),
          title: `Product ${id}`,
          description: 'Operational product facts',
          handle: `product-${id}`,
          vendor: 'AG Alchemy',
          productType: 'Snack',
          status: 'ACTIVE',
          tags: ['test', 'inventory'],
          isGiftCard: false,
          tracksInventory: true,
          totalInventory: quantities.on_hand,
          hasOutOfStockVariants: false,
          hasVariantsThatRequiresComponents: false,
          onlineStoreUrl: `https://example.test/products/product-${id}`,
          publishedAt: '2026-07-01T12:00:00.000Z',
          createdAt: '2026-07-01T12:00:00.000Z',
          updatedAt: '2026-07-28T12:00:00.000Z',
          category: {
            id: 'gid://shopify/TaxonomyCategory/aa',
            name: 'Food',
            fullName: 'Food > Snacks',
          },
          options: [{
            id: `gid://shopify/ProductOption/${id}`,
            name: 'Title',
            position: 1,
            values: ['Default Title'],
          }],
          featuredMedia: null,
          physicalProductFields: productFields,
        },
      }]),
    },
    quantities: stateNames.map((name, index) => ({
      id: `gid://shopify/InventoryQuantity/${id}-${index}?name=${name}`,
      name,
      quantity: quantities[name],
      updatedAt: '2026-07-28T12:00:00.000Z',
    })),
  }
}

function definitionNodes(ownerType, definitionQuery, reverse) {
  const nodes = ownerType === 'PRODUCTVARIANT'
    ? (
        definitionQuery === 'type:dimension'
          ? variantDimensionDefinitions
          : variantListDefinitions
      )
    : (
        definitionQuery === 'type:dimension'
          ? productDimensionDefinitions
          : []
      )
  return reverse ? [...nodes].reverse() : [...nodes]
}

function createGraphqlMock({
  reverse = false,
  noDimensionDefinitions = false,
  denyUnitCostOnce = false,
} = {}) {
  const inventoryRequests = []
  let unitCostDenied = false
  const baseQuantities = {
    available: 7,
    incoming: 4,
    committed: 3,
    damaged: 0,
    on_hand: 10,
    quality_control: 0,
    reserved: 0,
    safety_stock: 0,
  }
  const otherQuantities = {
    available: 2,
    incoming: 0,
    committed: 1,
    damaged: 1,
    on_hand: 5,
    quality_control: 0,
    reserved: 1,
    safety_stock: 0,
  }
  const levels = [
    inventoryLevel(101, baseQuantities),
    inventoryLevel(102, otherQuantities),
  ]
  return {
    inventoryRequests,
    async shopifyAdminGraphql(_credential, request) {
      if (request.operationName === 'ClawPilotDimensionDefinitions') {
        return {
          metafieldDefinitions: connection(
            noDimensionDefinitions
              ? []
              : definitionNodes(
                  request.variables.ownerType,
                  request.variables.definitionQuery,
                  reverse,
                ),
          ),
        }
      }
      assert.equal(
        request.operationName,
        'ClawPilotInventoryByLocation',
      )
      inventoryRequests.push(request)
      if (
        denyUnitCostOnce
        && !unitCostDenied
        && request.query.includes('unitCost {')
      ) {
        unitCostDenied = true
        throw new ShopifyCommerceClientError(
          'Access denied for unitCost field.',
          403,
          'SHOPIFY_ACCESS_DENIED',
        )
      }
      return {
        location: {
          id: location.id,
          inventoryLevels: connection(
            reverse ? [...levels].reverse() : levels,
          ),
        },
      }
    },
  }
}

function loadAdapter(graphqlMock) {
  return loadTypeScriptModule(
    'app_src/lib/integrations/shopifyInventory.ts',
    {
      mocks: {
        '@/lib/integrations/shopifyCommerceClient': {
          ShopifyCommerceClientError,
          shopifyAdminGraphql: graphqlMock.shopifyAdminGraphql,
        },
        '@/lib/operations/shopifyInventoryProjection': projection,
      },
    },
  )
}

const credential = {
  shopDomain: 'ag-alchemy.myshopify.com',
  accessToken: 'not-a-real-token',
}
const firstMock = createGraphqlMock()
const firstAdapter = loadAdapter(firstMock)
const firstSnapshot = await firstAdapter.fetchShopifyInventorySnapshot(
  credential,
  location,
)
assert.equal(firstSnapshot.levels.length, 2)
assert.equal(firstSnapshot.levels[0].quantities.available, 7)
assert.equal(
  Object.keys(firstSnapshot.levels[0].quantityEvidence).length,
  8,
)
assert.match(
  firstSnapshot.levels[0].quantityEvidence.available.id,
  /^gid:\/\/shopify\/InventoryQuantity\//,
)
assert.equal(firstSnapshot.levels[0].equationMatches, true)
assert.equal(firstSnapshot.levels[0].providerWeightGrams, 454)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    firstSnapshot.levels[0].providerDimensionsMm,
  )),
  {
    length: 254,
    width: 203,
    height: 152,
    source: 'product_metafield',
    sourceKeys: [
      'shipping.length',
      'shipping.width',
      'shipping.height',
    ],
  },
)
assert.deepEqual(
  Object.fromEntries(
    firstSnapshot.enrichment.ambiguousDimensionDefinitions.map(
      (item) => [item.identifier, item.type],
    ),
  ),
  {
    'custom.alternate_lengths': 'list.dimension',
    'custom.package_length': 'dimension',
    'legacy.case_length': 'dimension',
  },
)

assert.equal(firstMock.inventoryRequests.length, 1)
const inventoryRequest = firstMock.inventoryRequests[0]
assert.equal(inventoryRequest.variables.first, 25)
assert.deepEqual(
  Array.from(inventoryRequest.variables.quantityNames),
  stateNames,
)
assert.deepEqual(
  Array.from(inventoryRequest.variables.variantDimensionKeys),
  ['custom.package_width', 'custom.package_height'],
)
assert.deepEqual(
  Array.from(inventoryRequest.variables.productDimensionKeys),
  ['shipping.length', 'shipping.width', 'shipping.height'],
)
assert.match(inventoryRequest.query, /inventoryLevels\(\s*first: \$first/)
assert.match(inventoryRequest.query, /variants\(first: 2\)/)
assert.match(
  inventoryRequest.query,
  /countryHarmonizedSystemCodes\(first: 10\)/,
)
assert.match(
  inventoryRequest.query,
  /physicalVariantFields: metafields\(\s*first: 2/,
)
assert.match(
  inventoryRequest.query,
  /physicalProductFields: metafields\(\s*first: 3/,
)
assert.ok(
  !inventoryRequest.query.includes('first: 250'),
  'Inventory GraphQL fan-out must stay bounded below Shopify query-cost limits',
)

const reverseMock = createGraphqlMock({ reverse: true })
const reverseAdapter = loadAdapter(reverseMock)
const reverseSnapshot = await reverseAdapter.fetchShopifyInventorySnapshot(
  credential,
  location,
)
assert.notEqual(firstSnapshot.fetchedAt, undefined)
assert.equal(
  reverseSnapshot.snapshotHash,
  firstSnapshot.snapshotHash,
  'Snapshot hashes must not depend on provider connection order or fetchedAt',
)

const leastPrivilegeMock = createGraphqlMock({
  noDimensionDefinitions: true,
  denyUnitCostOnce: true,
})
const leastPrivilegeAdapter = loadAdapter(leastPrivilegeMock)
const leastPrivilegeSnapshot =
  await leastPrivilegeAdapter.fetchShopifyInventorySnapshot(
    credential,
    location,
  )
assert.equal(leastPrivilegeMock.inventoryRequests.length, 2)
assert.match(
  leastPrivilegeMock.inventoryRequests[0].query,
  /unitCost \{/,
)
assert.ok(
  !leastPrivilegeMock.inventoryRequests[1].query.includes('unitCost {'),
  'Inventory reads must retry without optional unit-cost access',
)
assert.ok(
  !Object.hasOwn(
    leastPrivilegeMock.inventoryRequests[1].variables,
    'variantDimensionKeys',
  )
    && !Object.hasOwn(
      leastPrivilegeMock.inventoryRequests[1].variables,
      'productDimensionKeys',
    ),
  'Empty Shopify metafield key arrays must not be sent',
)
assert.ok(
  !leastPrivilegeMock.inventoryRequests[1].query.includes(
    'physicalVariantFields',
  )
    && !leastPrivilegeMock.inventoryRequests[1].query.includes(
      'physicalProductFields',
    ),
  'Empty dimension selections must be omitted from the GraphQL query',
)
assert.equal(leastPrivilegeSnapshot.enrichment.unitCostAvailable, false)
assert.equal(leastPrivilegeSnapshot.levels[0].providerDimensionsMm, null)

const inventoryMigration = read(
  'db/migrations/0124_operations_shopify_inventory.sql',
)
for (const fragment of [
  'operations_commerce_inventory_captures',
  'captured_snapshot jsonb NOT NULL',
  'provider_quantity_evidence jsonb NOT NULL',
  'levels_projected integer NOT NULL',
  "source_authority IN ('clawpilot', 'shopify')",
  "'clawpilot.shopify_inventory_sync', true",
  ") IS DISTINCT FROM 'on' THEN",
  'provider_writes integer NOT NULL DEFAULT 0 CHECK (provider_writes = 0)',
  'order_quantity_adjustment numeric(20,6) NOT NULL DEFAULT 0',
]) {
  assert.ok(
    inventoryMigration.includes(fragment),
    `Shopify inventory migration missing ${fragment}`,
  )
}
const inventoryPersistence = read(
  'app_src/lib/persistence/commerceInventory.ts',
)
assert.ok(
  inventoryPersistence.indexOf(
    'captureShopifyInventorySnapshotInPostgres',
  ) < inventoryPersistence.indexOf(
    'applyShopifyInventorySnapshotInPostgres',
  ),
  'Provider evidence capture must be defined before operational projection',
)
assert.match(
  inventoryPersistence,
  /SET LOCAL|set_config\(\s*'clawpilot\.shopify_inventory_sync'/,
)
assert.match(
  inventoryPersistence,
  /projectShopifyInventoryBalance\(\{/,
)
assert.match(
  inventoryPersistence,
  /product\.reference_code AS product_global_id/,
  'Inventory projection must use the canonical CRM product reference column',
)
assert.ok(
  !inventoryPersistence.includes('product.global_id'),
  'CRM products do not expose a global_id column',
)
assert.match(
  inventoryPersistence,
  /actor_email, correlation_id, idempotency_key/,
  'Inventory domain events must include the required correlation ID',
)
assert.ok(
  !inventoryPersistence.includes('BigInt(')
    && !inventoryPersistence.includes('0n'),
  'Inventory projection must compile for the repository ES2017 target',
)
const inventoryOrchestration = read(
  'app_src/lib/integrations/commerceInventory.ts',
)
assert.ok(
  inventoryOrchestration.indexOf(
    'captureShopifyInventorySnapshotInPostgres({',
  ) < inventoryOrchestration.indexOf(
    'applyShopifyInventorySnapshotInPostgres({',
  ),
  'Orchestration must durably capture Shopify before applying inventory',
)
assert.match(
  inventoryOrchestration,
  /location\.shipsInventory[\s\S]+location\.fulfillsOnlineOrders[\s\S]+!location\.isFulfillmentService/,
)
const operationsPersistence = read(
  'app_src/lib/persistence/operations.ts',
)
assert.match(
  operationsPersistence,
  /input\.position\.source_authority !== 'clawpilot'/,
  'Local reservations must reject Shopify-authoritative positions',
)

console.log(
  'Commerce inventory adapter tests passed '
  + '(8 states, projection, capture, authority, dimensions, bounds, fallback, deterministic hash).',
)
