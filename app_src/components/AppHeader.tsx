'use client'

import { useEffect, useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Badge from '@mui/material/Badge'
import Drawer from '@mui/material/Drawer'
import Chip from '@mui/material/Chip'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Divider from '@mui/material/Divider'
import Popover from '@mui/material/Popover'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import Button from '@mui/material/Button'
import NotificationsRounded from '@mui/icons-material/NotificationsRounded'
import MenuRounded from '@mui/icons-material/MenuRounded'
import SettingsRounded from '@mui/icons-material/SettingsRounded'
import KeyboardRounded from '@mui/icons-material/KeyboardRounded'
import InfoRounded from '@mui/icons-material/InfoRounded'
import LogoutRounded from '@mui/icons-material/LogoutRounded'
import GroupRounded from '@mui/icons-material/GroupRounded'
import ActivityLogPage from '@/components/activity/ActivityLogPage'
import ShortcutsModal from '@/components/help/ShortcutsModal'
import UserAccessDialog from '@/components/settings/UserAccessDialog'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'
import ActiveWorkspaceSwitcher from '@/components/workspaces/ActiveWorkspaceSwitcher'

type ActivityPreview = { id: string }

const READ_KEY = 'clawpilot_read_log'
function getReadCount(events: ActivityPreview[]): number {
  try {
    const read = new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]'))
    return events.filter((event) => !read.has(event.id)).length
  } catch { return 0 }
}

const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  docs: 'Docs',
  projects: 'Projects',
  pipeline: 'Pipeline',
  crm: 'CRM',
  accounting: 'Accounting',
  pos: 'POS',
  operations: 'Operations',
  links: 'Short Links',
  agents: 'Agents',
  versions: 'Versions',
}

type Props = {
  activeSection: string
  workspaceRevision: number
  title?: string
  onShortcutsOpen?: () => void
  desktopNavCollapsed: boolean
  mobileNavOpen: boolean
  onToggleDesktopNav: () => void
  onOpenMobileNav: () => void
}

