import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShopifyStoreEntityRateResponse,
  normalizeShopifyStoreEntityName,
  shopifyStoreEntityRateDescription,
  shopifyStoreEntityRateName,
} from '../../lib/integrations/shopifyCarrierServiceBranding.ts'

test('uses the verified store entity ahead of the provider service', () => {
  assert.equal(
    shopifyStoreEntityRateName({
      storeEntityName: 'Pro Bakery Bites',
      providerServiceName: 'UPS Ground',
    }),
    'Pro Bakery Bites · UPS Ground',
  )
  assert.equal(
    shopifyStoreEntityRateDescription({
      storeEntityName: 'Pro Bakery Bites',
      packageCount: 2,
    }),
    'Pro Bakery Bites · 2-package shipment',
  )
})

test('retains store, service, and test alias at the Shopify boundary', () => {
  const providerServiceName = 'S'.repeat(160)
  const shadowCustomerAlias = 'A'.repeat(80)
  const value = shopifyStoreEntityRateName({
    storeEntityName: 'Store '.repeat(42),
    providerServiceName,
    shadowCustomerAlias,
  })

  assert.equal(value.length, 255)
  assert.match(value, /^Store/)
  assert.ok(value.endsWith(
    ` · ${providerServiceName} · ${shadowCustomerAlias}`,
  ))
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
      'Pro Bakery Bites · UPS Ground',
      'Pro Bakery Bites · FedEx Ground',
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
    storeEntityName: `${'A'.repeat(241)}🐾`,
    providerServiceName: 'UPS Ground',
  })

  assert.ok(value.length <= 255)
  assert.ok(value.endsWith(' · UPS Ground'))
  assert.equal(value.includes('\ud83d'), false)
  assert.equal(value.includes('\udc3e'), false)
})
