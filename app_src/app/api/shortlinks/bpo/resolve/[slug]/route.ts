import { NextRequest, NextResponse } from 'next/server'
import {
  assertBpoShortLinkResolverAuthorization,
  resolveShortLink,
  ShortLinkRequestError,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

export async function GET(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  try {
    assertBpoShortLinkResolverAuthorization(req.headers.get('authorization'))
    const { slug } = await context.params
    const result = await resolveShortLink({
      slug,
      publicDomain: 'bpo',
      sourceApp: 'bpo-short-link',
      referrer: req.headers.get('x-shortlink-referrer'),
    })
    if (result.status === 'found' && result.destinationUrl) {
      return NextResponse.redirect(result.destinationUrl, { status: 307, headers: responseHeaders })
    }
    const status = result.status === 'not-found' ? 404 : 410
    return new NextResponse(status === 404 ? 'This short link does not exist.' : 'This short link is unavailable.', {
      status,
      headers: { ...responseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (error) {
    if (error instanceof ShortLinkRequestError) {
      return new NextResponse(error.status === 401 ? 'Unauthorized' : 'Short-link resolver unavailable', {
        status: error.status,
        headers: { ...responseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
    console.error('[shortlinks/bpo] resolver failed', error)
    return new NextResponse('Short-link resolver unavailable', {
      status: 503,
      headers: { ...responseHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

export async function HEAD() {
  return new NextResponse(null, { status: 405, headers: { ...responseHeaders, Allow: 'GET' } })
}
