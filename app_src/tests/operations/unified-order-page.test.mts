import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UnifiedOperationsOrderPageError,
  compareUnifiedOperationsOrderSortValues,
  mergeUnifiedOperationsOrderPage,
  type OperationsOrderProviderIdentity,
  type UnifiedOperationsOrderRow,
} from '../../lib/operations/unifiedOrderPage.ts'
import type {
  OperationsImportedOrderWorkingCopy,
  OperationsOrderListItem,
} from '../../lib/operations/types.ts'

function canonical(globalId: string): UnifiedOperationsOrderRow {
  return {
    kind: 'canonical',
    key: `canonical:${globalId}`,
    order: { globalId } as OperationsOrderListItem,
  }
}

function imported(candidateGlobalId: string): UnifiedOperationsOrderRow {
  return {
    kind: 'imported',
    key: `imported:${candidateGlobalId}`,
    order: { candidateGlobalId } as OperationsImportedOrderWorkingCopy,
  }
}

function evidence(
  rowCursor: string,
  sortValue: string,
  providerIdentity: OperationsOrderProviderIdentity | null = null,
) {
  return { rowCursor, sortValue, providerIdentity }
}

test('unified merge returns one bounded page and source consumption evidence', () => {
  const result = mergeUnifiedOperationsOrderPage({
    canonical: [
      {
        row: canonical('gor-1'),
        evidence: evidence('canonical-1', '2026-09-01T12:00:00.000Z'),
      },
      {
        row: canonical('gor-2'),
        evidence: evidence('canonical-2', '2026-09-01T10:00:00.000Z'),
      },
    ],
    imported: [
      {
        row: imported('gcoc-1'),
        evidence: evidence('imported-1', '2026-09-01T13:00:00.000Z'),
      },
      {
        row: imported('gcoc-2'),
        evidence: evidence('imported-2', '2026-09-01T11:00:00.000Z'),
      },
    ],
    sort: 'updated',
    direction: 'desc',
    pageSize: 3,
  })
  assert.deepEqual(result.rows.map((row) => row.key), [
    'imported:gcoc-1',
    'canonical:gor-1',
    'imported:gcoc-2',
  ])
  assert.equal(result.canonicalConsumed, 1)
  assert.equal(result.importedConsumed, 2)
})

test('equal cross-source keys use a deterministic direction-aware source rank', () => {
  const shared = {
    canonical: [{ row: canonical('gor-1'), evidence: evidence('c1', 'alpha') }],
    imported: [{ row: imported('gcoc-1'), evidence: evidence('i1', 'alpha') }],
    sort: 'customer' as const,
    pageSize: 2,
  }
  assert.deepEqual(
    mergeUnifiedOperationsOrderPage({ ...shared, direction: 'asc' })
      .rows.map((row) => row.kind),
    ['canonical', 'imported'],
  )
  assert.deepEqual(
    mergeUnifiedOperationsOrderPage({ ...shared, direction: 'desc' })
      .rows.map((row) => row.kind),
    ['imported', 'canonical'],
  )
})

test('provider identity overlap fails closed before rows are displayed', () => {
  const providerIdentity = {
    integrationAccountGlobalId: 'gia1234567',
    externalOrderId: 'provider-order-1',
  }
  assert.throws(
    () => mergeUnifiedOperationsOrderPage({
      canonical: [{
        row: canonical('gor-1'),
        evidence: evidence('c1', '1001', providerIdentity),
      }],
      imported: [{
        row: imported('gcoc-1'),
        evidence: evidence('i1', '1002', providerIdentity),
      }],
      sort: 'order_number',
      direction: 'asc',
      pageSize: 25,
    }),
    (error: unknown) => (
      error instanceof UnifiedOperationsOrderPageError
      && error.code === 'OPERATIONS_UNIFIED_ORDER_DUPLICATE_PROVIDER_IDENTITY'
    ),
  )
})

test('shared comparator validates timestamps and uses UTF-8 byte order for text', () => {
  assert.equal(compareUnifiedOperationsOrderSortValues({
    left: '2026-09-01T12:00:00.000Z',
    right: '2026-09-01T13:00:00.000Z',
    sort: 'updated',
    direction: 'asc',
  }), -1)
  assert.equal(compareUnifiedOperationsOrderSortValues({
    left: 'alpha',
    right: 'beta',
    sort: 'customer',
    direction: 'desc',
  }) > 0, true)
  assert.throws(() => compareUnifiedOperationsOrderSortValues({
    left: 'not-a-date',
    right: '2026-09-01T13:00:00.000Z',
    sort: 'updated',
    direction: 'asc',
  }), /invalid timestamp evidence/u)
})
