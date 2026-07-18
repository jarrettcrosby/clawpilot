export const WORKSPACE_CHANGED_EVENT = 'clawpilot:workspace-changed'

export type WorkspaceChangedDetail = {
  organizationId: string
  organizationName: string
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
