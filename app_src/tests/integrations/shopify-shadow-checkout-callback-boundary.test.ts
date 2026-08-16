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
        new URL(appPath.endsWith('.mjs') ? appPath : `${appPath}.ts`, appSourceUrl).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

const accountGlobalId = 'gia0000001'
const callbackToken = 'a'.repeat(43)
const allowedVariantId = '258644705304'
const deniedVariantId = '258644705305'

type CustomerPolicyFixture = {
  mode: 'show_all' | 'hide_all' | 'include_only' | 'exclude'
  serviceCodes: string[]
  policyHash: string
  rowVersion: number
  shadowTestChargeMode: 'carrier_rate'
  shadowTestServiceCode: null
  shadowTestSubsidyReason: null
}
const checkoutCustomerPolicy = (
  mode: CustomerPolicyFixture['mode'],
): CustomerPolicyFixture => ({
  mode,
  serviceCodes: [],
  policyHash: 'a'.repeat(64),
  rowVersion: 1,
  shadowTestChargeMode: 'carrier_rate',
  shadowTestServiceCode: null,
  shadowTestSubsidyReason: null,
})
let customerPolicy: CustomerPolicyFixture | null =
  checkoutCustomerPolicy('show_all')
let checkoutAudienceMode:
  | 'off'
  | 'restricted_customers'
  | 'all_eligible' = 'restricted_customers'
let checkoutRateSource: 'sandbox' | 'production' = 'sandbox'
let activationState:
  | 'disabled'
  | 'shadow'
  | 'read_only'
  | 'active'
  | 'frozen' = 'shadow'
let accountEnvironment: 'sandbox' | 'production' = 'sandbox'
let storeSyncDesiredState: 'running' | 'paused' = 'running'
let policyLookupCount = 0
let ratingAccountAvailable = true
let flipToRestrictedLiveAfterPolicyLookup = false
const downstreamCalls: string[] = []

function unexpectedDownstreamCall(name: string) {
  return () => {
    downstreamCalls.push(name)
    throw new Error(`unexpected downstream call: ${name}`)
  }
}

const account = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  accountGlobalId,
  storeEntityName: 'Pro Bakery Bites',
  get environment() {
    return accountEnvironment
  },
  externalAccountId: 'pro-bakery-bites.myshopify.com',
  registrationState: 'registered',
  get storeSyncDesiredState() {
    return storeSyncDesiredState
  },
  configGlobalId: 'gscf0000001',
  configRowVersion: 1,
  credentialGeneration: 1,
  registrationActivationRevision: 1,
  get activationState() {
    return activationState
  },
  activationRevision: 1,
  callbackTokenVersion: 1,
  policyRevision: 1,
  policyHash: 'policy-hash',
  get policySnapshot() {
    return {
      checkoutRateControl: {
        version: 'shopify-checkout-rate-control-v1',
        audience: checkoutAudienceMode,
        rateSource: checkoutRateSource,
      },
    }
  },
  get checkoutRateControl() {
    return {
      version: 'shopify-checkout-rate-control-v1' as const,
      audience: checkoutAudienceMode,
      rateSource: checkoutRateSource,
    }
  },
  warehouseId: '33333333-3333-4333-8333-333333333333',
  warehouseGlobalId: 'gwh0000001',
  warehouseName: 'AG Alchemy',
  warehouseTimezone: 'America/Chicago',
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
  algorithmVersion: 'test',
  materials: [],
  carriers: [
    {
      provider: 'ups_rest',
      carrierAccountId: '44444444-4444-4444-8444-444444444444',
      carrierAccountGlobalId: 'gac0000001',
      credentialVersion: 1,
      displayName: 'UPS sandbox',
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
      provider: 'fedex_rest',
      carrierAccountId: '55555555-5555-4555-8555-555555555555',
      carrierAccountGlobalId: 'gac0000002',
      credentialVersion: 1,
      displayName: 'FedEx sandbox',
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
  ],
} as const

mock.module('@/lib/persistence/shopifyCustomerRatePolicies', {
  namedExports: {
    async readShopifyCheckoutCustomerRatePolicyFromPostgres() {
      policyLookupCount += 1
      return customerPolicy
    },
  },
})

