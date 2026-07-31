import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  canonicalizeShopifyAppProxyQuery,
  ShopifyAppProxyVerificationError,
  verifyShopifyAppProxyRequest,
} from '../../lib/integrations/shopifyAppProxy.ts'
import {
  readShopifyCustomerRateZones,
  ShopifyCustomerRateZoneError,
} from '../../lib/integrations/shopifyCustomerRateZones.ts'
import {
  loadShopifyRateWarmResponse,
  type ShopifyRateWarmTenant,
} from '../../lib/integrations/shopifyRateWarm.ts'
import {
  readShopifyCheckoutRateWarmPolicy,
} from '../../lib/operations/shopifyCheckoutRateWarmPolicy.ts'

const SECRET = 'test-only-shopify-app-proxy-secret-0000000001'
const SHOP = 'ag-alchemy.myshopify.com'
const NOW = 1_785_400_000
const CART_FINGERPRINT = 'a'.repeat(64)

const PROXY_DEPENDENCIES = {
  readShopHint(parameters: URLSearchParams) {
    return String(parameters.get('shop') || '')
  },
  verifyProxy: verifyShopifyAppProxyRequest,
  readPolicy: readShopifyCheckoutRateWarmPolicy,
}

function signedParameters(input: {
  shop?: string
  customerId?: string
  timestamp?: number
  extras?: Array<[string, string]>
} = {}) {
  const parameters = new URLSearchParams(input.extras || [])
  parameters.set('shop', input.shop ?? SHOP)
  parameters.set(
    'logged_in_customer_id',
    input.customerId === undefined ? '123456789' : input.customerId,
  )
  parameters.set('timestamp', String(input.timestamp ?? NOW))
  parameters.set('cart_fingerprint', CART_FINGERPRINT)
  parameters.set('cart_currency', 'usd')
  parameters.set('path_prefix', '/apps/clawpilot')
  parameters.set(
    'signature',
    createHmac('sha256', SECRET)
      .update(canonicalizeShopifyAppProxyQuery(parameters))
      .digest('hex'),
  )
  return parameters
}

function hasProxyCode(error: unknown, code: string) {
  return error instanceof ShopifyAppProxyVerificationError
    && error.code === code
}

function hasZoneCode(error: unknown, code: string) {
  return error instanceof ShopifyCustomerRateZoneError
    && error.code === code
}

test('verifies Shopify app-proxy HMAC with repeated parameter values', () => {
  const parameters = signedParameters({
    extras: [['extra', 'one'], ['extra', 'two']],
  })
  const expectedCanonical = [
    'cart_currency=usd',
    `cart_fingerprint=${CART_FINGERPRINT}`,
    'extra=one,two',
    'logged_in_customer_id=123456789',
    'path_prefix=/apps/clawpilot',
    `shop=${SHOP}`,
    `timestamp=${NOW}`,
  ].join('')
  assert.equal(
    canonicalizeShopifyAppProxyQuery(parameters),
    expectedCanonical,
  )
  parameters.set(
    'signature',
    createHmac('sha256', SECRET).update(expectedCanonical).digest('hex'),
  )
  assert.deepEqual(
    verifyShopifyAppProxyRequest({
      parameters,
      clientSecret: SECRET,
      expectedShopDomain: SHOP,
      nowSeconds: NOW,
    }),
    {
      shopDomain: SHOP,
      customerId: '123456789',
      timestamp: NOW,
      pathPrefix: '/apps/clawpilot',
      cartFingerprint: CART_FINGERPRINT,
      cartCurrency: 'USD',
    },
  )
})

