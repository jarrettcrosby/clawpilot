import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { requestAuthMagicCode } from '@/lib/authMagicCode'
import { disconnectChatGPT } from '@/lib/agents/chatgptAuth'
import { inviteAppUser, listAppUsers, setAppUserStatus } from '@/lib/users'

function sessionEmail(req: NextRequest): string | null {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  return session.ok ? session.user : null
}

export async function GET(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { actor, users } = await listAppUsers(email)
    return NextResponse.json({
      ok: true,
      currentUser: actor,
      canInvite: actor.role === 'owner',
      users,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load users'
    return NextResponse.json({ ok: false, error: message }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  const actorEmail = sessionEmail(req)
  if (!actorEmail) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const user = await inviteAppUser({ actorEmail, email: body?.email })
    const delivery = await requestAuthMagicCode({ email: user.email })
    return NextResponse.json({
      ok: true,
      user,
      delivery: delivery.status === 'sent' ? 'sent' : delivery.status,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to invite user'
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const actorEmail = sessionEmail(req)
  if (!actorEmail) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const status = body?.status === 'active' ? 'active' : body?.status === 'disabled' ? 'disabled' : null
    if (!status) return NextResponse.json({ ok: false, error: 'Valid status required' }, { status: 400 })
    const user = await setAppUserStatus({ actorEmail, email: body?.email, status })
    if (status === 'disabled') await disconnectChatGPT(user.email).catch(() => undefined)
    return NextResponse.json({ ok: true, user })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update user'
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
