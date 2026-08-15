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
const firstCarrierAccountGlobalId = 'gac0000001'
const secondCarrierAccountGlobalId = 'gac0000002'
const productionCarrierAccountGlobalId = 'gac0000003'
const lineKey = 'shopify-line-001'
const productGlobalId = 'gprod0000001'
const profileVersionGlobalId = 'gppv0000001'
type CompletionInput = {
  packagePlanHash: string
  packages: Array<Record<string, unknown> & {
    packageKey: string
    contentWeightGrams: number
    tareWeightGrams: number
    allocations: Array<Record<string, unknown>>
  }>
  providerAttempts: Array<{
    provider: 'ups_rest' | 'fedex_rest'
    carrierAccountGlobalId: string
    rateEvidenceGlobalId: string
    status: 'succeeded' | 'degraded'
    failureCode: string | null
    attemptSnapshot: Record<string, unknown>
  }>
  offers: Array<Record<string, unknown> & {
    carrierAccountGlobalId: string
    rateEvidenceGlobalId: string
    carrierCostMinor: number
    customerChargeMinor: number
    subsidyReason?: string | null
    minDeliveryDate?: string | null
    maxDeliveryDate?: string | null
  }>
  resultSnapshot: Record<string, unknown> & {
    configuredAccounts: Array<{
      provider: 'ups_rest' | 'fedex_rest'
      carrierAccountGlobalId: string
      environment: 'sandbox' | 'production'
    }>
  }
}
const providerCalls: Array<Record<string, unknown>> = []
const productionProviderCalls: Array<Record<string, unknown>> = []
let completionCalls = 0
let failureCalls = 0
let rateScenario: 'cheapest' | 'tie' | 'degraded' = 'cheapest'
let callbackActivationState: 'shadow' | 'active' = 'shadow'
let staleCarrierEnvironment: 'sandbox' | 'production' | null = null
let cachedReceipt: Record<string, unknown> | null = null
let serveCachedReceipt = false
let lastCompletionInput: CompletionInput | null = null

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
  activationState: 'shadow',
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
  carriers: [
    {
      provider: 'ups_rest',
      carrierIntegrationAccountGlobalId: 'gia0000002',
      carrierAccountId: '44444444-4444-4444-8444-444444444444',
      carrierAccountGlobalId: firstCarrierAccountGlobalId,
      credentialVersion: 1,
      displayName: 'UPS sandbox primary',
      registeredAddress: {
        line1: '7009 S 108th St',
        line2: null,
        city: 'La Vista',
        region: 'NE',
        postalCode: '68128',
        countryCode: 'US',
      },
      registeredAddressFingerprint: createHash('sha256')
        .update(JSON.stringify({
          line1: '7009 s 108th st',
          line2: null,
          city: 'la vista',
          region: 'ne',
          postalCode: '68128',
          countryCode: 'US',
        }))
        .digest('hex'),
      accountStatus: 'active',
      integrationStatus: 'active',
      environment: 'sandbox',
    },
    {
      provider: 'ups_rest',
      carrierIntegrationAccountGlobalId: 'gia0000002',
      carrierAccountId: '66666666-6666-4666-8666-666666666666',
      carrierAccountGlobalId: secondCarrierAccountGlobalId,
      credentialVersion: 1,
      displayName: 'UPS sandbox secondary',
      registeredAddress: {
        line1: '7009 S 108th St',
        line2: null,
        city: 'La Vista',
        region: 'NE',
        postalCode: '68128',
        countryCode: 'US',
      },
      registeredAddressFingerprint: createHash('sha256')
        .update(JSON.stringify({
          line1: '7009 s 108th st',
          line2: null,
          city: 'la vista',
          region: 'ne',
          postalCode: '68128',
          countryCode: 'US',
        }))
        .digest('hex'),
      accountStatus: 'active',
      integrationStatus: 'active',
      environment: 'sandbox',
    },
    {
      provider: 'ups_rest',
      carrierIntegrationAccountGlobalId: 'gia0000003',
      carrierAccountId: '77777777-7777-4777-8777-777777777777',
      carrierAccountGlobalId: productionCarrierAccountGlobalId,
      credentialVersion: 2,
      displayName: 'UPS production',
      registeredAddress: {
        line1: '7009 S 108th St',
        line2: null,
        city: 'La Vista',
        region: 'NE',
        postalCode: '68128',
        countryCode: 'US',
      },
      registeredAddressFingerprint: createHash('sha256')
        .update(JSON.stringify({
          line1: '7009 s 108th st',
          line2: null,
          city: 'la vista',
          region: 'ne',
          postalCode: '68128',
          countryCode: 'US',
        }))
        .digest('hex'),
      accountStatus: 'active',
      integrationStatus: 'active',
      environment: 'production',
    },
  ],
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
      return new Set(['258644705304'])
    },
  },
})

