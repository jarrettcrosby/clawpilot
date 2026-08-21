import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CommerceStoreSyncHttpError,
  commerceStoreSyncPendingResolution,
  type CommerceStoreSyncControl,
  type CommerceStoreSyncPendingCommand,
} from '../../lib/operations/commerceStoreSync.ts'

const command: CommerceStoreSyncPendingCommand = {
  accountGlobalId: 'gia0000001',
  desiredState: 'running',
  expectedDesiredState: 'paused',
  expectedRevision: 7,
  reason: 'Changed Store sync after reviewing the current account',
  idempotencyKey: 'store-sync:00000000-0000-4000-8000-000000000001',
}

const control = (
  overrides: Partial<CommerceStoreSyncControl> = {},
): CommerceStoreSyncControl => ({
  accountGlobalId: command.accountGlobalId,
  provider: 'shopify',
  environment: 'sandbox',
  displayName: 'Store A',
  accountStatus: 'active',
  desiredState: command.desiredState,
  effectiveState: 'running',
  effectiveReason: 'STORE_SYNC_EXPLICIT_RUNNING',
  effectiveReasonLabel: 'Running by an explicit Store sync choice.',
  explicitChoice: true,
  revision: command.expectedRevision + 1,
  reason: command.reason,
  updatedAt: '2026-08-16T12:00:00.000Z',
  ...overrides,
})

test('an exact refreshed result reconciles an ambiguous lost response', () => {
  assert.equal(
    commerceStoreSyncPendingResolution(
      control(),
      command,
      new TypeError('fetch failed'),
    ),
    'applied',
  )
})

test('transport, retryable HTTP, and malformed success outcomes retain exact retry', () => {
  for (const failure of [
    new TypeError('fetch failed'),
    new CommerceStoreSyncHttpError(429, 'Try again later', 'RATE_LIMITED'),
    new CommerceStoreSyncHttpError(503, 'Unavailable', 'UNAVAILABLE'),
    new Error('Store sync returned a response for a different command'),
  ]) {
    assert.equal(
      commerceStoreSyncPendingResolution(control({ revision: 7 }), command, failure),
      'retain_exact_retry',
    )
  }
})

test('a definitive conflict clears stale retry and requires review', () => {
  assert.equal(
    commerceStoreSyncPendingResolution(
      control({
        desiredState: 'paused',
        effectiveState: 'paused',
        effectiveReason: 'STORE_SYNC_EXPLICIT_PAUSED',
        effectiveReasonLabel: 'Paused by an explicit Store sync choice.',
        revision: 9,
        reason: 'A different administrator paused this account',
      }),
      command,
      new CommerceStoreSyncHttpError(
        409,
        'Store sync changed before this request',
        'COMMERCE_STORE_SYNC_REVISION_CONFLICT',
      ),
    ),
    'definitive_rejection',
  )
})

test('all definitive non-applied 4xx outcomes clear stale retry', () => {
  for (const status of [400, 401, 403, 404, 409, 410, 422]) {
    assert.equal(
      commerceStoreSyncPendingResolution(
        control({ revision: 7 }),
        command,
        new CommerceStoreSyncHttpError(status, 'Rejected'),
      ),
      'definitive_rejection',
    )
  }
})

test('same desired state and revision with a different reason is not reconciled', () => {
  assert.equal(
    commerceStoreSyncPendingResolution(
      control({ reason: 'Different command at the same revision' }),
      command,
      new TypeError('fetch failed'),
    ),
    'retain_exact_retry',
  )
})