mock.module('@/lib/persistence/shopifyCheckoutRating', {
  namedExports: {
    SHOPIFY_CHECKOUT_RECEIPT_LINE_SNAPSHOT_VERSION:
      'shopify-checkout-line-pack-evidence-v1',
    async lookupShopifyCarrierServiceCallbackPolicyByGlobalIdInPostgres() {
      const policy = {
        organizationId: account.organizationId,
        accountGlobalId,
        environment: accountEnvironment,
        activationState: account.activationState,
        policySnapshot: account.policySnapshot,
        checkoutRateControl: account.checkoutRateControl,
      }
      if (flipToRestrictedLiveAfterPolicyLookup) {
        checkoutAudienceMode = 'restricted_customers'
        checkoutRateSource = 'production'
      }
      return policy
    },
    async lookupShopifyCheckoutRatingAccountByGlobalIdInPostgres() {
      return ratingAccountAvailable
        && !(
          checkoutAudienceMode === 'restricted_customers'
          && checkoutRateSource === 'production'
        )
        ? account
        : null
    },
    assertShopifyCheckoutRatingRuntimeReadyInPostgres:
      unexpectedDownstreamCall('rating_runtime_readiness'),
    claimShopifyCheckoutRateReceiptInPostgres:
      unexpectedDownstreamCall('receipt_claim'),
    completeShopifyCheckoutRateReceiptInPostgres:
      unexpectedDownstreamCall('receipt_complete'),
    failShopifyCheckoutRateReceiptInPostgres:
      unexpectedDownstreamCall('receipt_fail'),
    readCachedShopifyCheckoutRateReceiptInPostgres:
      unexpectedDownstreamCall('receipt_cache'),
    shopifyCheckoutPackagePlanHash:
      unexpectedDownstreamCall('receipt_package_plan_hash'),
    shopifyCheckoutRatingHash:
      unexpectedDownstreamCall('receipt_rating_hash'),
  },
})

mock.module('@/lib/persistence/shopifyCheckoutContext', {
  namedExports: {
    readShopifyCheckoutContextFromPostgres:
      unexpectedDownstreamCall('cartonization_context'),
  },
})

mock.module('@/lib/operations/shopifyCheckoutRating', {
  namedExports: {
    planShopifyCheckoutPackageCandidates:
      unexpectedDownstreamCall('cartonization_plan'),
    shopifyProductGid(value: string | number) {
      downstreamCalls.push('cartonization_product_gid')
      return `gid://shopify/Product/${value}`
    },
    shopifyVariantGid(value: string | number) {
      downstreamCalls.push('cartonization_variant_gid')
      return `gid://shopify/ProductVariant/${value}`
    },
  },
})

mock.module('@/lib/integrations/carrierCheckoutRate', {
  namedExports: {
    CHECKOUT_RATE_MAX_CARRIER_ACCOUNTS: 8,
    rateOptimizedCheckoutPlans:
      unexpectedDownstreamCall('carrier_rate_optimization'),
  },
})

mock.module('@/lib/integrations/shopifyCarrierServiceProductionRate', {
  namedExports: {
    rateShopifyProductionCheckoutShipment:
      unexpectedDownstreamCall('production_provider_rate'),
  },
})

mock.module('@/lib/integrations/carrierIntegrations', {
  namedExports: {
    testCarrierSandboxShipmentRate:
      unexpectedDownstreamCall('provider_rate'),
  },
})

mock.module('@/lib/integrations/carrierSandboxRate', {
  namedExports: {
    carrierSandboxRateDestinationFingerprint() {
      downstreamCalls.push('carrier_destination_fingerprint')
      return 'd'.repeat(64)
    },
  },
})

const { executeShopifyCarrierServiceCallback } = await import(
  '../../lib/integrations/shopifyCarrierServiceCallback.ts'
)
const { ShopifyShadowCheckoutGuardDenialReason } = await import(
  '../../lib/integrations/shopifyShadowCheckoutGuard.ts'
)

