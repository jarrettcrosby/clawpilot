// Browser-safe settings DTOs. No native IDs, matrices, ledger rows or provider
// configuration are accepted from or serialized to the browser.
export type RootCrmSettingsRequest =
  | { action: 'configure'; enabled: boolean; workspaceIds: string[]; registryVersion: string }
  | { action: 'employee'; userEmail: string; enabled: boolean; registryVersion: string }
  | { action: 'resume'; transitionId: string }
export type RootCrmSettings = {
  workspaceId: string; workspaceName: string; registryVersion: string
  configured: boolean; enabled: boolean
  workspaces: Array<{ id: string; name: string; selected: boolean; available: boolean }>
  employees: Array<{ email: string; displayName: string | null; status: string; enabled: boolean; crmAllowed: boolean }>
  pending: { transitionId: string; changes: number } | null
}
export class RootCrmSettingsError extends Error {
  constructor(message: string, readonly status: number = 400, readonly code = 'ROOT_CRM_SETTINGS_INVALID') {
    super(message); this.name = 'RootCrmSettingsError'
  }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/
const HASH = /^[a-f0-9]{64}(?![\s\S])/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/
export function parseRootCrmSettingsRequest(value: unknown): RootCrmSettingsRequest {
  const invalid = () => { throw new RootCrmSettingsError('Check the CRM access settings and refresh before saving.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(',')
  if (input.action === 'resume') {
    if (keys !== 'action,transitionId' || typeof input.transitionId !== 'string' || !HASH.test(input.transitionId)) return invalid()
    return { action: 'resume', transitionId: input.transitionId }
  }
  if (typeof input.enabled !== 'boolean' || typeof input.registryVersion !== 'string' || !HASH.test(input.registryVersion)) return invalid()
  if (input.action === 'configure') {
    if (keys !== 'action,enabled,registryVersion,workspaceIds' || !Array.isArray(input.workspaceIds) || input.workspaceIds.length < 1
      || input.workspaceIds.length > 100 || !input.workspaceIds.every(id => typeof id === 'string' && UUID.test(id))
      || new Set(input.workspaceIds).size !== input.workspaceIds.length) return invalid()
    return { action: 'configure', enabled: input.enabled, registryVersion: input.registryVersion, workspaceIds: [...input.workspaceIds].sort() }
  }
  if (input.action === 'employee') {
    if (keys !== 'action,enabled,registryVersion,userEmail' || typeof input.userEmail !== 'string' || input.userEmail.length > 320
      || input.userEmail !== input.userEmail.toLowerCase() || !EMAIL.test(input.userEmail)) return invalid()
    return { action: 'employee', enabled: input.enabled, registryVersion: input.registryVersion, userEmail: input.userEmail }
  }
  return invalid()
}
