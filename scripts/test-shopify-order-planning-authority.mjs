#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    AbortController,
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
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const organizationId = '11111111-1111-4111-8111-111111111111'
const accountGlobalId = 'gia1234567'
const candidateGlobalId = 'gcoc1234567'
const warehouseGlobalId = 'gwh1234567'
const orderId = 'gid://shopify/Order/6600'
const lineId = 'gid://shopify/LineItem/101'
const locationId = 'gid://shopify/Location/202'
const fulfillmentOrderId = 'gid://shopify/FulfillmentOrder/303'
const fulfillmentOrderLineItemId =
  'gid://shopify/FulfillmentOrderLineItem/404'

const target = {
  organizationId,
  accountGlobalId,
  candidate: {
    globalId: candidateGlobalId,
    rowVersion: 9,
    sourceHash: 'a'.repeat(64),
  },
  warehouse: {
    globalId: warehouseGlobalId,
    locationMappingGlobalId: 'gilm1234567',
    locationMappingRowVersion: 2,
    shopifyLocationId: locationId,
  },
  externalOrderId: orderId,
  lines: [{
    candidateLineGlobalId: 'gcol1234567',
    canonicalLineGlobalId: 'gol1234567',
    externalLineId: lineId,
    quantity: 1,
  }],
}

const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false } })
const openOrder = () => ({
  id: orderId,
  name: '#6600',
  confirmed: true,
  cancelledAt: null,
  closedAt: null,
  updatedAt: '2026-08-10T18:00:00.000Z',
  displayFulfillmentStatus: 'UNFULFILLED',
  fulfillable: true,
  lineItems: page([{
    id: lineId,
    currentQuantity: 1,
    unfulfilledQuantity: 1,
    requiresShipping: true,
  }]),
  fulfillmentOrders: page([{
    id: fulfillmentOrderId,
    status: 'OPEN',
    requestStatus: 'UNSUBMITTED',
    updatedAt: '2026-08-10T17:59:00.000Z',
    assignedLocation: {
      location: {
        id: locationId,
        name: 'Shop location',
        isFulfillmentService: false,
        fulfillmentService: null,
      },
    },
    lineItems: page([{
      id: fulfillmentOrderLineItemId,
      lineItem: { id: lineId },
      remainingQuantity: 1,
    }]),
  }]),
})

let providerOrder = openOrder()
let providerAssignmentOrder = null
const providerCalls = []
const module = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyOrderPlanningAuthority.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential: () => ({
        provider: 'shopify',
        clientId: 'client-id',
        clientSecret: 'client-secret-value',
      }),
    },
    '@/lib/integrations/commerceCapabilities': {
      hasEffectiveShopifyScope: (scopes, scope) => scopes.includes(scope),
    },
    '@/lib/integrations/shopifyCommerceClient': {
      ShopifyCommerceClientError: class extends Error {},
      normalizeShopifyShopDomain: String,
      requestShopifyAccessToken: async () => ({
        accessToken: 'token',
        grantedScopes: [
          'read_orders',
          'read_locations',
          'read_merchant_managed_fulfillment_orders',
          'read_third_party_fulfillment_orders',
          'read_assigned_fulfillment_orders',
        ],
      }),
      probeShopifyConnection: async () => ({
        shopId: 'gid://shopify/Shop/505',
        grantedScopes: [
          'read_orders',
          'read_locations',
          'read_merchant_managed_fulfillment_orders',
          'read_third_party_fulfillment_orders',
          'read_assigned_fulfillment_orders',
        ],
      }),
      shopifyAdminGraphql: async (_credential, request) => {
        providerCalls.push(request)
        if (
          request.operationName
            === 'ClawPilotShopifyOrderPlanningAuthority'
        ) {
          return { order: structuredClone(providerOrder) }
        }
        if (
          request.operationName
            === 'ClawPilotShopifyOrderPlanningAssignment'
        ) {
          return { order: structuredClone(providerAssignmentOrder) }
        }
        assert.fail(`Unexpected operation ${request.operationName}`)
      },
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: async () => null,
    },
    '@/lib/persistence/shopifyOrderPlanningAuthority': {
      ShopifyOrderPlanningAuthorityPersistenceError: class extends Error {},
      readShopifyOrderPlanningAssignmentTargetFromPostgres: async () => null,
      readShopifyOrderPlanningAuthorityTargetFromPostgres: async () => target,
    },
  },
)

