'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material'

export default function LoginEmailPanel({ identityEmail }: { identityEmail: string }) {
  const router = useRouter()
  const [loginEmail, setLoginEmail] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [pendingEmail, setPendingEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/auth/login-email', { signal: controller.signal }).then(async (response) => {
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load login email')
      setLoginEmail(data.loginEmail)
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load login email') })
    return () => controller.abort()
  }, [identityEmail])

  async function submit(confirm: boolean) {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login-email', { method: confirm ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: confirm ? pendingEmail : newEmail.trim(), ...(confirm ? { code } : {}) }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to change login email')
      if (confirm) {
        router.replace(`/login?email=${encodeURIComponent(data.loginEmail)}`)
        router.refresh()
      } else {
        setPendingEmail(data.pendingEmail)
        setCode('')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to change login email')
    } finally { setBusy(false) }
  }

  return <Box component="section" mt={3}>
    <Typography variant="subtitle1" fontWeight={700}>Login email</Typography>
    <Typography variant="body2" color="text.secondary" mb={1}>Current sign-in address: {loginEmail || 'Loading…'}</Typography>
    <Typography variant="caption" color="text.secondary" display="block" mb={2}>
      This changes how you sign in, not your historical identity, organization memberships, CRM contact emails, or email sender settings.
      Verify the new inbox first. You will be signed out of all devices and must relink Google sign-in afterward. The old email will stop working for sign-in.
    </Typography>
    {error ? <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert> : null}
    {pendingEmail ? <Alert severity="info" sx={{ mb: 1 }}>Enter the six-digit code sent to {pendingEmail}. No change has been made yet.</Alert> : null}
    <Stack spacing={1.5}>
      <TextField label="New login email" type="email" size="small" value={newEmail} disabled={busy} onChange={(event) => { setNewEmail(event.target.value); setPendingEmail(''); setCode('') }} />
      <Button type="button" variant="outlined" disabled={busy || !loginEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.trim().toLowerCase() === loginEmail} onClick={() => { void submit(false) }}>Send verification code</Button>
      {pendingEmail ? <>
        <TextField label="Login email verification code" size="small" value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 6 }} />
        <Button type="button" variant="contained" disabled={busy || code.length !== 6} onClick={() => { void submit(true) }}>Verify and change login email</Button>
      </> : null}
    </Stack>
  </Box>
}
