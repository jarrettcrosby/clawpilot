import type {
  OperationsImportedOrderWorkingCopy,
  OperationsOrderListItem,
  OperationsOrderStatus,
} from './types'

export type OperationsOrderSavedView =
  | 'attention'
  | 'ready'
  | 'in_progress'
  | 'external_history'
  | 'cancelled'
  | 'all'

export type OperationsOrderSort =
  | 'priority'
  | 'updated_desc'
  | 'updated_asc'
  | 'order_asc'
  | 'order_desc'
  | 'customer_asc'
  | 'promise_asc'
  | 'value_desc'
  | 'lines_desc'

export type OperationsOrderDateFilter = 'all' | '7d' | '30d' | '90d'
export type OperationsOrderTrackingFilter = 'all' | 'present' | 'missing'
export type OperationsOrderStatusFilter =
  | ''
  | OperationsOrderStatus
  | 'fulfilled_externally'
  | 'closed_externally'

export type OperationsOrderWorkbenchRow =
  | {
      kind: 'imported'
      key: string
      order: OperationsImportedOrderWorkingCopy
    }
  | {
      kind: 'canonical'
      key: string
      order: OperationsOrderListItem
    }

export const OPERATIONS_ORDER_SAVED_VIEWS: Array<{
  value: OperationsOrderSavedView
  label: string
}> = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'ready', label: 'Ready to fulfill' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'external_history', label: 'External history' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All orders' },
]

export function operationsOrderWorkbenchRows(input: {
  imported: OperationsImportedOrderWorkingCopy[]
  canonical: OperationsOrderListItem[]
}) {
  return [
    ...input.imported.map((order): OperationsOrderWorkbenchRow => ({
      kind: 'imported',
      key: `imported:${order.candidateGlobalId}`,
      order,
    })),
    ...input.canonical.map((order): OperationsOrderWorkbenchRow => ({
      kind: 'canonical',
      key: `canonical:${order.globalId}`,
      order,
    })),
  ]
}

export function operationsOrderRowProvider(row: OperationsOrderWorkbenchRow) {
  return row.kind === 'imported'
    ? row.order.provider
    : row.order.sourceProvider.toLocaleLowerCase()
}

export function operationsOrderRowUpdatedAt(row: OperationsOrderWorkbenchRow) {
  return row.order.updatedAt
}

export function operationsOrderRowTracking(row: OperationsOrderWorkbenchRow) {
  return row.order.trackingNumber
}

export function operationsOrderRowWarehouse(row: OperationsOrderWorkbenchRow) {
  return row.kind === 'canonical' ? row.order.warehouseName : null
}

export function operationsOrderRowStatus(row: OperationsOrderWorkbenchRow) {
  if (row.kind === 'canonical') {
    return row.order.externallyFulfilled
      ? 'fulfilled_externally'
      : row.order.status
  }
  if (
    row.order.providerState.lifecycle === 'cancelled'
    || row.order.providerState.fulfillment === 'cancelled'
  ) return 'cancelled'
  if (row.order.providerState.fulfillment === 'fulfilled') {
    return 'fulfilled_externally'
  }
  if (row.order.providerState.lifecycle === 'closed') return 'closed_externally'
  return 'imported'
}

export function operationsOrderRowNeedsAttention(row: OperationsOrderWorkbenchRow) {
  if (row.kind === 'imported') {
    return !operationsImportedOrderIsTerminal(row.order)
      && (
        row.order.needsInfo
        || !operationsImportedOrderIsActionable(row.order)
      )
  }
  return row.order.exceptionCount > 0
    || row.order.status === 'held'
    || row.order.status === 'exception'
}

export function operationsImportedOrderIsTerminal(
  order: OperationsImportedOrderWorkingCopy,
) {
  return order.providerState.lifecycle === 'closed'
    || order.providerState.lifecycle === 'cancelled'
    || order.providerState.fulfillment === 'fulfilled'
    || order.providerState.fulfillment === 'cancelled'
}

export function operationsImportedOrderIsActionable(
  order: OperationsImportedOrderWorkingCopy,
) {
  return order.actionAvailable
}

export function operationsOrderRowMatchesSavedView(
  row: OperationsOrderWorkbenchRow,
  view: OperationsOrderSavedView,
) {
  if (view === 'all') return true
  if (view === 'attention') return operationsOrderRowNeedsAttention(row)
  if (view === 'cancelled') {
    return row.kind === 'imported'
      ? row.order.providerState.lifecycle === 'cancelled'
        || row.order.providerState.fulfillment === 'cancelled'
      : row.order.status === 'cancelled' && !row.order.externallyFulfilled
  }
  if (view === 'external_history') {
    return row.kind === 'imported'
      ? operationsImportedOrderIsTerminal(row.order)
        && row.order.providerState.lifecycle !== 'cancelled'
        && row.order.providerState.fulfillment !== 'cancelled'
      : row.order.externallyFulfilled
  }
  if (view === 'in_progress') {
    return row.kind === 'imported'
      ? !operationsImportedOrderIsTerminal(row.order)
        && operationsImportedOrderIsActionable(row.order)
        && ['partial', 'on_hold', 'scheduled'].includes(
          row.order.providerState.fulfillment,
        )
      : ['planned', 'released', 'picking', 'packed'].includes(row.order.status)
  }
  if (operationsOrderRowNeedsAttention(row)) return false
  if (row.kind === 'imported') {
    return !operationsImportedOrderIsTerminal(row.order)
      && operationsImportedOrderIsActionable(row.order)
      && !row.order.needsInfo
      && !['partial', 'on_hold', 'scheduled'].includes(
        row.order.providerState.fulfillment,
      )
  }
  return !row.order.externallyFulfilled
    && ['imported', 'validated', 'promised', 'reserved'].includes(row.order.status)
}

