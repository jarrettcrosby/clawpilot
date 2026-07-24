#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RESTAURANT_GUID = '11111111-1111-4111-8111-111111111111'

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function loadTypeScriptModule(relativePath, mocks = {}) {
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(mocks, specifier)) return mocks[specifier]
    try {
      return requireFromApp(specifier)
    } catch {
      return nodeRequire(specifier)
    }
  }
  vm.runInNewContext(output, {
    Buffer,
    console,
    Date,
    Error,
    exports: module.exports,
    module,
    process,
    require: localRequire,
  }, { filename: relativePath })
  return module.exports
}

function defaultReceiptLines() {
  return [{
    Id: '1',
    Amount: '10.00',
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: 'item-food', name: 'Food' },
      Qty: '1',
    },
  }, {
    Id: '2',
    Amount: '2.50',
    DetailType: 'GroupLineDetail',
    GroupLineDetail: {
      Line: [{
        Id: '2.1',
        Amount: '2.50',
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: 'item-food', name: 'Food' },
          Qty: '0.5',
        },
      }],
    },
  }, {
    Id: '3',
    Amount: '5.00',
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: 'item-other', name: 'Other sales' },
      Qty: '1',
    },
  }, {
    Id: '4',
    Amount: '17.50',
    DetailType: 'SubTotalLineDetail',
    SubTotalLineDetail: {},
  }]
}

function defaultJournalLines() {
  return [{
    Id: '1', Amount: '13.75', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: 'account-card', name: 'Card clearing' },
    },
  }, {
    Id: '2', Amount: '5.00', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: 'account-cash', name: 'Cash on hand' },
    },
  }, {
    Id: '3', Amount: '10.00', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: 'account-sales', name: 'Sales' },
    },
  }, {
    Id: '4', Amount: '5.00', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: 'account-sales', name: 'Sales' },
    },
  }, {
    Id: '5', Amount: '1.25', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: 'account-tax', name: 'Sales tax payable' },
    },
  }, {
    Id: '6', Amount: '2.50', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Credit',
      AccountRef: { value: 'account-tips', name: 'Tips payable' },
    },
  }]
}

function receiptTransaction({
  id,
  date,
  documentNumber,
  memo = `Toast ${date}`,
  total = '18.75',
  tax = '1.25',
  lines = defaultReceiptLines(),
}) {
  return {
    entity_type: 'SalesReceipt',
    quickbooks_transaction_id: id,
    document_number: documentNumber,
    transaction_date: date,
    currency_code: 'USD',
    total_amount: total,
    memo,
    synced_at: '2026-09-16T12:00:00.000Z',
    source_payload: {
      Id: id,
      DocNumber: documentNumber,
      TxnDate: date,
      PrivateNote: memo,
      CurrencyRef: { value: 'USD' },
      TotalAmt: total,
      TxnTaxDetail: { TotalTax: tax },
      Line: lines,
      rawSourcePayloadSecret: `secret-${id}`,
    },
  }
}

function journalTransaction({
  id,
  date,
  documentNumber,
  memo = `Toast ${date}`,
  lines = defaultJournalLines(),
}) {
  return {
    entity_type: 'JournalEntry',
    quickbooks_transaction_id: id,
    document_number: documentNumber,
    transaction_date: date,
    currency_code: 'USD',
    total_amount: '18.75',
    memo,
    synced_at: '2026-09-16T12:00:00.000Z',
    source_payload: {
      Id: id,
      DocNumber: documentNumber,
      TxnDate: date,
      PrivateNote: memo,
      CurrencyRef: { value: 'USD' },
      Line: lines,
      rawSourcePayloadSecret: `secret-${id}`,
    },
  }
}

