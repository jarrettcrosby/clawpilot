import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UnifiedOperationsOrderPageError,
  compareUnifiedOperationsOrderSortValues,
  mergeUnifiedOperationsOrderPage,
  seekUnifiedOperationsOrderPartition,
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

test('direct-page seek finds the exact two-source partition', async () => {
  const canonical = ['001', '003', '005', '007', '009']
    .map((value, index) => evidence(`c-${index}`, value))
  const imported = ['002', '004', '006', '008', '010']
    .map((value, index) => evidence(`i-${index}`, value))
  const result = await seekUnifiedOperationsOrderPartition({
    canonicalTotal: canonical.length,
    importedTotal: imported.length,
    offset: 7,
    sort: 'order_number',
    direction: 'asc',
    canonicalAt: async (offset) => canonical[offset],
    importedAt: async (offset) => imported[offset],
  })
  assert.equal(result.canonicalOffset, 4)
  assert.equal(result.importedOffset, 3)
  assert.equal(result.canonicalBefore?.rowCursor, 'c-3')
  assert.equal(result.importedBefore?.rowCursor, 'i-2')
})

test('direct-page seek applies the merge source rank to equal keys', async () => {
  const canonical = [evidence('c-0', 'same'), evidence('c-1', 'same')]
  const imported = [evidence('i-0', 'same'), evidence('i-1', 'same')]
  const shared = {
    canonicalTotal: canonical.length,
    importedTotal: imported.length,
    offset: 2,
    sort: 'customer' as const,
    canonicalAt: async (offset: number) => canonical[offset],
    importedAt: async (offset: number) => imported[offset],
  }
  const ascending = await seekUnifiedOperationsOrderPartition({
    ...shared,
    direction: 'asc',
  })
  assert.deepEqual(
    [ascending.canonicalOffset, ascending.importedOffset],
    [2, 0],
  )
  const descending = await seekUnifiedOperationsOrderPartition({
    ...shared,
    direction: 'desc',
  })
  assert.deepEqual(
    [descending.canonicalOffset, descending.importedOffset],
    [0, 2],
  )
})

test('direct-page seek uses logarithmic source probes', async () => {
  const totalPerSource = 4096
  let probes = 0
  const at = async (source: 'c' | 'i', offset: number) => {
    probes += 1
    const sortValue = String((offset * 2) + (source === 'c' ? 0 : 1))
      .padStart(8, '0')
    return evidence(`${source}-${offset}`, sortValue)
  }
  const result = await seekUnifiedOperationsOrderPartition({
    canonicalTotal: totalPerSource,
    importedTotal: totalPerSource,
    offset: 7000,
    sort: 'order_number',
    direction: 'asc',
    canonicalAt: (offset) => at('c', offset),
    importedAt: (offset) => at('i', offset),
  })
  assert.deepEqual(
    [result.canonicalOffset, result.importedOffset],
    [3500, 3500],
  )
  assert.ok(probes <= 52, `Expected logarithmic probes, received ${probes}`)
})

test('direct-page partitions match the merge for every small offset', async () => {
  for (const scenario of [
    {
      direction: 'asc' as const,
      canonicalValues: ['a', 'b', 'b', 'd'],
      importedValues: ['a', 'b', 'c', 'd'],
    },
    {
      direction: 'desc' as const,
      canonicalValues: ['d', 'b', 'b', 'a'],
      importedValues: ['d', 'c', 'b', 'a'],
    },
  ]) {
    const canonicalEvidence = scenario.canonicalValues.map((value, index) => (
      evidence(`c-${index}`, value)
    ))
    const importedEvidence = scenario.importedValues.map((value, index) => (
      evidence(`i-${index}`, value)
    ))
    const merged = mergeUnifiedOperationsOrderPage({
      canonical: canonicalEvidence.map((item, index) => ({
        row: canonical(`gor-${index}`),
        evidence: item,
      })),
      imported: importedEvidence.map((item, index) => ({
        row: imported(`gcoc-${index}`),
        evidence: item,
      })),
      sort: 'customer',
      direction: scenario.direction,
      pageSize: canonicalEvidence.length + importedEvidence.length,
    })
    for (let offset = 0; offset <= merged.rows.length; offset += 1) {
      const expectedCanonical = merged.rows.slice(0, offset)
        .filter((row) => row.kind === 'canonical').length
      const partition = await seekUnifiedOperationsOrderPartition({
        canonicalTotal: canonicalEvidence.length,
        importedTotal: importedEvidence.length,
        offset,
        sort: 'customer',
        direction: scenario.direction,
        canonicalAt: async (index) => canonicalEvidence[index],
        importedAt: async (index) => importedEvidence[index],
      })
      assert.equal(partition.canonicalOffset, expectedCanonical)
      assert.equal(partition.importedOffset, offset - expectedCanonical)
    }
  }
})

test('direct-page seek rejects unsafe combined source totals', async () => {
  await assert.rejects(
    seekUnifiedOperationsOrderPartition({
      canonicalTotal: Number.MAX_SAFE_INTEGER,
      importedTotal: 1,
      offset: 0,
      sort: 'updated',
      direction: 'desc',
      canonicalAt: async () => evidence('c', '2026-09-01T12:00:00.000Z'),
      importedAt: async () => evidence('i', '2026-09-01T12:00:00.000Z'),
    }),
    (error: unknown) => (
      error instanceof UnifiedOperationsOrderPageError
      && error.code === 'OPERATIONS_UNIFIED_ORDER_OFFSET_INVALID'
    ),
  )
})
