import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as shadowTraining from '../../lib/operations/shadowTraining.ts'

const {
  OperationsShadowTrainingError,
  assertShadowTrainingCommandState,
  assertShadowTrainingEligibility,
  assertShadowTrainingSandboxCarrierBeforeIo,
  shadowTrainingAvailableActions,
  shadowTrainingUndoTarget,
} = shadowTraining

const eligible = {
  activationState: 'shadow',
  orderStatus: 'imported',
  sourceProvider: 'shopify',
  integrationType: 'commerce',
  accountStatus: 'active',
  accountEnvironment: 'sandbox',
  credentialVerificationStatus: 'verified',
}

function expectCode(invoke: () => unknown, code: string) {
  assert.throws(invoke, (error: unknown) => {
    assert.ok(error instanceof OperationsShadowTrainingError)
    assert.equal(error.code, code)
    return true
  })
}

test('accepts local training in every current safety profile', () => {
  for (const activationState of [
    'disabled', 'shadow', 'read_only', 'active', 'frozen',
  ]) {
    assert.doesNotThrow(() => assertShadowTrainingEligibility({
      ...eligible,
      activationState,
    }))
  }
  assert.doesNotThrow(() => assertShadowTrainingEligibility({
    ...eligible,
    activationState: 'read_only',
    sourceProvider: 'faire',
    accountEnvironment: 'production',
  }))
})

test('rejects mock accounts, missing safety state, and progressed orders', () => {
  expectCode(
    () => assertShadowTrainingEligibility({
      ...eligible,
      accountEnvironment: 'mock',
    }),
    'OPERATIONS_SHADOW_TRAINING_CONNECTION_REQUIRED',
  )
  expectCode(
    () => assertShadowTrainingEligibility({ ...eligible, activationState: 'missing' }),
    'OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED',
  )
  expectCode(
    () => assertShadowTrainingEligibility({ ...eligible, orderStatus: 'planned' }),
    'OPERATIONS_SHADOW_TRAINING_IMPORTED_ORDER_REQUIRED',
  )
})

test('exposes only the local overlay progression and terminal reset', () => {
  assert.deepEqual(shadowTrainingAvailableActions('enabled'), ['plan', 'reset'])
  assert.deepEqual(shadowTrainingAvailableActions('planned'), ['release', 'reset'])
  assert.deepEqual(shadowTrainingAvailableActions('released'), ['confirm-picks', 'undo', 'reset'])
  assert.deepEqual(shadowTrainingAvailableActions('picked'), ['verify-pack', 'undo', 'reset'])
  assert.deepEqual(shadowTrainingAvailableActions('packed'), ['complete', 'undo', 'reset'])
  assert.deepEqual(shadowTrainingAvailableActions('completed'), ['undo', 'reset'])
  assert.equal(shadowTrainingUndoTarget('released'), 'planned')
  assert.equal(shadowTrainingUndoTarget('picked'), 'released')
  assert.equal(shadowTrainingUndoTarget('packed'), 'picked')
  assert.equal(shadowTrainingUndoTarget('completed'), 'packed')
  expectCode(
    () => shadowTrainingUndoTarget('planned'),
    'OPERATIONS_SHADOW_TRAINING_UNDO_UNAVAILABLE',
  )
  expectCode(
    () => assertShadowTrainingCommandState({ state: 'reset', action: 'plan' }),
    'OPERATIONS_SHADOW_TRAINING_TRANSITION_INVALID',
  )
})

test('carrier execution accepts only UPS/FedEx sandbox rate-test evidence', () => {
  assert.doesNotThrow(() => assertShadowTrainingSandboxCarrierBeforeIo({
    environment: 'sandbox',
    purpose: 'sandbox_rate_test',
    provider: 'ups_rest',
  }))
  expectCode(
    () => assertShadowTrainingSandboxCarrierBeforeIo({
      environment: 'production',
      purpose: 'sandbox_rate_test',
      provider: 'ups_rest',
    }),
    'OPERATIONS_SHADOW_TRAINING_SANDBOX_CARRIER_REQUIRED',
  )
  expectCode(
    () => assertShadowTrainingSandboxCarrierBeforeIo({
      environment: 'sandbox',
      purpose: 'label',
      provider: 'fedex_rest',
    }),
    'OPERATIONS_SHADOW_TRAINING_SANDBOX_CARRIER_REQUIRED',
  )
})