function accountingDraft({
  id,
  date,
  receiptDocumentNumber,
  journalDocumentNumber,
  receiptMemo = `Toast ${date}`,
  journalMemo = `Toast ${date}`,
  receiptProviderTransactionId = null,
  journalProviderTransactionId = null,
  standard = { total: '18.75', tax: '1.25' },
  extraProposedLines = [],
}) {
  return {
    id,
    restaurant_guid: RESTAURANT_GUID,
    restaurant_name: 'Historical Restaurant',
    location_name: 'Downtown',
    business_date: date,
    status: 'needs_review',
    reconciliation_status: 'ready',
    draft_revision: 3,
    source_revision: 7,
    updated_at: '2026-09-16T12:00:00.000Z',
    source_summary: {
      standard,
      canonical: {
        parity: {
          documents: {
            salesReceipt: {
              providerTransactionId: receiptProviderTransactionId,
              documentNumber: receiptDocumentNumber,
              memo: receiptMemo,
            },
            journalEntry: {
              providerTransactionId: journalProviderTransactionId,
              documentNumber: journalDocumentNumber,
              memo: journalMemo,
            },
          },
        },
      },
    },
    proposed_lines: [{
      document: 'sales_receipt', amount: '10.00', quantity: '1',
      target: { type: 'item', id: 'item-food', name: 'Food' },
    }, {
      document: 'sales_receipt', amount: '2.50', quantity: '0.5',
      target: { type: 'item', id: 'item-food', name: 'Food' },
    }, {
      document: 'sales_receipt', amount: '5.00', quantity: '1',
      target: { type: 'item', id: 'item-other', name: 'Other sales' },
    }, {
      document: 'payments_journal', side: 'debit', amount: '13.75',
      target: { type: 'account', id: 'account-card', name: 'Card clearing' },
    }, {
      document: 'payments_journal', side: 'debit', amount: '5.00',
      target: { type: 'account', id: 'account-cash', name: 'Cash on hand' },
    }, {
      document: 'payments_journal', side: 'credit', amount: '15.00',
      target: { type: 'account', id: 'account-sales', name: 'Sales' },
    }, {
      document: 'payments_journal', side: 'credit', amount: '1.25',
      target: { type: 'account', id: 'account-tax', name: 'Sales tax payable' },
    }, {
      document: 'payments_journal', side: 'credit', amount: '2.50',
      target: { type: 'account', id: 'account-tips', name: 'Tips payable' },
    }, ...extraProposedLines],
  }
}

const pure = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/persistence/postgres': {
    query: async () => {
      throw new Error('Pure parity helpers must not query Postgres')
    },
  },
})

assert.equal(pure.moneyToCents('1,234.565'), 123457)
assert.equal(pure.moneyToCents('-1.005'), -101)
assert.equal(pure.moneyToCents('not-money'), null)
assert.equal(pure.quantityToMillis('2.3456'), 2346)

const normalizedReceipt = pure.normalizeSalesReceiptEvidence(receiptTransaction({
  id: 'receipt-normalized',
  date: '2025-03-14',
  documentNumber: '250314POS',
}))
assert.equal(normalizedReceipt.totalCents, 1875)
assert.equal(normalizedReceipt.taxCents, 125)
assert.equal(normalizedReceipt.subtotalCents, 1750)
assert.equal(normalizedReceipt.subtotalSource, 'explicit')
assert.equal(normalizedReceipt.lineGroups.length, 2)
assert.equal(normalizedReceipt.lineGroups[0].itemId, 'item-food')
assert.equal(normalizedReceipt.lineGroups[0].amountCents, 1250)
assert.equal(normalizedReceipt.lineGroups[0].quantityMillis, 1500)
assert.equal(normalizedReceipt.unsupportedLineCount, 0)
assert.equal(JSON.stringify(normalizedReceipt).includes('rawSourcePayloadSecret'), false)
assert.equal(pure.compareSalesReceiptInternalArithmetic(normalizedReceipt).status, 'match')

const normalizedJournal = pure.normalizeJournalEntryEvidence(journalTransaction({
  id: 'journal-normalized',
  date: '2025-03-14',
  documentNumber: '250314POS',
}))
assert.equal(normalizedJournal.debitCents, 1875)
assert.equal(normalizedJournal.creditCents, 1875)
assert.equal(normalizedJournal.lineGroups.length, 5)
assert.equal(
  normalizedJournal.lineGroups.find((line) => line.accountId === 'account-sales').amountCents,
  1500,
)
assert.equal(
  normalizedJournal.lineGroups.find((line) => line.accountId === 'account-cash').amountCents,
  500,
)
assert.equal(JSON.stringify(normalizedJournal).includes('rawSourcePayloadSecret'), false)
assert.equal(pure.compareJournalEntryBalance(normalizedJournal).status, 'match')

