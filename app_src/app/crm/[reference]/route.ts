import { NextRequest, NextResponse } from 'next/server'
import { resolveCrmReferenceRoute } from '@/lib/persistence/crm'
import { appPublicUrl } from '@/lib/publicUrl'
import { sessionEmail } from '@/lib/requestUser'

const CRM_REFERENCE_PATTERN = /^g(?:a|c|i|k|l|m|o)[0-9]{7}$/
const CRM_PIPELINE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params
  const normalized = String(reference || '').trim().toLowerCase()
  if (!CRM_REFERENCE_PATTERN.test(normalized)) {
    return NextResponse.json({ ok: false, error: 'CRM record not found' }, { status: 404 })
  }
  const requestedPipelineId = req.nextUrl.searchParams.get('pipeline')?.trim() || ''
  const resolved = await resolveCrmReferenceRoute(normalized, {
    actorEmail: sessionEmail(req),
    requestedPipelineId,
  })
  const destination = new URL('/', appPublicUrl())
  destination.searchParams.set('crm', resolved.referenceCode)
  const pipelineId = CRM_PIPELINE_PATTERN.test(requestedPipelineId)
    ? requestedPipelineId
    : resolved.pipelineId || ''
  if (CRM_PIPELINE_PATTERN.test(pipelineId)) {
    destination.searchParams.set('pipeline', pipelineId)
  }
  if (req.nextUrl.searchParams.get('action') === 'compose-email') {
    destination.searchParams.set('crmAction', 'compose-email')
  }
  destination.hash = 'crm'
  return NextResponse.redirect(destination)
}
