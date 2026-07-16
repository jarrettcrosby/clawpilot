'use client'

import { useCallback, useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import { SESSION_CHANGED_EVENT } from './SessionGuard'

type SessionPayload = {
  ok?: boolean
  authenticatedUser?: { email: string; displayName: string | null }
  effectiveUser?: { email: string; displayName: string | null }
  impersonation?: { active: boolean; expiresAt?: string | null }
}
export default function ImpersonationBanner() {
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' })
    if (!response.ok) return
    setSession(await response.json())
  }, [])

  useEffect(() => {
    void load()
    function onSessionChanged(event: Event) {
      setSession((event as CustomEvent<SessionPayload>).detail)
    }
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChanged)
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChanged)
  }, [load])

  if (!session?.impersonation?.active || !session.authenticatedUser || !session.effectiveUser) return null

  const authenticatedName = session.authenticatedUser.displayName || session.authenticatedUser.email
  const effectiveName = session.effectiveUser.displayName || session.effectiveUser.email

  async function exitUserView() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch('/api/auth/impersonation', { method: 'DELETE' })
      if (!response.ok) throw new Error('Unable to exit user view')
      window.location.reload()
    } finally {
      setPending(false)
    }
  }

  return (
    <Alert
      severity="warning"
      icon={<VisibilityRounded fontSize="small" />}
      action={(
        <Button
          size="small"
          color="inherit"
          onClick={() => { void exitUserView() }}
          disabled={pending}
          startIcon={pending ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ minHeight: 32, borderRadius: '6px', whiteSpace: 'nowrap' }}
        >
          Exit user view
        </Button>
      )}
      sx={{
        borderRadius: 0,
        borderLeft: 0,
        borderRight: 0,
        py: 0.25,
        px: { xs: 1.25, sm: 2 },
        '& .MuiAlert-message': { minWidth: 0, py: 0.75 },
        '& .MuiAlert-action': { alignItems: 'center', pl: 1 },
      }}
    >
      <Box component="span" sx={{ fontWeight: 700 }}>{effectiveName}</Box>
      <Box component="span" sx={{ color: 'text.secondary' }}> viewed by {authenticatedName}. Actions retain both identities.</Box>
    </Alert>
  )
}