const journalWithZeroLine = pure.normalizeJournalEntryEvidence(journalTransaction({
  id: 'journal-zero-line',
  date: '2025-03-14',
  documentNumber: '250314POS',
  lines: [...defaultJournalLines(), {
    Id: '7', Amount: '0.00', DetailType: 'JournalEntryLineDetail',
    JournalEntryLineDetail: {
      PostingType: 'Debit',
      AccountRef: { value: 'account-over-short', name: 'Cash Over/Short' },
    },
  }],
}))
assert.equal(journalWithZeroLine.lineGroups.length, 5)
assert.equal(
  journalWithZeroLine.lineGroups.some((line) => line.accountId === 'account-over-short'),
  false,
)
assert.equal(pure.isToastMarkedQuickBooksTransaction(receiptTransaction({
  id: 'toast-marker', date: '2025-03-14', documentNumber: 'TOAST-1',
})), true)
assert.equal(pure.isToastMarkedQuickBooksTransaction(receiptTransaction({
  id: 'toast-marker-leading-space', date: '2025-03-14', documentNumber: 'TOAST-2',
  memo: '  Toast 2025-03-14',
})), true)
assert.equal(pure.isToastMarkedQuickBooksTransaction(receiptTransaction({
  id: 'unrelated', date: '2025-03-14', documentNumber: 'OTHER-1', memo: 'Retail counter',
})), false)
assert.equal(pure.isToastMarkedQuickBooksTransaction(receiptTransaction({
  id: 'pos-suffix', date: '2025-03-14', documentNumber: '250314pos', memo: 'Settlement batch',
})), false)
assert.equal(pure.isToastMarkedQuickBooksTransaction(receiptTransaction({
  id: 'wrong-toast-date', date: '2025-03-14', documentNumber: '250314POS', memo: 'Toast 2025-03-13',
})), false)
assert.equal(pure.classifyPosAccountingQuickBooksTransaction(receiptTransaction({
  id: 'linked-clawpilot-receipt',
  date: '2025-03-14',
  documentNumber: 'UNRELATED-SEQUENCE',
  memo: 'POS 2025-03-14',
}), new Set(['linked-clawpilot-receipt'])), 'clawpilot')
assert.equal(pure.classifyPosAccountingQuickBooksTransaction({
  ...receiptTransaction({
    id: 'trusted-external-receipt',
    date: '2025-03-14',
    documentNumber: 'MIDDLEWARE-42',
    memo: 'External accounting bridge',
  }),
  pos_accounting_origin: 'external',
}), 'external')

const parityDraft = pure.normalizePosAccountingDraftEvidence(accountingDraft({
  id: 'draft-comparison',
  date: '2025-03-14',
  receiptDocumentNumber: '250314POS',
  journalDocumentNumber: '250314POS',
}))
const canonicalTaxDraftInput = accountingDraft({
  id: 'draft-canonical-tax',
  date: '2025-03-14',
  receiptDocumentNumber: '250314POS',
  journalDocumentNumber: '250314POS',
  standard: { total: '17.50', tax: '0.00' },
})
canonicalTaxDraftInput.source_summary.canonical.accounting = {
  salesReceipt: { tax: '1.25', total: '18.75' },
}
const canonicalTaxDraft = pure.normalizePosAccountingDraftEvidence(canonicalTaxDraftInput)
assert.equal(canonicalTaxDraft.documents[0].taxCents, 125)
assert.equal(canonicalTaxDraft.documents[0].totalCents, 1875)
const journalOnlyPaymentExceptionDraft = pure.normalizePosAccountingDraftEvidence({
  id: 'draft-payment-exception-capture',
  restaurant_guid: RESTAURANT_GUID,
  business_date: '2025-03-13',
  status: 'needs_review',
  reconciliation_status: 'orders_only',
  source_summary: { standard: { netSales: '44.54', tax: '0.00' } },
  proposed_lines: [{
    document: 'payments_journal',
    code: 'calculated_net_card_settlement',
    sourceKind: 'card_brand',
    side: 'debit',
    amount: '44.54',
    target: { id: 'account-card', name: 'Card clearing' },
  }, {
    document: 'payments_journal',
    code: 'payment_exception_capture',
    sourceKind: 'payment_exception',
    side: 'credit',
    amount: '44.54',
    target: { id: 'account-payment-exceptions', name: 'Payment Exceptions' },
  }],
})
assert.equal(journalOnlyPaymentExceptionDraft.documents.length, 1)
assert.equal(journalOnlyPaymentExceptionDraft.documents[0].entityType, 'JournalEntry')
assert.equal(journalOnlyPaymentExceptionDraft.documents[0].debitCents, 4454)
assert.equal(journalOnlyPaymentExceptionDraft.documents[0].creditCents, 4454)
const receiptComparison = pure.compareSalesReceiptEvidence(
  parityDraft.documents[0],
  normalizedReceipt,
)
assert.equal(receiptComparison.status, 'match')
assert.equal(receiptComparison.lines.length, 2)

