import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  fingerprintQuickBooksWritePayload,
  type QuickBooksJournalEntryDraft,
  type QuickBooksSalesReceiptDraft,
  type QuickBooksWriteDraftPayload,
  type QuickBooksWriteOperationKind,
} from '@/lib/integrations/quickBooksWritePayloads'
import {
  buildPosAccountingParityReport,
  readPosAccountingParityReportInPostgres,
} from '@/lib/persistence/posAccountingParity'
import {
  evaluateStoredPosAccountingReadiness,
  POS_ACCOUNTING_POSTING_GATE_VERSION,
} from '@/lib/persistence/posAccounting'
import { acquireTransactionAdvisoryLock, withTransaction } from '@/lib/persistence/postgres'
import { configuredQuickBooksWritePolicy } from '@/lib/quickBooksWritePolicy'

type JsonRecord = Record<string, unknown>
type PostingBatchStatus =
  | 'pending_approval'
  | 'approved'
  | 'posting'
  | 'posted'
  | 'partial_failed'
  | 'failed'
  | 'cancelled'

const EXTERNAL_POSTING_RECONCILIATION_STATUSES = new Set(['ready', 'orders_only'])

type DraftRow = {
  id: string
  restaurant_guid: string
  business_date: string
  status: string
  reconciliation_status: string
  source_summary: unknown
  proposed_lines: unknown
  posting_batch_id: string | null
  is_current: boolean
}

type ExternalPostingDraftRow = DraftRow & {
  review_outcome: string | null
  posting_origin: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  external_posting_provider: string | null
  external_posting_reference: string | null
  quickbooks_sales_receipt_id: string | null
  quickbooks_journal_entry_id: string | null
  draft_revision: number
  source_revision: number
  updated_at: string
  restaurant_name: string | null
  location_name: string | null
}

type PostingBatchRow = {
  id: string
  draft_id: string
  restaurant_guid: string
  business_date: string
  status: PostingBatchStatus
  request_fingerprint: string
  sales_receipt_request_id: string | null
  sales_receipt_status: string | null
  sales_receipt_provider_entity_id: string | null
  sales_receipt_error: string | null
  journal_entry_request_id: string
  journal_entry_status: string
  journal_entry_provider_entity_id: string | null
  journal_entry_error: string | null
  requested_by: string
  approved_by: string | null
  approval_note: string | null
  last_error: string | null
  submitted_at: string
  approved_at: string | null
  posted_at: string | null
  updated_at: string
}

export class PosAccountingPostingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'PosAccountingPostingError'
  }
}

const BATCH_SELECT = `batch.id::text, batch.draft_id::text,
  batch.restaurant_guid::text, batch.business_date::text, batch.status,
  batch.request_fingerprint, batch.sales_receipt_request_id::text,
  receipt.status AS sales_receipt_status,
  receipt.provider_entity_id AS sales_receipt_provider_entity_id,
  receipt.last_error_message AS sales_receipt_error,
  batch.journal_entry_request_id::text, journal.status AS journal_entry_status,
  journal.provider_entity_id AS journal_entry_provider_entity_id,
  journal.last_error_message AS journal_entry_error,
  batch.requested_by, batch.approved_by, batch.approval_note, batch.last_error,
  batch.submitted_at::text, batch.approved_at::text, batch.posted_at::text,
  batch.updated_at::text`

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

function text(value: unknown, maximum = 1_000): string | null {
  const cleaned = String(value ?? '').trim()
  return cleaned && cleaned.length <= maximum && !/[\u0000-\u001f\u007f]/.test(cleaned) ? cleaned : null
}

function amount(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0
}

function requiredUuid(value: unknown, label: string) {
  const id = String(value || '').trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_ID_INVALID', `${label} is invalid`)
  }
  return id
}

function requiredDate(value: unknown, label: string) {
  const date = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const parsed = match ? new Date(`${date}T00:00:00.000Z`) : null
  if (!match || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_DATE_INVALID', `${label} must be a valid date`)
  }
  return date
}

function requiredProviderId(value: unknown, label: string) {
  const id = text(value, 200)
  if (!id) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_EXTERNAL_EVIDENCE_ID_INVALID', `${label} is required`)
  }
  return id
}

function optionalProviderId(value: unknown, label: string) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  return requiredProviderId(value, label)
}

function requiredExternalProvider(value: unknown) {
  const provider = text(value, 120)
  if (!provider) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_EXTERNAL_PROVIDER_INVALID',
      'Name the system that posted these QuickBooks documents',
    )
  }
  return provider
}

function optionalExternalReference(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const reference = text(value, 200)
  if (!reference) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_EXTERNAL_REFERENCE_INVALID',
      'External posting reference is invalid',
    )
  }
  return reference
}

function deterministicUuid(seed: string) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function batchFromRow(row: PostingBatchRow) {
  return {
    id: row.id,
    draftId: row.draft_id,
    restaurantGuid: row.restaurant_guid,
    businessDate: row.business_date,
    status: row.status,
    requestFingerprint: row.request_fingerprint,
    salesReceipt: {
      requestId: row.sales_receipt_request_id,
      status: row.sales_receipt_status || 'not_required',
      providerEntityId: row.sales_receipt_provider_entity_id,
      error: row.sales_receipt_error,
    },
    journalEntry: {
      requestId: row.journal_entry_request_id,
      status: row.journal_entry_status,
      providerEntityId: row.journal_entry_provider_entity_id,
      error: row.journal_entry_error,
    },
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvalNote: row.approval_note,
    lastError: row.last_error,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
    updatedAt: row.updated_at,
  }
}

async function readBatch(client: PoolClient, organizationId: string, batchId: string) {
  const result = await client.query<PostingBatchRow>(
    `SELECT ${BATCH_SELECT}
     FROM pos_accounting_posting_batches batch
     LEFT JOIN quickbooks_write_requests receipt ON receipt.id = batch.sales_receipt_request_id
     JOIN quickbooks_write_requests journal ON journal.id = batch.journal_entry_request_id
     WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
     FOR UPDATE OF batch, journal`,
    [organizationId, batchId],
  )
  return result.rows[0] || null
}

