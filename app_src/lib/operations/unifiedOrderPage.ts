import { Buffer } from 'node:buffer'
import type {
  OperationsImportedOrderWorkingCopy,
  OperationsOrderListItem,
  OperationsOrderStatus,
} from './types'
import type {
  OperationsOrderSortDirection,
  OperationsOrderTrackingFilter,
} from './orderListQuery'

export const UNIFIED_OPERATIONS_ORDER_SORTS = [
  'updated',
  'order_date',
  'order_number',
  'customer',
] as const

export const MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE = 100
export const MAX_UNIFIED_OPERATIONS_ORDER_CURSOR_LENGTH = 16_384
export const EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION =
  'd41d8cd98f00b204e9800998ecf8427e'

export type UnifiedOperationsOrderSort =
  (typeof UNIFIED_OPERATIONS_ORDER_SORTS)[number]

export type UnifiedOperationsOrderStatus =
  | OperationsOrderStatus
  | 'fulfilled_externally'
  | 'closed_externally'

export type OperationsOrderProviderIdentity = {
  integrationAccountGlobalId: string
  externalOrderId: string
}

export type OperationsOrderSourceEvidence = {
  rowCursor: string
  sortValue: string
  providerIdentity: OperationsOrderProviderIdentity | null
  provider?: string
}

export type UnifiedOperationsOrderRow =
  | {
      kind: 'canonical'
      key: string
      order: OperationsOrderListItem
    }
  | {
      kind: 'imported'
      key: string
      order: OperationsImportedOrderWorkingCopy
    }

export type UnifiedOperationsOrderPage = {
  total: number
  returned: number
  pageSize: number
  offset: number
  nextCursor: string | null
  complete: boolean
  truncated: boolean
  /** Opaque result-set fence for direct numbered-page navigation. */
  snapshot: string | null
}

export type UnifiedOperationsOrderPageInput = {
  organizationId: string
  search?: string | null
  status?: UnifiedOperationsOrderStatus | null
  sort?: UnifiedOperationsOrderSort | null
  direction?: OperationsOrderSortDirection | null
  provider?: string | null
  tracking?: OperationsOrderTrackingFilter | null
  updatedAfter?: string | null
  cursor?: string | null
  /** One-based direct page request. Mutually exclusive with cursor. */
  page?: number | null
  /** Opaque result-set fence returned by the first direct page read. */
  snapshot?: string | null
  pageSize?: number | null
}

type MergeSourceRow = {
  row: UnifiedOperationsOrderRow
  evidence: OperationsOrderSourceEvidence
}

export type UnifiedOperationsOrderMergeInput = {
  canonical: MergeSourceRow[]
  imported: MergeSourceRow[]
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
  pageSize: number
}

export type UnifiedOperationsOrderMergeResult = {
  rows: UnifiedOperationsOrderRow[]
  canonicalConsumed: number
  importedConsumed: number
}

export class UnifiedOperationsOrderPageError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'UnifiedOperationsOrderPageError'
    this.code = code
  }
}

export function isUnifiedOperationsOrderSort(
  value: string,
): value is UnifiedOperationsOrderSort {
  return (UNIFIED_OPERATIONS_ORDER_SORTS as readonly string[]).includes(value)
}

function compareUtf8(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function orderProviderRank(value: string | null | undefined) {
  const provider = String(value || '').trim().toLowerCase()
  if (provider === 'shopify') return 0
  if (provider === 'faire') return 1
  return 2
}

function normalizedShopifyOrderNumber(value: string) {
  const normalized = value.trim().replace(/^#/u, '')
  return /^\d+$/u.test(normalized)
    ? normalized.replace(/^0+(?=\d)/u, '')
    : null
}

function compareNaturalOrderNumber(input: {
  left: string
  right: string
  leftProvider?: string | null
  rightProvider?: string | null
}) {
  const providerComparison = orderProviderRank(input.leftProvider)
    - orderProviderRank(input.rightProvider)
  if (providerComparison) return providerComparison
  if (orderProviderRank(input.leftProvider) === 0) {
    const leftNumber = normalizedShopifyOrderNumber(input.left)
    const rightNumber = normalizedShopifyOrderNumber(input.right)
    if (leftNumber && rightNumber) {
      if (leftNumber.length !== rightNumber.length) {
        return leftNumber.length < rightNumber.length ? -1 : 1
      }
      const numericComparison = compareUtf8(leftNumber, rightNumber)
      if (numericComparison) return numericComparison
    } else if (leftNumber || rightNumber) {
      return leftNumber ? -1 : 1
    }
  }
  return compareUtf8(input.left.toLowerCase(), input.right.toLowerCase())
}

export function compareUnifiedOperationsOrderSortValues(input: {
  left: string
  right: string
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
  leftProvider?: string | null
  rightProvider?: string | null
}) {
  let comparison: number
  if (input.sort === 'updated' || input.sort === 'order_date') {
    const left = Date.parse(input.left)
    const right = Date.parse(input.right)
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_SORT_EVIDENCE_INVALID',
        'Unified order pagination received invalid timestamp evidence',
      )
    }
    comparison = left === right ? 0 : left < right ? -1 : 1
  } else if (input.sort === 'order_number') {
    comparison = compareNaturalOrderNumber({
      left: input.left,
      right: input.right,
      leftProvider: input.leftProvider,
      rightProvider: input.rightProvider,
    })
    const providerComparison = orderProviderRank(input.leftProvider)
      - orderProviderRank(input.rightProvider)
    if (providerComparison) return providerComparison
  } else {
    comparison = compareUtf8(input.left, input.right)
  }
  return input.direction === 'asc' ? comparison : -comparison
}