const tipsExcludedDraft = pure.normalizePosAccountingDraftEvidence(accountingDraft({
  id: 'draft-tips-excluded',
  date: '2025-03-14',
  receiptDocumentNumber: '250314POS',
  journalDocumentNumber: '250314POS',
  standard: { total: '21.25', tendered: '18.75', tax: '1.25', tips: '2.50' },
  extraProposedLines: [{
    document: 'payments_journal', side: 'debit', amount: '0.00',
    target: { type: 'account', id: 'account-over-short', name: 'Cash Over/Short' },
  }],
}))
assert.equal(tipsExcludedDraft.documents[0].totalCents, 1875)
assert.equal(tipsExcludedDraft.documents[1].lineGroups.length, 5)
assert.equal(
  pure.compareSalesReceiptEvidence(tipsExcludedDraft.documents[0], normalizedReceipt).status,
  'match',
)
assert.equal(
  pure.compareJournalEntryEvidence(tipsExcludedDraft.documents[1], journalWithZeroLine).status,
  'match',
)

const journalComparison = pure.compareJournalEntryEvidence(
  parityDraft.documents[1],
  normalizedJournal,
)
assert.equal(journalComparison.status, 'match')
assert.equal(journalComparison.lines.length, 5)
assert.equal(journalComparison.lines.every((line) => line.status === 'match'), true)

const changedSettlementLines = defaultJournalLines()
changedSettlementLines[1] = { ...changedSettlementLines[1], Amount: '4.99' }
const changedJournal = pure.normalizeJournalEntryEvidence(journalTransaction({
  id: 'journal-changed',
  date: '2025-03-14',
  documentNumber: '250314POS',
  lines: changedSettlementLines,
}))
const changedComparison = pure.compareJournalEntryEvidence(parityDraft.documents[1], changedJournal)
assert.equal(changedComparison.status, 'variance')
assert.equal(
  changedComparison.lines.find((line) => line.accountId === 'account-cash').deltaAmountCents,
  -1,
)

function expectedReceipt({ id, date, providerId = null, documentNumber = null, memo = null }) {
  return pure.normalizePosAccountingDraftEvidence(accountingDraft({
    id,
    date,
    receiptDocumentNumber: documentNumber,
    journalDocumentNumber: `unused-${id}`,
    receiptMemo: memo,
    receiptProviderTransactionId: providerId,
  })).documents[0]
}

const matchingExpected = [
  expectedReceipt({
    id: 'draft-provider', date: '2025-04-01', providerId: 'actual-provider',
    documentNumber: 'wrong-document', memo: 'wrong memo',
  }),
  expectedReceipt({
    id: 'draft-doc-memo', date: '2025-04-02', documentNumber: 'DOC-MEMO', memo: 'Toast exact',
  }),
  expectedReceipt({
    id: 'draft-document', date: '2025-04-03', documentNumber: 'DOC-ONLY', memo: 'Toast expected',
  }),
  expectedReceipt({
    id: 'draft-memo', date: '2025-04-04', documentNumber: 'EXPECTED-DOC', memo: 'Toast memo only',
  }),
  expectedReceipt({
    id: 'draft-date', date: '2025-04-05', documentNumber: null, memo: null,
  }),
]
const matchingActual = [
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-provider', date: '2025-04-01', documentNumber: 'other-document', memo: 'Toast other',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-doc-memo', date: '2025-04-02', documentNumber: 'doc-memo', memo: '  TOAST   EXACT ',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-document', date: '2025-04-03', documentNumber: 'doc-only', memo: 'Toast changed',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-memo', date: '2025-04-04', documentNumber: 'ACTUAL-DOC', memo: 'toast memo only',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-date', date: '2025-04-05', documentNumber: 'ACTUAL-DATE', memo: 'Toast actual date',
  })),
]
const priorityMatches = pure.matchPosAccountingParityDocuments({
  expected: matchingExpected,
  actual: matchingActual,
}).matches
assert.deepEqual(
  [...priorityMatches].map((match) => match.basis),
  ['provider_id', 'memo', null, 'memo', 'date_only'],
)
assert.equal(priorityMatches[2].status, 'ambiguous')
assert.deepEqual([...priorityMatches[2].candidateTransactionIds], ['actual-document'])

const conflictingFallback = pure.matchPosAccountingParityDocuments({
  expected: [expectedReceipt({
    id: 'draft-conflicting-date',
    date: '2025-04-06',
    documentNumber: 'EXPECTED-DATE',
    memo: 'Toast expected date',
  })],
  actual: [pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'actual-conflicting-date',
    date: '2025-04-06',
    documentNumber: 'ACTUAL-DATE',
    memo: 'Toast actual date',
  }))],
})
assert.equal(conflictingFallback.matches[0].status, 'ambiguous')
assert.equal(conflictingFallback.matches[0].basis, null)
assert.deepEqual([...conflictingFallback.matches[0].candidateTransactionIds], ['actual-conflicting-date'])