mock.module('@/lib/persistence/shopifyCustomerRatePolicies', {
  namedExports: {
    async readActiveShopifyCustomerRatePolicyFromPostgres() {
      return { mode: 'show_all' }
    },
  },
})

mock.module('@/lib/persistence/shopifyCheckoutRating', {
  namedExports: {
    SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION:
      'shopify-checkout-line-pack-evidence-v1',
    async lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres() {
      return {
        ...account,
        activationState: callbackActivationState,
        carriers: account.carriers.map((carrier) => (
          carrier.environment === staleCarrierEnvironment
            ? {
                ...carrier,
                accountStatus: 'disabled',
                integrationStatus: 'disabled',
                credentialVersion: 0,
                registeredAddress: {
                  ...carrier.registeredAddress,
                  line1: 'Stale carrier origin',
                },
                registeredAddressFingerprint: '0'.repeat(64),
              }
            : carrier
        )),
      }
    },
    async readCachedShopifyCheckoutRateReceiptInPostgres() {
      return serveCachedReceipt ? cachedReceipt : null
    },
    async claimShopifyCheckoutRateReceiptInPostgres() {
      return {
        kind: 'claimed',
        receiptGlobalId: 'gsqr0000001',
        leaseToken: '55555555-5555-4555-8555-555555555555',
      }
    },
    async completeShopifyCheckoutRateReceiptInPostgres(
      input: CompletionInput,
    ) {
      completionCalls += 1
      lastCompletionInput = input
      const packages = input.packages.map((parcel) => ({
        ...parcel,
        materialGlobalId: parcel.materialGlobalId ?? null,
        materialRowVersion: parcel.materialRowVersion ?? null,
        materialStockGlobalId: parcel.materialStockGlobalId ?? null,
        materialStockRowVersion: parcel.materialStockRowVersion ?? null,
        materialStockOnHandQuantity:
          parcel.materialStockOnHandQuantity ?? null,
        packProfileVersionGlobalId:
          parcel.packProfileVersionGlobalId ?? null,
        packProfileVersionRowVersion:
          parcel.packProfileVersionRowVersion ?? null,
        selfPackageLineKey: parcel.selfPackageLineKey ?? null,
        grossWeightGrams:
          parcel.contentWeightGrams + parcel.tareWeightGrams,
        carrierParcelSnapshot: {},
        packageHash: createHash('sha256')
          .update(`package:${parcel.packageKey}`)
          .digest('hex'),
        allocations: parcel.allocations.map(
          (allocation) => ({
            ...allocation,
            allocationHash: createHash('sha256')
              .update(JSON.stringify(allocation))
              .digest('hex'),
          }),
        ),
      }))
      const bindingByAccount = new Map<
        string,
        (typeof account.carriers)[number]
      >(account.carriers.map((carrier) => [
          carrier.carrierAccountGlobalId,
          carrier,
        ]))
      const providerAttempts = input.providerAttempts.map(
        (attempt) => {
          const binding = bindingByAccount.get(
            attempt.carrierAccountGlobalId,
          )
          assert.ok(binding)
          const hashed = {
            provider: attempt.provider,
            carrierAccountGlobalId: attempt.carrierAccountGlobalId,
            rateEvidenceGlobalId: attempt.rateEvidenceGlobalId,
            status: attempt.status,
            failureCode: attempt.failureCode,
            attemptSnapshot: attempt.attemptSnapshot,
          }
          return {
            ...hashed,
            credentialVersion: binding.credentialVersion,
            carrierRequestHash: createHash('sha256')
              .update(`request:${attempt.carrierAccountGlobalId}`)
              .digest('hex'),
            attemptHash: createHash('sha256')
              .update(JSON.stringify(hashed))
              .digest('hex'),
          }
        },
      )
      const offers = input.offers.map((offer) => {
        const binding = bindingByAccount.get(offer.carrierAccountGlobalId)
        assert.ok(binding)
        const checkoutAdjustmentMinor =
          offer.customerChargeMinor - offer.carrierCostMinor
        const normalized = {
          ...offer,
          credentialVersion: binding.credentialVersion,
          carrierRequestHash: createHash('sha256')
            .update(`request:${offer.carrierAccountGlobalId}`)
            .digest('hex'),
          carrierResponseRateHash: createHash('sha256')
            .update(`rate:${offer.rateEvidenceGlobalId}`)
            .digest('hex'),
          checkoutAdjustmentMinor,
          checkoutAdjustmentKind: checkoutAdjustmentMinor < 0
            ? 'subsidy'
            : 'none',
          checkoutAdjustmentReason: checkoutAdjustmentMinor < 0
            ? offer.subsidyReason
            : null,
          packageCount: packages.length,
          packagePlanHash: input.packagePlanHash,
          minDeliveryDate: offer.minDeliveryDate ?? null,
          maxDeliveryDate: offer.maxDeliveryDate ?? null,
        }
        return {
          ...normalized,
          offerHash: createHash('sha256')
            .update(JSON.stringify(normalized))
            .digest('hex'),
        }
      })
      cachedReceipt = {
        id: '88888888-8888-4888-8888-888888888888',
        globalId: 'gcr0000001',
        organizationId,
        integrationAccountId: account.integrationAccountId,
        accountGlobalId,
        configId: '99999999-9999-4999-8999-999999999999',
        configGlobalId: account.configGlobalId,
        configRowVersion: account.configRowVersion,
        credentialGeneration: account.credentialGeneration,
        activationState: callbackActivationState,
        activationRevision: account.activationRevision,
        policyRevision: account.policyRevision,
        policyHash: account.policyHash,
        warehouseId: account.warehouseId,
        warehouseGlobalId: account.warehouseGlobalId,
        algorithmVersion: account.algorithmVersion,
        requestFingerprint: createHash('sha256').update('request').digest('hex'),
        destinationFingerprint: createHash('sha256')
          .update('destination')
          .digest('hex'),
        carrierDestinationFingerprint: createHash('sha256')
          .update('carrier-destination')
          .digest('hex'),
        lineQuantityFingerprint: createHash('sha256')
          .update('lines')
          .digest('hex'),
        requestEvidenceHash: createHash('sha256')
          .update('request-evidence')
          .digest('hex'),
        redactedRequestSnapshot: {},
        currency: 'USD',
        idempotencyKey: 'shopify-rate-test',
        status: 'succeeded',
        leaseToken: null,
        leaseExpiresAt: null,
        claimedBy: null,
        attemptCount: 1,
        packagePlanHash: input.packagePlanHash,
        resultHash: createHash('sha256')
          .update(JSON.stringify(input.resultSnapshot))
          .digest('hex'),
        resultSnapshot: input.resultSnapshot,
        errorCode: null,
        providerWriteCount: 0,
        inventorySnapshotHash: context.inventorySnapshotHash,
        inventorySnapshotAt: context.inventorySnapshotAt,
        inventoryRefreshVersion: 1,
        reconciliationWindowSeconds: 900,
        reconciliationDeadlineAt: '2026-08-15T12:00:00.000Z',
        expiresAt: '2026-08-15T12:00:00.000Z',
        completedAt: '2026-08-14T12:00:01.000Z',
        createdAt: '2026-08-14T12:00:00.000Z',
        updatedAt: '2026-08-14T12:00:01.000Z',
        lines: [],
        packages,
        providerAttempts,
        offers,
      }
      return cachedReceipt
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
      const carrierAccountGlobalId = String(
        input.carrierAccountGlobalId,
      )
      if (
        rateScenario === 'degraded'
        && carrierAccountGlobalId === secondCarrierAccountGlobalId
      ) {
        const error = new Error('secondary UPS account unavailable')
        Object.assign(error, {
          code: 'UPS_SECONDARY_UNAVAILABLE',
          rateEvidenceGlobalId: 'grq0000002',
        })
        throw error
      }
      const secondary = carrierAccountGlobalId
        === secondCarrierAccountGlobalId
      return {
        evidenceGlobalId: secondary ? 'grq0000002' : 'grq0000001',
        rates: [{
          serviceCode: '03',
          serviceName: 'UPS Ground',
          amount: secondary
            ? rateScenario === 'cheapest' ? '10.00' : '12.34'
            : '12.34',
          currency: 'USD',
          transitDays: 3,
          deliveryDate: '2026-08-17',
        }],
      }
    },
  },
})

