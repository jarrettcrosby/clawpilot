export const DEMO_SYSTEM_EMAIL = 'demo-system@clawpilot.example'
export const DEMO_WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'
export const DEMO_PIPELINE_ID = '20000000-0000-4000-8000-000000000001'
export const DEMO_BOARD_ID = '30000000-0000-4000-8000-000000000001'

export function isDemoWorkspaceId(value: unknown): boolean {
  return String(value || '').toLowerCase() === DEMO_WORKSPACE_ID
}

export function demoMutationIsRestricted(
  pathname: string,
  method: string,
  activeWorkspaceOrganizationId: unknown,
): boolean {
  if (!isDemoWorkspaceId(activeWorkspaceOrganizationId)) return false
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false
  return ![
    '/api/auth/logout',
    '/api/auth/session/activity',
    '/api/auth/workspace',
  ].includes(pathname)
}
