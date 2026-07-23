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
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type CarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest'
type CarrierEnvironment = 'sandbox' | 'production'

type CarrierAccountState = {
  globalId: string
  provider: CarrierProvider
  environment: CarrierEnvironment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  clientIdLastFour: string | null
  accountNumberLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  updatedAt: string
}

type CarrierIntegrationsState = {
  organizationId: string
  accounts: CarrierAccountState[]
}

type CarrierPayload = {
  ok?: boolean
  error?: string
  canManage?: boolean
  integrations?: CarrierIntegrationsState
  rateTest?: CarrierSandboxRateTest
}

type CarrierSandboxRateTest = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  fixture: {
    origin: { name: string; street: string; city: string; state: string; postalCode: string; countryCode: string }
    destination: { name: string; street: string; city: string; state: string; postalCode: string; countryCode: string }
    parcel: {
      description: string
      length: number
      width: number
      height: number
      dimensionUnit: string
      weight: number
      weightUnit: string
    }
  }
  rates: Array<{
    serviceCode: string
    serviceName: string
    amount: string
    currency: string
    rateType: string | null
    transitDays: number | null
    deliveryDate: string | null
  }>
  testedAt: string
  evidenceGlobalId: string
}

type CredentialForm = {
  displayName: string
  clientId: string
  clientSecret: string
  accountNumber: string
}

const PROVIDERS: Array<{ value: CarrierProvider; label: string }> = [
  { value: 'ups_rest', label: 'UPS' },
  { value: 'fedex_rest', label: 'FedEx' },
  { value: 'usps_rest', label: 'USPS' },
]

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

const buttonSx = {
  minHeight: 40,
  borderRadius: '8px',
  px: 1.5,
  width: { xs: '100%', sm: 'auto' },
}

function accountKey(provider: CarrierProvider, environment: CarrierEnvironment) {
  return `${provider}:${environment}`
}

function providerLabel(provider: CarrierProvider) {
  return PROVIDERS.find((entry) => entry.value === provider)?.label || provider
}

function emptyForm(provider: CarrierProvider, environment: CarrierEnvironment): CredentialForm {
  return {
    displayName: `${providerLabel(provider)} ${environment === 'sandbox' ? 'sandbox' : 'production'}`,
    clientId: '',
    clientSecret: '',
    accountNumber: '',
  }
}

async function requestCarriers(init?: RequestInit): Promise<CarrierPayload> {
  const response = await fetch('/api/integrations/carriers', init)
  const result = await response.json().catch(() => ({})) as CarrierPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'Carrier integration request failed')
  return result
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Carrier integration request failed'
}

