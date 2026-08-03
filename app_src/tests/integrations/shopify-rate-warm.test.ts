import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  canonicalizeShopifyAppProxyQuery,
  ShopifyAppProxyVerificationError,
  verifyShopifyAppProxyRequest,
} from '../../lib/integrations/shopifyAppProxy.ts'
import {
  readShopifyCustomerRateDestinations,
  ShopifyCustomerRateZoneError,
} from '../../lib/integrations/shopifyCustomerRateZones.ts'
import {
  loadShopifyRateWarmResponse,
  type ShopifyRateWarmTenant,
} from '../../lib/integrations/shopifyRateWarm.ts'
import {
  readShopifyCheckoutRateWarmPolicy,
} from '../../lib/operations/shopifyCheckoutRateWarmPolicy.ts'
import {
  configuredShopifyNumericIdentifierSet,
} from '../../lib/integrations/shopifyShadowCheckoutAllowlist.ts'

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
  isShadowCustomerAllowed: () => false,
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

test('Shadow variant allowlist fails closed when absent or malformed', () => {
  const prior = process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS
  try {
    delete process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS
    assert.equal(configuredShopifyNumericIdentifierSet(
      'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
    ), null)

    process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS =
      '123456789,not-a-shopify-id'
    assert.equal(configuredShopifyNumericIdentifierSet(
      'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
    ), null)

    process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS =
      '123456789,987654321'
    assert.deepEqual(
      [...(configuredShopifyNumericIdentifierSet(
        'SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS',
      ) || [])],
      ['123456789', '987654321'],
    )
  } finally {
    if (prior === undefined) {
      delete process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS
    } else {
      process.env.SHOPIFY_CHECKOUT_SHADOW_ALLOWED_VARIANT_IDS = prior
    }
  }
})

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

test('paginates every distinct full destination and redacts non-address facts', async () => {
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
              address2: '',
              city: 'Beverly Hills',
              phone: '555-555-0100',
              countryCodeV2: 'US',
              provinceCode: 'CA',
              zip: '90210',
            },
            {
              address1: 'Different private street',
              address2: 'Suite 2',
              city: 'Beverly Hills',
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
              address1: '100  PRIVATE street',
              address2: '',
              city: 'BEVERLY HILLS',
              countryCodeV2: 'US',
              provinceCode: 'CA',
              zip: '90210',
            },
            {
              address1: '200 Private Avenue',
              address2: '',
              city: 'Ottawa',
              countryCodeV2: 'CA',
              provinceCode: 'ON',
              zip: 'K1A 0B1',
            },
            {
              address1: 'Missing Postal',
              address2: '',
              city: 'New York',
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
  const result = await readShopifyCustomerRateDestinations({
    customerId: '123456789',
    credential: { shopDomain: SHOP, accessToken: 'test-access-token' },
    grantedScopes: ['read_customers'],
    async graphql(_credential, request) {
      requests.push(request.variables)
      return pages[requests.length - 1] as never
    },
  })

  assert.deepEqual(result, {
    destinations: [
      {
        address1: '200 Private Avenue',
        address2: '',
        city: 'Ottawa',
        province: 'ON',
        country: 'CA',
        zip: 'K1A 0B1',
      },
      {
        address1: '100 Private Street',
        address2: '',
        city: 'Beverly Hills',
        province: 'CA',
        country: 'US',
        zip: '90210',
      },
      {
        address1: 'Different private street',
        address2: 'Suite 2',
        city: 'Beverly Hills',
        province: 'CA',
        country: 'US',
        zip: '90210',
      },
    ],
    counts: { scanned: 5, eligible: 3, duplicate: 1, skipped: 1 },
  })
  assert.equal(requests[1]?.after, 'cursor-1')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('firstName'), false)
  assert.equal(serialized.includes('customer@example.com'), false)
  assert.equal(serialized.includes('MailingAddress'), false)
  assert.equal(serialized.includes('555-555-0100'), false)
})

