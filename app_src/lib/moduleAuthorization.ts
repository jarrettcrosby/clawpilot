import 'server-only'
import type { NextRequest } from 'next/server'
import { moduleAccessFromPermissions, type AppModuleId } from '@/lib/moduleAccess'
import { effectiveUserPermissions, type AppUser } from '@/lib/users'

export class ModuleAccessError extends Error {
  readonly status = 403
  readonly code = 'MODULE_VIEW_REQUIRED'
  constructor(public readonly module: AppModuleId) {
    super('Your organization administrator has not granted access to this module.')
  }
}

export function moduleCapabilitiesForUser(actor: AppUser) {
  // A durable workspace must be authorized by its membership, never by a
  // global owner/admin role when the membership payload is missing.
  if (actor.organizationId && (!actor.organizationRole || !actor.organizationPermissions)) {
    throw new Error('Workspace permission validation unavailable')
  }
  return moduleAccessFromPermissions(effectiveUserPermissions(actor))
}

export function requireModuleAccess(actor: AppUser, module: AppModuleId): void {
  if (!moduleCapabilitiesForUser(actor)[module]) throw new ModuleAccessError(module)
}

// Browser module endpoints only. Mixed-use worker/public routes are bypassed
// by their existing verified authentication path, never by a client header here.
export function moduleForApiPath(pathname: string): AppModuleId | null {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/api/docs' || path.startsWith('/api/docs/') || path === '/api/docs-sync') return 'docs'
  if (path === '/api/tasks' || path.startsWith('/api/tasks/') || path === '/api/deleted-tasks' || path.startsWith('/api/checklist/') || path === '/api/task-creation-audit/summary') return 'projects'
  if (path === '/api/crm' || path.startsWith('/api/crm/') || path.startsWith('/crm/') || path === '/api/pipeline' || path.startsWith('/api/pipeline/')) return 'crm'
  if (path === '/api/accounting' || path.startsWith('/api/accounting/') || path === '/api/pos' || path.startsWith('/api/pos/')) return 'accounting'
  if (path === '/api/shortlinks' || path === '/api/shortlinks/preferences') return 'links'
  if (path === '/api/agents' || path.startsWith('/api/agents/') || path.startsWith('/api/execution-') || path === '/api/freeze' || path === '/api/nightly-status') return 'agents'
  if (path === '/api/versions' || path === '/api/railway-backups') return 'versions'
  return null
}

// Agents can be configured without Projects access, but task-backed browser
// endpoints require both modules in addition to their existing board ACLs.
// Verified worker branches retain their separate authorization before this gate.
export function requiredModulesForApiPath(pathname: string): readonly AppModuleId[] {
  const primary = moduleForApiPath(pathname)
  if (!primary) return []
  const path = pathname.replace(/\/+$/, '')
  if (path === '/api/agents/docs-bootstrap') return [primary, 'docs']
  const taskBacked = path === '/api/agents/threads'
    || path === '/api/agents/assignments'
    || path === '/api/agents/repository-runs'
    || /^\/api\/execution-(runs|results|threads)(\/|$)/.test(path)
    || path === '/api/execution-selftest'
    || path === '/api/execution-queue-selftest'
  return taskBacked ? [primary, 'projects'] : [primary]
}

export function requireRequestModuleAccess(req: Pick<NextRequest, 'url'>, actor: AppUser) {
  for (const moduleId of requiredModulesForApiPath(new URL(req.url).pathname)) requireModuleAccess(actor, moduleId)
  return actor
}
