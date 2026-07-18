import type { NextRequest } from 'next/server'
import { resolveRequestSession, type BrowserSession } from '@/lib/authSessions'
import { OWNER_PERMISSIONS, requireActiveAppUser, type AppUser } from '@/lib/users'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

function localDevelopmentUser(): AppUser | null {
  const hosted = Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.VERCEL,
  )
  if (hosted || process.env.APP_AUTH_REQUIRED !== '0') return null

  const now = new Date().toISOString()
  const email = String(process.env.APP_LOGIN_EMAIL || 'local.developer@example.test').trim().toLowerCase()
  return {
    email,
    referenceCode: 'gu0000001',
    contactReferenceCode: 'gc0000002',
    crmUserEnabled: true,
    role: 'owner',
    status: 'active',
    displayName: 'Local Developer',
    jobTitle: null,
    organizationId: null,
    organizationName: 'Local ClawPilot',
    organizationRole: 'owner',
    organizationPermissions: { ...OWNER_PERMISSIONS },
    suiteCrmUserId: null,
    suiteCrmUsername: null,
    timezone: 'America/New_York',
    locale: 'en-US',
    permissions: { ...OWNER_PERMISSIONS },
    invitedBy: null,
    invitedAt: null,
    activatedAt: now,
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

export async function requestSession(req: NextRequest): Promise<BrowserSession | null> {
  return resolveRequestSession(req)
}

export async function sessionEmail(req: NextRequest): Promise<string | null> {
  const session = await requestSession(req)
  return session?.effectiveUser || localDevelopmentUser()?.email || null
}

export async function requireRequestUser(req: NextRequest): Promise<AppUser> {
  const session = await requestSession(req)
  if (session?.effectiveUser) {
    return requireWorkspaceAppUser(session.effectiveUser, session.activeWorkspaceOrganizationId)
  }
  const localUser = localDevelopmentUser()
  if (localUser) return localUser
  throw new Error('Unauthorized')
}

export async function requireRequestSession(req: NextRequest): Promise<BrowserSession> {
  const session = await requestSession(req)
  if (!session) throw new Error('Unauthorized')
  await requireActiveAppUser(session.authenticatedUser)
  await requireWorkspaceAppUser(session.effectiveUser, session.activeWorkspaceOrganizationId)
  return session
}
