import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readOperationsPrintArtifactPayloadInPostgres,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

const ARTIFACT_EXTENSIONS = {
  ZPL: 'zpl',
  PDF: 'pdf',
  PNG: 'png',
} as const

function safeArtifactFilename(
  value: string,
  format: keyof typeof ARTIFACT_EXTENSIONS,
  artifactGlobalId: string,
) {
  const extension = ARTIFACT_EXTENSIONS[format]
  const stem = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\.(zpl|pdf|png)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 180)
  return `${stem || `print-artifact-${artifactGlobalId}`}.${extension}`
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Print artifact request failed',
    code: 'OPERATIONS_PRINT_ARTIFACT_REQUEST_FAILED',
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
        error: 'Print artifacts require Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canView) {
      return json({
        ok: false,
        error: 'You do not have permission to view print artifacts',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const { globalId } = await context.params
    const artifact = await readOperationsPrintArtifactPayloadInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      artifactGlobalId: globalId,
    })
    const etag = `"${artifact.contentSha256}"`
    const filename = safeArtifactFilename(
      artifact.filename,
      artifact.format,
      artifact.globalId,
    )
    const headers = {
      'Content-Type': artifact.mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
      'Content-Security-Policy': 'sandbox',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-ClawPilot-Content-SHA256': artifact.contentSha256,
      Vary: 'Cookie',
      ETag: etag,
    }
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, { status: 304, headers })
    }
    return new NextResponse(new Uint8Array(artifact.payload), {
      status: 200,
      headers: {
        ...headers,
        'Content-Length': String(artifact.byteLength),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
