import {
  effectiveAuthorizationRole,
  effectiveUserPermissions,
  type AppUser,
} from '@/lib/users'

export type AccountingCapabilities = {
  canView: boolean
  canManage: boolean
  canPrepare: boolean
  canApprove: boolean
}

export function accountingCapabilities(actor: AppUser): AccountingCapabilities {
  const role = effectiveAuthorizationRole(actor)
  const permissions = effectiveUserPermissions(actor)
  const canView = role === 'owner' || permissions.viewAccounting
  return {
    canView,
    canManage: role === 'owner' || (role === 'admin' && permissions.manageUserAccess),
    canPrepare: canView && (role === 'owner' || permissions.prepareAccounting),
    canApprove: canView && (role === 'owner' || (role === 'admin' && permissions.approveAccounting)),
  }
}

export function activeAccountingOrganizationId(actor: AppUser): string {
  const organizationId = String(actor.organizationId || '').trim()
  if (!organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
  return organizationId
}
