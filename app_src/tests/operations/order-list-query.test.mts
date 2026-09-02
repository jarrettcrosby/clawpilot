import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH,
  isOperationsOrderCursorSortValue,
  isOperationsImportedOrderProviderFilter,
  isOperationsOrderProviderFilter,
  isOperationsOrderSort,
  isOperationsOrderSortDirection,
  isOperationsOrderTrackingFilter,
  isOperationsOrderUpdatedAfter,
} from '../../lib/operations/orderListQuery.ts'

test('order page cursor budget is shared across API and browser validation', () => {
  assert.equal(OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH, 4096)
})

test('order-list query enums accept only the public contract', () => {
  for (const value of [
    'updated',
    'order_number',
    'customer',
    'status',
    'provider',
    'tracking',
  ]) {
    assert.equal(isOperationsOrderSort(value), true)
  }
  assert.equal(isOperationsOrderSort('updated_at'), false)
  assert.equal(isOperationsOrderSort('updated DESC'), false)

  assert.equal(isOperationsOrderSortDirection('asc'), true)
  assert.equal(isOperationsOrderSortDirection('desc'), true)
  assert.equal(isOperationsOrderSortDirection('DESC'), false)

  assert.equal(isOperationsOrderTrackingFilter('present'), true)
  assert.equal(isOperationsOrderTrackingFilter('missing'), true)
  assert.equal(isOperationsOrderTrackingFilter('any'), false)
})

test('provider filters reject unsafe or ambiguous values', () => {
  for (const value of [
    'shopify',
    'faire',
    'clawpilot_native',
    'mock-commerce',
    'toast',
  ]) {
    assert.equal(isOperationsOrderProviderFilter(value), true)
  }
  for (const value of ['', 'Shopify', 'shopify,faire', "shopify' OR true", 'a'.repeat(65)]) {
    assert.equal(isOperationsOrderProviderFilter(value), false)
  }

  assert.equal(isOperationsImportedOrderProviderFilter('shopify'), true)
  assert.equal(isOperationsImportedOrderProviderFilter('faire'), true)
  assert.equal(isOperationsImportedOrderProviderFilter('toast'), false)
})

test('updatedAfter accepts only canonical ISO instants', () => {
  assert.equal(
    isOperationsOrderUpdatedAfter('2026-09-01T12:34:56.789Z'),
    true,
  )
  assert.equal(isOperationsOrderUpdatedAfter('2026-09-01T12:34:56Z'), false)
  assert.equal(
    isOperationsOrderUpdatedAfter('2026-09-01T08:34:56.789-04:00'),
    false,
  )
  assert.equal(
    isOperationsOrderUpdatedAfter('-100000-01-01T00:00:00.000Z'),
    false,
  )
  assert.equal(
    isOperationsOrderUpdatedAfter('+010000-01-01T00:00:00.000Z'),
    false,
  )
  assert.equal(
    isOperationsOrderUpdatedAfter('0000-01-01T00:00:00.000Z'),
    false,
  )
  assert.equal(isOperationsOrderUpdatedAfter('not-a-date'), false)
})

test('cursor text tuples reject PostgreSQL NUL and malformed Unicode', () => {
  assert.equal(isOperationsOrderCursorSortValue('Customer', 'customer'), true)
  assert.equal(
    isOperationsOrderCursorSortValue('客'.repeat(500), 'customer'),
    true,
  )
  assert.equal(
    isOperationsOrderCursorSortValue('客'.repeat(501), 'customer'),
    false,
  )
  assert.equal(
    isOperationsOrderCursorSortValue('Customer\u0000forged', 'customer'),
    false,
  )
  assert.equal(isOperationsOrderCursorSortValue('\ud800', 'customer'), false)
})
