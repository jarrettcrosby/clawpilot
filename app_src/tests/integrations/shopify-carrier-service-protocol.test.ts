import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildShopifyCarrierServiceRateResponse,
  fingerprintShopifyCarrierServiceRateRequest,
  parseShopifyCarrierServiceRateRequest,
  readShopifyCarrierServiceRateRequest,
  safeShopifyCarrierServiceProtocolErrorPath,
  shopifyCarrierServiceRequestMatchesTestAllowlist,
  SHOPIFY_CARRIER_SERVICE_FINGERPRINT_VERSION,
  SHOPIFY_CARRIER_SERVICE_MAX_REQUEST_BYTES,
  ShopifyCarrierServiceProtocolError,
} from '../../lib/integrations/shopifyCarrierServiceProtocol.ts'

function fixture() {
  return {
    rate: {
      origin: {
        country: 'US',
        postal_code: '02532',
        province: 'MA',
        city: 'Buzzards Bay',
        address1: '101 Academy Drive',
        address2: '',
        email: 'warehouse@example.com',
        phone: '508-555-0100',
      },
      destination: {
        country: 'US',
        postal_code: '06103',
        province: 'CT',
        city: 'Hartford',
        address1: '1 Test Street',
        address2: '',
        name: 'Jarrett Warehouse',
        email: 'Jarrett+warehouse@episcs.com',
        phone: '860-555-0100',
      },
      items: [
        {
          name: 'Apple Crisp 6 oz',
          sku: 'AG-APPLE-6',
          quantity: 12,
          grams: 170,
          price: 799,
          vendor: 'AG Alchemy',
          requires_shipping: true,
          taxable: true,
          fulfillment_service: 'manual',
          properties: { case_pack: 12, note: 'case' },
          product_id: 48447225880,
          variant_id: 258644705304,
        },
        {
          name: 'Apple Crisp 2 oz',
          sku: 'AG-APPLE-2',
          quantity: 2,
          grams: 57,
          price: 399,
          vendor: 'AG Alchemy',
          requires_shipping: true,
          taxable: true,
          fulfillment_service: 'manual',
          properties: null,
          product_id: 48447225881,
          variant_id: 258644705305,
        },
      ],
      currency: 'usd',
      locale: 'en_US',
      order_totals: {
        subtotal_price: '10386',
        total_price: '10386',
        discount_amount: '0',
      },
      customer: {
        id: 207119551,
        tags: ['wholesale', 'VIP', 'VIP'],
        email: 'Jarrett+warehouse@episcs.com',
        phone: '860-555-0100',
      },
    },
  }
}

test('normalizes exact callback data and discards all contact fields', () => {
  const request = parseShopifyCarrierServiceRateRequest(fixture())

  assert.equal(request.currency, 'USD')
  assert.equal(request.locale, 'en-us')
  assert.equal(request.items[0]?.variantId, '258644705304')
  assert.equal(request.items[0]?.quantity, 12)
  assert.equal(request.items[0]?.grams, 170)
  assert.equal(request.items[0]?.priceMinor, 799)
  assert.deepEqual(request.customer, {
    id: '207119551',
    tags: ['VIP', 'wholesale'],
  })
  assert.equal('email' in request.destination, false)
  assert.equal('phone' in request.destination, false)
  assert.equal('name' in request.destination, false)
  assert.equal(JSON.stringify(request).includes('Jarrett+warehouse@episcs.com'), false)
  assert.match(request.items[0]?.propertiesFingerprint || '', /^[a-f0-9]{64}$/)
})

test('keeps a zero-dollar cart shippable and eligible for rating', () => {
  const zeroDollarCart = fixture()
  zeroDollarCart.rate.items = [{
    ...zeroDollarCart.rate.items[0]!,
    name: 'ClawPilot checkout-rate test product',
    quantity: 1,
    price: 0,
    requires_shipping: true,
  }]
  zeroDollarCart.rate.order_totals = {
    subtotal_price: '0',
    total_price: '0',
    discount_amount: '0',
  }

  const request = parseShopifyCarrierServiceRateRequest(zeroDollarCart)

  assert.equal(request.items.length, 1)
  assert.equal(request.items[0]?.priceMinor, 0)
  assert.equal(request.items[0]?.requiresShipping, true)
  assert.deepEqual(request.orderTotals, {
    subtotalPriceMinor: 0,
    totalPriceMinor: 0,
    discountAmountMinor: 0,
  })
  assert.match(
    fingerprintShopifyCarrierServiceRateRequest(request),
    /^[a-f0-9]{64}$/,
  )
})