const ambiguousExpected = expectedReceipt({
  id: 'draft-ambiguous', date: '2025-05-01', documentNumber: null, memo: null,
})
const crossDateExpected = expectedReceipt({
  id: 'draft-cross-date', date: '2025-05-02', documentNumber: 'SAME-DOC', memo: 'Toast cross date',
})
const ambiguity = pure.matchPosAccountingParityDocuments({
  expected: [ambiguousExpected, crossDateExpected],
  actual: [
    pure.normalizeSalesReceiptEvidence(receiptTransaction({
      id: 'ambiguous-a', date: '2025-05-01', documentNumber: 'A',
    })),
    pure.normalizeSalesReceiptEvidence(receiptTransaction({
      id: 'ambiguous-b', date: '2025-05-01', documentNumber: 'B',
    })),
    pure.normalizeSalesReceiptEvidence(receiptTransaction({
      id: 'cross-date', date: '2025-05-03', documentNumber: 'SAME-DOC', memo: 'Toast cross date',
    })),
  ],
})
assert.equal(ambiguity.matches[0].status, 'ambiguous')
assert.equal(ambiguity.matches[0].candidateTransactionIds.length, 2)
assert.equal(ambiguity.matches[1].status, 'missing_quickbooks')
assert.equal(ambiguity.unmatchedQuickBooks.length, 3)
assert.equal(ambiguity.unmatchedQuickBooks.filter((row) => row.ambiguous).length, 2)

function dateRange(first, last, count) {
  const firstMillis = new Date(`${first}T00:00:00.000Z`).getTime()
  const lastMillis = new Date(`${last}T00:00:00.000Z`).getTime()
  return Array.from({ length: count }, (_, index) => new Date(
    firstMillis + Math.round(((lastMillis - firstMillis) * index) / (count - 1)),
  ).toISOString().slice(0, 10))
}

const historicalDates = dateRange('2025-03-14', '2026-09-15', 81)
const historicalTransactions = []
for (let index = 0; index < 44; index += 1) {
  const date = historicalDates[index]
  const documentNumber = `HIST-${String(index + 1).padStart(3, '0')}POS`
  historicalTransactions.push(receiptTransaction({
    id: `historical-receipt-${index}`,
    date,
    documentNumber,
  }))
  historicalTransactions.push(journalTransaction({
    id: `historical-journal-${index}`,
    date,
    documentNumber,
  }))
}
for (let index = 44; index < historicalDates.length; index += 1) {
  const unmatchedIndex = index - 44
  const documentMarked = unmatchedIndex < 32
  const memoMarked = unmatchedIndex < 4 || unmatchedIndex >= 32
  const input = {
    id: `historical-unmatched-${index}`,
    date: historicalDates[index],
    documentNumber: `UNMATCHED-${String(index + 1).padStart(3, '0')}${documentMarked ? 'POS' : ''}`,
    memo: memoMarked ? `Toast ${historicalDates[index]}` : 'Historical settlement batch',
  }
  historicalTransactions.push(index % 2 === 0
    ? receiptTransaction(input)
    : journalTransaction(input))
}

assert.equal(historicalTransactions.length, 125)
const pairGroups = new Map()
for (const transaction of historicalTransactions) {
  const key = `${transaction.transaction_date}:${transaction.document_number}`
  pairGroups.set(key, (pairGroups.get(key) || 0) + 1)
}
assert.equal([...pairGroups.values()].filter((count) => count === 2).length, 44)
assert.equal([...pairGroups.values()].filter((count) => count === 1).length, 37)
assert.equal(historicalTransactions.filter((row) => /toast/i.test(row.memo)).length, 97)
assert.equal(historicalTransactions.filter((row) => /pos$/i.test(row.document_number)).length, 120)
assert.equal(historicalTransactions.filter(
  (row) => /toast/i.test(row.memo) || /pos$/i.test(row.document_number),
).length, 125)
assert.equal(historicalTransactions.filter(
  (row) => !/toast/i.test(row.memo) && /pos$/i.test(row.document_number),
).length, 28)
assert.equal(historicalTransactions.filter(
  (row) => /toast/i.test(row.memo) && !/pos$/i.test(row.document_number),
).length, 5)

