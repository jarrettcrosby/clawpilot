'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AnalyticsRounded from '@mui/icons-material/AnalyticsRounded'
import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import LocationOnRounded from '@mui/icons-material/LocationOnRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import RestaurantRounded from '@mui/icons-material/RestaurantRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import SyncRounded from '@mui/icons-material/SyncRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type AccessType = 'analytics' | 'standard'

type CredentialState = {
  accessType: AccessType
  configured: boolean
  apiBaseUrl: string | null
  clientIdLastFour: string | null
  clientSecretLastFour: string | null
  credentialVersion: number
  syncEnabled: boolean
  verifiedAt: string | null
  lastErrorCode: string | null
  updatedAt: string | null
}

type LocationState = {
  restaurantGuid: string
  restaurantName: string
  locationName: string | null
  locationCode: string | null
  timezone: string | null
  active: boolean
  testMode: boolean
  archived: boolean
  analyticsAccess: boolean
  standardAccess: boolean
  selected: boolean
  lastVerifiedAt: string | null
  updatedAt: string
}

type IntegrationState = {
  organizationId: string
  credentials: Record<AccessType, CredentialState>
  locations: LocationState[]
  jobs: { pending: number; processing: number; failed: number; dead: number; succeeded: number }
  accountingDrafts: { needsMapping: number; needsReview: number; approved: number; posted: number; failed: number }
  latestSyncAt: string | null
}

type ToastPayload = {
  ok?: boolean
  error?: string
  canManage?: boolean
  integration?: IntegrationState
  queued?: number
}

type CredentialForm = { apiBaseUrl: string; clientId: string; clientSecret: string }

const EMPTY_CREDENTIAL = (accessType: AccessType): CredentialState => ({
  accessType,
  configured: false,
  apiBaseUrl: null,
  clientIdLastFour: null,
  clientSecretLastFour: null,
  credentialVersion: 0,
  syncEnabled: false,
  verifiedAt: null,
  lastErrorCode: null,
  updatedAt: null,
})

const EMPTY_STATE: IntegrationState = {
  organizationId: '',
  credentials: { analytics: EMPTY_CREDENTIAL('analytics'), standard: EMPTY_CREDENTIAL('standard') },
  locations: [],
  jobs: { pending: 0, processing: 0, failed: 0, dead: 0, succeeded: 0 },
  accountingDrafts: { needsMapping: 0, needsReview: 0, approved: 0, posted: 0, failed: 0 },
  latestSyncAt: null,
}

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

const buttonSx = {
  minHeight: 40,
  borderRadius: '8px',
  px: 1.5,
  whiteSpace: 'nowrap',
  width: { xs: '100%', sm: 'auto' },
}

async function requestToast(init?: RequestInit): Promise<ToastPayload> {
  const response = await fetch('/api/integrations/toast', init)
  const result = await response.json().catch(() => ({})) as ToastPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'Toast integration request failed')
  return result
}

function yesterday() {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Toast integration request failed'
}

function accessLabel(accessType: AccessType) {
  return accessType === 'analytics' ? 'Analytics API' : 'Standard API'
}

