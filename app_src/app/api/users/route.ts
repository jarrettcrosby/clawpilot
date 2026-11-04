import { NextRequest, NextResponse } from 'next/server'
import { revokeBrowserSessionsForUserWorkspace } from '@/lib/authSessions'
import { createUserInvitation } from '@/lib/invitations'
import {
  listWorkspaceOrganizationHierarchy,
  workspaceOrganizationById,
} from '@/lib/organizations'
import { ensureDefaultResourcesForUser } from '@/lib/tenancy'
import { syncAppUserProfileToOwnedPipelines } from '@/lib/persistence/crm'
import { requireRequestUser } from '@/lib/requestUser'
import { NativeEmailAccessPendingError } from '@/lib/crm/nativeEmailAuthorityRuntime'
import { getPendingWorkspaceUserAuthorityChange, resumeWorkspaceUserAuthorityChange } from '@/lib/crm/nativeEmailWorkspaceUserRecovery'
import {
  AppUserAuthorizationError,
  AppUserNotFoundError,
  AppUserIdentitySyncConflictError,
  addAppUserOrganizationMemberships,
  canInviteUsers,
  canManageUserAccess,
  effectiveAuthorizationRole,
  listAppUsers,
  setAppUserStatus,
  setAppUserTrashed,
  updateAppUserAccess,
  updateAppUserCrmEmployee,
  updateAppUserProfile,
  syncAppUserSuiteCrmIdentity,
} from '@/lib/users'

function userMutationErrorStatus(error: unknown): number {
  if (error instanceof AppUserAuthorizationError) return 403
  if (error instanceof AppUserNotFoundError) return 404
  if (error instanceof Error && error.message.includes('already being sent')) return 409
  return 400
}

function userMutationErrorResponse(error: unknown, fallback: string) {
  if (error instanceof AppUserIdentitySyncConflictError) return NextResponse.json({
    ok: false, error: error.message, code: error.code,
  }, { status: error.status })
  if (error instanceof NativeEmailAccessPendingError) return NextResponse.json({
    ok: false, error: error.message, code: error.code, transitionId: error.transitionId,
  }, { status: error.status })
  // Database fences are the last line of defence, not browser diagnostics.
  // An unsupported identity/enrollment request must not expose SQL or suggest
  // that its user mutation succeeded while the native change was held.
  if (error instanceof Error && 'code' in error && error.code === '55000'
    && /native (?:email |authority |transition |member |user )/i.test(error.message)) {
    const pending = new NativeEmailAccessPendingError()
    return NextResponse.json({ ok: false, error: pending.message, code: pending.code,
      transitionId: null }, { status: pending.status })
  }
  return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : fallback },
    { status: userMutationErrorStatus(error) })
}