function assertCanonicalDraftReadiness(draft: Pick<DraftRow, 'source_summary'>) {
  const sourceSummary = record(draft.source_summary)
  const canonical = record(sourceSummary.canonical)
  const storedReadiness = record(canonical.readiness)
  if (storedReadiness.postingGateVersion !== POS_ACCOUNTING_POSTING_GATE_VERSION) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_REGENERATION_REQUIRED',
      'Regenerate accounting before posting so this draft is checked against the current Toast closeout rules.',
      409,
    )
  }
  const readiness = evaluateStoredPosAccountingReadiness(storedReadiness)
  if (storedReadiness.readyForReview !== true || !readiness.readyForReview) {
    const blocker = readiness.blockers[0]
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_NOT_READY',
      blocker
        ? `${blocker.title}: ${blocker.detail}`
        : 'Resolve every accounting hold before preparing or approving this date',
      409,
    )
  }
  return { sourceSummary, canonical, readiness }
}

function isJournalOnlyPaymentExceptionDraft(draft: Pick<DraftRow, 'proposed_lines'>) {
  const lines = records(draft.proposed_lines)
  const hasReceipt = lines.some((line) => line.document === 'sales_receipt')
  return !hasReceipt && lines.some((line) =>
    line.document === 'payments_journal'
      && line.sourceKind === 'payment_exception'
      && line.code === 'payment_exception_capture')
}

export function posAccountingDraftTaxAmount(sourceSummaryValue: unknown) {
  const sourceSummary = record(sourceSummaryValue)
  const canonicalReceipt = record(record(record(sourceSummary.canonical).accounting).salesReceipt)
  return canonicalReceipt.tax !== null && canonicalReceipt.tax !== undefined
    ? amount(canonicalReceipt.tax)
    : amount(record(sourceSummary.standard).tax)
}