const dependencies = (overrides = {}) => ({
  readTarget: async () => structuredClone(target),
  readRuntimeCredential: async () => ({
    organizationId,
    globalId: accountGlobalId,
    provider: 'shopify',
    environment: 'sandbox',
    externalAccountId: 'gid://shopify/Shop/505',
    status: 'active',
    verificationStatus: 'verified',
    credentialVersion: 7,
    configuration: { shopDomain: 'ag-alchemy.myshopify.com' },
    encrypted: {},
  }),
  decryptCredential: () => ({
    provider: 'shopify',
    clientId: 'client-id',
    clientSecret: 'client-secret-value',
  }),
  requestAccessToken: async () => ({
    accessToken: 'token',
    grantedScopes: [
      'read_orders',
      'read_locations',
      'read_merchant_managed_fulfillment_orders',
      'read_third_party_fulfillment_orders',
      'read_assigned_fulfillment_orders',
    ],
  }),
  probeConnection: async () => ({
    shopId: 'gid://shopify/Shop/505',
    grantedScopes: [
      'read_orders',
      'read_locations',
      'read_merchant_managed_fulfillment_orders',
      'read_third_party_fulfillment_orders',
      'read_assigned_fulfillment_orders',
    ],
  }),
  readOrder: module.readShopifyOrderPlanningAuthority,
  ...overrides,
})

const request = {
  organizationId,
  accountGlobalId,
  candidateGlobalId,
  expectedCandidateRowVersion: 9,
  warehouseGlobalId,
}
const evidence = await module.inspectShopifyOrderPlanningAuthority(
  request,
  dependencies(),
)
assert.equal(evidence.providerReads, 1)
assert.equal(evidence.providerWrites, 0)
assert.match(evidence.authorityHash, /^[a-f0-9]{64}$/)
assert.equal(evidence.snapshot.order.externalOrderId, orderId)
assert.equal(evidence.snapshot.warehouse.shopifyLocationId, locationId)
assert.equal(
  providerCalls.length,
  1,
  'planning authority must come from one atomic provider response',
)
assert.equal(providerCalls[0].operationName, 'ClawPilotShopifyOrderPlanningAuthority')
assert.match(providerCalls[0].query, /confirmed/)
assert.match(providerCalls[0].query, /fulfillmentOrders\(first: 25\)/)
assert.match(
  providerCalls[0].query,
  /assignedLocation[\s\S]+isFulfillmentService[\s\S]+fulfillmentService/,
)
assert.match(providerCalls[0].query, /updatedAt/)
assert.match(
  providerCalls[0].query,
  /fulfillmentOrders[\s\S]+lineItems\(first: 250\)/,
)
assert.doesNotMatch(
  read('app_src/lib/integrations/shopifyOrderPlanningAuthority.ts'),
  /ClawPilotShopifyFulfillmentOrderPlanningLines/,
  'a second fulfillment-line read would permit a torn provider snapshot',
)

const reorderedSnapshot = JSON.parse(JSON.stringify({
  fulfillmentOrders: evidence.snapshot.fulfillmentOrders,
  lines: evidence.snapshot.lines,
  order: evidence.snapshot.order,
  warehouse: evidence.snapshot.warehouse,
  candidate: evidence.snapshot.candidate,
  accountGlobalId: evidence.snapshot.accountGlobalId,
  credentialVersion: evidence.snapshot.credentialVersion,
  shopId: evidence.snapshot.shopId,
  version: evidence.snapshot.version,
}))
assert.equal(
  module.shopifyOrderPlanningAuthorityHash(reorderedSnapshot),
  evidence.authorityHash,
  'retained JSONB key ordering must not affect the authority hash',
)
const touchedFulfillmentOrderSnapshot = structuredClone(evidence.snapshot)
touchedFulfillmentOrderSnapshot.fulfillmentOrders[0].updatedAt =
  '2026-08-10T18:01:00.000Z'
assert.notEqual(
  module.shopifyOrderPlanningAuthorityHash(
    touchedFulfillmentOrderSnapshot,
  ),
  evidence.authorityHash,
  'a Shopify UI fulfillment-order touch must invalidate authority',
)

