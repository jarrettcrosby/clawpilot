import type { BrowserSession } from '@/lib/authSessions'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

const PHYSICAL_OUTPUT_AUTH_METHODS = new Set<BrowserSession['authMethod']>([
  'magic_code',
  'google_sso',
  'operator_password',
])

export function canUsePhysicalOutputAttestationBrowserSession(input: {
  session: BrowserSession | null
  actor: AppUser
  organizationId: string
}): boolean {
  const { session, actor, organizationId } = input
  if (!session) return false
  return session.legacy !== true
    && PHYSICAL_OUTPUT_AUTH_METHODS.has(session.authMethod)
    && !session.impersonating
    && session.impersonationStartedAt === null
    && session.impersonationExpiresAt === null
    && session.authenticatedUser === session.effectiveUser
    && session.authenticatedUser === actor.email
    && session.activeWorkspaceOrganizationId === organizationId
    && session.activeWorkspaceRole === effectiveAuthorizationRole(actor)
}
