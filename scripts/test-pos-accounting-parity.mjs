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

function paymentExceptionsJournalTransaction({
  id,
  date,
  documentNumber,
  amount,
  side,
  accountId = 'account-payment-exceptions',
  accountName = 'Payment Exceptions',
  memo = `Toast ${date}`,
}) {
  const offsetSide = side === 'credit' ? 'Debit' : 'Credit'
  const paymentExceptionsSide = side === 'credit' ? 'Credit' : 'Debit'
  return journalTransaction({
    id,
    date,
    documentNumber,
    memo,
    lines: [{
      Id: '1', Amount: amount, DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: paymentExceptionsSide,
        AccountRef: { value: accountId, name: accountName },
      },
    }, {
      Id: '2', Amount: amount, DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: offsetSide,
        AccountRef: { value: 'account-settlement-offset', name: 'Settlement offset' },
      },
    }],
  })
}

function singleItemReceiptLines(amount) {
  return [{
    Id: '1', Amount: amount, DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: 'item-pos-sales', name: 'POS sales' },
      Qty: '1',
    },
  }, {
    Id: '2', Amount: amount, DetailType: 'SubTotalLineDetail',
    SubTotalLineDetail: {},
  }]
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

const clearingReconciliation = loadTypeScriptModule(
  'app_src/lib/accounting/posClearingReconciliation.ts',
)
const pure = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/accounting/posClearingReconciliation': clearingReconciliation,
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
assert.equal(tipsExcludedDraft.documents[0].draft.sourceTipsCents, 250)
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

const scheduledDraftInput = accountingDraft({
  id: 'draft-scheduled',
  date: '2026-09-20',
  receiptDocumentNumber: '260920POS',
  journalDocumentNumber: '260920POS',
})
scheduledDraftInput.scheduled_for_future = true
const scheduledReport = pure.buildPosAccountingParityReport({
  drafts: [scheduledDraftInput],
  transactions: [],
  evidenceLastSyncedAt: '2026-09-17T12:00:00.000Z',
})
assert.equal(scheduledReport.summary.scheduled, 2)
assert.equal(scheduledReport.summary.missingQuickBooks, 0)
assert.equal(scheduledReport.rows.every((row) => row.match.status === 'scheduled'), true)

const captureLifecycleDraft = accountingDraft({
  id: 'draft-preorder-capture',
  date: '2026-07-23',
  receiptDocumentNumber: '260723POS',
  journalDocumentNumber: '260723POS',
  standard: { total: '44.54', tendered: '44.54', tax: '3.04', tips: '0.00' },
})
captureLifecycleDraft.source_summary.canonical.paymentExceptions = {
  affectedChecks: 2,
  captureChecks: 2,
  releaseChecks: 0,
  captureAmount: 44.54,
  releaseAmount: 0,
  links: [{
    kind: 'capture',
    orderKey: 'order-1',
    checkKey: 'check-1',
    paymentKey: 'payment-1',
    paymentBusinessDate: '2026-07-23',
    fulfillmentBusinessDate: '2026-07-25',
    amount: 44.54,
    tip: 0,
    total: 44.54,
  }],
}
const releaseLifecycleDraft = accountingDraft({
  id: 'draft-preorder-release',
  date: '2026-07-25',
  receiptDocumentNumber: '260725POS',
  journalDocumentNumber: '260725POS',
  standard: { total: '44.54', tendered: '44.54', tax: '3.04', tips: '0.00' },
})
releaseLifecycleDraft.source_summary.canonical.paymentExceptions = {
  affectedChecks: 2,
  captureChecks: 0,
  releaseChecks: 2,
  captureAmount: 0,
  releaseAmount: 44.54,
  links: [{
    kind: 'release',
    orderKey: 'order-1',
    checkKey: 'check-1',
    paymentKey: 'payment-1',
    paymentBusinessDate: '2026-07-23',
    fulfillmentBusinessDate: '2026-07-25',
    amount: 44.54,
    tip: 0,
    total: 44.54,
  }],
}
const lifecycleReport = pure.buildPosAccountingParityReport({
  drafts: [captureLifecycleDraft, releaseLifecycleDraft],
  transactions: [],
  evidenceLastSyncedAt: '2026-07-24T12:00:00.000Z',
})
assert.equal(lifecycleReport.preorderLifecycles.length, 1)
assert.equal(lifecycleReport.preorderLifecycles[0].status, 'linked')
assert.equal(lifecycleReport.preorderLifecycles[0].paymentBusinessDate, '2026-07-23')
assert.equal(lifecycleReport.preorderLifecycles[0].fulfillmentBusinessDate, '2026-07-25')
assert.equal(lifecycleReport.preorderLifecycles[0].totalCents, 4454)
assert.equal(lifecycleReport.preorderLifecycles[0].tipCents, 0)
assert.equal(lifecycleReport.preorderLifecycles[0].captureDraftId, 'draft-preorder-capture')
assert.equal(lifecycleReport.preorderLifecycles[0].releaseDraftId, 'draft-preorder-release')
assert.equal(lifecycleReport.evidenceLastSyncedAt, '2026-07-24T12:00:00.000Z')
assert.equal(lifecycleReport.evidenceFreshness.draftsNewerThanEvidence, 2)
assert.equal(lifecycleReport.evidenceFreshness.evidenceMayBeStale, true)
const freshLifecycleReport = pure.buildPosAccountingParityReport({
  drafts: [captureLifecycleDraft, releaseLifecycleDraft],
  transactions: [],
  evidenceLastSyncedAt: '2026-09-17T12:00:00.000Z',
})
assert.equal(freshLifecycleReport.evidenceFreshness.draftsNewerThanEvidence, 0)
assert.equal(freshLifecycleReport.evidenceFreshness.evidenceMayBeStale, false)

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
assert.equal(fallbackAndAmbiguousBaseline.summary.postingBundleCount, 1)
assert.equal(fallbackAndAmbiguousBaseline.postingBundles[0].salesReceipts.length, 2)
assert.equal(fallbackAndAmbiguousBaseline.postingBundles[0].journalEntries.length, 1)
assert.equal(fallbackAndAmbiguousBaseline.postingBundles[0].receiptTotalCents, 3750)
assert.equal(fallbackAndAmbiguousBaseline.summary.ambiguousGroups, 0)
assert.equal(fallbackAndAmbiguousBaseline.summary.ambiguousEvidence, 0)
assert.equal(fallbackAndAmbiguousBaseline.summary.unmatchedEvidence, 0)

const journalOnlyCaptureBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(journalTransaction({
    id: 'payment-exception-only',
    date: '2026-07-23',
    documentNumber: '260723POS',
    lines: [{
      Id: '1', Amount: '42.59', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: 'account-bank', name: 'Bank deposit' },
      },
    }, {
      Id: '2', Amount: '1.95', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: 'account-fees', name: 'Processing fees' },
      },
    }, {
      Id: '3', Amount: '44.54', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: 'account-payment-exceptions', name: 'Payment Exceptions' },
      },
    }],
  })),
])
assert.equal(journalOnlyCaptureBaseline.summary.journalOnlyCaptureCount, 1)
assert.equal(journalOnlyCaptureBaseline.summary.unmatchedEvidence, 0)
assert.equal(journalOnlyCaptureBaseline.journalOnlyCaptures[0].journalBalance.status, 'match')

const julyCrossDayClearingBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: '260723-payment-exceptions-capture',
    date: '2026-07-23',
    documentNumber: '260723POS',
    amount: '44.54',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: '260724-payment-exceptions-capture',
    date: '2026-07-24',
    documentNumber: '260724POS',
    amount: '95.26',
    side: 'credit',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: '260725-sales-receipt',
    date: '2026-07-25',
    documentNumber: '260725POS',
    total: '139.80',
    tax: '0.00',
    lines: singleItemReceiptLines('139.80'),
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: '260725-payment-exceptions-release',
    date: '2026-07-25',
    documentNumber: '260725POS',
    amount: '139.80',
    side: 'debit',
  })),
], {
  organizationId: ORGANIZATION_ID,
  quickBooksCompanyId: 'qbo-company-test',
  paymentExceptionAccounts: [{
    accountId: 'account-payment-exceptions',
    accountName: 'Payment Exceptions',
  }],
  asOfBusinessDate: '2026-07-25',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-07-23',
    toBusinessDate: '2026-07-25',
  }],
})
assert.equal(julyCrossDayClearingBaseline.summary.clearingLifecycleCount, 1)
assert.equal(julyCrossDayClearingBaseline.summary.clearingStatusCounts.settled, 1)
assert.equal(julyCrossDayClearingBaseline.summary.journalOnlyCaptureCount, 2)
assert.equal(julyCrossDayClearingBaseline.summary.unmatchedGroups, 0)
assert.equal(julyCrossDayClearingBaseline.summary.unmatchedEvidence, 0)
assert.equal(julyCrossDayClearingBaseline.summary.ambiguousEvidence, 0)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].evidenceCoverage, 'cached_only')
assert.deepEqual(
  [...julyCrossDayClearingBaseline.clearingLifecycles[0].captureBusinessDates],
  ['2026-07-23', '2026-07-24'],
)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].capturedCents, 13980)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].releasedCents, 13980)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].appliedCents, 13980)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].outstandingCents, 0)
assert.equal(julyCrossDayClearingBaseline.clearingLifecycles[0].salesReceipts.length, 1)

const julyDateFilteredTransactions = [
  paymentExceptionsJournalTransaction({
    id: '260724-date-filtered-capture',
    date: '2026-07-24',
    documentNumber: '260724POS',
    amount: '95.26',
    side: 'credit',
  }),
  receiptTransaction({
    id: '260725-date-filtered-sales-receipt',
    date: '2026-07-25',
    documentNumber: '260725POS',
    total: '139.80',
    tax: '0.00',
    lines: singleItemReceiptLines('139.80'),
  }),
  paymentExceptionsJournalTransaction({
    id: '260725-date-filtered-release',
    date: '2026-07-25',
    documentNumber: '260725POS',
    amount: '139.80',
    side: 'debit',
  }),
]
const julyDateFilteredReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: julyDateFilteredTransactions,
  fullHistoryTransactions: julyDateFilteredTransactions,
  clearingOpeningBalanceTransactions: [
    paymentExceptionsJournalTransaction({
      id: '260723-date-filtered-opening-capture',
      date: '2026-07-23',
      documentNumber: '260723POS',
      amount: '44.54',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: '260723-date-filtered-wrong-account',
      date: '2026-07-23',
      documentNumber: '260723OTHER',
      amount: '999.99',
      side: 'credit',
      accountId: 'account-not-payment-exceptions',
      accountName: 'Other clearing',
    }),
  ],
  historicalBaselineOptions: {
    organizationId: ORGANIZATION_ID,
    quickBooksCompanyId: 'qbo-company-test',
    paymentExceptionAccounts: [{
      accountId: 'account-payment-exceptions',
      accountName: 'Payment Exceptions',
    }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-25',
    evidenceCoverageRanges: [{
      fromBusinessDate: '2026-07-23',
      toBusinessDate: '2026-07-25',
    }],
  },
})
assert.equal(julyDateFilteredReport.historicalBaseline.summary.clearingLifecycleCount, 1)
assert.equal(julyDateFilteredReport.historicalBaseline.summary.clearingStatusCounts.settled, 0)
assert.equal(julyDateFilteredReport.historicalBaseline.summary.clearingStatusCounts.ambiguous, 1)
assert.equal(julyDateFilteredReport.historicalBaseline.summary.unmatchedGroups, 0)
assert.equal(julyDateFilteredReport.historicalBaseline.summary.unmatchedEvidence, 0)
assert.equal(julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].status, 'ambiguous')
assert.equal(
  julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].evidenceCoverage,
  'cached_only',
)
assert.deepEqual(
  [...julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].captureBusinessDates],
  ['2026-07-23', '2026-07-24'],
)
assert.equal(julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].capturedCents, 13980)
assert.equal(julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].releasedCents, 13980)
assert.equal(julyDateFilteredReport.historicalBaseline.clearingLifecycles[0].outstandingCents, 0)

const openingBalanceVisibilityReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: [],
  fullHistoryTransactions: [],
  clearingOpeningBalanceTransactions: [
    paymentExceptionsJournalTransaction({
      id: 'pre-range-settled-capture',
      date: '2026-07-20',
      documentNumber: '260720POS',
      amount: '12.34',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'pre-range-settled-release',
      date: '2026-07-21',
      documentNumber: '260721POS',
      amount: '12.34',
      side: 'debit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'pre-range-unresolved-capture',
      date: '2026-07-22',
      documentNumber: '260722POS',
      amount: '8.76',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'pre-range-orphan-release',
      date: '2026-07-19',
      documentNumber: '260719POS',
      amount: '7.65',
      side: 'debit',
    }),
  ],
  historicalBaselineOptions: {
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-25',
    providerHistoryBoundaryProven: true,
  },
})
assert.equal(openingBalanceVisibilityReport.historicalBaseline.summary.cachedTransactions, 0)
assert.equal(openingBalanceVisibilityReport.historicalBaseline.summary.clearingLifecycleCount, 1)
assert.equal(openingBalanceVisibilityReport.historicalBaseline.clearingLifecycles[0].status, 'pending')
assert.equal(openingBalanceVisibilityReport.historicalBaseline.clearingLifecycles[0].capturedCents, 876)
assert.equal(openingBalanceVisibilityReport.historicalBaseline.summary.unmatchedEvidence, 0)
assert.equal(
  JSON.stringify(openingBalanceVisibilityReport.historicalBaseline)
    .includes('pre-range-orphan-release'),
  false,
)

const partiallyReleasedOpeningBalanceReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: [paymentExceptionsJournalTransaction({
    id: 'in-range-final-release',
    date: '2026-07-24',
    documentNumber: '260724POS',
    amount: '60.00',
    side: 'debit',
  })],
  fullHistoryTransactions: [paymentExceptionsJournalTransaction({
    id: 'in-range-final-release',
    date: '2026-07-24',
    documentNumber: '260724POS',
    amount: '60.00',
    side: 'debit',
  })],
  clearingOpeningBalanceTransactions: [
    paymentExceptionsJournalTransaction({
      id: 'pre-range-partial-capture',
      date: '2026-07-20',
      documentNumber: '260720POS',
      amount: '100.00',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'pre-range-partial-release',
      date: '2026-07-21',
      documentNumber: '260721POS',
      amount: '40.00',
      side: 'debit',
    }),
  ],
  historicalBaselineOptions: {
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-24',
    providerHistoryBoundaryProven: true,
  },
})
assert.equal(partiallyReleasedOpeningBalanceReport.historicalBaseline.clearingLifecycles.length, 1)
assert.equal(partiallyReleasedOpeningBalanceReport.historicalBaseline.clearingLifecycles[0].status, 'settled')
assert.deepEqual(
  [...partiallyReleasedOpeningBalanceReport.historicalBaseline.clearingLifecycles[0]
    .releaseBusinessDates],
  ['2026-07-21', '2026-07-24'],
)
assert.equal(
  partiallyReleasedOpeningBalanceReport.historicalBaseline.clearingLifecycles[0].releasedCents,
  10000,
)

const incompleteOpeningBalanceReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: julyDateFilteredTransactions,
  fullHistoryTransactions: julyDateFilteredTransactions,
  clearingOpeningBalanceTransactions: [paymentExceptionsJournalTransaction({
    id: 'incomplete-opening-capture',
    date: '2026-07-23',
    documentNumber: '260723POS',
    amount: '44.54',
    side: 'credit',
  })],
  historicalBaselineOptions: {
    organizationId: ORGANIZATION_ID,
    quickBooksCompanyId: 'qbo-company-test',
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-25',
    openingBalanceQueryTruncated: true,
  },
})
assert.equal(incompleteOpeningBalanceReport.historicalBaseline.clearingLifecycles.length, 1)
assert.equal(incompleteOpeningBalanceReport.historicalBaseline.clearingLifecycles[0].status, 'ambiguous')
assert.match(
  incompleteOpeningBalanceReport.historicalBaseline.clearingLifecycles[0].reviewReason,
  /bounded opening-balance query/,
)

const incompleteOpeningSelectedOnlyReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: [
    paymentExceptionsJournalTransaction({
      id: 'incomplete-selected-only-capture',
      date: '2026-07-24',
      documentNumber: '260724POS',
      amount: '44.54',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'incomplete-selected-only-release',
      date: '2026-07-25',
      documentNumber: '260725POS',
      amount: '44.54',
      side: 'debit',
    }),
  ],
  fullHistoryTransactions: [
    paymentExceptionsJournalTransaction({
      id: 'incomplete-selected-only-capture',
      date: '2026-07-24',
      documentNumber: '260724POS',
      amount: '44.54',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'incomplete-selected-only-release',
      date: '2026-07-25',
      documentNumber: '260725POS',
      amount: '44.54',
      side: 'debit',
    }),
  ],
  clearingOpeningBalanceTransactions: [],
  historicalBaselineOptions: {
    organizationId: ORGANIZATION_ID,
    quickBooksCompanyId: 'qbo-company-test',
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-25',
    openingBalanceQueryTruncated: true,
  },
})
assert.equal(incompleteOpeningSelectedOnlyReport.historicalBaseline.clearingLifecycles.length, 1)
assert.equal(
  incompleteOpeningSelectedOnlyReport.historicalBaseline.clearingLifecycles[0].status,
  'ambiguous',
)
assert.match(
  incompleteOpeningSelectedOnlyReport.historicalBaseline.clearingLifecycles[0].reviewReason,
  /account offset cannot be treated as conclusive/,
)

