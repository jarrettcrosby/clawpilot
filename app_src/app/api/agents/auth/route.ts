import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { disconnectChatGPT, getChatGPTConnection, startChatGPTDeviceLogin } from '@/lib/agents/chatgptAuth'
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

export async function GET(req: NextRequest) {
  const operatorId = await operatorEmail(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ ok: true, auth: await getChatGPTConnection(operatorId) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load ChatGPT connection'
    return NextResponse.json({ ok: false, error: message }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  const operatorId = await operatorEmail(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const login = await startChatGPTDeviceLogin(operatorId)
    return NextResponse.json({ ok: true, ...login })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start ChatGPT authorization'
    return NextResponse.json({ ok: false, error: message }, { status: 503 })
  }
}

export async function DELETE(req: NextRequest) {
  const operatorId = await operatorEmail(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    await disconnectChatGPT(operatorId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to disconnect ChatGPT'
    return NextResponse.json({ ok: false, error: message }, { status: 503 })
  }
}
