'use client'

import { FormEvent, useState } from 'react'
import LoginRounded from '@mui/icons-material/LoginRounded'
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
  TextField,
  Typography,
} from '@mui/material'
import { BrandIcon } from '@/lib/icons'

function nextPath() {
  const requested = new URLSearchParams(window.location.search).get('next') || '/'
  return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
}

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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
          width: 'min(100%, 380px)',
          p: { xs: 3, sm: 4 },
          borderRadius: 1,
          border: '1px solid rgba(255,255,255,0.08)',
          bgcolor: '#1A1A23',
          color: 'inherit',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 3 }}>
          <Avatar
            sx={{
              width: 38,
              height: 38,
              bgcolor: '#A8C7FA',
              color: '#001D36',
            }}
          >
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
          sx={{
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
            bgcolor: '#A8C7FA',
            color: '#001D36',
            fontWeight: 750,
            '&:hover': { bgcolor: '#BDD4FB' },
          }}
        >
          Sign in
        </Button>
      </Paper>
    </Box>
  )
}
