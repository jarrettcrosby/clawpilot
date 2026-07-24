import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  QUICKBOOKS_EXPLORER_RANGES,
  QUICKBOOKS_EXPLORER_VIEWS,
  QUICKBOOKS_FINANCIAL_REPORT_KEYS,
  QUICKBOOKS_FINANCIAL_REPORT_PERIODS,
  readQuickBooksExplorerListInPostgres,
  readQuickBooksExplorerOverviewInPostgres,
  readQuickBooksFinancialReportInPostgres,
  readQuickBooksInvoiceDetailInPostgres,
  readQuickBooksTransactionAttachmentsInPostgres,
  type QuickBooksExplorerRange,
  type QuickBooksExplorerView,
  type QuickBooksFinancialReportKey,
  type QuickBooksFinancialReportPeriod,
} from '@/lib/persistence/quickBooksExplorer'
import { requireRequestUser } from '@/lib/requestUser'
import { accountingCapabilities, activeAccountingOrganizationId } from '@/lib/accountingAuthorization'
import {
  readPosAccountingParityEvidenceDetailInPostgres,
  readPosAccountingParityReportInPostgres,
  type PosAccountingParityEntityType,
} from '@/lib/persistence/posAccountingParity'
import { refreshQuickBooksPosEvidenceInPostgres } from '@/lib/persistence/quickBooksIntegrations'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const TRANSACTION_ENTITY_TYPES = new Set([
  'Invoice', 'Payment', 'SalesReceipt', 'Purchase', 'Bill', 'BillPayment', 'CreditMemo', 'RefundReceipt',
  'JournalEntry',
])
const MAX_REQUEST_BYTES = 16 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function numberParam(value: string | null, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function businessDateParam(value: string | null) {
  const candidate = String(value || '').trim()
  if (!candidate) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined
  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : undefined
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!isPostgresStorageEnabled()) {
      return json({ ok: false, error: 'Accounting requires Postgres storage', code: 'ACCOUNTING_POSTGRES_REQUIRED' }, 503)
    }
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canApprove) {
      return json({
        ok: false,
        error: 'Approval access is required to refresh posting evidence',
        code: 'ACCOUNTING_APPROVAL_REQUIRED',
      }, 403)
    }
    if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return json({
        ok: false,
        error: 'QuickBooks evidence refresh requests require JSON',
        code: 'ACCOUNTING_CONTENT_TYPE_INVALID',
      }, 415)
    }
    const declaredLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return json({ ok: false, error: 'Accounting request is too large', code: 'ACCOUNTING_REQUEST_TOO_LARGE' }, 413)
    }
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
      return json({ ok: false, error: 'Accounting request is too large', code: 'ACCOUNTING_REQUEST_TOO_LARGE' }, 413)
    }
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      body = parsed as Record<string, unknown>
    } catch {
      return json({ ok: false, error: 'Accounting request must be valid JSON', code: 'ACCOUNTING_REQUEST_INVALID' }, 400)
    }
    if (body.action !== 'refresh-pos-evidence') {
      return json({ ok: false, error: 'Unsupported accounting action', code: 'ACCOUNTING_ACTION_INVALID' }, 400)
    }
    const unsupported = Object.keys(body).find((key) => !['action', 'fromBusinessDate', 'toBusinessDate'].includes(key))
    if (unsupported) {
      return json({ ok: false, error: `Unsupported accounting action field: ${unsupported}`, code: 'ACCOUNTING_ACTION_FIELD_INVALID' }, 400)
    }
    const fromBusinessDate = businessDateParam(String(body.fromBusinessDate || ''))
    const toBusinessDate = businessDateParam(String(body.toBusinessDate || ''))
    if (!fromBusinessDate || !toBusinessDate || fromBusinessDate > toBusinessDate) {
      return json({ ok: false, error: 'A valid QuickBooks evidence date range is required', code: 'ACCOUNTING_PARITY_DATE_INVALID' }, 400)
    }
    const fromTime = new Date(`${fromBusinessDate}T00:00:00.000Z`).getTime()
    const toTime = new Date(`${toBusinessDate}T00:00:00.000Z`).getTime()
    if ((toTime - fromTime) / 86_400_000 > 31) {
      return json({
        ok: false,
        error: 'QuickBooks evidence refresh supports at most 32 business dates',
        code: 'ACCOUNTING_PARITY_DATE_RANGE_TOO_LARGE',
      }, 400)
    }
    const refreshed = await refreshQuickBooksPosEvidenceInPostgres({
      organizationId: activeAccountingOrganizationId(actor),
      fromBusinessDate,
      toBusinessDate,
      actorEmail: actor.email,
    })
    return json({ ok: true, capabilities, refreshed })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
    }
    if (error instanceof Error && error.message === 'The active organization QuickBooks connection is unavailable') {
      return json({
        ok: false,
        error: 'Connect the active organization to QuickBooks before refreshing posting evidence',
        code: 'QUICKBOOKS_CONNECTION_UNAVAILABLE',
      }, 409)
    }
    if (error instanceof Error && error.message === 'QuickBooks connection changed before POS evidence refresh completion') {
      return json({
        ok: false,
        error: 'The QuickBooks connection changed during refresh; retry against the active company',
        code: 'QUICKBOOKS_CONNECTION_CHANGED',
      }, 409)
    }
    return json({
      ok: false,
      error: 'QuickBooks posting evidence could not be refreshed',
      code: 'ACCOUNTING_POS_EVIDENCE_REFRESH_FAILED',
    }, 502)
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!isPostgresStorageEnabled()) {
      return json({ ok: false, error: 'Accounting requires Postgres storage', code: 'ACCOUNTING_POSTGRES_REQUIRED' }, 503)
    }
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to accounting data',
        code: 'ACCOUNTING_VIEW_REQUIRED',
      }, 403)
    }
    const organization = activeAccountingOrganizationId(actor)
    const rangeValue = String(req.nextUrl.searchParams.get('range') || 'ytd') as QuickBooksExplorerRange
    const range = QUICKBOOKS_EXPLORER_RANGES.includes(rangeValue) ? rangeValue : 'ytd'
    const viewValue = req.nextUrl.searchParams.get('view')
    if (!viewValue || viewValue === 'overview') {
      return json({
        ok: true,
        capabilities,
        overview: await readQuickBooksExplorerOverviewInPostgres({ organizationId: organization, range }),
      })
    }
    if (viewValue === 'reports') {
      const reportValue = String(req.nextUrl.searchParams.get('report') || 'profit_loss') as QuickBooksFinancialReportKey
      const reportKey = QUICKBOOKS_FINANCIAL_REPORT_KEYS.includes(reportValue) ? reportValue : 'profit_loss'
      const periodValue = String(req.nextUrl.searchParams.get('period') || 'ytd') as QuickBooksFinancialReportPeriod
      const periodKey = QUICKBOOKS_FINANCIAL_REPORT_PERIODS.includes(periodValue) ? periodValue : 'ytd'
      return json({
        ok: true,
        capabilities,
        view: 'reports',
        report: await readQuickBooksFinancialReportInPostgres({
          organizationId: organization,
          reportKey,
          periodKey,
        }),
      })
    }
    if (viewValue === 'pos-parity') {
      const fromBusinessDate = businessDateParam(req.nextUrl.searchParams.get('from'))
      const toBusinessDate = businessDateParam(req.nextUrl.searchParams.get('to'))
      if (fromBusinessDate === undefined || toBusinessDate === undefined) {
        return json({
          ok: false,
          error: 'Parity dates must use valid YYYY-MM-DD values',
          code: 'ACCOUNTING_PARITY_DATE_INVALID',
        }, 400)
      }
      if (fromBusinessDate && toBusinessDate && fromBusinessDate > toBusinessDate) {
        return json({
          ok: false,
          error: 'The parity start date must be on or before the end date',
          code: 'ACCOUNTING_PARITY_DATE_RANGE_INVALID',
        }, 400)
      }
      const page = Math.max(1, Math.min(100000, Math.floor(numberParam(req.nextUrl.searchParams.get('page'), 1))))
      const pageSize = Math.max(10, Math.min(366, Math.floor(numberParam(req.nextUrl.searchParams.get('pageSize'), 90))))
      const historyPage = Math.max(1, Math.min(100000, Math.floor(numberParam(req.nextUrl.searchParams.get('historyPage'), 1))))
      const historyPageSize = Math.max(10, Math.min(100, Math.floor(numberParam(req.nextUrl.searchParams.get('historyPageSize'), 20))))
      return json({
        ok: true,
        capabilities,
        view: 'pos-parity',
        report: await readPosAccountingParityReportInPostgres({
          organizationId: organization,
          fromBusinessDate,
          toBusinessDate,
          page,
          pageSize,
          historyPage,
          historyPageSize,
        }),
      })
    }
    if (viewValue === 'pos-parity-evidence') {
      const transactionId = String(req.nextUrl.searchParams.get('id') || '').trim()
      const entityType = String(req.nextUrl.searchParams.get('entityType') || '').trim()
      if (!transactionId || transactionId.length > 200 || /[^\x20-\x7e]/.test(transactionId)) {
        return json({
          ok: false,
          error: 'Parity transaction id is invalid',
          code: 'ACCOUNTING_PARITY_TRANSACTION_ID_INVALID',
        }, 400)
      }
      if (entityType !== 'SalesReceipt' && entityType !== 'JournalEntry') {
        return json({
          ok: false,
          error: 'Parity transaction type is invalid',
          code: 'ACCOUNTING_PARITY_TRANSACTION_TYPE_INVALID',
        }, 400)
      }
      const detail = await readPosAccountingParityEvidenceDetailInPostgres({
        organizationId: organization,
        entityType: entityType as PosAccountingParityEntityType,
        providerTransactionId: transactionId,
      })
      return detail
        ? json({ ok: true, capabilities, view: 'pos-parity-evidence', detail })
        : json({
          ok: false,
          error: 'Toast posting evidence was not found',
          code: 'ACCOUNTING_PARITY_EVIDENCE_NOT_FOUND',
        }, 404)
    }
    if (viewValue === 'invoice') {
      const invoiceId = String(req.nextUrl.searchParams.get('id') || '').trim()
      if (!invoiceId || invoiceId.length > 200 || /[^\x20-\x7e]/.test(invoiceId)) {
        return json({ ok: false, error: 'Invoice id is invalid', code: 'ACCOUNTING_INVOICE_ID_INVALID' }, 400)
      }
      const invoice = await readQuickBooksInvoiceDetailInPostgres({
        organizationId: organization,
        invoiceId,
      })
      return invoice
        ? json({ ok: true, capabilities, view: 'invoice', invoice })
        : json({ ok: false, error: 'Invoice was not found', code: 'ACCOUNTING_INVOICE_NOT_FOUND' }, 404)
    }
    if (viewValue === 'transaction-attachments') {
      const transactionId = String(req.nextUrl.searchParams.get('id') || '').trim()
      const entityType = String(req.nextUrl.searchParams.get('entityType') || '').trim()
      if (!transactionId || transactionId.length > 200 || /[^\x20-\x7e]/.test(transactionId)) {
        return json({ ok: false, error: 'Transaction id is invalid', code: 'ACCOUNTING_TRANSACTION_ID_INVALID' }, 400)
      }
      if (!TRANSACTION_ENTITY_TYPES.has(entityType)) {
        return json({ ok: false, error: 'Transaction type is invalid', code: 'ACCOUNTING_TRANSACTION_TYPE_INVALID' }, 400)
      }
      return json({
        ok: true,
        capabilities,
        view: 'transaction-attachments',
        attachments: await readQuickBooksTransactionAttachmentsInPostgres({
          organizationId: organization,
          entityType,
          transactionId,
        }),
      })
    }
    const view = viewValue as QuickBooksExplorerView
    if (!QUICKBOOKS_EXPLORER_VIEWS.includes(view)) {
      return json({ ok: false, error: 'Unsupported accounting view', code: 'ACCOUNTING_VIEW_INVALID' }, 400)
    }
    const requestedEntityType = String(req.nextUrl.searchParams.get('entityType') || '').trim()
    const entityType = TRANSACTION_ENTITY_TYPES.has(requestedEntityType) ? requestedEntityType : null
    const statusValue = String(req.nextUrl.searchParams.get('status') || '').trim()
    const status = ['Open', 'Paid', 'Overdue', 'Posted'].includes(statusValue) ? statusValue : null
    return json({
      ok: true,
      capabilities,
      view,
      result: await readQuickBooksExplorerListInPostgres({
        organizationId: organization,
        view,
        page: numberParam(req.nextUrl.searchParams.get('page'), 1),
        pageSize: numberParam(req.nextUrl.searchParams.get('pageSize'), 25),
        search: String(req.nextUrl.searchParams.get('search') || ''),
        range,
        status,
        entityType,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
    }
    return json({ ok: false, error: 'Accounting data is temporarily unavailable', code: 'ACCOUNTING_INTERNAL_ERROR' }, 500)
  }
}
