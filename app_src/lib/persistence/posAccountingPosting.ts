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
import { readPosAccountingParityReportInPostgres } from '@/lib/persistence/posAccountingParity'
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

type PostingBatchRow = {
  id: string
  draft_id: string
  restaurant_guid: string
  business_date: string
  status: PostingBatchStatus
  request_fingerprint: string
  sales_receipt_request_id: string
  sales_receipt_status: string
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
      status: row.sales_receipt_status,
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
     JOIN quickbooks_write_requests receipt ON receipt.id = batch.sales_receipt_request_id
     JOIN quickbooks_write_requests journal ON journal.id = batch.journal_entry_request_id
     WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
     FOR UPDATE OF batch, receipt, journal`,
    [organizationId, batchId],
  )
  return result.rows[0] || null
}

async function materializePostingPayloads(
  client: PoolClient,
  organizationId: string,
  draft: DraftRow,
) {
  const sourceSummary = record(draft.source_summary)
  const canonical = record(sourceSummary.canonical)
  const readiness = record(canonical.readiness)
  if (readiness.mappingsComplete !== true || readiness.allocationComplete !== true
    || records(readiness.missingMappings).length > 0) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_NOT_READY',
      'Complete every POS accounting mapping and allocation before preparing this date',
      409,
    )
  }
  if (draft.reconciliation_status !== 'ready') {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_SOURCE_VARIANCE',
      'Resolve the Toast source reconciliation variance before preparing this date',
      409,
    )
  }
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
  if (!rawReceiptLines.length || !rawJournalLines.length) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_DOCUMENTS_INCOMPLETE',
      'The accounting draft must contain both a Sales Receipt and a Journal Entry',
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
  const taxAmount = amount(record(sourceSummary.standard).tax)
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

  if (profile.quickbooks_customer_id) {
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
  if (receiptTotal <= 0) {
    throw new PosAccountingPostingError(
      'POS_ACCOUNTING_POSTING_RECEIPT_TOTAL_INVALID',
      'The Sales Receipt total must be greater than zero',
      409,
    )
  }
  const salesReceipt: QuickBooksSalesReceiptDraft = {
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
  }
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
    if (draft.posting_batch_id) {
      const existing = await readBatch(client, input.organizationId, draft.posting_batch_id)
      if (existing) return batchFromRow(existing)
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
    const receipt = await insertChildRequest(client, {
      organizationId: input.organizationId,
      connectionId,
      draftId,
      kind: 'sales-receipt',
      operationKind: 'sales_receipt.create',
      payload: payloads.salesReceipt,
      actorEmail: input.actorEmail,
    })
    const journal = await insertChildRequest(client, {
      organizationId: input.organizationId,
      connectionId,
      draftId,
      kind: 'journal-entry',
      operationKind: 'journal_entry.create',
      payload: payloads.journalEntry,
      actorEmail: input.actorEmail,
    })
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      draftId,
      salesReceipt: receipt.fingerprint,
      journalEntry: journal.fingerprint,
    })).digest('hex')
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
        receipt.id,
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
        message: `Prepared Sales Receipt and Journal Entry for Toast ${draft.business_date}`,
        draftId,
        businessDate: draft.business_date,
        requestFingerprint,
        documentCount: 2,
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
      && policy.allowedOperations.includes('sales_receipt.create')
      && policy.allowedOperations.includes('journal_entry.create')
    if (!allowed) {
      throw new PosAccountingPostingError(
        'POS_ACCOUNTING_POSTING_DISABLED',
        'QuickBooks posting must be verified and enabled for both Sales Receipts and Journal Entries',
        409,
      )
    }
    const children = await client.query<{ id: string; status: string }>(
      `UPDATE quickbooks_write_requests request SET
         status = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN 'approved' ELSE request.status END,
         approved_by = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN lower($4) ELSE request.approved_by END,
         approved_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN now() ELSE request.approved_at END,
         approval_note = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN $5 ELSE request.approval_note END,
         attempt_count = CASE WHEN request.status IN ('failed', 'dead') THEN 0 ELSE request.attempt_count END,
         available_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN now() ELSE request.available_at END,
         locked_at = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.locked_at END,
         locked_by = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.locked_by END,
         lock_token = CASE WHEN request.status IN ('pending_approval', 'failed', 'dead') THEN NULL ELSE request.lock_token END,
         last_error_code = CASE WHEN request.status IN ('failed', 'dead') THEN NULL ELSE request.last_error_code END,
         last_error_message = CASE WHEN request.status IN ('failed', 'dead') THEN NULL ELSE request.last_error_message END,
         updated_at = now()
       WHERE request.organization_id = $1::uuid
         AND request.id IN ($2::uuid, $3::uuid)
         AND request.status <> 'cancelled'
       RETURNING request.id::text, request.status`,
      [
        input.organizationId,
        batch.sales_receipt_request_id,
        batch.journal_entry_request_id,
        input.actorEmail,
        input.approvalNote || null,
      ],
    )
    if (children.rows.length !== 2) {
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
        documentCount: 2,
      },
    }, client)
    const stored = await readBatch(client, input.organizationId, batchId)
    if (!stored) throw new Error('POS accounting posting batch could not be read')
    return batchFromRow(stored)
  })
}

function toastDateMarker(transaction: { businessDate: string; memo: string | null; sourcePayload: unknown }) {
  const payload = record(transaction.sourcePayload)
  const values = [
    transaction.memo,
    text(payload.PrivateNote),
    text(record(payload.CustomerMemo).value),
    text(payload.Memo),
  ].filter(Boolean) as string[]
  return values.some((value) => value.trim().toLowerCase().startsWith(`toast ${transaction.businessDate}`))
}

export async function recordMatchedShogoResultsInPostgres(input: {
  organizationId: string
  fromBusinessDate: string
  toBusinessDate: string
  actorEmail: string
}) {
  const fromBusinessDate = requiredDate(input.fromBusinessDate, 'From date')
  const toBusinessDate = requiredDate(input.toBusinessDate, 'To date')
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
    const accepted = rows.length === 2
      && receipt?.match.status === 'matched'
      && journal?.match.status === 'matched'
      && receipt.comparison?.status === 'match'
      && journal.comparison?.status === 'match'
      && receipt.actual?.postingOrigin === 'shogo'
      && journal.actual?.postingOrigin === 'shogo'
      && Boolean(receipt.actual.providerTransactionId)
      && Boolean(journal.actual.providerTransactionId)
    return accepted ? [{
      draftId,
      businessDate: receipt!.expected.businessDate,
      receiptId: receipt!.actual!.providerTransactionId!,
      journalId: journal!.actual!.providerTransactionId!,
    }] : []
  })
  const result = await withTransaction(async (client) => {
    let recorded = 0
    let alreadyRecorded = 0
    const recordedDates: string[] = []
    for (const candidate of candidates) {
      await acquireTransactionAdvisoryLock(client, `pos-accounting-posting:${input.organizationId}:${candidate.draftId}`)
      const evidence = await client.query<{
        entity_type: string
        quickbooks_transaction_id: string
        transaction_date: string
        memo: string | null
        source_payload: unknown
      }>(
        `SELECT entity_type, quickbooks_transaction_id, transaction_date::text, memo, source_payload
         FROM quickbooks_transactions
         WHERE organization_id = $1::uuid
           AND quickbooks_transaction_id = ANY($2::text[])
           AND entity_type IN ('SalesReceipt', 'JournalEntry')
         FOR SHARE`,
        [input.organizationId, [candidate.receiptId, candidate.journalId]],
      )
      const validEvidence = evidence.rows.length === 2
        && evidence.rows.every((row) => row.transaction_date === candidate.businessDate && toastDateMarker({
          businessDate: candidate.businessDate,
          memo: row.memo,
          sourcePayload: row.source_payload,
        }))
      if (!validEvidence) continue
      const draft = await client.query<{
        status: string
        review_outcome: string | null
        quickbooks_sales_receipt_id: string | null
        quickbooks_journal_entry_id: string | null
      }>(
        `SELECT status, review_outcome, quickbooks_sales_receipt_id, quickbooks_journal_entry_id
         FROM toast_accounting_export_drafts
         WHERE organization_id = $1::uuid AND id = $2::uuid AND is_current = true
         FOR UPDATE`,
        [input.organizationId, candidate.draftId],
      )
      const current = draft.rows[0]
      if (!current) continue
      if (current.review_outcome === 'shogo_posted'
        && current.quickbooks_sales_receipt_id === candidate.receiptId
        && current.quickbooks_journal_entry_id === candidate.journalId) {
        alreadyRecorded += 1
        continue
      }
      if (!['needs_review', 'failed'].includes(current.status)) continue
      await client.query(
        `UPDATE toast_accounting_export_drafts SET
           status = 'posted', review_outcome = 'shogo_posted', posting_origin = 'shogo',
           reviewed_by = lower($3), reviewed_at = now(),
           review_note = 'Matched to Shogo-posted QuickBooks evidence',
           quickbooks_sales_receipt_id = $4,
           quickbooks_journal_entry_id = $5,
           quickbooks_transaction_id = $4,
           approved_by = lower($3), approved_at = now(), posted_at = now(),
           last_error = NULL, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [input.organizationId, candidate.draftId, input.actorEmail, candidate.receiptId, candidate.journalId],
      )
      await recordAuditEvent({
        actor: input.actorEmail,
        eventType: 'pos.accounting.shogo_result.recorded',
        aggregateType: 'toast_accounting_export_draft',
        aggregateId: candidate.draftId,
        organizationId: input.organizationId,
        payload: {
          message: `Recorded matched Shogo posting for Toast ${candidate.businessDate}`,
          businessDate: candidate.businessDate,
          salesReceiptId: candidate.receiptId,
          journalEntryId: candidate.journalId,
          postingOrigin: 'shogo',
        },
      }, client)
      recorded += 1
      recordedDates.push(candidate.businessDate)
    }
    return { recorded, alreadyRecorded, recordedDates }
  })
  return {
    ...result,
    eligible: candidates.length,
    unresolved: Math.max(0, grouped.size - candidates.length),
    fromBusinessDate,
    toBusinessDate,
  }
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
     JOIN quickbooks_write_requests receipt ON receipt.id = batch.sales_receipt_request_id
     JOIN quickbooks_write_requests journal ON journal.id = batch.journal_entry_request_id
     WHERE batch.organization_id = $1::uuid
       AND $2::uuid IN (batch.sales_receipt_request_id, batch.journal_entry_request_id)
     FOR UPDATE OF batch, receipt, journal`,
    [input.organizationId, input.requestId],
  )
  const batch = batchResult.rows[0]
  if (!batch) return null
  const receiptSucceeded = batch.sales_receipt_status === 'succeeded'
  const journalSucceeded = batch.journal_entry_status === 'succeeded'
  const receiptFailed = ['failed', 'dead'].includes(batch.sales_receipt_status)
  const journalFailed = ['failed', 'dead'].includes(batch.journal_entry_status)
  const bothSucceeded = receiptSucceeded && journalSucceeded
  const anySucceeded = receiptSucceeded || journalSucceeded
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
       quickbooks_transaction_id = CASE WHEN $3 = 'posted' THEN $4 ELSE quickbooks_transaction_id END,
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
