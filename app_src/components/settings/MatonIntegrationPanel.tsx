'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddRounded from '@mui/icons-material/AddRounded'
import CloudRounded from '@mui/icons-material/CloudRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import EmailRounded from '@mui/icons-material/EmailRounded'
import ExtensionRounded from '@mui/icons-material/ExtensionRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import TableChartRounded from '@mui/icons-material/TableChartRounded'
import type { SvgIconComponent } from '@mui/icons-material'

type ApiPayload = {
  ok?: boolean
  error?: string
  authorizationUrl?: string
  credential?: ApiMatonCredential
  platformCredentialAvailable?: boolean
}

type ApiMatonConnection = {
  provider?: string | null
  app?: string | null
  label?: string | null
  name?: string | null
  connectionId?: string | null
  accountEmail?: string | null
  email?: string | null
  status?: string | null
  selected?: boolean
  isSelected?: boolean
  isDefault?: boolean
  default?: boolean
  updatedAt?: string | null
  remoteUpdatedAt?: string | null
}

type ApiMatonCredential = {
  configured?: boolean
  loginEmail?: string | null
  keyLastFour?: string | null
  connections?: ApiMatonConnection[] | null
  updatedAt?: string | null
}

type MatonConnection = {
  provider: string
  app: string
  label: string
  connectionId: string
  maskedId: string
  accountEmail: string
  status: string
  isDefault: boolean
  updatedAt: string | null
}

type MatonIntegration = {
  configured: boolean
  loginEmail: string
  keyLastFour: string
  platformCredentialAvailable: boolean
  connections: MatonConnection[]
  updatedAt: string | null
}

type ConnectionDefinition = {
  app: string
  label: string
  aliases: string[]
  Icon: SvgIconComponent
}

const CONNECTIONS: ConnectionDefinition[] = [
  { app: 'google-mail', label: 'Gmail', aliases: ['google-mail', 'gmail'], Icon: EmailRounded },
  { app: 'google-sheets', label: 'Google Sheets', aliases: ['google-sheets', 'sheets'], Icon: TableChartRounded },
  { app: 'google-drive', label: 'Google Drive', aliases: ['google-drive', 'drive'], Icon: CloudRounded },
  { app: 'slack', label: 'Slack', aliases: ['slack'], Icon: ExtensionRounded },
  { app: 'notion', label: 'Notion', aliases: ['notion'], Icon: ExtensionRounded },
  { app: 'hubspot', label: 'HubSpot', aliases: ['hubspot'], Icon: ExtensionRounded },
  { app: 'salesforce', label: 'Salesforce', aliases: ['salesforce'], Icon: ExtensionRounded },
  { app: 'airtable', label: 'Airtable', aliases: ['airtable'], Icon: ExtensionRounded },
  { app: 'asana', label: 'Asana', aliases: ['asana'], Icon: ExtensionRounded },
  { app: 'github', label: 'GitHub', aliases: ['github'], Icon: ExtensionRounded },
  { app: 'linear', label: 'Linear', aliases: ['linear'], Icon: ExtensionRounded },
  { app: 'stripe', label: 'Stripe', aliases: ['stripe'], Icon: ExtensionRounded },
  { app: 'monday', label: 'Monday', aliases: ['monday'], Icon: ExtensionRounded },
  { app: 'outlook', label: 'Outlook', aliases: ['outlook'], Icon: EmailRounded },
  { app: 'microsoft-teams', label: 'Microsoft Teams', aliases: ['microsoft-teams'], Icon: ExtensionRounded },
  { app: 'dropbox', label: 'Dropbox', aliases: ['dropbox'], Icon: CloudRounded },
  { app: 'quickbooks', label: 'QuickBooks', aliases: ['quickbooks'], Icon: ExtensionRounded },
  { app: 'squarespace', label: 'Squarespace', aliases: ['squarespace'], Icon: ExtensionRounded },
  { app: 'vercel', label: 'Vercel', aliases: ['vercel'], Icon: ExtensionRounded },
  { app: 'zoom', label: 'Zoom', aliases: ['zoom'], Icon: ExtensionRounded },
  { app: 'google-calendar', label: 'Google Calendar', aliases: ['google-calendar'], Icon: ExtensionRounded },
]

const CONNECTION_OPTIONS = CONNECTIONS.filter(({ app }) => app !== 'google-sheets' && app !== 'google-drive')
const MATON_APP_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

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

async function requestMaton(init?: RequestInit): Promise<ApiPayload> {
  const response = await fetch('/api/integrations/maton', init)
  const result = await response.json().catch(() => ({})) as ApiPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'Maton request failed')
  return result
}