test('rejects invalid, stale, wrong-shop, and guest app-proxy requests', () => {
  const invalid = signedParameters()
  invalid.set('signature', 'b'.repeat(64))
  assert.throws(
    () => verifyShopifyAppProxyRequest({
      parameters: invalid,
      clientSecret: SECRET,
      expectedShopDomain: SHOP,
      nowSeconds: NOW,
    }),
    (error: unknown) => hasProxyCode(
      error,
      'SHOPIFY_APP_PROXY_SIGNATURE_INVALID',
    ),
  )
  assert.throws(
    () => verifyShopifyAppProxyRequest({
      parameters: signedParameters({ timestamp: NOW - 301 }),
      clientSecret: SECRET,
      expectedShopDomain: SHOP,
      nowSeconds: NOW,
    }),
    (error: unknown) => hasProxyCode(
      error,
      'SHOPIFY_APP_PROXY_TIMESTAMP_STALE',
    ),
  )
  assert.throws(
    () => verifyShopifyAppProxyRequest({
      parameters: signedParameters(),
      clientSecret: SECRET,
      expectedShopDomain: 'another-store.myshopify.com',
      nowSeconds: NOW,
    }),
    (error: unknown) => hasProxyCode(
      error,
      'SHOPIFY_APP_PROXY_SHOP_MISMATCH',
    ),
  )
  assert.throws(
    () => verifyShopifyAppProxyRequest({
      parameters: signedParameters({ customerId: '' }),
      clientSecret: SECRET,
      expectedShopDomain: SHOP,
      nowSeconds: NOW,
    }),
    (error: unknown) => hasProxyCode(
      error,
      'SHOPIFY_APP_PROXY_CUSTOMER_REQUIRED',
    ),
  )
})

