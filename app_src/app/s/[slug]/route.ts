import { NextRequest, NextResponse } from 'next/server'
import { resolveShortLink } from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

export async function GET(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params
  const sourceApp = new URL(req.url).searchParams.get('source') || 'short-link'
  const result = await resolveShortLink({
    slug,
    sourceApp,
    referrer: req.headers.get('referer'),
  })
  if (result.status === 'found' && result.destinationUrl) {
    return NextResponse.redirect(result.destinationUrl, { status: 307, headers: responseHeaders })
  }
  const status = result.status === 'not-found' ? 404 : 410
  const label = result.status === 'not-found'
    ? 'This short link does not exist.'
    : result.status === 'expired'
      ? 'This short link has expired.'
      : result.status === 'exhausted'
        ? 'This short link has reached its click limit.'
        : 'This short link is disabled.'
  return new NextResponse(label, { status, headers: { ...responseHeaders, 'Content-Type': 'text/plain; charset=utf-8' } })
}
