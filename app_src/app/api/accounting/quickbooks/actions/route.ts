import { NextRequest, NextResponse } from 'next/server'
import {
  accountingCapabilities,
  activeAccountingOrganizationId,
  canConfigureAccountingScope,
} from '@/lib/accountingAuthorization'
import {
  type QuickBooksItemDraft,
  QuickBooksWriteValidationError,
  validateQuickBooksWriteDraft,
} from '@/lib/integrations/quickBooksWritePayloads'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createQuickBooksWriteRequestInPostgres,
  QuickBooksWriteRequestError,
  readQuickBooksWriteWorkspaceInPostgres,
  transitionQuickBooksWriteRequestInPostgres,
} from '@/lib/persistence/quickBooksWrites'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_CONTENT_TYPE_INVALID', 'Accounting requests require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_REQUEST_TOO_LARGE', 'Accounting request exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_REQUEST_TOO_LARGE', 'Accounting request exceeded the supported size', 413)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_REQUEST_INVALID', 'A valid accounting request is required', 400)
  }
}

function uuidValue(value: unknown, label: string) {
  const id = String(value || '').trim()
  if (!UUID_PATTERN.test(id)) {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_ID_INVALID', `${label} is invalid`, 400)
  }
  return id.toLowerCase()
}

function approvalNote(value: unknown) {
  const note = String(value || '').trim()
  if (!note) return null
  if (note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
    throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_APPROVAL_NOTE_INVALID', 'Approval note is invalid', 400)
  }
  return note
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new QuickBooksWriteRequestError('ACCOUNTING_POSTGRES_REQUIRED', 'Accounting actions require Postgres storage', 503)
  }
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({ ok: false, error: 'Your organization administrator has not granted access to accounting data', code: 'ACCOUNTING_VIEW_REQUIRED' }, 403)
    }
    const requestIdValue = req.nextUrl.searchParams.get('requestId')
    const workspace = await readQuickBooksWriteWorkspaceInPostgres({
      organizationId: activeAccountingOrganizationId(actor),
      page: Number(req.nextUrl.searchParams.get('page') || 1),
      pageSize: Number(req.nextUrl.searchParams.get('pageSize') || 50),
      requestId: requestIdValue ? uuidValue(requestIdValue, 'Accounting request id') : null,
    })
    return json({ ok: true, capabilities, ...workspace })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canPrepare) {
      return json({ ok: false, error: 'You do not have permission to prepare accounting drafts', code: 'ACCOUNTING_PREPARE_REQUIRED' }, 403)
    }
    const organizationId = activeAccountingOrganizationId(actor)
    const body = await requestBody(req)
    const clientRequestId = uuidValue(body.clientRequestId, 'Client request id')
    const validated = await validateQuickBooksWriteDraft({
      organizationId,
      operationKind: body.operationKind,
      payload: body.payload,
    })
    const mappingScope = validated.operationKind === 'item.create'
      ? (validated.payload as QuickBooksItemDraft).mappingScope
      : null
    if (mappingScope && !canConfigureAccountingScope(capabilities, mappingScope)) {
      return json({
        ok: false,
        error: 'Accounting preparers may only create mappings for a selected location',
        code: 'POS_ACCOUNTING_ORGANIZATION_CONFIG_REQUIRED',
      }, 403)
    }
    const request = await createQuickBooksWriteRequestInPostgres({
      organizationId,
      operationKind: validated.operationKind,
      clientRequestId,
      payload: validated.payload,
      requestFingerprint: validated.requestFingerprint,
      actorEmail: actor.email,
    })
    return json({ ok: true, request }, 201)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = accountingCapabilities(actor)
    const body = await requestBody(req)
    const action = String(body.action || '') as 'submit' | 'approve' | 'cancel' | 'retry'
    if (!['submit', 'approve', 'cancel', 'retry'].includes(action)) {
      throw new QuickBooksWriteRequestError('QUICKBOOKS_WRITE_ACTION_INVALID', 'Accounting draft action is invalid', 400)
    }
    const approvalAction = action === 'approve' || action === 'retry'
    if (approvalAction ? !capabilities.canApprove : (!capabilities.canPrepare && !capabilities.canApprove)) {
      return json({
        ok: false,
        error: approvalAction ? 'You do not have permission to approve accounting changes' : 'You do not have permission to update accounting drafts',
        code: approvalAction ? 'ACCOUNTING_APPROVAL_REQUIRED' : 'ACCOUNTING_PREPARE_REQUIRED',
      }, 403)
    }
    const request = await transitionQuickBooksWriteRequestInPostgres({
      organizationId: activeAccountingOrganizationId(actor),
      requestId: uuidValue(body.requestId, 'Accounting request id'),
      action,
      actorEmail: actor.email,
      confirmFingerprint: typeof body.confirmFingerprint === 'string' ? body.confirmFingerprint : null,
      approvalNote: approvalNote(body.approvalNote),
    })
    return json({ ok: true, request })
  } catch (error) {
    return errorResponse(error)
  }
}

function errorResponse(error: unknown) {
  if (error instanceof QuickBooksWriteRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof QuickBooksWriteValidationError) {
    return json({ ok: false, error: error.message, code: error.code }, 400)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  return json({ ok: false, error: 'Accounting action is temporarily unavailable', code: 'ACCOUNTING_WRITE_INTERNAL_ERROR' }, 500)
}
