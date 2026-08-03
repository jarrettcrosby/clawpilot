import assert from 'node:assert/strict'
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

let configuredVariantIds: ReadonlySet<string> | null = new Set([
  allowedVariantId,
])
let customerPolicy: { mode: string } | null = { mode: 'show_all' }
let policyLookupCount = 0
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
  policyHash: 'policy-hash',
  policySnapshot: {},
  warehouseId: '33333333-3333-4333-8333-333333333333',
  warehouseGlobalId: 'gwh0000001',
  warehouseName: 'AG Alchemy',
  warehouseTimezone: 'America/Chicago',
  warehouseAddress: {},
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
      accountStatus: 'active',
      integrationStatus: 'active',
      environment: 'sandbox',
    },
  ],
} as const

mock.module('@/lib/integrations/shopifyShadowCheckoutAllowlist', {
  namedExports: {
    configuredShopifyNumericIdentifierSet() {
      return configuredVariantIds
    },
  },
})

mock.module('@/lib/persistence/shopifyCustomerRatePolicies', {
  namedExports: {
    async readActiveShopifyCustomerRatePolicyFromPostgres() {
      policyLookupCount += 1
      return customerPolicy
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
    shopifyProductGid: unexpectedDownstreamCall('cartonization_product_gid'),
    shopifyVariantGid: unexpectedDownstreamCall('cartonization_variant_gid'),
  },
})

mock.module('@/lib/integrations/carrierCheckoutRate', {
  namedExports: {
    rateOptimizedCheckoutPlans:
      unexpectedDownstreamCall('carrier_rate_optimization'),
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
    carrierSandboxRateDestinationFingerprint:
      unexpectedDownstreamCall('carrier_destination_fingerprint'),
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
    name: 'missing customer identity',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
    configured: new Set([allowedVariantId]),
    policy: { mode: 'show_all' },
    request: callbackPayload({}),
    expectedPolicyLookups: 0,
  },
  {
    name: 'missing variant configuration',
    reasonCode:
      ShopifyShadowCheckoutGuardDenialReason.MissingVariantConfiguration,
    configured: null,
    policy: { mode: 'show_all' },
    request: callbackPayload({ customerId: 207119551 }),
    expectedPolicyLookups: 0,
  },
  {
    name: 'no shippable items',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.NoShippableItems,
    configured: new Set([allowedVariantId]),
    policy: { mode: 'show_all' },
    request: callbackPayload({
      customerId: 207119551,
      requiresShipping: false,
    }),
    expectedPolicyLookups: 0,
  },
  {
    name: 'unallowlisted variant',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.UnallowlistedVariant,
    configured: new Set([allowedVariantId]),
    policy: { mode: 'show_all' },
    request: callbackPayload({
      customerId: 207119551,
      variantId: deniedVariantId,
    }),
    expectedPolicyLookups: 0,
  },
  {
    name: 'absent or ineligible customer policy',
    reasonCode:
      ShopifyShadowCheckoutGuardDenialReason.PolicyAbsentOrIneligible,
    configured: new Set([allowedVariantId]),
    policy: null,
    request: callbackPayload({ customerId: 207119551 }),
    expectedPolicyLookups: 1,
  },
  {
    name: 'hide-all customer policy',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.HideAll,
    configured: new Set([allowedVariantId]),
    policy: { mode: 'hide_all' },
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
          configuredVariantIds = scenario.configured
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
              checkpoint: 'request_parsed',
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
