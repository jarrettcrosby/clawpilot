'use client'

import { useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'

type Resource = {
  id: string
  name: string
  ownerEmail: string
  accessRole: 'owner' | 'editor' | 'viewer'
}

type WorkspacePayload = {
  ok?: boolean
  error?: string
  boards?: Resource[]
  pipelines?: Resource[]
  selectedBoardId?: string | null
  selectedPipelineId?: string | null
}

export default function WorkspaceSelector({
  kind,
  onAccessChange,
}: {
  kind: 'board' | 'pipeline'
  onAccessChange?: (resource: Resource | null) => void
}) {
  const [payload, setPayload] = useState<WorkspacePayload>({})
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadRevision, setLoadRevision] = useState(0)
  const [error, setError] = useState('')
  const resources = useMemo(() => kind === 'board' ? payload.boards || [] : payload.pipelines || [], [kind, payload])
  const selectedId = kind === 'board' ? payload.selectedBoardId || '' : payload.selectedPipelineId || ''

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    fetch('/api/workspaces')
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as WorkspacePayload
        if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load workspaces')
        if (active) setPayload(result)
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Unable to load workspaces')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadRevision])

  useEffect(() => {
    onAccessChange?.(resources.find((resource) => resource.id === selectedId) || null)
  }, [onAccessChange, resources, selectedId])

  async function select(id: string) {
    if (!id || id === selectedId || pending) return
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: kind === 'board' ? 'select-board' : 'select-pipeline', [`${kind}Id`]: id }),
      })
      const result = await response.json().catch(() => ({})) as WorkspacePayload
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to switch workspace')
      const url = new URL(window.location.href)
      for (const parameter of ['board', 'pipeline', 'crm', 'crmAction', 'doc']) url.searchParams.delete(parameter)
      url.searchParams.set(kind, id)
      window.location.assign(url.toString())
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Unable to switch workspace'
      setError(`${message}. Your current ${kind} is unchanged; try selecting again.`)
    } finally {
      setPending(false)
    }
  }

  if (loading) return <CircularProgress size={18} aria-label={`Loading ${kind === 'board' ? 'boards' : 'pipelines'}`} />
  if (resources.length === 0 && !error) return null

  return (
    <Box sx={{ maxWidth: '100%', minWidth: 0 }}>
    {error && <Alert severity="error" sx={{ mb: resources.length ? 1 : 0, maxWidth: 360 }}
      action={resources.length === 0 ? <Button color="inherit" size="small" onClick={() => setLoadRevision((current) => current + 1)}>Retry</Button> : undefined}>{error}</Alert>}
    {resources.length > 0 && <TextField
      select
      size="small"
      label={kind === 'board' ? 'Board' : 'Pipeline'}
      value={selectedId}
      onChange={(event) => select(event.target.value)}
      disabled={pending}
      sx={{
        width: { xs: 'min(220px, calc(100vw - 146px))', sm: 260 },
        maxWidth: '100%',
        '& .MuiInputBase-root': { borderRadius: 1 },
      }}
    >
      {resources.map((resource) => (
        <MenuItem key={resource.id} value={resource.id}>
          {resource.name}{resource.accessRole === 'viewer' ? ' (view only)' : resource.accessRole !== 'owner' ? ' (shared)' : ''}
        </MenuItem>
      ))}
    </TextField>}
    </Box>
  )
}
