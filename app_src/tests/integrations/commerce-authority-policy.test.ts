import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commerceAuthorityCapability,
  commerceAuthorityDefaults,
  commerceAuthorityHistoricalCoverageReady,
  DEFAULT_COMMERCE_PROVIDER_WRITE_MODE,
  isCommerceAuthorityResource,
} from '../../lib/integrations/commerceAuthorityPolicy.ts'

test('desired authority modes are resource-specific and never grant writes', () => {
  assert.deepEqual(commerceAuthorityDefaults('shopify', 'orders'), {
    authorityMode: 'provider',
    desiredIngestMode: 'windowed_history_and_core_order_signals_plus_poll',
    providerWriteMode: 'disabled',
  })
  assert.deepEqual(commerceAuthorityDefaults('faire', 'orders'), {
    authorityMode: 'provider',
    desiredIngestMode: 'provider_available_history_and_continuous_poll',
    providerWriteMode: 'disabled',
  })
  assert.deepEqual(commerceAuthorityDefaults('shopify', 'inventory'), {
    authorityMode: 'provider',
    desiredIngestMode: 'current_snapshot_and_realtime',
    providerWriteMode: 'disabled',
  })
  assert.deepEqual(commerceAuthorityDefaults('faire', 'inventory'), {
    authorityMode: 'observation_only',
    desiredIngestMode: 'observation_only',
    providerWriteMode: 'disabled',
  })
  assert.equal(DEFAULT_COMMERCE_PROVIDER_WRITE_MODE, 'disabled')
})

test('Faire inventory is an observation-only capability', () => {
  const capability = commerceAuthorityCapability('faire', 'inventory')
  assert.equal(capability.inbound, 'provider_inventory_observation')
  assert.equal(capability.clawPilotAuthorityAvailable, false)
  assert.equal(capability.providerWriteAvailable, false)
  assert.equal(
    capability.providerWriteBlockerCode,
    'COMMERCE_FAIRE_INVENTORY_OBSERVATION_ONLY',
  )
})

test('Shopify and Faire order authority uses provider order sync', () => {
  assert.equal(
    commerceAuthorityCapability('shopify', 'orders').inbound,
    'provider_order_sync',
  )
  assert.equal(
    commerceAuthorityCapability('faire', 'orders').inbound,
    'provider_order_sync',
  )
  assert.equal(isCommerceAuthorityResource('orders'), true)
  assert.equal(isCommerceAuthorityResource('inventory'), true)
  assert.equal(isCommerceAuthorityResource('products'), false)
})

test('historical authority binds each provider to its exact coverage evidence', () => {
  assert.equal(commerceAuthorityHistoricalCoverageReady({
    provider: 'faire',
    enabled: true,
    status: 'succeeded',
    completenessState: 'faire_provider_available_orders_complete',
  }), true)
  assert.equal(commerceAuthorityHistoricalCoverageReady({
    provider: 'faire',
    enabled: true,
    status: 'succeeded',
    completenessState: 'shopify_fixed_window_orders_complete',
  }), false)
  assert.equal(commerceAuthorityHistoricalCoverageReady({
    provider: 'shopify',
    enabled: true,
    status: 'succeeded',
    completenessState: 'shopify_fixed_window_read_attempt_complete',
  }), false)
})
