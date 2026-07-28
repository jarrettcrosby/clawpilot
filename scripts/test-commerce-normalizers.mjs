#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, mocks = {}) {
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter((diagnostic) => (
    diagnostic.category === ts.DiagnosticCategory.Error
  ))
  assert.equal(
    errors.length,
    0,
    errors.map((diagnostic) => (
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    )).join('\n'),
  )
  const loadedModule = { exports: {} }
  const sandbox = {
    BigInt,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    TextEncoder,
    console,
    exports: loadedModule.exports,
    module: loadedModule,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(result.outputText, sandbox, { filename: path })
  return loadedModule.exports
}

const commonPath = 'app_src/lib/operations/commerceNormalization.ts'
const shopifyPath =
  'app_src/lib/integrations/shopifyCommerceNormalizer.ts'
const fairePath = 'app_src/lib/integrations/faireCommerceNormalizer.ts'
const common = loadTypeScriptModule(commonPath)
const moduleMocks = {
  '@/lib/operations/commerceNormalization': common,
}
const shopify = loadTypeScriptModule(shopifyPath, moduleMocks)
const faire = loadTypeScriptModule(fairePath, moduleMocks)

const observedAt = '2026-07-27T12:00:00.000Z'
const retentionExpiresAt = '2026-07-28T12:00:00.000Z'
const baseContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  integrationAccountId: '22222222-2222-4222-8222-222222222222',
  apiVersion: '2026-07',
  observedAt,
  credentialGeneration: 3,
  retentionExpiresAt,
  sourceState: 'current',
}

