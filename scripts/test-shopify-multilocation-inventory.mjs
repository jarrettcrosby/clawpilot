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
    RegExp,
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

class CommerceIntegrationRequestError extends Error {
  constructor(message, status = 409, code = 'COMMERCE_REQUEST_FAILED') {
    super(message)
    this.name = 'CommerceIntegrationRequestError'
    this.status = status
    this.code = code
  }
}

class CommerceInventoryPersistenceError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'CommerceInventoryPersistenceError'
    this.code = code
    this.status = status
  }
}

class ShopifyCommerceClientError extends Error {
  constructor(message, status = 502, code = 'SHOPIFY_UPSTREAM_FAILED') {
    super(message)
    this.name = 'ShopifyCommerceClientError'
    this.status = status
    this.code = code
    this.retryable = false
  }
}

const merchantLocation = {
  id: 'gid://shopify/Location/108489507063',
  name: 'Shop location',
  isActive: true,
  shipsInventory: true,
  fulfillsOnlineOrders: true,
  hasActiveInventory: true,
  addressVerified: true,
  isFulfillmentService: false,
  fulfillmentService: null,
  address: {
    line1: '35 Saxony Drive',
    line2: '',
    city: 'Trumbull',
    region: 'Connecticut',
    regionCode: 'CT',
    postalCode: '06611',
    country: 'United States',
    countryCode: 'US',
  },
}

const appManagedLocation = {
  ...merchantLocation,
  id: 'gid://shopify/Location/108489507064',
  name: 'Snow City Warehouse',
  isFulfillmentService: true,
  fulfillmentService: {
    id: 'gid://shopify/FulfillmentService/9001',
    handle: 'snow-city',
    serviceName: 'Snow City',
    type: 'THIRD_PARTY',
    inventoryManagement: true,
  },
}

const secondMerchantLocation = {
  ...merchantLocation,
  id: 'gid://shopify/Location/108489507065',
  name: 'My Custom Location',
}

const runtime = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  globalId: 'gia0000001',
  provider: 'shopify',
  environment: 'development',
  externalAccountId: 'gid://shopify/Shop/1',
  status: 'active',
  verificationStatus: 'verified',
  credentialVersion: 3,
  authMode: 'shopify_client_credentials',
  configuration: { shopDomain: 'test-pro-bakery-bites.myshopify.com' },
  encrypted: {},
}

