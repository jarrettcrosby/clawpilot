import { NextRequest, NextResponse } from 'next/server'
import { readQuickBooksAttachmentDownloadUrl } from '@/lib/integrations/quickBooksClient'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readQuickBooksAttachmentAccessInPostgres } from '@/lib/persistence/quickBooksExplorer'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, effectiveUserPermissions } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(error: string, code: string, status: number) {
  return NextResponse.json({ ok: false, error, code }, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const actor = await requireRequestUser(request)
    if (!isPostgresStorageEnabled()) return json('Accounting requires Postgres storage', 'ACCOUNTING_POSTGRES_REQUIRED', 503)
    const role = effectiveAuthorizationRole(actor)
    const permissions = effectiveUserPermissions(actor)
    if (role !== 'owner' && !permissions.viewAccounting) {
      return json('Your organization administrator has not granted access to accounting data', 'ACCOUNTING_VIEW_REQUIRED', 403)
    }
    const organizationId = String(actor.organizationId || '').trim()
    if (!organizationId) return json('Select an active organization first', 'ACTIVE_ORGANIZATION_REQUIRED', 409)
    const { attachmentId } = await context.params
    if (!attachmentId || attachmentId.length > 200 || /[^\x20-\x7e]/.test(attachmentId)) {
      return json('Attachment id is invalid', 'ACCOUNTING_ATTACHMENT_ID_INVALID', 400)
    }
    const access = await readQuickBooksAttachmentAccessInPostgres({ organizationId, attachmentId })
    if (!access) return json('Attachment was not found', 'ACCOUNTING_ATTACHMENT_NOT_FOUND', 404)
    const target = await readQuickBooksAttachmentDownloadUrl({
      ownerEmail: access.ownerEmail,
      connectionId: access.connectionId,
      attachmentId: access.attachmentId,
      thumbnail: request.nextUrl.searchParams.get('thumbnail') === '1',
    })
    return NextResponse.redirect(target, {
      status: 302,
      headers: {
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json('Unauthorized', 'UNAUTHORIZED', 401)
    }
    return json('QuickBooks attachment is temporarily unavailable', 'ACCOUNTING_ATTACHMENT_UNAVAILABLE', 502)
  }
}