function maskConnectionId(value: unknown) {
  const connectionId = String(value || '').trim()
  if (!connectionId) return ''
  if (connectionId.length <= 4) return '*'.repeat(connectionId.length)
  if (connectionId.length <= 8) return `${connectionId.slice(0, 2)}...${connectionId.slice(-2)}`
  return `${connectionId.slice(0, 4)}...${connectionId.slice(-4)}`
}

function cleanStatus(value: unknown, hasConnection: boolean) {
  const status = String(value || '').trim().slice(0, 40)
  if (!status) return hasConnection ? 'Connected' : 'Not connected'
  return status
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function normalizeIntegration(
  value: ApiMatonCredential | undefined,
  platformCredentialAvailable: unknown,
): MatonIntegration {
  const connections = Array.isArray(value?.connections) ? value.connections : []
  return {
    configured: Boolean(value?.configured),
    loginEmail: String(value?.loginEmail || '').trim(),
    keyLastFour: String(value?.keyLastFour || '').trim().slice(-4),
    platformCredentialAvailable: Boolean(platformCredentialAvailable),
    connections: connections.map((connection) => {
      const provider = String(connection.provider || connection.app || '').trim().toLowerCase()
      const app = String(connection.app || connection.provider || '').trim().toLowerCase()
      const connectionId = String(connection.connectionId || '').trim()
      const maskedId = maskConnectionId(connectionId)
      return {
        provider,
        app,
        label: String(connection.label || connection.name || app || provider || 'Connection').trim().slice(0, 80),
        connectionId,
        maskedId,
        accountEmail: String(connection.accountEmail || connection.email || '').trim().slice(0, 254),
        status: cleanStatus(connection.status, Boolean(maskedId)),
        isDefault: connection.selected === true || connection.isSelected === true || connection.isDefault === true || connection.default === true,
        updatedAt: connection.updatedAt || connection.remoteUpdatedAt ? String(connection.updatedAt || connection.remoteUpdatedAt) : null,
      }
    }),
    updatedAt: value?.updatedAt ? String(value.updatedAt) : null,
  }
}

async function getIntegration() {
  const result = await requestMaton()
  if (!result.credential) throw new Error('Maton credential response was incomplete')
  return normalizeIntegration(result.credential, result.platformCredentialAvailable)
}

async function integrationFrom(result: ApiPayload) {
  return result.credential
    ? normalizeIntegration(result.credential, result.platformCredentialAvailable)
    : getIntegration()
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

function definitionForConnection(connection: MatonConnection) {
  return CONNECTIONS.find((definition) => (
    definition.aliases.includes(connection.app) || definition.aliases.includes(connection.provider)
  )) || null
}

function normalizeAppId(value: string) {
  const normalized = value.trim().toLowerCase()
  const definition = CONNECTIONS.find((candidate) => (
    candidate.app === normalized
    || candidate.label.toLowerCase() === normalized
    || candidate.aliases.includes(normalized)
  ))
  return definition?.app || normalized
}

function definitionForApp(value: string) {
  const app = normalizeAppId(value)
  return CONNECTIONS.find((definition) => definition.app === app || definition.aliases.includes(app)) || null
}

function appDisplayLabel(value: string) {
  const app = normalizeAppId(value)
  return definitionForApp(app)?.label || app
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' {
  const normalized = status.toLowerCase()
  if (normalized.includes('error') || normalized.includes('fail') || normalized.includes('expired')) return 'error'
  if (normalized.includes('pending') || normalized.includes('authoriz')) return 'warning'
  if (normalized.includes('not connect') || normalized.includes('disconnect') || normalized.includes('inactive')) return 'default'
  if (normalized.includes('connect') || normalized.includes('active') || normalized.includes('ready')) return 'success'
  return 'default'
}

function validHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export default function MatonIntegrationPanel({
  isOwner,
  embedded = false,
}: {
  isOwner: boolean
  embedded?: boolean
}) {
  const [integration, setIntegration] = useState<MatonIntegration | null>(null)
  const [loginEmail, setLoginEmail] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [connectionApp, setConnectionApp] = useState('')
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [disconnectOpen, setDisconnectOpen] = useState(false)

  const busy = pendingAction !== null
  const savedLoginEmail = integration?.loginEmail || ''
  const loginEmailValue = loginEmail.trim()
  const loginEmailValid = !loginEmailValue || isEmail(loginEmailValue)
  const loginEmailDirty = loginEmailValue !== savedLoginEmail
  const hasApiKey = Boolean(integration?.keyLastFour)
  const hasSavedIntegration = Boolean(
    integration?.configured
      || integration?.loginEmail
      || integration?.keyLastFour
      || integration?.connections.length,
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    getIntegration()
      .then((next) => {
        if (!active) return
        setIntegration(next)
        setLoginEmail(next.loginEmail)
      })
      .catch((loadError) => {
        if (active) setError(messageFrom(loadError, 'Unable to load Maton settings'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  function startAction(key: string) {
    setPendingAction(key)
    setError('')
    setNotice('')
  }

  function finishAction() {
    setPendingAction(null)
  }

  async function patchIntegration(
    key: string,
    body: Record<string, unknown>,
    successMessage: string,
  ) {
    if (busy) return null
    startAction(key)
    try {
      const result = await requestMaton({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const next = await integrationFrom(result)
      setIntegration(next)
      setNotice(successMessage)
      return next
    } catch (actionError) {
      setError(messageFrom(actionError, 'Unable to update Maton settings'))
      return null
    } finally {
      finishAction()
    }
  }

  async function saveLoginEmail(event: FormEvent) {
    event.preventDefault()
    if (busy || !loginEmailValid || !loginEmailDirty) return
    const next = await patchIntegration(
      'maton-profile',
      { action: 'update-credential', loginEmail: loginEmailValue },
      'Maton login email saved.',
    )
    if (next) setLoginEmail(next.loginEmail)
  }

  async function saveApiKey(event: FormEvent) {
    event.preventDefault()
    const value = apiKey.trim()
    if (busy || !value) return
    try {
      await patchIntegration(
        'maton-api-key',
        { action: 'update-credential', apiKey: value },
        hasApiKey ? 'Maton API key rotated.' : 'Maton API key saved.',
      )
    } finally {
      setApiKey('')
    }
  }

  async function refreshConnections() {
    await patchIntegration(
      'refresh-connections',
      { action: 'refresh-connections' },
      'Maton connections refreshed.',
    )
  }

  async function importPlatformCredential() {
    await patchIntegration(
      'import-platform-credential',
      { action: 'import-platform-credential' },
      'Existing ClawPilot key connected to your Maton account.',
    )
  }

  async function createConnection() {
    if (busy || !hasApiKey) return
    const app = normalizeAppId(connectionApp)
    if (!MATON_APP_PATTERN.test(app)) {
      setError('Enter a valid Maton application ID.')
      return
    }
    const label = appDisplayLabel(app)
    const authorizationWindow = window.open('about:blank', '_blank')
    if (!authorizationWindow) {
      setError('Allow pop-ups to open Maton authorization.')
      return
    }
    authorizationWindow.opener = null

    startAction(`create-connection:${app}`)
    try {
      const result = await requestMaton({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-connection', app }),
      })
      const authorizationUrl = String(result.authorizationUrl || '')
      if (!validHttpsUrl(authorizationUrl)) throw new Error('Maton returned an invalid authorization URL')

      authorizationWindow.location.assign(authorizationUrl)
      const next = await integrationFrom(result)
      setIntegration(next)
      setConnectionApp('')
      setNotice(`${label} authorization opened.`)
    } catch (createError) {
      authorizationWindow.close()
      setError(messageFrom(createError, `Unable to add ${label}`))
    } finally {
      finishAction()
    }
  }

  async function selectConnection(connection: MatonConnection) {
    if (!connection.connectionId) return
    await patchIntegration(
      `select-connection:${connection.connectionId}`,
      { action: 'select-connection', connectionId: connection.connectionId },
      'Default Maton connection updated.',
    )
  }

  async function disconnect() {
    if (busy) return
    startAction('disconnect-maton')
    try {
      const result = await requestMaton({ method: 'DELETE' })
      const next = await integrationFrom(result)
      setIntegration(next)
      setLoginEmail(next.loginEmail)
      setApiKey('')
      setDisconnectOpen(false)
      setNotice('Maton disconnected.')
    } catch (disconnectError) {
      setError(messageFrom(disconnectError, 'Unable to disconnect Maton'))
    } finally {
      finishAction()
    }
  }

  if (loading) {
    return (
      <Box
        {...(embedded ? {} : { role: 'tabpanel', id: 'settings-panel-3', 'aria-labelledby': 'settings-tab-3' })}
        display="grid"
        sx={{ minHeight: 320, placeItems: 'center' }}
      >
        <CircularProgress size={28} aria-label="Loading Maton settings" />
      </Box>
    )
  }

  return (
    <Box
      {...(embedded ? {} : { role: 'tabpanel', id: 'settings-panel-3', 'aria-labelledby': 'settings-tab-3' })}
      aria-busy={busy}
      sx={{ maxWidth: 720, mx: 'auto' }}
    >
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Box component="section" aria-labelledby="maton-heading">
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" spacing={1.5}>
          <Box minWidth={0}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography id="maton-heading" variant="h6" color="text.primary" fontWeight={700}>Maton</Typography>
              <Chip
                size="small"
                color={integration?.configured ? 'success' : 'default'}
                variant="outlined"
                label={integration?.configured ? 'Configured' : 'Not configured'}
                sx={{ height: 26, minHeight: 26 }}
              />
            </Stack>
            {formatUpdatedAt(integration?.updatedAt) ? (
              <Typography variant="caption" color="text.disabled">
                Updated {formatUpdatedAt(integration?.updatedAt)}
              </Typography>
            ) : null}
          </Box>
          <Button
            variant="text"
            color="error"
            startIcon={<PowerSettingsNewRounded />}
            onClick={() => setDisconnectOpen(true)}
            disabled={busy || !hasSavedIntegration}
            sx={commandButtonSx}
          >
            Disconnect
          </Button>
        </Stack>
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box component="section" aria-labelledby="maton-account-heading">
        <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25}>
          <EmailRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
          <Typography id="maton-account-heading" variant="subtitle2" color="text.primary" fontWeight={700}>Account</Typography>
        </Stack>
        <Box
          component="form"
          onSubmit={saveLoginEmail}
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}
        >
          <TextField
            size="small"
            type="email"
            label="Maton login email"
            value={loginEmail}
            onChange={(event) => setLoginEmail(event.target.value)}
            error={!loginEmailValid}
            helperText={!loginEmailValid ? 'Enter a valid email address.' : ' '}
            disabled={busy}
            inputProps={{ maxLength: 254, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
            sx={fieldSx}
          />
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'maton-profile' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !loginEmailValid || !loginEmailDirty}
            sx={{ ...commandButtonSx, alignSelf: 'start' }}
          >
            Save email
          </Button>
        </Box>
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box component="section" aria-labelledby="maton-key-heading">
        <Stack direction="row" spacing={0.75} alignItems="center" mb={1.25} flexWrap="wrap" useFlexGap>
          <KeyRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
          <Typography id="maton-key-heading" variant="subtitle2" color="text.primary" fontWeight={700}>API key</Typography>
          {integration?.keyLastFour ? (
            <Chip size="small" variant="outlined" label={`Ends in ${integration.keyLastFour}`} sx={{ height: 24, minHeight: 24, fontSize: '0.72rem' }} />
          ) : null}
        </Stack>
        <Box
          component="form"
          onSubmit={saveApiKey}
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto' }, gap: 1 }}
        >
          <TextField
            size="small"
            type="password"
            label="Maton API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            helperText={hasApiKey ? `Saved key ending in ${integration?.keyLastFour}.` : 'No API key saved.'}
            disabled={busy}
            autoComplete="new-password"
            name="maton-api-key"
            inputProps={{ maxLength: 512, spellCheck: false }}
            sx={fieldSx}
          />
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'maton-api-key' ? <CircularProgress size={16} color="inherit" /> : <KeyRounded />}
            disabled={busy || !apiKey.trim()}
            sx={{ ...commandButtonSx, alignSelf: 'start' }}
          >
            {hasApiKey ? 'Rotate key' : 'Set key'}
          </Button>
        </Box>
        {isOwner && integration?.platformCredentialAvailable && !hasApiKey ? (
          <Button
            variant="outlined"
            startIcon={pendingAction === 'import-platform-credential' ? <CircularProgress size={16} /> : <KeyRounded />}
            onClick={() => { void importPlatformCredential() }}
            disabled={busy}
            sx={{ ...commandButtonSx, mt: 1 }}
          >
            Use existing ClawPilot key
          </Button>
        ) : null}
      </Box>

      <Divider sx={{ my: 3, borderColor: 'rgba(255,255,255,0.08)' }} />

      <Box component="section" aria-labelledby="maton-connections-heading">
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} mb={1.25}>
          <Typography id="maton-connections-heading" variant="subtitle2" color="text.primary" fontWeight={700}>Connections</Typography>
        </Box>

        {!hasApiKey ? (
          <Alert severity="info" sx={{ borderRadius: '8px' }}>Set an API key to manage Maton connections.</Alert>
        ) : (
          <>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'flex-start' }} mb={2}>
              <Button
                variant="outlined"
                startIcon={pendingAction === 'refresh-connections' ? <CircularProgress size={16} /> : <RefreshRounded />}
                onClick={() => { void refreshConnections() }}
                disabled={busy}
                sx={commandButtonSx}
              >
                Refresh connections
              </Button>
              <Autocomplete
                freeSolo
                disableClearable
                options={CONNECTION_OPTIONS.map(({ app }) => app)}
                inputValue={connectionApp}
                onInputChange={(_event, value) => setConnectionApp(value)}
                getOptionLabel={(option) => appDisplayLabel(option)}
                disabled={busy}
                sx={{ minWidth: { xs: '100%', sm: 240 }, flex: 1 }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    size="small"
                    label="Maton application"
                    inputProps={{ ...params.inputProps, maxLength: 64, autoCapitalize: 'none', spellCheck: false }}
                    sx={fieldSx}
                  />
                )}
              />
              <Button
                variant="outlined"
                startIcon={pendingAction?.startsWith('create-connection:') ? <CircularProgress size={16} /> : <AddRounded />}
                onClick={() => { void createConnection() }}
                disabled={busy || !MATON_APP_PATTERN.test(normalizeAppId(connectionApp))}
                sx={commandButtonSx}
              >
                Add connection
              </Button>
            </Stack>

            <Box aria-live="polite">
              {integration?.connections.length ? integration.connections.map((connection, index) => {
                const definition = definitionForConnection(connection)
                const Icon = definition?.Icon || CloudRounded
                const appLabel = definition?.label || connection.label || connection.app || connection.provider || 'Maton connection'
                const status = connection.status || 'Not connected'
                const updatedAt = formatUpdatedAt(connection.updatedAt)
                const selectKey = `select-connection:${connection.connectionId}`
                return (
                  <Box key={`${connection.app}:${connection.connectionId}:${index}`}>
                    {index > 0 ? <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} /> : null}
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' },
                        gap: 1.5,
                        alignItems: { xs: 'start', sm: 'center' },
                        py: 1.75,
                      }}
                    >
                      <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
                        <Icon sx={{ fontSize: 22, color: 'primary.main', flexShrink: 0 }} />
                        <Box minWidth={0}>
                          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography variant="body2" color="text.primary" fontWeight={700}>{appLabel}</Typography>
                            <Chip
                              size="small"
                              color={statusColor(status)}
                              variant="outlined"
                              label={status}
                              sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }}
                            />
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                            {connection.accountEmail || connection.label || 'Account email unavailable'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                            {connection.maskedId ? `ID ${connection.maskedId}` : 'No connection ID'}
                          </Typography>
                          {updatedAt ? <Typography variant="caption" color="text.disabled">Updated {updatedAt}</Typography> : null}
                        </Box>
                      </Stack>
                      {connection.isDefault ? (
                        <Chip
                          size="small"
                          color="primary"
                          variant="outlined"
                          label="Default"
                          sx={{ minWidth: 84, justifySelf: { xs: 'start', sm: 'end' } }}
                        />
                      ) : (
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={pendingAction === selectKey ? <CircularProgress size={16} /> : <CheckRounded />}
                          onClick={() => { void selectConnection(connection) }}
                          disabled={busy || !connection.connectionId || connection.status.toLowerCase() !== 'active'}
                          aria-label={`Select ${appLabel}${connection.accountEmail ? ` for ${connection.accountEmail}` : ''} as default`}
                          sx={{ ...commandButtonSx, justifySelf: { xs: 'stretch', sm: 'end' } }}
                        >
                          Select
                        </Button>
                      )}
                    </Box>
                  </Box>
                )
              }) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 1.75 }}>No Maton connections found.</Typography>
              )}
            </Box>
          </>
        )}
      </Box>

      <Dialog
        open={disconnectOpen}
        onClose={() => { if (!busy) setDisconnectOpen(false) }}
        aria-labelledby="disconnect-maton-title"
        aria-describedby="disconnect-maton-description"
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { backgroundColor: '#1A1A23', backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '8px' } }}
      >
        <DialogTitle id="disconnect-maton-title" fontWeight={700}>Disconnect Maton?</DialogTitle>
        <DialogContent>
          <Typography id="disconnect-maton-description" variant="body2" color="text.secondary">
            This removes the saved Maton API key and connections for your ClawPilot account. Your Maton login email remains saved.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setDisconnectOpen(false)} disabled={busy}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            startIcon={pendingAction === 'disconnect-maton' ? <CircularProgress size={16} color="inherit" /> : <PowerSettingsNewRounded />}
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
