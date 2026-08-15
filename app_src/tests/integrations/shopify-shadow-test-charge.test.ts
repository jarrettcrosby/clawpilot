import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { CheckoutRateOffer } from '../../lib/integrations/carrierCheckoutRate.ts'

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

const {
  applyShopifyShadowTestCharge,
  shopifyShadowTestChargePolicyFence,
  ShopifyShadowTestChargeError,
} = await import('../../lib/integrations/shopifyShadowTestCharge.ts')
const { collapseShopifyCheckoutRateSourceOffers } = await import(
  '../../lib/integrations/shopifyCheckoutRateSourceOffers.ts'
)

const offers: CheckoutRateOffer[] = [
  {
    provider: 'ups_rest',
    carrierAccountGlobalId: 'gac0000001',
    carrierCode: 'ups',
    serviceLevelCode: 'ground',
    serviceName: 'UPS Ground',
    amountMinor: 853,
    currency: 'USD',
    transitDays: 3,
    deliveryDate: '2026-08-03',
    evidenceGlobalId: 'gre0000001',
  },
  {
    provider: 'fedex_rest',
    carrierAccountGlobalId: 'gac0000002',
    carrierCode: 'fedex',
    serviceLevelCode: 'ground',
    serviceName: 'FedEx Ground',
    amountMinor: 912,
    currency: 'USD',
    transitDays: 3,
    deliveryDate: '2026-08-03',
    evidenceGlobalId: 'gre0000002',
  },
]

test('zeros only the exact selected stable service and retains receipt evidence', () => {
  const charged = applyShopifyShadowTestCharge({
    activationState: 'shadow',
    policy: {
      policyHash: 'policy-v2',
      rowVersion: 2,
      shadowTestChargeMode: 'zero_single_service',
      shadowTestServiceCode: 'clawpilot:ups:ground',
      shadowTestSubsidyReason: 'Authorized zero-dollar checkout test',
    },
    offers,
  })

  assert.deepEqual(charged.map((offer) => ({
    provider: offer.provider,
    serviceLevelCode: offer.serviceLevelCode,
    serviceName: offer.serviceName,
    carrierCostMinor: offer.amountMinor,
    customerChargeMinor: offer.customerChargeMinor,
    subsidyReason: offer.subsidyReason,
  })), [
    {
      provider: 'ups_rest',
      serviceLevelCode: 'ground',
      serviceName: 'UPS Ground',
      carrierCostMinor: 853,
      customerChargeMinor: 0,
      subsidyReason: 'Authorized zero-dollar checkout test',
    },
    {
      provider: 'fedex_rest',
      serviceLevelCode: 'ground',
      serviceName: 'FedEx Ground',
      carrierCostMinor: 912,
      customerChargeMinor: 912,
      subsidyReason: null,
    },
  ])
})

test('charges every account quote for one public service before collapsing', () => {
  const duplicateAccountOffers: CheckoutRateOffer[] = [
    offers[0],
    {
      ...offers[0],
      carrierAccountGlobalId: 'gac0000003',
      amountMinor: 799,
      transitDays: 4,
      deliveryDate: '2026-08-04',
      evidenceGlobalId: 'gre0000003',
    },
  ]
  const charged = applyShopifyShadowTestCharge({
    activationState: 'shadow',
    policy: {
      shadowTestChargeMode: 'zero_single_service',
      shadowTestServiceCode: 'clawpilot:ups:ground',
      shadowTestSubsidyReason: 'Authorized zero-dollar checkout test',
    },
    offers: duplicateAccountOffers,
  })
  assert.deepEqual(
    charged.map((offer) => offer.customerChargeMinor),
    [0, 0],
  )
  const collapsed = collapseShopifyCheckoutRateSourceOffers(charged)
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0]?.carrierAccountGlobalId, 'gac0000003')
  assert.equal(collapsed[0]?.amountMinor, 799)
})