function moneyBag(amount, currency = 'USD') {
  return {
    shopMoney: { amount, currencyCode: currency },
    presentmentMoney: { amount, currencyCode: currency },
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const packaging = {
  weightGrams: 125,
  dimensionsMm: {
    length: 200,
    width: 100,
    height: 50,
  },
}

const shopifySource = {
  shopDomain: 'ag-alchemy.myshopify.com',
  products: {
    nodes: [{
      id: 'gid://shopify/Product/100',
      title: 'Alchemy Bar',
      description: 'Wholesale snack',
      vendor: 'AG Alchemy',
      productType: 'Snack Bars',
      status: 'ACTIVE',
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-26T10:00:00Z',
      variants: {
        nodes: [{
          id: 'gid://shopify/ProductVariant/101',
          sku: 'BAR-CaseSensitive',
          barcode: '012345678901',
          title: 'Original',
          selectedOptions: [{ name: 'Flavor', value: 'Original' }],
          price: '4.97',
          compareAtPrice: '6.00',
          taxable: true,
          inventoryQuantity: 0,
          inventoryItem: {
            id: 'gid://shopify/InventoryItem/102',
            requiresShipping: true,
            measurement: {
              weight: { value: 0.125, unit: 'KILOGRAMS' },
            },
          },
          packaging,
          createdAt: '2026-07-01T10:00:00Z',
          updatedAt: '2026-07-26T10:00:00Z',
        }],
      },
    }],
  },
  orders: {
    nodes: [{
      id: 'gid://shopify/Order/200',
      name: '1001',
      createdAt: '2026-07-26T11:00:00Z',
      processedAt: '2026-07-26T11:01:00Z',
      updatedAt: '2026-07-26T11:02:00Z',
      cancelledAt: null,
      closedAt: null,
      status: 'OPEN',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      returnStatus: 'NO_RETURN',
      sourceName: 'web',
      test: false,
      currencyCode: 'USD',
      currentSubtotalPriceSet: moneyBag('9.94'),
      currentShippingPriceSet: moneyBag('0.11'),
      currentTotalTaxSet: moneyBag('0.00'),
      currentTotalDiscountsSet: moneyBag('0.00'),
      currentTotalPriceSet: moneyBag('10.05'),
      customer: {
        id: 'gid://shopify/Customer/300',
        firstName: 'Ada',
        lastName: 'Buyer',
        displayName: 'Ada Buyer',
        defaultEmailAddress: { emailAddress: 'ada@example.test' },
        defaultPhoneNumber: { phoneNumber: '+15555550100' },
      },
      email: 'ada@example.test',
      phone: '+15555550100',
      shippingLine: {
        code: 'GROUND',
        title: 'Ground shipping',
        deliveryCategory: 'SHIPPING',
      },
      shippingAddress: {
        name: 'Ada Buyer',
        company: 'Retail House',
        address1: '10 Market Street',
        address2: 'Suite 2',
        city: 'Brooklyn',
        province: 'New York',
        provinceCode: 'NY',
        zip: '11201',
        country: 'United States',
        countryCodeV2: 'US',
        phone: '+15555550100',
      },
      requestedDeliveryAt: '2026-08-01T15:00:00Z',
      lineItems: {
        nodes: [{
          id: 'gid://shopify/LineItem/201',
          product: { id: 'gid://shopify/Product/100' },
          variant: { id: 'gid://shopify/ProductVariant/101' },
          sku: 'BAR-CaseSensitive',
          title: 'Alchemy Bar',
          variantTitle: 'Original',
          vendor: 'AG Alchemy',
          quantity: 2,
          currentQuantity: 2,
          unfulfilledQuantity: 2,
          originalUnitPriceSet: moneyBag('4.97'),
          originalTotalSet: moneyBag('9.94'),
          discountedTotalSet: moneyBag('9.94'),
          totalDiscountSet: moneyBag('0.00'),
          unfulfilledOriginalTotalSet: moneyBag('9.94'),
          unfulfilledDiscountedTotalSet: moneyBag('9.94'),
          taxLines: [{
            title: 'Tax',
            priceSet: moneyBag('0.00'),
          }],
          requiresShipping: true,
        }],
        pageInfo: { hasNextPage: false },
      },
    }],
  },
}

const faireSource = {
  brand: {
    id: 'brand-1',
    currency: 'USD',
  },
  products: [{
    id: 'product-100',
    brand_id: 'brand-1',
    name: 'Alchemy Bar',
    description: 'Wholesale snack',
    brand_name: 'AG Alchemy',
    taxonomy_type: {
      id: 'taxonomy-snack-bars',
      name: 'Snack Bars',
    },
    lifecycle_state: 'PUBLISHED',
    active: true,
    currency: 'USD',
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-26T10:00:00Z',
    variants: [{
      id: 'variant-101',
      sku: 'BAR-CaseSensitive',
      gtin: '012345678901',
      name: 'Original',
      options: [{ name: 'Flavor', value: 'Original' }],
      prices: [{
        geo_constraint: { country: 'CAN' },
        wholesale_price: {
          amount_minor: 699,
          currency: 'CAD',
        },
        retail_price: {
          amount_minor: 899,
          currency: 'CAD',
        },
      }, {
        geo_constraint: { country: 'USA' },
        wholesale_price: {
          amount_minor: 497,
          currency: 'USD',
        },
        retail_price: {
          amount_minor: 600,
          currency: 'USD',
        },
      }],
      inventory_quantity: 0,
      unit_multiplier: 1,
      case_measurements: {
        mass_unit: 'GRAMS',
        weight: 125,
        distance_unit: 'MILLIMETERS',
        length: 200,
        width: 100,
        height: 50,
      },
      created_at: '2026-07-01T10:00:00Z',
      updated_at: '2026-07-26T10:00:00Z',
    }],
  }],
  orders: [{
    id: 'order-200',
    display_id: '1001',
    brand_id: 'brand-1',
    retailer_id: 'retailer-300',
    created_at: '2026-07-26T11:00:00Z',
    processing_at: '2026-07-26T11:01:00Z',
    updated_at: '2026-07-26T11:02:00Z',
    state: 'NEW',
    payment_state: 'PAID',
    fulfillment_state: 'NEW',
    return_state: 'NO_RETURN',
    currency: 'USD',
    subtotal_cents: 994,
    shipping_cents: 11,
    tax_cents: 0,
    total_discount_cents: 0,
    total_cents: 1005,
    brand_discounts: [{ amount_cents: 0, currency: 'USD' }],
    payout_costs: {
      maker_cost_cents: 1005,
      currency: 'USD',
      state: 'PENDING',
    },
    customer: {
      company_name: 'Retail House',
      first_name: 'Ada',
      last_name: 'Buyer',
      email: 'ada@example.test',
      phone_number: '+15555550100',
    },
    address: {
      name: 'Ada Buyer',
      company: 'Retail House',
      address1: '10 Market Street',
      address2: 'Suite 2',
      city: 'Brooklyn',
      state: 'New York',
      state_code: 'NY',
      postal_code: '11201',
      country: 'United States',
      country_code: 'US',
      phone_number: '+15555550100',
    },
    ship_after: '2026-08-01T15:00:00Z',
    items: [{
      id: 'item-201',
      product_id: 'product-100',
      product_variant_id: 'variant-101',
      sku: 'BAR-CaseSensitive',
      product_name: 'Alchemy Bar',
      variant_name: 'Original',
      brand_name: 'AG Alchemy',
      quantity: 2,
      unit_multiplier: 1,
      price_cents: 497,
      subtotal_cents: 994,
      discount_cents: 0,
      tax_cents: 0,
      requires_shipping: true,
    }],
  }],
}

const shopifyNormalized = shopify.normalizeShopifyCommerce(
  shopifySource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
const faireNormalized = faire.normalizeFaireCommerce(
  faireSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
const fairePageWrapped = faire.normalizeFaireCommerce({
  brand: clone(faireSource.brand),
  products: {
    products: clone(faireSource.products),
    cursor: 'products-page-2',
  },
  orders: {
    orders: clone(faireSource.orders),
    cursor: 'orders-page-2',
  },
}, {
  ...baseContext,
  externalAccountId: 'brand-1',
  apiVersion: 'external-api-v2',
})

assert.equal(shopifyNormalized.rejections.length, 0)
assert.equal(faireNormalized.rejections.length, 0)
for (const lifecycle of ['DRAFT', 'ARCHIVED', 'UNLISTED']) {
  const source = clone(shopifySource)
  source.products.nodes[0].status = lifecycle
  const normalized = shopify.normalizeShopifyCommerce(source, {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  })
  assert.equal(normalized.products.length, 1)
  assert.equal(normalized.products[0].lifecycleState, lifecycle)
  assert.equal(normalized.products[0].active, false)
}
for (const lifecycle of ['DRAFT', 'ARCHIVED', 'UNAVAILABLE']) {
  const source = clone(faireSource)
  source.products[0].lifecycle_state = lifecycle
  source.products[0].active = false
  const normalized = faire.normalizeFaireCommerce(source, {
    ...baseContext,
    externalAccountId: 'brand-1',
  })
  assert.equal(normalized.products.length, 1)
  assert.equal(normalized.products[0].lifecycleState, lifecycle)
  assert.equal(normalized.products[0].active, false)
}
for (const normalized of [shopifyNormalized, faireNormalized]) {
  assert.deepEqual(headerMoneyProjection(normalized.orders[0]), {
    state: 'complete',
    unavailableFields: [],
    fulfillmentDemandEligible: true,
    accountingEligible: true,
    customerChargeEligible: true,
  })
}

function availableValue(field) {
  assert.equal(field.state, 'available')
  return field.value
}

function textValue(field) {
  return field.state === 'available' ? field.value : null
}

function moneyValue(field) {
  return field.state === 'available'
    ? `${field.value.primary.amountMinor}:${field.value.primary.currency}`
    : field.state
}

function headerMoneyProjection(order) {
  return {
    state: order.headerMoney.state,
    unavailableFields: [...order.headerMoney.unavailableFields],
    fulfillmentDemandEligible:
      order.headerMoney.fulfillmentDemandEligible,
    accountingEligible: order.headerMoney.accountingEligible,
    customerChargeEligible: order.headerMoney.customerChargeEligible,
  }
}

const faireExternalOrderV2Source = clone(faireSource)
delete faireExternalOrderV2Source.brand.currency
const faireExternalOrderV2 = faireExternalOrderV2Source.orders[0]
delete faireExternalOrderV2.currency
delete faireExternalOrderV2.subtotal_cents
delete faireExternalOrderV2.shipping_cents
delete faireExternalOrderV2.tax_cents
delete faireExternalOrderV2.total_discount_cents
delete faireExternalOrderV2.total_cents
faireExternalOrderV2.is_free_shipping = true
faireExternalOrderV2.brand_discounts = [{
  id: 'bpc-brand-50',
  discount_type: 'FLAT_AMOUNT',
  discount_amount: {
    amount_minor: 50,
    currency: 'USD',
  },
}]
faireExternalOrderV2.payout_costs = {
  subtotal_after_brand_discounts: {
    amount_minor: 900,
    currency: 'USD',
  },
  total_brand_discounts: {
    amount_minor: 94,
    currency: 'USD',
  },
  net_tax: {
    amount_minor: 50,
    currency: 'USD',
  },
  total_payout: {
    amount_minor: 700,
    currency: 'USD',
  },
}
const faireExternalOrderV2Line = faireExternalOrderV2.items[0]
delete faireExternalOrderV2Line.price_cents
delete faireExternalOrderV2Line.subtotal_cents
delete faireExternalOrderV2Line.discount_cents
delete faireExternalOrderV2Line.tax_cents
faireExternalOrderV2Line.price = {
  amount_minor: 497,
  currency: 'USD',
}
faireExternalOrderV2Line.discounts = [{
  discount_amount: {
    amount_minor: 44,
    currency: 'USD',
  },
}]

const faireExternalOrderV2Normalized = faire.normalizeFaireCommerce(
  faireExternalOrderV2Source,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  faireExternalOrderV2Normalized.rejections.length,
  0,
  'Current ExternalOrderV2 nested Money fields must normalize',
)
assert.equal(faireExternalOrderV2Normalized.orders.length, 1)
const faireExternalOrderV2NormalizedOrder =
  faireExternalOrderV2Normalized.orders[0]
assert.equal(faireExternalOrderV2NormalizedOrder.currency, 'USD')
assert.deepEqual(
  {
    subtotal: moneyValue(faireExternalOrderV2NormalizedOrder.subtotal),
    shipping: moneyValue(faireExternalOrderV2NormalizedOrder.shipping),
    tax: moneyValue(faireExternalOrderV2NormalizedOrder.tax),
    discount: moneyValue(faireExternalOrderV2NormalizedOrder.discount),
    total: moneyValue(faireExternalOrderV2NormalizedOrder.total),
  },
  {
    subtotal: '994:USD',
    shipping: '0:USD',
    tax: '50:USD',
    discount: '94:USD',
    total: '950:USD',
  },
)
assert.deepEqual(
  {
    unitPrice: moneyValue(
      faireExternalOrderV2NormalizedOrder.lines[0].unitPrice,
    ),
    lineSubtotal: moneyValue(
      faireExternalOrderV2NormalizedOrder.lines[0].lineSubtotal,
    ),
    lineDiscount: moneyValue(
      faireExternalOrderV2NormalizedOrder.lines[0].lineDiscount,
    ),
    brandDiscount: moneyValue(
      faireExternalOrderV2NormalizedOrder.providerFacts.brandDiscount,
    ),
    lineDiscountTotal: moneyValue(
      faireExternalOrderV2NormalizedOrder.providerFacts.lineDiscountTotal,
    ),
    payout: moneyValue(
      faireExternalOrderV2NormalizedOrder.providerFacts.payoutAmount,
    ),
  },
  {
    unitPrice: '497:USD',
    lineSubtotal: '994:USD',
    lineDiscount: '44:USD',
    brandDiscount: '50:USD',
    lineDiscountTotal: '44:USD',
    payout: '700:USD',
  },
)
assert.equal(
  faireExternalOrderV2Normalized.normalizerVersion,
  'faire-commerce-normalizer-v3',
)
assert.deepEqual(
  headerMoneyProjection(faireExternalOrderV2NormalizedOrder),
  {
    state: 'complete',
    unavailableFields: [],
    fulfillmentDemandEligible: true,
    accountingEligible: true,
    customerChargeEligible: true,
  },
)

const faireExternalOrderV2TesterSource = clone(faireExternalOrderV2Source)
const faireExternalOrderV2TesterOrder =
  faireExternalOrderV2TesterSource.orders[0]
faireExternalOrderV2TesterOrder.id = 'order-v2-tester'
faireExternalOrderV2TesterOrder.display_id = 'V2-TESTER'
faireExternalOrderV2TesterOrder.payout_costs
  .subtotal_after_brand_discounts.amount_minor = 1_023
faireExternalOrderV2TesterOrder.items[0].includes_tester = true
faireExternalOrderV2TesterOrder.items[0].tester_price = {
  amount_minor: 123,
  currency: 'USD',
}
const faireExternalOrderV2Tester = faire.normalizeFaireCommerce(
  faireExternalOrderV2TesterSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(faireExternalOrderV2Tester.rejections.length, 0)
assert.equal(
  moneyValue(faireExternalOrderV2Tester.orders[0].lines[0].lineSubtotal),
  '1117:USD',
  'A Faire tester is one separately priced addition to the merchandise subtotal',
)

const faireExternalOrderV2MissingTesterSource =
  clone(faireExternalOrderV2TesterSource)
faireExternalOrderV2MissingTesterSource.orders[0].id =
  'order-v2-missing-tester-price'
faireExternalOrderV2MissingTesterSource.orders[0].display_id =
  'V2-MISSING-TESTER-PRICE'
delete faireExternalOrderV2MissingTesterSource.orders[0].items[0].tester_price
const faireExternalOrderV2MissingTester = faire.normalizeFaireCommerce(
  faireExternalOrderV2MissingTesterSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(faireExternalOrderV2MissingTester.orders.length, 0)
assertSafeRejection(faireExternalOrderV2MissingTester.rejections[0], {
  resourceType: 'order',
  errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
  externalId: 'order-v2-missing-tester-price',
})

const faireExternalOrderV2NoneDiscountSource =
  clone(faireExternalOrderV2Source)
faireExternalOrderV2NoneDiscountSource.orders[0].brand_discounts = [
  {
    id: 'bpc-free-shipping',
    discount_type: 'NONE',
    includes_free_shipping: true,
  },
  ...faireExternalOrderV2Source.orders[0].brand_discounts,
]
faireExternalOrderV2NoneDiscountSource.orders[0].items[0].discounts = [
  {
    id: 'bpc-line-none',
    discount_type: 'NONE',
    includes_free_shipping: true,
  },
  ...faireExternalOrderV2Source.orders[0].items[0].discounts,
]
const faireExternalOrderV2NoneDiscount = faire.normalizeFaireCommerce(
  faireExternalOrderV2NoneDiscountSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  moneyValue(
    faireExternalOrderV2NoneDiscount.orders[0].providerFacts.brandDiscount,
  ),
  '50:USD',
  'A NONE promotion contributes exact zero to monetary discounts',
)
assert.equal(
  moneyValue(
    faireExternalOrderV2NoneDiscount.orders[0]
      .providerFacts.lineDiscountTotal,
  ),
  '44:USD',
)

const faireExternalOrderV2PercentageDiscountSource =
  clone(faireExternalOrderV2Source)
faireExternalOrderV2PercentageDiscountSource.orders[0].brand_discounts = [{
  id: 'bpc-brand-percent',
  discount_type: 'PERCENTAGE',
  discount_percentage: 10,
}]
faireExternalOrderV2PercentageDiscountSource.orders[0].items[0].discounts = [{
  id: 'bpc-line-percent',
  discount_type: 'PERCENTAGE',
  discount_percentage: 10,
}]
const faireExternalOrderV2PercentageDiscount = faire.normalizeFaireCommerce(
  faireExternalOrderV2PercentageDiscountSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  moneyValue(
    faireExternalOrderV2PercentageDiscount.orders[0]
      .providerFacts.brandDiscount,
  ),
  'unavailable',
  'A percentage without an exact amount must not become inferred money',
)
assert.equal(
  moneyValue(
    faireExternalOrderV2PercentageDiscount.orders[0].lines[0].lineDiscount,
  ),
  'unavailable',
)
assert.equal(
  moneyValue(
    faireExternalOrderV2PercentageDiscount.orders[0]
      .providerFacts.lineDiscountTotal,
  ),
  'unavailable',
)

const faireExternalOrderV2MixedDiscountSource =
  clone(faireExternalOrderV2Source)
faireExternalOrderV2MixedDiscountSource.orders[0].brand_discounts.push({
  id: 'bpc-brand-percent',
  discount_type: 'PERCENTAGE',
  discount_percentage: 10,
})
faireExternalOrderV2MixedDiscountSource.orders[0].items[0].discounts.push({
  id: 'bpc-line-percent',
  discount_type: 'PERCENTAGE',
  discount_percentage: 10,
})
const faireExternalOrderV2MixedDiscount = faire.normalizeFaireCommerce(
  faireExternalOrderV2MixedDiscountSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  moneyValue(
    faireExternalOrderV2MixedDiscount.orders[0]
      .providerFacts.brandDiscount,
  ),
  'unavailable',
  'Mixed exact and inexact discounts must not expose a partial exact sum',
)
assert.equal(
  moneyValue(
    faireExternalOrderV2MixedDiscount.orders[0].lines[0].lineDiscount,
  ),
  'unavailable',
)
assert.equal(
  moneyValue(
    faireExternalOrderV2MixedDiscount.orders[0]
      .providerFacts.lineDiscountTotal,
  ),
  'unavailable',
)

const faireExternalOrderV2HeaderSource = clone(faireExternalOrderV2Source)
Object.assign(faireExternalOrderV2HeaderSource.orders[0], {
  subtotal_cents: 1_100,
  shipping_cents: 75,
  tax_cents: 60,
  total_discount_cents: 100,
  total_cents: 1_135,
})
const faireExternalOrderV2HeaderNormalized = faire.normalizeFaireCommerce(
  faireExternalOrderV2HeaderSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.deepEqual(
  {
    subtotal: moneyValue(
      faireExternalOrderV2HeaderNormalized.orders[0].subtotal,
    ),
    shipping: moneyValue(
      faireExternalOrderV2HeaderNormalized.orders[0].shipping,
    ),
    tax: moneyValue(faireExternalOrderV2HeaderNormalized.orders[0].tax),
    discount: moneyValue(
      faireExternalOrderV2HeaderNormalized.orders[0].discount,
    ),
    total: moneyValue(faireExternalOrderV2HeaderNormalized.orders[0].total),
  },
  {
    subtotal: '1100:USD',
    shipping: '75:USD',
    tax: '60:USD',
    discount: '100:USD',
    total: '1135:USD',
  },
  'Explicit header totals must take precedence over derived V2 payout facts',
)

const faireExternalOrderV2PaidShippingSource =
  clone(faireExternalOrderV2Source)
faireExternalOrderV2PaidShippingSource.orders[0].id = 'order-v2-paid-shipping'
faireExternalOrderV2PaidShippingSource.orders[0].display_id = 'V2-PAID-SHIPPING'
faireExternalOrderV2PaidShippingSource.orders[0].is_free_shipping = false
faireExternalOrderV2PaidShippingSource.orders[0]
  .payout_costs.shipping_subsidy = {
    amount_minor: 0,
    currency: 'USD',
  }
const faireExternalOrderV2PaidShipping = faire.normalizeFaireCommerce(
  faireExternalOrderV2PaidShippingSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(faireExternalOrderV2PaidShipping.orders.length, 1)
assert.equal(faireExternalOrderV2PaidShipping.rejections.length, 0)
const fairePaidShippingOrder = faireExternalOrderV2PaidShipping.orders[0]
assert.deepEqual(
  {
    subtotal: moneyValue(fairePaidShippingOrder.subtotal),
    discount: moneyValue(fairePaidShippingOrder.discount),
    shipping: moneyValue(fairePaidShippingOrder.shipping),
    tax: moneyValue(fairePaidShippingOrder.tax),
    total: moneyValue(fairePaidShippingOrder.total),
  },
  {
    subtotal: '994:USD',
    discount: '94:USD',
    shipping: 'unavailable',
    tax: '50:USD',
    total: 'unavailable',
  },
  'Faire shipping subsidy is not retailer shipping or an order total',
)
assert.deepEqual(
  headerMoneyProjection(fairePaidShippingOrder),
  {
    state: 'operational_incomplete',
    unavailableFields: ['shipping', 'total'],
    fulfillmentDemandEligible: true,
    accountingEligible: false,
    customerChargeEligible: false,
  },
)

function addressProjection(field) {
  const address = availableValue(field)
  return {
    name: textValue(address.name),
    organizationName: textValue(address.organizationName),
    line1: textValue(address.line1),
    line2: textValue(address.line2),
    city: textValue(address.city),
    region: textValue(address.region),
    regionCode: textValue(address.regionCode),
    postalCode: textValue(address.postalCode),
    country: textValue(address.country),
    countryCode: textValue(address.countryCode),
    phone: textValue(address.phone),
  }
}

function productSemanticProjection(envelope) {
  const product = envelope.products[0]
  return {
    title: product.title,
    description: product.description,
    active: product.active,
    variants: product.variants.map((variant) => {
      const inventory = availableValue(variant.inventory)
      const packageSnapshot = availableValue(variant.packaging)
      return {
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.title,
        wholesalePrice: moneyValue(variant.wholesalePrice),
        retailPrice: moneyValue(variant.retailPrice),
        inventory: {
          quantity: inventory.quantity,
          name: inventory.name,
        },
        packaging: {
          weightGrams: packageSnapshot.weightGrams,
          lengthMillimeters: packageSnapshot.lengthMillimeters,
          widthMillimeters: packageSnapshot.widthMillimeters,
          heightMillimeters: packageSnapshot.heightMillimeters,
        },
      }
    }),
  }
}

function orderSemanticProjection(envelope) {
  const order = envelope.orders[0]
  const party = availableValue(order.party)
  return {
    orderNumber: order.orderNumber,
    providerCreatedAt: order.providerCreatedAt,
    providerProcessedAt: order.providerProcessedAt,
    providerUpdatedAt: order.providerUpdatedAt,
    canonicalStates: {
      lifecycle: order.canonicalStates.lifecycle,
      payment: order.canonicalStates.payment,
      fulfillment: order.canonicalStates.fulfillment,
      returns: order.canonicalStates.returns,
    },
    currency: order.currency,
    subtotal: moneyValue(order.subtotal),
    shipping: moneyValue(order.shipping),
    tax: moneyValue(order.tax),
    discount: moneyValue(order.discount),
    total: moneyValue(order.total),
    party: {
      partyType: party.partyType,
      organizationName: textValue(party.organizationName),
      contactName: textValue(party.contactName),
      email: textValue(party.email),
      phone: textValue(party.phone),
    },
    shipTo: addressProjection(order.shipTo),
    requestedDeliveryAt: textValue(order.requestedDeliveryAt),
    lines: order.lines.map((line) => ({
      sku: line.sku,
      titleSnapshot: line.titleSnapshot,
      variantTitleSnapshot: line.variantTitleSnapshot,
      vendorSnapshot: line.vendorSnapshot,
      orderedQuantity: line.orderedQuantity,
      physicalUnitQuantity: line.physicalUnitQuantity,
      unitPrice: moneyValue(line.unitPrice),
      lineSubtotal: moneyValue(line.lineSubtotal),
      lineDiscount: moneyValue(line.lineDiscount),
      lineTax: moneyValue(line.lineTax),
      requiresShipping: line.requiresShipping,
      packagingState: line.packaging.state,
    })),
    readiness: order.readinessFacts.map((fact) => ({
      dimension: fact.dimension,
      code: fact.code,
      blocking: fact.blocking,
    })),
  }
}

assert.deepEqual(
  orderSemanticProjection(shopifyNormalized),
  orderSemanticProjection(faireNormalized),
  'Equivalent Shopify and Faire orders must normalize to semantic parity',
)
assert.deepEqual(
  productSemanticProjection(shopifyNormalized),
  productSemanticProjection(faireNormalized),
  'Equivalent Shopify and Faire products must normalize to semantic parity',
)

assert.equal(
  shopifyNormalized.products[0].identity.value,
  'gid://shopify/Product/100',
)
assert.equal(
  shopifyNormalized.products[0].variants[0].identity.value,
  'gid://shopify/ProductVariant/101',
)
assert.equal(shopifyNormalized.products[0].vendor, 'AG Alchemy')
assert.equal(shopifyNormalized.products[0].productType, 'Snack Bars')
assert.deepEqual(
  clone(shopifyNormalized.products[0].variants[0].selectedOptions),
  [{ name: 'Flavor', value: 'Original' }],
)
assert.equal(
  shopifyNormalized.products[0].variants[0].inventoryItemIdentity.value.value,
  'gid://shopify/InventoryItem/102',
)
assert.equal(shopifyNormalized.products[0].variants[0].taxable, true)
assert.equal(shopifyNormalized.products[0].variants[0].requiresShipping, true)
assert.equal(shopifyNormalized.products[0].variants[0].weightGrams, 125)
assert.equal(
  moneyValue(shopifyNormalized.products[0].variants[0].wholesalePrice),
  '497:USD',
  'Shopify Money scalars must use the exact shop/order currency',
)
assert.equal(faireNormalized.products[0].vendor, 'AG Alchemy')
assert.equal(faireNormalized.products[0].productType, 'Snack Bars')
assert.deepEqual(
  clone(faireNormalized.products[0].variants[0].selectedOptions),
  [{ name: 'Flavor', value: 'Original' }],
)
assert.equal(
  moneyValue(faireNormalized.products[0].variants[0].wholesalePrice),
  '497:USD',
  'Faire V2 prices must resolve by shop currency, not array order',
)
assert.equal(
  moneyValue(faireNormalized.products[0].variants[0].retailPrice),
  '600:USD',
)
assert.equal(faireNormalized.products[0].variants[0].taxable, null)
assert.equal(faireNormalized.products[0].variants[0].requiresShipping, null)
assert.equal(faireNormalized.products[0].variants[0].weightGrams, 125)
assert.equal(
  shopifyNormalized.orders[0].lines[0].variantIdentity.value.value,
  'gid://shopify/ProductVariant/101',
)
assert.deepEqual(
  {
    current: shopifyNormalized.orders[0].lines[0].currentQuantity,
    cancelled: shopifyNormalized.orders[0].lines[0].cancelledQuantity,
    fulfilled: shopifyNormalized.orders[0].lines[0].fulfilledQuantity,
    unfulfilled: shopifyNormalized.orders[0].lines[0].unfulfilledQuantity,
    returned: shopifyNormalized.orders[0].lines[0].returnedQuantity,
    removedOrRefunded:
      shopifyNormalized.orders[0].lines[0].removedOrRefundedQuantity,
  },
  {
    current: 2,
    cancelled: 0,
    fulfilled: 0,
    unfulfilled: 2,
    returned: null,
    removedOrRefunded: 0,
  },
)
assert.deepEqual(
  clone(shopifyNormalized.orders[0].providerFacts.shippingService),
  {
    code: 'GROUND',
    title: 'Ground shipping',
    deliveryCategory: 'SHIPPING',
  },
)
const orderSnapshotPartySource = clone(shopifySource)
delete orderSnapshotPartySource.orders.nodes[0].customer
const orderSnapshotParty = shopify.normalizeShopifyCommerce(
  orderSnapshotPartySource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
const fallbackParty = availableValue(orderSnapshotParty.orders[0].party)
assert.equal(
  fallbackParty.externalIdentity.state,
  'unavailable',
  'An order-only Shopify grant must not invent a stable customer identity',
)
assert.equal(
  textValue(fallbackParty.contactName),
  'Ada Buyer',
  'An order-only Shopify grant must retain an executable customer name fallback',
)
assert.equal(textValue(fallbackParty.email), 'ada@example.test')
assert.equal(
  faireNormalized.orders[0].lines[0].variantIdentity.value.value,
  'variant-101',
)

const partiallyFulfilledShopifySource = clone(shopifySource)
const partiallyFulfilledShopifyOrder =
  partiallyFulfilledShopifySource.orders.nodes[0]
partiallyFulfilledShopifyOrder.displayFulfillmentStatus =
  'PARTIALLY_FULFILLED'
partiallyFulfilledShopifyOrder.lineItems.nodes[0].quantity = 4
partiallyFulfilledShopifyOrder.lineItems.nodes[0].currentQuantity = 3
partiallyFulfilledShopifyOrder.lineItems.nodes[0].unfulfilledQuantity = 1
partiallyFulfilledShopifyOrder.lineItems.nodes[0].originalTotalSet =
  moneyBag('19.88')
partiallyFulfilledShopifyOrder.lineItems.nodes[0].discountedTotalSet =
  moneyBag('19.41')
partiallyFulfilledShopifyOrder.lineItems.nodes[0].totalDiscountSet =
  moneyBag('0.47')
partiallyFulfilledShopifyOrder.lineItems.nodes[0].unfulfilledOriginalTotalSet =
  moneyBag('4.97')
partiallyFulfilledShopifyOrder
  .lineItems.nodes[0].unfulfilledDiscountedTotalSet = moneyBag('4.50')
const partiallyFulfilledShopify = shopify.normalizeShopifyCommerce(
  partiallyFulfilledShopifySource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
const partialLine = partiallyFulfilledShopify.orders[0].lines[0]
assert.deepEqual(
  {
    ordered: partialLine.orderedQuantity,
    current: partialLine.currentQuantity,
    cancelled: partialLine.cancelledQuantity,
    fulfilled: partialLine.fulfilledQuantity,
    unfulfilled: partialLine.unfulfilledQuantity,
    returned: partialLine.returnedQuantity,
    removedOrRefunded: partialLine.removedOrRefundedQuantity,
  },
  {
    ordered: 4,
    current: 3,
    cancelled: 1,
    fulfilled: 2,
    unfulfilled: 1,
    returned: null,
    removedOrRefunded: 1,
  },
  'Shopify line quantities must preserve exact remaining fulfillment work',
)
assert.equal(
  moneyValue(partialLine.lineSubtotal),
  '497:USD',
  'Partial Shopify lines must stage the unfulfilled original subtotal',
)
assert.equal(
  moneyValue(partialLine.lineDiscount),
  '47:USD',
  'Partial Shopify lines must stage the unfulfilled discount delta',
)
assert.equal(
  faireNormalized.orders[0].providerFacts.brandIdentity.value.value,
  'brand-1',
)
assert.equal(
  faireNormalized.orders[0].providerFacts.retailerIdentity.value.value,
  'retailer-300',
)
assert.equal(
  fairePageWrapped.products.length,
  1,
  'Faire client page wrappers must retain products',
)
assert.equal(
  fairePageWrapped.orders.length,
  1,
  'Faire client page wrappers must retain orders',
)
assert.equal(
  fairePageWrapped.orders[0].lineItemsTruncated,
  true,
  'A Faire next cursor must create a deterministic truncation blocker',
)
assert.equal(
  moneyValue(faireNormalized.orders[0].providerFacts.brandDiscount),
  '0:USD',
)
assert.equal(
  moneyValue(faireNormalized.orders[0].providerFacts.lineDiscountTotal),
  '0:USD',
)
assert.equal(
  faireNormalized.orders[0].providerFacts.payoutState,
  'PENDING',
)
assert.equal(
  faireNormalized.orders[0].rawStates.payment,
  'PAID',
  'Faire payout evidence must not replace raw customer payment state',
)

assert.equal(
  common.decimalToCommerceMinorUnits('90071992547409.91', 'USD'),
  9_007_199_254_740_991n,
)
assert.equal(common.decimalToCommerceMinorUnits('1234', 'JPY'), 1_234n)
assert.equal(common.decimalToCommerceMinorUnits('1.234', 'KWD'), 1_234n)
assert.equal(common.decimalToCommerceMinorUnits('1.2345', 'CLF'), 12_345n)
assert.throws(
  () => common.decimalToCommerceMinorUnits('1.005', 'USD'),
  /more precision/,
)
assert.throws(
  () => common.decimalToCommerceMinorUnits(10.05, 'USD'),
  /plain decimal string/,
)

const missingSkuSource = clone(shopifySource)
missingSkuSource.products.nodes[0].variants.nodes[0].sku = null
missingSkuSource.orders.nodes[0].lineItems.nodes[0].sku = null
const missingSku = shopify.normalizeShopifyCommerce(missingSkuSource, {
  ...baseContext,
  externalAccountId: 'gid://shopify/Shop/1',
})
const missingSkuCodes = missingSku.orders[0].readinessFacts
  .map((fact) => fact.code)
assert.ok(missingSkuCodes.includes('product_sku_missing'))
assert.ok(missingSkuCodes.includes('product_mapping_required'))
assert.equal(
  missingSku.orders[0].lines[0].variantIdentity.value.value,
  'gid://shopify/ProductVariant/101',
  'Missing SKU must not erase the exact provider variant identity',
)

const ambiguousSkuSource = clone(shopifySource)
ambiguousSkuSource.products.nodes[0].variants.nodes.push({
  ...clone(ambiguousSkuSource.products.nodes[0].variants.nodes[0]),
  id: 'gid://shopify/ProductVariant/102',
})
const ambiguousSku = shopify.normalizeShopifyCommerce(
  ambiguousSkuSource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
const ambiguousFact = ambiguousSku.orders[0].readinessFacts.find(
  (fact) => fact.code === 'product_sku_ambiguous',
)
assert.ok(ambiguousFact)
assert.equal(ambiguousFact.blocking, true)
assert.equal(
  ambiguousSku.orders[0].lines[0].variantIdentity.value.value,
  'gid://shopify/ProductVariant/101',
  'Ambiguous SKU must not replace the selected exact provider identity',
)

function stringsAndKeys(value, result = [], seen = new Set()) {
  if (typeof value === 'string') {
    result.push(value)
    return result
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return result
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) stringsAndKeys(item, result, seen)
    return result
  }
  for (const [key, item] of Object.entries(value)) {
    result.push(key)
    stringsAndKeys(item, result, seen)
  }
  return result
}

const unknownFieldSource = clone(shopifySource)
unknownFieldSource.future_additive_field = {
  nested: 'RAW-PAYLOAD-SENTINEL',
}
unknownFieldSource.orders.nodes[0].another_future_field =
  'RAW-PAYLOAD-SENTINEL'
const unknownNormalized = shopify.normalizeShopifyCommerce(
  unknownFieldSource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
const exposedStrings = stringsAndKeys(unknownNormalized)
assert.ok(!exposedStrings.includes('RAW-PAYLOAD-SENTINEL'))
assert.ok(!exposedStrings.some((value) => (
  /^(?:payload|rawPayload|sourcePayload)$/i.test(value)
)))
assert.notEqual(
  unknownNormalized.sourceHash,
  shopifyNormalized.sourceHash,
  'Additive fields must affect source integrity without being returned',
)
assert.match(unknownNormalized.sourceHash, /^[a-f0-9]{64}$/)
assert.match(unknownNormalized.orders[0].sourceHash, /^[a-f0-9]{64}$/)

const unknownFaireSource = clone(faireSource)
unknownFaireSource.future_additive_field = {
  nested: 'FAIRE-RAW-PAYLOAD-SENTINEL',
}
unknownFaireSource.orders[0].another_future_field =
  'FAIRE-RAW-PAYLOAD-SENTINEL'
const unknownFaireNormalized = faire.normalizeFaireCommerce(
  unknownFaireSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.ok(
  !stringsAndKeys(unknownFaireNormalized)
    .includes('FAIRE-RAW-PAYLOAD-SENTINEL'),
)
assert.notEqual(
  unknownFaireNormalized.sourceHash,
  faireNormalized.sourceHash,
  'Faire additive fields must affect source integrity without being returned',
)

function assertSafeRejection(rejection, expected) {
  assert.equal(rejection.resourceType, expected.resourceType)
  assert.equal(rejection.errorCode, expected.errorCode)
  assert.equal(rejection.externalId, expected.externalId)
  assert.match(rejection.sourceHash, /^[a-f0-9]{64}$/)
  assert.ok(rejection.safeMessage.length > 0)
  assert.ok(rejection.safeMessage.length <= 128)
  assert.doesNotMatch(rejection.safeMessage, /RAW-REJECTION-SENTINEL/)
  assert.deepEqual(
    [...Object.keys(rejection)].sort(),
    ['errorCode', 'externalId', 'resourceType', 'safeMessage', 'sourceHash'],
    'Rejection evidence must not expose raw provider records or exception data',
  )
}

const shopifyIsolationSource = clone(shopifySource)
const invalidShopifyProduct = {
  id: 'RAW-REJECTION-SENTINEL@example.test',
  title: 'Rejected product',
  customer_note: 'RAW-REJECTION-SENTINEL',
  variants: { nodes: [] },
}
const invalidShopifyOrder = {
  id: null,
  customer_note: 'RAW-REJECTION-SENTINEL',
}
const invalidShopifyLineOrder = clone(shopifySource.orders.nodes[0])
invalidShopifyLineOrder.id = 'gid://shopify/Order/202'
invalidShopifyLineOrder.name = '1002'
invalidShopifyLineOrder.lineItems.nodes[0].id =
  'gid://shopify/LineItem/203'
invalidShopifyLineOrder.lineItems.nodes[0].quantity = '2'
shopifyIsolationSource.products.nodes.push(invalidShopifyProduct)
shopifyIsolationSource.orders.nodes.push(
  invalidShopifyOrder,
  invalidShopifyLineOrder,
)
const shopifyIsolation = shopify.normalizeShopifyCommerce(
  shopifyIsolationSource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
assert.equal(
  shopifyIsolation.products.length,
  1,
  'A malformed Shopify product must not discard valid sibling products',
)
assert.equal(
  shopifyIsolation.orders.length,
  1,
  'Malformed Shopify orders and lines must not discard valid sibling orders',
)
assert.equal(shopifyIsolation.rejections.length, 3)
const shopifyProductRejection = shopifyIsolation.rejections.find(
  (rejection) => rejection.resourceType === 'product',
)
assertSafeRejection(shopifyProductRejection, {
  resourceType: 'product',
  errorCode: 'COMMERCE_PRODUCT_RECORD_INVALID',
  externalId: `unidentified:${
    common.commerceSourceHash(invalidShopifyProduct)
  }`,
})
const shopifyInvalidOrderRejection = shopifyIsolation.rejections.find(
  (rejection) => (
    rejection.resourceType === 'order'
    && rejection.externalId.startsWith('unidentified:')
  ),
)
assertSafeRejection(shopifyInvalidOrderRejection, {
  resourceType: 'order',
  errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
  externalId: `unidentified:${
    common.commerceSourceHash(invalidShopifyOrder)
  }`,
})
assertSafeRejection(
  shopifyIsolation.rejections.find(
    (rejection) => rejection.externalId === 'gid://shopify/Order/202',
  ),
  {
    resourceType: 'order',
    errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
    externalId: 'gid://shopify/Order/202',
  },
)
assert.ok(
  !stringsAndKeys(shopifyIsolation).includes('RAW-REJECTION-SENTINEL'),
  'Shopify rejection evidence must not expose raw provider or party data',
)

const shopifyMoneySource = clone(shopifySource)
const shopifyMoneyOrder = clone(shopifySource.orders.nodes[0])
shopifyMoneyOrder.id = 'gid://shopify/Order/204'
shopifyMoneyOrder.name = '1004'
delete shopifyMoneyOrder.currentTotalTaxSet
shopifyMoneySource.orders.nodes.push(shopifyMoneyOrder)
const shopifyMoneyIsolation = shopify.normalizeShopifyCommerce(
  shopifyMoneySource,
  {
    ...baseContext,
    externalAccountId: 'gid://shopify/Shop/1',
  },
)
assert.equal(shopifyMoneyIsolation.orders.length, 1)
assertSafeRejection(shopifyMoneyIsolation.rejections[0], {
  resourceType: 'order',
  errorCode: 'COMMERCE_ORDER_MONEY_INCOMPLETE',
  externalId: 'gid://shopify/Order/204',
})

const faireIsolationSource = clone(faireSource)
const invalidFaireProduct = {
  name: 'Rejected product',
  customer_note: 'RAW-REJECTION-SENTINEL',
  variants: [],
}
const invalidFaireOrder = {
  display_id: 'Rejected order',
  customer_note: 'RAW-REJECTION-SENTINEL',
}
const invalidFaireLineOrder = clone(faireSource.orders[0])
invalidFaireLineOrder.id = 'order-202'
invalidFaireLineOrder.display_id = '1002'
invalidFaireLineOrder.items[0].id = 'item-203'
invalidFaireLineOrder.items[0].quantity = '2'
faireIsolationSource.products.push(invalidFaireProduct)
faireIsolationSource.orders.push(invalidFaireOrder, invalidFaireLineOrder)
const faireIsolation = faire.normalizeFaireCommerce(
  faireIsolationSource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  faireIsolation.products.length,
  1,
  'A malformed Faire product must not discard valid sibling products',
)
assert.equal(
  faireIsolation.orders.length,
  1,
  'Malformed Faire orders and lines must not discard valid sibling orders',
)
assert.equal(faireIsolation.rejections.length, 3)
assertSafeRejection(
  faireIsolation.rejections.find(
    (rejection) => rejection.resourceType === 'product',
  ),
  {
    resourceType: 'product',
    errorCode: 'COMMERCE_PRODUCT_RECORD_INVALID',
    externalId: `unidentified:${
      common.commerceSourceHash(invalidFaireProduct)
    }`,
  },
)
assertSafeRejection(
  faireIsolation.rejections.find(
    (rejection) => (
      rejection.resourceType === 'order'
      && rejection.externalId.startsWith('unidentified:')
    ),
  ),
  {
    resourceType: 'order',
    errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
    externalId: `unidentified:${common.commerceSourceHash(invalidFaireOrder)}`,
  },
)
assertSafeRejection(
  faireIsolation.rejections.find(
    (rejection) => rejection.externalId === 'order-202',
  ),
  {
    resourceType: 'order',
    errorCode: 'COMMERCE_ORDER_RECORD_INVALID',
    externalId: 'order-202',
  },
)
assert.ok(
  !stringsAndKeys(faireIsolation).includes('RAW-REJECTION-SENTINEL'),
  'Faire rejection evidence must not expose raw provider or party data',
)

const faireMoneySource = clone(faireSource)
const faireMoneyOrder = clone(faireSource.orders[0])
faireMoneyOrder.id = 'order-204'
faireMoneyOrder.display_id = '1004'
delete faireMoneyOrder.tax_cents
faireMoneySource.orders.push(faireMoneyOrder)
const faireMoneyIsolation = faire.normalizeFaireCommerce(
  faireMoneySource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(faireMoneyIsolation.orders.length, 1)
assertSafeRejection(faireMoneyIsolation.rejections[0], {
  resourceType: 'order',
  errorCode: 'COMMERCE_ORDER_MONEY_INCOMPLETE',
  externalId: 'order-204',
})

const redactedSource = clone(shopifySource)
redactedSource.orders.nodes[0].customer = null
redactedSource.orders.nodes[0].email = null
redactedSource.orders.nodes[0].phone = null
redactedSource.orders.nodes[0].shippingAddress = null
redactedSource.errors = [
  {
    message: 'Protected customer data is unavailable',
    path: ['orders', 'nodes', 0, 'customer'],
  },
  {
    message: 'Protected address is unavailable',
    path: ['orders', 'nodes', 0, 'shippingAddress'],
  },
]
const redacted = shopify.normalizeShopifyCommerce(redactedSource, {
  ...baseContext,
  externalAccountId: 'gid://shopify/Shop/1',
})
assert.equal(redacted.orders[0].party.state, 'redacted')
assert.equal(redacted.orders[0].shipTo.state, 'redacted')
assert.ok(
  redacted.orders[0].readinessFacts.some(
    (fact) => fact.code === 'customer_redacted' && fact.blocking,
  ),
)
assert.ok(
  redacted.orders[0].readinessFacts.some(
    (fact) => fact.code === 'ship_to_redacted' && fact.blocking,
  ),
)

const absentInventorySource = clone(faireSource)
delete absentInventorySource.products[0].variants[0].inventory_quantity
const absentInventory = faire.normalizeFaireCommerce(
  absentInventorySource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  faireNormalized.products[0].variants[0].inventory.state,
  'available',
)
assert.equal(
  faireNormalized.products[0].variants[0].inventory.value.quantity,
  0,
)
assert.equal(
  absentInventory.products[0].variants[0].inventory.state,
  'unavailable',
  'Absent Faire inventory must not be normalized as zero',
)

const signedInventorySource = clone(faireSource)
signedInventorySource.inventories = {
  'variant-101': {
    available_quantity: {
      type: 'QUANTITY',
      quantity: -3,
    },
  },
}
const signedInventory = faire.normalizeFaireCommerce(
  signedInventorySource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  signedInventory.products[0].variants[0].inventory.value.quantity,
  -3,
  'Faire hydrated signed inventory must override embedded catalog evidence',
)

const untrackedInventorySource = clone(absentInventorySource)
untrackedInventorySource.inventories = {
  'variant-101': {
    available_quantity: { type: 'UNTRACKED' },
  },
}
const untrackedInventory = faire.normalizeFaireCommerce(
  untrackedInventorySource,
  {
    ...baseContext,
    externalAccountId: 'brand-1',
    apiVersion: 'external-api-v2',
  },
)
assert.equal(
  untrackedInventory.products[0].variants[0].inventory.state,
  'unavailable',
)
assert.equal(
  untrackedInventory.products[0].variants[0].inventory.reason,
  'untracked',
  'Faire UNTRACKED inventory must not be converted to zero',
)

const legacyPriceSource = clone(faireSource)
delete legacyPriceSource.products[0].variants[0].prices
legacyPriceSource.products[0].variants[0].wholesale_price_cents = 497
legacyPriceSource.products[0].variants[0].retail_price_cents = 600
const legacyPrices = faire.normalizeFaireCommerce(legacyPriceSource, {
  ...baseContext,
  externalAccountId: 'brand-1',
  apiVersion: 'external-api-v2',
})
assert.equal(
  moneyValue(legacyPrices.products[0].variants[0].wholesalePrice),
  '497:USD',
  'Legacy Faire minor price fields remain supported as a fallback',
)

const ambiguousPricesSource = clone(faireSource)
delete ambiguousPricesSource.brand.currency
delete ambiguousPricesSource.products[0].currency
const ambiguousPrices = faire.normalizeFaireCommerce(ambiguousPricesSource, {
  ...baseContext,
  externalAccountId: 'brand-1',
  apiVersion: 'external-api-v2',
})
assert.equal(
  ambiguousPrices.products[0].variants[0].wholesalePrice.state,
  'unavailable',
  'Multi-geo Faire prices require explicit currency evidence',
)

const casePackSource = clone(faireSource)
casePackSource.orders[0].items[0].quantity = 2
casePackSource.orders[0].items[0].unit_multiplier = 6
const casePack = faire.normalizeFaireCommerce(casePackSource, {
  ...baseContext,
  externalAccountId: 'brand-1',
  apiVersion: 'external-api-v2',
})
assert.equal(casePack.orders[0].lines[0].orderedQuantity, 2)
assert.equal(casePack.orders[0].lines[0].unitMultiplier, 6)
assert.equal(casePack.orders[0].lines[0].physicalUnitQuantity, 12)

const terminalSource = clone(shopifySource)
terminalSource.orders.nodes[0].cancelledAt = '2026-07-26T11:03:00Z'
terminalSource.orders.nodes[0].status = 'CANCELLED'
terminalSource.orders.nodes[0].displayFulfillmentStatus = 'FULFILLED'
terminalSource.orders.nodes[0].lineItems.pageInfo.hasNextPage = true
const terminal = shopify.normalizeShopifyCommerce(terminalSource, {
  ...baseContext,
  externalAccountId: 'gid://shopify/Shop/1',
  sourceState: 'stale',
})
const terminalCodes = new Map(
  terminal.orders[0].readinessFacts.map((fact) => [fact.code, fact]),
)
for (const code of [
  'order_cancelled',
  'order_already_fulfilled',
  'source_truncated',
  'source_stale',
]) {
  assert.equal(terminalCodes.get(code)?.blocking, true, `${code} must block`)
}

const unknownStateSource = clone(faireSource)
delete unknownStateSource.orders[0].state
delete unknownStateSource.orders[0].fulfillment_state
const unknownState = faire.normalizeFaireCommerce(unknownStateSource, {
  ...baseContext,
  externalAccountId: 'brand-1',
  apiVersion: 'external-api-v2',
})
const unknownStateCodes = new Map(
  unknownState.orders[0].readinessFacts.map((fact) => [fact.code, fact]),
)
assert.equal(
  unknownStateCodes.get('order_cancellation_state_unknown')?.blocking,
  true,
)
assert.equal(
  unknownStateCodes.get('order_fulfillment_state_unknown')?.blocking,
  true,
)

for (const adapter of [
  shopify.SHOPIFY_COMMERCE_NORMALIZATION_ADAPTER,
  faire.FAIRE_COMMERCE_NORMALIZATION_ADAPTER,
]) {
  assert.deepEqual(
    [...Object.keys(adapter)].sort(),
    ['normalize', 'normalizerVersion', 'provider'],
  )
  assert.ok(Object.isFrozen(adapter))
  assert.ok(
    Object.keys(adapter).every((key) => (
      !/(?:create|delete|export|fulfill|mutat|register|send|update|write)/i.test(key)
    )),
    'Read-only normalization adapter exposed a mutation-like method',
  )
}

const commonSource = read(commonPath)
const interfaceSource = commonSource.slice(
  commonSource.indexOf(
    'export interface ReadOnlyCommerceNormalizationAdapter',
  ),
  commonSource.indexOf(
    'export class CommerceNormalizationError',
  ),
)
assert.doesNotMatch(
  interfaceSource,
  /(?:create|delete|export|fulfill|mutat|register|send|update|write)\s*[:(]/i,
  'Read-only adapter interface must not contain provider mutation methods',
)

console.log(
  'PASS provider-neutral Shopify/Faire normalization, per-record rejection isolation, exact money, provenance, readiness, redaction, additive fields, and read-only adapter contracts',
)
