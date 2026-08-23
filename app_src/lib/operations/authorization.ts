import { effectiveAuthorizationRole, effectiveUserPermissions, type AppUser } from '@/lib/users'

export type OperationsCapabilities = {
  canView: boolean
  canManage: boolean
  canExecute: boolean
  canActivate: boolean
}

export type ShippingCapabilities = {
  canView: boolean
  canCreate: boolean
  canPurchaseLivePostage: boolean
}

export type CarrierRateNetworkCapabilities = {
  canManageNetworks: boolean
  canGrantRateAccess: boolean
  canViewCarrierCost: boolean
  canReconcileCarrierBilling: boolean
  canApproveCarrierSettlement: boolean
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

export function shippingCapabilities(user: AppUser): ShippingCapabilities {
  const role = effectiveAuthorizationRole(user)
  const permissions = effectiveUserPermissions(user)
  const canView = role === 'owner' || permissions.viewShipping === true
  const canCreate = role === 'owner' || (
    (role === 'admin' || role === 'member')
    && canView
    && permissions.createShipments === true
  )
  return {
    canView,
    canCreate,
    canPurchaseLivePostage: role === 'owner' || (
      (role === 'admin' || role === 'member')
      && canCreate
      && permissions.purchaseLivePostage === true
    ),
  }
}

export function carrierRateNetworkCapabilities(user: AppUser): CarrierRateNetworkCapabilities {
  const role = effectiveAuthorizationRole(user)
  const permissions = effectiveUserPermissions(user)
  const isOwner = role === 'owner'
  const isAdministrator = role === 'admin'
  const canViewCarrierCost = isOwner || permissions.viewCarrierCost === true
  return {
    canManageNetworks: isOwner || (isAdministrator && permissions.manageCarrierRateNetworks === true),
    canGrantRateAccess: isOwner || (isAdministrator && permissions.grantCarrierRateAccess === true),
    canViewCarrierCost,
    canReconcileCarrierBilling: canViewCarrierCost && (
      isOwner || permissions.reconcileCarrierBilling === true
    ),
    canApproveCarrierSettlement: canViewCarrierCost && (
      isOwner || (isAdministrator && permissions.approveCarrierSettlement === true)
    ),
  }
}

export function requireOperationsCapability(user: AppUser, capability: keyof OperationsCapabilities) {
  if (!operationsCapabilities(user)[capability]) {
    throw new Error('OPERATIONS_FORBIDDEN')
  }
}

export function requireShippingCapability(user: AppUser, capability: keyof ShippingCapabilities) {
  if (!shippingCapabilities(user)[capability]) {
    throw new Error('SHIPPING_FORBIDDEN')
  }
}

export function requireCarrierRateNetworkCapability(
  user: AppUser,
  capability: keyof CarrierRateNetworkCapabilities,
) {
  if (!carrierRateNetworkCapabilities(user)[capability]) {
    throw new Error('CARRIER_RATE_NETWORK_FORBIDDEN')
  }
}

export function activeOperationsOrganizationId(user: AppUser): string {
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
  return organizationId
}
