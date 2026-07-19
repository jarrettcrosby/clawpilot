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

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const TRANSACTION_ENTITY_TYPES = new Set([
  'Invoice', 'Payment', 'SalesReceipt', 'Purchase', 'Bill', 'BillPayment', 'CreditMemo', 'RefundReceipt',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function numberParam(value: string | null, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
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
