'use client'

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
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
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded'
import CloudOffRounded from '@mui/icons-material/CloudOffRounded'
import DriveFileMoveRounded from '@mui/icons-material/DriveFileMoveRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import UploadFileRounded from '@mui/icons-material/UploadFileRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'
import IntegrationSetupJourney from '@/components/settings/IntegrationSetupJourney'

type GoogleIntegrationState = {
  configured: boolean
  ready: boolean
  apiKeyConfigured: boolean
  apiKeyLastFour: string | null
  serviceAccountConfigured: boolean
  projectId: string | null
  serviceAccountEmail: string | null
  privateKeyId: string | null
  credentialVersion: number
  sharedDriveConfigured: boolean
  sharedDriveName: string | null
  verifiedAt: string | null
  updatedAt: string | null
}

type SharedDrive = {
  id: string
  name: string
}

type GoogleIntegrationPayload = {
  ok?: boolean
  error?: string
  integration?: Partial<GoogleIntegrationState>
  sharedDrives?: Array<Partial<SharedDrive>>
}

const EMPTY_INTEGRATION: GoogleIntegrationState = {
  configured: false,
  ready: false,
  apiKeyConfigured: false,
  apiKeyLastFour: null,
  serviceAccountConfigured: false,
  projectId: null,
  serviceAccountEmail: null,
  privateKeyId: null,
  credentialVersion: 0,
  sharedDriveConfigured: false,
  sharedDriveName: null,
  verifiedAt: null,
  updatedAt: null,
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
    backgroundColor: '#20202A',
  },
}

const commandButtonSx = {
  minHeight: 40,
  borderRadius: '8px',
  px: 1.5,
  whiteSpace: 'nowrap',
  width: { xs: '100%', sm: 'auto' },
}

function normalizeIntegration(value: Partial<GoogleIntegrationState> | undefined): GoogleIntegrationState {
  return {
    configured: Boolean(value?.configured),
    ready: Boolean(value?.ready),
    apiKeyConfigured: Boolean(value?.apiKeyConfigured),
    apiKeyLastFour: value?.apiKeyLastFour ? String(value.apiKeyLastFour).slice(-4) : null,
    serviceAccountConfigured: Boolean(value?.serviceAccountConfigured),
    projectId: value?.projectId ? String(value.projectId).slice(0, 128) : null,
    serviceAccountEmail: value?.serviceAccountEmail ? String(value.serviceAccountEmail).slice(0, 254) : null,
    privateKeyId: value?.privateKeyId ? String(value.privateKeyId).slice(0, 256) : null,
    credentialVersion: Number.isFinite(Number(value?.credentialVersion)) ? Number(value?.credentialVersion) : 0,
    sharedDriveConfigured: Boolean(value?.sharedDriveConfigured),
    sharedDriveName: value?.sharedDriveName ? String(value.sharedDriveName).slice(0, 160) : null,
    verifiedAt: value?.verifiedAt ? String(value.verifiedAt) : null,
    updatedAt: value?.updatedAt ? String(value.updatedAt) : null,
  }
}

function normalizeSharedDrives(value: GoogleIntegrationPayload['sharedDrives']): SharedDrive[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, SharedDrive>()
  for (const item of value) {
    const id = String(item?.id || '').trim()
    const name = String(item?.name || '').trim()
    if (!id || !name || id.length > 256 || name.length > 160) continue
    byId.set(id, { id, name })
  }
  return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name))
}

async function requestGoogleWorkspace(init?: RequestInit): Promise<GoogleIntegrationPayload> {
  const response = await fetch('/api/integrations/google-workspace', init)
  const result = await response.json().catch(() => ({})) as GoogleIntegrationPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'Google Workspace request failed')
  return result
}

