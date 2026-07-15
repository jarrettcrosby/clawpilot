import { NextRequest, NextResponse } from 'next/server'
import { resolveCrmReferenceCode } from '@/lib/persistence/crm'
import { appPublicUrl } from '@/lib/publicUrl'

const CRM_REFERENCE_PATTERN = /^g(?:a|c|i|k|l|m|o)[0-9]{7}$/

export async function GET(req: NextRequest, context: { params: Promise<{ reference: string }> }) {
  const { reference } = await context.params
  const normalized = String(reference || '').trim().toLowerCase()
  if (!CRM_REFERENCE_PATTERN.test(normalized)) {
    return NextResponse.json({ ok: false, error: 'CRM record not found' }, { status: 404 })
  }
  const canonical = await resolveCrmReferenceCode(normalized)
  const destination = new URL('/', appPublicUrl())
  destination.searchParams.set('crm', canonical)
  const pipelineId = req.nextUrl.searchParams.get('pipeline')?.trim() || ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pipelineId)) {
    destination.searchParams.set('pipeline', pipelineId)
  }
  destination.hash = 'crm'
  return NextResponse.redirect(destination)
}
