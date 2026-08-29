import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPipelineCurrency } from '../../lib/crm/pipelineCurrency.ts'

test('pipeline currency preserves the same cents across app reporting surfaces', () => {
  assert.equal(formatPipelineCurrency(125.4375), '$125.44')
  assert.equal(formatPipelineCurrency(125), '$125.00')
  assert.equal(formatPipelineCurrency(0), '$0.00')
  assert.equal(formatPipelineCurrency(-0.125), '-$0.13')
})

test('pipeline currency fails closed for a non-finite value', () => {
  assert.equal(formatPipelineCurrency(Number.NaN), '—')
  assert.equal(formatPipelineCurrency(Number.POSITIVE_INFINITY), '—')
})
