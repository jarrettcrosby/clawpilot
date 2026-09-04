import assert from 'node:assert/strict'
import test from 'node:test'
import {
  derivedOrderWorkbenchIdempotencyKey,
} from '../../lib/operations/orderWorkbenchIdempotency.ts'

const input = {
  organizationId: 'bb13beb0-2b75-48a2-8b1d-2bd154950668',
  idempotencyKey: 'd4783b27-b341-49d0-8e1e-1278b39039a8',
  candidateGlobalId: 'gcoc1000001',
} as const

test('provider refresh derives the UUID required by commerce intake', () => {
  const key = derivedOrderWorkbenchIdempotencyKey({
    ...input,
    purpose: 'provider',
  })
  assert.match(
    key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
  assert.equal(
    key,
    derivedOrderWorkbenchIdempotencyKey({ ...input, purpose: 'provider' }),
  )
  assert.notEqual(key, input.idempotencyKey)
})

test('provider and local rebase steps retain separate key contracts', () => {
  const provider = derivedOrderWorkbenchIdempotencyKey({
    ...input,
    purpose: 'provider',
  })
  const rebase = derivedOrderWorkbenchIdempotencyKey({
    ...input,
    purpose: 'rebase',
  })
  assert.match(rebase, /^order-workbench-rebase:[0-9a-f]{64}$/u)
  assert.notEqual(provider, rebase)
})