async function materializePostingPayloads(
  client: PoolClient,
  organizationId: string,
  draft: DraftRow,
) {
  const { sourceSummary, canonical } = assertCanonicalDraftReadiness(draft)
  const profileId = requiredUuid(canonical.profileId, 'Accounting profile')
  const profileResult = await client.query<{
    quickbooks_binding_status: string
    quickbooks_customer_id: string | null
    quickbooks_customer_name: string | null
    quickbooks_clearing_account_id: string | null
    quickbooks_clearing_account_name: string | null
    track_sales_tax: boolean
  }>(
    `SELECT quickbooks_binding_status, quickbooks_customer_id, quickbooks_customer_name,
       quickbooks_clearing_account_id, quickbooks_clearing_account_name, track_sales_tax
     FROM pos_accounting_profiles
     WHERE organization_id = $1::uuid AND id = $2::uuid
     LIMIT 1`,
    [organizationId, profileId],
  )
  const profile = profileResult.rows[0]
  if (!profile || profile.quickbooks_binding_status !== 'verified' || !profile.quickbooks_clearing_account_id) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_BINDING_REQUIRED',
      'Verify the QuickBooks company and clearing account before preparing this date',
      409,
    )
  }

  const proposedLines = records(draft.proposed_lines)
  const rawReceiptLines = proposedLines.filter((line) => line.document === 'sales_receipt')
  const rawJournalLines = proposedLines.filter((line) => line.document === 'payments_journal')
  const journalOnlyPaymentException = rawReceiptLines.length === 0
    && rawJournalLines.some((line) =>
      line.sourceKind === 'payment_exception' && line.code === 'payment_exception_capture')
  if (!rawJournalLines.length || (rawReceiptLines.length === 0 && !journalOnlyPaymentException)) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_DOCUMENTS_INCOMPLETE',
      'The accounting draft must contain a Journal Entry and, unless it is payment-exception-only, a Sales Receipt',
      409,
    )
  }

  const itemIds = [...new Set(rawReceiptLines.map((line) => text(record(line.target).id, 200)).filter(Boolean))] as string[]
  const itemResult = await client.query<{
    quickbooks_item_id: string
    name: string
    fully_qualified_name: string
    item_type: string
    taxable: boolean
  }>(
    `SELECT quickbooks_item_id, name, fully_qualified_name, item_type, taxable
     FROM quickbooks_items
     WHERE organization_id = $1::uuid AND quickbooks_item_id = ANY($2::text[]) AND active = true`,
    [organizationId, itemIds],
  )
  const items = new Map(itemResult.rows.map((item) => [item.quickbooks_item_id, item]))
  const receiptLines = rawReceiptLines.map((line, index) => {
    const target = record(line.target)
    const itemId = text(target.id, 200)
    const item = itemId ? items.get(itemId) : null
    const quantity = Number(line.quantity)
    const lineAmount = amount(line.amount)
    if (!itemId || !item || item.item_type.toLowerCase() === 'category'
      || !Number.isFinite(quantity) || quantity <= 0 || lineAmount === 0) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_ITEM_INVALID',
        `Sales Receipt line ${index + 1} is not mapped to an active QuickBooks product`,
        409,
      )
    }
    return {
      itemId,
      itemName: item.fully_qualified_name || item.name,
      description: text(line.sourceName, 1_000),
      quantity: Math.round(quantity * 1_000) / 1_000,
      unitPrice: amount(lineAmount / quantity),
      amount: lineAmount,
      taxable: item.taxable,
    }
  })

  const accountIds = [...new Set([
    profile.quickbooks_clearing_account_id,
    ...rawJournalLines.map((line) => text(record(line.target).id, 200)),
  ].filter(Boolean))] as string[]
  const accountResult = await client.query<{
    quickbooks_account_id: string
    fully_qualified_name: string
  }>(
    `SELECT quickbooks_account_id, fully_qualified_name
     FROM quickbooks_accounts
     WHERE organization_id = $1::uuid AND quickbooks_account_id = ANY($2::text[]) AND active = true`,
    [organizationId, accountIds],
  )
  const accounts = new Map(accountResult.rows.map((account) => [account.quickbooks_account_id, account]))
  if (!accounts.has(profile.quickbooks_clearing_account_id)) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_CLEARING_INVALID',
      'The selected QuickBooks clearing account is no longer active',
      409,
    )
  }
  const journalLines = rawJournalLines.map((line, index) => {
    const accountId = text(record(line.target).id, 200)
    const account = accountId ? accounts.get(accountId) : null
    const postingType = line.side === 'debit' ? 'Debit' : line.side === 'credit' ? 'Credit' : null
    const lineAmount = amount(line.amount)
    if (!accountId || !account || !postingType || lineAmount <= 0) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_JOURNAL_INVALID',
        `Journal Entry line ${index + 1} is not mapped to an active QuickBooks account`,
        409,
      )
    }
    return {
      accountId,
      accountName: account.fully_qualified_name,
      description: text(line.label, 1_000),
      postingType,
      amount: lineAmount,
    } as QuickBooksJournalEntryDraft['lines'][number]
  })
  const debitAmount = amount(journalLines.filter((line) => line.postingType === 'Debit').reduce((sum, line) => sum + line.amount, 0))
  const creditAmount = amount(journalLines.filter((line) => line.postingType === 'Credit').reduce((sum, line) => sum + line.amount, 0))
  if (debitAmount <= 0 || Math.abs(debitAmount - creditAmount) >= 0.01) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_JOURNAL_UNBALANCED',
      'The Journal Entry must be balanced before it can be prepared',
      409,
    )
  }

  let taxCode: { id: string; name: string } | null = null
  const taxAmount = posAccountingDraftTaxAmount(sourceSummary)
  if (profile.track_sales_tax && taxAmount !== 0) {
    const mappingIds = records(canonical.mappingRevisions)
      .filter((mapping) => mapping.sourceKind === 'tax' && mapping.targetType === 'tax_code')
      .map((mapping) => requiredUuid(mapping.id, 'Tax mapping'))
    const taxResult = await client.query<{ target_id: string; target_name: string }>(
      `SELECT mapping.target_id, mapping.target_name
       FROM pos_accounting_catalog_mappings mapping
       JOIN quickbooks_tax_codes tax_code
         ON tax_code.organization_id = mapping.organization_id
        AND tax_code.quickbooks_tax_code_id = mapping.target_id
        AND tax_code.active = true
       WHERE mapping.organization_id = $1::uuid
         AND mapping.id = ANY($2::uuid[]) AND mapping.active = true
       ORDER BY mapping.created_at DESC LIMIT 1`,
      [organizationId, mappingIds],
    )
    const row = taxResult.rows[0]
    if (!row) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_TAX_INVALID',
        'The sales tax mapping is no longer active in QuickBooks',
        409,
      )
    }
    taxCode = { id: row.target_id, name: row.target_name }
  }

  if (rawReceiptLines.length > 0 && profile.quickbooks_customer_id) {
    const customer = await client.query<{ quickbooks_customer_id: string }>(
      `SELECT quickbooks_customer_id FROM quickbooks_customers
       WHERE organization_id = $1::uuid AND quickbooks_customer_id = $2 AND active = true LIMIT 1`,
      [organizationId, profile.quickbooks_customer_id],
    )
    if (!customer.rows[0]) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_CUSTOMER_INVALID',
        'The selected QuickBooks customer is no longer active',
        409,
      )
    }
  }

  const marker = `Toast ${draft.business_date} - ClawPilot POS accounting`
  const receiptTotal = amount(receiptLines.reduce((sum, line) => sum + line.amount, 0) + taxAmount)
  if (rawReceiptLines.length > 0 && receiptTotal <= 0) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_RECEIPT_TOTAL_INVALID',
      'The Sales Receipt total must be greater than zero',
      409,
    )
  }
  const salesReceipt: QuickBooksSalesReceiptDraft | null = rawReceiptLines.length > 0 ? {
    transactionDate: draft.business_date,
    customerId: profile.quickbooks_customer_id,
    customerName: profile.quickbooks_customer_name,
    depositToAccountId: profile.quickbooks_clearing_account_id,
    depositToAccountName: profile.quickbooks_clearing_account_name || 'Clearing account',
    taxCodeId: taxCode?.id || null,
    taxCodeName: taxCode?.name || null,
    taxAmount,
    memo: marker,
    lines: receiptLines,
    totalAmount: receiptTotal,
  } : null
  const journalEntry: QuickBooksJournalEntryDraft = {
    transactionDate: draft.business_date,
    memo: marker,
    lines: journalLines,
    debitAmount,
    creditAmount,
  }
  return { salesReceipt, journalEntry }
}

async function insertChildRequest(
  client: PoolClient,
  input: {
    organizationId: string
    connectionId: string
    draftId: string
    kind: 'sales-receipt' | 'journal-entry'
    operationKind: QuickBooksWriteOperationKind
    payload: QuickBooksWriteDraftPayload
    actorEmail: string
  },
) {
  const clientRequestId = deterministicUuid(`clawpilot:pos-accounting:${input.draftId}:${input.kind}`)
  const fingerprint = fingerprintQuickBooksWritePayload(input.payload)
  const result = await client.query<{ id: string; request_fingerprint: string; operation_kind: string }>(
    `INSERT INTO quickbooks_write_requests (
       organization_id, reviewed_maton_connection_id, operation_kind,
       client_request_id, provider_request_id, request_payload, request_fingerprint,
       requested_by, submitted_by, status, submitted_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2, $3, $4::uuid, 'cp-' || $4::text, $5::jsonb, $6,
       lower($7), lower($7), 'pending_approval', now(), now(), now()
     )
     ON CONFLICT (organization_id, client_request_id) DO UPDATE
       SET updated_at = quickbooks_write_requests.updated_at
     RETURNING id::text, request_fingerprint, operation_kind`,
    [
      input.organizationId,
      input.connectionId,
      input.operationKind,
      clientRequestId,
      JSON.stringify(input.payload),
      fingerprint,
      input.actorEmail,
    ],
  )
  const row = result.rows[0]
  if (!row || row.request_fingerprint !== fingerprint || row.operation_kind !== input.operationKind) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_IDEMPOTENCY_CONFLICT',
      'This immutable accounting draft was already prepared with different content',
      409,
    )
  }
  return { id: row.id, fingerprint }
}

