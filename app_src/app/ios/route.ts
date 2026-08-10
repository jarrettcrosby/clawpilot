import { NextResponse } from 'next/server'

export function GET() {
  return new NextResponse(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>ClawPilot Picking</title><body><main><h1>ClawPilot Picking</h1><p>Open this link on the enrolled iPhone to complete Meta glasses registration.</p></main></body></html>',
    {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  )
}
