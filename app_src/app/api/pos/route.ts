import { NextRequest, NextResponse } from 'next/server'
import { accountingCapabilities, activeAccountingOrganizationId } from '@/lib/accountingAuthorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readPosWorkspaceFromPostgres } from '@/lib/persistence/pos'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function dateValue(value: string | null, fallback: Date) {
  const candidate = String(value || fallback.toISOString().slice(0, 10))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) throw new Error('POS_DATE_INVALID')
  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) throw new Error('POS_DATE_INVALID')
  return candidate
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!isPostgresStorageEnabled()) {
      return json({ ok: false, error: 'POS reporting requires Postgres storage', code: 'POS_POSTGRES_REQUIRED' }, 503)
    }
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({ ok: false, error: 'Your organization administrator has not granted access to POS data', code: 'POS_VIEW_REQUIRED' }, 403)
    }
    const today = new Date()
    const defaultFrom = new Date(today)
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29)
    const from = dateValue(req.nextUrl.searchParams.get('from'), defaultFrom)
    const to = dateValue(req.nextUrl.searchParams.get('to'), today)
    const rangeDays = Math.round((new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / 86_400_000)
    if (rangeDays < 0 || rangeDays > 366) {
      return json({ ok: false, error: 'Select a POS date range of 367 days or less', code: 'POS_DATE_RANGE_INVALID' }, 400)
    }
    const locationValue = String(req.nextUrl.searchParams.get('location') || '').trim()
    if (locationValue && !UUID_PATTERN.test(locationValue)) {
      return json({ ok: false, error: 'POS location is invalid', code: 'POS_LOCATION_INVALID' }, 400)
    }
    const selectedOrderGuid = String(req.nextUrl.searchParams.get('order') || '').trim()
    if (selectedOrderGuid.length > 200 || /[\u0000-\u001f\u007f]/.test(selectedOrderGuid)) {
      return json({ ok: false, error: 'POS order is invalid', code: 'POS_ORDER_INVALID' }, 400)
    }
    const search = String(req.nextUrl.searchParams.get('search') || '')
    if (search.length > 160 || /[\u0000-\u001f\u007f]/.test(search)) {
      return json({ ok: false, error: 'POS search is invalid', code: 'POS_SEARCH_INVALID' }, 400)
    }
    return json({
      ok: true,
      capabilities,
      pos: await readPosWorkspaceFromPostgres({
        organizationId: activeAccountingOrganizationId(actor),
        from,
        to,
        restaurantGuid: locationValue || null,
        page: boundedInteger(req.nextUrl.searchParams.get('page'), 1, 1, 1_000_000),
        pageSize: boundedInteger(req.nextUrl.searchParams.get('pageSize'), 25, 1, 100),
        selectedOrderGuid: selectedOrderGuid || null,
        search,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
    }
    if (error instanceof Error && error.message === 'POS_DATE_INVALID') {
      return json({ ok: false, error: 'POS date is invalid', code: error.message }, 400)
    }
    return json({ ok: false, error: 'POS data is temporarily unavailable', code: 'POS_INTERNAL_ERROR' }, 500)
  }
}
