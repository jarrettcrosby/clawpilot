import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShopifyStoreEntityRateResponse,
  normalizeShopifyStoreEntityName,
  shopifyStoreEntityCarrierServiceName,
  shopifyStoreEntityRateDescription,
  shopifyStoreEntityRateName,
} from '../../lib/integrations/shopifyCarrierServiceBranding.ts'

const packages = [
  {
    packageSequence: 1,
    itemCount: 30,
    contentWeightGrams: 5_100,
    tareWeightGrams: 95,
    grossWeightGrams: 5_195,
  },
  {
    packageSequence: 2,
    itemCount: 12,
    contentWeightGrams: 2_040,
    tareWeightGrams: 95,
    grossWeightGrams: 2_135,
  },
  {
    packageSequence: 3,
    itemCount: 8,
    contentWeightGrams: 1_360,
    tareWeightGrams: 95,
    grossWeightGrams: 1_455,
  },
] as const

test('uses the store entity, carrier, and normalized service at checkout', () => {
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'ups',
      providerServiceName: 'UPS Ground',
    }),
    'Pro Bakery Bites · UPS · Ground',
  )
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'ups',
      providerServiceName: 'UPS® Ground',
    }),
    'Pro Bakery Bites · UPS · Ground',
  )
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'fedex',
      providerServiceName: 'FedEx Ground',
    }),
    'Pro Bakery Bites · FedEx · Ground',
  )
  assert.equal(
    shopifyStoreEntityRateDescription({
      storeEntityName: 'Pro Bakery Bites',
      packageCount: 2,
    }),
    'Pro Bakery Bites · 2-package shipment',
  )
})

test('retains store, carrier, and service at the Shopify boundary', () => {
  const providerServiceName = 'S'.repeat(160)
  const value = shopifyStoreEntityRateName({
    storeEntityName: 'Store '.repeat(42),
    carrierCode: 'ups',
    providerServiceName,
  })

  assert.equal(value.length, 255)
  assert.match(value, /^Store/)
  assert.ok(value.endsWith(
    ` · UPS · ${providerServiceName}`,
  ))
  assert.doesNotMatch(value, /Warehouse Warehouse/)
})

test('adds exact package totals and complete compact package detail', () => {
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'ups',
      providerServiceName: 'UPS Ground',
      packages,
    }),
    'Pro Bakery Bites · UPS · Ground · 3 packages · 50 items'
      + ' · 19.37 lb gross · 18.74 lb items · 0.63 lb tare'
      + ' · P1: 30 items, 11.45 lb gross, 0.21 lb tare'
      + '; P2: 12 items, 4.71 lb gross, 0.21 lb tare'
      + '; P3: 8 items, 3.21 lb gross, 0.21 lb tare',
  )
})

test('does not repeat the only package as P1', () => {
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'fedex',
      providerServiceName: 'FedEx Ground®',
      packages: [{
        packageSequence: 1,
        itemCount: 5,
        contentWeightGrams: 848,
        tareWeightGrams: 91,
        grossWeightGrams: 939,
      }],
    }),
    'Pro Bakery Bites · FedEx · Ground® · 1 package · 5 items'
      + ' · 2.07 lb gross · 1.87 lb items · 0.20 lb tare',
  )
})

test('shows each package tare independently from its gross weight', () => {
  const value = shopifyStoreEntityRateName({
    storeEntityName: 'Pro Bakery Bites',
    carrierCode: 'ups',
    providerServiceName: 'UPS Ground',
    packages: [
      {
        packageSequence: 1,
        itemCount: 1,
        contentWeightGrams: 1_000,
        tareWeightGrams: 100,
        grossWeightGrams: 1_100,
      },
      {
        packageSequence: 2,
        itemCount: 2,
        contentWeightGrams: 500,
        tareWeightGrams: 250,
        grossWeightGrams: 750,
      },
    ],
  })

  assert.ok(value.includes('2 packages · 3 items · 4.08 lb gross'))
  assert.ok(value.includes('3.31 lb items · 0.77 lb tare'))
  assert.ok(value.includes('P1: 1 item, 2.43 lb gross, 0.22 lb tare'))
  assert.ok(value.includes('P2: 2 items, 1.65 lb gross, 0.55 lb tare'))
})

