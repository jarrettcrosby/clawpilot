import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readOperationsBarcodeLabelBatchPreviewFromPostgres,
} from '@/lib/persistence/operationBarcodeLabels'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Barcode label preview failed',
    code: 'OPERATIONS_BARCODE_LABEL_PREVIEW_FAILED',
  }, 500)
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ globalId: string }> },
) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'Barcode labels require Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Operations view permission is required to preview barcode labels',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const { globalId } = await context.params
    const preview = await readOperationsBarcodeLabelBatchPreviewFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      batchGlobalId: globalId,
    })
    return new NextResponse(preview.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'self'",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie',
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