function callbackPayload(input: {
  customerId?: number | null
  variantId?: string
  requiresShipping?: boolean
}) {
  return {
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
        requires_shipping: input.requiresShipping ?? true,
        taxable: false,
        fulfillment_service: 'manual',
        properties: null,
        product_id: 48447225880,
        variant_id: Number(input.variantId ?? allowedVariantId),
      }],
      currency: 'USD',
      locale: 'en_US',
      order_totals: {
        subtotal_price: '0',
        total_price: '0',
        discount_amount: '0',
      },
      ...(input.customerId === undefined
        ? {}
        : {
            customer: input.customerId === null
              ? null
              : { id: input.customerId, tags: ['warehouse-test'] },
          }),
    },
  }
}

function callbackRequest(payload: ReturnType<typeof callbackPayload>) {
  return new Request('https://example.test/shopify/carrier-service', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

const scenarios = [
  {
    name: 'checkout audience off',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.AudienceOff,
    audienceMode: 'off',
    policy: checkoutCustomerPolicy('show_all'),
    request: callbackPayload({}),
    expectedPolicyLookups: 0,
  },
  {
    name: 'missing customer identity',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
    audienceMode: 'restricted_customers',
    policy: checkoutCustomerPolicy('show_all'),
    request: callbackPayload({}),
    expectedPolicyLookups: 0,
  },
  {
    name: 'no shippable items',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.NoShippableItems,
    audienceMode: 'restricted_customers',
    policy: checkoutCustomerPolicy('show_all'),
    request: callbackPayload({
      customerId: 207119551,
      requiresShipping: false,
    }),
    expectedPolicyLookups: 0,
  },
  {
    name: 'absent or ineligible customer policy',
    reasonCode:
      ShopifyShadowCheckoutGuardDenialReason.PolicyAbsentOrIneligible,
    audienceMode: 'restricted_customers',
    policy: null,
    request: callbackPayload({ customerId: 207119551 }),
    expectedPolicyLookups: 1,
  },
  {
    name: 'hide-all customer policy',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.HideAll,
    audienceMode: 'restricted_customers',
    policy: checkoutCustomerPolicy('hide_all'),
    request: callbackPayload({ customerId: 207119551 }),
    expectedPolicyLookups: 1,
  },
] as const

test('every Shadow guard denial is a privacy-safe zero-work callback boundary',
  async (t) => {
    const warningCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    try {
      for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
          accountEnvironment = 'sandbox'
          ratingAccountAvailable = true
          checkoutAudienceMode = scenario.audienceMode
          customerPolicy = scenario.policy
          policyLookupCount = 0
          downstreamCalls.length = 0
          warningCalls.length = 0

          const result = await executeShopifyCarrierServiceCallback({
            accountGlobalId,
            callbackToken,
            request: callbackRequest(scenario.request),
          })

          assert.deepEqual(result, {
            authenticated: true,
            httpStatus: 200,
            response: { rates: [] },
          })
          assert.equal(policyLookupCount, scenario.expectedPolicyLookups)
          assert.deepEqual(
            downstreamCalls,
            [],
            'a denied request must not reach receipt, cartonization, carrier, or provider work',
          )
          assert.deepEqual(warningCalls, [[
            '[shopify checkout rating] shadow guard denied',
            {
              accountGlobalId,
              stage: 'shadow_guard',
              checkpoint: scenario.audienceMode === 'off'
                ? 'account_authenticated'
                : 'request_parsed',
              reasonCode: scenario.reasonCode,
            },
          ]])
          const telemetry = warningCalls[0]?.[1] as Record<string, unknown>
          assert.deepEqual(Object.keys(telemetry).sort(), [
            'accountGlobalId',
            'checkpoint',
            'reasonCode',
            'stage',
          ])
          assert.equal(
            JSON.stringify(warningCalls).includes('207119551'),
            false,
          )
          assert.equal(
            JSON.stringify(warningCalls).includes(allowedVariantId),
            false,
          )
          assert.equal(
            JSON.stringify(warningCalls).includes(deniedVariantId),
            false,
          )
        })
      }
    } finally {
      warn.mock.restore()
    }
  },
)

