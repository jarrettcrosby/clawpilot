import type { NextRequest } from 'next/server'
import { resolveRequestSession, type BrowserSession } from '@/lib/authSessions'
import { requireActiveAppUser, type AppUser } from '@/lib/users'

export async function requestSession(req: NextRequest): Promise<BrowserSession | null> {
  return resolveRequestSession(req)
}

export async function sessionEmail(req: NextRequest): Promise<string | null> {
  const session = await requestSession(req)
  return session?.effectiveUser || null
}

export async function requireRequestUser(req: NextRequest): Promise<AppUser> {
  const email = await sessionEmail(req)
  if (!email) throw new Error('Unauthorized')
  return requireActiveAppUser(email)
}

export async function requireRequestSession(req: NextRequest): Promise<BrowserSession> {
  const session = await requestSession(req)
  if (!session) throw new Error('Unauthorized')
  await requireActiveAppUser(session.authenticatedUser)
  await requireActiveAppUser(session.effectiveUser)
  return session
}