function compareUnifiedOperationsOrderSourceEvidence(input: {
  left: OperationsOrderSourceEvidence
  leftSource: 'canonical' | 'imported'
  right: OperationsOrderSourceEvidence
  rightSource: 'canonical' | 'imported'
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
}) {
  const primaryComparison = compareUnifiedOperationsOrderSortValues({
    left: input.left.sortValue,
    right: input.right.sortValue,
    sort: input.sort,
    direction: input.direction,
    leftProvider: input.left.provider,
    rightProvider: input.right.provider,
  })
  if (primaryComparison || input.leftSource === input.rightSource) {
    return primaryComparison
  }
  return input.leftSource === 'canonical' ? -1 : 1
}

function identityKey(identity: OperationsOrderProviderIdentity) {
  return `${identity.integrationAccountGlobalId}\u0000${identity.externalOrderId}`
}

function assertNoCrossSourceProviderIdentityOverlap(input: {
  canonical: MergeSourceRow[]
  imported: MergeSourceRow[]
}) {
  const canonicalIdentities = new Set<string>()
  for (const item of input.canonical) {
    if (item.evidence.providerIdentity) {
      canonicalIdentities.add(identityKey(item.evidence.providerIdentity))
    }
  }
  for (const item of input.imported) {
    const identity = item.evidence.providerIdentity
    if (identity && canonicalIdentities.has(identityKey(identity))) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_DUPLICATE_PROVIDER_IDENTITY',
        'A provider order appeared in both canonical and imported order results',
      )
    }
  }
}

function validateSourceRows(source: string, rows: MergeSourceRow[]) {
  const rowKeys = new Set<string>()
  const rowCursors = new Set<string>()
  const providerIdentities = new Set<string>()
  for (const item of rows) {
    if (!item.evidence.rowCursor) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
        `${source} order pagination did not provide a row cursor`,
      )
    }
    if (rowCursors.has(item.evidence.rowCursor)) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
        `${source} order pagination returned a repeated row cursor`,
      )
    }
    rowCursors.add(item.evidence.rowCursor)
    if (rowKeys.has(item.row.key)) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_DUPLICATE_ROW',
        `${source} order pagination returned a duplicate row`,
      )
    }
    rowKeys.add(item.row.key)
    if (item.evidence.providerIdentity) {
      const key = identityKey(item.evidence.providerIdentity)
      if (providerIdentities.has(key)) {
        throw new UnifiedOperationsOrderPageError(
          'OPERATIONS_UNIFIED_ORDER_DUPLICATE_PROVIDER_IDENTITY',
          `${source} order pagination returned a duplicate provider identity`,
        )
      }
      providerIdentities.add(key)
    }
  }
}

export function mergeUnifiedOperationsOrderPage(
  input: UnifiedOperationsOrderMergeInput,
): UnifiedOperationsOrderMergeResult {
  if (
    !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1
    || input.pageSize > MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE
  ) {
    throw new UnifiedOperationsOrderPageError(
      'OPERATIONS_UNIFIED_ORDER_PAGE_SIZE_INVALID',
      'Unified order page size is invalid',
    )
  }
  validateSourceRows('Canonical', input.canonical)
  validateSourceRows('Imported', input.imported)
  assertNoCrossSourceProviderIdentityOverlap(input)

  const rows: UnifiedOperationsOrderRow[] = []
  let canonicalConsumed = 0
  let importedConsumed = 0
  while (rows.length < input.pageSize) {
    const canonical = input.canonical[canonicalConsumed]
    const imported = input.imported[importedConsumed]
    if (!canonical && !imported) break
    if (!canonical) {
      rows.push(imported.row)
      importedConsumed += 1
      continue
    }
    if (!imported) {
      rows.push(canonical.row)
      canonicalConsumed += 1
      continue
    }
    const comparison = compareUnifiedOperationsOrderSourceEvidence({
      left: canonical.evidence,
      leftSource: 'canonical',
      right: imported.evidence,
      rightSource: 'imported',
      sort: input.sort,
      direction: input.direction,
    })
    if (comparison <= 0) {
      rows.push(canonical.row)
      canonicalConsumed += 1
    } else {
      rows.push(imported.row)
      importedConsumed += 1
    }
  }
  return { rows, canonicalConsumed, importedConsumed }
}
