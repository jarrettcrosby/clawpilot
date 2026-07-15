'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import SaveRounded from '@mui/icons-material/SaveRounded'

type EmbeddingSettings = {
  provider: 'local' | 'openai'
  model: string
  keyConfigured: boolean
  sendsDocumentContentExternally: boolean
  valid: boolean
}

export default function EmbeddingSettingsPanel() {
  const [settings, setSettings] = useState<EmbeddingSettings | null>(null)
  const [provider, setProvider] = useState<'local' | 'openai'>('local')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetch('/api/settings/embeddings')
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load embedding settings')
        if (cancelled) return
        setSettings(payload.settings)
        setProvider(payload.settings.provider)
      })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load embedding settings') })
    return () => { cancelled = true }
  }, [])

  async function save() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/settings/embeddings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to save embedding settings')
      setSettings(payload.settings)
      setProvider(payload.settings.provider)
      setNotice('Embedding setting saved')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save embedding settings')
    } finally {
      setBusy(false)
    }
  }

  if (!settings && !error) return <Box display="grid" sx={{ placeItems: 'center', minHeight: 180 }}><CircularProgress size={26} /></Box>

  return (
    <Stack spacing={2.25} sx={{ maxWidth: 620 }}>
      <Box>
        <Typography variant="h6" fontWeight={700}>Knowledge search</Typography>
        <Stack direction="row" gap={1} mt={1} flexWrap="wrap">
          <Chip label={settings?.model || 'Not loaded'} variant="outlined" />
          <Chip
            label={settings?.keyConfigured ? 'External key configured' : 'External key not configured'}
            color={settings?.keyConfigured ? 'success' : 'default'}
            variant="outlined"
          />
        </Stack>
      </Box>
      {error ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert> : null}
      <ToggleButtonGroup
        exclusive
        value={provider}
        onChange={(_, value: 'local' | 'openai' | null) => { if (value) setProvider(value) }}
        aria-label="Embedding provider"
        fullWidth
      >
        <ToggleButton value="local">Local</ToggleButton>
        <ToggleButton value="openai" disabled={!settings?.keyConfigured}>External</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary">
        {provider === 'local' ? 'Document content stays inside ClawPilot.' : 'Document content is sent to the configured embedding provider.'}
      </Typography>
      <Button
        variant="contained"
        startIcon={<SaveRounded />}
        disabled={busy || provider === settings?.provider}
        onClick={save}
        sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
      >
        Save
      </Button>
    </Stack>
  )
}