test('configured Off stays an authenticated 200 empty response when full readiness drifts',
  async () => {
    const warningCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    try {
      accountEnvironment = 'sandbox'
      checkoutAudienceMode = 'off'
      ratingAccountAvailable = false
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({})),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 200,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])
      assert.deepEqual(warningCalls, [[
        '[shopify checkout rating] shadow guard denied',
        {
          accountGlobalId,
          stage: 'shadow_guard',
          checkpoint: 'account_authenticated',
          reasonCode: 'SHOPIFY_SHADOW_GUARD_AUDIENCE_OFF',
        },
      ]])
    } finally {
      warn.mock.restore()
      ratingAccountAvailable = true
      checkoutAudienceMode = 'restricted_customers'
    }
  },
)

test('Disabled and Frozen are distinct authenticated empty-rate emergency overrides',
  async () => {
    for (const scenario of [
      {
        activationState: 'disabled' as const,
        reasonCode: 'SHOPIFY_CHECKOUT_RATES_EMERGENCY_DISABLED',
      },
      {
        activationState: 'frozen' as const,
        reasonCode: 'SHOPIFY_CHECKOUT_RATES_EMERGENCY_FROZEN',
      },
    ]) {
      const warningCalls: unknown[][] = []
      const warn = mock.method(console, 'warn', (...args: unknown[]) => {
        warningCalls.push(args)
      })
      try {
        activationState = scenario.activationState
        checkoutAudienceMode = 'all_eligible'
        checkoutRateSource = 'production'
        accountEnvironment = 'production'
        ratingAccountAvailable = false
        policyLookupCount = 0
        downstreamCalls.length = 0

        const result = await executeShopifyCarrierServiceCallback({
          accountGlobalId,
          callbackToken,
          request: callbackRequest(callbackPayload({})),
        })

        assert.deepEqual(result, {
          authenticated: true,
          httpStatus: 200,
          response: { rates: [] },
        })
        assert.equal(policyLookupCount, 0)
        assert.deepEqual(downstreamCalls, [])
        assert.deepEqual(warningCalls, [[
          '[shopify checkout rating] shadow guard denied',
          {
            accountGlobalId,
            stage: 'shadow_guard',
            checkpoint: 'account_authenticated',
            reasonCode: scenario.reasonCode,
          },
        ]])
      } finally {
        warn.mock.restore()
        activationState = 'shadow'
        checkoutAudienceMode = 'restricted_customers'
        checkoutRateSource = 'sandbox'
        accountEnvironment = 'sandbox'
        ratingAccountAvailable = true
      }
    }
  },
)

test('a Restricted TEST policy saved while Frozen stays empty, then resumes in Read-only',
  async () => {
    const callbackError = mock.method(console, 'error', () => undefined)
    try {
      customerPolicy = checkoutCustomerPolicy('show_all')
      checkoutAudienceMode = 'restricted_customers'
      checkoutRateSource = 'sandbox'
      accountEnvironment = 'sandbox'
      ratingAccountAvailable = true
      activationState = 'frozen'
      policyLookupCount = 0
      downstreamCalls.length = 0

      const frozen = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({ customerId: 207119551 })),
      })
      assert.deepEqual(frozen, {
        authenticated: true,
        httpStatus: 200,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])

      activationState = 'read_only'
      const resumed = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({ customerId: 207119551 })),
      })
      assert.equal(resumed.authenticated, true)
      assert.equal(resumed.authenticated && resumed.httpStatus, 503)
      assert.equal(
        policyLookupCount,
        1,
        'Read-only must reuse the exact local policy instead of requiring a global mode rewrite',
      )
    } finally {
      callbackError.mock.restore()
      activationState = 'shadow'
      customerPolicy = checkoutCustomerPolicy('show_all')
      checkoutAudienceMode = 'restricted_customers'
      checkoutRateSource = 'sandbox'
      accountEnvironment = 'sandbox'
      ratingAccountAvailable = true
      policyLookupCount = 0
      downstreamCalls.length = 0
    }
  })

test('an authenticated non-Off callback retains strict full readiness', async () => {
  try {
    accountEnvironment = 'sandbox'
    checkoutAudienceMode = 'restricted_customers'
    ratingAccountAvailable = false
    policyLookupCount = 0
    downstreamCalls.length = 0

    const result = await executeShopifyCarrierServiceCallback({
      accountGlobalId,
      callbackToken,
      request: callbackRequest(callbackPayload({ customerId: 207119551 })),
    })

    assert.deepEqual(result, {
      authenticated: true,
      httpStatus: 503,
      response: { rates: [] },
    })
    assert.equal(policyLookupCount, 0)
    assert.deepEqual(downstreamCalls, [])
  } finally {
    ratingAccountAvailable = true
  }
})

