import { NextRequest, NextResponse } from 'next/server'
import { openUserInvitation, requestUserInvitationCode } from '@/lib/invitations'

const INVITATION_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

function invitationError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unable to load this invitation'
  const status = /invalid|expired|already used/i.test(message) ? 410 : 400
  return NextResponse.json({ ok: false, error: message }, { status, headers: INVITATION_HEADERS })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    if (body?.action === 'open') {
      const invitation = await openUserInvitation(body?.token)
      return NextResponse.json({ ok: true, invitation }, { headers: INVITATION_HEADERS })
    }
    const result = await requestUserInvitationCode(body?.token)
    return NextResponse.json({ ok: true, ...result }, { headers: INVITATION_HEADERS })
  } catch (error) {
    return invitationError(error)
  }
}