test('keeps core package totals and drops only detail at the text limit', () => {
  const value = shopifyStoreEntityRateName({
    storeEntityName: 'Store '.repeat(42),
    carrierCode: 'ups',
    providerServiceName: `UPS ${'S'.repeat(156)}`,
    packages,
  })

  assert.ok(value.length <= 255)
  assert.match(value, /^Store/)
  assert.ok(value.includes('3 packages · 50 items'))
  assert.ok(value.includes('19.37 lb gross'))
  assert.ok(value.includes('18.74 lb items'))
  assert.ok(value.endsWith('0.63 lb tare'))
  assert.doesNotMatch(value, /P1: 30 items/)
})

test('fails closed on inconsistent package presentation evidence', () => {
  assert.throws(
    () => shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      carrierCode: 'ups',
      providerServiceName: 'UPS Ground',
      packages: [{
        ...packages[0],
        grossWeightGrams: packages[0].grossWeightGrams + 1,
      }],
    }),
    /package summary is inconsistent/,
  )
})

test('normalizes provider store whitespace and rejects missing identity', () => {
  assert.equal(
    normalizeShopifyStoreEntityName('  Pro   Bakery\nBites  '),
    'Pro Bakery Bites',
  )
  assert.throws(
    () => normalizeShopifyStoreEntityName(''),
    /store entity name is missing or invalid/,
  )
})

test('brands the registered CarrierService with the verified store entity', () => {
  assert.equal(
    shopifyStoreEntityCarrierServiceName('  Pro   Bakery Bites  '),
    'Pro Bakery Bites',
  )
  assert.doesNotMatch(
    shopifyStoreEntityCarrierServiceName('Pro Bakery Bites'),
    /clawpilot|shopify/i,
  )
})

test('canonicalizes initial and reloaded offer order to the same response', () => {
  const amountOrder = [
    {
      carrierCode: 'ups' as const,
      serviceLevelCode: 'ground',
      providerServiceName: 'UPS Ground',
      amountMinor: 850,
      currency: 'USD',
      minDeliveryDate: null,
      maxDeliveryDate: null,
    },
    {
      carrierCode: 'fedex' as const,
      serviceLevelCode: 'ground',
      providerServiceName: 'FedEx Ground',
      amountMinor: 1250,
      currency: 'USD',
      minDeliveryDate: null,
      maxDeliveryDate: null,
    },
  ]
  const providerOrder = [...amountOrder].reverse()

  const initial = buildShopifyStoreEntityRateResponse({
    storeEntityName: 'Pro Bakery Bites',
    packageCount: packages.length,
    packages,
    offers: amountOrder,
  })
  const replay = buildShopifyStoreEntityRateResponse({
    storeEntityName: 'Pro Bakery Bites',
    packageCount: packages.length,
    packages: [...packages].reverse(),
    offers: providerOrder,
  })

  assert.deepEqual(replay.response, initial.response)
  assert.deepEqual(
    initial.response.rates.map((rate) => rate.service_name),
    [
      'Pro Bakery Bites · UPS · Ground · 3 packages · 50 items'
        + ' · 19.37 lb gross · 18.74 lb items · 0.63 lb tare'
        + ' · P1: 30 items, 11.45 lb gross, 0.21 lb tare'
        + '; P2: 12 items, 4.71 lb gross, 0.21 lb tare'
        + '; P3: 8 items, 3.21 lb gross, 0.21 lb tare',
      'Pro Bakery Bites · FedEx · Ground · 3 packages · 50 items'
        + ' · 19.37 lb gross · 18.74 lb items · 0.63 lb tare'
        + ' · P1: 30 items, 11.45 lb gross, 0.21 lb tare'
        + '; P2: 12 items, 4.71 lb gross, 0.21 lb tare'
        + '; P3: 8 items, 3.21 lb gross, 0.21 lb tare',
    ],
  )
  assert.deepEqual(
    initial.response.rates.map((rate) => rate.service_code),
    [
      'clawpilot:ups:ground',
      'clawpilot:fedex:ground',
    ],
  )
  assert.equal(JSON.stringify(initial.response).includes('Warehouse'), false)
})

test('never splits a Unicode code point at the Shopify text limit', () => {
  assert.equal(
    normalizeShopifyStoreEntityName('🐾'.repeat(255)),
    '🐾'.repeat(255),
  )
  const value = shopifyStoreEntityRateName({
    storeEntityName: `${'A'.repeat(238)}🐾`,
    carrierCode: 'ups',
    providerServiceName: 'UPS Ground',
  })

  assert.equal(value.length, 255)
  assert.ok(value.endsWith('🐾 · UPS · Ground'))
})
