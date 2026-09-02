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

export function compareUnifiedOperationsOrderSortValues(input: {
  left: string
  right: string
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
}) {
  let comparison: number
  if (input.sort === 'updated') {
    const left = Date.parse(input.left)
    const right = Date.parse(input.right)
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      throw new UnifiedOperationsOrderPageError(
        'OPERATIONS_UNIFIED_ORDER_SORT_EVIDENCE_INVALID',
        'Unified order pagination received invalid timestamp evidence',
      )
    }
    comparison = left === right ? 0 : left < right ? -1 : 1
  } else {
    comparison = compareUtf8(input.left, input.right)
  }
  return input.direction === 'asc' ? comparison : -comparison
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
    const primaryComparison = compareUnifiedOperationsOrderSortValues({
      left: canonical.evidence.sortValue,
      right: imported.evidence.sortValue,
      sort: input.sort,
      direction: input.direction,
    })
    // A source rank makes equal primary keys deterministic without changing
    // either source reader's own UUID-backed keyset order.
    const comparison = primaryComparison || (input.direction === 'asc' ? -1 : 1)
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
