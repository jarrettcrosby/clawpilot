import { NextRequest, NextResponse } from 'next/server'
import { globalIdPattern } from '@/lib/globalIds.mjs'
import { query } from '@/lib/persistence/postgres'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REFERENCE_PATTERN = globalIdPattern('ga')

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ referenceCode: string }> },
) {
  const { referenceCode: rawReferenceCode } = await context.params
  const referenceCode = String(rawReferenceCode || '').trim().toLowerCase()
  if (!REFERENCE_PATTERN.test(referenceCode)) {
    return NextResponse.json({ ok: false, error: 'Organization logo was not found' }, { status: 404 })
  }
  const result = await query<{
    logo_bytes: Buffer
    logo_mime_type: string
    revision: string
  }>(
    `SELECT branding.logo_bytes, branding.logo_mime_type, branding.revision::text
     FROM workspace_organization_branding branding
     JOIN workspace_organizations organization ON organization.id = branding.organization_id
     WHERE organization.reference_code = $1
       AND branding.logo_bytes IS NOT NULL
       AND branding.logo_mime_type IS NOT NULL
     LIMIT 1`,
    [referenceCode],
  )
  const logo = result.rows[0]
  if (!logo) return NextResponse.json({ ok: false, error: 'Organization logo was not found' }, { status: 404 })
  const etag = `"${referenceCode}-${logo.revision}"`
  if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag } })
  return new NextResponse(new Uint8Array(logo.logo_bytes), {
    headers: {
      'Content-Type': logo.logo_mime_type,
      'Content-Length': String(logo.logo_bytes.length),
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    },
  })
}