test('refuses missing scope before reading customer data', async () => {
  let called = false
  await assert.rejects(
    readShopifyCustomerRateDestinations({
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
    readShopifyCustomerRateDestinations({
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
                {
                  address1: '100 Main Street',
                  address2: '',
                  city: 'Beverly Hills',
                  countryCodeV2: 'US',
                  provinceCode: 'CA',
                  zip: '90210',
                },
                {
                  address1: '35 Saxony Drive',
                  address2: '',
                  city: 'Trumbull',
                  countryCodeV2: 'US',
                  provinceCode: 'CT',
                  zip: '06103',
                },
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
  environment?: 'sandbox' | 'production'
  policyEnabled?: boolean
} = {}): ShopifyRateWarmTenant {
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    accountGlobalId: 'gia0000001',
    shopDomain: input.shopDomain || SHOP,
    activationState: input.activationState || 'active',
    environment: input.environment || 'sandbox',
    policyRevision: 7,
    policySnapshot: {
      checkoutRateWarm: {
        version: 'shopify-checkout-rate-warm-v1',
        enabled: input.policyEnabled ?? true,
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

test('returns exact hosted contract and only tenant-supported destinations', async () => {
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
      async readCustomerRateDestinations(input) {
        assert.equal(input.customerId, '123456789')
        return {
          destinations: [
            {
              address1: '100 Main Street',
              address2: '',
              city: 'Beverly Hills',
              province: 'CA',
              country: 'US',
              zip: '90210',
            },
            {
              address1: '10 Downing Street',
              address2: '',
              city: 'London',
              province: '',
              country: 'GB',
              zip: 'SW1A 1AA',
            },
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
    destinations: [
      {
        address1: '100 Main Street',
        address2: '',
        city: 'Beverly Hills',
        province: 'CA',
        country: 'US',
        zip: '90210',
      },
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

test('disabled policy returns no destinations and never reads Shopify Admin', async () => {
  let tokenRequested = false
  let addressesRead = false
  const result = await loadShopifyRateWarmResponse({
    parameters: signedParameters(),
    nowSeconds: NOW,
    dependencies: {
      ...PROXY_DEPENDENCIES,
      async resolveTenant() {
        return tenant({ policyEnabled: false })
      },
      async requestAccessToken() {
        tokenRequested = true
        return { accessToken: 'test', grantedScopes: ['read_customers'] }
      },
      async readCustomerRateDestinations() {
        addressesRead = true
        return {
          destinations: [],
          counts: { scanned: 0, eligible: 0, duplicate: 0, skipped: 0 },
        }
      },
    },
  })
  assert.equal(result.enabled, false)
  assert.deepEqual(result.destinations, [])
  assert.equal(tokenRequested, false)
  assert.equal(addressesRead, false)
})

test('Shadow sandbox warms only a signed customer with an active policy', async () => {
  let tokenRequests = 0
  let addressReads = 0
  const dependencies = {
    ...PROXY_DEPENDENCIES,
    async resolveTenant() {
      return tenant({
        activationState: 'shadow',
        environment: 'sandbox',
      })
    },
    async requestAccessToken() {
      tokenRequests += 1
      return {
        accessToken: 'test-access-token',
        grantedScopes: ['read_customers'],
      }
    },
    async readCustomerRateDestinations() {
      addressReads += 1
      return {
        destinations: [{
          address1: '35 Saxony Drive',
          address2: '',
          city: 'Trumbull',
          province: 'CT',
          country: 'US',
          zip: '06611',
        }],
        counts: { scanned: 1, eligible: 1, duplicate: 0, skipped: 0 },
      }
    },
  }
  const denied = await loadShopifyRateWarmResponse({
    parameters: signedParameters(),
    nowSeconds: NOW,
    dependencies,
  })
  assert.equal(denied.enabled, false)
  assert.deepEqual(denied.destinations, [])
  assert.equal(tokenRequests, 0)
  assert.equal(addressReads, 0)

  const allowed = await loadShopifyRateWarmResponse({
    parameters: signedParameters(),
    nowSeconds: NOW,
    dependencies: {
      ...dependencies,
      isShadowCustomerAllowed: async (
        customerId: string,
        resolvedTenant: ShopifyRateWarmTenant,
      ) => customerId === '123456789'
        && resolvedTenant.accountGlobalId === 'gia0000001',
    },
  })
  assert.equal(allowed.enabled, true)
  assert.equal(allowed.destinations.length, 1)
  assert.equal(tokenRequests, 1)
  assert.equal(addressReads, 1)
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
        async readCustomerRateDestinations() {
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