test('fingerprint is canonical across line order and ephemeral contact changes', () => {
  const first = fixture()
  const second = fixture()
  second.rate.items.reverse()
  second.rate.destination.name = 'A different checkout recipient'
  second.rate.destination.email = 'different@example.com'
  second.rate.destination.phone = '212-555-9999'
  second.rate.customer.email = 'other@example.com'
  second.rate.customer.phone = '212-555-9999'
  second.rate.items[1]!.properties = { note: 'case', case_pack: 12 }
  second.rate.items[0]!.properties = null

  const firstFingerprint = fingerprintShopifyCarrierServiceRateRequest(
    parseShopifyCarrierServiceRateRequest(first),
  )
  const secondFingerprint = fingerprintShopifyCarrierServiceRateRequest(
    parseShopifyCarrierServiceRateRequest(second),
  )

  assert.equal(firstFingerprint, secondFingerprint)
  assert.match(firstFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(firstFingerprint.includes('Jarrett'), false)

  second.rate.customer.id = 207119552
  assert.notEqual(
    firstFingerprint,
    fingerprintShopifyCarrierServiceRateRequest(
      parseShopifyCarrierServiceRateRequest(second),
    ),
  )
  second.rate.customer.id = 207119551
  second.rate.items[0]!.quantity = 3
  assert.notEqual(
    firstFingerprint,
    fingerprintShopifyCarrierServiceRateRequest(
      parseShopifyCarrierServiceRateRequest(second),
    ),
  )
})

test('fingerprint coalesces progressive address enrichment within one rate zone', () => {
  const zipOnly = fixture()
  Object.assign(zipOnly.rate.destination, {
    province: null,
    city: null,
    address1: null,
    address2: null,
  })
  const fullAddress = fixture()

  assert.equal(
    SHOPIFY_CARRIER_SERVICE_FINGERPRINT_VERSION,
    'shopify-carrier-service-rate-v2',
  )
  const zipOnlyFingerprint = fingerprintShopifyCarrierServiceRateRequest(
    parseShopifyCarrierServiceRateRequest(zipOnly),
  )
  const fullAddressFingerprint = fingerprintShopifyCarrierServiceRateRequest(
    parseShopifyCarrierServiceRateRequest(fullAddress),
  )

  assert.equal(
    zipOnlyFingerprint,
    fullAddressFingerprint,
    'ZIP-only and enriched callbacks must reuse one receipt',
  )

  const differentZip = fixture()
  differentZip.rate.destination.postal_code = '06104'
  assert.notEqual(
    zipOnlyFingerprint,
    fingerprintShopifyCarrierServiceRateRequest(
      parseShopifyCarrierServiceRateRequest(differentZip),
    ),
    'a different destination rate zone must retain independent evidence',
  )

  const differentCountry = fixture()
  differentCountry.rate.destination.country = 'CA'
  assert.notEqual(
    zipOnlyFingerprint,
    fingerprintShopifyCarrierServiceRateRequest(
      parseShopifyCarrierServiceRateRequest(differentCountry),
    ),
    'a different destination country must retain independent evidence',
  )

  const differentOrigin = fixture()
  differentOrigin.rate.origin.postal_code = '02533'
  assert.notEqual(
    zipOnlyFingerprint,
    fingerprintShopifyCarrierServiceRateRequest(
      parseShopifyCarrierServiceRateRequest(differentOrigin),
    ),
    'origin changes must remain independently fenced',
  )
})

test('Shadow test allowlist requires the exact customer and every shippable test variant', () => {
  const request = parseShopifyCarrierServiceRateRequest(fixture())
  const allowlist = {
    customerIds: new Set(['207119551']),
    variantIds: new Set(['258644705304', '258644705305']),
  }
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(request, allowlist),
    true,
  )
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(request, {
      ...allowlist,
      customerIds: new Set(['2071195510']),
    }),
    false,
  )
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(request, {
      ...allowlist,
      variantIds: new Set(['258644705304']),
    }),
    false,
  )

  const noCustomer = fixture()
  ;(noCustomer.rate.destination as Record<string, unknown>).email = null
  ;(noCustomer.rate as { customer: unknown }).customer = null
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(
      parseShopifyCarrierServiceRateRequest(noCustomer),
      allowlist,
    ),
    false,
  )

  const nonShippableForeignVariant = fixture()
  nonShippableForeignVariant.rate.items[1]!.requires_shipping = false
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(
      parseShopifyCarrierServiceRateRequest(nonShippableForeignVariant),
      {
        customerIds: new Set(['207119551']),
        variantIds: new Set(['258644705304']),
      },
    ),
    true,
  )
})