let mappedInput = null
let createdInput = null
const integration = loadTypeScriptModule(
  'app_src/lib/integrations/commerceInventory.ts',
  {
    mocks: {
      '@/lib/integrations/commerceCredentialCrypto': {
        decryptCommerceCredential() {
          return {
            provider: 'shopify',
            clientId: 'client',
            clientSecret: 'secret',
          }
        },
        normalizeCommerceAccountGlobalId(value) {
          return String(value)
        },
        normalizeCommerceOrganizationId(value) {
          return String(value)
        },
      },
      '@/lib/integrations/commerceIntegrations': {
        CommerceIntegrationRequestError,
        sanitizedCommerceIntegrationError(error) {
          return error instanceof CommerceIntegrationRequestError
            ? error
            : new CommerceIntegrationRequestError(
              error.message,
              error.status,
              error.code,
            )
        },
      },
      '@/lib/integrations/commerceCapabilities': {
        hasEffectiveShopifyScope(scopes, scope) {
          return scopes.includes(scope)
        },
      },
      '@/lib/integrations/commerceReadRuntime': {
        commerceReadCredentialEligible() { return true },
        commerceReadRuntimeAvailable() { return true },
        commerceReadRuntimeMode() { return 'development' },
      },
      '@/lib/integrations/shopifyCommerceClient': {
        normalizeShopifyShopDomain(value) { return String(value) },
        async probeShopifyConnection() {
          return {
            shopId: runtime.externalAccountId,
            grantedScopes: [
              'read_inventory',
              'read_locations',
              'read_products',
            ],
          }
        },
        async requestShopifyAccessToken() {
          return {
            accessToken: 'token',
            grantedScopes: [
              'read_inventory',
              'read_locations',
              'read_products',
            ],
          }
        },
        ShopifyCommerceClientError,
      },
      '@/lib/integrations/shopifyInventory': {
        async listShopifyInventoryLocations() {
          return [
            merchantLocation,
            appManagedLocation,
            secondMerchantLocation,
          ]
        },
        SHOPIFY_INVENTORY_ADAPTER_VERSION: 'test',
      },
      '@/lib/persistence/commerceInventory': {
        CommerceInventoryPersistenceError,
        async mapShopifyInventoryLocationInPostgres(input) {
          mappedInput = input
          return {
            mapping: {
              globalId: 'gilm0000001',
              externalLocationId: input.providerLocation.id,
              externalLocationName: input.providerLocation.name,
              ownershipClassification: 'merchant_managed',
              inventoryImportEnabled: true,
              rowVersion: 0,
              warehouseGlobalId: input.warehouseGlobalId,
              locationGlobalId: input.locationGlobalId,
            },
            providerWrites: 0,
            replayed: false,
          }
        },
        async createShopifyInventoryWarehouseAndMappingInPostgres(input) {
          createdInput = input
          return {
            warehouse: {
              globalId: 'gwh0000002',
              code: input.warehouse.code,
              name: input.warehouse.name,
              facilityType: input.warehouse.facilityType,
              timezone: input.warehouse.timezone,
              inventoryLocationGlobalId: 'gwl0000002',
              inventoryLocationCode: 'RESERVE-01',
            },
            mapping: {
              globalId: 'gilm0000002',
              externalLocationId: input.providerLocation.id,
              externalLocationName: input.providerLocation.name,
              ownershipClassification: 'merchant_managed',
              inventoryImportEnabled: true,
              rowVersion: 0,
              warehouseGlobalId: 'gwh0000002',
              locationGlobalId: 'gwl0000002',
            },
            providerWrites: 0,
            replayed: false,
          }
        },
        async readShopifyInventoryConfigurationFromPostgres() {
          if (createdInput) {
            return {
              warehouses: [{
                globalId: 'gwh0000002',
                code: createdInput.warehouse.code,
                name: createdInput.warehouse.name,
                address: {},
                status: 'active',
                locations: [{
                  globalId: 'gwl0000002',
                  code: 'RESERVE-01',
                  zone: 'STORAGE',
                  locationType: 'storage',
                  active: true,
                }],
              }],
              mappings: [{
                globalId: 'gilm0000002',
                externalLocationId: secondMerchantLocation.id,
                externalLocationName: secondMerchantLocation.name,
                externalLocationAddress: secondMerchantLocation.address,
                mappingMethod: 'manual',
                ownershipClassification: 'merchant_managed',
                providerObservedAt: '2026-08-14T12:00:00.000Z',
                inventoryImportEnabled: true,
                active: true,
                rowVersion: 0,
                warehouse: {
                  globalId: 'gwh0000002',
                  code: createdInput.warehouse.code,
                  name: createdInput.warehouse.name,
                },
                location: {
                  globalId: 'gwl0000002',
                  code: 'RESERVE-01',
                  zone: 'STORAGE',
                  locationType: 'storage',
                },
                latestRun: null,
              }],
            }
          }
          return {
            warehouses: [{
              globalId: 'gwh0000001',
              code: 'AG-HQ',
              name: 'AG Alchemy HQ',
              address: {},
              status: 'active',
              locations: [{
                globalId: 'gwl0000001',
                code: 'RESERVE-01',
                zone: 'STORAGE',
                locationType: 'storage',
                active: true,
              }],
            }],
            mappings: mappedInput
              ? [{
                  globalId: 'gilm0000001',
                  externalLocationId: merchantLocation.id,
                  externalLocationName: merchantLocation.name,
                  externalLocationAddress: merchantLocation.address,
                  mappingMethod: 'manual',
                  ownershipClassification: 'merchant_managed',
                  providerObservedAt: '2026-08-14T12:00:00.000Z',
                  inventoryImportEnabled: true,
                  active: true,
                  rowVersion: 0,
                  warehouse: {
                    globalId: 'gwh0000001',
                    code: 'AG-HQ',
                    name: 'AG Alchemy HQ',
                  },
                  location: {
                    globalId: 'gwl0000001',
                    code: 'RESERVE-01',
                    zone: 'STORAGE',
                    locationType: 'storage',
                  },
                  latestRun: null,
                }]
              : [],
          }
        },
        async readShopifyInventoryStateFromPostgres() {
          return {
            accountGlobalId: runtime.globalId,
            status: 'never_synced',
            latestRun: null,
            levels: [],
          }
        },
      },
      '@/lib/persistence/commerceIntegrations': {
        async readCommerceRuntimeCredentialFromPostgres() { return runtime },
      },
      '@/lib/persistence/shopifyInventoryRefresh': {
        async readShopifyInventoryRefreshRecoveryStateFromPostgres() {
          return { managerRecoveryRequired: false }
        },
      },
    },
  },
)

const initial = await integration.getShopifyInventoryState({
  organizationId: runtime.organizationId,
  accountGlobalId: runtime.globalId,
})
assert.equal(initial.providerLocations.length, 3)
assert.equal(initial.providerLocations[0].ownershipClassification, 'merchant_managed')
assert.equal(initial.providerLocations[0].mappingEligible, true)
assert.equal(initial.providerLocations[1].ownershipClassification, 'fulfillment_service')
assert.equal(initial.providerLocations[1].mappingEligible, false)
assert.match(
  initial.providerLocations[1].mappingIneligibleReason,
  /fulfillment service/i,
)
assert.equal(initial.providerWrites, 0)
assert.equal(initial.warehouses[0].locations[0].active, true)

