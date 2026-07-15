'use client'

import { useEffect, useState } from 'react'
import CheckRounded from '@mui/icons-material/CheckRounded'
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import BrandMark from '@/components/BrandMark'

type Invitation = {
  email: string
  inviterName: string
  expiresAt: string
}

const INVITATION_TOKEN_STORAGE_KEY = 'clawpilot.invitationToken'

export default function WelcomePage() {
  const [token, setToken] = useState('')
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') || ''
    const currentToken = fragmentToken || window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY) || ''
    if (fragmentToken) {
      window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, fragmentToken)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
    setToken(currentToken)
    if (!currentToken) {
      setError('This invitation link is invalid or expired.')
      setLoading(false)
      return
    }
    fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ action: 'open', token: currentToken }),
    })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}))
        if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load this invitation')
        setInvitation(result.invitation as Invitation)
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load this invitation'))
      .finally(() => setLoading(false))
  }, [])

  async function continueToSignIn() {
    if (!token || !invitation || sending) return
    setSending(true)
    setError('')
    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'code', token }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to send your sign-in code')
      window.sessionStorage.setItem(INVITATION_TOKEN_STORAGE_KEY, token)
      window.location.replace(`/login?email=${encodeURIComponent(result.email)}&sent=1&welcome=1`)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send your sign-in code')
      setSending(false)
    }
  }

  return (
    <Box component="main" sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', px: 2, py: 4, bgcolor: '#0F0F13', color: '#E4E1EC' }}>
      <CssBaseline />
      <Paper elevation={0} sx={{ width: 'min(100%, 560px)', p: { xs: 3, sm: 4 }, borderRadius: 1, border: '1px solid rgba(255,255,255,0.09)', bgcolor: '#1A1A23', color: 'inherit' }}>
        <BrandMark size={52} sx={{ mb: 2.5 }} />
        <Typography component="h1" variant="h4" fontWeight={750} sx={{ fontSize: { xs: '1.7rem', sm: '2rem' }, mb: 1 }}>
          Welcome to ClawPilot
        </Typography>

        {loading ? (
          <Box display="flex" alignItems="center" gap={1.5} py={4}>
            <CircularProgress size={22} />
            <Typography color="text.secondary">Checking your invitation...</Typography>
          </Box>
        ) : error ? (
          <Alert severity="error" sx={{ my: 2 }}>{error}</Alert>
        ) : invitation ? (
          <>
            <Typography color="text.secondary" sx={{ lineHeight: 1.65, mb: 2.5, overflowWrap: 'anywhere' }}>
              {invitation.inviterName} invited <Box component="span" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>{invitation.email}</Box> to a private ClawPilot workspace.
            </Typography>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {[
                'Coordinate project work and shared boards',
                'Track pipeline activity and personal reports',
                'Work with task-linked AI agents using your own ChatGPT authorization',
              ].map((item) => (
                <Box key={item} display="flex" alignItems="flex-start" gap={1.25}>
                  <CheckRounded sx={{ color: '#4FD1B8', fontSize: 20, mt: '2px' }} />
                  <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>{item}</Typography>
                </Box>
              ))}
            </Stack>
            <Box sx={{ p: 2, mb: 3, border: '1px solid rgba(126,171,255,0.22)', borderRadius: 1, bgcolor: 'rgba(126,171,255,0.06)' }}>
              <Typography variant="body2" color="text.primary" fontWeight={700} mb={0.5}>Passwordless access</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
                ClawPilot emails a six-digit, one-time code whenever you sign in. Codes expire after 15 minutes and can only be used once.
              </Typography>
            </Box>
            <Button
              fullWidth
              variant="contained"
              onClick={continueToSignIn}
              disabled={sending}
              startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <MailOutlineRounded />}
              sx={{ minHeight: 46, borderRadius: 1, bgcolor: '#7EABFF', color: '#061A2F', fontWeight: 750, '&:hover': { bgcolor: '#9CC0FF' } }}
            >
              Send my sign-in code
            </Button>
            <Typography variant="caption" color="text.disabled" display="block" textAlign="center" mt={1.5}>
              Welcome link expires {new Date(invitation.expiresAt).toLocaleDateString()}.
            </Typography>
          </>
        ) : null}
      </Paper>
    </Box>
  )
}