export default function AppHeader({
  activeSection,
  workspaceRevision,
  title,
  onShortcutsOpen,
  desktopNavCollapsed,
  mobileNavOpen,
  onToggleDesktopNav,
  onOpenMobileNav,
}: Props) {
  const dateTimeSettings = useUserDateTime()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activityState, setActivityState] = useState<{
    workspaceRevision: number
    events: ActivityPreview[]
  }>({ workspaceRevision: 0, events: [] })
  const [helpAnchor, setHelpAnchor] = useState<null | HTMLElement>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [health, setHealth] = useState<{ status: string; errors: string[] }>({ status: 'ok', errors: [] })
  const [healthAnchor, setHealthAnchor] = useState<null | HTMLElement>(null)
  const [buildInfo, setBuildInfo] = useState<{ short: string; hash: string; subject: string; date: string; dirty: boolean; dirtyCount: number } | null>(null)
  const [buildOpen, setBuildOpen] = useState(false)
  const [userAccessOpen, setUserAccessOpen] = useState(false)
  const [runtimeInfo, setRuntimeInfo] = useState<{
    lane: string
    port: string
    commit: string
    branch?: string | null
    environment?: string | null
    provider?: string
    repoPath?: string
  } | null>(null)
  const [runtimeAnchor, setRuntimeAnchor] = useState<null | HTMLElement>(null)
  const [freezeState, setFreezeState] = useState<{ frozen: boolean; reason?: string | null } | null>(null)

  const unreadCount = useMemo(() => {
    if (drawerOpen || activityState.workspaceRevision !== workspaceRevision) return 0
    return getReadCount(activityState.events)
  }, [activityState, drawerOpen, workspaceRevision])

  useEffect(() => {
    let active = true
    fetch('/api/activity?limit=100', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return [] as ActivityPreview[]
        const payload = await response.json() as { events?: ActivityPreview[] }
        return Array.isArray(payload.events) ? payload.events : []
      })
      .then((events) => {
        if (active) setActivityState({ workspaceRevision, events })
      })
      .catch(() => {
        if (active) setActivityState({ workspaceRevision, events: [] })
      })
    return () => { active = false }
  }, [drawerOpen, workspaceRevision])

  useEffect(() => {
    function check() {
      fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {})
    }
    check()
    const t = setInterval(check, 60000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    // Build/version info (git)
    fetch('/api/version').then(r => r.json()).then(setBuildInfo).catch(() => {})
    fetch('/api/runtime').then(r => r.json()).then(setRuntimeInfo).catch(() => {})
    fetch('/api/freeze').then(r => r.json()).then(setFreezeState).catch(() => {})
  }, [])

  // Allow parent to open shortcuts via prop
  useEffect(() => {
    if (onShortcutsOpen) {
      // will be triggered externally via ref pattern — handled in page.tsx
    }
  }, [onShortcutsOpen])

  const label = title || MODULE_LABELS[activeSection] || activeSection

  function openShortcuts() {
    setHelpAnchor(null)
    setShortcutsOpen(true)
  }

  return (
    <>
      {freezeState?.frozen && (
        <Box sx={{
          px: { xs: 2, md: 3 },
          py: 0.75,
          backgroundColor: 'rgba(239,83,80,0.15)',
          borderBottom: '1px solid rgba(239,83,80,0.35)',
        }}>
          <Typography variant="caption" color="#EF5350" fontWeight={700}>
            Rollout freeze active{freezeState.reason ? ` — ${freezeState.reason}` : ''}. Writes are temporarily disabled.
          </Typography>
        </Box>
      )}
      <Box data-testid="app-header" sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        px: { xs: 2, md: 3 }, py: 1.25,
        pt: { xs: 'calc(env(safe-area-inset-top) + 10px)', md: 1.25 },
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        minHeight: { xs: 'calc(env(safe-area-inset-top) + 52px)', md: 52 },
        '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
          px: 1,
          py: 0.25,
          pt: 'max(env(safe-area-inset-top), 2px)',
          minHeight: 'calc(env(safe-area-inset-top) + 44px)',
        },
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <Tooltip title="Open navigation">
            <IconButton
              data-testid="mobile-navigation-toggle"
              aria-label="Open navigation menu"
              aria-controls="mobile-navigation-drawer"
              aria-expanded={mobileNavOpen}
              aria-haspopup="dialog"
              onClick={onOpenMobileNav}
              sx={{
                display: { xs: 'inline-flex', md: 'none' },
                color: 'rgba(255,255,255,0.55)',
                p: 1,
                minWidth: 48,
                minHeight: 48,
                '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' },
              }}
            >
              <MenuRounded sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={desktopNavCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <IconButton
              data-testid="desktop-navigation-toggle"
              aria-label={desktopNavCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-controls="desktop-navigation-drawer"
              aria-expanded={!desktopNavCollapsed}
              onClick={onToggleDesktopNav}
              sx={{
                display: { xs: 'none', md: 'inline-flex' },
                color: 'rgba(255,255,255,0.55)',
                p: 1,
                minWidth: 48,
                minHeight: 48,
                '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' },
              }}
            >
              <MenuRounded sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
          <Typography variant="subtitle1" fontWeight={600} color="text.primary" sx={{ fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {label}
          </Typography>
          <ActiveWorkspaceSwitcher />
        </Box>

        <Box display="flex" alignItems="center" gap={0.5}>
          {runtimeInfo && (
            <Tooltip title={`Lane: ${runtimeInfo.lane} • Port: ${runtimeInfo.port} • Commit: ${runtimeInfo.commit.slice(0,7)}`}>
              <Chip
                data-testid="runtime-chip"
                size="small"
                label={`${runtimeInfo.lane}:${runtimeInfo.port}`}
                onClick={(e) => setRuntimeAnchor(e.currentTarget)}
                sx={{ display: { xs: 'none', sm: 'inline-flex' }, height: 22, fontSize: '0.65rem', borderRadius: 1, backgroundColor: 'rgba(168,199,250,0.12)', color: '#A8C7FA', border: '1px solid rgba(168,199,250,0.3)' }}
              />
            </Tooltip>
          )}
          {/* Health indicator */}
          <Tooltip title={health.status === 'ok' ? 'App healthy' : `${health.errors.length} recent error${health.errors.length !== 1 ? 's' : ''} — tap to view`}>
            <IconButton
              onClick={e => setHealthAnchor(e.currentTarget)}
              aria-label="App health"
              sx={{ p: { xs: 1.5, md: 1 }, minWidth: 48, minHeight: 48 }}
            >
              <Box sx={{
                width: 10, height: 10, borderRadius: '50%',
                backgroundColor: health.status === 'ok' ? '#66BB6A' : '#EF5350',
                boxShadow: health.status !== 'ok' ? '0 0 6px #EF5350' : '0 0 4px #66BB6A55',
                animation: health.status !== 'ok' ? 'hpulse 1.5s ease-in-out infinite' : 'none',
                '@keyframes hpulse': {
                  '0%,100%': { opacity: 1, boxShadow: '0 0 6px #EF5350' },
                  '50%': { opacity: 0.5, boxShadow: '0 0 2px #EF5350' },
                },
              }} />
            </IconButton>
          </Tooltip>

          {/* Help button */}
          <Tooltip title="Settings">
            <IconButton
              onClick={(e) => setHelpAnchor(e.currentTarget)}
              aria-label="Settings"
              sx={{ color: 'rgba(255,255,255,0.45)', p: { xs: 1.5, md: 1 }, minWidth: 48, minHeight: 48, '&:hover': { color: '#CFC6EA', backgroundColor: 'rgba(207,198,234,0.08)' } }}
            >
              <SettingsRounded sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>

          {/* Bell */}
          <Tooltip title="Activity log" disableInteractive>
            <IconButton
              onClick={() => setDrawerOpen(true)}
              aria-label="Activity log"
              sx={{ color: unreadCount > 0 ? '#A8C7FA' : 'rgba(255,255,255,0.60)', p: { xs: 1.5, md: 1 }, minWidth: 48, minHeight: 48, '&:hover': { color: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' } }}
            >
              <Badge
                badgeContent={unreadCount}
                max={99}
                sx={{ '& .MuiBadge-badge': { backgroundColor: '#FFA726', color: '#001D36', fontWeight: 700, fontSize: '0.6rem', minWidth: 16, height: 16, padding: '0 4px' } }}>
                <NotificationsRounded sx={{ fontSize: 22 }} />
              </Badge>
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Health popover */}
      <Popover
        open={Boolean(healthAnchor)}
        anchorEl={healthAnchor}
        onClose={() => setHealthAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        PaperProps={{
          sx: {
            backgroundColor: '#1A1A23',
            border: `1px solid ${health.status === 'ok' ? 'rgba(102,187,106,0.3)' : 'rgba(239,83,80,0.3)'}`,
            borderRadius: 2, p: 2, maxWidth: 360, mt: 0.5,
          }
        }}
      >
        <Typography variant="caption" fontWeight={700} color={health.status === 'ok' ? '#66BB6A' : '#EF5350'} display="block" mb={1}>
          {health.status === 'ok' ? '✓ App is healthy' : `⚠ ${health.errors.length} recent error${health.errors.length !== 1 ? 's' : ''}`}
        </Typography>
        {health.errors.length === 0
          ? <Typography variant="caption" color="text.disabled">No errors in recent logs.</Typography>
          : health.errors.map((e, i) => (
            <Typography key={i} variant="caption" color="text.secondary" display="block"
              sx={{ fontFamily: 'monospace', fontSize: 11, mb: 0.5, wordBreak: 'break-all' }}>
              {e.trim()}
            </Typography>
          ))
        }
      </Popover>

      {/* Help menu */}
      <Menu
        anchorEl={helpAnchor}
        open={Boolean(helpAnchor)}
        onClose={() => setHelpAnchor(null)}
        transformOrigin={{ horizontal: 'right', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
        PaperProps={{
          sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, minWidth: 200, mt: 0.5 }
        }}
      >
        <MenuItem
          onClick={() => { setHelpAnchor(null); setBuildOpen(true) }}
          sx={{ py: 1.25, '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' } }}
        >
          <ListItemIcon sx={{ minWidth: 36 }}>
            <InfoRounded sx={{ fontSize: 18, color: 'text.secondary' }} />
          </ListItemIcon>
          <ListItemText
            primary="Build info"
            secondary={buildInfo ? `${buildInfo.short}${buildInfo.dirty ? ' (dirty)' : ''}` : 'Loading…'}
            primaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
            secondaryTypographyProps={{ variant: 'caption', color: 'text.disabled' }}
          />
        </MenuItem>

        <MenuItem onClick={openShortcuts} sx={{ py: 1.25, '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' } }}>
          <ListItemIcon sx={{ minWidth: 36 }}>
            <KeyboardRounded sx={{ fontSize: 18, color: 'text.secondary' }} />
          </ListItemIcon>
          <ListItemText
            primary="Keyboard Shortcuts"
            secondary="Press ? anytime"
            primaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
            secondaryTypographyProps={{ variant: 'caption', color: 'text.disabled' }}
          />
        </MenuItem>

        <MenuItem
          onClick={() => { setHelpAnchor(null); setUserAccessOpen(true) }}
          sx={{ py: 1.25, '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' } }}
        >
          <ListItemIcon sx={{ minWidth: 36 }}>
            <GroupRounded sx={{ fontSize: 18, color: 'text.secondary' }} />
          </ListItemIcon>
          <ListItemText
            primary="Workspace settings"
            secondary="Profile, access and sharing"
            primaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
            secondaryTypographyProps={{ variant: 'caption', color: 'text.disabled' }}
          />
        </MenuItem>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        <MenuItem onClick={async () => {
          setHelpAnchor(null)
          try { await fetch('/api/auth/logout', { method: 'POST' }) } catch {}
          window.location.href = '/login'
        }} sx={{ py: 1.25, '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' } }}>
          <ListItemIcon sx={{ minWidth: 36 }}>
            <LogoutRounded sx={{ fontSize: 18, color: 'text.secondary' }} />
          </ListItemIcon>
          <ListItemText
            primary="Log out"
            secondary="End local session"
            primaryTypographyProps={{ variant: 'body2', color: 'text.primary' }}
            secondaryTypographyProps={{ variant: 'caption', color: 'text.disabled' }}
          />
        </MenuItem>
      </Menu>

      {/* Build info */}
      <Dialog
        open={buildOpen}
        onClose={() => setBuildOpen(false)}
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, width: { xs: '92vw', sm: 520 } } }}
      >
        <DialogTitle sx={{ color: 'text.primary', fontWeight: 700 }}>Build info</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {buildInfo
              ? `${buildInfo.short}${buildInfo.dirty ? ` (dirty: ${buildInfo.dirtyCount})` : ''} — ${buildInfo.subject}`
              : 'Loading…'}
          </Typography>
          {buildInfo && (
            <Typography variant="caption" color="text.disabled" display="block" mt={1} sx={{ fontFamily: 'monospace' }}>
              {buildInfo.hash}
              {'\n'}{formatUserDateTime(buildInfo.date, dateTimeSettings, {
                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: buildInfo.date,
              })}
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setBuildOpen(false)} sx={{ color: 'text.secondary' }}>Close</Button>
        </DialogActions>
      </Dialog>

      <UserAccessDialog open={userAccessOpen} onClose={() => setUserAccessOpen(false)} />

      <Popover
        open={Boolean(runtimeAnchor)}
        anchorEl={runtimeAnchor}
        onClose={() => setRuntimeAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        PaperProps={{ sx: { p: 1.5, backgroundColor: '#12141C', border: '1px solid rgba(255,255,255,0.08)' } }}
      >
        <Typography variant="caption" color="text.secondary" display="block">Lane: {runtimeInfo?.lane || 'unknown'}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Port: {runtimeInfo?.port || 'unknown'}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Commit: {runtimeInfo?.commit?.slice(0,7) || 'unknown'}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Environment: {runtimeInfo?.environment || runtimeInfo?.lane || 'unknown'}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">Branch: {runtimeInfo?.branch || 'local'}</Typography>
      </Popover>

      {/* Shortcuts modal */}
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Activity drawer */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{
          sx: {
            width: { xs: '100vw', sm: 560 },
            maxWidth: '100vw',
            height: '100dvh',
            backgroundColor: '#0F0F13',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
          }
        }}
      >
        <ActivityLogPage
          onClose={() => setDrawerOpen(false)}
        />
      </Drawer>
    </>
  )
}
