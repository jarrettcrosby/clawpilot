'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

export default function ArchitecturePanel() {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ sourceHash: string; toolVersion: string } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/settings/architecture', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to load architecture')
        if (!controller.signal.aborted) setState(result)
      }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load architecture') })
    return () => controller.abort()
  }, [revision])
  return <Stack spacing={2}>
    <Typography variant="h6">Architecture</Typography>
    <Typography variant="body2" color="text.secondary">A hand-reviewed map of ClawPilot, its data stores, integrations, and environments. Diagram status labels are dated documentation, not live health checks.</Typography>
    {error ? <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => { setState(null); setError(''); setRevision((value) => value + 1) }}>Retry</Button>}>{error}</Alert>
      : !state ? <CircularProgress size={24} aria-label="Loading architecture" /> : <>
        <Typography variant="caption" color="text.secondary">Private platform-owner view · LikeC4 {state.toolVersion} · Model {state.sourceHash.slice(0, 12)}</Typography>
        <Box component="iframe" title="ClawPilot architecture diagrams" src={`/api/settings/architecture/viewer?model=${state.sourceHash}`}
          sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy"
          sx={{ width: '100%', height: 'min(72vh, 900px)', minHeight: 460, border: 1, borderColor: 'divider', borderRadius: 1 }} />
      </>}
  </Stack>
}