export default function CarrierIntegrationPanel() {
  const dateTimeSettings = useUserDateTime()
  const [provider, setProvider] = useState<CarrierProvider>('ups_rest')
  const [environment, setEnvironment] = useState<CarrierEnvironment>('sandbox')
  const [integrations, setIntegrations] = useState<CarrierIntegrationsState>({ organizationId: '', accounts: [] })
  const [forms, setForms] = useState<Record<string, CredentialForm>>({})
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rateTest, setRateTest] = useState<CarrierSandboxRateTest | null>(null)

  const key = accountKey(provider, environment)
  const form = forms[key] || emptyForm(provider, environment)
  const account = useMemo(
    () => integrations.accounts.find((entry) => entry.provider === provider && entry.environment === environment) || null,
    [environment, integrations.accounts, provider],
  )
  const busy = Boolean(pendingAction)

  useEffect(() => {
    let active = true
    requestCarriers()
      .then((result) => {
        if (!active || !result.integrations) return
        setIntegrations(result.integrations)
        setForms((current) => {
          const next = { ...current }
          for (const configured of result.integrations?.accounts || []) {
            const configuredKey = accountKey(configured.provider, configured.environment)
            next[configuredKey] = {
              ...(next[configuredKey] || emptyForm(configured.provider, configured.environment)),
              displayName: configured.displayName,
            }
          }
          return next
        })
      })
      .catch((loadError) => setError(errorMessage(loadError)))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  function updateForm(field: keyof CredentialForm, value: string) {
    setForms((current) => ({
      ...current,
      [key]: { ...(current[key] || emptyForm(provider, environment)), [field]: value },
    }))
  }

  async function patch(actionKey: string, body: Record<string, unknown>, success: string) {
    if (busy) return null
    setPendingAction(actionKey)
    setNotice('')
    setError('')
    try {
      const result = await requestCarriers({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result.integrations) setIntegrations(result.integrations)
      setNotice(success)
      return result
    } catch (actionError) {
      setError(errorMessage(actionError))
      return null
    } finally {
      setPendingAction('')
    }
  }

  async function saveCredential(event: FormEvent) {
    event.preventDefault()
    if (!form.clientId.trim() || !form.clientSecret.trim()) return
    if (provider !== 'usps_rest' && !form.accountNumber.trim()) return
    const result = await patch(
      'save',
      {
        action: 'update-credential',
        provider,
        environment,
        displayName: form.displayName,
        clientId: form.clientId,
        clientSecret: form.clientSecret,
        accountNumber: form.accountNumber,
      },
      `${providerLabel(provider)} credential verified and saved.`,
    )
    if (result) {
      setForms((current) => ({
        ...current,
        [key]: { ...form, clientId: '', clientSecret: '', accountNumber: '' },
      }))
    }
  }

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 320, placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  const verifiedLabel = account?.verifiedAt
    ? formatUserDateTime(account.verifiedAt, dateTimeSettings, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

  return (
    <Box sx={{ maxWidth: 840, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <LocalShippingRounded color="primary" />
            <Typography variant="h6" fontWeight={700}>Carrier accounts</Typography>
            <Chip
              size="small"
              color={account?.verificationStatus === 'verified' ? 'success' : account?.verificationStatus === 'failed' ? 'error' : 'default'}
              variant={account?.verificationStatus === 'verified' ? 'filled' : 'outlined'}
              label={account?.verificationStatus === 'verified' ? 'Verified' : account?.configured ? 'Needs verification' : 'Not connected'}
            />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            {verifiedLabel ? `Verified ${verifiedLabel}` : 'UPS, FedEx, and USPS direct accounts'}
          </Typography>
        </Box>
        <Tooltip title={account?.configured ? 'Enable or disable this carrier account' : 'Connect credentials first'}>
          <span>
            <FormControlLabel
              control={(
                <Switch
                  checked={account?.status === 'active'}
                  onChange={(_, enabled) => {
                    void patch(
                      'enabled',
                      { action: 'set-enabled', provider, environment, enabled },
                      enabled ? `${providerLabel(provider)} enabled.` : `${providerLabel(provider)} disabled.`,
                    )
                  }}
                  disabled={!account?.configured || busy}
                />
              )}
              label={account?.status === 'active' ? 'Active' : account?.status === 'error' ? 'Error' : 'Disabled'}
              sx={{ m: 0 }}
            />
          </span>
        </Tooltip>
      </Stack>

      <Tabs
        value={provider}
        onChange={(_, value: CarrierProvider) => {
          setProvider(value)
          setConfirmDisconnect(false)
          setRateTest(null)
        }}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Carrier provider"
        sx={{ mt: 2, minHeight: 42, '& .MuiTab-root': { minHeight: 42 } }}
      >
        {PROVIDERS.map((entry) => <Tab key={entry.value} value={entry.value} label={entry.label} />)}
      </Tabs>

      <Divider sx={{ mb: 2 }} />

      <ToggleButtonGroup
        exclusive
        fullWidth
        size="small"
        value={environment}
        onChange={(_, value: CarrierEnvironment | null) => {
          if (value) {
            setEnvironment(value)
            setConfirmDisconnect(false)
            setRateTest(null)
          }
        }}
        aria-label="Carrier environment"
        sx={{ maxWidth: 420, mb: 2, '& .MuiToggleButton-root': { borderRadius: '8px' } }}
      >
        <ToggleButton
          value="sandbox"
          title="Provider developer environment: UPS CIE, FedEx Sandbox, or USPS TEM"
        >
          Sandbox / developer
        </ToggleButton>
        <ToggleButton value="production">Production</ToggleButton>
      </ToggleButtonGroup>

      {account?.configured ? (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={2}>
          <Chip size="small" icon={<KeyRounded />} label={`Client ending ${account.clientIdLastFour || 'unknown'}`} />
          {account.accountNumberLastFour ? <Chip size="small" label={`Account ending ${account.accountNumberLastFour}`} /> : null}
          <Chip size="small" variant="outlined" label={`Credential v${account.credentialVersion}`} />
          <Chip size="small" variant="outlined" label={account.globalId} />
        </Stack>
      ) : null}

      <Box component="form" onSubmit={saveCredential}>
        <TextField
          fullWidth
          label="Account name"
          value={form.displayName}
          onChange={(event) => updateForm('displayName', event.target.value)}
          disabled={busy}
          sx={{ ...fieldSx, mb: 1.5 }}
          inputProps={{ maxLength: 120 }}
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
          <TextField
            required
            label="Client ID"
            value={form.clientId}
            onChange={(event) => updateForm('clientId', event.target.value)}
            disabled={busy}
            autoComplete="off"
            sx={fieldSx}
          />
          <TextField
            required
            type="password"
            label="Client secret"
            value={form.clientSecret}
            onChange={(event) => updateForm('clientSecret', event.target.value)}
            disabled={busy}
            autoComplete="new-password"
            sx={fieldSx}
          />
        </Box>
        <TextField
          fullWidth
          required={provider !== 'usps_rest'}
          label={provider === 'usps_rest' ? 'USPS account number (optional)' : 'Billing account number'}
          value={form.accountNumber}
          onChange={(event) => updateForm('accountNumber', event.target.value)}
          disabled={busy}
          autoComplete="off"
          sx={{ ...fieldSx, mt: 1.5 }}
        />

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2} flexWrap="wrap" useFlexGap>
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'save' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !form.clientId.trim() || !form.clientSecret.trim() || (provider !== 'usps_rest' && !form.accountNumber.trim())}
            sx={buttonSx}
          >
            Save and verify
          </Button>
          <Button
            variant="outlined"
            startIcon={pendingAction === 'test' ? <CircularProgress size={16} color="inherit" /> : <CloudDoneRounded />}
            disabled={busy || !account?.configured}
            onClick={() => void patch(
              'test',
              { action: 'test-connection', provider, environment },
              `${providerLabel(provider)} connection verified.`,
            )}
            sx={buttonSx}
          >
            Test connection
          </Button>
          {environment === 'sandbox' && provider !== 'usps_rest' ? (
            <Tooltip title="Rates the fixed synthetic test parcel. No shipment, label, pickup, or charge is created.">
              <span>
                <Button
                  variant="outlined"
                  startIcon={pendingAction === 'rate' ? <CircularProgress size={16} color="inherit" /> : <PriceCheckRounded />}
                  disabled={busy || !account?.configured || account.verificationStatus !== 'verified'}
                  onClick={() => {
                    void patch(
                      'rate',
                      { action: 'test-sandbox-rate', provider, environment },
                      `${providerLabel(provider)} sandbox rates returned.`,
                    ).then((result) => {
                      if (result?.rateTest) setRateTest(result.rateTest)
                    })
                  }}
                  sx={buttonSx}
                >
                  Test sandbox rate
                </Button>
              </span>
            </Tooltip>
          ) : null}
          <Button
            color="error"
            variant="text"
            startIcon={<LinkOffRounded />}
            disabled={busy || !account?.configured}
            onClick={() => setConfirmDisconnect(true)}
            sx={buttonSx}
          >
            Disconnect
          </Button>
        </Stack>
      </Box>

      {environment === 'sandbox' && provider !== 'usps_rest' ? (
        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" fontWeight={700}>Sandbox rating fixture</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            John Doe, 101 Jegs Place, Delaware, OH 43015 to John Doe, 101 Academy Drive,
            Buzzards Bay, MA 02532. Test Product, 12 x 10 x 6 IN, 5 LB.
          </Typography>
          <Typography variant="caption" color="text.disabled">
            Rating only. ClawPilot does not create a shipment, label, pickup, manifest, or carrier charge.
          </Typography>
          {rateTest ? (
            <Stack spacing={0} sx={{ mt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
              {rateTest.rates.map((rate) => (
                <Box
                  key={`${rate.serviceCode}:${rate.rateType || 'default'}`}
                  sx={{
                    py: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(180px, 1fr) auto auto' },
                    gap: 1,
                    alignItems: 'center',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={650} noWrap>{rate.serviceName}</Typography>
                    <Typography variant="caption" color="text.disabled">{rate.serviceCode}</Typography>
                  </Box>
                  <Typography variant="body2" fontWeight={700}>{rate.currency} {rate.amount}</Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' }, textAlign: { sm: 'right' } }}
                  >
                    {rate.deliveryDate || (rate.transitDays !== null ? `${rate.transitDays} business days` : 'Transit estimate unavailable')}
                  </Typography>
                </Box>
              ))}
              <Typography variant="caption" color="text.disabled" sx={{ mt: 1 }}>
                Evidence {rateTest.evidenceGlobalId}
              </Typography>
            </Stack>
          ) : null}
        </Box>
      ) : null}

      {confirmDisconnect ? (
        <Alert
          severity="warning"
          sx={{ mt: 2, borderRadius: '8px' }}
          action={(
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
              <Button
                color="error"
                size="small"
                startIcon={<PowerSettingsNewRounded />}
                onClick={() => {
                  setConfirmDisconnect(false)
                  void patch(
                    'disconnect',
                    { action: 'disconnect', provider, environment },
                    `${providerLabel(provider)} credential disconnected.`,
                  )
                }}
              >
                Confirm
              </Button>
            </Stack>
          )}
        >
          Remove the encrypted credential for this account?
        </Alert>
      ) : null}
    </Box>
  )
}
