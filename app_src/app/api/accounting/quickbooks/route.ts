import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  QUICKBOOKS_EXPLORER_RANGES,
  QUICKBOOKS_EXPLORER_VIEWS,
  readQuickBooksExplorerListInPostgres,
  readQuickBooksExplorerOverviewInPostgres,
  type QuickBooksExplorerRange,
  type QuickBooksExplorerView,
} from '@/lib/persistence/quickBooksExplorer'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, effectiveUserPermissions, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const TRANSACTION_ENTITY_TYPES = new Set([
  'Invoice', 'Payment', 'SalesReceipt', 'Purchase', 'Bill', 'BillPayment', 'CreditMemo', 'RefundReceipt',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function organizationId(actor: AppUser) {
  const organizationId = String(actor.organizationId || '').trim()
  if (!organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
  return organizationId
}

function accountingCapabilities(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  const permissions = effectiveUserPermissions(actor)
  return {
    canView: role === 'owner' || permissions.viewAccounting,
    canManage: role === 'owner' || (role === 'admin' && permissions.manageUserAccess),
  }
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
    const organization = organizationId(actor)
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