export function fingerprintPosAccountingPostingPayloads(
  draftId: string,
  payloads: {
    salesReceipt: QuickBooksSalesReceiptDraft | null
    journalEntry: QuickBooksJournalEntryDraft
  },
) {
  return crypto.createHash('sha256').update(JSON.stringify({
    draftId,
    salesReceipt: payloads.salesReceipt
      ? fingerprintQuickBooksWritePayload(payloads.salesReceipt)
      : null,
    journalEntry: fingerprintQuickBooksWritePayload(payloads.journalEntry),
  })).digest('hex')
}

function assertPreparedBatchMatchesCurrentPayloads(
  draft: Pick<DraftRow, 'id'>,
  payloads: {
    salesReceipt: QuickBooksSalesReceiptDraft | null
    journalEntry: QuickBooksJournalEntryDraft
  },
  batch: Pick<PostingBatchRow, 'request_fingerprint'>,
) {
  const currentFingerprint = fingerprintPosAccountingPostingPayloads(draft.id, payloads)
  if (currentFingerprint !== batch.request_fingerprint) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_CONTENT_STALE',
      'The prepared posting no longer matches the current accounting content. Regenerate accounting and review the new revision before posting.',
      409,
    )
  }
  return currentFingerprint
}

export async function preparePosAccountingPostingBatchInPostgres(input: {
  organizationId: string
  draftId: string
  actorEmail: string
}) {
  const draftId = requiredUuid(input.draftId, 'Accounting draft')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `pos-accounting-posting:${input.organizationId}:${draftId}`)
    const draftResult = await client.query<DraftRow>(
      `SELECT id::text, restaurant_guid::text, business_date::text, status,
         reconciliation_status, source_summary, proposed_lines,
         posting_batch_id::text, is_current
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, draftId],
    )
    const draft = draftResult.rows[0]
    if (!draft || !draft.is_current) {
      throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_DRAFT_NOT_FOUND', 'The current accounting draft was not found', 404)
    }
    // The canonical blocker set is authoritative even when a child batch was
    // prepared earlier. Regeneration can discover a later Toast closeout hold;
    // never replay the prior prepared payload around that new gate.
    assertCanonicalDraftReadiness(draft)
    if (draft.posting_batch_id) {
      const existing = await readBatch(client, input.organizationId, draft.posting_batch_id)
      if (existing) {
        if (existing.status === 'posted') return batchFromRow(existing)
        const currentPayloads = await materializePostingPayloads(client, input.organizationId, draft)
        assertPreparedBatchMatchesCurrentPayloads(draft, currentPayloads, existing)
        return batchFromRow(existing)
      }
    }
    if (draft.status !== 'needs_review' && draft.status !== 'failed') {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_STATE_CONFLICT',
        'Only a review-ready or failed accounting draft can be prepared',
        409,
      )
    }
    const connectionResult = await client.query<{ maton_connection_id: string }>(
      `SELECT maton_connection_id FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND status = 'active' FOR SHARE`,
      [input.organizationId],
    )
    const connectionId = connectionResult.rows[0]?.maton_connection_id
    if (!connectionId) {
      throw new PosAccountingPostingError('QUICKBOOKS_NOT_CONNECTED', 'Connect QuickBooks before preparing this posting', 409)
    }
    const payloads = await materializePostingPayloads(client, input.organizationId, draft)
    const receipt = payloads.salesReceipt ? await insertChildRequest(client, {
        organizationId: input.organizationId,
        connectionId,
        draftId,
        kind: 'sales-receipt',
        operationKind: 'sales_receipt.create',
        payload: payloads.salesReceipt,
        actorEmail: input.actorEmail,
      }) : null
    const journal = await insertChildRequest(client, {
      organizationId: input.organizationId,
      connectionId,
      draftId,
      kind: 'journal-entry',
      operationKind: 'journal_entry.create',
      payload: payloads.journalEntry,
      actorEmail: input.actorEmail,
    })
    const requestFingerprint = fingerprintPosAccountingPostingPayloads(draftId, payloads)
    const batchResult = await client.query<{ id: string }>(
      `INSERT INTO pos_accounting_posting_batches (
         organization_id, draft_id, restaurant_guid, business_date,
         request_fingerprint, sales_receipt_request_id, journal_entry_request_id,
         requested_by, submitted_at, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::uuid, $7::uuid, lower($8), now(), now(), now())
       ON CONFLICT (draft_id) DO UPDATE SET updated_at = pos_accounting_posting_batches.updated_at
       RETURNING id::text`,
      [
        input.organizationId,
        draftId,
        draft.restaurant_guid,
        draft.business_date,
        requestFingerprint,
        receipt?.id || null,
        journal.id,
        input.actorEmail,
      ],
    )
    const batchId = batchResult.rows[0]?.id
    if (!batchId) throw new Error('POS accounting posting batch could not be prepared')
    await client.query(
      `UPDATE toast_accounting_export_drafts
       SET posting_batch_id = $3::uuid,
         quickbooks_payload = $4::jsonb, last_error = NULL, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, draftId, batchId, JSON.stringify(payloads)],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'pos.accounting.posting.prepared',
      aggregateType: 'pos_accounting_posting_batch',
      aggregateId: batchId,
      organizationId: input.organizationId,
      payload: {
        message: payloads.salesReceipt
          ? `Prepared Sales Receipt and Journal Entry for Toast ${draft.business_date}`
          : `Prepared Payment Exceptions Journal Entry for Toast ${draft.business_date}`,
        draftId,
        businessDate: draft.business_date,
        requestFingerprint,
        documentCount: payloads.salesReceipt ? 2 : 1,
      },
    }, client)
    const stored = await readBatch(client, input.organizationId, batchId)
    if (!stored) throw new Error('POS accounting posting batch could not be read')
    return batchFromRow(stored)
  })
}

