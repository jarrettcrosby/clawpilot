import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMMERCE_CUSTOM_INTEGRATION_ONBOARDING,
  SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
} from '../../lib/integrations/commerceCapabilities.ts'
import {
  resolveCommerceSetupPermissionGuidance,
} from '../../lib/integrations/commerceSetupGuidance.ts'

const faireScopeProfiles =
  COMMERCE_CUSTOM_INTEGRATION_ONBOARDING.faire.scopeProfiles

function guidance(input: {
  provider: 'shopify' | 'faire' | null
  faireAuthPath: 'brand_api_key' | 'oauth'
  faireScopeProfile: 'connection_test' | 'distributed_operations'
}) {
  return resolveCommerceSetupPermissionGuidance({
    ...input,
    shopifyScopes: SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES,
    faireScopeProfiles,
  })
}

test('Faire generated API-key setup exposes provider-issued access without OAuth scopes', () => {
  const result = guidance({
    provider: 'faire',
    faireAuthPath: 'brand_api_key',
    faireScopeProfile: 'distributed_operations',
  })
  assert.equal(result?.mode, 'provider_issued_access')
  assert.equal(result?.copyable, false)
  assert.deepEqual(result?.scopes, [])
  assert.match(result?.description || '', /no OAuth scope list to copy/i)
  assert.match(result?.description || '', /provider-issued key/i)
})

test('Faire OAuth connection test renders READ_BRAND and nothing else', () => {
  const result = guidance({
    provider: 'faire',
    faireAuthPath: 'oauth',
    faireScopeProfile: 'connection_test',
  })
  assert.equal(result?.mode, 'faire_oauth_scopes')
  assert.equal(result?.copyable, true)
  assert.deepEqual(result?.scopes, ['READ_BRAND'])
})

test('Faire OAuth distributed operations renders the exact full profile', () => {
  const result = guidance({
    provider: 'faire',
    faireAuthPath: 'oauth',
    faireScopeProfile: 'distributed_operations',
  })
  assert.equal(result?.mode, 'faire_oauth_scopes')
  assert.equal(result?.copyable, true)
  assert.deepEqual(
    result?.scopes,
    [
      'READ_PRODUCTS',
      'WRITE_PRODUCTS',
      'READ_ORDERS',
      'WRITE_ORDERS',
      'READ_BRAND',
      'READ_RETAILER',
      'READ_INVENTORIES',
      'WRITE_INVENTORIES',
      'READ_SHIPMENTS',
      'READ_REVIEWS',
    ],
  )
})

test('Shopify setup keeps its app-version scope list copyable', () => {
  const result = guidance({
    provider: 'shopify',
    faireAuthPath: 'brand_api_key',
    faireScopeProfile: 'connection_test',
  })
  assert.equal(result?.mode, 'shopify_app_scopes')
  assert.equal(result?.copyable, true)
  assert.deepEqual(result?.scopes, SHOPIFY_DISTRIBUTED_OPERATIONS_SCOPES)
})