const unrelatedTransaction = receiptTransaction({
  id: 'unrelated-quickbooks-receipt',
  date: '2026-01-01',
  documentNumber: 'RETAIL-1',
  memo: 'Unrelated retail receipt',
})
const historicalReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: [...historicalTransactions, unrelatedTransaction],
})
assert.equal(historicalReport.summary.cachedTransactions, 97)
assert.equal(historicalReport.summary.unmatchedQuickBooks, 97)
assert.equal(historicalReport.discardedEvidence.nonToastQuickBooksTransactions, 29)
assert.equal(historicalReport.dates.at(-1), '2025-03-14')
assert.equal(historicalReport.dates[0], '2026-09-15')
assert.equal(historicalReport.dates.length, 53)
assert.equal(historicalReport.historicalBaseline.summary.pairCount, 44)
assert.equal(historicalReport.historicalBaseline.summary.exactMarkerPairs, 44)
assert.equal(historicalReport.historicalBaseline.summary.dateFallbackPairs, 0)
assert.equal(historicalReport.historicalBaseline.summary.unmatchedGroups, 9)
assert.equal(historicalReport.historicalBaseline.summary.unmatchedEvidence, 9)
assert.equal(historicalReport.historicalBaseline.summary.ambiguousGroups, 0)
assert.equal(historicalReport.historicalBaseline.summary.receiptArithmetic.match, 49)
assert.equal(historicalReport.historicalBaseline.summary.journalBalance.match, 48)
assert.equal(JSON.stringify(historicalReport).includes('rawSourcePayloadSecret'), false)
assert.equal(JSON.stringify(historicalReport).includes('secret-historical'), false)

const conflictingHistoricalFallback = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'history-conflict-receipt',
    date: '2025-02-01',
    documentNumber: 'RECEIPT-POS',
    memo: 'Toast receipt',
  })),
  pure.normalizeJournalEntryEvidence(journalTransaction({
    id: 'history-conflict-journal',
    date: '2025-02-01',
    documentNumber: 'JOURNAL-POS',
    memo: 'Toast journal',
  })),
])
assert.equal(conflictingHistoricalFallback.summary.pairCount, 0)
assert.equal(conflictingHistoricalFallback.summary.ambiguousGroups, 1)
assert.equal(conflictingHistoricalFallback.summary.ambiguousEvidence, 2)

const qualifyingHistoricalTransactions = historicalTransactions.filter(
  pure.isToastMarkedQuickBooksTransaction,
)
const descendingHistoricalDates = [...new Set(qualifyingHistoricalTransactions
  .map((transaction) => transaction.transaction_date))].sort().reverse()
const secondPageDates = descendingHistoricalDates.slice(10, 20)
const secondPageDateSet = new Set(secondPageDates)
const secondPageTransactions = qualifyingHistoricalTransactions.filter(
  (transaction) => secondPageDateSet.has(transaction.transaction_date),
)
const independentlyScopedReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: secondPageTransactions,
  fullHistoryTransactions: [...historicalTransactions, unrelatedTransaction],
})
assert.equal(independentlyScopedReport.summary.cachedTransactions, secondPageTransactions.length)
assert.equal(independentlyScopedReport.dates.length, secondPageDates.length)
assert.equal(independentlyScopedReport.historicalBaseline.summary.cachedTransactions, 97)
assert.equal(independentlyScopedReport.historicalBaseline.summary.exactMarkerPairs, 44)
assert.equal(independentlyScopedReport.historicalBaseline.summary.unmatchedGroups, 9)
assert.equal(JSON.stringify(independentlyScopedReport).includes('rawSourcePayloadSecret'), false)

const fallbackAndAmbiguousBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'fallback-receipt', date: '2026-01-10', documentNumber: null,
  })),
  pure.normalizeJournalEntryEvidence(journalTransaction({
    id: 'fallback-journal', date: '2026-01-10', documentNumber: 'JOURNAL-POS',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'ambiguous-receipt-a', date: '2026-01-11', documentNumber: 'A-POS',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'ambiguous-receipt-b', date: '2026-01-11', documentNumber: 'B-POS',
  })),
  pure.normalizeJournalEntryEvidence(journalTransaction({
    id: 'ambiguous-journal', date: '2026-01-11', documentNumber: 'C-POS',
  })),
])
assert.equal(fallbackAndAmbiguousBaseline.summary.pairCount, 1)
assert.equal(fallbackAndAmbiguousBaseline.summary.exactMarkerPairs, 1)
assert.equal(fallbackAndAmbiguousBaseline.summary.dateFallbackPairs, 0)
assert.equal(fallbackAndAmbiguousBaseline.summary.ambiguousGroups, 1)
assert.equal(fallbackAndAmbiguousBaseline.summary.ambiguousEvidence, 3)
assert.equal(fallbackAndAmbiguousBaseline.summary.unmatchedEvidence, 0)

