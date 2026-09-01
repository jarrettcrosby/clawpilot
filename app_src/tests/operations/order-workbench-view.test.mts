import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterAndSortOperationsOrderRows,
  operationsOrderRowStatus,
  operationsOrderSavedViewCounts,
  operationsOrderWorkbenchRows,
} from '../../lib/operations/orderWorkbenchView.ts'
import type {
  OperationsImportedOrderWorkingCopy,
  OperationsOrderListItem,
} from '../../lib/operations/types.ts'

function canonical(
  overrides: Partial<OperationsOrderListItem>,
): OperationsOrderListItem {
  return {
    id: '1',
    globalId: 'gor0000001',
    orderNumber: '#1001',
    customerName: 'Customer',
    customerGlobalId: 'ga0000001',
    sourceProvider: 'shopify',
    currency: 'USD',
    status: 'imported',
    externallyFulfilled: false,
    warehouseName: null,
    promisedDeliveryAt: null,
    lineCount: 1,
    exceptionCount: 0,
    orderValueMinor: '1000',
    expectedCostMinor: null,
    expectedRevenueMinor: '1000',
    expectedMarginMinor: null,
    trackingNumber: null,
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...overrides,
  }
}

function imported(
  overrides: Partial<OperationsImportedOrderWorkingCopy>,
): OperationsImportedOrderWorkingCopy {
  return {
    kind: 'imported_working_copy',
    globalId: 'goc0000001',
    candidateGlobalId: 'goc0000001',
    canonicalOrderGlobalId: null,
    integrationAccountGlobalId: 'gia0000001',
    integrationAccountName: 'Store',
    provider: 'shopify',
    externalOrderId: '1',
    orderNumber: '#1002',
    status: 'imported',
    providerState: {
      lifecycle: 'open',
      fulfillment: 'unfulfilled',
      observedAt: '2026-09-01T13:00:00.000Z',
      source: 'operational',
    },
    needsInfo: false,
    blockerCodes: [],
    customerName: 'Customer',
    lineCount: 1,
    sourceUpdatedAt: '2026-09-01T13:00:00.000Z',
    updatedAt: '2026-09-01T13:00:00.000Z',
    trackingNumber: null,
    orderValueMinor: '2000',
    currency: 'USD',
    candidateRowVersion: 1,
    workflowState: 'ready',
    actionAvailable: true,
    rowVersion: 1,
    providerVersionChanged: false,
    resolutionDetailsLoaded: false,
    customer: {
      status: 'resolved',
      resolvedCustomerGlobalId: 'ga0000001',
      selectedCustomerGlobalId: 'ga0000001',
      options: [],
    },
    delivery: {
      status: 'not_supplied',
      providerRequestedDeliveryAt: null,
      selectedDeliveryAt: null,
      draftDeliveryAt: null,
    },
    lines: [],
    providerHistory: {
      observedAt: null,
      currentLines: [],
      events: [],
      providerWrites: 0,
    },
    productOptions: [],
    shipTo: {
      value: {
        name: '',
        line1: '',
        line2: '',
        city: '',
        region: '',
        postalCode: '',
        country: '',
      },
      readiness: 'missing',
      provenance: 'provider',
      syncStatus: 'provider_snapshot',
      issues: [],
    },
    providerWrites: 0,
    ...overrides,
  }
}

test('saved views separate attention from terminal provider history', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [canonical({ exceptionCount: 1 })],
    imported: [imported({
      providerState: {
        lifecycle: 'closed',
        fulfillment: 'fulfilled',
        observedAt: '2026-09-01T13:00:00.000Z',
        source: 'history',
      },
      needsInfo: true,
    })],
  })
  assert.deepEqual(operationsOrderSavedViewCounts(rows), {
    attention: 1,
    ready: 0,
    in_progress: 0,
    external_history: 1,
    cancelled: 0,
    all: 2,
  })
})

test('global sorting interleaves imported and canonical rows', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [canonical({ orderNumber: '#1001', updatedAt: '2026-09-01T14:00:00.000Z' })],
    imported: [imported({ orderNumber: '#1002', updatedAt: '2026-09-01T15:00:00.000Z' })],
  })
  const sorted = filterAndSortOperationsOrderRows({
    rows,
    view: 'all',
    sort: 'updated_desc',
    provider: '',
    tracking: 'all',
    date: 'all',
    warehouse: '',
  })
  assert.deepEqual(sorted.map((row) => row.order.orderNumber), ['#1002', '#1001'])
})

