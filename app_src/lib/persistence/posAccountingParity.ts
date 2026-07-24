import { query } from '@/lib/persistence/postgres'

export type PosAccountingParityEntityType = 'SalesReceipt' | 'JournalEntry'
export type PosAccountingPostingOrigin = 'shogo' | 'external' | 'clawpilot'
export type PosAccountingParityMatchBasis =
  | 'provider_id'
  | 'memo'
  | 'date_only'

type UnknownRecord = Record<string, unknown>

export interface PosAccountingReceiptLineGroup {
  itemId: string
  itemName: string | null
  amountCents: number
  quantityMillis: number
}

export interface PosAccountingJournalLineGroup {
  side: 'debit' | 'credit'
  accountId: string
  accountName: string | null
  amountCents: number
}

interface PosAccountingIdentity {
  providerTransactionId: string | null
  documentNumber: string | null
  memo: string | null
}

interface PosAccountingExpectedBase extends PosAccountingIdentity {
  expectedId: string
  entityType: PosAccountingParityEntityType
  businessDate: string
  draft: {
    id: string
    revision: number
    restaurantGuid: string
    restaurantName: string | null
    locationName: string | null
    status: string
    reconciliationStatus: string
    sourceRevision: number
    updatedAt: string | null
    reviewOutcome: string | null
    postingOrigin: PosAccountingPostingOrigin | null
    reviewedBy: string | null
    reviewedAt: string | null
    reviewNote: string | null
    externalPostingProvider: string | null
    externalPostingReference: string | null
    quickBooksSalesReceiptId: string | null
    quickBooksJournalEntryId: string | null
    postingBatch: {
      id: string
      status: string
      requestFingerprint: string
      requestedBy: string
      approvedBy: string | null
      approvalNote: string | null
      lastError: string | null
      submittedAt: string | null
      approvedAt: string | null
      postedAt: string | null
      updatedAt: string | null
      salesReceipt: {
        requestId: string
        status: string
        providerEntityId: string | null
        error: string | null
      }
      journalEntry: {
        requestId: string
        status: string
        providerEntityId: string | null
        error: string | null
      }
    } | null
  }
}

export interface NormalizedExpectedSalesReceipt extends PosAccountingExpectedBase {
  entityType: 'SalesReceipt'
  totalCents: number | null
  taxCents: number | null
  lineGroups: PosAccountingReceiptLineGroup[]
  lineEvidenceAvailable: boolean
  unmappedLineCount: number
}

export interface NormalizedExpectedJournalEntry extends PosAccountingExpectedBase {
  entityType: 'JournalEntry'
  debitCents: number | null
  creditCents: number | null
  lineGroups: PosAccountingJournalLineGroup[]
  lineEvidenceAvailable: boolean
  unmappedLineCount: number
}

export type NormalizedExpectedPosAccountingDocument =
  | NormalizedExpectedSalesReceipt
  | NormalizedExpectedJournalEntry

export interface NormalizedPosAccountingDraftEvidence {
  draftId: string
  businessDate: string
  documents: NormalizedExpectedPosAccountingDocument[]
}

interface NormalizedQuickBooksBase extends PosAccountingIdentity {
  evidenceId: string
  entityType: PosAccountingParityEntityType
  businessDate: string
  postingOrigin: PosAccountingPostingOrigin | null
  partyName: string | null
  accountName: string | null
  currencyCode: string | null
  syncedAt: string | null
}

export interface NormalizedQuickBooksSalesReceipt extends NormalizedQuickBooksBase {
  entityType: 'SalesReceipt'
  subtotalCents: number | null
  subtotalSource: 'explicit' | 'line_sum' | null
  totalCents: number | null
  taxCents: number | null
  lineGroups: PosAccountingReceiptLineGroup[]
  unidentifiedLineCount: number
  unsupportedLineCount: number
}

export interface NormalizedQuickBooksJournalEntry extends NormalizedQuickBooksBase {
  entityType: 'JournalEntry'
  debitCents: number
  creditCents: number
  lineGroups: PosAccountingJournalLineGroup[]
  unidentifiedLineCount: number
  unsupportedLineCount: number
}

export type NormalizedQuickBooksPosAccountingEvidence =
  | NormalizedQuickBooksSalesReceipt
  | NormalizedQuickBooksJournalEntry

export interface PosAccountingParityAmountComparison {
  status: 'match' | 'variance' | 'insufficient_evidence'
  expectedCents: number | null
  actualCents: number | null
  deltaCents: number | null
}

export interface PosAccountingReceiptLineComparison {
  itemId: string
  itemName: string | null
  expectedAmountCents: number | null
  actualAmountCents: number | null
  deltaAmountCents: number | null
  expectedQuantityMillis: number | null
  actualQuantityMillis: number | null
  deltaQuantityMillis: number | null
  status: 'match' | 'variance' | 'missing' | 'extra' | 'insufficient_evidence'
}

export interface PosAccountingJournalLineComparison {
  side: 'debit' | 'credit'
  accountId: string
  accountName: string | null
  expectedAmountCents: number | null
  actualAmountCents: number | null
  deltaAmountCents: number | null
  status: 'match' | 'variance' | 'missing' | 'extra' | 'insufficient_evidence'
}

export interface PosAccountingSalesReceiptComparison {
  status: 'match' | 'variance' | 'insufficient_evidence'
  total: PosAccountingParityAmountComparison
  tax: PosAccountingParityAmountComparison
  lines: PosAccountingReceiptLineComparison[]
  coverageIncomplete: boolean
}

export interface PosAccountingJournalEntryComparison {
  status: 'match' | 'variance' | 'insufficient_evidence'
  debits: PosAccountingParityAmountComparison
  credits: PosAccountingParityAmountComparison
  lines: PosAccountingJournalLineComparison[]
  coverageIncomplete: boolean
}

export type PosAccountingParityComparison =
  | PosAccountingSalesReceiptComparison
  | PosAccountingJournalEntryComparison

export interface PosAccountingReceiptArithmeticCheck {
  status: 'match' | 'variance' | 'insufficient_evidence'
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number | null
  deltaCents: number | null
}

export interface PosAccountingJournalBalanceCheck {
  status: 'match' | 'variance' | 'insufficient_evidence'
  debitCents: number
  creditCents: number
  deltaCents: number
}

interface PosAccountingHistoricalEvidenceReference {
  evidenceId: string
  entityType: PosAccountingParityEntityType
  providerTransactionId: string | null
  businessDate: string
  documentNumber: string | null
  memo: string | null
  postingOrigin: PosAccountingPostingOrigin | null
}

export interface PosAccountingHistoricalBaseline {
  summary: {
    cachedTransactions: number
    pairCount: number
    exactMarkerPairs: number
    dateFallbackPairs: number
    unmatchedGroups: number
    unmatchedEvidence: number
    ambiguousGroups: number
    ambiguousEvidence: number
    receiptArithmetic: Record<'match' | 'variance' | 'insufficientEvidence', number>
    journalBalance: Record<'match' | 'variance' | 'insufficientEvidence', number>
  }
  pairs: Array<{
    basis: 'business_date_and_marker' | 'business_date_only'
    businessDate: string
    salesReceipt: PosAccountingHistoricalEvidenceReference
    journalEntry: PosAccountingHistoricalEvidenceReference
    receiptArithmetic: PosAccountingReceiptArithmeticCheck
    journalBalance: PosAccountingJournalBalanceCheck
  }>
  unmatchedGroups: Array<{
    businessDate: string
    documentNumber: string | null
    entityType: PosAccountingParityEntityType
    evidence: PosAccountingHistoricalEvidenceReference[]
  }>
  ambiguousGroups: Array<{
    basis: 'business_date_and_marker' | 'business_date_only'
    businessDate: string
    documentNumber: string | null
    salesReceipts: PosAccountingHistoricalEvidenceReference[]
    journalEntries: PosAccountingHistoricalEvidenceReference[]
  }>
}

export interface PosAccountingParityMatch {
  expected: NormalizedExpectedPosAccountingDocument
  actual: NormalizedQuickBooksPosAccountingEvidence | null
  status: 'matched' | 'ambiguous' | 'missing_quickbooks'
  basis: PosAccountingParityMatchBasis | null
  candidateTransactionIds: string[]
}

export interface PosAccountingParityReport {
  dates: string[]
  historicalBaseline: PosAccountingHistoricalBaseline
  rows: Array<{
    expected: NormalizedExpectedPosAccountingDocument
    actual: NormalizedQuickBooksPosAccountingEvidence | null
    match: {
      status: PosAccountingParityMatch['status']
      basis: PosAccountingParityMatchBasis | null
      candidateTransactionIds: string[]
    }
    comparison: PosAccountingParityComparison | null
  }>
  unmatchedQuickBooks: Array<{
    evidence: NormalizedQuickBooksPosAccountingEvidence
    candidateDraftIds: string[]
    ambiguous: boolean
  }>
  discardedEvidence: {
    drafts: number
    quickBooksTransactions: number
    nonToastQuickBooksTransactions: number
  }
  summary: {
    drafts: number
    expectedDocuments: number
    cachedTransactions: number
    matched: number
    ambiguous: number
    missingQuickBooks: number
    unmatchedQuickBooks: number
    comparisonsMatched: number
    comparisonsWithVariance: number
    comparisonsWithInsufficientEvidence: number
  }
}

export interface ReadPosAccountingParityInput {
  organizationId: string
  fromBusinessDate?: string | null
  toBusinessDate?: string | null
  page?: number
  pageSize?: number
  historyPage?: number
  historyPageSize?: number
}

export interface ReadPosAccountingParityEvidenceInput {
  organizationId: string
  entityType: PosAccountingParityEntityType
  providerTransactionId: string
}

export type PosAccountingParityEvidenceDetail = {
  evidence: NormalizedQuickBooksPosAccountingEvidence
  integrity: PosAccountingReceiptArithmeticCheck | PosAccountingJournalBalanceCheck
}

export interface PosAccountingParityPostgresReport extends PosAccountingParityReport {
  pagination: {
    page: number
    pageSize: number
    totalDates: number
    totalPages: number
    dates: string[]
  }
  historicalPagination: {
    page: number
    pageSize: number
    totalPages: number
    pairPages: number
    unmatchedPages: number
    ambiguousPages: number
  }
  cache: {
    configured: boolean
    connectionStatus: string | null
    lastCatalogSyncedAt: string | null
    syncStatus: string | null
    syncCompletedAt: string | null
    salesReceiptCount: number
    journalEntryCount: number
  }
  warnings: string[]
}