export async function approvePosAccountingPostingBatchInPostgres(input: {
  organizationId: string
  batchId: string
  confirmFingerprint: string
  actorEmail: string
  approvalNote?: string | null
}) {
  const batchId = requiredUuid(input.batchId, 'Posting batch')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `pos-accounting-posting:${input.organizationId}:${batchId}`)
    const batch = await readBatch(client, input.organizationId, batchId)
    if (!batch) throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_BATCH_NOT_FOUND', 'The posting batch was not found', 404)
    if (batch.status === 'posted') return batchFromRow(batch)
    if (!['pending_approval', 'failed', 'partial_failed'].includes(batch.status)) {
      throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_STATE_CONFLICT', 'This posting batch cannot be approved in its current state', 409)
    }
    const draftResult = await client.query<DraftRow>(
      `SELECT id::text, restaurant_guid::text, business_date::text, status,
         reconciliation_status, source_summary, proposed_lines,
         posting_batch_id::text, is_current
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [input.organizationId, batch.draft_id],
    )
    const currentDraft = draftResult.rows[0]
    if (!currentDraft?.is_current) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_APPROVAL_STALE',
        'Regenerate and review the current accounting date before approving this posting',
        409,
      )
    }
    assertCanonicalDraftReadiness(currentDraft)
    const currentPayloads = await materializePostingPayloads(client, input.organizationId, currentDraft)
    assertPreparedBatchMatchesCurrentPayloads(currentDraft, currentPayloads, batch)
    if (input.confirmFingerprint !== batch.request_fingerprint) {
      throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_APPROVAL_STALE', 'Review the current two-document posting before approving it', 409)
    }
    const connectionResult = await client.query<{
      write_mode: 'disabled' | 'sandbox' | 'production'
      write_verified_at: string | null
    }>(
      `SELECT write_mode, write_verified_at::text
       FROM organization_quickbooks_connections
       WHERE organization_id = $1::uuid AND status = 'active' FOR SHARE`,
      [input.organizationId],
    )
    const connection = connectionResult.rows[0]
    const policy = configuredQuickBooksWritePolicy()
    const allowed = connection?.write_verified_at
      && policy.enabled
      && policy.mode === connection.write_mode
      && (!batch.sales_receipt_request_id || policy.allowedOperations.includes('sales_receipt.create'))
      && policy.allowedOperations.includes('journal_entry.create')
    if (!allowed) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_DISABLED',
        'QuickBooks posting must be verified and enabled for both Sales Receipts and Journal Entries',
        409,
      )
    }
    const requestIds = [batch.sales_receipt_request_id, batch.journal_entry_request_id].filter(Boolean) as string[]
    const children = await client.query<{ id: string; status: string }>(
      `UPDATE quickbooks_write_requests request SET
         status = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN 'approved' ELSE request.status END,
         approved_by = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN lower($3) ELSE request.approved_by END,
         approved_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN now() ELSE request.approved_at END,
         approval_note = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN $4 ELSE request.approval_note END,
         attempt_count = CASE WHEN request.status IN ('failed', 'dead') THEN 0 ELSE request.attempt_count END,
         available_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN now() ELSE request.available_at END,
         locked_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.locked_at END,
         locked_by = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.locked_by END,
         lock_token = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.lock_token END,
         last_error_code = CASE WHEN request.status IN ('failed', 'dead') THEN NULL ELSE request.last_error_code END,
         last_error_message = CASE WHEN request.status IN ('failed', 'dead') THEN NULL ELSE request.last_error_message END,
         updated_at = now()
       WHERE request.organization_id = $1::uuid
         AND request.id = ANY($2::uuid[])
         AND request.status <> 'cancelled'
       RETURNING request.id::text, request.status`,
      [
        input.organizationId,
        requestIds,
        input.actorEmail,
        input.approvalNote || null,
      ],
    )
    if (children.rows.length !== requestIds.length) {
      throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_CHILD_CONFLICT', 'One of the two accounting documents was cancelled or removed', 409)
    }
    const childStatuses = new Set(children.rows.map((row) => row.status))
    const nextStatus = childStatuses.has('succeeded') ? 'posting' : 'approved'
    await client.query(
      `UPDATE pos_accounting_posting_batches SET
         status = $3, approved_by = lower($4), approval_note = $5,
         approved_at = now(), last_error = NULL, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, batchId, nextStatus, input.actorEmail, input.approvalNote || null],
    )
    await client.query(
      `UPDATE toast_accounting_export_drafts SET
         status = $3, review_outcome = 'clawpilot_post', posting_origin = 'clawpilot',
         reviewed_by = lower($4), reviewed_at = now(), review_note = $5,
         approved_by = lower($4), approved_at = now(), last_error = NULL, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, batch.draft_id, nextStatus, input.actorEmail, input.approvalNote || null],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: batch.status === 'pending_approval'
        ? 'pos.accounting.posting.approved'
        : 'pos.accounting.posting.retry_approved',
      aggregateType: 'pos_accounting_posting_batch',
      aggregateId: batchId,
      organizationId: input.organizationId,
      payload: {
        message: `Approved two-document QuickBooks posting for Toast ${batch.business_date}`,
        draftId: batch.draft_id,
        businessDate: batch.business_date,
        requestFingerprint: batch.request_fingerprint,
        previousStatus: batch.status,
        requestStatus: nextStatus,
        documentCount: requestIds.length,
      },
    }, client)
    const stored = await readBatch(client, input.organizationId, batchId)
    if (!stored) throw new Error('POS accounting posting batch could not be read')
    return batchFromRow(stored)
  })
}

async function cancelPreparedPostingBatchForExternalEvidence(
  client: PoolClient,
  input: {
    organizationId: string
    postingBatchId: string | null
    actorEmail: string
  },
) {
  if (!input.postingBatchId) return null
  const batch = await readBatch(client, input.organizationId, input.postingBatchId)
  if (!batch) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_BATCH_NOT_FOUND',
      'The prepared ClawPilot posting batch could not be verified',
      409,
    )
  }
  if (batch.status === 'cancelled') return batch.id
  if (batch.status !== 'pending_approval') {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_EXTERNAL_POSTING_CONFLICT',
      'ClawPilot already started this posting. Resolve that posting batch before recording external evidence.',
      409,
    )
  }
  const requestIds = [batch.sales_receipt_request_id, batch.journal_entry_request_id].filter(Boolean) as string[]
  const children = await client.query<{ id: string }>(
    `UPDATE quickbooks_write_requests request SET
       status = 'cancelled', cancelled_by = lower($3),
       cancelled_at = COALESCE(request.cancelled_at, now()), updated_at = now()
     WHERE request.organization_id = $1::uuid
       AND request.id = ANY($2::uuid[])
       AND request.status IN ('draft', 'pending_approval', 'cancelled')
     RETURNING request.id::text`,
    [
      input.organizationId,
      requestIds,
      input.actorEmail,
    ],
  )
  if (children.rows.length !== requestIds.length) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_EXTERNAL_POSTING_CONFLICT',
      'One of the prepared ClawPilot documents is no longer safe to cancel',
      409,
    )
  }
  await client.query(
    `UPDATE pos_accounting_posting_batches SET
       status = 'cancelled', cancelled_by = lower($3), cancelled_at = now(),
       last_error = NULL, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, batch.id, input.actorEmail],
  )
  return batch.id
}