mock.module('@/lib/integrations/shopifyCarrierServiceProductionRate', {
  namedExports: {
    async rateShopifyProductionCheckoutShipment(
      input: Record<string, unknown>,
    ) {
      productionProviderCalls.push(input)
      return {
        provider: 'ups_rest',
        carrierAccountGlobalId: productionCarrierAccountGlobalId,
        packageCount: 1,
        rateScope: 'multi_package_shipment',
        rates: [{
          serviceCode: '03',
          serviceName: 'UPS Ground',
          amount: '15.00',
          currency: 'USD',
          transitDays: 3,
          deliveryDate: '2026-08-17',
          evidenceGlobalId: 'grq0000003',
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
        order_totals: {
          subtotal_price: 0,
          total_price: 0,
          discount_amount: 0,
        },
        customer: {
          id: 207119551,
          tags: ['warehouse-test'],
        },
      },
    }),
  })
}

function resetScenario(input: {
  activation?: 'shadow' | 'active'
  rates?: typeof rateScenario
  staleEnvironment?: 'sandbox' | 'production'
} = {}) {
  providerCalls.splice(0)
  productionProviderCalls.splice(0)
  completionCalls = 0
  failureCalls = 0
  rateScenario = input.rates ?? 'cheapest'
  callbackActivationState = input.activation ?? 'shadow'
  staleCarrierEnvironment = input.staleEnvironment ?? null
  cachedReceipt = null
  serveCachedReceipt = false
  lastCompletionInput = null
}

async function executeCallback() {
  return executeShopifyCarrierServiceCallback({
    accountGlobalId,
    callbackToken,
    request: callbackRequest(),
  })
}

test('Shadow fans out same-provider accounts, publishes the cheapest service, and replays v5 account evidence',
  async () => {
    resetScenario({ rates: 'cheapest' })

    const result = await executeCallback()

    assert.equal(result.authenticated, true)
    assert.equal(result.authenticated && result.httpStatus, 200)
    assert.equal(providerCalls.length, 2)
    assert.deepEqual(
      providerCalls.map((call) => call.carrierAccountGlobalId).sort(),
      [firstCarrierAccountGlobalId, secondCarrierAccountGlobalId],
    )
    assert.ok(providerCalls.every((call) => call.environment === 'sandbox'))
    assert.ok(providerCalls.every((call) => (
      typeof call.carrierSelectionKey === 'string'
      && /^[a-f0-9]{64}$/.test(call.carrierSelectionKey)
    )))
    assert.equal(
      new Set(providerCalls.map((call) => call.carrierSelectionKey)).size,
      2,
      'each exact billing account must retain its own receipt selection key',
    )
    assert.equal(productionProviderCalls.length, 0)
    assert.equal(completionCalls, 1)
    assert.equal(failureCalls, 0)
    assert.equal(result.authenticated && result.response.rates.length, 1)
    assert.equal(
      result.authenticated && result.response.rates[0]?.total_price,
      '1000',
    )
    assert.ok(lastCompletionInput)
    assert.equal(lastCompletionInput.offers.length, 1)
    assert.equal(
      lastCompletionInput.offers[0].carrierAccountGlobalId,
      secondCarrierAccountGlobalId,
    )
    assert.equal(lastCompletionInput.providerAttempts.length, 2)
    assert.deepEqual(
      lastCompletionInput.resultSnapshot.configuredAccounts,
      [
        {
          provider: 'ups_rest',
          carrierAccountGlobalId: firstCarrierAccountGlobalId,
          environment: 'sandbox',
        },
        {
          provider: 'ups_rest',
          carrierAccountGlobalId: secondCarrierAccountGlobalId,
          environment: 'sandbox',
        },
      ],
    )
    assert.equal(
      JSON.stringify(result.response).includes(
        secondCarrierAccountGlobalId,
      ),
      false,
    )

    serveCachedReceipt = true
    const replay = await executeCallback()
    assert.equal(replay.authenticated, true)
    assert.equal(replay.authenticated && replay.httpStatus, 200)
    assert.deepEqual(
      replay.authenticated && replay.response,
      result.authenticated && result.response,
    )
    assert.equal(providerCalls.length, 2)
    assert.equal(productionProviderCalls.length, 0)
    assert.equal(completionCalls, 1)
  })

test('same-price service ties select the lower carrier account Global ID',
  async () => {
    resetScenario({ rates: 'tie' })

    const result = await executeCallback()

    assert.equal(result.authenticated, true)
    assert.equal(result.authenticated && result.httpStatus, 200)
    assert.ok(lastCompletionInput)
    assert.equal(lastCompletionInput.offers.length, 1)
    assert.equal(
      lastCompletionInput.offers[0].carrierAccountGlobalId,
      firstCarrierAccountGlobalId,
    )
    assert.equal(lastCompletionInput.providerAttempts.length, 2)
  })

test('one degraded account retains exact attempt evidence while the successful account remains eligible',
  async () => {
    resetScenario({ rates: 'degraded' })

    const result = await executeCallback()

    assert.equal(result.authenticated, true)
    assert.equal(result.authenticated && result.httpStatus, 200)
    assert.ok(lastCompletionInput)
    assert.equal(lastCompletionInput.offers.length, 1)
    assert.equal(
      lastCompletionInput.offers[0].carrierAccountGlobalId,
      firstCarrierAccountGlobalId,
    )
    assert.equal(lastCompletionInput.providerAttempts.length, 2)
    assert.deepEqual(
      lastCompletionInput.providerAttempts.map(
        (attempt: Record<string, unknown>) => ({
          carrierAccountGlobalId: attempt.carrierAccountGlobalId,
          status: attempt.status,
          failureCode: attempt.failureCode,
        }),
      ),
      [
        {
          carrierAccountGlobalId: firstCarrierAccountGlobalId,
          status: 'succeeded',
          failureCode: null,
        },
        {
          carrierAccountGlobalId: secondCarrierAccountGlobalId,
          status: 'degraded',
          failureCode: 'UPS_SECONDARY_UNAVAILABLE',
        },
      ],
    )
  })

test('Active with a stale TEST group dispatches only the ready LIVE group',
  async () => {
    resetScenario({ activation: 'active', staleEnvironment: 'sandbox' })

    const result = await executeCallback()

    assert.equal(result.authenticated, true)
    assert.equal(result.authenticated && result.httpStatus, 200)
    assert.equal(providerCalls.length, 0)
    assert.equal(productionProviderCalls.length, 1)
    assert.ok(lastCompletionInput)
    assert.equal(lastCompletionInput.providerAttempts.length, 1)
    assert.equal(
      lastCompletionInput.providerAttempts[0].carrierAccountGlobalId,
      productionCarrierAccountGlobalId,
    )
    assert.deepEqual(
      lastCompletionInput.resultSnapshot.configuredAccounts,
      [{
        provider: 'ups_rest',
        carrierAccountGlobalId: productionCarrierAccountGlobalId,
        environment: 'production',
      }],
    )
  })

test('Shadow with a stale LIVE group dispatches only the ready TEST group',
  async () => {
    resetScenario({ activation: 'shadow', staleEnvironment: 'production' })

    const result = await executeCallback()

    assert.equal(result.authenticated, true)
    assert.equal(result.authenticated && result.httpStatus, 200)
    assert.equal(providerCalls.length, 2)
    assert.equal(productionProviderCalls.length, 0)
    assert.ok(lastCompletionInput)
    assert.equal(lastCompletionInput.providerAttempts.length, 2)
    assert.ok(lastCompletionInput.providerAttempts.every(
      (attempt) => attempt.carrierAccountGlobalId
        !== productionCarrierAccountGlobalId,
    ))
  })

for (const applicableEnvironment of ['sandbox', 'production'] as const) {
  const activation = applicableEnvironment === 'sandbox' ? 'shadow' : 'active'
  test(`${activation} rejects a stale applicable ${applicableEnvironment} group`,
    async () => {
      resetScenario({
        activation,
        staleEnvironment: applicableEnvironment,
      })

      const result = await executeCallback()

      assert.equal(result.authenticated, true)
      assert.equal(result.authenticated && result.httpStatus, 503)
      assert.equal(providerCalls.length, 0)
      assert.equal(productionProviderCalls.length, 0)
      assert.equal(completionCalls, 0)
      assert.equal(failureCalls, 0)
    })
}
