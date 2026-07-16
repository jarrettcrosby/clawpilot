'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import DevicesRounded from '@mui/icons-material/DevicesRounded'
import LogoutRounded from '@mui/icons-material/LogoutRounded'
import PersonSearchRounded from '@mui/icons-material/PersonSearchRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type BrowserSession = {
  id: string
  authenticatedUser: string
  effectiveUser: string
  deviceLabel: string
  initialIpAddress: string | null
  lastIpAddress: string | null
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  current: boolean
  impersonating: boolean
}
type Target = {
  email: string
  displayName: string | null
  organizationName: string | null
  role: 'admin' | 'member'
}

type SupportPayload = {
  isRootAdmin: boolean
  impersonation: {
    active: boolean
    authenticatedUser?: string
    effectiveUser?: string
    expiresAt?: string | null
  }
  targets: Target[]
}

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error || 'Request failed')
  return payload
}

export default function SessionSecurityPanel() {
  const dateTimeSettings = useUserDateTime()
  const [sessions, setSessions] = useState<BrowserSession[]>([])
  const [support, setSupport] = useState<SupportPayload | null>(null)
  const [targetEmail, setTargetEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const otherSessionCount = useMemo(() => sessions.filter((session) => !session.current).length, [sessions])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [sessionPayload, supportPayload] = await Promise.all([
        requestJson<{ sessions: BrowserSession[] }>('/api/auth/sessions'),
        requestJson<SupportPayload>('/api/auth/impersonation'),
      ])
      setSessions(sessionPayload.sessions || [])
      setSupport(supportPayload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load security settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function revoke(sessionId: string, current: boolean) {
    setPending(`revoke:${sessionId}`)
    setError('')
    try {
      await requestJson('/api/auth/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke', sessionId }),
      })
      if (current) {
        window.location.assign('/login')
        return
      }
      setSessions((items) => items.filter((item) => item.id !== sessionId))
      setNotice('Browser session signed out.')
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Unable to sign out browser')
    } finally {
      setPending('')
    }
  }

  async function revokeOthers() {
    setPending('revoke-others')
    setError('')
    try {
      await requestJson('/api/auth/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke-others' }),
      })
      setSessions((items) => items.filter((item) => item.current))
      setNotice('Other browsers signed out.')
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Unable to sign out other browsers')
    } finally {
      setPending('')
    }
  }

  async function enterUserView() {
    if (!targetEmail) return
    setPending('impersonate')
    setError('')
    try {
      await requestJson('/api/auth/impersonation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetEmail }),
      })
      window.location.reload()
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : 'Unable to enter user view')
      setPending('')
    }
  }

  async function exitUserView() {
    setPending('exit-impersonation')
    setError('')
    try {
      await requestJson('/api/auth/impersonation', { method: 'DELETE' })
      window.location.reload()
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : 'Unable to exit user view')
      setPending('')
    }
  }

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 280, placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Box role="tabpanel" id="settings-panel-4" aria-labelledby="settings-tab-4" sx={{ maxWidth: 760, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Box component="section">
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} mb={1.25}>
          <Stack direction="row" spacing={0.75} alignItems="center">
            <DevicesRounded sx={{ fontSize: 20, color: 'text.secondary' }} />
            <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Browser sessions</Typography>
            <Chip size="small" label={sessions.length} sx={{ height: 24, minHeight: 24 }} />
          </Stack>
          <Button
            size="small"
            variant="outlined"
            startIcon={pending === 'revoke-others' ? <CircularProgress size={15} /> : <LogoutRounded />}
            onClick={() => { void revokeOthers() }}
            disabled={Boolean(pending) || otherSessionCount === 0 || support?.impersonation.active}
            sx={{ borderRadius: '8px', whiteSpace: 'nowrap' }}
          >
            Sign out others
          </Button>
        </Box>

        <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {sessions.map((session) => (
            <Box
              key={session.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                gap: 1.5,
                alignItems: 'center',
                py: 1.5,
                borderBottom: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <Box minWidth={0}>
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="body2" color="text.primary" fontWeight={700}>{session.deviceLabel}</Typography>
                  {session.current ? <Chip size="small" color="primary" label="Current" sx={{ height: 22, minHeight: 22, fontSize: '0.68rem' }} /> : null}
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block">
                  {session.impersonating
                    ? `Signed in as ${session.authenticatedUser} · Viewing as ${session.effectiveUser}`
                    : `Signed in as ${session.authenticatedUser}`}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ overflowWrap: 'anywhere' }}>
                  Last observed IP {session.lastIpAddress || 'Unavailable'}
                </Typography>
                {session.initialIpAddress && session.initialIpAddress !== session.lastIpAddress ? (
                  <Typography variant="caption" color="text.disabled" display="block" sx={{ overflowWrap: 'anywhere' }}>
                    Sign-in IP {session.initialIpAddress}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary" display="block">
                  Last active {formatUserDateTime(session.lastSeenAt, dateTimeSettings, {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown',
                  })}
                </Typography>
                <Typography variant="caption" color="text.disabled" display="block">
                  Signed in {formatUserDateTime(session.createdAt, dateTimeSettings, {
                    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown',
                  })}
                </Typography>
              </Box>
              <Tooltip title={session.current ? 'Sign out this browser' : 'Sign out browser'}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Sign out ${session.deviceLabel}`}
                    disabled={Boolean(pending) || support?.impersonation.active}
                    onClick={() => { void revoke(session.id, session.current) }}
                    sx={{ color: 'text.secondary' }}
                  >
                    {pending === `revoke:${session.id}` ? <CircularProgress size={18} /> : <LogoutRounded fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          ))}
        </Box>
      </Box>

      {support?.isRootAdmin ? (
        <>
          <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />
          <Box component="section">
            <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25}>
              <PersonSearchRounded sx={{ fontSize: 20, color: 'text.secondary' }} />
              <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Root support mode</Typography>
            </Stack>
            {support.impersonation.active ? (
              <Box sx={{ display: 'flex', alignItems: { xs: 'stretch', sm: 'center' }, flexDirection: { xs: 'column', sm: 'row' }, gap: 1.25 }}>
                <Alert severity="warning" icon={<VisibilityRounded fontSize="small" />} sx={{ flex: 1, borderRadius: '8px' }}>
                  Viewing as {support.impersonation.effectiveUser}
                </Alert>
                <Button
                  variant="outlined"
                  startIcon={pending === 'exit-impersonation' ? <CircularProgress size={16} /> : <VisibilityOffRounded />}
                  onClick={() => { void exitUserView() }}
                  disabled={Boolean(pending)}
                  sx={{ borderRadius: '8px', minHeight: 40 }}
                >
                  Exit user view
                </Button>
              </Box>
            ) : (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}>
                <TextField
                  select
                  size="small"
                  label="User"
                  value={targetEmail}
                  onChange={(event) => setTargetEmail(event.target.value)}
                  disabled={Boolean(pending)}
                  sx={fieldSx}
                >
                  {(support.targets || []).map((target) => (
                    <MenuItem key={target.email} value={target.email}>
                      {target.displayName || target.email} · {target.organizationName || 'No organization'}
                    </MenuItem>
                  ))}
                </TextField>
                <Button
                  variant="contained"
                  startIcon={pending === 'impersonate' ? <CircularProgress size={16} color="inherit" /> : <VisibilityRounded />}
                  onClick={() => { void enterUserView() }}
                  disabled={Boolean(pending) || !targetEmail}
                  sx={{ borderRadius: '8px', minHeight: 40, whiteSpace: 'nowrap' }}
                >
                  View as user
                </Button>
              </Box>
            )}
          </Box>
        </>
      ) : null}
    </Box>
  )
}