const ENTITY_TYPES = new Set<PosAccountingParityEntityType>(['SalesReceipt', 'JournalEntry'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown, maximumLength = 500): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).replace(CONTROL_CHARACTERS, '').trim()
  return normalized ? normalized.slice(0, maximumLength) : null
}

function firstText(values: unknown[], maximumLength = 500): string | null {
  for (const value of values) {
    const candidate = text(value, maximumLength)
    if (candidate !== null) return candidate
  }
  return null
}

function integer(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  const candidate = text(value, 100)
  if (!candidate) return null
  const parsed = new Date(candidate)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function businessDate(value: unknown): string | null {
  const candidate = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : text(value, 10)
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null
  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null
}

function entityType(value: unknown): PosAccountingParityEntityType | null {
  const candidate = text(value, 80)
  if (!candidate) return null
  const compact = candidate.replace(/[^a-z]/gi, '').toLowerCase()
  if (compact === 'salesreceipt') return 'SalesReceipt'
  if (compact === 'journalentry') return 'JournalEntry'
  return null
}

function postingOrigin(value: unknown): PosAccountingPostingOrigin | null {
  const candidate = text(value, 40)
  return candidate === 'shogo' || candidate === 'external' || candidate === 'clawpilot'
    ? candidate
    : null
}

function decimalToScaledInteger(value: unknown, scale: number): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  let source = String(value).trim().replace(/,/g, '')
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(source)) {
    const numeric = Number(source)
    if (!Number.isFinite(numeric)) return null
    source = numeric.toFixed(Math.min(scale + 8, 20))
  }
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(source)
  if (!match) return null
  const sign = match[1] === '-' ? BigInt(-1) : BigInt(1)
  const fraction = match[3] || ''
  const factor = BigInt(10) ** BigInt(scale)
  const keptFraction = fraction.slice(0, scale).padEnd(scale, '0')
  let scaled = BigInt(match[2]) * factor + BigInt(keptFraction || '0')
  if (fraction.length > scale && Number(fraction[scale]) >= 5) scaled += BigInt(1)
  scaled *= sign
  const result = Number(scaled)
  return Number.isSafeInteger(result) ? result : null
}

export function moneyToCents(value: unknown): number | null {
  return decimalToScaledInteger(value, 2)
}

export function quantityToMillis(value: unknown): number | null {
  return decimalToScaledInteger(value, 3)
}

function directInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function firstMoney(record: UnknownRecord, centsKeys: string[], amountKeys: string[]): number | null {
  for (const key of centsKeys) {
    const candidate = directInteger(record[key])
    if (candidate !== null) return candidate
  }
  for (const key of amountKeys) {
    const candidate = moneyToCents(record[key])
    if (candidate !== null) return candidate
  }
  return null
}

function normalizedIdentity(value: string | null): string | null {
  return value ? value.replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : null
}

function populatedIdentifiersConflict(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizedIdentity(left)
  const normalizedRight = normalizedIdentity(right)
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft !== normalizedRight)
}

function evidenceIdentifiersConflict(
  left: { documentNumber: string | null; memo: string | null },
  right: { documentNumber: string | null; memo: string | null },
): boolean {
  return populatedIdentifiersConflict(left.memo, right.memo)
}

function recordAt(root: UnknownRecord, path: string[]): UnknownRecord {
  let cursor: UnknownRecord = root
  for (const key of path) {
    const next = asRecord(cursor[key])
    if (Object.keys(next).length === 0) return {}
    cursor = next
  }
  return cursor
}

function documentRecord(
  sourceSummary: UnknownRecord,
  quickBooksPayload: UnknownRecord,
  aliases: string[],
): UnknownRecord {
  const roots = [
    recordAt(sourceSummary, ['canonical', 'parity', 'documents']),
    recordAt(sourceSummary, ['canonical', 'documents']),
    recordAt(sourceSummary, ['documents']),
    quickBooksPayload,
  ]
  const normalizedAliases = new Set(aliases.map((alias) => alias.replace(/[^a-z]/gi, '').toLowerCase()))
  for (const root of roots) {
    for (const [key, value] of Object.entries(root)) {
      if (!normalizedAliases.has(key.replace(/[^a-z]/gi, '').toLowerCase())) continue
      const candidate = asRecord(value)
      if (Object.keys(candidate).length > 0) return candidate
    }
  }
  return {}
}

function transactionPayload(row: UnknownRecord, type: PosAccountingParityEntityType): UnknownRecord {
  const root = asRecord(row.source_payload ?? row.sourcePayload)
  const direct = asRecord(root[type])
  if (Object.keys(direct).length > 0) return direct
  const queryResponse = asRecord(root.QueryResponse)
  const fromResponse = asList(queryResponse[type]).map(asRecord)[0]
  return fromResponse && Object.keys(fromResponse).length > 0 ? fromResponse : root
}

function providerTransactionId(row: UnknownRecord, payload: UnknownRecord): string | null {
  return firstText([
    row.quickbooks_transaction_id,
    row.providerTransactionId,
    payload.Id,
  ], 200)
}

function toastMarkerDate(value: unknown): string | null {
  const candidate = text(value, 4000)
  if (!candidate) return null
  const match = /^\s*toast\s+(\d{4}-\d{2}-\d{2})(?:\s|$)/i.exec(candidate)
  return match ? businessDate(match[1]) : null
}

export function classifyPosAccountingQuickBooksTransaction(
  input: unknown,
  linkedProviderIds: ReadonlySet<string> = new Set<string>(),
): PosAccountingPostingOrigin | null {
  const row = asRecord(input)
  const type = entityType(row.entity_type ?? row.entityType)
  if (!type) return null
  const payload = transactionPayload(row, type)
  const providerId = providerTransactionId(row, payload)
  if (providerId && linkedProviderIds.has(providerId)) return 'clawpilot'

  const trustedOrigin = text(row.pos_accounting_origin ?? row.posAccountingOrigin, 40)
  if (trustedOrigin === 'clawpilot' || trustedOrigin === 'external' || trustedOrigin === 'shogo') {
    return trustedOrigin
  }

  const date = businessDate(row.transaction_date ?? row.businessDate ?? payload.TxnDate)
  if (!date) return null
  const markerDate = [
    row.memo,
    payload.PrivateNote,
    asRecord(payload.CustomerMemo).value,
    payload.Memo,
  ].map(toastMarkerDate).find(Boolean)
  return markerDate === date ? 'shogo' : null
}

export function isToastMarkedQuickBooksTransaction(input: unknown): boolean {
  return classifyPosAccountingQuickBooksTransaction(input) !== null
}

function collectTransactionLines(value: unknown, output: UnknownRecord[]) {
  for (const candidate of asList(value)) {
    const line = asRecord(candidate)
    const group = asRecord(line.GroupLineDetail)
    const nested = asList(group.Line ?? line.Line)
    if (nested.length > 0) {
      collectTransactionLines(nested, output)
      continue
    }
    output.push(line)
  }
}

function sortReceiptGroups(groups: Iterable<PosAccountingReceiptLineGroup>) {
  return [...groups].sort((left, right) => left.itemId.localeCompare(right.itemId))
}

function sortJournalGroups(groups: Iterable<PosAccountingJournalLineGroup>) {
  return [...groups].sort((left, right) =>
    left.side.localeCompare(right.side) || left.accountId.localeCompare(right.accountId))
}

export function normalizeSalesReceiptEvidence(
  input: unknown,
  linkedProviderIds: ReadonlySet<string> = new Set<string>(),
): NormalizedQuickBooksSalesReceipt | null {
  const row = asRecord(input)
  const payload = transactionPayload(row, 'SalesReceipt')
  const providerTransactionId = firstText([
    row.quickbooks_transaction_id,
    row.providerTransactionId,
    payload.Id,
  ], 200)
  const date = businessDate(row.transaction_date ?? row.businessDate ?? payload.TxnDate)
  if (!providerTransactionId || !date) return null

  const flattenedLines: UnknownRecord[] = []
  collectTransactionLines(payload.Line, flattenedLines)
  const groups = new Map<string, PosAccountingReceiptLineGroup>()
  let unidentifiedLineCount = 0
  let unsupportedLineCount = 0
  let explicitSubtotalCents: number | null = null

  for (const line of flattenedLines) {
    const detailType = text(line.DetailType, 100)?.replace(/[^a-z]/gi, '').toLowerCase()
    if (detailType === 'subtotallinedetail' || Object.hasOwn(line, 'SubTotalLineDetail')) {
      const subtotal = moneyToCents(line.Amount)
      if (subtotal !== null) explicitSubtotalCents = (explicitSubtotalCents || 0) + subtotal
      continue
    }
    const detail = asRecord(line.SalesItemLineDetail)
    const amountCents = moneyToCents(line.Amount) ?? 0
    if (Object.keys(detail).length === 0) {
      if (amountCents !== 0) unsupportedLineCount += 1
      continue
    }
    const item = asRecord(detail.ItemRef)
    const itemId = firstText([item.value, item.id], 200)
    if (!itemId) {
      unidentifiedLineCount += 1
      continue
    }
    const quantityMillis = quantityToMillis(detail.Qty) ?? 0
    const existing = groups.get(itemId)
    groups.set(itemId, {
      itemId,
      itemName: existing?.itemName || firstText([item.name], 300),
      amountCents: (existing?.amountCents || 0) + amountCents,
      quantityMillis: (existing?.quantityMillis || 0) + quantityMillis,
    })
  }

  const taxDetail = asRecord(payload.TxnTaxDetail)
  const lineGroups = sortReceiptGroups(groups.values())
  const subtotalCents = explicitSubtotalCents ?? (
    lineGroups.length > 0 && unidentifiedLineCount === 0 && unsupportedLineCount === 0
      ? lineGroups.reduce((total, line) => total + line.amountCents, 0)
      : null
  )
  return {
    evidenceId: `SalesReceipt:${providerTransactionId}`,
    entityType: 'SalesReceipt',
    providerTransactionId,
    businessDate: date,
    postingOrigin: classifyPosAccountingQuickBooksTransaction(input, linkedProviderIds),
    partyName: firstText([
      row.party_name,
      row.partyName,
      asRecord(payload.CustomerRef).name,
    ], 300),
    accountName: firstText([
      row.account_name,
      row.accountName,
      asRecord(payload.DepositToAccountRef).name,
    ], 300),
    documentNumber: firstText([payload.DocNumber, row.document_number, row.documentNumber], 200),
    memo: firstText([
      payload.PrivateNote,
      asRecord(payload.CustomerMemo).value,
      payload.Memo,
      row.memo,
    ], 1000),
    currencyCode: firstText([
      asRecord(payload.CurrencyRef).value,
      row.currency_code,
      row.currencyCode,
    ], 20),
    syncedAt: timestamp(row.synced_at ?? row.syncedAt),
    subtotalCents,
    subtotalSource: explicitSubtotalCents !== null
      ? 'explicit'
      : subtotalCents !== null ? 'line_sum' : null,
    totalCents: moneyToCents(payload.TotalAmt)
      ?? moneyToCents(row.total_amount ?? row.totalAmount),
    taxCents: moneyToCents(taxDetail.TotalTax),
    lineGroups,
    unidentifiedLineCount,
    unsupportedLineCount,
  }
}

