import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  isOperationsOrderProviderFilter,
  isOperationsOrderSortDirection,
  isOperationsOrderTrackingFilter,
  isOperationsOrderUpdatedAfter,
  type OperationsOrderSortDirection,
  type OperationsOrderTrackingFilter,
} from '@/lib/operations/orderListQuery'
import {
  EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION,
  MAX_UNIFIED_OPERATIONS_ORDER_CURSOR_LENGTH,
  MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE,
  UnifiedOperationsOrderPageError,
  isUnifiedOperationsOrderSort,
  mergeUnifiedOperationsOrderPage,
  seekUnifiedOperationsOrderPartition,
  type OperationsOrderSourceEvidence,
  type UnifiedOperationsOrderPage,
  type UnifiedOperationsOrderPageInput,
  type UnifiedOperationsOrderRow,
  type UnifiedOperationsOrderSort,
  type UnifiedOperationsOrderStatus,
} from '@/lib/operations/unifiedOrderPage'
import { readCommerceOrderWorkbenchPageFromPostgres } from './commerceOrderWorkbench'
import {
  OperationsRequestError,
  readOperationsOrderPageFromPostgres,
} from './operations'
import {
  getPostgresPool,
  normalizePostgresPersistenceError,
} from './postgres'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SOURCE_CURSOR = /^[A-Za-z0-9_-]{1,4096}$/u
const COMBINED_CURSOR = new RegExp(
  `^[A-Za-z0-9_-]{1,${MAX_UNIFIED_OPERATIONS_ORDER_CURSOR_LENGTH}}$`,
  'u',
)
const SCOPE_HASH = /^[0-9a-f]{64}$/u
const RESULT_SET_REVISION = /^[0-9a-f]{32}$/u
const UNIFIED_ORDER_STATUSES = new Set<UnifiedOperationsOrderStatus>([
  'fulfilled_externally',
  'closed_externally',
  'imported',
  'validated',
  'held',
  'promised',
  'reserved',
  'planned',
  'released',
  'picking',
  'packed',
  'shipped',
  'cancelled',
  'exception',
])

type SourceCursorState = {
  cursor: string | null
  done: boolean
  total: number
  revision: string
}

type CombinedCursor = {
  v: 2
  scopeHash: string
  offset: number
  total: number
  canonical: SourceCursorState
  imported: SourceCursorState
}

type NormalizedInput = {
  organizationId: string
  search: string
  status: UnifiedOperationsOrderStatus | null
  sort: UnifiedOperationsOrderSort
  direction: OperationsOrderSortDirection
  provider: string | null
  tracking: OperationsOrderTrackingFilter | null
  updatedAfter: string | null
  pageSize: number
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function normalizedInput(
  input: UnifiedOperationsOrderPageInput,
): NormalizedInput {
  const organizationId = String(input.organizationId || '').trim()
  if (!UUID.test(organizationId)) {
    requestError(
      'ACTIVE_ORGANIZATION_REQUIRED',
      'Select an active organization first',
      409,
    )
  }
  const search = String(input.search || '').trim()
  if (search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search)) {
    requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
  }
  const status = String(input.status || '').trim() || null
  if (
    status
    && !UNIFIED_ORDER_STATUSES.has(status as UnifiedOperationsOrderStatus)
  ) {
    requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
  }
  const sort = input.sort || 'updated'
  if (!isUnifiedOperationsOrderSort(sort)) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_SORT_INVALID',
      'Unified order sort is invalid',
    )
  }
  const direction = input.direction || 'desc'
  if (!isOperationsOrderSortDirection(direction)) {
    requestError(
      'OPERATIONS_ORDER_SORT_DIRECTION_INVALID',
      'Order sort direction is invalid',
    )
  }
  const provider = String(input.provider || '').trim() || null
  if (provider && !isOperationsOrderProviderFilter(provider)) {
    requestError(
      'OPERATIONS_ORDER_PROVIDER_INVALID',
      'Order provider is invalid',
    )
  }
  const tracking = input.tracking || null
  if (tracking && !isOperationsOrderTrackingFilter(tracking)) {
    requestError(
      'OPERATIONS_ORDER_TRACKING_FILTER_INVALID',
      'Order tracking filter is invalid',
    )
  }
  const updatedAfter = String(input.updatedAfter || '').trim() || null
  if (updatedAfter && !isOperationsOrderUpdatedAfter(updatedAfter)) {
    requestError(
      'OPERATIONS_ORDER_UPDATED_AFTER_INVALID',
      'Order updated-after value is invalid',
    )
  }
  const pageSize = input.pageSize ?? MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE
  if (
    !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || pageSize > MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE
  ) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_PAGE_SIZE_INVALID',
      'Unified order page size is invalid',
    )
  }
  return {
    organizationId,
    search,
    status: status as UnifiedOperationsOrderStatus | null,
    sort,
    direction,
    provider,
    tracking,
    updatedAfter,
    pageSize,
  }
}