const truncatedOpeningRetentionReport = pure.buildPosAccountingParityReport({
  drafts: [],
  transactions: [],
  fullHistoryTransactions: [],
  clearingOpeningBalanceTransactions: [
    paymentExceptionsJournalTransaction({
      id: 'truncated-opening-apparent-capture',
      date: '2026-07-20',
      documentNumber: '260720POS',
      amount: '10.00',
      side: 'credit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'truncated-opening-apparent-release',
      date: '2026-07-21',
      documentNumber: '260721POS',
      amount: '10.00',
      side: 'debit',
    }),
    paymentExceptionsJournalTransaction({
      id: 'truncated-opening-orphan-release',
      date: '2026-07-22',
      documentNumber: '260722POS',
      amount: '5.00',
      side: 'debit',
    }),
  ],
  historicalBaselineOptions: {
    organizationId: ORGANIZATION_ID,
    quickBooksCompanyId: 'qbo-company-test',
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    fromBusinessDate: '2026-07-24',
    asOfBusinessDate: '2026-07-25',
    openingBalanceQueryTruncated: true,
  },
})
assert.equal(truncatedOpeningRetentionReport.historicalBaseline.clearingLifecycles.length, 2)
assert.equal(
  truncatedOpeningRetentionReport.historicalBaseline.clearingLifecycles.every(
    (lifecycle) => lifecycle.status === 'ambiguous',
  ),
  true,
)
assert.equal(
  JSON.stringify(truncatedOpeningRetentionReport.historicalBaseline)
    .includes('truncated-opening-orphan-release'),
  true,
)

const splitReleaseClearingBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-capture',
    date: '2026-08-01',
    documentNumber: '260801POS',
    amount: '100.00',
    side: 'credit',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'split-release-receipt-first',
    date: '2026-08-02',
    documentNumber: '260802POS',
    total: '40.00',
    tax: '0.00',
    lines: singleItemReceiptLines('40.00'),
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-journal-first',
    date: '2026-08-02',
    documentNumber: '260802POS',
    amount: '40.00',
    side: 'debit',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'split-release-receipt-final',
    date: '2026-08-03',
    documentNumber: '260803POS',
    total: '60.00',
    tax: '0.00',
    lines: singleItemReceiptLines('60.00'),
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-journal-final',
    date: '2026-08-03',
    documentNumber: '260803POS',
    amount: '60.00',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-03',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-01',
    toBusinessDate: '2026-08-03',
  }],
})
assert.equal(splitReleaseClearingBaseline.clearingLifecycles.length, 1)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].capturedCents, 10_000)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].releasedCents, 10_000)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].appliedCents, 10_000)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].outstandingCents, 0)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].releaseJournals.length, 2)
assert.equal(splitReleaseClearingBaseline.clearingLifecycles[0].salesReceipts.length, 2)
assert.equal(splitReleaseClearingBaseline.summary.unmatchedEvidence, 0)
assert.deepEqual(
  [...splitReleaseClearingBaseline.clearingLifecycles[0].releaseBusinessDates],
  ['2026-08-02', '2026-08-03'],
)

const dateOnlyReceiptDoesNotBackRelease = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'date-only-capture',
    date: '2026-08-04',
    documentNumber: '260804POS',
    amount: '50.00',
    side: 'credit',
  })),
  pure.normalizeSalesReceiptEvidence({
    ...receiptTransaction({
      id: 'date-only-unrelated-receipt',
      date: '2026-08-05',
      documentNumber: '260805POS',
      memo: '',
      total: '50.00',
      tax: '0.00',
      lines: singleItemReceiptLines('50.00'),
    }),
    pos_accounting_origin: 'shogo',
  }),
  pure.normalizeJournalEntryEvidence({
    ...paymentExceptionsJournalTransaction({
      id: 'date-only-release',
      date: '2026-08-05',
      documentNumber: '260805POS',
      memo: '',
      amount: '50.00',
      side: 'debit',
    }),
    pos_accounting_origin: 'shogo',
  }),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-05',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-04',
    toBusinessDate: '2026-08-05',
  }],
})
assert.equal(dateOnlyReceiptDoesNotBackRelease.summary.dateFallbackPairs, 0)
assert.equal(dateOnlyReceiptDoesNotBackRelease.clearingLifecycles.length, 1)
assert.equal(dateOnlyReceiptDoesNotBackRelease.clearingLifecycles[0].status, 'settled')
assert.equal(dateOnlyReceiptDoesNotBackRelease.clearingLifecycles[0].salesReceipts.length, 0)
assert.equal(dateOnlyReceiptDoesNotBackRelease.clearingLifecycles[0].reviewReason, null)
assert.equal(dateOnlyReceiptDoesNotBackRelease.summary.unmatchedEvidence, 1)
assert.equal(dateOnlyReceiptDoesNotBackRelease.unmatchedGroups.length, 1)
assert.equal(
  dateOnlyReceiptDoesNotBackRelease.unmatchedGroups[0].evidence[0].providerTransactionId,
  'date-only-unrelated-receipt',
)

const lateFutureOrderReleaseBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'late-future-order-capture',
    date: '2026-07-01',
    documentNumber: '260701POS',
    amount: '75.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'late-future-order-release',
    date: '2026-08-15',
    documentNumber: '260815POS',
    amount: '75.00',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-15',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-07-01',
    toBusinessDate: '2026-08-15',
  }],
})
assert.equal(lateFutureOrderReleaseBaseline.clearingLifecycles.length, 1)
assert.equal(lateFutureOrderReleaseBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(lateFutureOrderReleaseBaseline.clearingLifecycles[0].appliedCents, 7_500)
assert.equal(lateFutureOrderReleaseBaseline.clearingLifecycles[0].salesReceipts.length, 0)
assert.equal(lateFutureOrderReleaseBaseline.summary.unmatchedGroups, 0)
assert.equal(lateFutureOrderReleaseBaseline.summary.unmatchedEvidence, 0)

const splitReleaseWithoutReceiptBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-no-receipt-capture',
    date: '2026-08-20',
    documentNumber: '260820POS',
    amount: '100.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-no-receipt-first',
    date: '2026-08-21',
    documentNumber: '260821POS',
    amount: '40.00',
    side: 'debit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'split-release-no-receipt-final',
    date: '2026-08-22',
    documentNumber: '260822POS',
    amount: '60.00',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-22',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-20',
    toBusinessDate: '2026-08-22',
  }],
})
assert.equal(splitReleaseWithoutReceiptBaseline.clearingLifecycles.length, 1)
assert.equal(splitReleaseWithoutReceiptBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(splitReleaseWithoutReceiptBaseline.clearingLifecycles[0].releaseJournals.length, 2)
assert.equal(splitReleaseWithoutReceiptBaseline.clearingLifecycles[0].salesReceipts.length, 0)
assert.equal(splitReleaseWithoutReceiptBaseline.summary.unmatchedGroups, 0)
assert.equal(splitReleaseWithoutReceiptBaseline.summary.unmatchedEvidence, 0)

const aggregateClearingCohortBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'aggregate-clearing-capture-40',
    date: '2026-08-20',
    documentNumber: '260820POS-A',
    amount: '40.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'aggregate-clearing-capture-90',
    date: '2026-08-21',
    documentNumber: '260821POS-A',
    amount: '90.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'aggregate-clearing-release-100',
    date: '2026-08-22',
    documentNumber: '260822POS-A',
    amount: '100.00',
    side: 'debit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'aggregate-clearing-release-30',
    date: '2026-08-23',
    documentNumber: '260823POS-A',
    amount: '30.00',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-23',
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-20',
    toBusinessDate: '2026-08-23',
  }],
})
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles.length, 1)
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].capturedCents, 13_000)
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].releasedCents, 13_000)
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].appliedCents, 13_000)
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].outstandingCents, 0)
assert.equal(aggregateClearingCohortBaseline.clearingLifecycles[0].releaseJournals.length, 2)
assert.equal(aggregateClearingCohortBaseline.summary.unmatchedGroups, 0)
assert.equal(aggregateClearingCohortBaseline.summary.unmatchedEvidence, 0)

const chronologyBlockedClearingBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'chronology-blocked-capture-40',
    date: '2026-08-20',
    documentNumber: '260820POS-B',
    amount: '40.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'chronology-blocked-capture-90',
    date: '2026-08-21',
    documentNumber: '260821POS-B',
    amount: '90.00',
    side: 'credit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'chronology-blocked-release-100',
    date: '2026-08-22',
    documentNumber: '260822POS-B',
    amount: '100.00',
    side: 'debit',
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'chronology-blocked-release-40',
    date: '2026-08-23',
    documentNumber: '260823POS-B',
    amount: '40.00',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-23',
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-20',
    toBusinessDate: '2026-08-23',
  }],
})
assert.equal(chronologyBlockedClearingBaseline.clearingLifecycles.length, 1)
assert.equal(chronologyBlockedClearingBaseline.summary.clearingStatusCounts.settled, 0)
assert.equal(chronologyBlockedClearingBaseline.summary.clearingStatusCounts.ambiguous, 1)
assert.equal(chronologyBlockedClearingBaseline.clearingLifecycles[0].status, 'ambiguous')
assert.equal(chronologyBlockedClearingBaseline.clearingLifecycles[0].appliedCents, 0)
assert.equal(chronologyBlockedClearingBaseline.clearingLifecycles[0].outstandingCents, 13_000)
assert.equal(chronologyBlockedClearingBaseline.clearingLifecycles[0].unappliedReleaseCents, 14_000)
assert.deepEqual(
  Array.from(
    chronologyBlockedClearingBaseline.clearingLifecycles[0].releaseJournals,
    (row) => row.providerTransactionId,
  ),
  ['chronology-blocked-release-100', 'chronology-blocked-release-40'],
)
assert.equal(chronologyBlockedClearingBaseline.summary.unmatchedGroups, 2)
assert.equal(chronologyBlockedClearingBaseline.summary.unmatchedEvidence, 2)
assert.deepEqual(
  Array.from(chronologyBlockedClearingBaseline.unmatchedGroups)
    .flatMap((group) => Array.from(group.evidence, (row) => row.providerTransactionId))
    .sort(),
  ['chronology-blocked-release-100', 'chronology-blocked-release-40'].sort(),
)

const multiAccountConflictBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(journalTransaction({
    id: 'multi-account-payment-exceptions-conflict',
    date: '2026-08-24',
    documentNumber: '260824POS-CONFLICT',
    lines: [{
      Id: '1', Amount: '10.00', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: 'account-payment-exceptions', name: 'Payment Exceptions' },
      },
    }, {
      Id: '2', Amount: '10.00', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: 'account-payment-exceptions', name: 'Payment Exceptions' },
      },
    }, {
      Id: '3', Amount: '20.00', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Debit',
        AccountRef: { value: 'account-payment-exceptions-alt', name: 'Payment Exceptions Alt' },
      },
    }, {
      Id: '4', Amount: '20.00', DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: {
        PostingType: 'Credit',
        AccountRef: { value: 'account-payment-exceptions-alt', name: 'Payment Exceptions Alt' },
      },
    }],
  })),
], {
  paymentExceptionAccounts: [
    { accountId: 'account-payment-exceptions' },
    { accountId: 'account-payment-exceptions-alt' },
  ],
  asOfBusinessDate: '2026-08-24',
})
assert.equal(multiAccountConflictBaseline.clearingLifecycles.length, 2)
assert.deepEqual(
  Array.from(multiAccountConflictBaseline.clearingLifecycles, (row) => [
      row.paymentExceptionsAccountId,
      row.capturedCents,
      row.releasedCents,
      row.status,
    ])
    .sort((left, right) => left[0].localeCompare(right[0])),
  [
    ['account-payment-exceptions', 1_000, 1_000, 'ambiguous'],
    ['account-payment-exceptions-alt', 2_000, 2_000, 'ambiguous'],
  ],
)

const debitOnlyUnpairedBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'debit-without-capture-or-receipt',
    date: '2026-08-01',
    documentNumber: '260801POS',
    amount: '44.54',
    side: 'debit',
  })),
], {
  paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
  asOfBusinessDate: '2026-08-01',
  overdueGraceDays: 3,
})
assert.equal(debitOnlyUnpairedBaseline.summary.journalOnlyCaptureCount, 0)
assert.equal(debitOnlyUnpairedBaseline.clearingLifecycles.length, 1)
assert.equal(debitOnlyUnpairedBaseline.clearingLifecycles[0].status, 'ambiguous')
assert.equal(debitOnlyUnpairedBaseline.clearingLifecycles[0].captureJournals.length, 0)
assert.equal(
  debitOnlyUnpairedBaseline.clearingLifecycles[0].releaseJournal.providerTransactionId,
  'debit-without-capture-or-receipt',
)

const renamedAccountBaseline = pure.buildHistoricalPosAccountingBaseline([
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'renamed-account-capture',
    date: '2026-08-10',
    documentNumber: '260810POS',
    amount: '25.00',
    side: 'credit',
    accountName: 'Deferred tender holding',
  })),
  pure.normalizeSalesReceiptEvidence(receiptTransaction({
    id: 'renamed-account-receipt',
    date: '2026-08-12',
    documentNumber: '260812POS',
    total: '25.00',
    tax: '0.00',
    lines: singleItemReceiptLines('25.00'),
  })),
  pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
    id: 'renamed-account-release',
    date: '2026-08-12',
    documentNumber: '260812POS',
    amount: '25.00',
    side: 'debit',
    accountName: 'Deferred tender holding',
  })),
], {
  paymentExceptionAccounts: [{
    accountId: 'account-payment-exceptions',
    accountName: 'Payment Exceptions before rename',
  }],
  asOfBusinessDate: '2026-08-12',
  overdueGraceDays: 3,
  evidenceCoverageRanges: [{
    fromBusinessDate: '2026-08-10',
    toBusinessDate: '2026-08-12',
  }],
})
assert.equal(renamedAccountBaseline.clearingLifecycles.length, 1)
assert.equal(renamedAccountBaseline.clearingLifecycles[0].status, 'settled')
assert.equal(
  renamedAccountBaseline.clearingLifecycles[0].accountMatchBasis,
  'configured_account_id',
)
assert.equal(
  renamedAccountBaseline.clearingLifecycles[0].paymentExceptionsAccountName,
  'Deferred tender holding',
)

function agedCaptureBaseline(evidenceCoverageRanges, providerHistoryBoundaryProven = false) {
  return pure.buildHistoricalPosAccountingBaseline([
    pure.normalizeJournalEntryEvidence(paymentExceptionsJournalTransaction({
      id: `aged-capture-${evidenceCoverageRanges.length ? 'complete' : 'cached'}`,
      date: '2026-08-20',
      documentNumber: '260820POS',
      amount: '30.00',
      side: 'credit',
    })),
  ], {
    paymentExceptionAccounts: [{ accountId: 'account-payment-exceptions' }],
    asOfBusinessDate: '2026-08-24',
    overdueGraceDays: 3,
    evidenceCoverageRanges,
    providerHistoryBoundaryProven,
  })
}

const cachedOnlyAgedCapture = agedCaptureBaseline([])
assert.equal(cachedOnlyAgedCapture.clearingLifecycles.length, 1)
assert.equal(cachedOnlyAgedCapture.clearingLifecycles[0].status, 'pending')
assert.equal(cachedOnlyAgedCapture.clearingLifecycles[0].evidenceCoverage, 'cached_only')

const forwardOnlyCoverageAgedCapture = agedCaptureBaseline([{
  fromBusinessDate: '2026-08-20',
  toBusinessDate: '2026-08-24',
}])
assert.equal(forwardOnlyCoverageAgedCapture.clearingLifecycles.length, 1)
assert.equal(forwardOnlyCoverageAgedCapture.clearingLifecycles[0].status, 'pending')
assert.equal(forwardOnlyCoverageAgedCapture.clearingLifecycles[0].evidenceCoverage, 'cached_only')

const completeCoverageAgedCapture = agedCaptureBaseline([{
  fromBusinessDate: '2026-08-20',
  toBusinessDate: '2026-08-24',
}], true)
assert.equal(completeCoverageAgedCapture.clearingLifecycles.length, 1)
assert.equal(completeCoverageAgedCapture.clearingLifecycles[0].status, 'pending')
assert.equal(completeCoverageAgedCapture.clearingLifecycles[0].evidenceCoverage, 'complete')
assert.equal(completeCoverageAgedCapture.clearingLifecycles[0].reviewReason, null)

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
      last_pos_evidence_synced_at: '2026-09-16T12:00:00.000Z',
      quickbooks_company_id: 'qbo-company-test',
      maton_connection_id: 'maton-connection-test',
      sync_status: 'succeeded',
      sync_completed_at: '2026-09-16T12:00:00.000Z',
      sales_receipt_count: '49',
      journal_entry_count: '48',
      drafts_newer_than_evidence: '0',
    }] }
  }
  if (source.includes('FROM pos_accounting_catalog_mappings mapping')) {
    return { rows: [{
      account_id: 'account-payment-exceptions',
      account_name: 'Payment Exceptions',
    }] }
  }
  if (source.includes("event.event_type = 'quickbooks.pos_evidence.refreshed'")) {
    return { rows: [{
      from_business_date: '2025-03-14',
      to_business_date: '2026-09-15',
    }] }
  }
  if (source.includes("transaction.entity_type = 'JournalEntry'")
    && source.includes('transaction.transaction_date < $2::date')) {
    return { rows: [] }
  }
  if (source.includes('LEFT JOIN toast_locations location')) return { rows: [] }
  if (source.includes('SELECT transaction.entity_type')) return { rows: historicalTransactions }
  throw new Error(`Unexpected parity query: ${source}`)
}