export function normalizeJournalEntryEvidence(
  input: unknown,
  linkedProviderIds: ReadonlySet<string> = new Set<string>(),
): NormalizedQuickBooksJournalEntry | null {
  const row = asRecord(input)
  const payload = transactionPayload(row, 'JournalEntry')
  const providerTransactionId = firstText([
    row.quickbooks_transaction_id,
    row.providerTransactionId,
    payload.Id,
  ], 200)
  const date = businessDate(row.transaction_date ?? row.businessDate ?? payload.TxnDate)
  if (!providerTransactionId || !date) return null

  const flattenedLines: UnknownRecord[] = []
  collectTransactionLines(payload.Line, flattenedLines)
  const groups = new Map<string, PosAccountingJournalLineGroup>()
  let unidentifiedLineCount = 0
  let unsupportedLineCount = 0

  for (const line of flattenedLines) {
    const detail = asRecord(line.JournalEntryLineDetail)
    const amountCents = moneyToCents(line.Amount) ?? 0
    if (amountCents === 0) continue
    if (Object.keys(detail).length === 0) {
      unsupportedLineCount += 1
      continue
    }
    const postingType = normalizedIdentity(text(detail.PostingType, 20))
    const side = postingType === 'debit' || postingType === 'credit' ? postingType : null
    const account = asRecord(detail.AccountRef)
    const accountId = firstText([account.value, account.id], 200)
    if (!side || !accountId) {
      unidentifiedLineCount += 1
      continue
    }
    const key = `${side}:${accountId}`
    const existing = groups.get(key)
    groups.set(key, {
      side,
      accountId,
      accountName: existing?.accountName || firstText([account.name], 300),
      amountCents: (existing?.amountCents || 0) + amountCents,
    })
  }

  const lineGroups = sortJournalGroups(groups.values())
  return {
    evidenceId: `JournalEntry:${providerTransactionId}`,
    entityType: 'JournalEntry',
    providerTransactionId,
    businessDate: date,
    postingOrigin: classifyPosAccountingQuickBooksTransaction(input, linkedProviderIds),
    partyName: firstText([row.party_name, row.partyName], 300),
    accountName: firstText([row.account_name, row.accountName], 300),
    documentNumber: firstText([payload.DocNumber, row.document_number, row.documentNumber], 200),
    memo: firstText([payload.PrivateNote, payload.Memo, row.memo], 1000),
    currencyCode: firstText([
      asRecord(payload.CurrencyRef).value,
      row.currency_code,
      row.currencyCode,
    ], 20),
    syncedAt: timestamp(row.synced_at ?? row.syncedAt),
    debitCents: lineGroups
      .filter((line) => line.side === 'debit')
      .reduce((total, line) => total + line.amountCents, 0),
    creditCents: lineGroups
      .filter((line) => line.side === 'credit')
      .reduce((total, line) => total + line.amountCents, 0),
    lineGroups,
    unidentifiedLineCount,
    unsupportedLineCount,
  }
}

export function normalizeQuickBooksPosAccountingEvidence(
  input: unknown,
  linkedProviderIds: ReadonlySet<string> = new Set<string>(),
): NormalizedQuickBooksPosAccountingEvidence | null {
  const row = asRecord(input)
  const type = entityType(row.entity_type ?? row.entityType)
  if (!type || !ENTITY_TYPES.has(type)) return null
  return type === 'SalesReceipt'
    ? normalizeSalesReceiptEvidence(row, linkedProviderIds)
    : normalizeJournalEntryEvidence(row, linkedProviderIds)
}

function normalizeExpectedReceiptLines(lines: UnknownRecord[]) {
  const receiptLines = lines.filter((line) => {
    const document = text(line.document, 80)?.replace(/[^a-z]/gi, '').toLowerCase()
    return document === 'salesreceipt'
  })
  const groups = new Map<string, PosAccountingReceiptLineGroup>()
  let unmappedLineCount = 0
  for (const line of receiptLines) {
    const target = asRecord(line.target)
    const itemId = firstText([target.id, line.quickbooksItemId, line.itemId], 200)
    if (!itemId) {
      unmappedLineCount += 1
      continue
    }
    const amountCents = moneyToCents(line.amount) ?? 0
    const quantityMillis = quantityToMillis(line.quantity) ?? 0
    const existing = groups.get(itemId)
    groups.set(itemId, {
      itemId,
      itemName: existing?.itemName || firstText([target.name, line.targetName], 300),
      amountCents: (existing?.amountCents || 0) + amountCents,
      quantityMillis: (existing?.quantityMillis || 0) + quantityMillis,
    })
  }
  return {
    groups: sortReceiptGroups(groups.values()),
    lineEvidenceAvailable: receiptLines.length > 0,
    unmappedLineCount,
  }
}

function normalizeExpectedJournalLines(lines: UnknownRecord[]) {
  const journalLines = lines.filter((line) => {
    const document = text(line.document, 80)?.replace(/[^a-z]/gi, '').toLowerCase()
    return document === 'paymentsjournal' || document === 'journalentry'
  })
  const groups = new Map<string, PosAccountingJournalLineGroup>()
  let unmappedLineCount = 0
  for (const line of journalLines) {
    const amountCents = moneyToCents(line.amount) ?? 0
    if (amountCents === 0) continue
    const sideText = normalizedIdentity(text(line.side, 20))
    const side = sideText === 'debit' || sideText === 'credit' ? sideText : null
    const target = asRecord(line.target)
    const accountId = firstText([target.id, line.quickbooksAccountId, line.accountId], 200)
    if (!side || !accountId) {
      unmappedLineCount += 1
      continue
    }
    const key = `${side}:${accountId}`
    const existing = groups.get(key)
    groups.set(key, {
      side,
      accountId,
      accountName: existing?.accountName || firstText([target.name, line.targetName], 300),
      amountCents: (existing?.amountCents || 0) + amountCents,
    })
  }
  return {
    groups: sortJournalGroups(groups.values()),
    lineEvidenceAvailable: journalLines.length > 0,
    unmappedLineCount,
  }
}