test('accepts Shopify official payload shape without customer or order totals', () => {
  const officialShape = fixture()
  delete (officialShape.rate as Partial<typeof officialShape.rate>).customer
  delete (officialShape.rate as Partial<typeof officialShape.rate>).order_totals

  const request = parseShopifyCarrierServiceRateRequest(officialShape)

  assert.equal(request.customer, null)
  assert.equal(request.orderTotals, null)
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(request, {
      customerIds: new Set(['207119551']),
      variantIds: new Set(['258644705304', '258644705305']),
    }),
    false,
  )
})

test('Shadow test allowlist accepts exact resource GIDs and denies mixed variants or customer mismatch', () => {
  const allowlist = {
    customerIds: new Set(['207119551']),
    variantIds: new Set(['258644705304']),
  }
  const exactVariant = fixture()
  exactVariant.rate.items = [exactVariant.rate.items[0]!]
  exactVariant.rate.customer.id =
    'gid://shopify/Customer/207119551' as unknown as number
  exactVariant.rate.items[0]!.product_id =
    'gid://shopify/Product/48447225880' as unknown as number
  exactVariant.rate.items[0]!.variant_id =
    'gid://shopify/ProductVariant/258644705304' as unknown as number
  const normalized = parseShopifyCarrierServiceRateRequest(exactVariant)
  assert.equal(normalized.customer?.id, '207119551')
  assert.equal(normalized.items[0]?.productId, '48447225880')
  assert.equal(normalized.items[0]?.variantId, '258644705304')
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(
      normalized,
      allowlist,
    ),
    true,
  )

  const mixedVariants = fixture()
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(
      parseShopifyCarrierServiceRateRequest(mixedVariants),
      allowlist,
    ),
    false,
  )

  exactVariant.rate.customer.id = 'gid://shopify/Customer/207119552' as unknown as number
  assert.equal(
    shopifyCarrierServiceRequestMatchesTestAllowlist(
      parseShopifyCarrierServiceRateRequest(exactVariant),
      allowlist,
    ),
    false,
  )
})

test('rejects wrong-resource and malformed identifiers at a safe schema path', () => {
  const wrongResourceGid = fixture()
  wrongResourceGid.rate.items[0]!.variant_id =
    'gid://shopify/Product/258644705304' as unknown as number

  let failure: unknown
  try {
    parseShopifyCarrierServiceRateRequest(wrongResourceGid)
  } catch (error) {
    failure = error
  }

  assert.ok(failure instanceof ShopifyCarrierServiceProtocolError)
  assert.equal(failure.code, 'SHOPIFY_CARRIER_IDENTIFIER_INVALID')
  assert.equal(
    safeShopifyCarrierServiceProtocolErrorPath(failure),
    '$.rate.items[0].variant_id',
  )

  const wrongCustomerGid = fixture()
  wrongCustomerGid.rate.customer.id =
    'gid://shopify/Product/207119551' as unknown as number
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(wrongCustomerGid),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_IDENTIFIER_INVALID'
      && safeShopifyCarrierServiceProtocolErrorPath(error)
        === '$.rate.customer.id',
  )

  const leadingZero = fixture()
  leadingZero.rate.items[0]!.product_id = '048447225880' as unknown as number
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(leadingZero),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_IDENTIFIER_INVALID'
      && safeShopifyCarrierServiceProtocolErrorPath(error)
        === '$.rate.items[0].product_id',
  )

  const unsafePropertyPath = new ShopifyCarrierServiceProtocolError(
    'redacted',
    'SHOPIFY_CARRIER_PROPERTIES_INVALID',
    '$.rate.items[0].properties.customer_email',
  )
  assert.equal(
    safeShopifyCarrierServiceProtocolErrorPath(unsafePropertyPath),
    '$.rate.items[0].properties',
  )
  assert.equal(
    safeShopifyCarrierServiceProtocolErrorPath(new Error('not protocol')),
    null,
  )
})

test('fails closed on fractional, unsafe, negative, or unbounded item data', () => {
  const fractional = fixture()
  fractional.rate.items[0]!.quantity = 1.5
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(fractional),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_INTEGER_OUT_OF_RANGE',
  )

  const negativeWeight = fixture()
  negativeWeight.rate.items[0]!.grams = -1
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(negativeWeight),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.path.endsWith('.grams'),
  )

  const unsafeIdentifier = fixture()
  unsafeIdentifier.rate.items[0]!.variant_id = Number.MAX_SAFE_INTEGER + 1
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(unsafeIdentifier),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_IDENTIFIER_INVALID',
  )

  const tooManyLines = fixture()
  tooManyLines.rate.items = Array.from(
    { length: 251 },
    () => ({ ...fixture().rate.items[0] }),
  )
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(tooManyLines),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_ITEMS_INVALID',
  )

  const quantityBeyondPersistence = fixture()
  quantityBeyondPersistence.rate.items[0]!.quantity = 100_001
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(
      quantityBeyondPersistence,
    ),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.path.endsWith('.quantity'),
  )

  const weightBeyondPersistence = fixture()
  weightBeyondPersistence.rate.items[0]!.grams = 1_000_001
  assert.throws(
    () => parseShopifyCarrierServiceRateRequest(weightBeyondPersistence),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.path.endsWith('.grams'),
  )
})

