import assert from 'node:assert/strict'
import test from 'node:test'
import { availableOperationsOrderActions } from '../../lib/operations/domain.ts'

function shipmentAction(overrides: Record<string, unknown> = {}) {
  const actions = availableOperationsOrderActions({
    status: 'packed',
    sourceProvider: 'clawpilot_native',
    orderType: 'one_off',
    oneOffShippingMode: 'test',
    activationState: 'shadow',
    canExecute: true,
    planStatus: 'released',
    waveStatus: 'completed',
    lineCount: 1,
    fullyReservedLineCount: 1,
    allocatedLineCount: 1,
    pickTaskCount: 1,
    readyPickTaskCount: 0,
    pickedPickTaskCount: 1,
    packageCount: 2,
    plannedPackageCount: 0,
    packedPackageCount: 2,
    blockingExceptionCount: 0,
    activeLabelCount: 2,
    sandboxLabelCount: 2,
    shippableLabelCount: 0,
    unresolvedLabelAttemptCount: 0,
    existingShipmentCount: 0,
    nativeOneOffGroupReady: true,
    nativeOneOffGroupBlockedReason: null,
    ...overrides,
  })
  return actions.find((action) => action.action === 'confirm_shipment')!
}

test('native TEST one-off permits complete multi-package confirmation only in Shadow', () => {
  assert.deepEqual(shipmentAction(), {
    action: 'confirm_shipment',
    label: 'Confirm shipment',
    enabled: true,
    blockedReason: null,
  })
  assert.match(
    shipmentAction({ activationState: 'active' }).blockedReason || '',
    /TEST one-off shipments.*Operations Shadow/,
  )
})

test('native LIVE one-off permits complete multi-package confirmation only in Active', () => {
  assert.equal(shipmentAction({
    oneOffShippingMode: 'live',
    activationState: 'active',
    canActivate: true,
    sandboxLabelCount: 0,
    shippableLabelCount: 2,
  }).enabled, true)
  assert.match(shipmentAction({
    oneOffShippingMode: 'live',
    activationState: 'shadow',
    canActivate: true,
  }).blockedReason || '', /LIVE one-off shipments.*Operations Active/)
  assert.match(shipmentAction({
    oneOffShippingMode: 'live',
    activationState: 'active',
    canActivate: false,
  }).blockedReason || '', /activation permission.*LIVE postage/i)
})

test('native one-off blocks partial, unresolved, and closed group evidence', () => {
  assert.equal(shipmentAction({ packedPackageCount: 1 }).enabled, false)
  assert.equal(shipmentAction({
    nativeOneOffGroupReady: false,
    nativeOneOffGroupBlockedReason: 'Resolve the pending one-off carrier group.',
  }).blockedReason, 'Resolve the pending one-off carrier group.')
})

test('generic multi-package shipment behavior remains unchanged', () => {
  const action = shipmentAction({
    sourceProvider: 'shopify',
    orderType: 'standard',
    oneOffShippingMode: null,
    activationState: 'active',
    nativeOneOffGroupReady: false,
    nativeOneOffGroupBlockedReason: null,
    sandboxLabelCount: 0,
    shippableLabelCount: 2,
  })
  assert.equal(action.enabled, false)
  assert.match(action.blockedReason || '', /exactly one verified package/)
})

test('legacy authorized sandbox E2E multi-package behavior remains unchanged', () => {
  const action = shipmentAction({
    sourceProvider: 'shopify',
    orderType: 'standard',
    oneOffShippingMode: null,
    activationState: 'active',
    sandboxE2eAuthorized: true,
    nativeOneOffGroupReady: false,
    nativeOneOffGroupBlockedReason: null,
  })
  assert.equal(action.enabled, true)
})