test('collapses duplicate public services by exact deterministic tie order', () => {
  const duplicateAccountOffers: CheckoutRateOffer[] = [
    {
      ...offers[0],
      carrierAccountGlobalId: 'gac0000003',
      amountMinor: 799,
      transitDays: 4,
      deliveryDate: '2026-08-04',
      evidenceGlobalId: 'gre0000003',
    },
    {
      ...offers[0],
      carrierAccountGlobalId: 'gac0000004',
      amountMinor: 799,
      transitDays: 3,
      deliveryDate: '2026-08-03',
      evidenceGlobalId: 'gre0000004',
    },
    {
      ...offers[0],
      carrierAccountGlobalId: 'gac0000002',
      amountMinor: 799,
      transitDays: 3,
      deliveryDate: '2026-08-03',
      evidenceGlobalId: 'gre0000002',
    },
  ]
  const charged = applyShopifyShadowTestCharge({
    activationState: 'active',
    policy: null,
    offers: duplicateAccountOffers,
  })
  const collapsed = collapseShopifyCheckoutRateSourceOffers(charged)
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0]?.carrierAccountGlobalId, 'gac0000002')
  assert.equal(collapsed[0]?.evidenceGlobalId, 'gre0000002')
})

test('fails closed when the configured stable service is unavailable', () => {
  assert.throws(
    () => applyShopifyShadowTestCharge({
      activationState: 'shadow',
      policy: {
        shadowTestChargeMode: 'zero_single_service',
        shadowTestServiceCode: 'clawpilot:ups:next_day_air',
        shadowTestSubsidyReason: 'Authorized zero-dollar checkout test',
      },
      offers,
    }),
    (error) => (
      error instanceof ShopifyShadowTestChargeError
      && error.code === 'SHOPIFY_SHADOW_TEST_SERVICE_UNAVAILABLE'
    ),
  )
})

test('fails closed before receipt persistence for unsupported reason bounds', () => {
  for (const shadowTestSubsidyReason of ['ab', 'x'.repeat(161)]) {
    assert.throws(
      () => applyShopifyShadowTestCharge({
        activationState: 'shadow',
        policy: {
          shadowTestChargeMode: 'zero_single_service',
          shadowTestServiceCode: 'clawpilot:ups:ground',
          shadowTestSubsidyReason,
        },
        offers,
      }),
      (error) => (
        error instanceof ShopifyShadowTestChargeError
        && error.code === 'SHOPIFY_SHADOW_TEST_SUBSIDY_INVALID'
      ),
    )
  }
})

test('keeps carrier charges in normal mode and every non-Shadow state', () => {
  for (const input of [
    {
      activationState: 'shadow',
      policy: {
        shadowTestChargeMode: 'carrier_rate' as const,
        shadowTestServiceCode: null,
        shadowTestSubsidyReason: null,
      },
    },
    {
      activationState: 'active',
      policy: {
        shadowTestChargeMode: 'zero_single_service' as const,
        shadowTestServiceCode: 'clawpilot:ups:ground',
        shadowTestSubsidyReason: 'Must not apply outside Shadow',
      },
    },
  ]) {
    const charged = applyShopifyShadowTestCharge({ ...input, offers })
    assert.deepEqual(
      charged.map((offer) => ({
        customerChargeMinor: offer.customerChargeMinor,
        subsidyReason: offer.subsidyReason,
      })),
      [
        { customerChargeMinor: 853, subsidyReason: null },
        { customerChargeMinor: 912, subsidyReason: null },
      ],
    )
  }
})

test('policy fence changes with subsidy configuration but is absent in Active', () => {
  const shadowFence = shopifyShadowTestChargePolicyFence({
    activationState: 'shadow',
    policy: {
      policyHash: 'policy-v2',
      rowVersion: 2,
      shadowTestChargeMode: 'zero_single_service',
      shadowTestServiceCode: 'clawpilot:ups:ground',
      shadowTestSubsidyReason: 'Authorized zero-dollar checkout test',
    },
  })
  assert.deepEqual(shadowFence, {
    policyHash: 'policy-v2',
    rowVersion: 2,
    chargeMode: 'zero_single_service',
    serviceCode: 'clawpilot:ups:ground',
    subsidyReason: 'Authorized zero-dollar checkout test',
  })
  assert.equal(shopifyShadowTestChargePolicyFence({
    activationState: 'active',
    policy: {
      policyHash: 'policy-v2',
      rowVersion: 2,
      shadowTestChargeMode: 'zero_single_service',
      shadowTestServiceCode: 'clawpilot:ups:ground',
      shadowTestSubsidyReason: 'Authorized zero-dollar checkout test',
    },
  }), null)
})