const reader = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/accounting/posClearingReconciliation': clearingReconciliation,
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
assert.equal(postgresReport.cache.lastPosEvidenceSyncedAt, '2026-09-16T12:00:00.000Z')
assert.equal(postgresReport.evidenceLastSyncedAt, '2026-09-16T12:00:00.000Z')
assert.equal(postgresReport.evidenceFreshness.draftsNewerThanEvidence, 0)
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
assert.equal(postgresReport.historicalPagination.postingBundlePages, 0)
assert.equal(postgresReport.historicalPagination.journalOnlyCapturePages, 0)
assert.equal(postgresReport.historicalPagination.clearingLifecyclePages, 0)
assert.equal(postgresReport.historicalPagination.unmatchedPages, 1)
assert.equal(JSON.stringify(postgresReport).includes('source_payload'), false)
assert.equal(JSON.stringify(postgresReport).includes('rawSourcePayloadSecret'), false)

assert.equal(sqlCalls.length, 8)
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
assert.equal(sqlCalls.some((call) => call.source.includes('last_pos_evidence_synced_at')), true)
assert.equal(sqlCalls.some((call) => call.source.includes('AS scheduled_for_future')), true)
assert.equal(sqlCalls.some((call) => call.source.includes("IN ('SalesReceipt', 'JournalEntry')")), true)
const fullHistoryQuery = sqlCalls.find((call) =>
  call.source.includes('SELECT transaction.entity_type')
    && call.source.includes("transaction.entity_type IN ('SalesReceipt', 'JournalEntry')")
    && call.source.includes('transaction.transaction_date IS NOT NULL'))
assert.ok(fullHistoryQuery)
assert.deepEqual([...fullHistoryQuery.parameters], [
  ORGANIZATION_ID,
  '2025-03-14',
  '2026-09-15',
])
assert.match(fullHistoryQuery.source, /transaction\.transaction_date >= \$2/)
assert.match(fullHistoryQuery.source, /transaction\.transaction_date <= \$3/)
assert.doesNotMatch(fullHistoryQuery.source, /ANY\(\$2::date\[\]\)/)
assert.doesNotMatch(fullHistoryQuery.source, /\bLIMIT\b/)

const openingBalanceQuery = sqlCalls.find((call) =>
  call.source.includes("transaction.entity_type = 'JournalEntry'")
    && call.source.includes('transaction.transaction_date < $2::date'))
assert.ok(openingBalanceQuery)
assert.deepEqual([...openingBalanceQuery.parameters], [
  ORGANIZATION_ID,
  '2025-03-14',
  ['account-payment-exceptions'],
  1001,
])
assert.match(openingBalanceQuery.source, /transaction\.transaction_date < \$2::date/)
assert.match(openingBalanceQuery.source, /jsonb_path_query/)
assert.match(openingBalanceQuery.source, /JournalEntryLineDetail/)
assert.match(openingBalanceQuery.source, /AccountRef,value/)
assert.match(openingBalanceQuery.source, /cardinality\(\$3::text\[\]\)/)
assert.match(openingBalanceQuery.source, /LIMIT \$4::integer/)
assert.doesNotMatch(openingBalanceQuery.source, /transaction\.transaction_date <= \$3::date/)
assert.doesNotMatch(openingBalanceQuery.source, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i)

const paymentExceptionMappingsQuery = sqlCalls.find((call) =>
  call.source.includes('FROM pos_accounting_catalog_mappings mapping'))
assert.ok(paymentExceptionMappingsQuery)
assert.match(paymentExceptionMappingsQuery.source, /mapping\.effective_to IS NULL/)

const evidenceCoverageQuery = sqlCalls.find((call) =>
  call.source.includes("event.event_type = 'quickbooks.pos_evidence.refreshed'"))
assert.ok(evidenceCoverageQuery)
assert.doesNotMatch(evidenceCoverageQuery.source, /connection\.verified_at/)
assert.match(evidenceCoverageQuery.source, /quickbooks\.connection\.bound/)

const warningQueryCalls = []
const warningReader = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/accounting/posClearingReconciliation': clearingReconciliation,
  '@/lib/persistence/postgres': {
    query: async (source, parameters = []) => {
      warningQueryCalls.push({ source, parameters })
      if (source.includes('count(*)::text AS total_dates FROM evidence_dates')) {
        return { rows: [{ total_dates: '1' }] }
      }
      if (source.includes('SELECT evidence_date::text AS business_date')) {
        return { rows: [{ business_date: '2026-07-20' }] }
      }
      if (source.includes('EXISTS (') && source.includes('sales_receipt_count')) {
        return { rows: [{
          configured: true,
          connection_status: 'active',
          last_catalog_synced_at: '2026-07-20T12:00:00.000Z',
          last_pos_evidence_synced_at: '2026-07-20T12:00:00.000Z',
          quickbooks_company_id: 'qbo-company-test',
          maton_connection_id: 'maton-connection-test',
          sync_status: 'succeeded',
          sync_completed_at: '2026-07-20T12:00:00.000Z',
          sales_receipt_count: '0',
          journal_entry_count: '1',
          drafts_newer_than_evidence: '0',
        }] }
      }
      if (source.includes('FROM pos_accounting_catalog_mappings mapping')) return { rows: [] }
      if (source.includes("event.event_type = 'quickbooks.pos_evidence.refreshed'")) {
        return { rows: [] }
      }
      if (source.includes("transaction.entity_type = 'JournalEntry'")
        && source.includes('transaction.transaction_date < $2::date')) {
        return { rows: Array.from({ length: 1001 }, () => ({})) }
      }
      if (source.includes('LEFT JOIN toast_locations location')) return { rows: [] }
      if (source.includes('SELECT transaction.entity_type')) {
        return { rows: [paymentExceptionsJournalTransaction({
          id: 'legacy-warning-capture',
          date: '2026-07-20',
          documentNumber: '260720POS',
          amount: '10.00',
          side: 'credit',
        })] }
      }
      throw new Error(`Unexpected warning parity query: ${source}`)
    },
  },
})
const warningReport = await warningReader.readPosAccountingParityReportInPostgres({
  organizationId: ORGANIZATION_ID,
  fromBusinessDate: '2026-07-20',
  toBusinessDate: '2026-07-20',
  historyPage: 2,
  historyPageSize: 1,
})
assert.equal(warningReport.historicalBaseline.clearingLifecycles.length, 0)
assert.equal(warningReport.historicalPagination.clearingLifecyclePages, 1)
assert.equal(
  warningReport.warnings.some((warning) => warning.includes('legacy account name')),
  true,
)
assert.equal(
  warningReport.warnings.some((warning) => warning.includes('organization and QuickBooks account level')),
  true,
)
assert.equal(
  warningReport.warnings.some((warning) => warning.includes('1000 most recent cached earlier')),
  true,
)
assert.equal(
  warningReport.warnings.some((warning) => warning.includes('provider history before the selected range')),
  true,
)
const warningOpeningQuery = warningQueryCalls.find((call) =>
  call.source.includes("transaction.entity_type = 'JournalEntry'")
    && call.source.includes('transaction.transaction_date < $2::date'))
