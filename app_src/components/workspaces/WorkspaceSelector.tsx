'use client'

import { useEffect, useMemo, useState } from 'react'
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
  const resources = useMemo(() => kind === 'board' ? payload.boards || [] : payload.pipelines || [], [kind, payload])
  const selectedId = kind === 'board' ? payload.selectedBoardId || '' : payload.selectedPipelineId || ''

  useEffect(() => {
    let active = true
    fetch('/api/workspaces')
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as WorkspacePayload
        if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load workspaces')
        if (active) setPayload(result)
      })
      .catch(() => {
        if (active) setPayload({})
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    onAccessChange?.(resources.find((resource) => resource.id === selectedId) || null)
  }, [onAccessChange, resources, selectedId])

  async function select(id: string) {
    if (!id || id === selectedId || pending) return
    setPending(true)
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
    } catch {
      // Keep the current resource selected when switching fails.
    } finally {
      setPending(false)
    }
  }

  if (resources.length === 0) return pending ? <CircularProgress size={18} /> : null

  return (
    <TextField
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
    </TextField>
  )
}
