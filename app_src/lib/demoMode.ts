export const DEMO_USER_EMAIL = 'demo@clawpilot.example'

export function isDemoMode(): boolean {
  return process.env.CLAWPILOT_DEMO_MODE === '1'
}

export function isDemoEnvironment(): boolean {
  return isDemoMode() && String(process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'demo'
}

export function assertDemoEnvironment(): void {
  if (!isDemoEnvironment()) throw new Error('Demo mode is unavailable in this environment')
}

export function demoMutationIsRestricted(pathname: string, method: string): boolean {
  if (!isDemoMode() || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return false
  const restricted = [
    '/api/users',
    '/api/workspaces',
    '/api/invitations',
    '/api/settings/',
    '/api/integrations/',
    '/api/agents/',
    '/api/agents/auth',
    '/api/auth/impersonation',
    '/api/auth/sessions',
    '/api/railway-backups',
  ]
  return restricted.some((prefix) => pathname === prefix || pathname.startsWith(prefix))
}
