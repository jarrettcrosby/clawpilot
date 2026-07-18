'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import AddBusinessRounded from '@mui/icons-material/AddBusinessRounded'
import BusinessRounded from '@mui/icons-material/BusinessRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import { announceWorkspaceChange } from '@/lib/workspaceClient'

type Workspace = {
  organizationId: string
  organizationReferenceCode: string
  organizationName: string
  organizationType: 'root' | 'member'
  role: 'owner' | 'admin' | 'member'
  isDefault: boolean
}

type WorkspaceResponse = {
  ok: boolean
  activeOrganizationId: string | null
  canCreateRoot: boolean
  workspaces: Workspace[]
}

type ActiveWorkspace = {
  organizationId: string
  referenceCode: string
  name: string
  role: Workspace['role']
}

type WorkspaceMutationResponse = {
  ok?: boolean
  error?: string
  activeWorkspace?: ActiveWorkspace
}

export default function ActiveWorkspaceSwitcher() {
  const [payload, setPayload] = useState<WorkspaceResponse | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [businessName, setBusinessName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/auth/workspace', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load businesses')
        return response.json() as Promise<WorkspaceResponse>
      })
      .then((result) => { if (active) setPayload(result) })
      .catch(() => { if (active) setPayload(null) })
    return () => { active = false }
  }, [])

  const current = useMemo(() => payload?.workspaces.find(
    (workspace) => workspace.organizationId === payload.activeOrganizationId,
  ) || payload?.workspaces[0] || null, [payload])

  if (!current) return null

  function finishWorkspaceChange(activeWorkspace: ActiveWorkspace, organizationType: Workspace['organizationType']) {
    setPayload((previous) => {
      if (!previous) return previous
      const existing = previous.workspaces.find(
        (workspace) => workspace.organizationId === activeWorkspace.organizationId,
      )
      const nextWorkspace: Workspace = {
        organizationId: activeWorkspace.organizationId,
        organizationReferenceCode: activeWorkspace.referenceCode,
        organizationName: activeWorkspace.name,
        organizationType: existing?.organizationType || organizationType,
        role: activeWorkspace.role,
        isDefault: existing?.isDefault || false,
      }
      return {
        ...previous,
        activeOrganizationId: activeWorkspace.organizationId,
        workspaces: existing
          ? previous.workspaces.map((workspace) => (
              workspace.organizationId === activeWorkspace.organizationId ? nextWorkspace : workspace
            ))
          : [...previous.workspaces, nextWorkspace],
      }
    })
    setAnchor(null)
    setCreateOpen(false)
    setBusinessName('')
    setSwitching(null)
    announceWorkspaceChange({
      organizationId: activeWorkspace.organizationId,
      organizationName: activeWorkspace.name,
    })
  }

  async function selectWorkspace(organizationId: string) {
    if (organizationId === current?.organizationId || switching) {
      setAnchor(null)
      return
    }
    setSwitching(organizationId)
    setError('')
    try {
      const response = await fetch('/api/auth/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', organizationId }),
      })
      const result = await response.json() as WorkspaceMutationResponse
      if (!response.ok || !result.ok || !result.activeWorkspace) {
        throw new Error(result.error || 'Unable to switch businesses')
      }
      const selected = payload?.workspaces.find((workspace) => workspace.organizationId === organizationId)
      finishWorkspaceChange(result.activeWorkspace, selected?.organizationType || 'member')
    } catch (caught) {
      setSwitching(null)
      setError(caught instanceof Error ? caught.message : 'Unable to switch businesses')
    }
  }

  async function createWorkspace() {
    const name = businessName.replace(/\s+/g, ' ').trim()
    if (!name || switching) return
    setSwitching('create-root')
    setError('')
    try {
      const response = await fetch('/api/auth/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-root', name }),
      })
      const result = await response.json() as WorkspaceMutationResponse
      if (!response.ok || !result.ok || !result.activeWorkspace) {
        throw new Error(result.error || 'Unable to add business')
      }
      finishWorkspaceChange(result.activeWorkspace, 'root')
    } catch (caught) {
      setSwitching(null)
      setError(caught instanceof Error ? caught.message : 'Unable to add business')
    }
  }

  const canSwitch = (payload?.workspaces.length || 0) > 1
  const canOpen = canSwitch || Boolean(payload?.canCreateRoot)
  return (
    <>
      <Tooltip title={canOpen ? 'Switch or add business' : `Active business: ${current.organizationName}`}>
        <Button
          data-testid="active-workspace-switcher"
          aria-label={`Active business: ${current.organizationName}`}
          aria-haspopup={canOpen ? 'menu' : undefined}
          aria-expanded={canOpen ? Boolean(anchor) : undefined}
          onClick={(event) => { if (canOpen) setAnchor(event.currentTarget) }}
          startIcon={<BusinessRounded sx={{ fontSize: 17 }} />}
          endIcon={canOpen ? <ExpandMoreRounded sx={{ fontSize: 16 }} /> : undefined}
          sx={{
            minWidth: 0,
            maxWidth: { xs: 48, sm: 230 },
            minHeight: 38,
            px: { xs: 1, sm: 1.25 },
            color: '#A8C7FA',
            border: '1px solid rgba(168,199,250,0.24)',
            borderRadius: 1.5,
            justifyContent: 'flex-start',
            textTransform: 'none',
            overflow: 'hidden',
            '& .MuiButton-startIcon': { m: { xs: 0, sm: '0 6px 0 0' }, flexShrink: 0 },
            '& .MuiButton-endIcon': { display: { xs: 'none', sm: 'inherit' }, ml: 0.5 },
          }}
        >
          <Box component="span" sx={{
            display: { xs: 'none', sm: 'block' },
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '0.75rem',
            fontWeight: 600,
          }}>
            {current.organizationName}
          </Box>
        </Button>
      </Tooltip>

      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => { if (!switching) setAnchor(null) }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        PaperProps={{
          sx: {
            mt: 0.5,
            minWidth: 280,
            maxWidth: 'calc(100vw - 24px)',
            backgroundColor: '#1A1A23',
            border: '1px solid rgba(255,255,255,0.08)',
          },
        }}
      >
        {payload?.workspaces.map((workspace) => {
          const selected = workspace.organizationId === current.organizationId
          return (
            <MenuItem
              key={workspace.organizationId}
              selected={selected}
              disabled={Boolean(switching)}
              onClick={() => void selectWorkspace(workspace.organizationId)}
              sx={{ py: 1.1 }}
            >
              <ListItemIcon sx={{ minWidth: 34 }}>
                {switching === workspace.organizationId
                  ? <CircularProgress size={17} />
                  : selected
                    ? <CheckRounded sx={{ fontSize: 19, color: '#66BB6A' }} />
                    : <BusinessRounded sx={{ fontSize: 18, color: 'text.secondary' }} />}
              </ListItemIcon>
              <ListItemText
                primary={workspace.organizationName}
                secondary={`${workspace.organizationReferenceCode} · ${workspace.role}`}
                primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                secondaryTypographyProps={{ variant: 'caption' }}
              />
            </MenuItem>
          )
        })}
        {payload?.canCreateRoot && <Divider />}
        {payload?.canCreateRoot && (
          <MenuItem
            disabled={Boolean(switching)}
            onClick={() => {
              setAnchor(null)
              setBusinessName('')
              setCreateOpen(true)
            }}
            sx={{ py: 1.1 }}
          >
            <ListItemIcon sx={{ minWidth: 34 }}>
              <AddBusinessRounded sx={{ fontSize: 19, color: '#A8C7FA' }} />
            </ListItemIcon>
            <ListItemText primary="Add business" primaryTypographyProps={{ variant: 'body2' }} />
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={createOpen}
        onClose={() => { if (!switching) setCreateOpen(false) }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Add business</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            required
            margin="dense"
            label="Business name"
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            inputProps={{ maxLength: 200 }}
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={Boolean(switching)} onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!businessName.trim() || Boolean(switching)}
            onClick={() => void createWorkspace()}
            startIcon={switching === 'create-root' ? <CircularProgress size={16} /> : <AddBusinessRounded />}
          >
            Add business
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(error)} autoHideDuration={5000} onClose={() => setError('')}>
        <Alert severity="error" onClose={() => setError('')} sx={{ width: '100%' }}>
          {error}
        </Alert>
      </Snackbar>
    </>
  )
}
