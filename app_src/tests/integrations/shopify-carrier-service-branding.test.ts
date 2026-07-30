import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShopifyStoreEntityRateResponse,
  normalizeShopifyStoreEntityName,
  shopifyStoreEntityCarrierServiceName,
  shopifyStoreEntityRateDescription,
  shopifyStoreEntityRateName,
} from '../../lib/integrations/shopifyCarrierServiceBranding.ts'

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
    packageCount: 2,
    offers: amountOrder,
  })
  const replay = buildShopifyStoreEntityRateResponse({
    storeEntityName: 'Pro Bakery Bites',
    packageCount: 2,
    offers: providerOrder,
  })

  assert.deepEqual(replay.response, initial.response)
  assert.deepEqual(
    initial.response.rates.map((rate) => rate.service_name),
    [
      'Pro Bakery Bites · UPS · Ground',
      'Pro Bakery Bites · FedEx · Ground',
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
