import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commerceIntakeCandidateIsHistoricalOutcome,
  commerceIntakeCandidateNeedsOperatorAction,
  commerceIntakeHistoricalOutcomeLabel,
} from '../../lib/operations/commerceIntakeAttention.ts'

test('terminal provider outcomes are retained history, not operator attention', () => {
  assert.equal(commerceIntakeCandidateIsHistoricalOutcome({
    normalizedOrderStatus: 'closed',
    normalizedFulfillmentStatus: 'fulfilled',
  }), true)
  assert.equal(commerceIntakeCandidateIsHistoricalOutcome({
    normalizedOrderStatus: 'cancelled',
    normalizedFulfillmentStatus: 'unfulfilled',
  }), true)
  assert.equal(commerceIntakeCandidateIsHistoricalOutcome({
    providerStatus: 'CLOSED',
    fulfillmentStatus: 'FULFILLED',
  }), true)
})

test('open and partially fulfilled orders can still require attention', () => {
  assert.equal(commerceIntakeCandidateIsHistoricalOutcome({
    normalizedOrderStatus: 'open',
    normalizedFulfillmentStatus: 'unfulfilled',
  }), false)
  assert.equal(commerceIntakeCandidateIsHistoricalOutcome({
    normalizedOrderStatus: 'open',
    normalizedFulfillmentStatus: 'partial',
  }), false)
})

test('open provider orders require action until promoted, including refresh states', () => {
  assert.equal(commerceIntakeCandidateNeedsOperatorAction({
    state: 'held',
    normalizedOrderStatus: 'open',
    normalizedFulfillmentStatus: 'unfulfilled',
  }), true)
  assert.equal(commerceIntakeCandidateNeedsOperatorAction({
    state: 'held',
    normalizedOrderStatus: 'closed',
    normalizedFulfillmentStatus: 'fulfilled',
  }), false)
  assert.equal(commerceIntakeCandidateNeedsOperatorAction({
    state: 'promoted',
    normalizedOrderStatus: 'open',
    normalizedFulfillmentStatus: 'unfulfilled',
  }), false)
  for (const state of ['failed', 'expired']) {
    assert.equal(commerceIntakeCandidateNeedsOperatorAction({
      state,
      normalizedOrderStatus: 'open',
      normalizedFulfillmentStatus: 'unfulfilled',
    }), true)
  }
})

test('historical outcome labels explain why no action is required', () => {
  assert.equal(commerceIntakeHistoricalOutcomeLabel({
    normalizedOrderStatus: 'cancelled',
  }), 'Cancelled externally')
  assert.equal(commerceIntakeHistoricalOutcomeLabel({
    normalizedOrderStatus: 'closed',
    normalizedFulfillmentStatus: 'fulfilled',
  }), 'Fulfilled externally')
  assert.equal(commerceIntakeHistoricalOutcomeLabel({
    normalizedOrderStatus: 'closed',
  }), 'Closed externally')
})