function scopeHash(input: NormalizedInput) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function validSourceState(value: unknown): value is SourceCursorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<SourceCursorState>
  if (
    Object.keys(state).sort().join(',') !== 'cursor,done,revision,total'
  ) return false
  return (
    (state.cursor === null || (
      typeof state.cursor === 'string' && SOURCE_CURSOR.test(state.cursor)
    ))
    && typeof state.done === 'boolean'
    && (!state.done || state.cursor === null)
    && Number.isSafeInteger(state.total)
    && Number(state.total) >= 0
    && typeof state.revision === 'string'
    && RESULT_SET_REVISION.test(state.revision)
  )
}

function decodeCombinedCursor(
  value: string | null | undefined,
  expectedScopeHash: string,
): CombinedCursor | null {
  if (!value) return null
  if (!COMBINED_CURSOR.test(value)) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_CURSOR_INVALID',
      'The unified order cursor is invalid',
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_CURSOR_INVALID',
      'The unified order cursor is invalid',
    )
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_CURSOR_INVALID',
      'The unified order cursor is invalid',
    )
  }
  const cursor = decoded as Partial<CombinedCursor>
  const valid = (
    Object.keys(cursor).sort().join(',')
      === 'canonical,imported,offset,scopeHash,total,v'
    && cursor.v === 2
    && typeof cursor.scopeHash === 'string'
    && SCOPE_HASH.test(cursor.scopeHash)
    && cursor.scopeHash === expectedScopeHash
    && Number.isSafeInteger(cursor.offset)
    && Number(cursor.offset) >= 0
    && Number.isSafeInteger(cursor.total)
    && Number(cursor.total) > Number(cursor.offset)
    && validSourceState(cursor.canonical)
    && validSourceState(cursor.imported)
    && Number(cursor.total)
      === Number(cursor.canonical?.total) + Number(cursor.imported?.total)
  )
  if (!valid) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_CURSOR_INVALID',
      'The unified order cursor is invalid',
    )
  }
  return cursor as CombinedCursor
}

function encodeCombinedCursor(cursor: CombinedCursor) {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  if (encoded.length > MAX_UNIFIED_OPERATIONS_ORDER_CURSOR_LENGTH) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_EVIDENCE_INVALID',
      'Unified order pagination produced an oversized cursor',
      500,
    )
  }
  return encoded
}

function emptySourceResult(
  total: number,
  pageSize: number,
  resultSetRevision: string,
) {
  return {
    orders: [],
    page: {
      total,
      returned: 0,
      pageSize,
      nextCursor: null,
      complete: true,
      truncated: false,
    },
    internal: {
      rowCursors: [],
      sortValues: [],
      providerIdentities: [],
      sourceEvidence: [] as OperationsOrderSourceEvidence[],
      resultSetRevision,
    },
  }
}

