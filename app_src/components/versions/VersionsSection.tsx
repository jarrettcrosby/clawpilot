'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import AddRounded from '@mui/icons-material/AddRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type ReleaseEntry = {
  id: string
  commitHash: string
  shortCommit: string
  environment: string
  branch: string | null
  title: string
  summary: string
  features: string[]
  fixes: string[]
  deployedAt: string
}

type DataCheckpoint = {
  id: string
  releaseId: string | null
  createdBy: string | null
  label: string
  reason: string
  objectCounts: Record<string, number>
  checksum: string
  sizeBytes: number
  providerBackupStatus: 'not_verified' | 'verified' | 'failed'
  createdAt: string
}

type ReleaseAccess = {
  historyScope: 'full' | 'last-30-days'
  historyDays: number | null
  manageBackups: boolean
}

type ReleasePayload = {
  ok: true
  access: ReleaseAccess
  releases: ReleaseEntry[]
  checkpoints?: DataCheckpoint[]
}

type OperationStatus = {
  severity: 'success' | 'error'
  message: string
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>
}

async function loadReleasePayload(signal: AbortSignal): Promise<ReleasePayload> {
  const response = await fetch('/api/versions', { cache: 'no-store', signal })
  const data = await responsePayload(response)
  if (!response.ok || data.ok !== true) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Unable to load release notes')
  }
  return data as ReleasePayload
}

