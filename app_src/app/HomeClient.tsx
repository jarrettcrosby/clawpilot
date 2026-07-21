'use client'

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import Navigation from '@/components/Navigation'
import AppHeader from '@/components/AppHeader'
import DocsSection from '@/components/docs/DocsSection'
import KanbanBoard from '@/components/projects/KanbanBoard'
import VersionsSection from '@/components/versions/VersionsSection'
import DashboardSection from '@/components/dashboard/DashboardSection'
import PipelineSection from '@/components/pipeline/PipelineSection'
import AgentsSection from '@/components/agents/AgentsSection'
import ShortLinksSection from '@/components/links/ShortLinksSection'
import CrmSection from '@/components/crm/CrmSection'
import AccountingSection from '@/components/accounting/AccountingSection'
import PosSection from '@/components/pos/PosSection'
import ShortcutsModal from '@/components/help/ShortcutsModal'
import SessionGuard from '@/components/auth/SessionGuard'
import ImpersonationBanner from '@/components/auth/ImpersonationBanner'
import { Box } from '@mui/material'
import type { BoardFilter } from '@/components/projects/FilterBar'
import { emptyFilter } from '@/components/projects/FilterBar'
import { WORKSPACE_CHANGED_EVENT, type WorkspaceChangedDetail } from '@/lib/workspaceClient'
import { accountingSectionFromNavigationUrl } from '@/lib/accountingDraftNavigation'

const SECTIONS = ['dashboard', 'docs', 'projects', 'pipeline', 'crm', 'accounting', 'pos', 'links', 'agents', 'versions']
const DESKTOP_NAV_COLLAPSED_KEY = 'clawpilot_desktop_nav_collapsed'
const DESKTOP_NAV_PREFERENCE_EVENT = 'clawpilot:desktop-nav-preference'

function getSectionFromHash(): string {
  if (typeof window === 'undefined') return 'dashboard'
  const accountingSection = accountingSectionFromNavigationUrl(window.location.href)
  if (accountingSection) return accountingSection
  const hash = window.location.hash.replace('#', '')
  return SECTIONS.includes(hash) ? hash : 'dashboard'
}

function subscribeToHashChange(onStoreChange: () => void) {
  window.addEventListener('hashchange', onStoreChange)
  return () => window.removeEventListener('hashchange', onStoreChange)
}

