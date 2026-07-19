'use client'

import { FormEvent, useEffect, useState } from 'react'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import LoginRounded from '@mui/icons-material/LoginRounded'
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded'
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import BrandMark from '@/components/BrandMark'

type LoginMode = 'email' | 'code'
type PendingAction = 'request' | 'verify' | null
type AuthResponse = { ok?: boolean; error?: string; message?: string; email?: string }

const INVITATION_TOKEN_STORAGE_KEY = 'clawpilot.invitationToken'

function nextPath() {
  const requested = new URLSearchParams(window.location.search).get('next') || '/'
  return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
}

export default function LoginPage() {
  const [mode, setMode] = useState<LoginMode>('email')
  const [email, setEmail] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)
  const [resendSeconds, setResendSeconds] = useState(0)
  const [invitedFlow, setInvitedFlow] = useState(false)
  const [demoAvailable, setDemoAvailable] = useState(false)
  const [demoChecked, setDemoChecked] = useState(false)
  const [demoPending, setDemoPending] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const prefilledEmail = String(params.get('email') || '').trim().toLowerCase()
    const codeSent = params.get('sent') === '1'
    const fromWelcome = params.get('welcome') === '1'
    if (prefilledEmail.includes('@')) setEmail(prefilledEmail)
    if (fromWelcome) setInvitedFlow(true)
    if (prefilledEmail.includes('@') && codeSent) {
      setSentEmail(prefilledEmail)
      setMode('code')
      setResendSeconds(60)
      setNotice('Your one-time sign-in code is on the way.')
    }
  }, [])

  useEffect(() => {
    let active = true
    fetch('/api/auth/demo', { cache: 'no-store' })
      .then((response) => response.json())
      .then((result) => {
        if (!active) return
        setDemoAvailable(result?.available === true)
        setDemoChecked(true)
      })
      .catch(() => { if (active) setDemoChecked(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setTimeout(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resendSeconds])

  const requestCode = async (requestedEmail = email) => {
    const normalizedEmail = requestedEmail.trim().toLowerCase()
    if (!normalizedEmail.includes('@') || pending) return

    setPending('request')
    setError('')
    setNotice('')
    try {
      const invitationToken = invitedFlow
        ? window.sessionStorage.getItem(INVITATION_TOKEN_STORAGE_KEY) || ''
        : ''
      if (invitedFlow && !invitationToken) {
        throw new Error('Return to your ClawPilot welcome link to request another code')
      }
      const response = await fetch(invitedFlow ? '/api/invitations/accept' : '/api/auth/magic/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invitedFlow
          ? { action: 'code', token: invitationToken }
          : { email: normalizedEmail }),
      })
      const result = (await response.json().catch(() => ({}))) as AuthResponse
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to send a sign-in code')
      const responseEmail = invitedFlow && 'email' in result
        ? String(result.email || '').trim().toLowerCase()
        : normalizedEmail
      setEmail(responseEmail)
      setSentEmail(responseEmail)
      setCode('')
      setMode('code')
      setResendSeconds(60)
      setNotice(result.message || 'Check your email for a six-digit sign-in code.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to send a sign-in code')
    } finally {
      setPending(null)
    }
  }

  const verifyCode = async () => {
    if (!sentEmail || code.length !== 6 || pending) return

    setPending('verify')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/auth/magic/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: sentEmail, code }),
      })
      const result = (await response.json().catch(() => ({}))) as AuthResponse
      if (!response.ok || !result.ok) throw new Error(result.error || 'The code is invalid or expired')
      if (invitedFlow) window.sessionStorage.removeItem(INVITATION_TOKEN_STORAGE_KEY)
      window.location.replace(nextPath())
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'The code is invalid or expired')
      setPending(null)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mode === 'email') await requestCode()
    if (mode === 'code') await verifyCode()
  }

  const resetEmail = () => {
    if (invitedFlow) {
      window.location.replace('/welcome')
      return
    }
    setMode('email')
    setCode('')
    setSentEmail('')
    setError('')
    setNotice('')
  }

  const openDemo = async () => {
    if (demoPending) return
    setDemoPending(true)
    setError('')
    try {
      const response = await fetch('/api/auth/demo', { method: 'POST' })
      const result = (await response.json().catch(() => ({}))) as AuthResponse
      if (!response.ok || !result.ok) throw new Error(result.error || 'The demo is unavailable')
      window.location.replace(nextPath())
    } catch (demoError) {
      setError(demoError instanceof Error ? demoError.message : 'The demo is unavailable')
      setDemoPending(false)
    }
  }

  const primaryLabel = mode === 'email' ? 'Email sign-in code' : 'Verify and sign in'
  const primaryIcon = pending
    ? <CircularProgress size={16} color="inherit" />
    : mode === 'email'
      ? <MailOutlineRounded />
      : <LoginRounded />
  const primaryDisabled = Boolean(pending)
    || (mode === 'email' && !email.trim().includes('@'))
    || (mode === 'code' && code.length !== 6)
  const showDemo = demoChecked && demoAvailable && !invitedFlow
  const showSignIn = demoChecked && !showDemo

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        px: 2,
        py: 4,
        bgcolor: '#0F0F13',
        color: '#E4E1EC',
      }}
    >
      <CssBaseline />
      <Paper
        component="form"
        onSubmit={submit}
        elevation={0}
        sx={{
          width: 'min(100%, 420px)',
          p: { xs: 3, sm: 4 },
          borderRadius: 1,
          border: '1px solid rgba(255,255,255,0.08)',
          bgcolor: '#1A1A23',
          color: 'inherit',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 3 }}>
          <BrandMark size={42} />
          <Box>
            <Typography component="h1" variant="h5" sx={{ fontWeight: 750 }}>
              ClawPilot
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {showDemo ? 'Interactive product demo' : invitedFlow ? 'Complete your sign in' : 'Operator sign in'}
            </Typography>
          </Box>
        </Box>

        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

        {!demoChecked ? (
          <Box sx={{ minHeight: 120, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={24} />
          </Box>
        ) : null}

        {showSignIn && mode === 'email' ? (
          <TextField
            autoFocus
            fullWidth
            required
            id="email"
            name="email"
            type="email"
            label="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            slotProps={{
              htmlInput: { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <MailOutlineRounded sx={{ color: 'text.secondary' }} />
                  </InputAdornment>
                ),
              },
            }}
            sx={fieldSx}
          />
        ) : null}

        {showSignIn && mode === 'code' ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, overflowWrap: 'anywhere' }}>
              Enter the code sent to <Box component="span" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>{sentEmail}</Box>.
            </Typography>
            <TextField
              autoFocus
              fullWidth
              required
              id="verification-code"
              name="verificationCode"
              label="Six-digit code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              autoComplete="one-time-code"
              inputMode="numeric"
              slotProps={{
                htmlInput: { pattern: '[0-9]*', enterKeyHint: 'done' },
              }}
              sx={{
                ...fieldSx,
                '& input': { letterSpacing: '0.22em', fontVariantNumeric: 'tabular-nums' },
              }}
            />
          </>
        ) : null}

        {showSignIn ? (
          <Button
            fullWidth
            type="submit"
            variant="contained"
            endIcon={primaryIcon}
            disabled={primaryDisabled}
            sx={{
              minHeight: 44,
              borderRadius: 1,
              bgcolor: '#A8C7FA',
              color: '#001D36',
              fontWeight: 750,
              '&:hover': { bgcolor: '#BDD4FB' },
            }}
          >
            {primaryLabel}
          </Button>
        ) : null}

        {showSignIn && mode === 'code' ? (
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5 }}>
            <Button size="small" startIcon={<ArrowBackRounded />} onClick={resetEmail} disabled={Boolean(pending)}>
              {invitedFlow ? 'Back to welcome' : 'Change email'}
            </Button>
            <Button
              size="small"
              onClick={() => requestCode(sentEmail)}
              disabled={Boolean(pending) || resendSeconds > 0}
            >
              {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend code'}
            </Button>
          </Stack>
        ) : null}

        {showDemo ? (
          <>
            <Button
              fullWidth
              type="button"
              variant="contained"
              startIcon={demoPending ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRounded />}
              onClick={() => { void openDemo() }}
              disabled={demoPending}
              sx={{ minHeight: 44, borderRadius: 1, fontWeight: 750 }}
            >
              Explore the live demo
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, textAlign: 'center' }}>
              Synthetic CRM, pipeline, projects, documents, and accounting data refresh automatically. External integrations are disabled.
            </Typography>
          </>
        ) : null}

      </Paper>
    </Box>
  )
}

const fieldSx = {
  mb: 2,
  '& .MuiInputLabel-root': { color: 'text.secondary' },
  '& .MuiOutlinedInput-root': {
    color: 'text.primary',
    bgcolor: '#232330',
    borderRadius: 1,
    '& fieldset': { borderColor: 'rgba(255,255,255,0.14)' },
    '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.28)' },
    '&.Mui-focused fieldset': { borderColor: '#A8C7FA' },
  },
} as const