export function normalizePosAccountingDraftEvidence(
  input: unknown,
): NormalizedPosAccountingDraftEvidence | null {
  const row = asRecord(input)
  const draftId = firstText([row.id, row.draft_id, row.draftId], 200)
  const date = businessDate(row.business_date ?? row.businessDate)
  const restaurantGuid = firstText([row.restaurant_guid, row.restaurantGuid], 200)
  if (!draftId || !date || !restaurantGuid) return null

  const sourceSummary = asRecord(row.source_summary ?? row.sourceSummary)
  const standard = asRecord(sourceSummary.standard)
  const canonicalReceipt = recordAt(sourceSummary, ['canonical', 'accounting', 'salesReceipt'])
  const quickBooksPayload = asRecord(row.quickbooks_payload ?? row.quickBooksPayload)
  const receiptDocument = documentRecord(
    sourceSummary,
    quickBooksPayload,
    ['SalesReceipt', 'sales_receipt', 'receipt'],
  )
  const journalDocument = documentRecord(
    sourceSummary,
    quickBooksPayload,
    ['JournalEntry', 'journal_entry', 'payments_journal', 'journal'],
  )
  const lines = asList(row.proposed_lines ?? row.proposedLines).map(asRecord)
  const receiptLines = normalizeExpectedReceiptLines(lines)
  const journalLines = normalizeExpectedJournalLines(lines)
  const journalOnlyPaymentException = !receiptLines.lineEvidenceAvailable
    && lines.some((line) => {
      const document = text(line.document, 80)?.replace(/[^a-z]/gi, '').toLowerCase()
      return (document === 'paymentsjournal' || document === 'journalentry')
        && line.sourceKind === 'payment_exception'
        && line.code === 'payment_exception_capture'
    })
  const providerTransactionId = firstText([
    row.quickbooks_transaction_id,
    row.providerTransactionId,
  ], 200)
  const postingBatchId = firstText([row.posting_batch_id, row.postingBatchId], 200)
  const postingBatch = postingBatchId ? {
    id: postingBatchId,
    status: firstText([row.posting_batch_status, row.postingBatchStatus], 80) || 'unknown',
    requestFingerprint: firstText([row.posting_batch_fingerprint, row.postingBatchFingerprint], 128) || '',
    requestedBy: firstText([row.posting_batch_requested_by, row.postingBatchRequestedBy], 254) || '',
    approvedBy: firstText([row.posting_batch_approved_by, row.postingBatchApprovedBy], 254),
    approvalNote: firstText([row.posting_batch_approval_note, row.postingBatchApprovalNote], 1_000),
    lastError: firstText([row.posting_batch_last_error, row.postingBatchLastError], 2_000),
    submittedAt: timestamp(row.posting_batch_submitted_at ?? row.postingBatchSubmittedAt),
    approvedAt: timestamp(row.posting_batch_approved_at ?? row.postingBatchApprovedAt),
    postedAt: timestamp(row.posting_batch_posted_at ?? row.postingBatchPostedAt),
    updatedAt: timestamp(row.posting_batch_updated_at ?? row.postingBatchUpdatedAt),
    salesReceipt: {
      requestId: firstText([row.sales_receipt_request_id, row.salesReceiptRequestId], 200) || '',
      status: firstText([row.sales_receipt_request_status, row.salesReceiptRequestStatus], 80) || 'unknown',
      providerEntityId: firstText([row.sales_receipt_provider_entity_id, row.salesReceiptProviderEntityId], 200),
      error: firstText([row.sales_receipt_request_error, row.salesReceiptRequestError], 2_000),
    },
    journalEntry: {
      requestId: firstText([row.journal_entry_request_id, row.journalEntryRequestId], 200) || '',
      status: firstText([row.journal_entry_request_status, row.journalEntryRequestStatus], 80) || 'unknown',
      providerEntityId: firstText([row.journal_entry_provider_entity_id, row.journalEntryProviderEntityId], 200),
      error: firstText([row.journal_entry_request_error, row.journalEntryRequestError], 2_000),
    },
  } : null
  const draft = {
    id: draftId,
    revision: Math.max(1, integer(row.draft_revision ?? row.draftRevision, 1)),
    restaurantGuid,
    restaurantName: firstText([row.restaurant_name, row.restaurantName], 300),
    locationName: firstText([row.location_name, row.locationName], 300),
    status: firstText([row.status], 80) || 'unknown',
    reconciliationStatus: firstText([
      row.reconciliation_status,
      row.reconciliationStatus,
    ], 80) || 'unknown',
    sourceRevision: Math.max(0, integer(row.source_revision ?? row.sourceRevision, 0)),
    updatedAt: timestamp(row.updated_at ?? row.updatedAt),
    reviewOutcome: firstText([row.review_outcome, row.reviewOutcome], 80),
    postingOrigin: postingOrigin(row.posting_origin ?? row.postingOrigin),
    reviewedBy: firstText([row.reviewed_by, row.reviewedBy], 254),
    reviewedAt: timestamp(row.reviewed_at ?? row.reviewedAt),
    reviewNote: firstText([row.review_note, row.reviewNote], 1_000),
    externalPostingProvider: firstText([
      row.external_posting_provider,
      row.externalPostingProvider,
    ], 120),
    externalPostingReference: firstText([
      row.external_posting_reference,
      row.externalPostingReference,
    ], 200),
    quickBooksSalesReceiptId: firstText([
      row.quickbooks_sales_receipt_id,
      row.quickBooksSalesReceiptId,
    ], 200),
    quickBooksJournalEntryId: firstText([
      row.quickbooks_journal_entry_id,
      row.quickBooksJournalEntryId,
    ], 200),
    postingBatch,
  }

  const receiptLineTotal = receiptLines.lineEvidenceAvailable && receiptLines.unmappedLineCount === 0
    ? receiptLines.groups.reduce((total, line) => total + line.amountCents, 0)
    : null
  const receiptTax = firstMoney(
    receiptDocument,
    ['taxCents', 'totalTaxCents'],
    ['tax', 'totalTax', 'TotalTax'],
  ) ?? firstMoney(canonicalReceipt, ['taxCents'], ['tax'])
    ?? firstMoney(standard, ['taxCents'], ['tax'])
  const receiptTotal = firstMoney(
    receiptDocument,
    ['totalCents', 'totalAmountCents'],
    ['total', 'totalAmount', 'TotalAmt'],
  ) ?? (
    receiptLineTotal !== null && receiptTax !== null
      ? receiptLineTotal + receiptTax
      : null
  ) ?? firstMoney(canonicalReceipt, ['totalCents'], ['total'])
    ?? firstMoney(standard, ['tenderedCents'], ['tendered'])
    ?? firstMoney(standard, ['totalCents'], ['total'])
    ?? receiptLineTotal

  const receipt: NormalizedExpectedSalesReceipt = {
    expectedId: `${draftId}:SalesReceipt`,
    entityType: 'SalesReceipt',
    businessDate: date,
    draft,
    providerTransactionId: firstText([
      row.quickbooks_sales_receipt_id,
      row.quickBooksSalesReceiptId,
      receiptDocument.providerTransactionId,
      receiptDocument.Id,
      providerTransactionId,
    ], 200),
    documentNumber: firstText([
      receiptDocument.documentNumber,
      receiptDocument.docNumber,
      receiptDocument.DocNumber,
    ], 200),
    memo: firstText([
      receiptDocument.memo,
      receiptDocument.privateNote,
      receiptDocument.PrivateNote,
    ], 1000),
    totalCents: receiptTotal,
    taxCents: receiptTax,
    lineGroups: receiptLines.groups,
    lineEvidenceAvailable: receiptLines.lineEvidenceAvailable,
    unmappedLineCount: receiptLines.unmappedLineCount,
  }

  const journal: NormalizedExpectedJournalEntry = {
    expectedId: `${draftId}:JournalEntry`,
    entityType: 'JournalEntry',
    businessDate: date,
    draft,
    providerTransactionId: firstText([
      row.quickbooks_journal_entry_id,
      row.quickBooksJournalEntryId,
      journalDocument.providerTransactionId,
      journalDocument.Id,
      providerTransactionId,
    ], 200),
    documentNumber: firstText([
      journalDocument.documentNumber,
      journalDocument.docNumber,
      journalDocument.DocNumber,
    ], 200),
    memo: firstText([
      journalDocument.memo,
      journalDocument.privateNote,
      journalDocument.PrivateNote,
    ], 1000),
    debitCents: journalLines.lineEvidenceAvailable && journalLines.unmappedLineCount === 0
      ? journalLines.groups
        .filter((line) => line.side === 'debit')
        .reduce((total, line) => total + line.amountCents, 0)
      : null,
    creditCents: journalLines.lineEvidenceAvailable && journalLines.unmappedLineCount === 0
      ? journalLines.groups
        .filter((line) => line.side === 'credit')
        .reduce((total, line) => total + line.amountCents, 0)
      : null,
    lineGroups: journalLines.groups,
    lineEvidenceAvailable: journalLines.lineEvidenceAvailable,
    unmappedLineCount: journalLines.unmappedLineCount,
  }

  return {
    draftId,
    businessDate: date,
    documents: journalOnlyPaymentException ? [journal] : [receipt, journal],
  }
}

function amountComparison(
  expectedCents: number | null,
  actualCents: number | null,
): PosAccountingParityAmountComparison {
  if (expectedCents === null || actualCents === null) {
    return { status: 'insufficient_evidence', expectedCents, actualCents, deltaCents: null }
  }
  const deltaCents = actualCents - expectedCents
  return {
    status: deltaCents === 0 ? 'match' : 'variance',
    expectedCents,
    actualCents,
    deltaCents,
  }
}

export function compareSalesReceiptEvidence(
  expected: NormalizedExpectedSalesReceipt,
  actual: NormalizedQuickBooksSalesReceipt,
): PosAccountingSalesReceiptComparison {
  const total = amountComparison(expected.totalCents, actual.totalCents)
  const tax = amountComparison(expected.taxCents, actual.taxCents)
  const expectedById = new Map(expected.lineGroups.map((line) => [line.itemId, line]))
  const actualById = new Map(actual.lineGroups.map((line) => [line.itemId, line]))
  const itemIds = [...new Set([...expectedById.keys(), ...actualById.keys()])].sort()
  const expectedCoverageIncomplete = !expected.lineEvidenceAvailable || expected.unmappedLineCount > 0
  const actualCoverageIncomplete = actual.unidentifiedLineCount > 0 || actual.unsupportedLineCount > 0
  const lines = itemIds.map<PosAccountingReceiptLineComparison>((itemId) => {
    const expectedLine = expectedById.get(itemId)
    const actualLine = actualById.get(itemId)
    let status: PosAccountingReceiptLineComparison['status']
    if (!expectedLine) status = expectedCoverageIncomplete ? 'insufficient_evidence' : 'extra'
    else if (!actualLine) status = actualCoverageIncomplete ? 'insufficient_evidence' : 'missing'
    else status = expectedLine.amountCents === actualLine.amountCents
      && expectedLine.quantityMillis === actualLine.quantityMillis
      ? 'match'
      : 'variance'
    return {
      itemId,
      itemName: expectedLine?.itemName || actualLine?.itemName || null,
      expectedAmountCents: expectedLine?.amountCents ?? null,
      actualAmountCents: actualLine?.amountCents ?? null,
      deltaAmountCents: expectedLine && actualLine
        ? actualLine.amountCents - expectedLine.amountCents
        : null,
      expectedQuantityMillis: expectedLine?.quantityMillis ?? null,
      actualQuantityMillis: actualLine?.quantityMillis ?? null,
      deltaQuantityMillis: expectedLine && actualLine
        ? actualLine.quantityMillis - expectedLine.quantityMillis
        : null,
      status,
    }
  })
  const coverageIncomplete = expectedCoverageIncomplete || actualCoverageIncomplete
  const hasVariance = total.status === 'variance'
    || tax.status === 'variance'
    || lines.some((line) => ['variance', 'missing', 'extra'].includes(line.status))
  const hasInsufficientEvidence = coverageIncomplete
    || total.status === 'insufficient_evidence'
    || tax.status === 'insufficient_evidence'
    || lines.some((line) => line.status === 'insufficient_evidence')
  return {
    status: hasVariance ? 'variance' : hasInsufficientEvidence ? 'insufficient_evidence' : 'match',
    total,
    tax,
    lines,
    coverageIncomplete,
  }
}

