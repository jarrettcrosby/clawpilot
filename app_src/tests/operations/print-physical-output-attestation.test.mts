import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the explicit extension.
import {
  canAttestOperationsPrintJobPhysicalOutput,
} from '../../lib/operations/printing.ts'

function job(overrides: Record<string, unknown> = {}) {
  return {
    status: 'delivered' as const,
    deliveredAttemptId: '8f0dd33a-3794-4de1-a664-4b53fcba21c2',
    deliveredAttemptSequenceNumber: 3,
    physicalOutputAttestation: null,
    ...overrides,
  }
}

test('physical-output attestation requires an exact delivered event version', () => {
  assert.equal(canAttestOperationsPrintJobPhysicalOutput(job()), true)
  assert.equal(canAttestOperationsPrintJobPhysicalOutput(job({ status: 'claimed' })), false)
  assert.equal(canAttestOperationsPrintJobPhysicalOutput(job({ deliveredAttemptId: null })), false)
  assert.equal(
    canAttestOperationsPrintJobPhysicalOutput(job({
      deliveredAttemptSequenceNumber: null,
    })),
    false,
  )
  assert.equal(
    canAttestOperationsPrintJobPhysicalOutput(job({
      deliveredAttemptSequenceNumber: 0,
    })),
    false,
  )
})

test('an existing immutable attestation prevents another operator confirmation', () => {
  assert.equal(
    canAttestOperationsPrintJobPhysicalOutput(job({
      physicalOutputAttestation: {
        deliveryAttemptId: '8f0dd33a-3794-4de1-a664-4b53fcba21c2',
        deliveryAttemptSequenceNumber: 3,
        deliveredAt: '2026-08-28T12:00:00.000Z',
        verifiedAt: '2026-08-28T12:01:00.000Z',
        verifiedBy: 'operator@example.com',
        reason: 'Observed one complete, legible 4 x 6 label.',
      },
    })),
    false,
  )
})
