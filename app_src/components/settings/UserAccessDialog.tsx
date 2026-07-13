'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import PersonAddRounded from '@mui/icons-material/PersonAddRounded'
import PersonOffRounded from '@mui/icons-material/PersonOffRounded'
import PersonRounded from '@mui/icons-material/PersonRounded'
import RestoreRounded from '@mui/icons-material/RestoreRounded'

type AppUser = {
  email: string
  role: 'owner' | 'member'
  status: 'invited' | 'active' | 'disabled'
  lastLoginAt?: string | null
}

type UsersPayload = {
  ok?: boolean
  error?: string
  currentUser?: AppUser
  canInvite?: boolean
  users?: AppUser[]
}

export default function UserAccessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [payload, setPayload] = useState<UsersPayload>({})
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function loadUsers() {
    const response = await fetch('/api/users')
    const result = await response.json().catch(() => ({})) as UsersPayload
    if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load users')
    setPayload(result)
  }

  useEffect(() => {
    if (!open) return
    setError('')
    setNotice('')
    loadUsers().catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load users'))
  }, [open])

  async function invite() {
    const normalized = email.trim().toLowerCase()
    if (!normalized.includes('@') || pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }),
      })
      const result = await response.json().catch(() => ({})) as UsersPayload
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to invite user')
      setEmail('')
      setNotice(`Invitation sign-in code sent to ${normalized}.`)
      await loadUsers()
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Unable to invite user')
    } finally {
      setPending(false)
    }
  }

  async function updateStatus(user: AppUser) {
    if (pending || user.role === 'owner') return
    setPending(true)
    setError('')
    setNotice('')
    const status = user.status === 'disabled' ? 'active' : 'disabled'
    try {
      const response = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, status }),
      })
      const result = await response.json().catch(() => ({})) as UsersPayload
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to update user')
      setNotice(status === 'active' ? `${user.email} restored.` : `${user.email} disabled.`)
      await loadUsers()
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update user')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1 } }}
    >
      <DialogTitle sx={{ color: 'text.primary', fontWeight: 700 }}>User access</DialogTitle>
      <DialogContent>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

        {payload.canInvite ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={2}>
            <TextField
              size="small"
              type="email"
              label="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              fullWidth
            />
            <Button
              variant="contained"
              startIcon={pending ? <CircularProgress size={16} color="inherit" /> : <PersonAddRounded />}
              onClick={invite}
              disabled={pending || !email.trim().includes('@')}
              sx={{ whiteSpace: 'nowrap' }}
            >
              Invite user
            </Button>
          </Stack>
        ) : null}

        <Stack spacing={0}>
          {(payload.users || []).map((user) => (
            <Box
              key={user.email}
              sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 1, py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.07)' }}
            >
              <Box minWidth={0}>
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                  <PersonRounded sx={{ fontSize: 18, color: 'text.secondary' }} />
                  <Typography variant="body2" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>{user.email}</Typography>
                  <Chip size="small" label={user.role} />
                  <Chip size="small" color={user.status === 'active' ? 'success' : 'default'} label={user.status} />
                </Stack>
                {user.lastLoginAt ? (
                  <Typography variant="caption" color="text.disabled">Last sign-in {new Date(user.lastLoginAt).toLocaleString()}</Typography>
                ) : null}
              </Box>
              {payload.canInvite && user.role !== 'owner' ? (
                <Tooltip title={user.status === 'disabled' ? 'Restore access' : 'Disable access'}>
                  <span>
                    <IconButton size="small" onClick={() => updateStatus(user)} disabled={pending}>
                      {user.status === 'disabled' ? <RestoreRounded /> : <PersonOffRounded />}
                    </IconButton>
                  </span>
                </Tooltip>
              ) : null}
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={pending} sx={{ color: 'text.secondary' }}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