const sqlCalls = []
async function queryMock(source, parameters = []) {
  sqlCalls.push({ source, parameters })
  if (source.includes('count(*)::text AS total_dates FROM evidence_dates')) {
    return { rows: [{ total_dates: String(descendingHistoricalDates.length) }] }
  }
  if (source.includes('SELECT evidence_date::text AS business_date')) {
    const limit = Number(parameters[3])
    const offset = Number(parameters[4])
    return {
      rows: descendingHistoricalDates
        .slice(offset, offset + limit)
        .map((business_date) => ({ business_date })),
    }
  }
  if (source.includes('EXISTS (') && source.includes('sales_receipt_count')) {
    return { rows: [{
      configured: true,
      connection_status: 'active',
      last_catalog_synced_at: '2026-09-16T12:00:00.000Z',
      sync_status: 'succeeded',
      sync_completed_at: '2026-09-16T12:00:00.000Z',
      sales_receipt_count: '49',
      journal_entry_count: '48',
    }] }
  }
  if (source.includes('LEFT JOIN toast_locations location')) return { rows: [] }
  if (source.includes('SELECT transaction.entity_type')) return { rows: historicalTransactions }
  throw new Error(`Unexpected parity query: ${source}`)
}

const reader = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/persistence/postgres': { query: queryMock },
})
const postgresReport = await reader.readPosAccountingParityReportInPostgres({
  organizationId: ORGANIZATION_ID,
  fromBusinessDate: '2025-03-14',
  toBusinessDate: '2026-09-15',
  page: 2,
  pageSize: 10,
  historyPage: 2,
  historyPageSize: 10,
})
assert.equal(postgresReport.summary.cachedTransactions, secondPageTransactions.length)
assert.equal(postgresReport.pagination.totalDates, 53)
assert.equal(postgresReport.pagination.totalPages, 6)
assert.equal(postgresReport.pagination.dates.length, 10)
assert.equal(postgresReport.pagination.dates[0], secondPageDates[0])
assert.equal(postgresReport.pagination.dates.at(-1), secondPageDates.at(-1))
assert.equal(postgresReport.cache.salesReceiptCount, 49)
assert.equal(postgresReport.cache.journalEntryCount, 48)
assert.equal(postgresReport.unmatchedQuickBooks.length, secondPageTransactions.length)
assert.equal(postgresReport.historicalBaseline.summary.cachedTransactions, 97)
assert.equal(postgresReport.historicalBaseline.summary.exactMarkerPairs, 44)
assert.equal(postgresReport.historicalBaseline.summary.unmatchedGroups, 9)
assert.equal(postgresReport.historicalBaseline.pairs.length, 10)
assert.equal(postgresReport.historicalBaseline.unmatchedGroups.length, 0)
assert.equal(postgresReport.historicalPagination.page, 2)
assert.equal(postgresReport.historicalPagination.pageSize, 10)
assert.equal(postgresReport.historicalPagination.totalPages, 5)
assert.equal(postgresReport.historicalPagination.pairPages, 5)
assert.equal(postgresReport.historicalPagination.unmatchedPages, 1)
assert.equal(JSON.stringify(postgresReport).includes('source_payload'), false)
assert.equal(JSON.stringify(postgresReport).includes('rawSourcePayloadSecret'), false)

assert.equal(sqlCalls.length, 5)
for (const call of sqlCalls) {
  assert.match(call.source.trim(), /^(SELECT|WITH)\b/)
  assert.doesNotMatch(call.source, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i)
  assert.equal(call.parameters[0], ORGANIZATION_ID)
}
assert.equal(sqlCalls.some((call) => call.source.includes("from '^[[:space:]]*toast[[:space:]]+([0-9]{4}-[0-9]{2}-[0-9]{2})'")), true)
assert.equal(sqlCalls.some((call) => call.source.includes("source_payload #>> '{CustomerMemo,value}'")), true)
assert.equal(sqlCalls.some((call) => call.source.includes('toast_accounting_export_drafts linked_draft')), true)
assert.equal(sqlCalls.some((call) => call.source.includes("linked_draft.posting_origin IN ('shogo', 'external', 'clawpilot')")), true)
assert.equal(sqlCalls.some((call) => /document_number[\s\S]*pos\$/i.test(call.source)), false)
assert.equal(sqlCalls.some((call) => call.source.includes('draft.is_current = true')), true)
assert.equal(sqlCalls.some((call) => call.source.includes("IN ('SalesReceipt', 'JournalEntry')")), true)
const fullHistoryQuery = sqlCalls.find((call) =>
  call.source.includes('SELECT transaction.entity_type')
    && call.source.includes('transaction.transaction_date IS NOT NULL'))
