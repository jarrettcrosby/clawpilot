import { NextRequest, NextResponse } from 'next/server'
import {
  accountingCapabilities,
  activeAccountingOrganizationId,
} from '@/lib/accountingAuthorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  approvePosAccountingPostingBatchInPostgres,
  PosAccountingPostingError,
  preparePosAccountingPostingBatchInPostgres,
  recordExternalPostingInPostgres,
  recordMatchedExternalResultsInPostgres,
  recordMatchedShogoResultsInPostgres,
} from '@/lib/persistence/posAccountingPosting'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_CONTENT_TYPE_INVALID', 'POS posting requests require JSON', 415)
  }
  const declaredLength = Number(req.headers.get('content-length') || 0)
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_REQUEST_TOO_LARGE', 'POS posting request exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_REQUEST_TOO_LARGE', 'POS posting request exceeded the supported size', 413)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_REQUEST_INVALID', 'A valid POS posting request is required')
  }
}

function noteValue(value: unknown) {
  const note = String(value || '').trim()
  if (!note) return null
  if (note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_NOTE_INVALID', 'Review note is invalid')
  }
  return note
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      throw new PosAccountingPostingError('ACCOUNTING_POSTGRES_REQUIRED', 'POS posting requires Postgres storage', 503)
    }
    const actor = await requireRequestUser(req)
    const organizationId = activeAccountingOrganizationId(actor)
    const capabilities = accountingCapabilities(actor)
    const body = await requestBody(req)
    const action = String(body.action || '')

    if (action === 'record-external-draft') {
      if (!capabilities.canApprove) {
        return json({ ok: false, error: 'You do not have permission to record accounting outcomes', code: 'ACCOUNTING_APPROVAL_REQUIRED' }, 403)
      }
      const result = await recordExternalPostingInPostgres({
        organizationId,
        draftId: String(body.draftId || ''),
        salesReceiptId: String(body.salesReceiptId || ''),
        journalEntryId: String(body.journalEntryId || ''),
        providerName: String(body.providerName || ''),
        providerReference: body.providerReference == null ? null : String(body.providerReference),
        reviewNote: noteValue(body.reviewNote),
        actorEmail: actor.email,
      })
      return json({ ok: true, capabilities, result })
    }

    if (action === 'record-external-range') {
      if (!capabilities.canApprove) {
        return json({ ok: false, error: 'You do not have permission to record accounting outcomes', code: 'ACCOUNTING_APPROVAL_REQUIRED' }, 403)
      }
      const result = await recordMatchedExternalResultsInPostgres({
        organizationId,
        fromBusinessDate: String(body.fromBusinessDate || ''),
        toBusinessDate: String(body.toBusinessDate || ''),
        providerName: String(body.providerName || ''),
        providerReference: body.providerReference == null ? null : String(body.providerReference),
        reviewNote: noteValue(body.reviewNote),
        actorEmail: actor.email,
      })
      return json({ ok: true, capabilities, result })
    }

    // Preserve the pre-0080 action while older clients finish rolling forward.
    if (action === 'record-shogo-range') {
      if (!capabilities.canApprove) {
        return json({ ok: false, error: 'You do not have permission to record accounting outcomes', code: 'ACCOUNTING_APPROVAL_REQUIRED' }, 403)
      }
      const result = await recordMatchedShogoResultsInPostgres({
        organizationId,
        fromBusinessDate: String(body.fromBusinessDate || ''),
        toBusinessDate: String(body.toBusinessDate || ''),
        actorEmail: actor.email,
      })
      return json({ ok: true, capabilities, result })
    }

    if (action === 'prepare-clawpilot') {
      if (!capabilities.canPrepare) {
        return json({ ok: false, error: 'You do not have permission to prepare accounting drafts', code: 'ACCOUNTING_PREPARE_REQUIRED' }, 403)
      }
      const batch = await preparePosAccountingPostingBatchInPostgres({
        organizationId,
        draftId: String(body.draftId || ''),
        actorEmail: actor.email,
      })
      return json({ ok: true, capabilities, batch }, 201)
    }

    if (action === 'approve-clawpilot') {
      if (!capabilities.canApprove) {
        return json({ ok: false, error: 'You do not have permission to approve accounting changes', code: 'ACCOUNTING_APPROVAL_REQUIRED' }, 403)
      }
      const batch = await approvePosAccountingPostingBatchInPostgres({
        organizationId,
        batchId: String(body.batchId || ''),
        confirmFingerprint: String(body.confirmFingerprint || ''),
        actorEmail: actor.email,
        approvalNote: noteValue(body.approvalNote),
      })
      return json({ ok: true, capabilities, batch })
    }

    throw new PosAccountingPostingError('POS_ACCOUNTING_POSTING_ACTION_INVALID', 'POS posting action is invalid')
  } catch (error) {
    if (error instanceof PosAccountingPostingError) {
      return json({ ok: false, error: error.message, code: error.code }, error.status)
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
    }
    return json({ ok: false, error: 'POS posting is temporarily unavailable', code: 'POS_ACCOUNTING_POSTING_INTERNAL_ERROR' }, 500)
  }
}