await assert.rejects(
  integration.mapShopifyInventoryLocation({
    organizationId: runtime.organizationId,
    accountGlobalId: runtime.globalId,
    externalLocationId: appManagedLocation.id,
    warehouseGlobalId: 'gwh0000001',
    locationGlobalId: 'gwl0000001',
    mappingGlobalId: null,
    expectedRowVersion: null,
    idempotencyKey: 'map-location:external-app',
    actorEmail: 'owner@example.com',
  }),
  (error) => (
    error.code
      === 'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN'
  ),
)
assert.equal(mappedInput, null)

const mapped = await integration.mapShopifyInventoryLocation({
  organizationId: runtime.organizationId,
  accountGlobalId: runtime.globalId,
  externalLocationId: merchantLocation.id,
  warehouseGlobalId: 'gwh0000001',
  locationGlobalId: 'gwl0000001',
  mappingGlobalId: null,
  expectedRowVersion: null,
  idempotencyKey: 'map-location:merchant-managed',
  actorEmail: 'owner@example.com',
})
assert.equal(mapped.providerWrites, 0)
assert.equal(mapped.mapping.externalLocationId, merchantLocation.id)
assert.equal(mapped.mapping.warehouse.name, 'AG Alchemy HQ')
assert.equal(mapped.mapping.location.code, 'RESERVE-01')
assert.equal(mapped.inventory.mappings.length, 1)
assert.equal(mapped.inventory.status, 'never_synced')
assert.equal(mappedInput.expectedMappingGlobalId, null)
assert.equal(mappedInput.expectedRowVersion, null)

const created = await integration.createShopifyInventoryWarehouseAndMap({
  organizationId: runtime.organizationId,
  accountGlobalId: runtime.globalId,
  externalLocationId: secondMerchantLocation.id,
  warehouse: {
    code: 'CUSTOM-01',
    name: 'My Custom Location',
    facilityType: 'store',
    timezone: 'America/New_York',
  },
  idempotencyKey: 'create-warehouse:merchant-managed',
  actorEmail: 'owner@example.com',
})
assert.equal(created.providerWrites, 0)
assert.deepEqual(
  JSON.parse(JSON.stringify(created.warehouse)),
  {
    globalId: 'gwh0000002',
    code: 'CUSTOM-01',
    name: 'My Custom Location',
  },
)
assert.equal(created.mapping.location.code, 'RESERVE-01')
assert.equal(createdInput.providerLocation.id, secondMerchantLocation.id)
assert.equal(createdInput.warehouse.facilityType, 'store')

const persistence = read('app_src/lib/persistence/commerceInventory.ts')
for (const fragment of [
  'mapping.inventory_import_enabled = true',
  'mapping.ownership_classification',
  'mapping.provider_snapshot_json',
  'mapping.provider_observed_at',
  'location_mapping_id = $3::uuid',
  'shopify_inventory_location_map',
  'shopify_inventory_warehouse_create_and_map',
  'SHOPIFY_WAREHOUSE_STARTER_LOCATIONS',
  "inventoryLocationCode: 'RESERVE-01'",
  'operations_command_receipts',
  'row_version = row_version + 1',
  "ownership_classification = 'merchant_managed'",
  'providerWrites: 0',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Multi-location inventory persistence missing ${fragment}`,
  )
}
assert.match(
  persistence,
  /external_location_id = \$3[\s\S]*?LIMIT 1[\s\S]*?FOR UPDATE/,
  'Snapshot apply must lock the exact provider location mapping',
)
assert.match(
  persistence,
  /AND \(\$3::text IS NULL OR mapping\.global_id = \$3\)/,
  'Selected mapping detail must be scoped by exact mapping Global ID',
)
assert.doesNotMatch(
  persistence,
  /providerWrites:\s*[1-9]/,
  'Location routing must not introduce provider inventory writes',
)

const orchestration = read('app_src/lib/integrations/commerceInventory.ts')
for (const fragment of [
  'providerLocations',
  'warehouses: configuration.warehouses',
  'mappings: configuration.mappings',
  'mappingGlobalId: target.existingMapping?.globalId || null',
  'SHOPIFY_INVENTORY_FULFILLMENT_SERVICE_LOCATION_FORBIDDEN',
]) {
  assert.ok(
    orchestration.includes(fragment),
    `Multi-location inventory orchestration missing ${fragment}`,
  )
}

const route = read(
  'app_src/app/api/integrations/commerce/inventory/route.ts',
)
for (const fragment of [
  "body.action === 'map-location'",
  "body.action === 'create-warehouse-and-map'",
  'mappingGlobalId: req.nextUrl.searchParams.get(\'mappingGlobalId\')',
  'expectedMappingRowVersion: body.expectedMappingRowVersion',
  'operationsCapabilities(user).canManage',
]) {
  assert.ok(fragment.includes('\\')
    ? route.includes(fragment.replaceAll('\\', ''))
    : route.includes(fragment))
}

console.log(
  'Shopify multi-location inventory tests passed '
  + '(discovery, ownership classification, mapping fence, scoped sync, zero writes).',
)
