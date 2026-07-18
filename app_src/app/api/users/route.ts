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
import {
  AppUserAuthorizationError,
  AppUserNotFoundError,
  canInviteUsers,
  canManageUserAccess,
  effectiveAuthorizationRole,
  listAppUsers,
  setAppUserStatus,
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

export async function GET(req: NextRequest) {
  try {
    const requestActor = await requireRequestUser(req)
    const currentOrganization = requestActor.organizationId
      ? await workspaceOrganizationById(requestActor.organizationId)
      : null
    if (!currentOrganization) throw new Error('Active workspace is not available')
    await ensureDefaultResourcesForUser(requestActor)
    const { actor, users } = await listAppUsers(requestActor)
    const workspaceOrganizations = await listWorkspaceOrganizationHierarchy(requestActor)
    const organizationRole = effectiveAuthorizationRole(actor)
    return NextResponse.json({
      ok: true,
      currentUser: actor,
      currentOrganization,
      isAdmin: organizationRole === 'owner' || organizationRole === 'admin',
      canInvite: canInviteUsers(actor),
      canManageUserAccess: canManageUserAccess(actor),
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
      createOrganization: body?.createOrganization === true,
      organizationName: body?.organizationName,
      parentOrganizationId: body?.parentOrganizationId,
      crmUserEnabled: body?.crmUserEnabled === true,
    })
    return NextResponse.json({
      ok: true,
      user: invitation.user,
      delivery: invitation.delivery,
      expiresAt: invitation.expiresAt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to invite user'
    return NextResponse.json({ ok: false, error: message }, { status: userMutationErrorStatus(error) })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const body = await req.json()
    if (body?.action === 'crm-employee') {
      let user = await updateAppUserCrmEmployee({
        actorEmail: actor,
        email: body.email,
        organizationId: body.organizationId,
        enabled: body.enabled === true,
      })
      let warning: string | undefined
      let crmIdentitySync: 'queued' | 'not-mapped' = 'not-mapped'
      if (body.enabled === true) {
        try {
          user = await syncAppUserSuiteCrmIdentity({
            actorEmail: actor,
            email: body.email,
            organizationId: body.organizationId,
          })
          crmIdentitySync = 'queued'
        } catch (error) {
          warning = error instanceof Error ? error.message : 'SuiteCRM identity sync is pending'
        }
      }
      return NextResponse.json({ ok: true, user, crmIdentitySync, warning })
    }
    if (body?.action === 'crm-user-sync') {
      const user = await syncAppUserSuiteCrmIdentity({
        actorEmail: actor,
        email: body.email,
        organizationId: body.organizationId,
      })
      return NextResponse.json({ ok: true, user, crmIdentitySync: 'queued' })
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
    const message = error instanceof Error ? error.message : 'Unable to update user'
    return NextResponse.json({ ok: false, error: message }, { status: userMutationErrorStatus(error) })
  }
}