export function compareJournalEntryEvidence(
  expected: NormalizedExpectedJournalEntry,
  actual: NormalizedQuickBooksJournalEntry,
): PosAccountingJournalEntryComparison {
  const debits = amountComparison(expected.debitCents, actual.debitCents)
  const credits = amountComparison(expected.creditCents, actual.creditCents)
  const keyFor = (line: PosAccountingJournalLineGroup) => `${line.side}:${line.accountId}`
  const expectedByKey = new Map(expected.lineGroups.map((line) => [keyFor(line), line]))
  const actualByKey = new Map(actual.lineGroups.map((line) => [keyFor(line), line]))
  const keys = [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort()
  const expectedCoverageIncomplete = !expected.lineEvidenceAvailable || expected.unmappedLineCount > 0
  const actualCoverageIncomplete = actual.unidentifiedLineCount > 0 || actual.unsupportedLineCount > 0
  const lines = keys.map<PosAccountingJournalLineComparison>((key) => {
    const expectedLine = expectedByKey.get(key)
    const actualLine = actualByKey.get(key)
    const reference = expectedLine || actualLine
    if (!reference) throw new Error('Journal comparison key has no line evidence')
    let status: PosAccountingJournalLineComparison['status']
    if (!expectedLine) status = expectedCoverageIncomplete ? 'insufficient_evidence' : 'extra'
    else if (!actualLine) status = actualCoverageIncomplete ? 'insufficient_evidence' : 'missing'
    else status = expectedLine.amountCents === actualLine.amountCents ? 'match' : 'variance'
    return {
      side: reference.side,
      accountId: reference.accountId,
      accountName: expectedLine?.accountName || actualLine?.accountName || null,
      expectedAmountCents: expectedLine?.amountCents ?? null,
      actualAmountCents: actualLine?.amountCents ?? null,
      deltaAmountCents: expectedLine && actualLine
        ? actualLine.amountCents - expectedLine.amountCents
        : null,
      status,
    }
  })
  const coverageIncomplete = expectedCoverageIncomplete || actualCoverageIncomplete
  const hasVariance = debits.status === 'variance'
    || credits.status === 'variance'
    || lines.some((line) => ['variance', 'missing', 'extra'].includes(line.status))
  const hasInsufficientEvidence = coverageIncomplete
    || lines.some((line) => line.status === 'insufficient_evidence')
  return {
    status: hasVariance ? 'variance' : hasInsufficientEvidence ? 'insufficient_evidence' : 'match',
    debits,
    credits,
    lines,
    coverageIncomplete,
  }
}

function evidenceKey(evidence: NormalizedQuickBooksPosAccountingEvidence): string {
  return evidence.evidenceId
}

export function matchPosAccountingParityDocuments(input: {
  expected: NormalizedExpectedPosAccountingDocument[]
  actual: NormalizedQuickBooksPosAccountingEvidence[]
}) {
  const expected = [...input.expected].sort((left, right) =>
    left.businessDate.localeCompare(right.businessDate)
      || left.entityType.localeCompare(right.entityType)
      || left.expectedId.localeCompare(right.expectedId))
  const actual = [...input.actual].sort((left, right) =>
    left.businessDate.localeCompare(right.businessDate)
      || left.entityType.localeCompare(right.entityType)
      || left.evidenceId.localeCompare(right.evidenceId))
  const expectedById = new Map(expected.map((item) => [item.expectedId, item]))
  const actualById = new Map(actual.map((item) => [evidenceKey(item), item]))
  const remainingExpected = new Set(expectedById.keys())
  const remainingActual = new Set(actualById.keys())
  const matches = new Map<string, PosAccountingParityMatch>()
  const ambiguityCandidates = new Map<string, Set<string>>()

  const rememberCandidates = (expectedId: string, candidates: string[]) => {
    if (candidates.length < 2) return
    const remembered = ambiguityCandidates.get(expectedId) || new Set<string>()
    candidates.forEach((candidate) => remembered.add(candidate))
    ambiguityCandidates.set(expectedId, remembered)
  }

  const applyExactPhase = (
    basis: PosAccountingParityMatchBasis,
    expectedSelector: (item: NormalizedExpectedPosAccountingDocument) => string | null,
    actualSelector: (item: NormalizedQuickBooksPosAccountingEvidence) => string | null,
  ) => {
    const expectedGroups = new Map<string, string[]>()
    const actualGroups = new Map<string, string[]>()
    for (const expectedId of remainingExpected) {
      const item = expectedById.get(expectedId)
      if (!item) continue
      const selected = expectedSelector(item)
      if (!selected) continue
      const key = `${item.businessDate}\u0000${item.entityType}\u0000${selected}`
      expectedGroups.set(key, [...(expectedGroups.get(key) || []), expectedId])
    }
    for (const actualId of remainingActual) {
      const item = actualById.get(actualId)
      if (!item) continue
      const selected = actualSelector(item)
      if (!selected) continue
      const key = `${item.businessDate}\u0000${item.entityType}\u0000${selected}`
      actualGroups.set(key, [...(actualGroups.get(key) || []), actualId])
    }
    for (const [key, expectedIds] of expectedGroups) {
      const actualIds = actualGroups.get(key) || []
      if (expectedIds.length === 1 && actualIds.length === 1) {
        const expectedId = expectedIds[0]
        const actualId = actualIds[0]
        const expectedItem = expectedById.get(expectedId)
        const actualItem = actualById.get(actualId)
        if (!expectedItem || !actualItem) continue
        matches.set(expectedId, {
          expected: expectedItem,
          actual: actualItem,
          status: 'matched',
          basis,
          candidateTransactionIds: [actualItem.providerTransactionId || actualItem.evidenceId],
        })
        remainingExpected.delete(expectedId)
        remainingActual.delete(actualId)
      } else if (actualIds.length > 1 || expectedIds.length > 1) {
        expectedIds.forEach((expectedId) => rememberCandidates(expectedId, actualIds))
      }
    }
  }

  applyExactPhase(
    'provider_id',
    (item) => item.providerTransactionId,
    (item) => item.providerTransactionId,
  )
  applyExactPhase(
    'memo',
    (item) => normalizedIdentity(item.memo),
    (item) => normalizedIdentity(item.memo),
  )

  const dateGroups = new Set<string>()
  for (const expectedId of remainingExpected) {
    const item = expectedById.get(expectedId)
    if (item) dateGroups.add(`${item.businessDate}\u0000${item.entityType}`)
  }
  for (const group of dateGroups) {
    const expectedIds = [...remainingExpected].filter((expectedId) => {
      const item = expectedById.get(expectedId)
      return item && `${item.businessDate}\u0000${item.entityType}` === group
    })
    const actualIds = [...remainingActual].filter((actualId) => {
      const item = actualById.get(actualId)
      return item && `${item.businessDate}\u0000${item.entityType}` === group
    })
    if (expectedIds.length !== 1 || actualIds.length !== 1) continue
    const expectedId = expectedIds[0]
    const actualId = actualIds[0]
    const expectedItem = expectedById.get(expectedId)
    const actualItem = actualById.get(actualId)
    if (!expectedItem || !actualItem) continue
    if (evidenceIdentifiersConflict(expectedItem, actualItem)) continue
    matches.set(expectedId, {
      expected: expectedItem,
      actual: actualItem,
      status: 'matched',
      basis: 'date_only',
      candidateTransactionIds: [actualItem.providerTransactionId || actualItem.evidenceId],
    })
    remainingExpected.delete(expectedId)
    remainingActual.delete(actualId)
  }

  for (const expectedId of remainingExpected) {
    const expectedItem = expectedById.get(expectedId)
    if (!expectedItem) continue
    const sameDateActual = [...remainingActual]
      .map((actualId) => actualById.get(actualId))
      .filter((item): item is NormalizedQuickBooksPosAccountingEvidence => Boolean(
        item
          && item.businessDate === expectedItem.businessDate
          && item.entityType === expectedItem.entityType,
      ))
    const remembered = ambiguityCandidates.get(expectedId) || new Set<string>()
    const candidates = sameDateActual.length > 0
      ? sameDateActual
      : [...remembered].map((actualId) => actualById.get(actualId)).filter(
        (item): item is NormalizedQuickBooksPosAccountingEvidence => Boolean(item),
      )
    const candidateTransactionIds = [...new Set(candidates.map(
      (item) => item.providerTransactionId || item.evidenceId,
    ))].sort()
    matches.set(expectedId, {
      expected: expectedItem,
      actual: null,
      status: candidateTransactionIds.length > 0 ? 'ambiguous' : 'missing_quickbooks',
      basis: null,
      candidateTransactionIds,
    })
  }

  const orderedMatches = expected.map((item) => matches.get(item.expectedId)).filter(
    (item): item is PosAccountingParityMatch => Boolean(item),
  )
  const unmatchedQuickBooks = [...remainingActual].map((actualId) => {
    const evidence = actualById.get(actualId)
    if (!evidence) throw new Error('Unmatched QuickBooks evidence disappeared')
    const candidateDraftIds = [...remainingExpected]
      .map((expectedId) => expectedById.get(expectedId))
      .filter((item): item is NormalizedExpectedPosAccountingDocument => Boolean(
        item
          && item.businessDate === evidence.businessDate
          && item.entityType === evidence.entityType,
      ))
      .map((item) => item.draft.id)
      .filter((draftId, index, all) => all.indexOf(draftId) === index)
      .sort()
    return { evidence, candidateDraftIds, ambiguous: candidateDraftIds.length > 0 }
  })

  return { matches: orderedMatches, unmatchedQuickBooks }
}

export function compareSalesReceiptInternalArithmetic(
  receipt: NormalizedQuickBooksSalesReceipt,
): PosAccountingReceiptArithmeticCheck {
  const { subtotalCents, taxCents, totalCents } = receipt
  const lineSumIsIncomplete = receipt.subtotalSource === 'line_sum'
    && (receipt.unidentifiedLineCount > 0 || receipt.unsupportedLineCount > 0)
  if (subtotalCents === null || taxCents === null || totalCents === null || lineSumIsIncomplete) {
    return {
      status: 'insufficient_evidence',
      subtotalCents,
      taxCents,
      totalCents,
      deltaCents: null,
    }
  }
  const deltaCents = totalCents - subtotalCents - taxCents
  return {
    status: deltaCents === 0 ? 'match' : 'variance',
    subtotalCents,
    taxCents,
    totalCents,
    deltaCents,
  }
}

export function compareJournalEntryBalance(
  journal: NormalizedQuickBooksJournalEntry,
): PosAccountingJournalBalanceCheck {
  const deltaCents = journal.debitCents - journal.creditCents
  return {
    status: journal.unidentifiedLineCount > 0 || journal.unsupportedLineCount > 0
      ? 'insufficient_evidence'
      : deltaCents === 0 ? 'match' : 'variance',
    debitCents: journal.debitCents,
    creditCents: journal.creditCents,
    deltaCents,
  }
}

function historicalEvidenceReference(
  evidence: NormalizedQuickBooksPosAccountingEvidence,
): PosAccountingHistoricalEvidenceReference {
  return {
    evidenceId: evidence.evidenceId,
    entityType: evidence.entityType,
    providerTransactionId: evidence.providerTransactionId,
    businessDate: evidence.businessDate,
    documentNumber: evidence.documentNumber,
    memo: evidence.memo,
    postingOrigin: evidence.postingOrigin,
  }
}

function statusCounts(statuses: Array<'match' | 'variance' | 'insufficient_evidence'>) {
  return {
    match: statuses.filter((status) => status === 'match').length,
    variance: statuses.filter((status) => status === 'variance').length,
    insufficientEvidence: statuses.filter((status) => status === 'insufficient_evidence').length,
  }
}

export function buildHistoricalPosAccountingBaseline(
  evidence: readonly NormalizedQuickBooksPosAccountingEvidence[],
): PosAccountingHistoricalBaseline {
  const receipts = evidence
    .filter((item): item is NormalizedQuickBooksSalesReceipt => item.entityType === 'SalesReceipt')
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate)
      || left.evidenceId.localeCompare(right.evidenceId))
  const journals = evidence
    .filter((item): item is NormalizedQuickBooksJournalEntry => item.entityType === 'JournalEntry')
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate)
      || left.evidenceId.localeCompare(right.evidenceId))
  const receiptById = new Map(receipts.map((item) => [item.evidenceId, item]))
  const journalById = new Map(journals.map((item) => [item.evidenceId, item]))
  const remainingReceipts = new Set(receiptById.keys())
  const remainingJournals = new Set(journalById.keys())
  const ambiguousEvidenceIds = new Set<string>()
  const pairs: PosAccountingHistoricalBaseline['pairs'] = []
  const ambiguousGroups: PosAccountingHistoricalBaseline['ambiguousGroups'] = []

  const appendPair = (
    receipt: NormalizedQuickBooksSalesReceipt,
    journal: NormalizedQuickBooksJournalEntry,
    basis: 'business_date_and_marker' | 'business_date_only',
  ) => {
    pairs.push({
      basis,
      businessDate: receipt.businessDate,
      salesReceipt: historicalEvidenceReference(receipt),
      journalEntry: historicalEvidenceReference(journal),
      receiptArithmetic: compareSalesReceiptInternalArithmetic(receipt),
      journalBalance: compareJournalEntryBalance(journal),
    })
    remainingReceipts.delete(receipt.evidenceId)
    remainingJournals.delete(journal.evidenceId)
  }

  const markerReceiptGroups = new Map<string, NormalizedQuickBooksSalesReceipt[]>()
  const markerJournalGroups = new Map<string, NormalizedQuickBooksJournalEntry[]>()
  for (const receipt of receipts) {
    const marker = normalizedIdentity(receipt.memo)
    if (!marker) continue
    const key = `${receipt.businessDate}\u0000${marker}`
    markerReceiptGroups.set(key, [...(markerReceiptGroups.get(key) || []), receipt])
  }
  for (const journal of journals) {
    const marker = normalizedIdentity(journal.memo)
    if (!marker) continue
    const key = `${journal.businessDate}\u0000${marker}`
    markerJournalGroups.set(key, [...(markerJournalGroups.get(key) || []), journal])
  }
  const markerKeys = [...new Set([
    ...markerReceiptGroups.keys(),
    ...markerJournalGroups.keys(),
  ])].sort()
  for (const key of markerKeys) {
    const groupReceipts = markerReceiptGroups.get(key) || []
    const groupJournals = markerJournalGroups.get(key) || []
    if (groupReceipts.length === 0 || groupJournals.length === 0) continue
    if (groupReceipts.length === 1 && groupJournals.length === 1) {
      appendPair(groupReceipts[0], groupJournals[0], 'business_date_and_marker')
      continue
    }
    const groupEvidence = [...groupReceipts, ...groupJournals]
    groupEvidence.forEach((item) => {
      ambiguousEvidenceIds.add(item.evidenceId)
      remainingReceipts.delete(item.evidenceId)
      remainingJournals.delete(item.evidenceId)
    })
    ambiguousGroups.push({
      basis: 'business_date_and_marker',
      businessDate: groupEvidence[0].businessDate,
      documentNumber: null,
      salesReceipts: groupReceipts.map(historicalEvidenceReference),
      journalEntries: groupJournals.map(historicalEvidenceReference),
    })
  }

  const remainingDates = [...new Set([
    ...[...remainingReceipts].map((id) => receiptById.get(id)?.businessDate).filter(Boolean),
    ...[...remainingJournals].map((id) => journalById.get(id)?.businessDate).filter(Boolean),
  ] as string[])].sort()
  for (const date of remainingDates) {
    const dateReceipts = [...remainingReceipts]
      .map((id) => receiptById.get(id))
      .filter((item): item is NormalizedQuickBooksSalesReceipt => item?.businessDate === date)
    const dateJournals = [...remainingJournals]
      .map((id) => journalById.get(id))
      .filter((item): item is NormalizedQuickBooksJournalEntry => item?.businessDate === date)
    if (dateReceipts.length === 0 || dateJournals.length === 0) continue
    if (dateReceipts.length === 1 && dateJournals.length === 1) {
      if (!evidenceIdentifiersConflict(dateReceipts[0], dateJournals[0])) {
        appendPair(dateReceipts[0], dateJournals[0], 'business_date_only')
        continue
      }
      const groupEvidence = [...dateReceipts, ...dateJournals]
      groupEvidence.forEach((item) => {
        ambiguousEvidenceIds.add(item.evidenceId)
        remainingReceipts.delete(item.evidenceId)
        remainingJournals.delete(item.evidenceId)
      })
      ambiguousGroups.push({
        basis: 'business_date_only',
        businessDate: date,
        documentNumber: null,
        salesReceipts: dateReceipts.map(historicalEvidenceReference),
        journalEntries: dateJournals.map(historicalEvidenceReference),
      })
      continue
    }
    const groupEvidence = [...dateReceipts, ...dateJournals]
    groupEvidence.forEach((item) => {
      ambiguousEvidenceIds.add(item.evidenceId)
      remainingReceipts.delete(item.evidenceId)
      remainingJournals.delete(item.evidenceId)
    })
    ambiguousGroups.push({
      basis: 'business_date_only',
      businessDate: date,
      documentNumber: null,
      salesReceipts: dateReceipts.map(historicalEvidenceReference),
      journalEntries: dateJournals.map(historicalEvidenceReference),
    })
  }

  const unmatchedByGroup = new Map<string, NormalizedQuickBooksPosAccountingEvidence[]>()
  const unmatchedEvidence = [
    ...[...remainingReceipts].map((id) => receiptById.get(id)),
    ...[...remainingJournals].map((id) => journalById.get(id)),
  ].filter((item): item is NormalizedQuickBooksPosAccountingEvidence => Boolean(item))
  for (const item of unmatchedEvidence) {
    const document = normalizedIdentity(item.documentNumber) || ''
    const key = `${item.businessDate}\u0000${item.entityType}\u0000${document}`
    unmatchedByGroup.set(key, [...(unmatchedByGroup.get(key) || []), item])
  }
  const unmatchedGroups = [...unmatchedByGroup.values()].map((group) => ({
    businessDate: group[0].businessDate,
    documentNumber: group[0].documentNumber,
    entityType: group[0].entityType,
    evidence: group.map(historicalEvidenceReference),
  })).sort((left, right) => right.businessDate.localeCompare(left.businessDate)
    || left.entityType.localeCompare(right.entityType)
    || (left.documentNumber || '').localeCompare(right.documentNumber || ''))

  pairs.sort((left, right) => right.businessDate.localeCompare(left.businessDate)
    || left.salesReceipt.evidenceId.localeCompare(right.salesReceipt.evidenceId))
  ambiguousGroups.sort((left, right) => right.businessDate.localeCompare(left.businessDate)
    || left.basis.localeCompare(right.basis)
    || (left.documentNumber || '').localeCompare(right.documentNumber || ''))
  const receiptChecks = receipts.map(compareSalesReceiptInternalArithmetic)
  const journalChecks = journals.map(compareJournalEntryBalance)
  return {
    summary: {
      cachedTransactions: evidence.length,
      pairCount: pairs.length,
      exactMarkerPairs: pairs
        .filter((pair) => pair.basis === 'business_date_and_marker').length,
      dateFallbackPairs: pairs.filter((pair) => pair.basis === 'business_date_only').length,
      unmatchedGroups: unmatchedGroups.length,
      unmatchedEvidence: unmatchedEvidence.length,
      ambiguousGroups: ambiguousGroups.length,
      ambiguousEvidence: ambiguousEvidenceIds.size,
      receiptArithmetic: statusCounts(receiptChecks.map((check) => check.status)),
      journalBalance: statusCounts(journalChecks.map((check) => check.status)),
    },
    pairs,
    unmatchedGroups,
    ambiguousGroups,
  }
}

