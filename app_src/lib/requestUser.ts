import type { NextRequest } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { requireActiveAppUser, type AppUser } from '@/lib/users'

export function sessionEmail(req: NextRequest): string | null {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  return session.ok ? session.user : null
}

export async function requireRequestUser(req: NextRequest): Promise<AppUser> {
  const email = sessionEmail(req)
  if (!email) throw new Error('Unauthorized')
  return requireActiveAppUser(email)
}