function formatDate(value: string, settings: UserDateTimeSettings): string {
  return formatUserDateTime(value, settings, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    fallback: 'Unknown date',
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function totalObjects(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

function ReleaseChangeList({ title, items }: { title: string; items: string[] }) {
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700} color="text.primary" mb={0.75}>
        {title}
      </Typography>
      {items.length > 0 ? (
        <Box component="ul" sx={{ pl: 2.5, m: 0, color: 'text.secondary' }}>
          {items.map((item, index) => (
            <Typography
              component="li"
              variant="body2"
              color="text.secondary"
              key={`${index}-${item}`}
              sx={{ mb: 0.5, overflowWrap: 'anywhere' }}
            >
              {item}
            </Typography>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.disabled">None listed.</Typography>
      )}
    </Box>
  )
}

export default function VersionsSection() {
  const dateTimeSettings = useUserDateTime()
  const shortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')
  const [tab, setTab] = useState<'releases' | 'checkpoints'>('releases')
  const [payload, setPayload] = useState<ReleasePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checkpointDialogOpen, setCheckpointDialogOpen] = useState(false)
  const [checkpointLabel, setCheckpointLabel] = useState('Manual checkpoint')
  const [checkpointReason, setCheckpointReason] = useState('')
  const [creatingCheckpoint, setCreatingCheckpoint] = useState(false)
  const [operationStatus, setOperationStatus] = useState<OperationStatus | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    loadReleasePayload(controller.signal)
      .then((data) => {
        setPayload(data)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(error instanceof Error ? error.message : 'Unable to load release notes')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  function openCheckpointDialog() {
    setCheckpointLabel('Manual checkpoint')
    setCheckpointReason('')
    setOperationStatus(null)
    setCheckpointDialogOpen(true)
  }

  async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const label = checkpointLabel.trim()
    const reason = checkpointReason.trim()
    if (!label || !reason) {
      setOperationStatus({ severity: 'error', message: 'Label and reason are required.' })
      return
    }

    setCreatingCheckpoint(true)
    setOperationStatus(null)
    try {
      const response = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, reason }),
      })
      const data = await responsePayload(response)
      if (!response.ok || data.ok !== true || !data.checkpoint) {
        throw new Error(typeof data.error === 'string' ? data.error : 'Unable to create data checkpoint')
      }
      const checkpoint = data.checkpoint as DataCheckpoint
      setPayload((current) => current
        ? { ...current, checkpoints: [checkpoint, ...(current.checkpoints || [])] }
        : current)
      setOperationStatus({
        severity: 'success',
        message: `Checkpoint created: ${checkpoint.label} (${totalObjects(checkpoint.objectCounts)} objects, ${formatBytes(checkpoint.sizeBytes)}).`,
      })
      setCheckpointDialogOpen(false)
    } catch (error) {
      setOperationStatus({
        severity: 'error',
        message: error instanceof Error ? error.message : 'Unable to create data checkpoint',
      })
    } finally {
      setCreatingCheckpoint(false)
    }
  }

  const canManageBackups = payload?.access.manageBackups === true
  const localHistory = Boolean(
    payload?.releases.length && payload.releases.every((release) => release.environment === 'local'),
  )

  return (
    <Box
      data-testid="release-notes"
      sx={{
        width: '100%',
        maxWidth: 960,
        mx: 'auto',
        px: { xs: 2, sm: 3 },
        py: { xs: 3, sm: 4 },
        overflowX: 'hidden',
      }}
    >
      <Typography variant="h5" fontWeight={700} color="text.primary" mb={0.5}>
        Versions
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={3}>
        {localHistory
          ? 'Local Git history. Deployed release notes and checkpoints appear in hosted environments.'
          : 'Deployment history and logical application checkpoints.'}
      </Typography>

      {loading && (
        <Box display="flex" justifyContent="center" py={6}>
          <CircularProgress size={28} aria-label="Loading release notes" />
        </Box>
      )}

      {!loading && loadError && (
        <Alert severity="error" sx={{ borderRadius: 1 }}>
          {loadError}
        </Alert>
      )}

      {!loading && payload && (
        <>
          <Tabs
            value={tab}
            onChange={(_, value: 'releases' | 'checkpoints') => setTab(value)}
            aria-label="Release history views"
            sx={{ mb: 3, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Tab value="releases" label={localHistory ? 'Commits' : 'Release Notes'} sx={{ textTransform: 'none', color: 'text.secondary' }} />
            {canManageBackups && (
              <Tab
                data-testid="data-checkpoints-tab"
                value="checkpoints"
                label="Data Checkpoints"
                sx={{ textTransform: 'none', color: 'text.secondary' }}
              />
            )}
          </Tabs>

          {tab === 'releases' && (
            <Box data-testid="release-history">
              {payload.access.historyScope === 'last-30-days' && (
                <Box
                  data-testid="release-history-scope"
                  sx={{
                    px: 1.5,
                    py: 1.25,
                    mb: 2,
                    backgroundColor: 'rgba(168,199,250,0.08)',
                    borderLeft: '3px solid #A8C7FA',
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    Showing release history from the last {payload.access.historyDays || 30} days.
                  </Typography>
                </Box>
              )}

              {payload.releases.length === 0 && (
                <Typography variant="body2" color="text.secondary" py={2}>
                  {localHistory ? 'No local commits are available.' : 'No releases are recorded for this history window.'}
                </Typography>
              )}

              {payload.releases.map((release, index) => (
                <Box key={release.id}>
                  <Box data-testid="release-entry" sx={{ py: 2.5 }}>
                    <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" mb={1}>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(release.deployedAt, dateTimeSettings)}
                      </Typography>
                      <Chip
                        label={release.environment}
                        size="small"
                        sx={{
                          height: 22,
                          minHeight: 22,
                          borderRadius: 1,
                          fontSize: '0.68rem',
                          backgroundColor: 'rgba(207,198,234,0.10)',
                          color: '#CFC6EA',
                        }}
                      />
                      <Chip
                        label={release.shortCommit}
                        size="small"
                        sx={{
                          height: 22,
                          minHeight: 22,
                          borderRadius: 1,
                          fontSize: '0.68rem',
                          fontFamily: 'monospace',
                          backgroundColor: 'rgba(168,199,250,0.10)',
                          color: '#A8C7FA',
                        }}
                      />
                      {release.branch && (
                        <Typography variant="caption" color="text.disabled" sx={{ overflowWrap: 'anywhere' }}>
                          {release.branch}
                        </Typography>
                      )}
                    </Box>
                    <Typography variant="h6" fontSize="1rem" fontWeight={700} color="text.primary" mb={0.75}>
                      {release.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {release.summary || 'No summary provided.'}
                    </Typography>
                    {(release.features.length > 0 || release.fixes.length > 0) && (
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' },
                          gap: 2.5,
                          mt: 2,
                        }}
                      >
                        <ReleaseChangeList title="Features" items={release.features} />
                        <ReleaseChangeList title="Fixes" items={release.fixes} />
                      </Box>
                    )}
                  </Box>
                  {index < payload.releases.length - 1 && (
                    <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
                  )}
                </Box>
              ))}
            </Box>
          )}

          {tab === 'checkpoints' && canManageBackups && (
            <Box data-testid="data-checkpoints">
              <Box display="flex" alignItems="flex-start" justifyContent="space-between" gap={2} mb={1.5}>
                <Box minWidth={0}>
                  <Typography variant="subtitle1" fontWeight={700} color="text.primary">
                    Logical application checkpoints
                  </Typography>
                  <Typography variant="body2" color="text.secondary" mt={0.5}>
                    These capture durable ClawPilot records for recovery and audit. Railway provider backups are a separate infrastructure control and are not created or verified here.
                  </Typography>
                </Box>
                <Tooltip title="Create data checkpoint">
                  <IconButton
                    data-testid="create-data-checkpoint"
                    aria-label="Create data checkpoint"
                    onClick={openCheckpointDialog}
                    disabled={creatingCheckpoint}
                    sx={{ color: '#A8C7FA', flexShrink: 0 }}
                  >
                    {creatingCheckpoint ? <CircularProgress size={20} /> : <AddRounded />}
                  </IconButton>
                </Tooltip>
              </Box>

              {operationStatus && (
                <Alert
                  severity={operationStatus.severity}
                  onClose={() => setOperationStatus(null)}
                  sx={{ my: 2, borderRadius: 1 }}
                >
                  {operationStatus.message}
                </Alert>
              )}

              {(payload.checkpoints || []).length === 0 && (
                <Typography variant="body2" color="text.secondary" py={2}>
                  No logical data checkpoints have been created.
                </Typography>
              )}

              {(payload.checkpoints || []).map((checkpoint, index, checkpoints) => (
                <Box key={checkpoint.id}>
                  <Box data-testid="data-checkpoint-entry" sx={{ py: 2.25 }}>
                    <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" mb={0.75}>
                      <Typography variant="caption" color="text.secondary">
                        {formatDate(checkpoint.createdAt, dateTimeSettings)}
                      </Typography>
                      <Chip
                        label={checkpoint.providerBackupStatus === 'verified' ? 'Provider verified' : checkpoint.providerBackupStatus === 'failed' ? 'Provider check failed' : 'Provider not verified'}
                        size="small"
                        sx={{
                          height: 22,
                          minHeight: 22,
                          borderRadius: 1,
                          fontSize: '0.68rem',
                          backgroundColor: 'rgba(255,255,255,0.06)',
                          color: 'text.secondary',
                        }}
                      />
                    </Box>
                    <Typography variant="subtitle1" fontWeight={700} color="text.primary">
                      {checkpoint.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mt={0.5} sx={{ overflowWrap: 'anywhere' }}>
                      {checkpoint.reason}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" display="block" mt={1}>
                      Created by {checkpoint.createdBy || 'system'} · {totalObjects(checkpoint.objectCounts)} objects · {formatBytes(checkpoint.sizeBytes)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" display="block" mt={0.5} sx={{ overflowWrap: 'anywhere' }}>
                      {Object.entries(checkpoint.objectCounts).map(([name, count]) => `${name}: ${count}`).join(' · ')}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.disabled"
                      display="block"
                      mt={0.5}
                      sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
                    >
                      SHA-256 {checkpoint.checksum}
                    </Typography>
                  </Box>
                  {index < checkpoints.length - 1 && (
                    <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
                  )}
                </Box>
              ))}
            </Box>
          )}
        </>
      )}

      <Dialog
        open={checkpointDialogOpen}
        onClose={() => {
          if (!creatingCheckpoint) setCheckpointDialogOpen(false)
        }}
        maxWidth="sm"
        fullWidth
        fullScreen={shortLandscape}
        PaperProps={{
          sx: {
            backgroundColor: '#1A1A23',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: shortLandscape ? 0 : 1,
          },
        }}
      >
        <DialogTitle sx={{ color: 'text.primary', fontWeight: 700 }}>Create data checkpoint</DialogTitle>
        <Box component="form" onSubmit={createCheckpoint}>
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Capture the current durable application records as a logical recovery and audit checkpoint.
            </Typography>
            {operationStatus?.severity === 'error' && (
              <Alert severity="error" sx={{ borderRadius: 1 }}>
                {operationStatus.message}
              </Alert>
            )}
            <TextField
              label="Label"
              value={checkpointLabel}
              onChange={(event) => setCheckpointLabel(event.target.value)}
              inputProps={{ maxLength: 120 }}
              required
              autoFocus
            />
            <TextField
              label="Reason"
              value={checkpointReason}
              onChange={(event) => setCheckpointReason(event.target.value)}
              inputProps={{ maxLength: 1000 }}
              required
              multiline
              minRows={3}
            />
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
            <Button
              type="button"
              onClick={() => setCheckpointDialogOpen(false)}
              disabled={creatingCheckpoint}
              sx={{ color: 'text.secondary' }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              startIcon={creatingCheckpoint ? <CircularProgress size={16} color="inherit" /> : <AddRounded />}
              disabled={creatingCheckpoint}
            >
              Create checkpoint
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
