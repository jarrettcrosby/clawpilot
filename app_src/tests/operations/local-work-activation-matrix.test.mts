import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the explicit extension.
import { availableOperationsOrderActions } from '../../lib/operations/domain.ts'

const activationStates = [
  'disabled',
  'shadow',
  'read_only',
  'active',
  'frozen',
] as const

function actions(overrides: Record<string, unknown>) {
  return availableOperationsOrderActions({
    status: 'planned',
    sourceProvider: 'shopify',
    orderType: 'commerce',
    activationState: 'disabled',
    canManage: true,
    canExecute: true,
    canPurchaseLivePostage: false,
    planStatus: 'planned',
    waveStatus: null,
    lineCount: 1,
    fullyReservedLineCount: 1,
    allocatedLineCount: 1,
    pickTaskCount: 0,
    readyPickTaskCount: 0,
    pickedPickTaskCount: 0,
    packageCount: 1,
    plannedPackageCount: 1,
    packedPackageCount: 0,
    blockingExceptionCount: 0,
    ...overrides,
  })
}

function action(
  overrides: Record<string, unknown>,
  name: string,
) {
  return actions(overrides).find((candidate) => candidate.action === name)!
}

test('ordinary local warehouse actions ignore the legacy activation profile', () => {
  for (const activationState of activationStates) {
    assert.equal(action({ activationState }, 'release_to_warehouse').enabled, true)
    assert.equal(action({
      activationState,
      status: 'released',
      planStatus: 'released',
      waveStatus: 'released',
      pickTaskCount: 1,
      readyPickTaskCount: 1,
      plannedPackageCount: 0,
    }, 'confirm_picks').enabled, true)
    assert.equal(action({
      activationState,
      status: 'released',
      planStatus: 'released',
      waveStatus: 'released',
      pickTaskCount: 1,
      readyPickTaskCount: 1,
      shopifyExternalFulfillmentReconciliationRequired: true,
      plannedPackageCount: 0,
    }, 'reconcile_external_fulfillment').enabled, true)
    assert.equal(action({
      activationState,
      status: 'picking',
      planStatus: 'released',
      waveStatus: 'completed',
      pickTaskCount: 1,
      pickedPickTaskCount: 1,
    }, 'verify_pack').enabled, true)
  }
})

test('connected-commerce shipment mutation retains its activation boundary', () => {
  for (const activationState of [
    'disabled', 'shadow', 'read_only', 'frozen',
  ] as const) {
    const confirmation = action({
      activationState,
      status: 'packed',
      planStatus: 'released',
      waveStatus: 'completed',
      plannedPackageCount: 0,
      packedPackageCount: 1,
      activeLabelCount: 1,
      shippableLabelCount: 1,
    }, 'confirm_shipment')
    assert.equal(confirmation.enabled, false)
    assert.match(confirmation.blockedReason || '', /Operations.*Active/u)
  }
})
