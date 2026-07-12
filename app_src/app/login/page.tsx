'use client'

import { FormEvent, useEffect, useState } from 'react'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import LoginRounded from '@mui/icons-material/LoginRounded'
import MailOutlineRounded from '@mui/icons-material/MailOutlineRounded'
import PasswordRounded from '@mui/icons-material/PasswordRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  IconButton,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { BrandIcon } from '@/lib/icons'

type LoginMode = 'email' | 'code' | 'password'
type PendingAction = 'request' | 'verify' | 'password' | null
type AuthResponse = { ok?: boolean; error?: string; message?: string }

function nextPath() {
  const requested = new URLSearchParams(window.location.search).get('next') || '/'
  return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
}

export default function LoginPage() {
  const [mode, setMode] = useState<LoginMode>('email')
  const [email, setEmail] = useState('')
  const [sentEmail, setSentEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<PendingAction>(null)
  const [resendSeconds, setResendSeconds] = useState(0)

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
      const response = await fetch('/api/auth/magic/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      })
      const result = (await response.json().catch(() => ({}))) as AuthResponse
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to send a sign-in code')
      setEmail(normalizedEmail)
      setSentEmail(normalizedEmail)
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
      window.location.replace(nextPath())
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'The code is invalid or expired')
      setPending(null)
    }
  }

  const signInWithPassword = async () => {
    if (!password || pending) return

    setPending('password')
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const result = (await response.json().catch(() => ({}))) as AuthResponse
      if (!response.ok || !result.ok) throw new Error(result.error || 'Sign in failed')
      window.location.replace(nextPath())
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign in failed')
      setPending(null)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mode === 'email') await requestCode()
    if (mode === 'code') await verifyCode()
    if (mode === 'password') await signInWithPassword()
  }

  const resetEmail = () => {
    setMode('email')
    setCode('')
    setSentEmail('')
    setError('')
    setNotice('')
  }

  const primaryLabel = mode === 'email' ? 'Email sign-in code' : mode === 'code' ? 'Verify and sign in' : 'Sign in'
  const primaryIcon = pending
    ? <CircularProgress size={16} color="inherit" />
    : mode === 'email'
      ? <MailOutlineRounded />
      : <LoginRounded />
  const primaryDisabled = Boolean(pending)
    || (mode === 'email' && !email.trim().includes('@'))
    || (mode === 'code' && code.length !== 6)
    || (mode === 'password' && !password)

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
          <Avatar sx={{ width: 38, height: 38, bgcolor: '#A8C7FA', color: '#001D36' }}>
            <BrandIcon sx={{ fontSize: 20 }} />
          </Avatar>
          <Box>
            <Typography component="h1" variant="h5" sx={{ fontWeight: 750 }}>
              ClawPilot
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Operator sign in
            </Typography>
          </Box>
        </Box>

        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

        {mode === 'email' ? (
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

        {mode === 'code' ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Enter the code sent to <Box component="span" color="text.primary">{sentEmail}</Box>.
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

        {mode === 'password' ? (
          <TextField
            autoFocus
            fullWidth
            required
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            label="Operator password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      edge="end"
                      onClick={() => setShowPassword((visible) => !visible)}
                      sx={{ color: 'text.secondary' }}
                    >
                      {showPassword ? <VisibilityOffRounded /> : <VisibilityRounded />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
            sx={fieldSx}
          />
        ) : null}

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

        {mode === 'code' ? (
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5 }}>
            <Button size="small" startIcon={<ArrowBackRounded />} onClick={resetEmail} disabled={Boolean(pending)}>
              Change email
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

        {mode !== 'code' ? (
          <Button
            fullWidth
            size="small"
            startIcon={mode === 'password' ? <MailOutlineRounded /> : <PasswordRounded />}
            onClick={() => {
              setMode(mode === 'password' ? 'email' : 'password')
              setError('')
              setNotice('')
            }}
            disabled={Boolean(pending)}
            sx={{ mt: 1.5, color: 'text.secondary' }}
          >
            {mode === 'password' ? 'Use email code instead' : 'Use operator password instead'}
          </Button>
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
