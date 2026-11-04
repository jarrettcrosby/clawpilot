import type { AppUserPermissions } from '../users'

/** Complete fail-closed module permissions for computed CRM workspace reads.
 * Never merge MEMBER_PERMISSIONS: its legacy defaults grant unrelated modules
 * and resource creation. Only a real explicit membership can grant those. */
export function rootEmployeeCrmReadPermissions(value: unknown): AppUserPermissions {
  const projects = value && typeof value === 'object' && !Array.isArray(value)
    && 'viewProjects' in value && value.viewProjects === true
  return {
    viewDocs: false, viewProjects: Boolean(projects), viewCrm: true, viewLinks: false,
    viewAgents: false, viewVersions: false, accessDemo: false, inviteUsers: false,
    manageUserAccess: false, createBoards: false, createPipelines: false,
    viewOperations: false, manageOperations: false, executeWarehouse: false,
    viewShipping: false, createShipments: false, purchaseLivePostage: false,
    manageCarrierRateNetworks: false, grantCarrierRateAccess: false, viewCarrierCost: false,
    reconcileCarrierBilling: false, approveCarrierSettlement: false,
    viewFullReleaseHistory: false, manageBackups: false, manageLinks: false,
    viewAccounting: false, prepareAccounting: false, approveAccounting: false,
    viewOrganizationAudit: false, viewSystemAudit: false,
  }
}
