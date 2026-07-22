import { effectiveAuthorizationRole, effectiveUserPermissions, type AppUser } from '@/lib/users'

export type OperationsCapabilities = {
  canView: boolean
  canManage: boolean
  canExecute: boolean
  canActivate: boolean
}

export function operationsCapabilities(user: AppUser): OperationsCapabilities {
  const role = effectiveAuthorizationRole(user)
  const permissions = effectiveUserPermissions(user)
  return {
    canView: role === 'owner' || permissions.viewOperations === true,
    canManage: role === 'owner' || ((role === 'admin' || role === 'member') && permissions.manageOperations === true),
    canExecute: role === 'owner' || permissions.executeWarehouse === true,
    canActivate: role === 'owner' || (role === 'admin' && permissions.manageOperations === true),
  }
}

export function requireOperationsCapability(user: AppUser, capability: keyof OperationsCapabilities) {
  if (!operationsCapabilities(user)[capability]) {
    throw new Error('OPERATIONS_FORBIDDEN')
  }
}

export function activeOperationsOrganizationId(user: AppUser): string {
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
  return organizationId
}