test('value sorting uses imported summary totals without loading line details', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [canonical({ orderValueMinor: '1000' })],
    imported: [imported({ orderValueMinor: '2000', lines: [] })],
  })
  const sorted = filterAndSortOperationsOrderRows({
    rows,
    view: 'all',
    sort: 'value_desc',
    provider: '',
    tracking: 'all',
    date: 'all',
    warehouse: '',
  })
  assert.deepEqual(sorted.map((row) => row.order.orderNumber), ['#1002', '#1001'])
})

test('value sorting partitions currencies before comparing minor-unit totals', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [canonical({
      orderNumber: '#1001',
      currency: 'USD',
      orderValueMinor: '999999',
    })],
    imported: [imported({
      orderNumber: '#1002',
      currency: 'JPY',
      orderValueMinor: '100',
    })],
  })
  const sorted = filterAndSortOperationsOrderRows({
    rows,
    view: 'all',
    sort: 'value_desc',
    provider: '',
    tracking: 'all',
    date: 'all',
    warehouse: '',
  })
  assert.deepEqual(sorted.map((row) => row.order.orderNumber), ['#1002', '#1001'])
})

test('closed but unfulfilled provider orders remain distinct from fulfilled history', () => {
  const [row] = operationsOrderWorkbenchRows({
    canonical: [],
    imported: [imported({
      providerState: {
        lifecycle: 'closed',
        fulfillment: 'unfulfilled',
        observedAt: '2026-09-01T13:00:00.000Z',
        source: 'history',
      },
    })],
  })
  assert.ok(row)
  assert.equal(operationsOrderRowStatus(row), 'closed_externally')
  assert.equal(filterAndSortOperationsOrderRows({
    rows: [row],
    view: 'external_history',
    sort: 'updated_desc',
    provider: '',
    tracking: 'all',
    date: 'all',
    warehouse: '',
    status: 'fulfilled_externally',
  }).length, 0)
  assert.equal(filterAndSortOperationsOrderRows({
    rows: [row],
    view: 'external_history',
    sort: 'updated_desc',
    provider: '',
    tracking: 'all',
    date: 'all',
    warehouse: '',
    status: 'closed_externally',
  }).length, 1)
})

test('externally reconciled canonical orders are history, not cancellations', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [canonical({
      status: 'cancelled',
      externallyFulfilled: true,
    })],
    imported: [],
  })
  assert.deepEqual(operationsOrderSavedViewCounts(rows), {
    attention: 0,
    ready: 0,
    in_progress: 0,
    external_history: 1,
    cancelled: 0,
    all: 1,
  })
})

test('retained failed or expired working copies cannot appear ready to fulfill', () => {
  for (const workflowState of ['failed', 'expired'] as const) {
    const rows = operationsOrderWorkbenchRows({
      canonical: [],
      imported: [imported({
        workflowState,
        actionAvailable: false,
        needsInfo: false,
      })],
    })
    assert.deepEqual(operationsOrderSavedViewCounts(rows), {
      attention: 1,
      ready: 0,
      in_progress: 0,
      external_history: 0,
      cancelled: 0,
      all: 1,
    })
  }
})

test('elapsed retained working-copy evidence cannot appear ready to fulfill', () => {
  const rows = operationsOrderWorkbenchRows({
    canonical: [],
    imported: [imported({
      workflowState: 'ready',
      actionAvailable: false,
      needsInfo: false,
    })],
  })
  assert.equal(operationsOrderSavedViewCounts(rows).ready, 0)
  assert.equal(operationsOrderSavedViewCounts(rows).attention, 1)
})

test('provider, tracking, warehouse, and date filters compose', () => {
  const now = Date.parse('2026-09-01T16:00:00.000Z')
  const rows = operationsOrderWorkbenchRows({
    canonical: [
      canonical({
        orderNumber: '#1001',
        trackingNumber: '1Z123',
        warehouseName: 'AG Alchemy HQ',
        updatedAt: '2026-08-31T16:00:00.000Z',
      }),
      canonical({
        globalId: 'gor0000002',
        orderNumber: '#1000',
        sourceProvider: 'faire',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ],
    imported: [],
  })
  const filtered = filterAndSortOperationsOrderRows({
    rows,
    view: 'all',
    sort: 'updated_desc',
    provider: 'shopify',
    tracking: 'present',
    date: '7d',
    warehouse: 'AG Alchemy HQ',
    now,
  })
  assert.deepEqual(filtered.map((row) => row.order.orderNumber), ['#1001'])
})
