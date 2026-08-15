import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the explicit extension.
import {
  availableOperationsOrderActions,
  operationsOrderReplanningActionAvailability,
} from '../../lib/operations/domain.ts'

const fingerprint = 'a'.repeat(64)

function correction(overrides: Partial<Parameters<
  typeof operationsOrderReplanningActionAvailability
>[0]> = {}) {
  return operationsOrderReplanningActionAvailability({
    activationState: 'active',
    canManage: true,
    canExecute: true,
    sourceProvider: 'shopify',
    orderType: 'commerce',
    status: 'planned',
    planStatus: 'planned',
    waveStatus: null,
    exactStateReady: true,
    expectedPlanGlobalId: 'gfp0000001',
    expectedPlanVersion: 1,
    expectedCorrectionFingerprint: fingerprint,
    ...overrides,
  })
}

test('projects one exact Active planned-order correction action', () => {
  const action = correction()
  assert.equal(action.action, 'reopen_for_replanning')
  assert.equal(action.enabled, true)
  assert.equal(action.blockedCode, null)
  assert.equal(action.expectedPlanGlobalId, 'gfp0000001')
  assert.equal(action.expectedPlanVersion, 1)
  assert.equal(action.expectedCorrectionFingerprint, fingerprint)
  assert.match(action.consequenceSummary || '', /No carrier or storefront calls/u)
})

test('keeps released correction visible but blocks it pending device recall', () => {
  const released = correction({
    status: 'released',
    planStatus: 'released',
    waveStatus: 'released',
  })
  assert.equal(released.enabled, false)
  assert.equal(
    released.blockedCode,
    'OPERATIONS_REPLANNING_RELEASED_RECALL_REQUIRED',
  )
  assert.match(released.blockedReason || '', /every picker device/u)
  assert.equal(released.expectedCorrectionFingerprint, null)
})

test('does not expose an executable correction outside Active commerce work', () => {
  const cases = [
    correction({ activationState: 'shadow' }),
    correction({ sourceProvider: 'mock-commerce' }),
    correction({ sourceProvider: 'clawpilot_native', orderType: 'one_off' }),
    correction({ status: 'picking', planStatus: 'released' }),
    correction({ canManage: false }),
    correction({ canExecute: false }),
  ]
  for (const action of cases) {
    assert.equal(action.enabled, false)
    assert.equal(action.expectedCorrectionFingerprint, null)
  }
})

test('carries the server exact-state blocker and fails closed without a fingerprint', () => {
  const physicalWork = correction({
    exactStateReady: false,
    exactStateBlockedCode: 'OPERATIONS_REPLANNING_PHYSICAL_WORK_EXISTS',
    exactStateBlockedReason: 'Picking has started.',
  })
  assert.equal(physicalWork.enabled, false)
  assert.equal(
    physicalWork.blockedCode,
    'OPERATIONS_REPLANNING_PHYSICAL_WORK_EXISTS',
  )
  assert.equal(physicalWork.blockedReason, 'Picking has started.')

  const missingFingerprint = correction({
    expectedCorrectionFingerprint: null,
  })
  assert.equal(missingFingerprint.enabled, false)
  assert.equal(
    missingFingerprint.blockedCode,
    'OPERATIONS_REPLANNING_FINGERPRINT_UNAVAILABLE',
  )
})

test('adds correction as a secondary action without replacing forward workflow', () => {
  const replanningCorrection = correction()
  const actions = availableOperationsOrderActions({
    status: 'planned',
    sourceProvider: 'shopify',
    orderType: 'commerce',
    activationState: 'active',
    canManage: true,
    canExecute: true,
    canActivate: false,
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
    replanningCorrection,
  })
  assert.ok(actions.some((action) => action.action === 'release_to_warehouse'))
  assert.equal(actions.at(-1), replanningCorrection)
})
