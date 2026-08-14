import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import test, { mock } from 'node:test'

const appSourceUrl = new URL('../../', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const appPath = specifier.slice(2)
      return nextResolve(
        new URL(
          appPath.endsWith('.mjs') ? appPath : `${appPath}.ts`,
          appSourceUrl,
        ).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = 'x'.repeat(48)

const accountGlobalId = 'gia0000001'
const callbackToken = 'a'.repeat(43)
const organizationId = '11111111-1111-4111-8111-111111111111'
const carrierAccountGlobalId = 'gac0000001'
const lineKey = 'shopify-line-001'
const productGlobalId = 'gprod0000001'
const profileVersionGlobalId = 'gppv0000001'
const providerCalls: Array<Record<string, unknown>> = []
let completionCalls = 0
let failureCalls = 0

const planRateOptimization = {
  version: 'shopify-checkout-plan-rate-objective-v2',
  maxCandidates: 1,
  objectivePriority: ['landed_price', 'package_count', 'unused_cube'],
  handlingCostMinorPerPackage: 0,
  handlingCostCurrency: 'USD',
}

const account = {
  organizationId,
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId,
  storeEntityName: 'Pro Bakery Bites',
  environment: 'sandbox',
  externalAccountId: 'pro-bakery-bites.myshopify.com',
  registrationState: 'registered',
  configGlobalId: 'gscf0000001',
  configRowVersion: 1,
  credentialGeneration: 1,
  registrationActivationRevision: 1,
  activationState: 'active',
  activationRevision: 1,
  callbackTokenVersion: 1,
  policyRevision: 1,
  policyHash: createHash('sha256').update('policy').digest('hex'),
  policySnapshot: { planRateOptimization },
  warehouseId: '33333333-3333-4333-8333-333333333333',
  warehouseGlobalId: 'gwh0000001',
  warehouseName: 'AG Alchemy',
  warehouseTimezone: 'America/New_York',
  warehouseAddress: {
    line1: '7009 S 108th St',
    city: 'La Vista',
    region: 'NE',
    postalCode: '68128',
    countryCode: 'US',
  },
  inventoryMaxAgeSeconds: 300,
  quoteTtlSeconds: 900,
  orderReconciliationWindowSeconds: 900,
  algorithmVersion: 'single-carrier-callback-test-v1',
  materials: [],
  carriers: [{
    provider: 'ups_rest',
    carrierAccountId: '44444444-4444-4444-8444-444444444444',
    carrierAccountGlobalId,
    credentialVersion: 1,
    displayName: 'UPS sandbox',
    accountStatus: 'active',
    integrationStatus: 'active',
    environment: 'sandbox',
  }],
} as const

const context = {
  readAt: '2026-08-14T12:00:00.000Z',
  inventorySnapshotAt: '2026-08-14T12:00:00.000Z',
  inventorySnapshotHash: createHash('sha256')
    .update('inventory')
    .digest('hex'),
  input: {
    mode: 'production',
    lines: [{
      lineGlobalId: lineKey,
      productGlobalId,
      title: 'Pro Bakery Bites case',
      quantity: 1,
      unitWeightGrams: 170,
      profile: {
        versionGlobalId: profileVersionGlobalId,
        capturedRowVersion: 1,
        currentRowVersion: 1,
        isCurrent: true,
        lifecycleState: 'active',
        fitModel: 'rigid_3d',
        evidenceType: 'measured',
        evidenceReference: 'single-carrier callback test',
        confirmedAt: '2026-08-14T12:00:00.000Z',
        packageLevel: 'case',
        baseEachQuantity: 2,
        shipsAsOwnPackage: true,
        outerDimensionsMm: { length: 200, width: 150, height: 100 },
        grossWeightGrams: 170,
      },
    }],
    recipes: [],
    materials: [],
  },
  lines: [{
    lineKey,
    productGid: 'gid://shopify/Product/48447225880',
    variantGid: 'gid://shopify/ProductVariant/258644705304',
    productGlobalId,
    packMappingGlobalId: 'gcpm0000001',
    packMappingRowVersion: 1,
    packEvidenceHash: createHash('sha256')
      .update('pack-evidence')
      .digest('hex'),
    packProfileVersionGlobalId: profileVersionGlobalId,
    packProfileVersionRowVersion: 1,
    packageLevel: 'case',
    baseEachQuantity: 2,
    shipsAsOwnPackage: true,
    inventoryLevelGlobalIds: ['gcil0000001'],
    quantity: 1,
    unitWeightGrams: 170,
    sku: 'CLAWPILOT-TEST-6OZ',
    requiresShipping: true,
  }],
  materials: [],
} as const

const plannedCandidate = {
  candidateKey: 'self-package-1',
  preferenceMaterialGlobalId: null,
  preferenceMaterialGlobalIdsByPool: {},
  parcels: [{
    packageKey: 'package-1',
    description: 'Pro Bakery Bites sealed case',
    exteriorInches: { length: 8, width: 6, height: 4 },
    grossPounds: 0.4,
  }],
  packageOuterCubeMm3: 3_000_000,
  unusedCubeMm3: 0,
  cubeBasis: 'outer_cube_proxy',
  plan: {
    status: 'ready',
    policyVersion: 'hybrid-cartonization-policy-v1',
    algorithmVersion: 'hybrid-cartonization-v1',
    inputHash: createHash('sha256').update('plan-input').digest('hex'),
    resultHash: createHash('sha256').update('plan-result').digest('hex'),
    selfPackages: [{
      packageKey: 'package-1',
      sequence: 1,
      planningMethod: 'self_package',
      packProfileVersionGlobalId: profileVersionGlobalId,
      packProfileVersionRowVersion: 1,
      packageLevel: 'case',
      baseEachQuantity: 2,
      lineAllocations: [{
        lineGlobalId: lineKey,
        productGlobalId,
        title: 'Pro Bakery Bites case',
        quantity: 1,
        profileVersionGlobalId,
        profileVersionRowVersion: 1,
        unitWeightGrams: 170,
        contentWeightGrams: 170,
      }],
      totalInputQuantity: 1,
      contentWeightGrams: 170,
      rateReadiness: {
        status: 'ready',
        ratedOuterDimensionsMm: { length: 200, width: 150, height: 100 },
        tareWeightGrams: 0,
        ratedWeightGrams: 170,
        blockers: [],
      },
    }],
    recipePackages: [],
    geometryFallbackLines: [],
    assumptions: [],
    blockers: [],
  },
} as const

mock.module('@/lib/integrations/shopifyShadowCheckoutAllowlist', {
  namedExports: {
    configuredShopifyNumericIdentifierSet() {
      throw new Error('active callback must not read a Shadow allowlist')
    },
  },
})

mock.module('@/lib/persistence/shopifyCustomerRatePolicies', {
  namedExports: {
    async readActiveShopifyCustomerRatePolicyFromPostgres() {
      throw new Error('active callback must not read a Shadow customer policy')
    },
  },
})

mock.module('@/lib/persistence/shopifyCheckoutRating', {
  namedExports: {
    SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION:
      'shopify-checkout-line-pack-evidence-v1',
    async lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres() {
      return account
    },
    async readCachedShopifyCheckoutRateReceiptInPostgres() {
      return null
    },
    async claimShopifyCheckoutRateReceiptInPostgres() {
      return {
        kind: 'claimed',
        receiptGlobalId: 'gcr0000001',
        leaseToken: '55555555-5555-4555-8555-555555555555',
      }
    },
    async completeShopifyCheckoutRateReceiptInPostgres() {
      completionCalls += 1
      throw new Error('intentional durable-completion boundary')
    },
    async failShopifyCheckoutRateReceiptInPostgres() {
      failureCalls += 1
      return null
    },
    shopifyCheckoutPackagePlanHash() {
      return createHash('sha256').update('package-plan').digest('hex')
    },
    shopifyCheckoutRatingHash(value: unknown) {
      return createHash('sha256').update(JSON.stringify(value)).digest('hex')
    },
  },
})

mock.module('@/lib/persistence/shopifyCheckoutContext', {
  namedExports: {
    async readShopifyCheckoutContextFromPostgres() {
      return context
    },
  },
})

mock.module('@/lib/operations/shopifyCheckoutRating', {
  namedExports: {
    planShopifyCheckoutPackageCandidates() {
      return [plannedCandidate]
    },
    shopifyProductGid(id: string | number) {
      return `gid://shopify/Product/${id}`
    },
    shopifyVariantGid(id: string | number) {
      return `gid://shopify/ProductVariant/${id}`
    },
  },
})

mock.module('@/lib/integrations/carrierIntegrations', {
  namedExports: {
    async testCarrierSandboxShipmentRate(input: Record<string, unknown>) {
      providerCalls.push(input)
      return {
        evidenceGlobalId: 'grq0000001',
        rates: [{
          serviceCode: '03',
          serviceName: 'UPS Ground',
          amount: '12.34',
          currency: 'USD',
          transitDays: 3,
          deliveryDate: '2026-08-17',
        }],
      }
    },
  },
})

mock.module('@/lib/integrations/carrierSandboxRate', {
  namedExports: {
    carrierSandboxRateDestinationFingerprint() {
      return createHash('sha256').update('carrier-destination').digest('hex')
    },
  },
})

const { executeShopifyCarrierServiceCallback } = await import(
  '../../lib/integrations/shopifyCarrierServiceCallback.ts'
)

function callbackRequest() {
  return new Request('https://example.test/shopify/carrier-service', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rate: {
        origin: {
          country: 'US',
          postal_code: '68128',
          province: 'NE',
          city: 'La Vista',
          address1: '7009 S 108th St',
          address2: '',
        },
        destination: {
          country: 'US',
          postal_code: '92647',
          province: 'CA',
          city: 'Huntington Beach',
          address1: '16691 Gothard St',
          address2: 'Suite Q',
        },
        items: [{
          name: 'Test Product',
          sku: 'CLAWPILOT-TEST-6OZ',
          quantity: 1,
          grams: 170,
          price: 0,
          vendor: 'AG Alchemy',
          requires_shipping: true,
          taxable: false,
          fulfillment_service: 'manual',
          properties: null,
          product_id: 48447225880,
          variant_id: 258644705304,
        }],
        currency: 'USD',
        locale: 'en_US',
      },
    }),
  })
}

test('active callback invokes its one configured carrier exactly once',
  async () => {
    const warnings: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args)
    })
    try {
      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(),
      })

      assert.equal(result.authenticated, true)
      assert.equal(result.authenticated && result.httpStatus, 503)
      assert.equal(providerCalls.length, 1)
      assert.equal(providerCalls[0]?.provider, 'ups_rest')
      assert.equal(
        providerCalls[0]?.carrierAccountGlobalId,
        carrierAccountGlobalId,
      )
      assert.equal(providerCalls[0]?.environment, 'sandbox')
      assert.equal(completionCalls, 1)
      assert.equal(failureCalls, 1)
      assert.equal(warnings.length, 1)
    } finally {
      warn.mock.restore()
    }
  })
