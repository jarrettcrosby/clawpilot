import type { DashboardBootstrapPayload } from '@/lib/dashboardBootstrapTypes'

export const WORKSPACE_CHANGED_EVENT = 'clawpilot:workspace-changed'
export const WORKSPACE_PREFETCH_TTL_MS = 45_000
const WORKSPACE_PREFETCH_LIMIT = 2
const WORKSPACE_MRU_KEY = 'clawpilot_workspace_mru'

type WorkspaceCandidate = { organizationId: string }
type CachedBootstrap = {
  expiresAt: number
  payload: DashboardBootstrapPayload
}

const bootstrapCache = new Map<string, CachedBootstrap>()
const bootstrapRequests = new Map<string, Promise<DashboardBootstrapPayload | null>>()

export type WorkspaceChangedDetail = {
  organizationId: string
  organizationName: string
}

function readWorkspaceMru(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(WORKSPACE_MRU_KEY) || '[]')
    return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 12) : []
  } catch {
    return []
  }
}

export function rememberWorkspaceVisit(organizationId: string) {
  if (typeof window === 'undefined' || !organizationId) return
  try {
    const next = [organizationId, ...readWorkspaceMru().filter((id) => id !== organizationId)].slice(0, 12)
    window.localStorage.setItem(WORKSPACE_MRU_KEY, JSON.stringify(next))
  } catch {}
}

export function selectWorkspacePrefetchTargets<T extends WorkspaceCandidate>(
  workspaces: T[],
  activeOrganizationId: string,
): T[] {
  const mruRank = new Map(readWorkspaceMru().map((id, index) => [id, index]))
  return workspaces
    .map((workspace, index) => ({ workspace, index }))
    .filter(({ workspace }) => workspace.organizationId !== activeOrganizationId)
    .sort((left, right) => {
      const leftRank = mruRank.get(left.workspace.organizationId) ?? Number.MAX_SAFE_INTEGER
      const rightRank = mruRank.get(right.workspace.organizationId) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || left.index - right.index
    })
    .slice(0, WORKSPACE_PREFETCH_LIMIT)
    .map(({ workspace }) => workspace)
}

export function readWorkspaceBootstrap(organizationId: string): DashboardBootstrapPayload | null {
  const cached = bootstrapCache.get(organizationId)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    bootstrapCache.delete(organizationId)
    return null
  }
  return cached.payload
}

export function prefetchWorkspaceBootstrap(
  organizationId: string,
): Promise<DashboardBootstrapPayload | null> {
  if (typeof window === 'undefined' || !organizationId) return Promise.resolve(null)
  const cached = readWorkspaceBootstrap(organizationId)
  if (cached) return Promise.resolve(cached)
  const pending = bootstrapRequests.get(organizationId)
  if (pending) return pending

  const request = fetch(
    `/api/auth/workspace/prefetch?organizationId=${encodeURIComponent(organizationId)}`,
    { cache: 'no-store' },
  )
    .then(async (response) => {
      if (!response.ok) return null
      const payload = await response.json() as DashboardBootstrapPayload
      if (!payload?.ok || payload.organizationId !== organizationId) return null
      bootstrapCache.set(organizationId, {
        expiresAt: Date.now() + WORKSPACE_PREFETCH_TTL_MS,
        payload,
      })
      return payload
    })
    .catch(() => null)
    .finally(() => { bootstrapRequests.delete(organizationId) })
  bootstrapRequests.set(organizationId, request)
  return request
}

export function announceWorkspaceChange(detail: WorkspaceChangedDetail) {
  if (typeof window === 'undefined') return

  const currentUrl = window.location.href
  const target = new URL('/', window.location.origin)
  target.hash = 'dashboard'
  const targetUrl = target.toString()

  if (currentUrl !== targetUrl) {
    window.history.replaceState(window.history.state, '', `${target.pathname}${target.hash}`)
    window.dispatchEvent(new Event('hashchange'))
  }

  window.dispatchEvent(new CustomEvent<WorkspaceChangedDetail>(WORKSPACE_CHANGED_EVENT, {
    detail,
  }))
}