assert.ok(fullHistoryQuery)
assert.deepEqual([...fullHistoryQuery.parameters], [
  ORGANIZATION_ID,
  '2025-03-14',
  '2026-09-15',
])
assert.doesNotMatch(fullHistoryQuery.source, /ANY\(\$2::date\[\]\)/)
assert.doesNotMatch(fullHistoryQuery.source, /\bLIMIT\b/)

const detailCalls = []
const detailReader = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/persistence/postgres': {
    query: async (source, parameters = []) => {
      detailCalls.push({ source, parameters })
      return { rows: [{
        ...receiptTransaction({
          id: '1534',
          date: '2026-07-18',
          documentNumber: '260718POS',
        }),
        party_name: 'Toast clearing customer',
        account_name: 'Clearing account',
        pos_accounting_origin: 'shogo',
      }] }
    },
  },
})
const detail = await detailReader.readPosAccountingParityEvidenceDetailInPostgres({
  organizationId: ORGANIZATION_ID,
  entityType: 'SalesReceipt',
  providerTransactionId: '1534',
})
assert.equal(detail.evidence.providerTransactionId, '1534')
assert.equal(detail.evidence.postingOrigin, 'shogo')
assert.equal(detail.evidence.partyName, 'Toast clearing customer')
assert.equal(detail.integrity.status, 'match')
assert.equal(JSON.stringify(detail).includes('rawSourcePayloadSecret'), false)
assert.equal(detailCalls.length, 1)
assert.deepEqual([...detailCalls[0].parameters], [ORGANIZATION_ID, 'SalesReceipt', '1534'])
assert.match(detailCalls[0].source, /toast_accounting_export_drafts linked_draft/)
assert.doesNotMatch(detailCalls[0].source, /document_number[\s\S]*pos\$/i)

await assert.rejects(
  () => reader.readPosAccountingParityReportInPostgres({ organizationId: 'not-an-organization' }),
  /valid organizationId/,
)
await assert.rejects(
  () => reader.readPosAccountingParityReportInPostgres({
    organizationId: ORGANIZATION_ID,
    fromBusinessDate: '2026-09-16',
    toBusinessDate: '2025-03-14',
  }),
  /on or before/,
)

const accountingRoute = read('app_src/app/api/accounting/quickbooks/route.ts')
assert.match(accountingRoute, /viewValue === 'pos-parity'/)
assert.match(accountingRoute, /readPosAccountingParityReportInPostgres/)
assert.match(accountingRoute, /viewValue === 'pos-parity-evidence'/)
assert.match(accountingRoute, /readPosAccountingParityEvidenceDetailInPostgres/)
assert.match(accountingRoute, /activeAccountingOrganizationId\(actor\)/)
assert.match(accountingRoute, /ACCOUNTING_PARITY_DATE_INVALID/)
assert.match(accountingRoute, /ACCOUNTING_PARITY_TRANSACTION_ID_INVALID/)
assert.match(accountingRoute, /ACCOUNTING_PARITY_TRANSACTION_TYPE_INVALID/)
assert.doesNotMatch(accountingRoute, /viewValue === 'pos-parity'[\s\S]*?(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)/i)

const accountingSection = read('app_src/components/accounting/AccountingSection.tsx')
const parityPanel = read('app_src/components/accounting/PosAccountingParityPanel.tsx')
assert.match(accountingSection, /id: 'pos-parity', label: 'POS posting parity'/)
assert.match(accountingSection, /<PosAccountingParityPanel \/>/)
assert.match(parityPanel, /Toast posting history/)
assert.match(parityPanel, /Current ClawPilot drafts/)
assert.match(parityPanel, /Posting history detail page/)
assert.match(parityPanel, /historyPageSize: '20'/)
assert.match(parityPanel, /view: 'pos-parity'/)
assert.match(parityPanel, /view: 'pos-parity-evidence'/)
assert.match(parityPanel, /document numbers are shown for reference and never establish posting origin/)
assert.match(parityPanel, /their totals are not compared to each other/)
assert.match(parityPanel, /Acknowledge external posting/)
assert.match(parityPanel, /record-external-draft/)
assert.match(parityPanel, /record-external-range/)
assert.match(parityPanel, /ClawPilot will not create, approve, or resend a QuickBooks transaction/)

console.log('PASS POS accounting parity normalization, matching, comparison, historical corpus, and read-only Postgres contracts')
