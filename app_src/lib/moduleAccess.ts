// Client-safe permission metadata. Never import the server user/database helpers here.
import type { AppUserPermissions } from '@/lib/users'

export const APP_MODULE_IDS = ['dashboard', 'docs', 'projects', 'pipeline', 'crm', 'accounting', 'pos', 'operations', 'shipping', 'links', 'agents', 'versions'] as const
export type AppModuleId = typeof APP_MODULE_IDS[number]
export type ModuleCapabilities = Record<AppModuleId, boolean>
export type ModulePermissionKey = keyof AppUserPermissions

export const MODULE_PERMISSION_GROUPS: ReadonlyArray<{
  id: string
  title: string
  description?: string
  permissionKeys: readonly ModulePermissionKey[]
}> = [
  { id: 'docs', title: 'Docs', permissionKeys: ['viewDocs'] },
  { id: 'projects', title: 'Projects', permissionKeys: ['viewProjects', 'createBoards'] },
  { id: 'crm', title: 'Pipeline and CRM', description: 'Pipeline and CRM share the same sales records and access setting.', permissionKeys: ['viewCrm', 'createPipelines'] },
  { id: 'accounting', title: 'Accounting and POS', description: 'POS reporting and accounting share financial data and access settings.', permissionKeys: ['viewAccounting', 'prepareAccounting', 'approveAccounting'] },
  { id: 'operations', title: 'Operations', permissionKeys: ['viewOperations', 'manageOperations', 'executeWarehouse'] },
  { id: 'shipping', title: 'Shipping', permissionKeys: ['viewShipping', 'createShipments', 'purchaseLivePostage'] },
  { id: 'carrier-billing', title: 'Carrier rates and billing', description: 'Shared by Operations and Shipping; existing carrier billing access is independent of Shipping view.', permissionKeys: ['manageCarrierRateNetworks', 'grantCarrierRateAccess', 'viewCarrierCost', 'reconcileCarrierBilling', 'approveCarrierSettlement'] },
  { id: 'links', title: 'Links', permissionKeys: ['viewLinks', 'manageLinks'] },
  { id: 'agents', title: 'Agents', permissionKeys: ['viewAgents'] },
  { id: 'versions', title: 'Versions and checkpoints', permissionKeys: ['viewVersions', 'viewFullReleaseHistory', 'manageBackups'] },
  { id: 'administration', title: 'Administration and activity', permissionKeys: ['accessDemo', 'inviteUsers', 'manageUserAccess', 'viewOrganizationAudit', 'viewSystemAudit'] },
]

export function moduleAccessFromPermissions(permissions: Partial<AppUserPermissions>): ModuleCapabilities {
  return {
    dashboard: true,
    docs: permissions.viewDocs !== false,
    projects: permissions.viewProjects !== false,
    pipeline: permissions.viewCrm !== false,
    crm: permissions.viewCrm !== false,
    accounting: permissions.viewAccounting === true,
    pos: permissions.viewAccounting === true,
    operations: permissions.viewOperations === true,
    shipping: permissions.viewShipping === true,
    links: permissions.viewLinks !== false,
    agents: permissions.viewAgents !== false,
    versions: permissions.viewVersions !== false,
  }
}

// Session payloads are authority, not legacy permission documents: missing or
// malformed values must not temporarily expose a module during client loading.
export function validatedModuleCapabilities(value: unknown): ModuleCapabilities {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(APP_MODULE_IDS.map((id) => [id, id === 'dashboard' || input[id] === true])) as ModuleCapabilities
}

export function modulePermissionDependencies<T extends Partial<AppUserPermissions>>(current: T, key: ModulePermissionKey, enabled: boolean): T {
  const next = { ...current, [key]: enabled }
  const dependencies: Partial<Record<ModulePermissionKey, readonly ModulePermissionKey[]>> = {
    createBoards: ['viewProjects'], createPipelines: ['viewCrm'],
    prepareAccounting: ['viewAccounting'], approveAccounting: ['viewAccounting'],
    manageOperations: ['viewOperations'], executeWarehouse: ['viewOperations'],
    createShipments: ['viewShipping'], purchaseLivePostage: ['viewShipping', 'createShipments'],
    manageLinks: ['viewLinks'], viewFullReleaseHistory: ['viewVersions'], manageBackups: ['viewVersions'],
    reconcileCarrierBilling: ['viewCarrierCost'], approveCarrierSettlement: ['viewCarrierCost'],
  }
  if (enabled) for (const dependency of dependencies[key] || []) Object.assign(next, { [dependency]: true })
  else for (const [dependent, requirements] of Object.entries(dependencies)) {
    if (requirements?.includes(key)) Object.assign(next, { [dependent]: false })
  }
  return next
}