function assertSourceEvidence(input: {
  source: string
  orders: unknown[]
  page: { total: number; returned: number; complete: boolean; nextCursor: string | null }
  evidence: OperationsOrderSourceEvidence[]
  expectedTotal: number | null
  resultSetRevision: string | null
  expectedResultSetRevision: string | null
}) {
  if (
    !Number.isSafeInteger(input.page.total)
    || input.page.total < input.orders.length
    || input.page.returned !== input.orders.length
    || input.evidence.length !== input.orders.length
    || (input.orders.length === 0 && !input.page.complete)
    || (input.page.complete !== (input.page.nextCursor === null))
  ) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
      `${input.source} order pagination returned inconsistent evidence`,
      500,
    )
  }
  if (input.expectedTotal !== null && input.page.total !== input.expectedTotal) {
    requestError(
      'OPERATIONS_ORDER_PAGE_SNAPSHOT_CHANGED',
      'The order result set changed while pages were being read; restart from page one',
      409,
    )
  }
  if (
    input.resultSetRevision === null
    || !RESULT_SET_REVISION.test(input.resultSetRevision)
  ) {
    if (input.expectedResultSetRevision !== null) {
      requestError(
        'OPERATIONS_ORDER_PAGE_SNAPSHOT_CHANGED',
        'The order result set changed while pages were being read; restart from page one',
        409,
      )
    }
    requestError(
      'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
      `${input.source} order pagination did not return result-set revision evidence`,
      500,
    )
  }
  if (
    input.expectedResultSetRevision !== null
    && input.resultSetRevision !== input.expectedResultSetRevision
  ) {
    requestError(
      'OPERATIONS_ORDER_PAGE_SNAPSHOT_CHANGED',
      'The order result set changed while pages were being read; restart from page one',
      409,
    )
  }
}

function nextSourceState(input: {
  incoming: SourceCursorState
  total: number
  sourceRows: unknown[]
  evidence: OperationsOrderSourceEvidence[]
  complete: boolean
  consumed: number
  resultSetRevision: string
}): SourceCursorState {
  if (input.consumed === 0) {
    if (input.sourceRows.length === 0 && input.complete) {
      return {
        cursor: null,
        done: true,
        total: input.total,
        revision: input.resultSetRevision,
      }
    }
    return {
      ...input.incoming,
      total: input.total,
      revision: input.resultSetRevision,
    }
  }
  const lastEvidence = input.evidence[input.consumed - 1]
  if (!lastEvidence?.rowCursor) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
      'Order pagination could not advance a source cursor',
      500,
    )
  }
  const done = input.consumed === input.sourceRows.length && input.complete
  return {
    cursor: done ? null : lastEvidence.rowCursor,
    done,
    total: input.total,
    revision: input.resultSetRevision,
  }
}

function directPageValue(value: number | null | undefined) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_PAGE_INVALID',
      'Unified order page is invalid',
    )
  }
  return value
}

function clampedPageOffset(input: {
  page: number
  pageSize: number
  total: number
}) {
  if (!Number.isSafeInteger(input.total) || input.total < 0) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_EVIDENCE_INVALID',
      'Unified order pagination returned invalid total evidence',
      500,
    )
  }
  if (input.total === 0) return 0
  const lastPageOffset = Math.floor((input.total - 1) / input.pageSize)
    * input.pageSize
  const lastPage = (lastPageOffset / input.pageSize) + 1
  return input.page >= lastPage
    ? lastPageOffset
    : (input.page - 1) * input.pageSize
}

function directSourceState(input: {
  offset: number
  total: number
  revision: string
  before: OperationsOrderSourceEvidence | null
}): SourceCursorState {
  if (input.offset === input.total) {
    return {
      cursor: null,
      done: true,
      total: input.total,
      revision: input.revision,
    }
  }
  if (input.offset === 0) {
    return {
      cursor: null,
      done: input.total === 0,
      total: input.total,
      revision: input.revision,
    }
  }
  if (!input.before?.rowCursor) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
      'Unified order pagination did not return direct-page boundary evidence',
      500,
    )
  }
  return {
    cursor: input.before.rowCursor,
    done: false,
    total: input.total,
    revision: input.revision,
  }
}