test('Read-only and Active restricted audiences use local customer policy allow and deny decisions',
  async () => {
    const errorCalls: unknown[][] = []
    const callbackError = mock.method(console, 'error', (...args: unknown[]) => {
      errorCalls.push(args)
    })
    try {
      for (const state of ['read_only', 'active'] as const) {
        activationState = state
        accountEnvironment = 'sandbox'
        checkoutRateSource = 'sandbox'
        checkoutAudienceMode = 'restricted_customers'
        ratingAccountAvailable = true

        customerPolicy = checkoutCustomerPolicy('show_all')
        policyLookupCount = 0
        downstreamCalls.length = 0
        const allowed = await executeShopifyCarrierServiceCallback({
          accountGlobalId,
          callbackToken,
          request: callbackRequest(callbackPayload({
            customerId: 207119551,
          })),
        })
        assert.equal(allowed.authenticated, true)
        assert.equal(allowed.authenticated && allowed.httpStatus, 503)
        assert.equal(policyLookupCount, 1)
        assert.notEqual(
          allowed.authenticated && allowed.httpStatus,
          200,
          `${state} local customer allow policy was treated as a denial`,
        )

        customerPolicy = null
        errorCalls.length = 0
        policyLookupCount = 0
        downstreamCalls.length = 0
        const denied = await executeShopifyCarrierServiceCallback({
          accountGlobalId,
          callbackToken,
          request: callbackRequest(callbackPayload({
            customerId: 207119551,
          })),
        })
        assert.deepEqual(denied, {
          authenticated: true,
          httpStatus: 200,
          response: { rates: [] },
        })
        assert.equal(policyLookupCount, 1)
        assert.deepEqual(downstreamCalls, [])
      }
    } finally {
      callbackError.mock.restore()
      activationState = 'shadow'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      customerPolicy = checkoutCustomerPolicy('show_all')
      ratingAccountAvailable = true
      policyLookupCount = 0
      downstreamCalls.length = 0
    }
  })

test('production Restricted stays desired but is authenticated empty before checkout work without provider enforcement',
  async () => {
    const warningCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    try {
      activationState = 'read_only'
      accountEnvironment = 'production'
      checkoutRateSource = 'production'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = false
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({ customerId: 207119551 })),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 200,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])
      assert.deepEqual(warningCalls, [[
        '[shopify checkout rating] shadow guard denied',
        {
          accountGlobalId,
          stage: 'shadow_guard',
          checkpoint: 'account_authenticated',
          reasonCode:
            'SHOPIFY_CHECKOUT_RESTRICTED_LIVE_ENFORCEMENT_REQUIRED',
        },
      ]])
    } finally {
      warn.mock.restore()
      activationState = 'shadow'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = true
    }
  })

test('sandbox store with Restricted LIVE source is also authenticated empty before checkout work',
  async () => {
    try {
      activationState = 'read_only'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'production'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = false
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({ customerId: 207119551 })),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 200,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])
    } finally {
      activationState = 'shadow'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = true
    }
  })

test('an All-eligible LIVE policy flipped to Restricted LIVE before full lookup cannot claim or rate',
  async () => {
    try {
      activationState = 'read_only'
      accountEnvironment = 'production'
      checkoutRateSource = 'production'
      checkoutAudienceMode = 'all_eligible'
      ratingAccountAvailable = true
      flipToRestrictedLiveAfterPolicyLookup = true
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({})),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 503,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(
        downstreamCalls,
        [],
        'the authoritative full lookup must fence the changed control before receipt or carrier work',
      )
    } finally {
      flipToRestrictedLiveAfterPolicyLookup = false
      activationState = 'shadow'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = true
    }
  })

test('production store with desired TEST source is authenticated empty before checkout work',
  async () => {
    try {
      activationState = 'read_only'
      accountEnvironment = 'production'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'all_eligible'
      ratingAccountAvailable = false
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({})),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 200,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])
    } finally {
      activationState = 'shadow'
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      ratingAccountAvailable = true
    }
  })