test('paginates, normalizes, deduplicates, and redacts saved address zones', async () => {
  const requests: Array<Record<string, unknown>> = []
  const pages = [
    {
      customer: {
        id: 'gid://shopify/Customer/123456789',
        email: 'customer@example.com',
        addressesV2: {
          nodes: [
            {
              id: 'gid://shopify/MailingAddress/1',
              firstName: 'Private',
              address1: '100 Private Street',
              phone: '555-555-0100',
              countryCodeV2: 'us',
              provinceCode: 'ny',
              zip: ' 90210 ',
            },
            {
              address1: 'Different private street',
              countryCodeV2: 'US',
              provinceCode: 'CA',
              zip: '90210',
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        },
      },
    },
    {
      customer: {
        id: 'gid://shopify/Customer/123456789',
        addressesV2: {
          nodes: [
            {
              address1: '200 Private Avenue',
              countryCodeV2: 'ca',
              provinceCode: 'on',
              zip: ' k1a   0b1 ',
            },
            {
              countryCodeV2: 'US',
              provinceCode: 'NY',
              zip: '',
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ]
  const result = await readShopifyCustomerRateZones({
    customerId: '123456789',
    credential: { shopDomain: SHOP, accessToken: 'test-access-token' },
    grantedScopes: ['read_customers'],
    async graphql(_credential, request) {
      requests.push(request.variables)
      return pages[requests.length - 1] as never
    },
  })

  assert.deepEqual(result, {
    zones: [
      { countryCode: 'CA', provinceCode: 'ON', postalCode: 'K1A 0B1' },
      { countryCode: 'US', provinceCode: 'CA', postalCode: '90210' },
    ],
    counts: { scanned: 4, eligible: 2, duplicate: 1, skipped: 1 },
  })
  assert.equal(requests[1]?.after, 'cursor-1')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('Private'), false)
  assert.equal(serialized.includes('customer@example.com'), false)
  assert.equal(serialized.includes('MailingAddress'), false)
  assert.equal(serialized.includes('555-555-0100'), false)
})

test('refuses missing scope before reading customer data', async () => {
  let called = false
  await assert.rejects(
    readShopifyCustomerRateZones({
      customerId: '123456789',
      credential: { shopDomain: SHOP, accessToken: 'test-access-token' },
      grantedScopes: ['read_orders'],
      async graphql() {
        called = true
        return {} as never
      },
    }),
    (error: unknown) => hasZoneCode(
      error,
      'SHOPIFY_READ_CUSTOMERS_SCOPE_REQUIRED',
    ),
  )
  assert.equal(called, false)
})

test('fails closed when customer pagination exceeds the bound', async () => {
  let called = 0
  await assert.rejects(
    readShopifyCustomerRateZones({
      customerId: '123456789',
      credential: { shopDomain: SHOP, accessToken: 'test-access-token' },
      grantedScopes: ['read_customers'],
      pageSize: 2,
      maxAddresses: 2,
      async graphql() {
        called += 1
        return {
          customer: {
            id: 'gid://shopify/Customer/123456789',
            addressesV2: {
              nodes: [
                { countryCodeV2: 'US', provinceCode: 'CA', zip: '90210' },
                { countryCodeV2: 'US', provinceCode: 'CT', zip: '06103' },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: 'more-addresses',
              },
            },
          },
        } as never
      },
    }),
    (error: unknown) => hasZoneCode(
      error,
      'SHOPIFY_CUSTOMER_ADDRESSES_LIMIT_EXCEEDED',
    ),
  )
  assert.equal(called, 1)
})

function tenant(input: {
  shopDomain?: string
  activationState?: 'shadow' | 'active'
} = {}): ShopifyRateWarmTenant {
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    accountGlobalId: 'gia0000001',
    shopDomain: input.shopDomain || SHOP,
    activationState: input.activationState || 'active',
    policyRevision: 7,
    policySnapshot: {
      checkoutRateWarm: {
        version: 'shopify-checkout-rate-warm-v1',
        enabled: true,
        mode: 'hosted_ajax',
        zoneScope: 'all_saved_rate_zones',
        concurrency: 3,
        debounceMs: 400,
        minIntervalMs: 1_200,
        supportedCountries: ['US'],
        staleCartAbort: true,
      },
    },
    clientId: 'test-client-id',
    clientSecret: SECRET,
  }
}

test('returns exact hosted contract and only tenant-supported zones', async () => {
  const result = await loadShopifyRateWarmResponse({
    parameters: signedParameters(),
    nowSeconds: NOW,
    dependencies: {
      ...PROXY_DEPENDENCIES,
      async resolveTenant(shopDomain) {
        assert.equal(shopDomain, SHOP)
        return tenant()
      },
      async requestAccessToken() {
        return {
          accessToken: 'test-access-token',
          grantedScopes: ['read_customers'],
        }
      },
      async readCustomerRateZones(input) {
        assert.equal(input.customerId, '123456789')
        return {
          zones: [
            { countryCode: 'US', provinceCode: 'CA', postalCode: '90210' },
            { countryCode: 'GB', provinceCode: null, postalCode: 'SW1A 1AA' },
          ],
          counts: { scanned: 2, eligible: 2, duplicate: 0, skipped: 0 },
        }
      },
    },
  })

  assert.deepEqual(result, {
    version: 1,
    enabled: true,
    mode: 'hosted_ajax',
    policyRevision: 7,
    cartFingerprint: CART_FINGERPRINT,
    concurrency: 3,
    debounceMs: 400,
    minIntervalMs: 1_200,
    staleCartAbort: true,
    zones: [
      { countryCode: 'US', provinceCode: 'CA', postalCode: '90210' },
    ],
    coverage: {
      scanned: 2,
      eligible: 2,
      duplicate: 0,
      invalid: 0,
      unsupported: 1,
    },
  })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(SECRET), false)
  assert.equal(serialized.includes('test-access-token'), false)
  assert.equal(serialized.includes('123456789'), false)
})

test('shadow mode returns no zones and never reads Shopify Admin', async () => {
  let tokenRequested = false
  let addressesRead = false
  const result = await loadShopifyRateWarmResponse({
    parameters: signedParameters(),
    nowSeconds: NOW,
    dependencies: {
      ...PROXY_DEPENDENCIES,
      async resolveTenant() {
        return tenant({ activationState: 'shadow' })
      },
      async requestAccessToken() {
        tokenRequested = true
        return { accessToken: 'test', grantedScopes: ['read_customers'] }
      },
      async readCustomerRateZones() {
        addressesRead = true
        return {
          zones: [],
          counts: { scanned: 0, eligible: 0, duplicate: 0, skipped: 0 },
        }
      },
    },
  })
  assert.equal(result.enabled, false)
  assert.deepEqual(result.zones, [])
  assert.equal(tokenRequested, false)
  assert.equal(addressesRead, false)
})

test('refuses cross-tenant shop binding before token acquisition', async () => {
  let tokenRequested = false
  await assert.rejects(
    loadShopifyRateWarmResponse({
      parameters: signedParameters(),
      nowSeconds: NOW,
      dependencies: {
        ...PROXY_DEPENDENCIES,
        async resolveTenant() {
          return tenant({ shopDomain: 'another-store.myshopify.com' })
        },
        async requestAccessToken() {
          tokenRequested = true
          return { accessToken: 'test', grantedScopes: ['read_customers'] }
        },
        async readCustomerRateZones() {
          throw new Error('must not read')
        },
      },
    }),
    (error: unknown) => hasProxyCode(
      error,
      'SHOPIFY_APP_PROXY_SHOP_MISMATCH',
    ),
  )
  assert.equal(tokenRequested, false)
})