providerOrder = { ...openOrder(), closedAt: '2026-08-10T19:00:00.000Z',
  displayFulfillmentStatus: 'FULFILLED', fulfillable: false }
providerCalls.length = 0
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_ORDER_NOT_OPEN',
)
assert.equal(providerCalls.length, 1, 'closed order must stop after the header read')

providerOrder = openOrder()
providerOrder.lineItems.nodes[0].unfulfilledQuantity = 0
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_LINES_CHANGED',
)

providerOrder = openOrder()
providerOrder.fulfillmentOrders.nodes[0].assignedLocation.location.id =
  'gid://shopify/Location/999'
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_LOCATION_MISMATCH',
)

providerOrder = openOrder()
providerOrder.fulfillmentOrders.nodes[0].assignedLocation.location = {
  id: locationId,
  name: 'Snow City Warehouse',
  isFulfillmentService: true,
  fulfillmentService: {
    id: 'gid://shopify/FulfillmentService/888',
    serviceName: 'Snow City App',
    type: 'THIRD_PARTY',
  },
}
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => (
    error?.code === 'SHOPIFY_ORDER_PLANNING_PROVIDER_MANAGED'
  ),
)

providerOrder = openOrder()
providerOrder.fulfillmentOrders.nodes[0].requestStatus = 'SUBMITTED'
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => (
    error?.code === 'SHOPIFY_ORDER_PLANNING_FULFILLMENT_ALREADY_ACTIONED'
  ),
)

providerOrder = openOrder()
providerOrder.fulfillmentOrders.pageInfo.hasNextPage = true
providerCalls.length = 0
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_PAGINATION_REQUIRED',
)
assert.equal(
  providerCalls.length,
  1,
  'truncated fulfillment orders must fail within the atomic read',
)

providerOrder = openOrder()
providerOrder.fulfillmentOrders.nodes[0]
  .lineItems.pageInfo.hasNextPage = true
providerCalls.length = 0
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(request, dependencies()),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_PAGINATION_REQUIRED',
)
assert.equal(
  providerCalls.length,
  1,
  'truncated fulfillment lines must fail within the atomic read',
)

let scopedReadCalled = false
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAuthority(
    request,
    dependencies({
      requestAccessToken: async () => ({
        accessToken: 'token',
        grantedScopes: ['read_orders'],
      }),
      probeConnection: async () => ({
        shopId: 'gid://shopify/Shop/505',
        grantedScopes: ['read_orders'],
      }),
      readOrder: async () => {
        scopedReadCalled = true
        return { snapshot: evidence.snapshot, providerReads: 1 }
      },
    }),
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_SCOPE_REQUIRED',
)
assert.equal(scopedReadCalled, false)

const assignmentScopes = [
  'read_orders',
  'read_locations',
  'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
  'read_assigned_fulfillment_orders',
]
const assignmentTarget = {
  organizationId,
  accountGlobalId,
  candidateGlobalId,
  candidateRowVersion: 9,
  externalOrderId: orderId,
  mappings: [{
    globalId: 'gilm1234567',
    rowVersion: 2,
    externalLocationId: locationId,
    externalLocationName: 'Shop location',
    warehouseGlobalId,
    warehouseName: 'AG Alchemy HQ',
    locationGlobalId: 'gwl1234567',
    locationCode: 'RESERVE-01',
  }],
}
const assignmentOrder = ({
  assignedLocationId = locationId,
  assignedLocationName = 'Shop location',
  isFulfillmentService = false,
  fulfillmentService = null,
  secondLocation = null,
} = {}) => ({
  id: orderId,
  fulfillmentOrders: page([
    {
      id: fulfillmentOrderId,
      status: 'OPEN',
      requestStatus: 'UNSUBMITTED',
      assignedLocation: {
        location: {
          id: assignedLocationId,
          name: assignedLocationName,
          isFulfillmentService,
          fulfillmentService,
        },
      },
      lineItems: page([{ remainingQuantity: 1 }]),
    },
    ...(secondLocation ? [{
      id: 'gid://shopify/FulfillmentOrder/304',
      status: 'OPEN',
      requestStatus: 'UNSUBMITTED',
      assignedLocation: {
        location: {
          id: secondLocation.id,
          name: secondLocation.name,
          isFulfillmentService: false,
          fulfillmentService: null,
        },
      },
      lineItems: page([{ remainingQuantity: 1 }]),
    }] : []),
  ]),
})
const assignmentDependencies = (overrides = {}) => ({
  readTarget: async () => structuredClone(assignmentTarget),
  readRuntimeCredential: dependencies().readRuntimeCredential,
  decryptCredential: dependencies().decryptCredential,
  requestAccessToken: async () => ({
    accessToken: 'token',
    grantedScopes: assignmentScopes,
  }),
  probeConnection: async () => ({
    shopId: 'gid://shopify/Shop/505',
    grantedScopes: assignmentScopes,
  }),
  readAssignment: module.readShopifyOrderPlanningAssignment,
  ...overrides,
})
providerAssignmentOrder = assignmentOrder()
const assignment = await module.inspectShopifyOrderPlanningAssignment(
  {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion: 9,
  },
  assignmentDependencies(),
)
assert.equal(assignment.status, 'ready')
assert.equal(assignment.selectedWarehouse.globalId, warehouseGlobalId)
assert.equal(assignment.selectedWarehouse.shopifyLocationName, 'Shop location')
assert.equal(assignment.providerReads, 1)
assert.equal(assignment.providerWrites, 0)