function milliseconds(value: string | null | undefined) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

function textCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function rowOrderNumber(row: OperationsOrderWorkbenchRow) {
  return row.order.orderNumber
}

function rowCustomer(row: OperationsOrderWorkbenchRow) {
  return row.order.customerName || ''
}

function rowPromise(row: OperationsOrderWorkbenchRow) {
  return row.kind === 'canonical'
    ? milliseconds(row.order.promisedDeliveryAt)
    : milliseconds(row.order.delivery.selectedDeliveryAt)
}

function rowValue(row: OperationsOrderWorkbenchRow) {
  const parsed = Number(row.order.orderValueMinor)
  return row.order.orderValueMinor !== null && Number.isFinite(parsed)
    ? parsed
    : null
}

function rowCurrency(row: OperationsOrderWorkbenchRow) {
  return row.order.currency.trim().toLocaleUpperCase()
}

function priority(row: OperationsOrderWorkbenchRow) {
  if (operationsOrderRowNeedsAttention(row)) return 0
  if (operationsOrderRowMatchesSavedView(row, 'ready')) return 1
  if (operationsOrderRowMatchesSavedView(row, 'in_progress')) return 2
  if (operationsOrderRowMatchesSavedView(row, 'external_history')) return 4
  if (operationsOrderRowMatchesSavedView(row, 'cancelled')) return 5
  return 3
}

function compareNullableNumber(
  left: number | null,
  right: number | null,
  direction: 'asc' | 'desc',
) {
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return direction === 'asc' ? left - right : right - left
}

export function compareOperationsOrderRows(
  left: OperationsOrderWorkbenchRow,
  right: OperationsOrderWorkbenchRow,
  sort: OperationsOrderSort,
) {
  let comparison = 0
  if (sort === 'priority') {
    comparison = priority(left) - priority(right)
      || compareNullableNumber(
        milliseconds(operationsOrderRowUpdatedAt(left)),
        milliseconds(operationsOrderRowUpdatedAt(right)),
        'desc',
      )
  } else if (sort === 'updated_desc' || sort === 'updated_asc') {
    comparison = compareNullableNumber(
      milliseconds(operationsOrderRowUpdatedAt(left)),
      milliseconds(operationsOrderRowUpdatedAt(right)),
      sort === 'updated_asc' ? 'asc' : 'desc',
    )
  } else if (sort === 'order_asc' || sort === 'order_desc') {
    comparison = textCompare(rowOrderNumber(left), rowOrderNumber(right))
      * (sort === 'order_desc' ? -1 : 1)
  } else if (sort === 'customer_asc') {
    comparison = textCompare(rowCustomer(left), rowCustomer(right))
  } else if (sort === 'promise_asc') {
    comparison = compareNullableNumber(rowPromise(left), rowPromise(right), 'asc')
  } else if (sort === 'value_desc') {
    comparison = textCompare(rowCurrency(left), rowCurrency(right))
      || compareNullableNumber(rowValue(left), rowValue(right), 'desc')
  } else if (sort === 'lines_desc') {
    comparison = right.order.lineCount - left.order.lineCount
  }
  return comparison || textCompare(left.key, right.key)
}

export function filterAndSortOperationsOrderRows(input: {
  rows: OperationsOrderWorkbenchRow[]
  view: OperationsOrderSavedView
  sort: OperationsOrderSort
  provider: string
  tracking: OperationsOrderTrackingFilter
  date: OperationsOrderDateFilter
  warehouse: string
  status?: OperationsOrderStatusFilter
  now?: number
}) {
  const now = input.now ?? Date.now()
  const days = input.date === 'all' ? null : Number(input.date.slice(0, -1))
  const cutoff = days ? now - (days * 24 * 60 * 60 * 1000) : null
  return input.rows.filter((row) => {
    if (!operationsOrderRowMatchesSavedView(row, input.view)) return false
    if (input.status && operationsOrderRowStatus(row) !== input.status) return false
    if (
      input.provider
      && operationsOrderRowProvider(row) !== input.provider.toLocaleLowerCase()
    ) return false
    const tracking = Boolean(operationsOrderRowTracking(row))
    if (input.tracking === 'present' && !tracking) return false
    if (input.tracking === 'missing' && tracking) return false
    if (input.warehouse) {
      const warehouse = operationsOrderRowWarehouse(row) || ''
      if (warehouse !== input.warehouse) return false
    }
    if (cutoff !== null) {
      const updatedAt = milliseconds(operationsOrderRowUpdatedAt(row))
      if (updatedAt === null || updatedAt < cutoff) return false
    }
    return true
  }).sort((left, right) => compareOperationsOrderRows(left, right, input.sort))
}

export function operationsOrderSavedViewCounts(
  rows: OperationsOrderWorkbenchRow[],
) {
  return OPERATIONS_ORDER_SAVED_VIEWS.reduce<Record<OperationsOrderSavedView, number>>(
    (counts, view) => {
      counts[view.value] = rows.filter((row) => (
        operationsOrderRowMatchesSavedView(row, view.value)
      )).length
      return counts
    },
    {
      attention: 0,
      ready: 0,
      in_progress: 0,
      external_history: 0,
      cancelled: 0,
      all: 0,
    },
  )
}
