import { NextRequest, NextResponse } from 'next/server'

const CRM_REFERENCE_PATTERN = /^g(?:a|c|i|k|l|m|o)[0-9]{7}$/

export function GET(req: NextRequest, context: { params: Promise<{ reference: string }> }) {
  return context.params.then(({ reference }) => {
    const normalized = String(reference || '').trim().toLowerCase()
    if (!CRM_REFERENCE_PATTERN.test(normalized)) {
      return NextResponse.json({ ok: false, error: 'CRM record not found' }, { status: 404 })
    }
    const destination = new URL('/', req.url)
    destination.searchParams.set('crm', normalized)
    destination.hash = 'crm'
    return NextResponse.redirect(destination)
  })
}