providerAssignmentOrder = assignmentOrder({
  assignedLocationId: 'gid://shopify/Location/999',
  assignedLocationName: 'Snow City Warehouse',
  isFulfillmentService: true,
  fulfillmentService: {
    id: 'gid://shopify/FulfillmentService/888?id=true',
    serviceName: 'Snow City App',
    type: 'THIRD_PARTY',
  },
})
const providerManaged = await module.inspectShopifyOrderPlanningAssignment(
  {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion: 9,
  },
  assignmentDependencies(),
)
assert.equal(providerManaged.status, 'provider_managed')
assert.equal(providerManaged.selectedWarehouse, null)
assert.equal(
  providerManaged.assignments[0].fulfillmentService.serviceName,
  'Snow City App',
)
assert.equal(
  providerManaged.assignments[0].fulfillmentService.id,
  'gid://shopify/FulfillmentService/888?id=true',
)

providerAssignmentOrder = assignmentOrder({
  assignedLocationId: 'gid://shopify/Location/999',
  assignedLocationName: 'Snow City Warehouse',
  isFulfillmentService: true,
  fulfillmentService: {
    id: 'gid://shopify/FulfillmentService/888',
    serviceName: 'Snow City App',
    type: 'THIRD_PARTY',
  },
})
const providerManagedBaseId = await module.inspectShopifyOrderPlanningAssignment(
  {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion: 9,
  },
  assignmentDependencies(),
)
assert.equal(providerManagedBaseId.status, 'provider_managed')
assert.equal(
  providerManagedBaseId.assignments[0].fulfillmentService.id,
  'gid://shopify/FulfillmentService/888',
)

providerAssignmentOrder = assignmentOrder({
  assignedLocationId: 'gid://shopify/Location/999',
  assignedLocationName: 'Unreadable fulfillment-service location',
  isFulfillmentService: true,
  fulfillmentService: null,
})
const providerManagedWithoutDetails =
  await module.inspectShopifyOrderPlanningAssignment(
    {
      organizationId,
      accountGlobalId,
      candidateGlobalId,
      expectedCandidateRowVersion: 9,
    },
    assignmentDependencies(),
  )
assert.equal(providerManagedWithoutDetails.status, 'provider_managed')
assert.equal(
  providerManagedWithoutDetails.assignments[0].ownerType,
  'fulfillment_service',
)
assert.equal(
  providerManagedWithoutDetails.assignments[0].fulfillmentService,
  null,
)

