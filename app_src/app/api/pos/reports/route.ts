import { NextRequest, NextResponse } from 'next/server'
import { accountingCapabilities, activeAccountingOrganizationId } from '@/lib/accountingAuthorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  buildPosReportRanges,
  readPosOperationalReportFromPostgres,
} from '@/lib/persistence/posReporting'
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
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new Error('POS_DATE_INVALID')
  }
  return candidate
}

function locationValue(req: NextRequest) {
  const restaurantGuid = String(req.nextUrl.searchParams.get('restaurantGuid') || '').trim()
  const location = String(req.nextUrl.searchParams.get('location') || '').trim()
  if ((restaurantGuid && !UUID_PATTERN.test(restaurantGuid)) || (location && !UUID_PATTERN.test(location))) {
    throw new Error('POS_LOCATION_INVALID')
  }
  if (restaurantGuid && location && restaurantGuid.toLowerCase() !== location.toLowerCase()) {
    throw new Error('POS_LOCATION_CONFLICT')
  }
  return restaurantGuid || location || null
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
    buildPosReportRanges(from, to)
    const restaurantGuid = locationValue(req)

    return json({
      ok: true,
      capabilities,
      report: await readPosOperationalReportFromPostgres({
        organizationId: activeAccountingOrganizationId(actor),
        from,
        to,
        restaurantGuid,
      }),
    })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'Unauthorized') return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    if (code === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code }, 409)
    }
    if (code === 'POS_DATE_INVALID') return json({ ok: false, error: 'POS date is invalid', code }, 400)
    if (code === 'POS_DATE_RANGE_INVALID') {
      return json({ ok: false, error: 'Select a POS date range of 367 days or less', code }, 400)
    }
    if (code === 'POS_LOCATION_INVALID') return json({ ok: false, error: 'POS location is invalid', code }, 400)
    if (code === 'POS_LOCATION_CONFLICT') {
      return json({ ok: false, error: 'restaurantGuid and location must identify the same POS location', code }, 400)
    }
    return json({ ok: false, error: 'POS reporting is temporarily unavailable', code: 'POS_REPORT_INTERNAL_ERROR' }, 500)
  }
}
