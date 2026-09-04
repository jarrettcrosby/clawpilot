export const OPERATIONS_ORDER_SORTS = [
  'updated',
  'order_date',
  'order_number',
  'customer',
  'status',
  'provider',
  'tracking',
] as const

// SQL caps text sort keys so even 4-byte Unicode code points fit after JSON
// and base64url expansion.
export const OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS = 500
export const OPERATIONS_ORDER_PAGE_CURSOR_MAX_LENGTH = 4096

export type OperationsOrderSort = (typeof OPERATIONS_ORDER_SORTS)[number]

export const OPERATIONS_ORDER_SORT_DIRECTIONS = ['asc', 'desc'] as const

export type OperationsOrderSortDirection =
  (typeof OPERATIONS_ORDER_SORT_DIRECTIONS)[number]

export const OPERATIONS_ORDER_TRACKING_FILTERS = ['present', 'missing'] as const

export type OperationsOrderTrackingFilter =
  (typeof OPERATIONS_ORDER_TRACKING_FILTERS)[number]

const ORDER_PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/u

export function isOperationsOrderSort(
  value: string,
): value is OperationsOrderSort {
  return (OPERATIONS_ORDER_SORTS as readonly string[]).includes(value)
}

export function isOperationsOrderSortDirection(
  value: string,
): value is OperationsOrderSortDirection {
  return (
    OPERATIONS_ORDER_SORT_DIRECTIONS as readonly string[]
  ).includes(value)
}

export function isOperationsOrderTrackingFilter(
  value: string,
): value is OperationsOrderTrackingFilter {
  return (
    OPERATIONS_ORDER_TRACKING_FILTERS as readonly string[]
  ).includes(value)
}

export function isOperationsOrderProviderFilter(value: string) {
  return ORDER_PROVIDER.test(value)
}

export function isOperationsImportedOrderProviderFilter(
  value: string,
): value is 'shopify' | 'faire' {
  return value === 'shopify' || value === 'faire'
}

export function isOperationsOrderUpdatedAfter(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false
  }
  // PostgreSQL rejects ISO year 0000 when this value is cast to timestamptz.
  if (value.startsWith('0000-')) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}

export function isOperationsOrderCursorSortValue(
  value: unknown,
  sort: OperationsOrderSort,
) {
  if (typeof value !== 'string') return false
  if (sort === 'updated' || sort === 'order_date') {
    return isOperationsOrderUpdatedAfter(value)
  }
  // PostgreSQL text cannot contain NUL. Reject it before the value is bound,
  // and reject malformed surrogate pairs that would not round-trip through
  // UTF-8 as the same cursor tuple.
  if (value.includes('\u0000')) return false
  let codePoints = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
    codePoints += 1
    if (codePoints > OPERATIONS_ORDER_SORT_KEY_MAX_CHARACTERS) return false
  }
  return true
}