test('all-eligible audience on a production store fails before checkout work',
  async () => {
    const warningCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    try {
      accountEnvironment = 'production'
      checkoutRateSource = 'production'
      ratingAccountAvailable = true
      checkoutAudienceMode = 'all_eligible'
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({})),
      })

      assert.deepEqual(result, {
        authenticated: true,
        httpStatus: 503,
        response: { rates: [] },
      })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [])
      assert.deepEqual(warningCalls, [])
    } finally {
      warn.mock.restore()
      accountEnvironment = 'sandbox'
      checkoutRateSource = 'sandbox'
      ratingAccountAvailable = true
      checkoutAudienceMode = 'restricted_customers'
    }
  },
)

test('all-eligible audience bypasses customer-policy lookup but keeps later callback checks',
  async () => {
    const warningCalls: unknown[][] = []
    const errorCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    const error = mock.method(console, 'error', (...args: unknown[]) => {
      errorCalls.push(args)
    })
    const priorSessionSecret = process.env.APP_SESSION_SECRET
    try {
      process.env.APP_SESSION_SECRET = 'audience-callback-test-secret-32-bytes'
      accountEnvironment = 'sandbox'
      checkoutAudienceMode = 'all_eligible'
      customerPolicy = checkoutCustomerPolicy('hide_all')
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({})),
      })

      assert.equal(result.authenticated, true)
      assert.notEqual(result.httpStatus, 200)
      assert.deepEqual(result.response, { rates: [] })
      assert.equal(policyLookupCount, 0)
      assert.deepEqual(downstreamCalls, [
        'cartonization_product_gid',
        'cartonization_variant_gid',
        'carrier_destination_fingerprint',
        'cartonization_context',
      ])
      assert.equal(warningCalls.length, 1)
      assert.equal(errorCalls.length, 0)
      assert.equal(
        (warningCalls[0]?.[1] as Record<string, unknown>)?.stage,
        'checkout_context',
      )
      assert.equal(
        JSON.stringify(warningCalls).includes(
          'SHOPIFY_SHADOW_GUARD_MISSING_CUSTOMER',
        ),
        false,
      )
    } finally {
      warn.mock.restore()
      error.mock.restore()
      if (priorSessionSecret === undefined) {
        delete process.env.APP_SESSION_SECRET
      } else {
        process.env.APP_SESSION_SECRET = priorSessionSecret
      }
      accountEnvironment = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
    }
  },
)

test('Paused Store sync does not gate authenticated CarrierService callback evaluation',
  async () => {
    const warningCalls: unknown[][] = []
    const warn = mock.method(console, 'warn', (...args: unknown[]) => {
      warningCalls.push(args)
    })
    const priorSessionSecret = process.env.APP_SESSION_SECRET
    try {
      process.env.APP_SESSION_SECRET = 'paused-sync-callback-test-secret-32-bytes'
      storeSyncDesiredState = 'paused'
      accountEnvironment = 'sandbox'
      checkoutAudienceMode = 'restricted_customers'
      configuredVariantIds = new Set([allowedVariantId])
      customerPolicy = { mode: 'show_all' }
      policyLookupCount = 0
      downstreamCalls.length = 0

      const result = await executeShopifyCarrierServiceCallback({
        accountGlobalId,
        callbackToken,
        request: callbackRequest(callbackPayload({ customerId: 207119551 })),
      })

      assert.equal(result.authenticated, true)
      assert.notEqual(result.httpStatus, 200)
      assert.equal(policyLookupCount, 1)
      assert.deepEqual(downstreamCalls, [
        'cartonization_product_gid',
        'cartonization_variant_gid',
        'carrier_destination_fingerprint',
        'cartonization_context',
      ])
      assert.equal(
        (warningCalls[0]?.[1] as Record<string, unknown>)?.stage,
        'checkout_context',
      )
    } finally {
      warn.mock.restore()
      storeSyncDesiredState = 'running'
      if (priorSessionSecret === undefined) {
        delete process.env.APP_SESSION_SECRET
      } else {
        process.env.APP_SESSION_SECRET = priorSessionSecret
      }
    }
  },
)
