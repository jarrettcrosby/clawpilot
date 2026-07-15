import { NextRequest, NextResponse } from 'next/server'
import { disconnectChatGPT } from '@/lib/agents/chatgptAuth'
import { createUserInvitation } from '@/lib/invitations'
import { ensurePrimaryWorkspaceOrganization } from '@/lib/organizations'
import { ensureDefaultResourcesForUser } from '@/lib/tenancy'
import { syncAppUserProfileToOwnedPipelines } from '@/lib/persistence/crm'
import { sessionEmail } from '@/lib/requestUser'
import {
  AppUserAuthorizationError,
  AppUserNotFoundError,
  canInviteUsers,
  canManageUserAccess,
  listAppUsers,
  setAppUserStatus,
  updateAppUserAccess,
  updateAppUserProfile,
} from '@/lib/users'

function userMutationErrorStatus(error: unknown): number {
  if (error instanceof AppUserAuthorizationError) return 403
  if (error instanceof AppUserNotFoundError) return 404
  if (error instanceof Error && error.message.includes('already being sent')) return 409
  return 400
}

export async function GET(req: NextRequest) {
  const email = sessionEmail(req)
  if (!email) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const currentOrganization = await ensurePrimaryWorkspaceOrganization(email)
    await ensureDefaultResourcesForUser(email)
    const { actor, users } = await listAppUsers(email)
    return NextResponse.json({
      ok: true,
      currentUser: actor,
      currentOrganization,
      isAdmin: actor.role === 'owner' || actor.role === 'admin',
      canInvite: canInviteUsers(actor),
      canManageUserAccess: canManageUserAccess(actor),
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
    const invitation = await createUserInvitation({ actorEmail, email: body?.email })
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
  const actorEmail = sessionEmail(req)
  if (!actorEmail) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    if (body?.action === 'profile') {
      await ensurePrimaryWorkspaceOrganization(actorEmail)
      await ensureDefaultResourcesForUser(actorEmail)
      const user = await updateAppUserProfile({
        actorEmail,
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
        actorEmail,
        email: body.email,
        role: body.role === 'admin' ? 'admin' : body.role === 'member' ? 'member' : undefined,
        permissions: body.permissions,
      })
      return NextResponse.json({ ok: true, user })
    }
    const status = body?.status === 'active' ? 'active' : body?.status === 'disabled' ? 'disabled' : null
    if (!status) return NextResponse.json({ ok: false, error: 'Valid status required' }, { status: 400 })
    const user = await setAppUserStatus({ actorEmail, email: body?.email, status })
    if (status === 'disabled') await disconnectChatGPT(user.email).catch(() => undefined)
    return NextResponse.json({ ok: true, user })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update user'
    return NextResponse.json({ ok: false, error: message }, { status: userMutationErrorStatus(error) })
  }
}