export async function GET(req: NextRequest) {
  try {
    const requestActor = await requireRequestUser(req)
    const currentOrganization = requestActor.organizationId
      ? await workspaceOrganizationById(requestActor.organizationId)
      : null
    if (!currentOrganization) throw new Error('Active workspace is not available')
    await ensureDefaultResourcesForUser(requestActor)
    const { actor, users } = await listAppUsers(requestActor, req.nextUrl.searchParams.get('view') === 'trash' ? 'trash' : 'active')
    const workspaceOrganizations = await listWorkspaceOrganizationHierarchy(requestActor)
    const organizationRole = effectiveAuthorizationRole(actor)
    const pendingAccessChange = canManageUserAccess(actor) && actor.organizationId
      ? await getPendingWorkspaceUserAuthorityChange(actor.email, actor.organizationId) : null
    return NextResponse.json({
      ok: true,
      currentUser: actor,
      currentOrganization,
      isAdmin: organizationRole === 'owner' || organizationRole === 'admin',
      canInvite: canInviteUsers(actor),
      canManageUserAccess: canManageUserAccess(actor),
      pendingAccessChange,
      users,
      workspaceOrganizations,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load users'
    return NextResponse.json({ ok: false, error: message }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const body = await req.json()
    const invitation = await createUserInvitation({
      actorEmail: actor,
      email: body?.email,
      organizationId: body?.organizationId,
      organizationIds: body?.organizationIds,
      createOrganization: body?.createOrganization === true,
      organizationName: body?.organizationName,
      parentOrganizationId: body?.parentOrganizationId,
      crmUserEnabled: body?.crmUserEnabled === true,
      demoAccess: body?.demoAccess === true,
    })
    return NextResponse.json({
      ok: true,
      user: invitation.user,
      delivery: invitation.delivery,
      expiresAt: invitation.expiresAt,
    })
  } catch (error) {
    return userMutationErrorResponse(error, 'Unable to invite user')
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const body = await req.json()
    if (body?.action === 'resume-access-change') {
      if (!canManageUserAccess(actor) || !actor.organizationId) {
        throw new AppUserAuthorizationError('Manage access permission is required to resume this change')
      }
      await resumeWorkspaceUserAuthorityChange(actor.email, actor.organizationId, body.transitionId)
      return NextResponse.json({ ok: true })
    }
    if (body?.action === 'trash-user' || body?.action === 'restore-user') {
      const user = await setAppUserTrashed({ actorEmail: actor, email: body.email,
        organizationId: body.organizationId, trashed: body.action === 'trash-user' })
      return NextResponse.json({ ok: true, user })
    }
    if (body?.action === 'organizations-add') {
      const result = await addAppUserOrganizationMemberships({
        actorEmail: actor,
        email: body.email,
        organizationIds: body.organizationIds,
      })
      return NextResponse.json({ ok: true, ...result })
    }
    if (body?.action === 'crm-employee') {
      let user = await updateAppUserCrmEmployee({
        actorEmail: actor,
        email: body.email,
        organizationId: body.organizationId,
        enabled: body.enabled === true,
      })
      let warning: string | undefined
      let crmIdentitySync: 'queued' | 'verified' | 'not-mapped' | 'retained' = user.suiteCrmUserId ? 'retained' : 'not-mapped'
      // Re-enabling assignment eligibility must not rewrite an identity that
      // this operation deliberately retained or queue a native user resave.
      // Explicit identity repair remains the separate crm-user-sync action.
      if (body.enabled === true && !user.suiteCrmUserId) {
        try {
          const synced = await syncAppUserSuiteCrmIdentity({
            actorEmail: actor,
            email: body.email,
            organizationId: body.organizationId,
          })
          user = synced.user
          crmIdentitySync = synced.identitySync
        } catch (error) {
          warning = error instanceof Error ? error.message : 'SuiteCRM identity sync is pending'
        }
      }
      return NextResponse.json({ ok: true, user, crmIdentitySync, warning })
    }
    if (body?.action === 'crm-user-sync') {
      const synced = await syncAppUserSuiteCrmIdentity({
        actorEmail: actor,
        email: body.email,
        organizationId: body.organizationId,
      })
      return NextResponse.json({ ok: true, user: synced.user, crmIdentitySync: synced.identitySync })
    }
    if (body?.action === 'profile') {
      await ensureDefaultResourcesForUser(actor)
      const user = await updateAppUserProfile({
        actorEmail: actor,
        displayName: body.displayName,
        jobTitle: body.jobTitle,
        organizationName: body.organizationName,
        timezone: body.timezone,
        locale: body.locale,
      })
      let crmProfiles: Awaited<ReturnType<typeof syncAppUserProfileToOwnedPipelines>> = []
      let crmSync: 'synced' | 'queued' = 'synced'
      try {
        crmProfiles = await syncAppUserProfileToOwnedPipelines(user.email)
      } catch {
        crmSync = 'queued'
      }
      return NextResponse.json({ ok: true, user, crmProfiles, crmSync })
    }
    if (body?.action === 'access') {
      const user = await updateAppUserAccess({
        actorEmail: actor,
        email: body.email,
        organizationId: body.organizationId,
        role: body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : undefined,
        permissions: body.permissions,
      })
      if (!user.organizationId) throw new Error('User workspace assignment is missing')
      await revokeBrowserSessionsForUserWorkspace({
        userEmail: user.email,
        organizationId: user.organizationId,
        actor: actor.email,
        reason: 'access_changed',
      })
      return NextResponse.json({ ok: true, user })
    }
    const status = body?.status === 'active' ? 'active' : body?.status === 'disabled' ? 'disabled' : null
    if (!status) return NextResponse.json({ ok: false, error: 'Valid status required' }, { status: 400 })
    const user = await setAppUserStatus({
      actorEmail: actor,
      email: body?.email,
      organizationId: body?.organizationId,
      status,
    })
    if (status === 'disabled') {
      if (!user.organizationId) throw new Error('User workspace assignment is missing')
      await revokeBrowserSessionsForUserWorkspace({
        userEmail: user.email,
        organizationId: user.organizationId,
        actor: actor.email,
        reason: 'workspace_access_disabled',
      })
    }
    return NextResponse.json({ ok: true, user })
  } catch (error) {
    return userMutationErrorResponse(error, 'Unable to update user')
  }
}