for (const invalidId of [
  null,
  'gid://shopify/FulfillmentService/888?id=false',
  'gid://shopify/FulfillmentService/888?id=true&extra=1',
]) {
  providerAssignmentOrder = assignmentOrder({
    assignedLocationId: 'gid://shopify/Location/999',
    assignedLocationName: 'Snow City Warehouse',
    isFulfillmentService: true,
    fulfillmentService: {
      id: invalidId,
      serviceName: 'Snow City App',
      type: 'THIRD_PARTY',
    },
  })
  await assert.rejects(
    () => module.inspectShopifyOrderPlanningAssignment(
      {
        organizationId,
        accountGlobalId,
        candidateGlobalId,
        expectedCandidateRowVersion: 9,
      },
      assignmentDependencies(),
    ),
    (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
  )
}

providerAssignmentOrder = assignmentOrder({
  fulfillmentService: {
    id: 'gid://shopify/FulfillmentService/888?id=true',
    serviceName: 'Snow City App',
    type: 'THIRD_PARTY',
  },
})
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAssignment(
    {
      organizationId,
      accountGlobalId,
      candidateGlobalId,
      expectedCandidateRowVersion: 9,
    },
    assignmentDependencies(),
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_RESPONSE_INVALID',
)

providerAssignmentOrder = assignmentOrder({
  secondLocation: {
    id: 'gid://shopify/Location/203',
    name: 'Second shop location',
  },
})
const split = await module.inspectShopifyOrderPlanningAssignment(
  {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion: 9,
  },
  assignmentDependencies(),
)
assert.equal(split.status, 'split')
assert.equal(split.assignments.length, 2)

providerAssignmentOrder = assignmentOrder({
  assignedLocationId: 'gid://shopify/Location/204',
  assignedLocationName: 'Unmapped merchant location',
})
const unmapped = await module.inspectShopifyOrderPlanningAssignment(
  {
    organizationId,
    accountGlobalId,
    candidateGlobalId,
    expectedCandidateRowVersion: 9,
  },
  assignmentDependencies(),
)
assert.equal(unmapped.status, 'unmapped')
assert.equal(unmapped.assignments[0].mapping, null)

let assignmentProviderReadCalled = false
await assert.rejects(
  () => module.inspectShopifyOrderPlanningAssignment(
    {
      organizationId,
      accountGlobalId,
      candidateGlobalId,
      expectedCandidateRowVersion: 9,
    },
    assignmentDependencies({
      requestAccessToken: async () => ({
        accessToken: 'token',
        grantedScopes: ['read_orders', 'read_locations'],
      }),
      probeConnection: async () => ({
        shopId: 'gid://shopify/Shop/505',
        grantedScopes: ['read_orders', 'read_locations'],
      }),
      readAssignment: async () => {
        assignmentProviderReadCalled = true
        return { assignments: [], providerReads: 1 }
      },
    }),
  ),
  (error) => error?.code === 'SHOPIFY_ORDER_PLANNING_SCOPE_REQUIRED',
)
assert.equal(assignmentProviderReadCalled, false)

const assignmentRoute = read(
  'app_src/app/api/integrations/commerce/intake/planning-assignment/route.ts',
)
assert.match(assignmentRoute, /operationsCapabilities\(actor\)\.canManage/)
assert.match(assignmentRoute, /inspectShopifyOrderPlanningAssignment/)
assert.match(assignmentRoute, /Cache-Control': 'private, no-store'/)
assert.match(
  read('app_src/components/operations/OperationsSection.tsx'),
  /Locked to Shopify’s current exact fulfillment assignment/,
)

const persistence = read(
  'app_src/lib/persistence/shopifyOrderPlanningAuthority.ts',
)
for (const fragment of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  "candidate.workflow_state AS candidate_workflow_state",
  'canonical_line.quantity::text AS canonical_quantity',
  'mapping.external_location_id',
  'candidateQuantity !== canonicalQuantity',
]) {
  assert.ok(persistence.includes(fragment), `target reader missing ${fragment}`)
}

const route = read(
  'app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts',
)
const preflightIndex = route.indexOf(
  'await inspectShopifyOrderPlanningAuthority',
)
const hybridReadIndex = route.indexOf(
  'await readHybridCartonizationInputFromPostgres',
)
const carrierReadIndex = route.indexOf('await testCarrierSandboxShipmentRate')
assert.ok(preflightIndex > 0 && preflightIndex < hybridReadIndex)
assert.ok(hybridReadIndex < carrierReadIndex)
assert.ok(route.includes('shopifyOrderPlanningAuthorityHash:'))
assert.ok(route.includes('shopifyOrderPlanningAuthority.snapshot'))
assert.ok(route.includes("'live_shopify_order_fulfillment_preflight'"))
assert.ok(route.includes('providerOrderReads:'))

console.log('Shopify order planning authority tests passed')
