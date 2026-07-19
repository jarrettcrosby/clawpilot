import { NextRequest, NextResponse } from 'next/server'
import {
  accountingCapabilities,
  activeAccountingOrganizationId,
  canConfigureAccountingScope,
} from '@/lib/accountingAuthorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  POS_ACCOUNTING_SCOPES,
  PosAccountingRequestError,
  readPosAccountingWorkspaceFromPostgres,
  savePosAccountingMappingsInPostgres,
  savePosAccountingProfileInPostgres,
  validatePosAccountingMappings,
  validatePosAccountingProfile,
  type PosAccountingScope,
} from '@/lib/persistence/posAccounting'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 256 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROFILE_FIELDS = new Set([
  'postingMethod', 'quickBooksClassId', 'quickBooksClassName',
  'quickBooksDepartmentId', 'quickBooksDepartmentName',
  'quickBooksCustomerId', 'quickBooksCustomerName',
  'quickBooksClearingAccountId', 'quickBooksClearingAccountName',
  'trackSalesTax', 'breakoutDimensions', 'memoMode', 'customMemo',
  'customTransactionNumber', 'transactionNumberSuffix',
  'suppressZeroOverShort', 'autoPayoutTips', 'depositChecksWithCash',
  'openCheckPolicy', 'batchHoldPolicy',
])
const MAPPING_FIELDS = new Set([
  'sourceKind', 'sourceId', 'sourceName', 'targetType', 'targetId', 'targetName', 'active',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new PosAccountingRequestError(
      'POS_ACCOUNTING_POSTGRES_REQUIRED',
      'POS accounting configuration requires Postgres storage',
      503,
    )
  }
}

function dateValue(value: unknown) {
  const candidate = String(value || new Date().toISOString().slice(0, 10)).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_DATE_INVALID', 'Business date is invalid')
  }
  const parsed = new Date(`${candidate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_DATE_INVALID', 'Business date is invalid')
  }
  return candidate
}

function restaurantGuidValue(value: unknown, required = false) {
  const candidate = String(value || '').trim()
  if (!candidate && !required) return null
  if (!UUID_PATTERN.test(candidate)) {
    throw new PosAccountingRequestError('POS_LOCATION_INVALID', 'POS location is invalid')
  }
  return candidate.toLowerCase()
}

function assertFields(value: unknown, allowed: Set<string>, code: string, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PosAccountingRequestError(code, `${label} is invalid`)
  }
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) throw new PosAccountingRequestError(code, `${label} includes an unsupported field`)
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_CONTENT_TYPE_INVALID', 'POS accounting requests require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_REQUEST_TOO_LARGE', 'POS accounting request exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_REQUEST_TOO_LARGE', 'POS accounting request exceeded the supported size', 413)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    assertFields(
      parsed,
      new Set(['action', 'scope', 'restaurantGuid', 'profile', 'mappings']),
      'POS_ACCOUNTING_REQUEST_INVALID',
      'POS accounting request',
    )
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof PosAccountingRequestError) throw error
    throw new PosAccountingRequestError('POS_ACCOUNTING_REQUEST_INVALID', 'A valid POS accounting request is required')
  }
}

function scopeValue(value: unknown): PosAccountingScope {
  const scope = String(value || 'organization_default') as PosAccountingScope
  if (!POS_ACCOUNTING_SCOPES.includes(scope)) {
    throw new PosAccountingRequestError('POS_ACCOUNTING_SCOPE_INVALID', 'POS accounting scope is invalid')
  }
  return scope
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({ ok: false, error: 'Your organization administrator has not granted access to accounting data', code: 'ACCOUNTING_VIEW_REQUIRED' }, 403)
    }
    return json({
      ok: true,
      capabilities,
      accounting: await readPosAccountingWorkspaceFromPostgres({
        organizationId: activeAccountingOrganizationId(actor),
        restaurantGuid: restaurantGuidValue(req.nextUrl.searchParams.get('location')),
        businessDate: dateValue(req.nextUrl.searchParams.get('date')),
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canManage && !capabilities.canPrepare) {
      return json({ ok: false, error: 'You do not have permission to manage POS accounting configuration', code: 'POS_ACCOUNTING_MANAGE_REQUIRED' }, 403)
    }
    const organizationId = activeAccountingOrganizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '')
    const scope = scopeValue(body.scope)
    const restaurantGuid = restaurantGuidValue(body.restaurantGuid, scope === 'location_override')
    if (!canConfigureAccountingScope(capabilities, scope)) {
      return json({
        ok: false,
        error: 'Accounting preparers may only configure a selected location',
        code: 'POS_ACCOUNTING_ORGANIZATION_CONFIG_REQUIRED',
      }, 403)
    }
    if (action === 'save-profile') {
      if (body.mappings !== undefined) throw new PosAccountingRequestError('POS_ACCOUNTING_REQUEST_INVALID', 'Mappings are not accepted when saving a profile')
      assertFields(body.profile, PROFILE_FIELDS, 'POS_ACCOUNTING_PROFILE_INVALID', 'POS accounting profile')
      const profile = await savePosAccountingProfileInPostgres({
        organizationId,
        restaurantGuid,
        scope,
        actorEmail: actor.email,
        profile: validatePosAccountingProfile(body.profile),
      })
      return json({ ok: true, capabilities, profile })
    }
    if (action === 'save-mappings') {
      if (body.profile !== undefined) throw new PosAccountingRequestError('POS_ACCOUNTING_REQUEST_INVALID', 'Profile fields are not accepted when saving mappings')
      if (!Array.isArray(body.mappings)) throw new PosAccountingRequestError('POS_MAPPINGS_INVALID', 'Mappings must be a list')
      for (const mapping of body.mappings) {
        assertFields(mapping, MAPPING_FIELDS, 'POS_MAPPINGS_INVALID', 'POS accounting mapping')
      }
      const mappings = await savePosAccountingMappingsInPostgres({
        organizationId,
        restaurantGuid,
        scope,
        actorEmail: actor.email,
        mappings: validatePosAccountingMappings(body.mappings),
      })
      return json({ ok: true, capabilities, mappings })
    }
    throw new PosAccountingRequestError('POS_ACCOUNTING_ACTION_INVALID', 'POS accounting action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}

function errorResponse(error: unknown) {
  if (error instanceof PosAccountingRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  return json({ ok: false, error: 'POS accounting data is temporarily unavailable', code: 'POS_ACCOUNTING_INTERNAL_ERROR' }, 500)
}