export async function readUnifiedOperationsOrderPageFromPostgres(
  rawInput: UnifiedOperationsOrderPageInput,
): Promise<{
  rows: UnifiedOperationsOrderRow[]
  page: UnifiedOperationsOrderPage
}> {
  const input = normalizedInput(rawInput)
  const requestedPage = directPageValue(rawInput.page)
  if (requestedPage !== null && String(rawInput.cursor || '').trim()) {
    requestError(
      'OPERATIONS_UNIFIED_ORDER_PAGE_CURSOR_CONFLICT',
      'Unified order page and cursor cannot be combined',
    )
  }
  const expectedScopeHash = scopeHash(input)
  const cursor = decodeCombinedCursor(rawInput.cursor, expectedScopeHash)
  const initialSourceState: SourceCursorState = {
    cursor: null,
    done: false,
    total: 0,
    revision: EMPTY_OPERATIONS_ORDER_RESULT_SET_REVISION,
  }
  let canonicalState: SourceCursorState = cursor?.canonical || initialSourceState
  let importedState: SourceCursorState = cursor?.imported || initialSourceState
  const shared = {
    organizationId: input.organizationId,
    search: input.search,
    status: input.status,
    sort: input.sort,
    direction: input.direction,
    provider: input.provider,
    tracking: input.tracking,
    updatedAfter: input.updatedAfter,
    stableTextCollation: true,
  } as const
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

    let canonicalRead: Awaited<
      ReturnType<typeof readOperationsOrderPageFromPostgres>
    >
    let importedRead: Awaited<
      ReturnType<typeof readCommerceOrderWorkbenchPageFromPostgres>
    >
    let offset = cursor?.offset || 0
    let expectedSnapshot = Boolean(cursor)

    if (requestedPage !== null) {
      const initialPageSize = requestedPage === 1 ? input.pageSize : 1
      // These reads establish both source totals and revisions before a seek.
      // Keeping them sequenced on this client prevents a promotion committed
      // between source reads from crossing the repeatable-read snapshot.
      const canonicalHead = await readOperationsOrderPageFromPostgres({
        ...shared,
        offset: 0,
        pageSize: initialPageSize,
        queryClient: client,
      })
      const importedHead = await readCommerceOrderWorkbenchPageFromPostgres({
        ...shared,
        offset: 0,
        pageSize: initialPageSize,
        queryClient: client,
      })
      assertSourceEvidence({
        source: 'Canonical',
        orders: canonicalHead.orders,
        page: canonicalHead.page,
        evidence: canonicalHead.internal.sourceEvidence,
        expectedTotal: null,
        resultSetRevision: canonicalHead.internal.resultSetRevision,
        expectedResultSetRevision: null,
      })
      assertSourceEvidence({
        source: 'Imported',
        orders: importedHead.orders,
        page: importedHead.page,
        evidence: importedHead.internal.sourceEvidence,
        expectedTotal: null,
        resultSetRevision: importedHead.internal.resultSetRevision,
        expectedResultSetRevision: null,
      })
      const canonicalRevision = canonicalHead.internal.resultSetRevision as string
      const importedRevision = importedHead.internal.resultSetRevision as string
      const initialTotal = canonicalHead.page.total + importedHead.page.total
      if (!Number.isSafeInteger(initialTotal) || initialTotal < 0) {
        requestError(
          'OPERATIONS_UNIFIED_ORDER_EVIDENCE_INVALID',
          'Unified order pagination returned invalid total evidence',
          500,
        )
      }
      offset = clampedPageOffset({
        page: requestedPage,
        pageSize: input.pageSize,
        total: initialTotal,
      })

      const canonicalProbeCache = new Map<number, OperationsOrderSourceEvidence>()
      const importedProbeCache = new Map<number, OperationsOrderSourceEvidence>()
      const canonicalHeadEvidence = canonicalHead.internal.sourceEvidence[0]
      const importedHeadEvidence = importedHead.internal.sourceEvidence[0]
      if (canonicalHeadEvidence) canonicalProbeCache.set(0, canonicalHeadEvidence)
      if (importedHeadEvidence) importedProbeCache.set(0, importedHeadEvidence)

      const canonicalAt = async (sourceOffset: number) => {
        const cached = canonicalProbeCache.get(sourceOffset)
        if (cached) return cached
        const probe = await readOperationsOrderPageFromPostgres({
          ...shared,
          offset: sourceOffset,
          pageSize: 1,
          queryClient: client,
        })
        assertSourceEvidence({
          source: 'Canonical',
          orders: probe.orders,
          page: probe.page,
          evidence: probe.internal.sourceEvidence,
          expectedTotal: canonicalHead.page.total,
          resultSetRevision: probe.internal.resultSetRevision,
          expectedResultSetRevision: canonicalRevision,
        })
        if (probe.orders.length !== 1 || !probe.internal.sourceEvidence[0]) {
          requestError(
            'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
            'Canonical order pagination did not return offset-probe evidence',
            500,
          )
        }
        canonicalProbeCache.set(sourceOffset, probe.internal.sourceEvidence[0])
        return probe.internal.sourceEvidence[0]
      }
      const importedAt = async (sourceOffset: number) => {
        const cached = importedProbeCache.get(sourceOffset)
        if (cached) return cached
        const probe = await readCommerceOrderWorkbenchPageFromPostgres({
          ...shared,
          offset: sourceOffset,
          pageSize: 1,
          queryClient: client,
        })
        assertSourceEvidence({
          source: 'Imported',
          orders: probe.orders,
          page: probe.page,
          evidence: probe.internal.sourceEvidence,
          expectedTotal: importedHead.page.total,
          resultSetRevision: probe.internal.resultSetRevision,
          expectedResultSetRevision: importedRevision,
        })
        if (probe.orders.length !== 1 || !probe.internal.sourceEvidence[0]) {
          requestError(
            'OPERATIONS_UNIFIED_ORDER_SOURCE_EVIDENCE_INVALID',
            'Imported-order pagination did not return offset-probe evidence',
            500,
          )
        }
        importedProbeCache.set(sourceOffset, probe.internal.sourceEvidence[0])
        return probe.internal.sourceEvidence[0]
      }

      let partition
      try {
        partition = await seekUnifiedOperationsOrderPartition({
          canonicalTotal: canonicalHead.page.total,
          importedTotal: importedHead.page.total,
          offset,
          sort: input.sort,
          direction: input.direction,
          canonicalAt,
          importedAt,
        })
      } catch (error) {
        if (error instanceof UnifiedOperationsOrderPageError) {
          requestError(error.code, error.message, 500)
        }
        throw error
      }
      canonicalState = directSourceState({
        offset: partition.canonicalOffset,
        total: canonicalHead.page.total,
        revision: canonicalRevision,
        before: partition.canonicalBefore,
      })
      importedState = directSourceState({
        offset: partition.importedOffset,
        total: importedHead.page.total,
        revision: importedRevision,
        before: partition.importedBefore,
      })

      canonicalRead = canonicalState.done
        ? canonicalHead
        : partition.canonicalOffset === 0
          && initialPageSize === input.pageSize
        ? canonicalHead
        : await readOperationsOrderPageFromPostgres({
            ...shared,
            offset: partition.canonicalOffset,
            pageSize: input.pageSize,
            queryClient: client,
          })
      importedRead = importedState.done
        ? importedHead
        : partition.importedOffset === 0
          && initialPageSize === input.pageSize
        ? importedHead
        : await readCommerceOrderWorkbenchPageFromPostgres({
            ...shared,
            offset: partition.importedOffset,
            pageSize: input.pageSize,
            queryClient: client,
          })
      expectedSnapshot = true
    } else {
      // Cursor reads are intentionally sequenced on one client. The first
      // source read establishes the snapshot for both source result sets.
      canonicalRead = await readOperationsOrderPageFromPostgres({
        ...shared,
        cursor: canonicalState.done ? null : canonicalState.cursor,
        pageSize: canonicalState.done ? 1 : input.pageSize,
        queryClient: client,
      })
      importedRead = await readCommerceOrderWorkbenchPageFromPostgres({
        ...shared,
        cursor: importedState.done ? null : importedState.cursor,
        pageSize: importedState.done ? 1 : input.pageSize,
        queryClient: client,
      })
    }

    assertSourceEvidence({
      source: 'Canonical',
      orders: canonicalRead.orders,
      page: canonicalRead.page,
      evidence: canonicalRead.internal.sourceEvidence,
      expectedTotal: expectedSnapshot ? canonicalState.total : null,
      resultSetRevision: canonicalRead.internal.resultSetRevision,
      expectedResultSetRevision: expectedSnapshot ? canonicalState.revision : null,
    })
    assertSourceEvidence({
      source: 'Imported',
      orders: importedRead.orders,
      page: importedRead.page,
      evidence: importedRead.internal.sourceEvidence,
      expectedTotal: expectedSnapshot ? importedState.total : null,
      resultSetRevision: importedRead.internal.resultSetRevision,
      expectedResultSetRevision: expectedSnapshot ? importedState.revision : null,
    })

    const canonical = canonicalState.done
      ? emptySourceResult(
          canonicalRead.page.total,
          input.pageSize,
          canonicalRead.internal.resultSetRevision as string,
        )
      : canonicalRead
    const imported = importedState.done
      ? emptySourceResult(
          importedRead.page.total,
          input.pageSize,
          importedRead.internal.resultSetRevision as string,
        )
      : importedRead

    let merged
    try {
      merged = mergeUnifiedOperationsOrderPage({
        canonical: canonical.orders.map((order, index) => ({
          row: {
            kind: 'canonical' as const,
            key: `canonical:${order.globalId}`,
            order,
          },
          evidence: canonical.internal.sourceEvidence[index],
        })),
        imported: imported.orders.map((order, index) => ({
          row: {
            kind: 'imported' as const,
            key: `imported:${order.candidateGlobalId}`,
            order,
          },
          evidence: imported.internal.sourceEvidence[index],
        })),
        sort: input.sort,
        direction: input.direction,
        pageSize: input.pageSize,
      })
    } catch (error) {
      if (error instanceof UnifiedOperationsOrderPageError) {
        requestError(error.code, error.message, 500)
      }
      throw error
    }

    const total = canonical.page.total + imported.page.total
    if (
      !Number.isSafeInteger(total)
      || total < 0
      || (cursor && total !== cursor.total)
      || offset + merged.rows.length > total
    ) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_EVIDENCE_INVALID',
        'Unified order pagination returned invalid total evidence',
        500,
      )
    }
    const nextOffset = offset + merged.rows.length
    const nextCanonical = nextSourceState({
      incoming: canonicalState,
      total: canonical.page.total,
      sourceRows: canonical.orders,
      evidence: canonical.internal.sourceEvidence,
      complete: canonical.page.complete,
      consumed: merged.canonicalConsumed,
      resultSetRevision: canonical.internal.resultSetRevision as string,
    })
    const nextImported = nextSourceState({
      incoming: importedState,
      total: imported.page.total,
      sourceRows: imported.orders,
      evidence: imported.internal.sourceEvidence,
      complete: imported.page.complete,
      consumed: merged.importedConsumed,
      resultSetRevision: imported.internal.resultSetRevision as string,
    })
    if (
      nextOffset < total
      && (merged.rows.length === 0 || (nextCanonical.done && nextImported.done))
    ) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_EVIDENCE_INVALID',
        'Unified order pagination could not advance to the remaining orders',
        500,
      )
    }
    const nextCursor = nextOffset < total
      ? encodeCombinedCursor({
          v: 2,
          scopeHash: expectedScopeHash,
          offset: nextOffset,
          total,
          canonical: nextCanonical,
          imported: nextImported,
        })
      : null
    const result = {
      rows: merged.rows,
      page: {
        total,
        returned: merged.rows.length,
        pageSize: input.pageSize,
        offset,
        nextCursor,
        complete: nextCursor === null,
        truncated: nextCursor !== null,
      },
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw normalizePostgresPersistenceError(error)
  } finally {
    client.release()
  }
}