function getDesktopNavCollapsed(): boolean {
  try {
    return localStorage.getItem(DESKTOP_NAV_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function subscribeToDesktopNavPreference(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange)
  window.addEventListener(DESKTOP_NAV_PREFERENCE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', onStoreChange)
    window.removeEventListener(DESKTOP_NAV_PREFERENCE_EVENT, onStoreChange)
  }
}

export default function HomeClient({
  shortLinksEnabled,
  sessionGuardEnabled,
}: {
  shortLinksEnabled: boolean
  sessionGuardEnabled: boolean
}) {
  // Always init 'dashboard' to match SSR. useEffect corrects to real hash post-hydration.
  const activeSection = useSyncExternalStore(subscribeToHashChange, getSectionFromHash, () => 'dashboard')
  const desktopNavCollapsed = useSyncExternalStore(
    subscribeToDesktopNavPreference,
    getDesktopNavCollapsed,
    () => false,
  )
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [boardFilter, setBoardFilter] = useState<BoardFilter>(emptyFilter())
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)

  const toggleDesktopNav = useCallback(() => {
    try {
      localStorage.setItem(DESKTOP_NAV_COLLAPSED_KEY, String(!getDesktopNavCollapsed()))
      window.dispatchEvent(new Event(DESKTOP_NAV_PREFERENCE_EVENT))
    } catch {}
  }, [])

  function navigateWithFilter(section: string, filter?: BoardFilter) {
    navigate(section)
    if (filter) setBoardFilter(filter as import('@/components/projects/FilterBar').BoardFilter)
    else setBoardFilter(emptyFilter())
  }

  // Client error reporting (helps debug iOS Safari exceptions)
  useEffect(() => {
    const report = (payload: Record<string, unknown>) => {
      try {
        fetch('/api/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            href: window.location.href,
            ua: navigator.userAgent,
            ...payload,
          }),
        }).catch(() => {})
      } catch {}
    }

    const onError = (event: ErrorEvent) => {
      report({
        kind: 'error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: (event.error && (event.error.stack || String(event.error))) || null,
      })
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      report({
        kind: 'unhandledrejection',
        reason: (event.reason && (event.reason.stack || String(event.reason))) || String(event.reason),
      })
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  // Navigate and push to browser history
  const navigate = useCallback((section: string) => {
    setMobileNavOpen(false)
    window.location.hash = section
  }, [])

  useEffect(() => {
    if (!shortLinksEnabled && activeSection === 'links') navigate('dashboard')
  }, [activeSection, navigate, shortLinksEnabled])

  useEffect(() => {
    function onWorkspaceChanged(event: Event) {
      const detail = (event as CustomEvent<WorkspaceChangedDetail>).detail
      setMobileNavOpen(false)
      setBoardFilter(emptyFilter())
      setActiveWorkspaceId(detail?.organizationId || null)
      setWorkspaceRevision((revision) => revision + 1)
    }
    window.addEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChanged)
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChanged)
  }, [])

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      const isTyping = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable
      if (isTyping) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key) {
        case '?': setShortcutsOpen(true); break
        case 'Escape': setShortcutsOpen(false); break
        case '1': navigate('dashboard'); break
        case '2': navigate('docs'); break
        case '3': navigate('projects'); break
        case '4': navigate('pipeline'); break
        case '5': navigate('agents'); break
        case '6': navigate('versions'); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  const section = activeSection

  return (
    <Box
      data-testid="app-shell"
      display="flex"
      height="100dvh"
      width="100%"
      sx={{
        '--mobile-navigation-height': '64px',
        '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
          '--mobile-navigation-height': '52px',
        },
        maxWidth: '100vw',
        backgroundColor: '#0F0F13',
        overflow: 'hidden',
      }}
    >
      <Navigation
        activeSection={section}
        onNavigate={navigate}
        collapsed={desktopNavCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileOpen={() => setMobileNavOpen(true)}
        onMobileClose={() => setMobileNavOpen(false)}
        showLinks={shortLinksEnabled}
      />
      <Box
        data-testid="app-content"
        flex={1}
        display="flex"
        flexDirection="column"
        overflow="hidden"
        minWidth={0}
      >
        <SessionGuard enabled={sessionGuardEnabled} />
        <AppHeader
          activeSection={section}
          workspaceRevision={workspaceRevision}
          desktopNavCollapsed={desktopNavCollapsed}
          mobileNavOpen={mobileNavOpen}
          onToggleDesktopNav={toggleDesktopNav}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <ImpersonationBanner />
        <Box
          key={`workspace-${workspaceRevision}`}
          sx={{
            flex: 1,
            overflow: ['docs', 'projects', 'pipeline', 'crm', 'accounting', 'pos'].includes(section) ? 'hidden' : 'auto',
            pb: ['docs', 'projects', 'pipeline', 'crm', 'accounting', 'pos'].includes(section)
              ? { xs: 'calc(var(--mobile-navigation-height) + env(safe-area-inset-bottom) + 8px)', md: 0 }
              : { xs: 'calc(var(--mobile-navigation-height) + env(safe-area-inset-bottom) + 16px)', md: 2 },
          }}
        >
          {section === 'dashboard' && (
            <Box sx={{ height: '100%', overflow: 'auto' }}>
              <DashboardSection
                onNavigate={navigate}
                onNavigateWithFilter={navigateWithFilter}
                initialWorkspaceId={activeWorkspaceId}
              />
            </Box>
          )}
          {section === 'docs' && (
            <Box height="100%" overflow="hidden">
              <DocsSection />
            </Box>
          )}
          {section === 'projects' && (
            <Box sx={{ height: '100%', overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <KanbanBoard externalFilter={boardFilter} onFilterChange={setBoardFilter} />
            </Box>
          )}
          {section === 'pipeline' && (
            <Box sx={{ height: '100%', overflow: 'hidden' }}>
              <PipelineSection />
            </Box>
          )}
          {section === 'crm' && (
            <Box sx={{ height: '100%', overflow: 'hidden' }}>
              <CrmSection />
            </Box>
          )}
          {section === 'accounting' && (
            <Box sx={{ height: '100%', overflow: 'hidden' }}>
              <AccountingSection />
            </Box>
          )}
          {section === 'pos' && (
            <Box sx={{ height: '100%', overflow: 'hidden' }}>
              <PosSection />
            </Box>
          )}
          {shortLinksEnabled && section === 'links' && (
            <Box sx={{ height: '100%', overflow: 'auto' }}>
              <ShortLinksSection />
            </Box>
          )}
          {section === 'versions' && (
            <Box sx={{ height: '100%', overflow: 'auto' }}>
              <VersionsSection />
            </Box>
          )}
          {section === 'agents' && (
            <Box sx={{ height: '100%', overflow: 'auto' }}>
              <AgentsSection />
            </Box>
          )}
        </Box>
      </Box>

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </Box>
  )
}
