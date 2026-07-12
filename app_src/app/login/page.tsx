'use client'

import { FormEvent, useState } from 'react'
import LockOutlined from '@mui/icons-material/LockOutlined'
import LoginRounded from '@mui/icons-material/LoginRounded'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Paper,
  TextField,
  Typography,
} from '@mui/material'

function nextPath() {
  const requested = new URLSearchParams(window.location.search).get('next') || '/'
  return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
}

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!password || submitting) return

    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result?.error || 'Sign in failed')
      window.location.replace(nextPath())
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Sign in failed')
      setSubmitting(false)
    }
  }

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        px: 2,
        py: 4,
        bgcolor: '#101116',
        color: '#f4f5f7',
      }}
    >
      <CssBaseline />
      <Paper
        component="form"
        onSubmit={submit}
        elevation={0}
        sx={{
          width: 'min(100%, 380px)',
          p: { xs: 3, sm: 4 },
          borderRadius: 1,
          border: '1px solid rgba(255,255,255,0.12)',
          bgcolor: '#191b22',
          color: 'inherit',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 3 }}>
          <Box
            sx={{
              width: 38,
              height: 38,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 1,
              bgcolor: '#d7ff5f',
              color: '#101116',
            }}
          >
            <LockOutlined fontSize="small" />
          </Box>
          <Box>
            <Typography component="h1" variant="h5" sx={{ fontWeight: 750 }}>
              ClawPilot
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(244,245,247,0.62)' }}>
              Sign in
            </Typography>
          </Box>
        </Box>

        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}

        <TextField
          autoFocus
          fullWidth
          required
          type="password"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          sx={{
            mb: 2,
            '& .MuiInputLabel-root': { color: 'rgba(244,245,247,0.62)' },
            '& .MuiOutlinedInput-root': {
              color: '#f4f5f7',
              '& fieldset': { borderColor: 'rgba(255,255,255,0.2)' },
              '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.38)' },
            },
          }}
        />

        <Button
          fullWidth
          type="submit"
          variant="contained"
          endIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <LoginRounded />}
          disabled={!password || submitting}
          sx={{
            minHeight: 44,
            borderRadius: 1,
            bgcolor: '#d7ff5f',
            color: '#101116',
            fontWeight: 750,
            '&:hover': { bgcolor: '#c4ee4f' },
          }}
        >
          Sign in
        </Button>
      </Paper>
    </Box>
  )
}