export function buildPosAccountingParityReport(input: {
  drafts: readonly unknown[]
  transactions: readonly unknown[]
  fullHistoryTransactions?: readonly unknown[]
}): PosAccountingParityReport {
  const drafts = input.drafts
    .map(normalizePosAccountingDraftEvidence)
    .filter((item): item is NormalizedPosAccountingDraftEvidence => Boolean(item))
  const linkedProviderIds = new Set(drafts.flatMap((draft) => draft.documents
    .filter((document) => document.draft.postingOrigin === 'clawpilot')
    .map((document) => document.providerTransactionId)
    .filter((providerId): providerId is string => Boolean(providerId))))
  const toastTransactions = input.transactions.filter(
    (transaction) => classifyPosAccountingQuickBooksTransaction(transaction, linkedProviderIds) !== null,
  )
  const transactions = toastTransactions
    .map((transaction) => normalizeQuickBooksPosAccountingEvidence(transaction, linkedProviderIds))
    .filter((item): item is NormalizedQuickBooksPosAccountingEvidence => Boolean(item))
  const fullHistoryInput = input.fullHistoryTransactions ?? input.transactions
  const fullHistoryTransactions = fullHistoryInput
    .filter((transaction) => classifyPosAccountingQuickBooksTransaction(transaction, linkedProviderIds) !== null)
    .map((transaction) => normalizeQuickBooksPosAccountingEvidence(transaction, linkedProviderIds))
    .filter((item): item is NormalizedQuickBooksPosAccountingEvidence => Boolean(item))
  const expected = drafts.flatMap((draft) => draft.documents)
  const matched = matchPosAccountingParityDocuments({ expected, actual: transactions })
  const rows = matched.matches.map((match) => {
    let comparison: PosAccountingParityComparison | null = null
    if (match.actual && match.expected.entityType === 'SalesReceipt'
      && match.actual.entityType === 'SalesReceipt') {
      comparison = compareSalesReceiptEvidence(match.expected, match.actual)
    } else if (match.actual && match.expected.entityType === 'JournalEntry'
      && match.actual.entityType === 'JournalEntry') {
      comparison = compareJournalEntryEvidence(match.expected, match.actual)
    }
    return {
      expected: match.expected,
      actual: match.actual,
      match: {
        status: match.status,
        basis: match.basis,
        candidateTransactionIds: match.candidateTransactionIds,
      },
      comparison,
    }
  }).sort((left, right) =>
    right.expected.businessDate.localeCompare(left.expected.businessDate)
      || (left.expected.draft.locationName || left.expected.draft.restaurantName || '')
        .localeCompare(right.expected.draft.locationName || right.expected.draft.restaurantName || '')
      || left.expected.draft.id.localeCompare(right.expected.draft.id)
      || left.expected.entityType.localeCompare(right.expected.entityType))
  const dates = [...new Set([
    ...drafts.map((draft) => draft.businessDate),
    ...transactions.map((transaction) => transaction.businessDate),
  ])].sort().reverse()
  const comparisonStatuses = rows.map((row) => row.comparison?.status).filter(Boolean)
  return {
    dates,
    historicalBaseline: buildHistoricalPosAccountingBaseline(fullHistoryTransactions),
    rows,
    unmatchedQuickBooks: matched.unmatchedQuickBooks,
    discardedEvidence: {
      drafts: input.drafts.length - drafts.length,
      quickBooksTransactions: toastTransactions.length - transactions.length,
      nonToastQuickBooksTransactions: input.transactions.length - toastTransactions.length,
    },
    summary: {
      drafts: drafts.length,
      expectedDocuments: expected.length,
      cachedTransactions: transactions.length,
      matched: rows.filter((row) => row.match.status === 'matched').length,
      ambiguous: rows.filter((row) => row.match.status === 'ambiguous').length,
      missingQuickBooks: rows.filter((row) => row.match.status === 'missing_quickbooks').length,
      unmatchedQuickBooks: matched.unmatchedQuickBooks.length,
      comparisonsMatched: comparisonStatuses.filter((status) => status === 'match').length,
      comparisonsWithVariance: comparisonStatuses.filter((status) => status === 'variance').length,
      comparisonsWithInsufficientEvidence: comparisonStatuses
        .filter((status) => status === 'insufficient_evidence').length,
    },
  }
}