export async function recordExternalPostingInPostgres(input: {
  organizationId: string
  draftId: string
  salesReceiptId?: string | null
  journalEntryId: string
  providerName: string
  providerReference?: string | null
  reviewNote?: string | null
  actorEmail: string
}) {
  const draftId = requiredUuid(input.draftId, 'Accounting draft')
  const salesReceiptId = optionalProviderId(input.salesReceiptId, 'QuickBooks Sales Receipt ID')
  const journalEntryId = requiredProviderId(input.journalEntryId, 'QuickBooks Journal Entry ID')
  const providerName = requiredExternalProvider(input.providerName)
  const providerReference = optionalExternalReference(input.providerReference)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `pos-accounting-posting:${input.organizationId}:${draftId}`)
    const draftResult = await client.query<ExternalPostingDraftRow>(
      `SELECT draft.id::text, draft.restaurant_guid::text, draft.business_date::text,
         draft.status, draft.reconciliation_status, draft.source_summary,
         draft.proposed_lines, draft.posting_batch_id::text, draft.is_current,
         draft.review_outcome, draft.posting_origin, draft.reviewed_by,
         draft.reviewed_at::text, draft.review_note,
         draft.external_posting_provider, draft.external_posting_reference,
         draft.quickbooks_sales_receipt_id, draft.quickbooks_journal_entry_id,
         draft.draft_revision, draft.source_revision, draft.updated_at::text,
         location.restaurant_name, location.location_name
       FROM toast_accounting_export_drafts draft
       LEFT JOIN toast_locations location
         ON location.organization_id = draft.organization_id
        AND location.restaurant_guid = draft.restaurant_guid
       WHERE draft.organization_id = $1::uuid AND draft.id = $2::uuid
       FOR UPDATE OF draft`,
      [input.organizationId, draftId],
    )
    const draft = draftResult.rows[0]
    if (!draft || !draft.is_current) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_DRAFT_NOT_FOUND',
        'The current accounting draft was not found',
        404,
      )
    }
    const journalOnlyPaymentException = isJournalOnlyPaymentExceptionDraft(draft)
    if (!journalOnlyPaymentException && !salesReceiptId) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_EVIDENCE_ID_INVALID',
        'QuickBooks Sales Receipt ID is required for a sales-bearing accounting date',
      )
    }
    const alreadyExternal = draft.review_outcome === 'externally_posted'
      || draft.review_outcome === 'shogo_posted'
    if (alreadyExternal) {
      const sameProvider = draft.review_outcome === 'shogo_posted'
        ? providerName.toLowerCase() === 'shogo'
        : draft.external_posting_provider?.toLowerCase() === providerName.toLowerCase()
      if (sameProvider
        && draft.quickbooks_sales_receipt_id === salesReceiptId
        && draft.quickbooks_journal_entry_id === journalEntryId) {
        return {
          recorded: false,
          alreadyRecorded: true,
          draftId,
          businessDate: draft.business_date,
          providerName: draft.external_posting_provider || 'Shogo',
          salesReceiptId,
          journalEntryId,
        }
      }
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_POSTING_CONFLICT',
        'This draft already has different external posting evidence',
        409,
      )
    }
    if (!['needs_review', 'failed'].includes(draft.status)) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_STATE_CONFLICT',
        'Only a review-ready or failed accounting draft can be acknowledged as externally posted',
        409,
      )
    }
    if (!EXTERNAL_POSTING_RECONCILIATION_STATUSES.has(draft.reconciliation_status)) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_EVIDENCE_INCOMPLETE',
        'External posting acknowledgment requires complete order evidence without a source variance',
        409,
      )
    }
    const transactionResult = await client.query<Record<string, unknown>>(
      `SELECT transaction.*,
         to_char(transaction.transaction_date, 'YYYY-MM-DD') AS pos_accounting_business_date,
         'external'::text AS pos_accounting_origin
       FROM quickbooks_transactions transaction
       WHERE transaction.organization_id = $1::uuid
         AND transaction.quickbooks_transaction_id = ANY($2::text[])
         AND transaction.entity_type IN ('SalesReceipt', 'JournalEntry')
       FOR SHARE OF transaction`,
      [input.organizationId, [salesReceiptId, journalEntryId].filter(Boolean)],
    )
    const receipt = salesReceiptId ? transactionResult.rows.find((row) =>
      row.entity_type === 'SalesReceipt' && row.quickbooks_transaction_id === salesReceiptId)
      : null
    const journal = transactionResult.rows.find((row) =>
      row.entity_type === 'JournalEntry' && row.quickbooks_transaction_id === journalEntryId)
    if ((!journalOnlyPaymentException && !receipt) || !journal) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_EVIDENCE_NOT_FOUND',
        journalOnlyPaymentException
          ? 'The exact QuickBooks Journal Entry must be present in the current QuickBooks cache'
          : 'Both exact QuickBooks records must be present in the current QuickBooks cache',
        409,
      )
    }
    if ((receipt && String(receipt.pos_accounting_business_date) !== draft.business_date)
      || String(journal.pos_accounting_business_date) !== draft.business_date) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_EVIDENCE_DATE_MISMATCH',
        'Every QuickBooks record must use the draft business date',
        409,
      )
    }
    const parity = buildPosAccountingParityReport({
      drafts: [draft],
      transactions: [receipt, journal].filter(Boolean),
      fullHistoryTransactions: [receipt, journal].filter(Boolean),
    })
    const rows = parity.rows.filter((row) => row.expected.draft.id === draftId)
    const receiptRow = rows.find((row) => row.expected.entityType === 'SalesReceipt')
    const journalRow = rows.find((row) => row.expected.entityType === 'JournalEntry')
    const exactMatch = rows.length === (journalOnlyPaymentException ? 1 : 2)
      && (journalOnlyPaymentException || receiptRow?.match.status === 'matched')
      && journalRow?.match.status === 'matched'
      && (journalOnlyPaymentException || receiptRow?.comparison?.status === 'match')
      && journalRow.comparison?.status === 'match'
      && (journalOnlyPaymentException || receiptRow?.actual?.providerTransactionId === salesReceiptId)
      && journalRow.actual?.providerTransactionId === journalEntryId
    if (!exactMatch) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_EXTERNAL_EVIDENCE_MISMATCH',
        'The selected QuickBooks records do not exactly match the ClawPilot posting documents',
        409,
      )
    }
    const cancelledBatchId = await cancelPreparedPostingBatchForExternalEvidence(client, {
      organizationId: input.organizationId,
      postingBatchId: draft.posting_batch_id,
      actorEmail: input.actorEmail,
    })
    const reviewNote = input.reviewNote
      || `Matched to ${providerName}-posted QuickBooks evidence`
    await client.query(
      `UPDATE toast_accounting_export_drafts SET
         status = 'posted', review_outcome = 'externally_posted', posting_origin = 'external',
         external_posting_provider = $4, external_posting_reference = $5,
         reviewed_by = lower($3), reviewed_at = now(), review_note = $6,
         quickbooks_sales_receipt_id = $7,
         quickbooks_journal_entry_id = $8,
         quickbooks_transaction_id = COALESCE($7, $8),
         approved_by = lower($3), approved_at = now(), posted_at = now(),
         last_error = NULL, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [
        input.organizationId,
        draftId,
        input.actorEmail,
        providerName,
        providerReference,
        reviewNote,
        salesReceiptId,
        journalEntryId,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'pos.accounting.external_posting.recorded',
      aggregateType: 'toast_accounting_export_draft',
      aggregateId: draftId,
      organizationId: input.organizationId,
      payload: {
        message: `Recorded ${providerName} posting evidence for POS ${draft.business_date}`,
        businessDate: draft.business_date,
        providerName,
        providerReference,
        salesReceiptId,
        journalEntryId,
        cancelledClawPilotBatchId: cancelledBatchId,
        postingOrigin: 'external',
        sourceReconciliationStatus: draft.reconciliation_status,
      },
    }, client)
    return {
      recorded: true,
      alreadyRecorded: false,
      draftId,
      businessDate: draft.business_date,
      providerName,
      salesReceiptId,
      journalEntryId,
      sourceReconciliationStatus: draft.reconciliation_status,
    }
  })
}

export async function recordMatchedExternalResultsInPostgres(input: {
  organizationId: string
  fromBusinessDate: string
  toBusinessDate: string
  providerName: string
  providerReference?: string | null
  reviewNote?: string | null
  actorEmail: string
}) {
  const fromBusinessDate = requiredDate(input.fromBusinessDate, 'From date')
  const toBusinessDate = requiredDate(input.toBusinessDate, 'To date')
  const providerName = requiredExternalProvider(input.providerName)
  const providerReference = optionalExternalReference(input.providerReference)
  if (fromBusinessDate > toBusinessDate) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_RANGE_INVALID', 'From date must be on or before to date')
  }
  const report = await readPosAccountingParityReportInPostgres({
    organizationId: input.organizationId,
    fromBusinessDate,
    toBusinessDate,
    page: 1,
    pageSize: 366,
    historyPage: 1,
    historyPageSize: 20,
  })
  if (report.pagination.totalPages > 1) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_RANGE_TOO_LARGE',
      'Review at most 366 business dates at a time',
      400,
    )
  }
  const grouped = new Map<string, typeof report.rows>()
  for (const row of report.rows) {
    const rows = grouped.get(row.expected.draft.id) || []
    rows.push(row)
    grouped.set(row.expected.draft.id, rows)
  }
  const candidates = [...grouped.entries()].flatMap(([draftId, rows]) => {
    const receipt = rows.find((row) => row.expected.entityType === 'SalesReceipt')
    const journal = rows.find((row) => row.expected.entityType === 'JournalEntry')
    const journalOnlyPaymentException = rows.length === 1 && !receipt && Boolean(journal)
    const accepted = rows.length === (journalOnlyPaymentException ? 1 : 2)
      && EXTERNAL_POSTING_RECONCILIATION_STATUSES.has(
        (journal || receipt)?.expected.draft.reconciliationStatus || '',
      )
      && (journalOnlyPaymentException || receipt?.match.status === 'matched')
      && journal?.match.status === 'matched'
      && (journalOnlyPaymentException || receipt?.comparison?.status === 'match')
      && journal.comparison?.status === 'match'
      && (journalOnlyPaymentException || Boolean(receipt?.actual))
      && Boolean(journal.actual)
      && (journalOnlyPaymentException || receipt?.actual?.postingOrigin !== 'clawpilot')
      && journal.actual?.postingOrigin !== 'clawpilot'
      && (journalOnlyPaymentException || Boolean(receipt?.actual?.providerTransactionId))
      && Boolean(journal.actual?.providerTransactionId)
    return accepted ? [{
      draftId,
      businessDate: (journal || receipt)!.expected.businessDate,
      receiptId: receipt?.actual?.providerTransactionId || null,
      journalId: journal!.actual!.providerTransactionId!,
    }] : []
  })
  let recorded = 0
  let alreadyRecorded = 0
  const recordedDates: string[] = []
  const failures: Array<{
    draftId: string
    businessDate: string
    code: string
    message: string
  }> = []
  for (const candidate of candidates) {
    try {
      const outcome = await recordExternalPostingInPostgres({
        organizationId: input.organizationId,
        draftId: candidate.draftId,
        salesReceiptId: candidate.receiptId,
        journalEntryId: candidate.journalId,
        providerName,
        providerReference,
        reviewNote: input.reviewNote,
        actorEmail: input.actorEmail,
      })
      if (outcome.recorded) {
        recorded += 1
        recordedDates.push(candidate.businessDate)
      } else if (outcome.alreadyRecorded) {
        alreadyRecorded += 1
      }
    } catch (error) {
      if (!(error instanceof PosAccountingPostingError)) throw error
      failures.push({
        draftId: candidate.draftId,
        businessDate: candidate.businessDate,
        code: error.code,
        message: error.message,
      })
    }
  }
  return {
    recorded,
    alreadyRecorded,
    recordedDates,
    eligible: candidates.length,
    unresolved: Math.max(0, grouped.size - recorded - alreadyRecorded),
    failedValidation: failures.length,
    failures,
    fromBusinessDate,
    toBusinessDate,
    providerName,
  }
}

// Backward-compatible entrypoint for older callers while the UI moves to provider-neutral outcomes.
export async function recordMatchedShogoResultsInPostgres(input: {
  organizationId: string
  fromBusinessDate: string
  toBusinessDate: string
  actorEmail: string
}) {
  return recordMatchedExternalResultsInPostgres({
    ...input,
    providerName: 'Shogo',
  })
}

export async function synchronizePosAccountingPostingBatchForRequest(
  client: PoolClient,
  input: {
    organizationId: string
    requestId: string
    providerEntityId?: string | null
  },
) {
  const batchResult = await client.query<PostingBatchRow>(
    `SELECT ${BATCH_SELECT}
     FROM pos_accounting_posting_batches batch
     LEFT JOIN quickbooks_write_requests receipt ON receipt.id = batch.sales_receipt_request_id
     JOIN quickbooks_write_requests journal ON journal.id = batch.journal_entry_request_id
     WHERE batch.organization_id = $1::uuid
       AND (
         batch.sales_receipt_request_id = $2::uuid
         OR batch.journal_entry_request_id = $2::uuid
       )
     FOR UPDATE OF batch, journal`,
    [input.organizationId, input.requestId],
  )
  const batch = batchResult.rows[0]
  if (!batch) return null
  const receiptSucceeded = !batch.sales_receipt_request_id || batch.sales_receipt_status === 'succeeded'
  const journalSucceeded = batch.journal_entry_status === 'succeeded'
  const receiptFailed = Boolean(batch.sales_receipt_request_id)
    && ['failed', 'dead'].includes(batch.sales_receipt_status || '')
  const journalFailed = ['failed', 'dead'].includes(batch.journal_entry_status)
  const bothSucceeded = receiptSucceeded && journalSucceeded
  const anySucceeded = (Boolean(batch.sales_receipt_request_id) && receiptSucceeded) || journalSucceeded
  const anyFailed = receiptFailed || journalFailed
  const nextStatus: PostingBatchStatus = bothSucceeded
    ? 'posted'
    : anySucceeded && anyFailed
      ? 'partial_failed'
      : anyFailed
        ? 'failed'
        : 'posting'
  const lastError = [batch.sales_receipt_error, batch.journal_entry_error].filter(Boolean).join(' | ') || null
  await client.query(
    `UPDATE pos_accounting_posting_batches SET
       status = $3, last_error = $4,
       posted_at = CASE WHEN $3 = 'posted' THEN now() ELSE posted_at END,
       updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [input.organizationId, batch.id, nextStatus, lastError],
  )
  await client.query(
    `UPDATE toast_accounting_export_drafts SET
       status = CASE WHEN $3 = 'posted' THEN 'posted' WHEN $3 IN ('failed', 'partial_failed') THEN 'failed' ELSE 'posting' END,
       quickbooks_sales_receipt_id = $4,
       quickbooks_journal_entry_id = $5,
       quickbooks_transaction_id = CASE WHEN $3 = 'posted' THEN COALESCE($4, $5) ELSE quickbooks_transaction_id END,
       posted_at = CASE WHEN $3 = 'posted' THEN now() ELSE posted_at END,
       last_error = $6, updated_at = now()
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [
      input.organizationId,
      batch.draft_id,
      nextStatus,
      batch.sales_receipt_provider_entity_id,
      batch.journal_entry_provider_entity_id,
      lastError,
    ],
  )
  return { batchId: batch.id, draftId: batch.draft_id, status: nextStatus }
}