export default function ToastIntegrationPanel() {
  const dateTimeSettings = useUserDateTime()
  const [integration, setIntegration] = useState(EMPTY_STATE)
  const [canManage, setCanManage] = useState(false)
  const [forms, setForms] = useState<Record<AccessType, CredentialForm>>({
    analytics: { apiBaseUrl: 'https://ws-api.toasttab.com', clientId: '', clientSecret: '' },
    standard: { apiBaseUrl: 'https://ws-api.toasttab.com', clientId: '', clientSecret: '' },
  })
  const [standardLocationGuid, setStandardLocationGuid] = useState('')
  const [businessDate, setBusinessDate] = useState(yesterday)
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const busy = Boolean(pendingAction)
  const syncEnabled = integration.credentials.analytics.syncEnabled || integration.credentials.standard.syncEnabled
  const selectedCount = integration.locations.filter((location) => location.selected).length

  useEffect(() => {
    let active = true
    requestToast()
      .then((result) => {
        if (!active) return
        if (result.integration) {
          setIntegration(result.integration)
          setForms((current) => ({
            analytics: {
              ...current.analytics,
              apiBaseUrl: result.integration?.credentials.analytics.apiBaseUrl || current.analytics.apiBaseUrl,
            },
            standard: {
              ...current.standard,
              apiBaseUrl: result.integration?.credentials.standard.apiBaseUrl || current.standard.apiBaseUrl,
            },
          }))
        }
        setCanManage(Boolean(result.canManage))
      })
      .catch((loadError) => setError(errorMessage(loadError)))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function patch(actionKey: string, body: Record<string, unknown>, success: string) {
    if (busy) return null
    setPendingAction(actionKey)
    setNotice('')
    setError('')
    try {
      const result = await requestToast({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result.integration) setIntegration(result.integration)
      setNotice(success)
      return result
    } catch (actionError) {
      setError(errorMessage(actionError))
      return null
    } finally {
      setPendingAction('')
    }
  }

  async function saveCredential(event: FormEvent, accessType: AccessType) {
    event.preventDefault()
    const form = forms[accessType]
    if (!form.apiBaseUrl.trim() || !form.clientId.trim() || !form.clientSecret.trim()) return
    const result = await patch(
      `save:${accessType}`,
      { action: 'update-credential', accessType, ...form },
      `${accessLabel(accessType)} credential verified and saved.`,
    )
    if (result) {
      setForms((current) => ({
        ...current,
        [accessType]: { ...current[accessType], clientId: '', clientSecret: '' },
      }))
    }
  }

  function updateForm(accessType: AccessType, field: keyof CredentialForm, value: string) {
    setForms((current) => ({
      ...current,
      [accessType]: { ...current[accessType], [field]: value },
    }))
  }

  async function verifyStandardLocation(event: FormEvent) {
    event.preventDefault()
    const restaurantGuid = standardLocationGuid.trim()
    if (!restaurantGuid) return
    const result = await patch(
      'verify-standard-location',
      { action: 'verify-standard-location', restaurantGuid },
      'Standard API location verified.',
    )
    if (result) setStandardLocationGuid('')
  }

  const latestSync = integration.latestSyncAt
    ? formatUserDateTime(integration.latestSyncAt, dateTimeSettings, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

  const credentialPanels = useMemo(() => (['analytics', 'standard'] as const), [])

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 320, placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Box sx={{ maxWidth: 840, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <RestaurantRounded color="primary" />
            <Typography variant="h6" fontWeight={700}>Toast</Typography>
            <Chip size="small" variant="outlined" label={`${selectedCount} locations selected`} />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            {latestSync ? `Last sync ${latestSync}` : 'No completed sync'}
          </Typography>
        </Box>
        <FormControlLabel
          control={(
            <Switch
              checked={syncEnabled}
              onChange={(_, enabled) => {
                void patch('configure-sync', { action: 'configure-sync', enabled }, enabled ? 'Daily sync enabled.' : 'Daily sync disabled.')
              }}
              disabled={!canManage || busy || (!integration.credentials.analytics.configured && !integration.credentials.standard.configured)}
            />
          )}
          label="Daily sync"
          sx={{ m: 0 }}
        />
      </Stack>

      <Divider sx={{ my: 3 }} />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        {credentialPanels.map((accessType) => {
          const credential = integration.credentials[accessType]
          const form = forms[accessType]
          return (
            <Box key={accessType} component="section" sx={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" mb={2} flexWrap="wrap" useFlexGap>
                {accessType === 'analytics' ? <AnalyticsRounded color="primary" /> : <CloudDoneRounded color="primary" />}
                <Typography fontWeight={700}>{accessLabel(accessType)}</Typography>
                <Chip
                  size="small"
                  color={credential.configured && !credential.lastErrorCode ? 'success' : credential.configured ? 'warning' : 'default'}
                  variant="outlined"
                  label={credential.configured ? credential.lastErrorCode ? 'Needs attention' : 'Connected' : 'Not connected'}
                />
              </Stack>
              <Box component="form" onSubmit={(event) => { void saveCredential(event, accessType) }}>
                <Stack spacing={1.5}>
                  <TextField
                    label="API access URL"
                    value={form.apiBaseUrl}
                    onChange={(event) => updateForm(accessType, 'apiBaseUrl', event.target.value)}
                    disabled={!canManage || busy}
                    size="small"
                    fullWidth
                    sx={fieldSx}
                  />
                  <TextField
                    label={credential.configured ? `Client ID ending ${credential.clientIdLastFour}` : 'Client ID'}
                    value={form.clientId}
                    onChange={(event) => updateForm(accessType, 'clientId', event.target.value)}
                    disabled={!canManage || busy}
                    size="small"
                    fullWidth
                    autoComplete="off"
                    sx={fieldSx}
                  />
                  <TextField
                    label={credential.configured ? `Client secret ending ${credential.clientSecretLastFour}` : 'Client secret'}
                    value={form.clientSecret}
                    onChange={(event) => updateForm(accessType, 'clientSecret', event.target.value)}
                    disabled={!canManage || busy}
                    size="small"
                    fullWidth
                    type="password"
                    autoComplete="new-password"
                    sx={fieldSx}
                  />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <Button
                      type="submit"
                      variant="contained"
                      startIcon={pendingAction === `save:${accessType}` ? <CircularProgress size={16} /> : credential.configured ? <KeyRounded /> : <SaveRounded />}
                      disabled={!canManage || busy || !form.apiBaseUrl.trim() || !form.clientId.trim() || !form.clientSecret.trim()}
                      sx={buttonSx}
                    >
                      {credential.configured ? 'Rotate credential' : 'Connect'}
                    </Button>
                    <Button
                      variant="outlined"
                      startIcon={<CloudDoneRounded />}
                      onClick={() => { void patch(`test:${accessType}`, { action: 'test-connection', accessType }, `${accessLabel(accessType)} connection verified.`) }}
                      disabled={!canManage || busy || !credential.configured}
                      sx={buttonSx}
                    >
                      Test
                    </Button>
                    <Button
                      color="error"
                      variant="text"
                      startIcon={<PowerSettingsNewRounded />}
                      onClick={() => { void patch(`disconnect:${accessType}`, { action: 'disconnect', accessType }, `${accessLabel(accessType)} disconnected.`) }}
                      disabled={!canManage || busy || !credential.configured}
                      sx={buttonSx}
                    >
                      Disconnect
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            </Box>
          )
        })}
      </Box>

      <Divider sx={{ my: 3 }} />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} mb={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <LocationOnRounded color="primary" />
          <Typography fontWeight={700}>Locations</Typography>
        </Stack>
        <Button
          variant="outlined"
          startIcon={pendingAction === 'refresh-locations' ? <CircularProgress size={16} /> : <RefreshRounded />}
          onClick={() => { void patch('refresh-locations', { action: 'refresh-analytics-locations' }, 'Analytics locations refreshed.') }}
          disabled={!canManage || busy || !integration.credentials.analytics.configured}
          sx={buttonSx}
        >
          Refresh Analytics locations
        </Button>
      </Stack>

      <Box component="form" onSubmit={(event) => { void verifyStandardLocation(event) }} sx={{ mb: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            label="Standard API restaurant GUID"
            value={standardLocationGuid}
            onChange={(event) => setStandardLocationGuid(event.target.value)}
            disabled={!canManage || busy || !integration.credentials.standard.configured}
            size="small"
            fullWidth
            sx={fieldSx}
          />
          <Button
            type="submit"
            variant="outlined"
            startIcon={pendingAction === 'verify-standard-location' ? <CircularProgress size={16} /> : <CloudDoneRounded />}
            disabled={!canManage || busy || !standardLocationGuid.trim() || !integration.credentials.standard.configured}
            sx={buttonSx}
          >
            Verify location
          </Button>
        </Stack>
      </Box>

      <Stack spacing={0} sx={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', overflow: 'hidden' }}>
        {integration.locations.length ? integration.locations.map((location, index) => (
          <Box key={location.restaurantGuid} sx={{ p: 1.5, borderTop: index ? '1px solid rgba(255,255,255,0.08)' : 0 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
              <Box minWidth={0}>
                <Typography fontWeight={650} noWrap>{location.restaurantName}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                  {location.restaurantGuid}{location.timezone ? ` · ${location.timezone}` : ''}
                </Typography>
                <Stack direction="row" spacing={0.75} mt={0.75} flexWrap="wrap" useFlexGap>
                  {location.analyticsAccess ? <Chip size="small" label="Analytics" variant="outlined" /> : null}
                  {location.standardAccess ? <Chip size="small" label="Standard" variant="outlined" /> : null}
                  {location.testMode ? <Chip size="small" color="warning" label="Test" variant="outlined" /> : null}
                  {location.archived ? <Chip size="small" color="error" label="Archived" variant="outlined" /> : null}
                </Stack>
              </Box>
              <Switch
                checked={location.selected}
                inputProps={{ 'aria-label': `Sync ${location.restaurantName}` }}
                onChange={(_, selected) => {
                  void patch(
                    `select:${location.restaurantGuid}`,
                    { action: 'select-location', restaurantGuid: location.restaurantGuid, selected },
                    `${location.restaurantName} ${selected ? 'selected' : 'removed'}.`,
                  )
                }}
                disabled={!canManage || busy || location.archived || !location.active}
              />
            </Stack>
          </Box>
        )) : (
          <Typography color="text.secondary" variant="body2" sx={{ p: 2 }}>No verified Toast locations</Typography>
        )}
      </Stack>

      <Divider sx={{ my: 3 }} />

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', md: 'center' }}>
        <Box>
          <Typography fontWeight={700}>Sales and accounting</Typography>
          <Stack direction="row" spacing={0.75} mt={1} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${integration.jobs.pending + integration.jobs.processing} syncing`} color="warning" variant="outlined" />
            <Chip size="small" label={`${integration.jobs.failed + integration.jobs.dead} failed`} color={integration.jobs.failed + integration.jobs.dead ? 'error' : 'default'} variant="outlined" />
            <Chip size="small" label={`${integration.accountingDrafts.needsMapping} need mapping`} variant="outlined" />
            <Chip size="small" label={`${integration.accountingDrafts.needsReview} need review`} color="info" variant="outlined" />
            <Chip size="small" label={`${integration.accountingDrafts.posted} posted`} color="success" variant="outlined" />
          </Stack>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            label="Business date"
            type="date"
            value={businessDate}
            onChange={(event) => setBusinessDate(event.target.value)}
            size="small"
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: new Date().toISOString().slice(0, 10) }}
            sx={{ ...fieldSx, minWidth: { sm: 180 } }}
          />
          <Button
            variant="contained"
            startIcon={pendingAction === 'queue-sync' ? <CircularProgress size={16} /> : <SyncRounded />}
            onClick={() => {
              void patch('queue-sync', { action: 'queue-sync', businessDate }, 'Toast sync queued.')
            }}
            disabled={!canManage || busy || !businessDate || selectedCount === 0}
            sx={buttonSx}
          >
            Sync date
          </Button>
        </Stack>
      </Stack>

      <Alert severity="info" icon={<KeyRounded />} sx={{ mt: 2.5, borderRadius: '8px' }}>
        QuickBooks exports remain drafts until accounts are mapped and an authorized user approves them.
      </Alert>
    </Box>
  )
}