function requiredOrganizationId(value: unknown): string {
  const candidate = text(value, 100)
  if (!candidate || !UUID_PATTERN.test(candidate)) throw new Error('A valid organizationId is required')
  return candidate.toLowerCase()
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  const candidate = businessDate(value)
  if (!candidate) throw new Error(`${label} must be a valid YYYY-MM-DD business date`)
  return candidate
}

function positiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === null || value === undefined) return fallback
  const candidate = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`)
  }
  return candidate
}

function numberFromDatabase(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

const SHOGO_TRANSACTION_MARKER_SQL = `(
  substring(lower(coalesce(transaction.memo, ''))
    from '^[[:space:]]*toast[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})')
    = to_char(transaction.transaction_date, 'YYYY-MM-DD')
  OR substring(lower(coalesce(transaction.source_payload ->> 'PrivateNote', ''))
    from '^[[:space:]]*toast[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})')
    = to_char(transaction.transaction_date, 'YYYY-MM-DD')
  OR substring(lower(coalesce(transaction.source_payload #>> '{CustomerMemo,value}', ''))
    from '^[[:space:]]*toast[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})')
    = to_char(transaction.transaction_date, 'YYYY-MM-DD')
  OR substring(lower(coalesce(transaction.source_payload ->> 'Memo', ''))
    from '^[[:space:]]*toast[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})')
    = to_char(transaction.transaction_date, 'YYYY-MM-DD')
)`

const DRAFT_EVIDENCE_LINK_SQL = `EXISTS (
  SELECT 1
  FROM toast_accounting_export_drafts linked_draft
  WHERE linked_draft.organization_id = transaction.organization_id
    AND transaction.quickbooks_transaction_id = ANY(ARRAY[
      linked_draft.quickbooks_sales_receipt_id,
      linked_draft.quickbooks_journal_entry_id,
      linked_draft.quickbooks_transaction_id,
      linked_draft.source_summary #>> '{canonical,parity,documents,salesReceipt,providerTransactionId}',
      linked_draft.source_summary #>> '{canonical,parity,documents,journalEntry,providerTransactionId}',
      linked_draft.source_summary #>> '{canonical,documents,salesReceipt,providerTransactionId}',
      linked_draft.source_summary #>> '{canonical,documents,journalEntry,providerTransactionId}',
      linked_draft.quickbooks_payload #>> '{SalesReceipt,Id}',
      linked_draft.quickbooks_payload #>> '{JournalEntry,Id}',
      linked_draft.quickbooks_payload #>> '{salesReceipt,providerTransactionId}',
      linked_draft.quickbooks_payload #>> '{journalEntry,providerTransactionId}'
    ])
)`

const DRAFT_EVIDENCE_ORIGIN_SQL = `(
  SELECT (array_agg(
    linked_draft.posting_origin
    ORDER BY linked_draft.is_current DESC, linked_draft.reviewed_at DESC NULLS LAST,
      linked_draft.updated_at DESC
  ))[1]
  FROM toast_accounting_export_drafts linked_draft
  WHERE linked_draft.organization_id = transaction.organization_id
    AND linked_draft.posting_origin IN ('shogo', 'external', 'clawpilot')
    AND transaction.quickbooks_transaction_id = ANY(ARRAY[
      linked_draft.quickbooks_sales_receipt_id,
      linked_draft.quickbooks_journal_entry_id,
      linked_draft.quickbooks_transaction_id
    ])
)`

const POS_ACCOUNTING_TRANSACTION_SQL = `(
  ${SHOGO_TRANSACTION_MARKER_SQL}
  OR ${DRAFT_EVIDENCE_LINK_SQL}
)`

const POS_ACCOUNTING_ORIGIN_SQL = `COALESCE(
  ${DRAFT_EVIDENCE_ORIGIN_SQL},
  CASE WHEN ${SHOGO_TRANSACTION_MARKER_SQL} THEN 'shogo' END,
  CASE WHEN ${DRAFT_EVIDENCE_LINK_SQL} THEN 'external' END
)`

const EVIDENCE_DATES_CTE = `WITH evidence_dates AS (
  SELECT draft.business_date AS evidence_date
  FROM toast_accounting_export_drafts draft
  WHERE draft.organization_id = $1::uuid
    AND draft.is_current = true
    AND ($2::date IS NULL OR draft.business_date >= $2::date)
    AND ($3::date IS NULL OR draft.business_date <= $3::date)
  UNION
  SELECT transaction.transaction_date AS evidence_date
  FROM quickbooks_transactions transaction
  WHERE transaction.organization_id = $1::uuid
    AND transaction.entity_type IN ('SalesReceipt', 'JournalEntry')
    AND transaction.transaction_date IS NOT NULL
    AND ${POS_ACCOUNTING_TRANSACTION_SQL}
    AND ($2::date IS NULL OR transaction.transaction_date >= $2::date)
    AND ($3::date IS NULL OR transaction.transaction_date <= $3::date)
)`

export async function readPosAccountingParityReportInPostgres(
  input: ReadPosAccountingParityInput,
): Promise<PosAccountingParityPostgresReport> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const fromBusinessDate = optionalDate(input.fromBusinessDate, 'fromBusinessDate')
  const toBusinessDate = optionalDate(input.toBusinessDate, 'toBusinessDate')
  if (fromBusinessDate && toBusinessDate && fromBusinessDate > toBusinessDate) {
    throw new Error('fromBusinessDate must be on or before toBusinessDate')
  }
  const page = positiveInteger(input.page, 1, 100000, 'page')
  const pageSize = positiveInteger(input.pageSize, 90, 366, 'pageSize')
  const historyPage = positiveInteger(input.historyPage, 1, 100000, 'historyPage')
  const historyPageSize = positiveInteger(input.historyPageSize, 20, 100, 'historyPageSize')
  const baseValues = [organizationId, fromBusinessDate, toBusinessDate]

  const [countResult, dateResult, cacheResult, fullHistoryResult] = await Promise.all([
    query<{ total_dates: string }>(
      `${EVIDENCE_DATES_CTE}
       SELECT count(*)::text AS total_dates FROM evidence_dates`,
      baseValues,
    ),
    query<{ business_date: string }>(
      `${EVIDENCE_DATES_CTE}
       SELECT evidence_date::text AS business_date
       FROM evidence_dates
       ORDER BY evidence_date DESC
       LIMIT $4::integer OFFSET $5::integer`,
      [...baseValues, pageSize, (page - 1) * pageSize],
    ),
    query<{
      configured: boolean
      connection_status: string | null
      last_catalog_synced_at: string | null
      sync_status: string | null
      sync_completed_at: string | null
      sales_receipt_count: string
      journal_entry_count: string
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM organization_quickbooks_connections connection
           WHERE connection.organization_id = $1::uuid
         ) AS configured,
         (
           SELECT connection.status FROM organization_quickbooks_connections connection
           WHERE connection.organization_id = $1::uuid
         ) AS connection_status,
         (
           SELECT connection.last_catalog_synced_at::text
           FROM organization_quickbooks_connections connection
           WHERE connection.organization_id = $1::uuid
         ) AS last_catalog_synced_at,
         (
           SELECT outbox.status FROM quickbooks_sync_outbox outbox
           WHERE outbox.organization_id = $1::uuid AND outbox.sync_kind = 'catalog'
         ) AS sync_status,
         (
           SELECT outbox.completed_at::text FROM quickbooks_sync_outbox outbox
           WHERE outbox.organization_id = $1::uuid AND outbox.sync_kind = 'catalog'
         ) AS sync_completed_at,
         (
           SELECT count(*)::text FROM quickbooks_transactions transaction
           WHERE transaction.organization_id = $1::uuid
             AND transaction.entity_type = 'SalesReceipt'
             AND ${POS_ACCOUNTING_TRANSACTION_SQL}
         ) AS sales_receipt_count,
         (
           SELECT count(*)::text FROM quickbooks_transactions transaction
           WHERE transaction.organization_id = $1::uuid
             AND transaction.entity_type = 'JournalEntry'
             AND ${POS_ACCOUNTING_TRANSACTION_SQL}
         ) AS journal_entry_count`,
      [organizationId],
    ),
    query<{
      entity_type: string
      quickbooks_transaction_id: string
      document_number: string | null
      transaction_date: string
      currency_code: string | null
      total_amount: string
      memo: string | null
      source_payload: unknown
      synced_at: string
      party_name: string | null
      account_name: string | null
      pos_accounting_origin: PosAccountingPostingOrigin
    }>(
      `SELECT transaction.entity_type, transaction.quickbooks_transaction_id,
         transaction.document_number, transaction.transaction_date::text,
         transaction.currency_code, transaction.total_amount::text,
         transaction.memo, transaction.source_payload, transaction.synced_at::text,
         transaction.party_name, transaction.account_name,
         ${POS_ACCOUNTING_ORIGIN_SQL} AS pos_accounting_origin
       FROM quickbooks_transactions transaction
       WHERE transaction.organization_id = $1::uuid
         AND transaction.entity_type IN ('SalesReceipt', 'JournalEntry')
         AND transaction.transaction_date IS NOT NULL
         AND ($2::date IS NULL OR transaction.transaction_date >= $2::date)
         AND ($3::date IS NULL OR transaction.transaction_date <= $3::date)
         AND ${POS_ACCOUNTING_TRANSACTION_SQL}
       ORDER BY transaction.transaction_date DESC, transaction.entity_type,
         transaction.quickbooks_transaction_id`,
      baseValues,
    ),
  ])

  const dates = dateResult.rows
    .map((row) => businessDate(row.business_date))
    .filter((date): date is string => Boolean(date))
  const pageDates = new Set(dates)
  let drafts: unknown[] = []
  const transactions: unknown[] = fullHistoryResult.rows.filter((row) => {
    const date = businessDate(row.transaction_date)
    return date ? pageDates.has(date) : false
  })
  if (dates.length > 0) {
    const draftResult = await query<{
      id: string
      restaurant_guid: string
      restaurant_name: string | null
      location_name: string | null
      business_date: string
      status: string
      reconciliation_status: string
      source_summary: unknown
      proposed_lines: unknown
      quickbooks_payload: unknown
      quickbooks_transaction_id: string | null
      quickbooks_sales_receipt_id: string | null
      quickbooks_journal_entry_id: string | null
      review_outcome: string | null
      posting_origin: PosAccountingPostingOrigin | null
      reviewed_by: string | null
      reviewed_at: string | null
      review_note: string | null
      external_posting_provider: string | null
      external_posting_reference: string | null
      posting_batch_id: string | null
      posting_batch_status: string | null
      posting_batch_fingerprint: string | null
      posting_batch_requested_by: string | null
      posting_batch_approved_by: string | null
      posting_batch_approval_note: string | null
      posting_batch_last_error: string | null
      posting_batch_submitted_at: string | null
      posting_batch_approved_at: string | null
      posting_batch_posted_at: string | null
      posting_batch_updated_at: string | null
      sales_receipt_request_id: string | null
      sales_receipt_request_status: string | null
      sales_receipt_provider_entity_id: string | null
      sales_receipt_request_error: string | null
      journal_entry_request_id: string | null
      journal_entry_request_status: string | null
      journal_entry_provider_entity_id: string | null
      journal_entry_request_error: string | null
      draft_revision: number
      source_revision: number
      updated_at: string
    }>(
      `SELECT draft.id::text, draft.restaurant_guid::text,
         location.restaurant_name, location.location_name,
         draft.business_date::text, draft.status, draft.reconciliation_status,
         draft.source_summary, draft.proposed_lines, draft.quickbooks_payload,
         draft.quickbooks_transaction_id, draft.quickbooks_sales_receipt_id,
         draft.quickbooks_journal_entry_id, draft.review_outcome, draft.posting_origin,
         draft.reviewed_by, draft.reviewed_at::text, draft.review_note,
         draft.external_posting_provider, draft.external_posting_reference,
         posting_batch.id::text AS posting_batch_id,
         posting_batch.status AS posting_batch_status,
         posting_batch.request_fingerprint AS posting_batch_fingerprint,
         posting_batch.requested_by AS posting_batch_requested_by,
         posting_batch.approved_by AS posting_batch_approved_by,
         posting_batch.approval_note AS posting_batch_approval_note,
         posting_batch.last_error AS posting_batch_last_error,
         posting_batch.submitted_at::text AS posting_batch_submitted_at,
         posting_batch.approved_at::text AS posting_batch_approved_at,
         posting_batch.posted_at::text AS posting_batch_posted_at,
         posting_batch.updated_at::text AS posting_batch_updated_at,
         receipt_request.id::text AS sales_receipt_request_id,
         receipt_request.status AS sales_receipt_request_status,
         receipt_request.provider_entity_id AS sales_receipt_provider_entity_id,
         receipt_request.last_error_message AS sales_receipt_request_error,
         journal_request.id::text AS journal_entry_request_id,
         journal_request.status AS journal_entry_request_status,
         journal_request.provider_entity_id AS journal_entry_provider_entity_id,
         journal_request.last_error_message AS journal_entry_request_error,
         draft.draft_revision, draft.source_revision,
         draft.updated_at::text
       FROM toast_accounting_export_drafts draft
       LEFT JOIN toast_locations location
        ON location.organization_id = draft.organization_id
        AND location.restaurant_guid = draft.restaurant_guid
       LEFT JOIN pos_accounting_posting_batches posting_batch
         ON posting_batch.organization_id = draft.organization_id
        AND posting_batch.id = draft.posting_batch_id
       LEFT JOIN quickbooks_write_requests receipt_request
         ON receipt_request.organization_id = posting_batch.organization_id
        AND receipt_request.id = posting_batch.sales_receipt_request_id
       LEFT JOIN quickbooks_write_requests journal_request
         ON journal_request.organization_id = posting_batch.organization_id
        AND journal_request.id = posting_batch.journal_entry_request_id
       WHERE draft.organization_id = $1::uuid
         AND draft.is_current = true
         AND draft.business_date = ANY($2::date[])
       ORDER BY draft.business_date DESC, draft.restaurant_guid, draft.id`,
      [organizationId, dates],
    )
    drafts = draftResult.rows
  }

  const fullReport = buildPosAccountingParityReport({
    drafts,
    transactions,
    fullHistoryTransactions: fullHistoryResult.rows,
  })
  const historicalOffset = (historyPage - 1) * historyPageSize
  const historicalBaseline = fullReport.historicalBaseline
  const historicalPagination = {
    page: historyPage,
    pageSize: historyPageSize,
    pairPages: historicalBaseline.pairs.length === 0
      ? 0
      : Math.ceil(historicalBaseline.pairs.length / historyPageSize),
    unmatchedPages: historicalBaseline.unmatchedGroups.length === 0
      ? 0
      : Math.ceil(historicalBaseline.unmatchedGroups.length / historyPageSize),
    ambiguousPages: historicalBaseline.ambiguousGroups.length === 0
      ? 0
      : Math.ceil(historicalBaseline.ambiguousGroups.length / historyPageSize),
    totalPages: 0,
  }
  historicalPagination.totalPages = Math.max(
    historicalPagination.pairPages,
    historicalPagination.unmatchedPages,
    historicalPagination.ambiguousPages,
  )
  const report: PosAccountingParityReport = {
    ...fullReport,
    historicalBaseline: {
      ...historicalBaseline,
      pairs: historicalBaseline.pairs.slice(historicalOffset, historicalOffset + historyPageSize),
      unmatchedGroups: historicalBaseline.unmatchedGroups
        .slice(historicalOffset, historicalOffset + historyPageSize),
      ambiguousGroups: historicalBaseline.ambiguousGroups
        .slice(historicalOffset, historicalOffset + historyPageSize),
    },
  }
  const totalDates = numberFromDatabase(countResult.rows[0]?.total_dates)
  const cacheRow = cacheResult.rows[0]
  const cache = {
    configured: cacheRow?.configured === true,
    connectionStatus: text(cacheRow?.connection_status, 80),
    lastCatalogSyncedAt: timestamp(cacheRow?.last_catalog_synced_at),
    syncStatus: text(cacheRow?.sync_status, 80),
    syncCompletedAt: timestamp(cacheRow?.sync_completed_at),
    salesReceiptCount: numberFromDatabase(cacheRow?.sales_receipt_count),
    journalEntryCount: numberFromDatabase(cacheRow?.journal_entry_count),
  }
  const warnings: string[] = []
  if (!cache.configured) warnings.push('QuickBooks is not configured for this organization.')
  else if (cache.connectionStatus !== 'active') warnings.push('The QuickBooks connection is not active.')
  if (cache.syncStatus !== 'succeeded') {
    warnings.push('The latest QuickBooks catalog sync is not marked succeeded; unmatched evidence may be incomplete.')
  }
  if (report.discardedEvidence.drafts > 0 || report.discardedEvidence.quickBooksTransactions > 0) {
    warnings.push('Evidence with an invalid identifier, entity type, or business date was excluded.')
  }

  return {
    ...report,
    pagination: {
      page,
      pageSize,
      totalDates,
      totalPages: totalDates === 0 ? 0 : Math.ceil(totalDates / pageSize),
      dates,
    },
    historicalPagination,
    cache,
    warnings,
  }
}