function formattedDate(value: string | null, settings: UserDateTimeSettings) {
  return formatUserDateTime(value, settings, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) || null
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function readinessLabel(integration: GoogleIntegrationState) {
  if (integration.ready) return 'Ready'
  if (!integration.apiKeyConfigured) return 'Needs API key'
  if (!integration.serviceAccountConfigured) return 'Needs service account'
  if (!integration.sharedDriveConfigured) return 'Needs Shared Drive'
  return 'Needs verification'
}

export default function GoogleWorkspaceIntegrationPanel() {
  const dateTimeSettings = useUserDateTime()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [integration, setIntegration] = useState<GoogleIntegrationState>(EMPTY_INTEGRATION)
  const [apiKey, setApiKey] = useState('')
  const [serviceAccountJson, setServiceAccountJson] = useState('')
  const [serviceAccountFileName, setServiceAccountFileName] = useState('')
  const [sharedDrives, setSharedDrives] = useState<SharedDrive[]>([])
  const [selectedSharedDriveId, setSelectedSharedDriveId] = useState('')
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [disconnectOpen, setDisconnectOpen] = useState(false)

  const busy = pendingAction !== null

  useEffect(() => {
    let active = true
    setLoading(true)
    requestGoogleWorkspace()
      .then((result) => {
        if (!active) return
        setIntegration(normalizeIntegration(result.integration))
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, 'Unable to load Google Workspace settings'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  function startAction(action: string) {
    setPendingAction(action)
    setNotice('')
    setError('')
  }

  async function patch(action: string, body: Record<string, unknown>, success: string) {
    if (busy) return null
    startAction(action)
    try {
      const result = await requestGoogleWorkspace({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setIntegration(normalizeIntegration(result.integration))
      if (result.sharedDrives) setSharedDrives(normalizeSharedDrives(result.sharedDrives))
      setNotice(success)
      return result
    } catch (actionError) {
      setError(errorMessage(actionError, 'Unable to update Google Workspace settings'))
      return null
    } finally {
      setPendingAction(null)
    }
  }

  async function saveApiKey(event: FormEvent) {
    event.preventDefault()
    const value = apiKey.trim()
    if (!value) return
    const result = await patch(
      'api-key',
      { action: 'update-credential', apiKey: value },
      integration.apiKeyConfigured ? 'Google API key rotated.' : 'Google API key saved.',
    )
    if (result) setApiKey('')
  }

  async function saveServiceAccount(event: FormEvent) {
    event.preventDefault()
    if (!serviceAccountJson.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(serviceAccountJson)
    } catch {
      setError('Service account file must contain valid JSON.')
      return
    }
    const result = await patch(
      'service-account',
      { action: 'update-credential', serviceAccountJson: parsed },
      integration.serviceAccountConfigured ? 'Service account key rotated.' : 'Service account connected.',
    )
    if (result) {
      setServiceAccountJson('')
      setServiceAccountFileName('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleServiceAccountFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 64 * 1024) {
      setError('Service account file must be 64 KB or smaller.')
      event.target.value = ''
      return
    }
    try {
      const contents = await file.text()
      JSON.parse(contents)
      setServiceAccountJson(contents)
      setServiceAccountFileName(file.name.slice(0, 180))
      setError('')
    } catch {
      setError('Service account file must contain valid JSON.')
      event.target.value = ''
    }
  }

  async function refreshSharedDrives() {
    const result = await patch(
      'shared-drives',
      { action: 'refresh-shared-drives' },
      'Accessible Shared Drives refreshed.',
    )
    if (result) setSelectedSharedDriveId('')
  }

  async function selectSharedDrive() {
    if (!selectedSharedDriveId) return
    const selected = sharedDrives.find((drive) => drive.id === selectedSharedDriveId)
    const result = await patch(
      'select-shared-drive',
      { action: 'select-shared-drive', sharedDriveId: selectedSharedDriveId },
      `${selected?.name || 'Shared Drive'} selected.`,
    )
    if (result) setSelectedSharedDriveId('')
  }

  async function testConnection() {
    await patch('test-connection', { action: 'test-connection' }, 'Google Workspace connection verified.')
  }

  async function disconnect() {
    if (busy) return
    startAction('disconnect')
    try {
      const result = await requestGoogleWorkspace({ method: 'DELETE' })
      setIntegration(normalizeIntegration(result.integration))
      setApiKey('')
      setServiceAccountJson('')
      setServiceAccountFileName('')
      setSharedDrives([])
      setSelectedSharedDriveId('')
      setDisconnectOpen(false)
      setNotice('Google Workspace disconnected.')
    } catch (disconnectError) {
      setError(errorMessage(disconnectError, 'Unable to disconnect Google Workspace'))
    } finally {
      setPendingAction(null)
    }
  }

  if (loading) {
    return (
      <Box display="grid" sx={{ minHeight: 320, placeItems: 'center' }}>
        <CircularProgress size={28} aria-label="Loading Google Workspace settings" />
      </Box>
    )
  }

  const verifiedAt = formattedDate(integration.verifiedAt, dateTimeSettings)

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" spacing={1.5}>
        <Box minWidth={0}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6" color="text.primary" fontWeight={700}>Google Workspace</Typography>
            <Chip
              size="small"
              color={integration.ready ? 'success' : integration.configured ? 'warning' : 'default'}
              variant="outlined"
              label={readinessLabel(integration)}
              sx={{ height: 26, minHeight: 26 }}
            />
          </Stack>
          {verifiedAt ? <Typography variant="caption" color="text.disabled">Verified {verifiedAt}</Typography> : null}
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button
            variant="outlined"
            startIcon={pendingAction === 'test-connection' ? <CircularProgress size={16} /> : <CloudDoneRounded />}
            onClick={() => { void testConnection() }}
            disabled={busy || !integration.serviceAccountConfigured}
            sx={commandButtonSx}
          >
            Test connection
          </Button>
          <Button
            variant="text"
            color="error"
            startIcon={<PowerSettingsNewRounded />}
            onClick={() => setDisconnectOpen(true)}
            disabled={busy || !integration.configured}
            sx={commandButtonSx}
          >
            Disconnect
          </Button>
        </Stack>
      </Stack>

      <Box sx={{ mt: 2 }}>
        <IntegrationSetupJourney
          description="Add the two credential parts, select the operator-owned Shared Drive, and verify the complete workspace boundary."
          steps={[
            {
              key: 'google-api-key',
              label: 'Save the Google API key',
              state: integration.apiKeyConfigured ? 'complete' : 'current',
              description:
                'The API key supports bounded public API requests. The saved value remains masked in Settings.',
              facts: [
                {
                  label: 'Saved key',
                  value: integration.apiKeyLastFour
                    ? `••••${integration.apiKeyLastFour}`
                    : 'Not stored',
                },
              ],
            },
            {
              key: 'google-service-account',
              label: 'Upload the service account',
              state: integration.serviceAccountConfigured
                ? 'complete'
                : integration.apiKeyConfigured
                  ? 'current'
                  : 'pending',
              description:
                'Upload the service-account JSON. ClawPilot stores the private credential encrypted and exposes only nonsecret identity facts.',
              facts: [
                {
                  label: 'Service account',
                  value: integration.serviceAccountEmail || 'Not configured',
                  copyable: Boolean(integration.serviceAccountEmail),
                },
                {
                  label: 'Google Cloud project',
                  value: integration.projectId || 'Not configured',
                  copyable: Boolean(integration.projectId),
                },
                {
                  label: 'Credential version',
                  value: integration.credentialVersion
                    ? String(integration.credentialVersion)
                    : 'Not allocated',
                },
              ],
            },
            {
              key: 'google-shared-drive',
              label: 'Select the writable Shared Drive',
              state: integration.sharedDriveConfigured
                ? 'complete'
                : integration.serviceAccountConfigured
                  ? 'current'
                  : 'pending',
              description:
                'The selected Shared Drive is the writable operator table boundary. Inherited drive access remains governed by Google.',
              facts: [
                {
                  label: 'Shared Drive',
                  value: integration.sharedDriveName || 'Not selected',
                },
              ],
            },
            {
              key: 'google-verify',
              label: 'Test the complete connection',
              state: integration.ready
                ? 'complete'
                : integration.configured
                  ? 'attention'
                  : 'pending',
              description:
                'The final test verifies the service identity and selected drive without exposing credential material.',
              facts: [
                {
                  label: 'Connection state',
                  value: readinessLabel(integration),
                },
                {
                  label: 'Verified',
                  value: verifiedAt || 'Not yet',
                },
              ],
            },
          ]}
        />
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box component="form" onSubmit={saveApiKey}>
        <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25} flexWrap="wrap" useFlexGap>
          <KeyRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
          <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Google API key</Typography>
          {integration.apiKeyLastFour ? <Chip size="small" variant="outlined" label={`Ends in ${integration.apiKeyLastFour}`} sx={{ height: 24, minHeight: 24 }} /> : null}
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}>
          <TextField
            size="small"
            type="password"
            label="API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            name="google-api-key"
            inputProps={{ maxLength: 512, spellCheck: false }}
            disabled={busy}
            sx={fieldSx}
          />
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'api-key' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !apiKey.trim()}
            sx={commandButtonSx}
          >
            {integration.apiKeyConfigured ? 'Rotate key' : 'Save key'}
          </Button>
        </Box>
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box component="form" onSubmit={saveServiceAccount}>
        <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25} flexWrap="wrap" useFlexGap>
          <UploadFileRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
          <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Service account</Typography>
          {integration.serviceAccountConfigured ? <Chip size="small" color="success" variant="outlined" label="Connected" sx={{ height: 24, minHeight: 24 }} /> : null}
        </Stack>
        {integration.serviceAccountEmail ? (
          <Box mb={1.5}>
            <Typography variant="body2" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>{integration.serviceAccountEmail}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{integration.projectId}</Typography>
          </Box>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => { void handleServiceAccountFile(event) }}
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Button
            type="button"
            variant="outlined"
            startIcon={<UploadFileRounded />}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            sx={commandButtonSx}
          >
            Choose JSON
          </Button>
          <Typography variant="body2" color={serviceAccountFileName ? 'text.primary' : 'text.secondary'} sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {serviceAccountFileName || 'No credential file selected'}
          </Typography>
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'service-account' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !serviceAccountJson.trim()}
            sx={{ ...commandButtonSx, ml: { sm: 'auto' } }}
          >
            {integration.serviceAccountConfigured ? 'Rotate credential' : 'Connect'}
          </Button>
        </Stack>
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box>
        <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25} flexWrap="wrap" useFlexGap>
          <DriveFileMoveRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
          <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Shared Drive</Typography>
          {integration.sharedDriveName ? <Chip size="small" color="success" variant="outlined" label={integration.sharedDriveName} sx={{ height: 24, minHeight: 24, maxWidth: '100%' }} /> : null}
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
          <Button
            variant="outlined"
            startIcon={pendingAction === 'shared-drives' ? <CircularProgress size={16} /> : <RefreshRounded />}
            onClick={() => { void refreshSharedDrives() }}
            disabled={busy || !integration.serviceAccountConfigured}
            sx={commandButtonSx}
          >
            Refresh drives
          </Button>
          <FormControl size="small" sx={{ minWidth: { xs: '100%', sm: 260 }, flex: 1, ...fieldSx }} disabled={busy || sharedDrives.length === 0}>
            <InputLabel id="google-shared-drive-label">Shared Drive</InputLabel>
            <Select
              labelId="google-shared-drive-label"
              value={selectedSharedDriveId}
              label="Shared Drive"
              onChange={(event) => setSelectedSharedDriveId(String(event.target.value))}
            >
              {sharedDrives.map((drive) => <MenuItem key={drive.id} value={drive.id}>{drive.name}</MenuItem>)}
            </Select>
          </FormControl>
          <Button
            variant="contained"
            startIcon={pendingAction === 'select-shared-drive' ? <CircularProgress size={16} color="inherit" /> : <DriveFileMoveRounded />}
            onClick={() => { void selectSharedDrive() }}
            disabled={busy || !selectedSharedDriveId}
            sx={commandButtonSx}
          >
            Select
          </Button>
        </Stack>
        {!integration.sharedDriveConfigured && integration.serviceAccountConfigured ? (
          <Alert severity="warning" icon={<CloudOffRounded />} sx={{ mt: 1.5, borderRadius: '8px' }}>
            Select an accessible Shared Drive before creating managed pipeline Sheets.
          </Alert>
        ) : null}
      </Box>

      <Dialog
        open={disconnectOpen}
        onClose={() => { if (!busy) setDisconnectOpen(false) }}
        aria-labelledby="disconnect-google-title"
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '8px' } }}
      >
        <DialogTitle id="disconnect-google-title" fontWeight={700}>Disconnect Google Workspace?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            This removes the saved API key, service-account credential, and Shared Drive selection from this ClawPilot environment.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setDisconnectOpen(false)} disabled={busy}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            startIcon={pendingAction === 'disconnect' ? <CircularProgress size={16} color="inherit" /> : <PowerSettingsNewRounded />}
            onClick={() => { void disconnect() }}
            disabled={busy}
          >
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
