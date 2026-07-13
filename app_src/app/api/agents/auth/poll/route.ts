import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { pollChatGPTDeviceLogin } from '@/lib/agents/chatgptAuth'
import { requireActiveAppUser } from '@/lib/users'

async function operatorEmail(req: NextRequest): Promise<string | null> {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  if (!session.ok) return null
  try {
    return (await requireActiveAppUser(session.user)).email
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const operatorId = await operatorEmail(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json()
    const result = await pollChatGPTDeviceLogin(operatorId, body?.loginId)
    if (result.status === 'expired') {
      return NextResponse.json({ ok: false, status: 'expired', expired: true }, { status: 410 })
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ChatGPT authorization failed'
    return NextResponse.json({ ok: false, status: 'failed', error: message }, { status: 400 })
  }
}