export async function readPosAccountingParityEvidenceDetailInPostgres(
  input: ReadPosAccountingParityEvidenceInput,
): Promise<PosAccountingParityEvidenceDetail | null> {
  const organizationId = requiredOrganizationId(input.organizationId)
  const type = entityType(input.entityType)
  if (!type) throw new Error('A valid parity entityType is required')
  const transactionId = text(input.providerTransactionId, 200)
  if (!transactionId || /[^\x20-\x7e]/.test(transactionId)) {
    throw new Error('A valid providerTransactionId is required')
  }
  const result = await query<{
    entity_type: string
    quickbooks_transaction_id: string
    document_number: string | null
    transaction_date: string
    currency_code: string | null
    total_amount: string
    memo: string | null
    source_payload: unknown
    synced_at: string
    party_name: string | null
    account_name: string | null
    pos_accounting_origin: PosAccountingPostingOrigin
  }>(
    `SELECT transaction.entity_type, transaction.quickbooks_transaction_id,
       transaction.document_number, transaction.transaction_date::text,
       transaction.currency_code, transaction.total_amount::text,
       transaction.memo, transaction.source_payload, transaction.synced_at::text,
       transaction.party_name, transaction.account_name,
       ${POS_ACCOUNTING_ORIGIN_SQL} AS pos_accounting_origin
     FROM quickbooks_transactions transaction
     WHERE transaction.organization_id = $1::uuid
       AND transaction.entity_type = $2
       AND transaction.quickbooks_transaction_id = $3
       AND transaction.transaction_date IS NOT NULL
       AND ${POS_ACCOUNTING_TRANSACTION_SQL}
     LIMIT 1`,
    [organizationId, type, transactionId],
  )
  const evidence = normalizeQuickBooksPosAccountingEvidence(result.rows[0])
  if (!evidence) return null
  return {
    evidence,
    integrity: evidence.entityType === 'SalesReceipt'
      ? compareSalesReceiptInternalArithmetic(evidence)
      : compareJournalEntryBalance(evidence),
  }
}