assert.equal(warningOpeningQuery.parameters[3], 1001)

const detailCalls = []
const detailReader = loadTypeScriptModule('app_src/lib/persistence/posAccountingParity.ts', {
  '@/lib/accounting/posClearingReconciliation': clearingReconciliation,
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
assert.match(parityPanel, /Sync QuickBooks and recheck/)
assert.match(parityPanel, /action: 'refresh-pos-evidence'/)
assert.match(parityPanel, /lastEvidenceSyncedAt/)
assert.match(parityPanel, /draftsNewerThanEvidence/)
assert.match(parityPanel, /Acknowledgment was not recorded/)
assert.match(parityPanel, /payment-date exception requires its exact Journal Entry/)
assert.match(parityPanel, /scheduled for fulfillment/)
assert.match(parityPanel, /Tips belong in the[\s\S]*payment Journal Entry[\s\S]*excluded from the Sales Receipt total/)
assert.match(parityPanel, /Preorder lifecycles/)
assert.match(parityPanel, /Recognized multi-document posting bundles/)
assert.match(parityPanel, /They are recognized as one posting bundle and are not exceptions/)
assert.match(parityPanel, /Payment Exceptions clearing/)
assert.match(parityPanel, /organization-level clearing cycle/)
assert.match(
  parityPanel,
  /const clearingLifecycleSchemaPresent = baseline\?\.clearingLifecycles !== undefined/,
)
assert.match(
  parityPanel,
  /const visibleLegacyJournalOnlyCaptures = clearingLifecycleSchemaPresent\s*\? \[\]\s*: baseline\?\.journalOnlyCaptures \|\| \[\]/,
)
assert.doesNotMatch(
  parityPanel,
  /const visibleLegacyJournalOnlyCaptures = visibleClearingLifecycles\.length/,
)
const selectLegacyJournalOnlyCapturesBySchemaPresence = (baseline) => (
  baseline.clearingLifecycles !== undefined ? [] : baseline.journalOnlyCaptures || []
)
const emptyClearingLifecyclePage = {
  summary: { clearingLifecycleCount: 1 },
  clearingLifecycles: [],
  journalOnlyCaptures: [{ journalEntry: { evidenceId: 'legacy-row-must-not-reappear' } }],
}
assert.equal(emptyClearingLifecyclePage.summary.clearingLifecycleCount, 1)
assert.equal(emptyClearingLifecyclePage.clearingLifecycles.length, 0)
assert.equal(selectLegacyJournalOnlyCapturesBySchemaPresence(emptyClearingLifecyclePage).length, 0)
assert.equal(selectLegacyJournalOnlyCapturesBySchemaPresence({
  journalOnlyCaptures: emptyClearingLifecyclePage.journalOnlyCaptures,
}).length, 1)
assert.match(parityPanel, /Payment Exceptions credit fully offset by a later debit/)
assert.match(parityPanel, /Provisional account offset · cached evidence/)
assert.match(parityPanel, /label="Account offset"/)
assert.match(parityPanel, /Verify full provider history or a known zero-balance boundary before treating the clearing cycle as conclusively settled/)
assert.match(parityPanel, /cachedOffsetIsProvisional/)
assert.match(parityPanel, /const displayedClearingStatusCounts = baseline\?\.summary\.clearingStatusCounts/)
assert.match(parityPanel, /available organization-level evidence is insufficient for a conclusive allocation/)
assert.doesNotMatch(parityPanel, /More than one organization-level journal allocation fits/)
assert.match(
  parityPanel,
  /const evidenceStatus = cachedOffsetIsProvisional\s*\? CACHED_CLEARING_OFFSET_STATUS\s*: effectiveStatus/,
)
assert.match(parityPanel, /status === CACHED_CLEARING_OFFSET_STATUS\) return 'info'/)
assert.doesNotMatch(parityPanel, /const evidenceStatus = effectiveStatus/)
assert.match(parityPanel, /Offsets observed/)
assert.match(parityPanel, /not clearing proof/)
assert.match(parityPanel, /Sales Receipt evidence/)
assert.match(parityPanel, /Sync the relevant later dates before treating this balance as missing or overdue/)
assert.match(parityPanel, /Complete organization-level account evidence did not show a full offsetting debit within the expected window/)
assert.match(parityPanel, /does not establish Toast-location attribution or create accounting notifications/)
assert.match(parityPanel, /earlier credits appear only as opening-balance context/)

console.log('PASS POS accounting parity normalization, matching, comparison, historical corpus, and read-only Postgres contracts')