test('streams callback JSON within the hard request byte limit', async () => {
  const request = new Request('https://example.com/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fixture()),
  })
  const parsed = await readShopifyCarrierServiceRateRequest(request)
  assert.equal(parsed.items.length, 2)

  const tooLarge = new Request('https://example.com/callback', {
    method: 'POST',
    body: 'x'.repeat(SHOPIFY_CARRIER_SERVICE_MAX_REQUEST_BYTES + 1),
  })
  await assert.rejects(
    readShopifyCarrierServiceRateRequest(tooLarge),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_REQUEST_TOO_LARGE',
  )

  const malformed = new Request('https://example.com/callback', {
    method: 'POST',
    body: '{"rate":',
  })
  await assert.rejects(
    readShopifyCarrierServiceRateRequest(malformed),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_REQUEST_INVALID',
  )
})

test('cancels a stalled callback body at the shared deadline', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const request = new Request('https://example.com/callback', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const controller = new AbortController()
  const pending = readShopifyCarrierServiceRateRequest(request, {
    signal: controller.signal,
  })

  controller.abort()

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_REQUEST_ABORTED',
  )
  assert.equal(cancelled, true)
})

test('builds Shopify rates with stable codes and exact minor amounts', () => {
  const response = buildShopifyCarrierServiceRateResponse([
    {
      carrierCode: 'fedex',
      serviceLevelCode: 'ground',
      serviceName: 'FedEx Ground',
      description: 'Ground delivery with tracking',
      amountMinor: BigInt(1962),
      currency: 'USD',
      phoneRequired: false,
      minDeliveryDate: '2026-07-30T12:00:00-04:00',
      maxDeliveryDate: new Date('2026-08-03T16:00:00Z'),
    },
  ])

  assert.deepEqual(response, {
    rates: [
      {
        service_name: 'FedEx Ground',
        service_code: 'clawpilot:fedex:ground',
        total_price: '1962',
        description: 'Ground delivery with tracking',
        currency: 'USD',
        phone_required: false,
        min_delivery_date: '2026-07-30T16:00:00.000Z',
        max_delivery_date: '2026-08-03T16:00:00.000Z',
      },
    ],
  })
})

test('rejects unstable codes, duplicate services, fractional money, and invalid dates', () => {
  assert.throws(
    () => buildShopifyCarrierServiceRateResponse([
      {
        carrierCode: 'fedex',
        serviceLevelCode: 'ground/2026-07-29',
        serviceName: 'FedEx Ground',
        description: 'Ground delivery',
        amountMinor: 100,
        currency: 'USD',
      },
    ]),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_SERVICE_CODE_INVALID',
  )

  assert.throws(
    () => buildShopifyCarrierServiceRateResponse([
      {
        carrierCode: 'ups',
        serviceLevelCode: 'ground',
        serviceName: 'UPS Ground',
        description: 'Ground delivery',
        amountMinor: 100,
        currency: 'USD',
      },
      {
        carrierCode: 'ups',
        serviceLevelCode: 'ground',
        serviceName: 'UPS Ground duplicate',
        description: 'Ground delivery',
        amountMinor: 200,
        currency: 'USD',
      },
    ]),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_SERVICE_CODE_DUPLICATE',
  )

  assert.throws(
    () => buildShopifyCarrierServiceRateResponse([
      {
        carrierCode: 'ups',
        serviceLevelCode: 'ground',
        serviceName: 'UPS Ground',
        description: 'Ground delivery',
        amountMinor: 10.5,
        currency: 'USD',
      },
    ]),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && error.code === 'SHOPIFY_CARRIER_AMOUNT_INVALID',
  )

  assert.throws(
    () => buildShopifyCarrierServiceRateResponse([
      {
        carrierCode: 'ups',
        serviceLevelCode: 'ground',
        serviceName: 'UPS Ground',
        description: 'Ground delivery',
        amountMinor: 100,
        currency: 'usd',
        minDeliveryDate: '2026-08-04T00:00:00Z',
        maxDeliveryDate: '2026-08-03T00:00:00Z',
      },
    ]),
    (error: unknown) =>
      error instanceof ShopifyCarrierServiceProtocolError
      && (
        error.code === 'SHOPIFY_CARRIER_CURRENCY_INVALID'
        || error.code === 'SHOPIFY_CARRIER_DELIVERY_RANGE_INVALID'
      ),
  )
})
