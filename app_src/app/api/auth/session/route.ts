import { NextRequest, NextResponse } from 'next/server'
import {
  resolveRequestSession,
  setBrowserSessionCookie,
  upgradeLegacyRequestSession,
} from '@/lib/authSessions'
import { getAppUser, isRootAppOwner } from '@/lib/users'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { listWorkspaceMemberships, requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

export async function GET(req: NextRequest) {
  try {
    let session = await resolveRequestSession(req)
    if (!session) return NextResponse.json({ ok: false }, { status: 401 })
    let issued = null
    if (session.legacy) {
      issued = await upgradeLegacyRequestSession(req, session)
      session = issued.session
    }
    const [authenticatedUser, effectiveUser, memberships] = await Promise.all([
      getAppUser(session.authenticatedUser),
      requireWorkspaceAppUser(session.effectiveUser, session.activeWorkspaceOrganizationId),
      listWorkspaceMemberships(session.effectiveUser),
    ])
    if (!authenticatedUser || authenticatedUser.status !== 'active' || !effectiveUser || effectiveUser.status !== 'active') {
      return NextResponse.json({ ok: false }, { status: 401 })
    }
    const expiration = Math.min(Date.parse(session.idleExpiresAt), Date.parse(session.absoluteExpiresAt))
    const operations = operationsCapabilities(effectiveUser)
    const managerRole = effectiveUser.role === 'owner' || effectiveUser.role === 'admin'
    const response = NextResponse.json({
      ok: true,
      user: effectiveUser.email,
      role: effectiveUser.role,
      status: effectiveUser.status,
      exp: Math.floor(expiration / 1000),
      authenticatedUser: {
        email: authenticatedUser.email,
        displayName: authenticatedUser.displayName,
        role: authenticatedUser.role,
      },
      effectiveUser: {
        email: effectiveUser.email,
        displayName: effectiveUser.displayName,
        role: effectiveUser.role,
        organizationName: effectiveUser.organizationName,
        organizationRole: effectiveUser.organizationRole,
      },
      activeWorkspace: {
        organizationId: effectiveUser.organizationId,
        referenceCode: session.activeWorkspaceReferenceCode,
        name: effectiveUser.organizationName,
        role: effectiveUser.organizationRole,
        switchedAt: session.activeWorkspaceSwitchedAt,
      },
      availableWorkspaces: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        referenceCode: membership.organizationReferenceCode,
        name: membership.organizationName,
        organizationType: membership.organizationType,
        role: membership.role,
        isDefault: membership.isDefault,
      })),
      session: {
        id: session.id,
        deviceLabel: session.deviceLabel,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      },
      impersonation: session.impersonating ? {
        active: true,
        startedAt: session.impersonationStartedAt,
        expiresAt: session.impersonationExpiresAt,
      } : { active: false },
      mobileCapabilities: {
        canUsePicker: operations.canView && operations.canManage && operations.canExecute,
        canUseManager: managerRole || operations.canManage,
      },
      isRootAdmin: isRootAppOwner(authenticatedUser),
    })
    if (issued) setBrowserSessionCookie(response, issued)
    return response
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
}
