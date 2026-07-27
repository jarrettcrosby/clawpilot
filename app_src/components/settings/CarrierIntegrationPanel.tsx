'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
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
import AddRounded from '@mui/icons-material/AddRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'
import IntegrationSetupJourney from '@/components/settings/IntegrationSetupJourney'

type CarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest'
type CarrierEnvironment = 'sandbox' | 'production'

type CarrierAddress = {
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: string
}

type OperationsCarrierAccount = {
  globalId: string
  displayName: string
  senderName: string
  accountNumberLastFour: string
  registeredAddress: CarrierAddress
  addressVerification: 'unverified' | 'operator_attested' | 'provider_verified'
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
  status: 'needs_configuration' | 'active' | 'disabled'
  updatedAt: string
}

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
  carrierAccounts: OperationsCarrierAccount[]
}

type CarrierIntegrationsState = {
  organizationId: string
  accounts: CarrierAccountState[]
}

type CarrierPayload = {
  ok?: boolean
  error?: string
  canManage?: boolean
  canRevealCredentials?: boolean
  integrations?: CarrierIntegrationsState
  rateTest?: CarrierSandboxRateTest
  credential?: RevealedCarrierCredential
}

type RevealedCarrierCredential = {
  provider: CarrierProvider
  environment: CarrierEnvironment
  clientId: string
  clientSecret: string
  credentialVersion: number
  revealedAt: string
  expiresAt: string
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
  carrierAccountGlobalId: string
  billingRelationship: 'sender' | 'recipient' | 'third_party'
  evidenceGlobalId: string
}

type CredentialForm = {
  displayName: string
  clientId: string
  clientSecret: string
}

type CarrierAccountForm = {
  displayName: string
  senderName: string
  accountNumber: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  countryCode: string
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
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
  }
}

function emptyCarrierAccountForm(): CarrierAccountForm {
  return {
    displayName: '',
    senderName: '',
    accountNumber: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: 'US',
    allowSenderBilling: true,
    allowRecipientBilling: true,
    allowThirdPartyBilling: true,
  }
}

async function requestCarriers(init?: RequestInit): Promise<CarrierPayload> {
  const response = await fetch('/api/integrations/carriers', { cache: 'no-store', ...init })
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
  const [carrierAccountForm, setCarrierAccountForm] = useState<CarrierAccountForm>(emptyCarrierAccountForm)
  const [editingCarrierAccountGlobalId, setEditingCarrierAccountGlobalId] = useState('')
  const [selectedCarrierAccounts, setSelectedCarrierAccounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rateTest, setRateTest] = useState<CarrierSandboxRateTest | null>(null)
  const [canRevealCredentials, setCanRevealCredentials] = useState(false)
  const [revealedCredential, setRevealedCredential] = useState<RevealedCarrierCredential | null>(null)

  const key = accountKey(provider, environment)
  const form = forms[key] || emptyForm(provider, environment)
  const account = useMemo(
    () => integrations.accounts.find((entry) => entry.provider === provider && entry.environment === environment) || null,
    [environment, integrations.accounts, provider],
  )
  const activeCarrierAccounts = useMemo(
    () => (account?.carrierAccounts || []).filter((entry) => entry.status === 'active'),
    [account?.carrierAccounts],
  )
  const explicitCarrierAccountGlobalId = selectedCarrierAccounts[key] || ''
  const selectedCarrierAccountGlobalId = activeCarrierAccounts.some(
    (entry) => entry.globalId === explicitCarrierAccountGlobalId,
  )
    ? explicitCarrierAccountGlobalId
    : activeCarrierAccounts.length === 1 ? activeCarrierAccounts[0].globalId : ''
  const busy = Boolean(pendingAction)
  const sandboxRateBlocker = !account?.configured
    ? 'Save and verify provider credentials first.'
    : account.verificationStatus !== 'verified'
      ? 'Verify the provider credentials first.'
      : account.status !== 'active'
        ? 'Enable this sandbox integration.'
        : !activeCarrierAccounts.length
          ? 'Add and enable a sandbox billing account with its registered address.'
          : !selectedCarrierAccountGlobalId
            ? 'Select the sandbox billing account to use for the test.'
            : ''

  useEffect(() => {
    let active = true
    requestCarriers()
      .then((result) => {
        if (!active || !result.integrations) return
        setIntegrations(result.integrations)
        setCanRevealCredentials(result.canRevealCredentials === true)
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

  useEffect(() => {
    if (!revealedCredential) return
    const timeout = window.setTimeout(
      () => setRevealedCredential(null),
      Math.max(0, Date.parse(revealedCredential.expiresAt) - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [revealedCredential])

  function updateForm(field: keyof CredentialForm, value: string) {
    setForms((current) => ({
      ...current,
      [key]: { ...(current[key] || emptyForm(provider, environment)), [field]: value },
    }))
  }

  function updateCarrierAccountForm<K extends keyof CarrierAccountForm>(
    field: K,
    value: CarrierAccountForm[K],
  ) {
    setCarrierAccountForm((current) => ({ ...current, [field]: value }))
  }

  function resetCarrierAccountForm() {
    setCarrierAccountForm(emptyCarrierAccountForm())
    setEditingCarrierAccountGlobalId('')
  }

  function editCarrierAccount(entry: OperationsCarrierAccount) {
    setEditingCarrierAccountGlobalId(entry.globalId)
    setCarrierAccountForm({
      displayName: entry.displayName,
      senderName: entry.senderName,
      accountNumber: '',
      line1: entry.registeredAddress.line1,
      line2: entry.registeredAddress.line2 || '',
      city: entry.registeredAddress.city,
      region: entry.registeredAddress.region,
      postalCode: entry.registeredAddress.postalCode,
      countryCode: entry.registeredAddress.countryCode,
      allowSenderBilling: entry.allowSenderBilling,
      allowRecipientBilling: entry.allowRecipientBilling,
      allowThirdPartyBilling: entry.allowThirdPartyBilling,
    })
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
    const result = await patch(
      'save',
      {
        action: 'update-credential',
        provider,
        environment,
        displayName: form.displayName,
        clientId: form.clientId,
        clientSecret: form.clientSecret,
      },
      `${providerLabel(provider)} credential verified and saved.`,
    )
    if (result) {
      setRevealedCredential(null)
      setForms((current) => ({
        ...current,
        [key]: { ...form, clientId: '', clientSecret: '' },
      }))
    }
  }

  async function revealCredential() {
    if (!account?.configured || busy) return
    if (!window.confirm(
      `Reveal the current ${providerLabel(provider)} ${environment} client credentials? This action is audited.`,
    )) return
    const result = await patch(
      'reveal',
      { action: 'reveal-credential', provider, environment },
      'Credentials revealed for 30 seconds.',
    )
    if (result?.credential) setRevealedCredential(result.credential)
  }

  async function copyCredential(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(`${label} copied.`)
    } catch {
      setError(`${label} could not be copied. Select the value and copy it manually.`)
    }
  }

  async function saveCarrierAccount(event: FormEvent) {
    event.preventDefault()
    if (
      !carrierAccountForm.displayName.trim()
      || !carrierAccountForm.senderName.trim()
      || (!editingCarrierAccountGlobalId && !carrierAccountForm.accountNumber.trim())
      || !carrierAccountForm.line1.trim()
      || !carrierAccountForm.city.trim()
      || !carrierAccountForm.region.trim()
      || !carrierAccountForm.postalCode.trim()
      || !carrierAccountForm.countryCode.trim()
    ) return
    const result = await patch(
      editingCarrierAccountGlobalId ? 'update-account' : 'create-account',
      {
        action: editingCarrierAccountGlobalId ? 'update-account' : 'create-account',
        provider,
        environment,
        ...(editingCarrierAccountGlobalId
          ? { carrierAccountGlobalId: editingCarrierAccountGlobalId }
          : {}),
        displayName: carrierAccountForm.displayName,
        senderName: carrierAccountForm.senderName,
        ...(carrierAccountForm.accountNumber.trim()
          ? { accountNumber: carrierAccountForm.accountNumber }
          : {}),
        registeredAddress: {
          line1: carrierAccountForm.line1,
          line2: carrierAccountForm.line2 || null,
          city: carrierAccountForm.city,
          region: carrierAccountForm.region,
          postalCode: carrierAccountForm.postalCode,
          countryCode: carrierAccountForm.countryCode,
        },
        allowSenderBilling: carrierAccountForm.allowSenderBilling,
        allowRecipientBilling: carrierAccountForm.allowRecipientBilling,
        allowThirdPartyBilling: carrierAccountForm.allowThirdPartyBilling,
      },
      editingCarrierAccountGlobalId ? 'Carrier account updated.' : 'Carrier account added.',
    )
    if (result) resetCarrierAccountForm()
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
            <Typography variant="h6" fontWeight={700}>Carrier integrations</Typography>
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

      <Box sx={{ mt: 2 }}>
        <IntegrationSetupJourney
          description="Scope the provider lane, verify its credential, bind a billing identity, and activate only after the safe test boundary is ready."
          steps={[
            {
              key: 'carrier-scope',
              label: 'Choose provider and environment',
              state: 'complete',
              description:
                'Provider and sandbox/production are independent credential lanes. Changing either selection updates every later setup fact.',
              facts: [
                { label: 'Provider', value: providerLabel(provider) },
                {
                  label: 'Environment',
                  value: environment === 'sandbox'
                    ? 'Sandbox / developer'
                    : 'Production',
                },
              ],
            },
            {
              key: 'carrier-credential',
              label: 'Save and verify provider credentials',
              state: account?.verificationStatus === 'verified'
                ? 'complete'
                : account?.configured
                  ? 'attention'
                  : 'current',
              description:
                'ClawPilot verifies the provider identity before the credential can be activated. Secret values remain masked unless an authorized audited reveal is requested.',
              facts: [
                {
                  label: 'ClawPilot integration ID',
                  value: account?.globalId || 'Not allocated',
                  copyable: Boolean(account?.globalId),
                },
                {
                  label: 'Stored credential',
                  value: account?.configured
                    ? `Version ${account.credentialVersion} · client ••••${
                      account.clientIdLastFour || 'unknown'
                    }`
                    : 'Not stored',
                },
                {
                  label: 'Verified',
                  value: verifiedLabel || 'Not yet',
                },
              ],
            },
            {
              key: 'carrier-billing',
              label: 'Add the carrier billing account',
              state: activeCarrierAccounts.length
                ? 'complete'
                : account?.verificationStatus === 'verified'
                  ? 'current'
                  : 'pending',
              description:
                'The account number, registered address, sender name, and payer roles are operational identity; they are separate from the API credential.',
              facts: [
                {
                  label: 'Active billing accounts',
                  value: String(activeCarrierAccounts.length),
                },
                {
                  label: 'Selected billing account',
                  value: selectedCarrierAccountGlobalId || 'Not selected',
                  copyable: Boolean(selectedCarrierAccountGlobalId),
                },
              ],
            },
            {
              key: 'carrier-activate',
              label: 'Activate and validate',
              state: account?.status === 'active'
                ? 'complete'
                : account?.verificationStatus === 'verified'
                  && activeCarrierAccounts.length
                  ? 'current'
                  : 'pending',
              description:
                'Activation is explicit. Sandbox rating remains read-only and cannot create a shipment, label, pickup, or charge.',
              facts: [
                {
                  label: 'Integration status',
                  value: account?.status || 'Not connected',
                },
                {
                  label: 'Latest sandbox evidence',
                  value: rateTest?.evidenceGlobalId || 'No rate test loaded',
                  copyable: Boolean(rateTest?.evidenceGlobalId),
                },
              ],
            },
          ]}
        />
      </Box>

      <Tabs
        value={provider}
        onChange={(_, value: CarrierProvider) => {
          setProvider(value)
          setRevealedCredential(null)
          setConfirmDisconnect(false)
          setRateTest(null)
          resetCarrierAccountForm()
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
            setRevealedCredential(null)
            setConfirmDisconnect(false)
            setRateTest(null)
            resetCarrierAccountForm()
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
          <Chip size="small" variant="outlined" label={`Credential v${account.credentialVersion}`} />
          <Chip size="small" variant="outlined" label={account.globalId} />
        </Stack>
      ) : null}

      {environment === 'sandbox' && provider !== 'usps_rest' && sandboxRateBlocker ? (
        <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
          <Typography variant="body2" fontWeight={700}>Sandbox rate test setup</Typography>
          <Typography variant="body2">{sandboxRateBlocker}</Typography>
          <Typography variant="caption" color="text.secondary">
            Provider credentials and carrier billing accounts are separate. The account number and its
            registered address determine sender, recipient, or third-party billing for the test request.
          </Typography>
        </Alert>
      ) : null}

      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Provider credentials</Typography>
      <Box component="form" onSubmit={saveCredential}>
        <TextField
          fullWidth
          label="Connection name"
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
        {environment === 'sandbox' && provider !== 'usps_rest' && activeCarrierAccounts.length ? (
          <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
            <InputLabel id="sandbox-carrier-account-label">Sandbox billing account</InputLabel>
            <Select
              labelId="sandbox-carrier-account-label"
              label="Sandbox billing account"
              value={selectedCarrierAccountGlobalId}
              onChange={(event) => setSelectedCarrierAccounts((current) => ({
                ...current,
                [key]: event.target.value,
              }))}
              disabled={busy || activeCarrierAccounts.length === 1}
            >
              {activeCarrierAccounts.map((entry) => (
                <MenuItem key={entry.globalId} value={entry.globalId}>
                  {entry.displayName} ending {entry.accountNumberLastFour}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2} flexWrap="wrap" useFlexGap>
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'save' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !form.clientId.trim() || !form.clientSecret.trim()}
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
          {canRevealCredentials ? (
            <Button
              variant="outlined"
              startIcon={pendingAction === 'reveal' ? <CircularProgress size={16} color="inherit" /> : <VisibilityRounded />}
              disabled={busy || !account?.configured}
              onClick={() => void revealCredential()}
              sx={buttonSx}
            >
              Reveal credentials
            </Button>
          ) : null}
          {environment === 'sandbox' && provider !== 'usps_rest' ? (
            <Tooltip title={sandboxRateBlocker || 'Rates the fixed synthetic test parcel. No shipment, label, pickup, or charge is created.'}>
              <span>
                <Button
                  variant="outlined"
                  startIcon={pendingAction === 'rate' ? <CircularProgress size={16} color="inherit" /> : <PriceCheckRounded />}
                  disabled={
                    busy
                    || Boolean(sandboxRateBlocker)
                  }
                  onClick={() => {
                    void patch(
                      'rate',
                      {
                        action: 'test-sandbox-rate',
                        provider,
                        environment,
                        ...(activeCarrierAccounts.length > 1
                          ? { carrierAccountGlobalId: selectedCarrierAccountGlobalId }
                          : {}),
                      },
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

      {revealedCredential
        && revealedCredential.provider === provider
        && revealedCredential.environment === environment ? (
          <Alert
            severity="warning"
            sx={{ mt: 2, borderRadius: '8px', alignItems: 'flex-start' }}
            action={(
              <Tooltip title="Hide credentials">
                <IconButton
                  color="inherit"
                  size="small"
                  onClick={() => setRevealedCredential(null)}
                  aria-label="Hide carrier credentials"
                >
                  <VisibilityOffRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          >
            <Typography variant="body2" fontWeight={700}>
              Visible for 30 seconds
            </Typography>
            <Typography variant="caption" color="inherit">
              Copy these values only to a trusted system. This reveal was recorded in organization activity.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}>
              <TextField
                label="Client ID"
                value={revealedCredential.clientId}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Copy client ID">
                        <IconButton
                          edge="end"
                          onClick={() => void copyCredential('Client ID', revealedCredential.clientId)}
                          aria-label="Copy carrier client ID"
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
                sx={fieldSx}
              />
              <TextField
                label="Client secret"
                value={revealedCredential.clientSecret}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Copy client secret">
                        <IconButton
                          edge="end"
                          onClick={() => void copyCredential('Client secret', revealedCredential.clientSecret)}
                          aria-label="Copy carrier client secret"
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
                sx={fieldSx}
              />
            </Box>
          </Alert>
        ) : null}

      {account?.configured ? (
        <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Billing accounts</Typography>
            </Box>
            {editingCarrierAccountGlobalId ? (
              <Button size="small" onClick={resetCarrierAccountForm} disabled={busy}>Cancel edit</Button>
            ) : null}
          </Stack>

          <Stack spacing={0} sx={{ mt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            {(account.carrierAccounts || []).map((entry) => (
              <Box
                key={entry.globalId}
                sx={{
                  py: 1.25,
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto auto' },
                  gap: 1,
                  alignItems: 'center',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" fontWeight={650}>{entry.displayName}</Typography>
                    <Chip size="small" variant="outlined" label={`ending ${entry.accountNumberLastFour}`} />
                    <Chip size="small" variant="outlined" label={entry.globalId} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    Sender: {entry.senderName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {entry.registeredAddress.line1}, {entry.registeredAddress.city}, {entry.registeredAddress.region}{' '}
                    {entry.registeredAddress.postalCode}
                  </Typography>
                </Box>
                <FormControlLabel
                  control={(
                    <Switch
                      size="small"
                      checked={entry.status === 'active'}
                      disabled={busy || entry.status === 'needs_configuration'}
                      onChange={(_, enabled) => void patch(
                        `status-${entry.globalId}`,
                        {
                          action: 'set-account-status',
                          provider,
                          environment,
                          carrierAccountGlobalId: entry.globalId,
                          status: enabled ? 'active' : 'disabled',
                        },
                        enabled ? 'Carrier account enabled.' : 'Carrier account disabled.',
                      )}
                    />
                  )}
                  label={entry.status === 'active' ? 'Active' : 'Disabled'}
                  sx={{ m: 0 }}
                />
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Edit carrier account">
                    <span>
                      <Button
                        size="small"
                        startIcon={<EditRounded />}
                        onClick={() => editCarrierAccount(entry)}
                        disabled={busy}
                      >
                        Edit
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Delete unused carrier account">
                    <span>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteOutlineRounded />}
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete ${entry.displayName}?`)) return
                          void patch(
                            `delete-${entry.globalId}`,
                            {
                              action: 'delete-account',
                              provider,
                              environment,
                              carrierAccountGlobalId: entry.globalId,
                            },
                            'Carrier account deleted.',
                          )
                        }}
                      >
                        Delete
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              </Box>
            ))}
          </Stack>

          <Box component="form" onSubmit={saveCarrierAccount} sx={{ mt: 2 }}>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
              {editingCarrierAccountGlobalId ? 'Edit billing account' : 'Add billing account'}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              <TextField
                required
                label="Account name"
                value={carrierAccountForm.displayName}
                onChange={(event) => updateCarrierAccountForm('displayName', event.target.value)}
                disabled={busy}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <TextField
                required={!editingCarrierAccountGlobalId}
                label={editingCarrierAccountGlobalId ? 'New account number (optional)' : 'Account number'}
                value={carrierAccountForm.accountNumber}
                onChange={(event) => updateCarrierAccountForm('accountNumber', event.target.value)}
                disabled={busy}
                autoComplete="off"
                sx={fieldSx}
              />
              <TextField
                required
                label="Sender name"
                value={carrierAccountForm.senderName}
                onChange={(event) => updateCarrierAccountForm('senderName', event.target.value)}
                disabled={busy}
                inputProps={{ maxLength: 120 }}
                helperText="Used as the shipper name for carrier rating and labels."
                sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
              />
              <TextField
                required
                label="Registered address line 1"
                value={carrierAccountForm.line1}
                onChange={(event) => updateCarrierAccountForm('line1', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                label="Registered address line 2"
                value={carrierAccountForm.line2}
                onChange={(event) => updateCarrierAccountForm('line2', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="City"
                value={carrierAccountForm.city}
                onChange={(event) => updateCarrierAccountForm('city', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="State / region"
                value={carrierAccountForm.region}
                onChange={(event) => updateCarrierAccountForm('region', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="Postal code"
                value={carrierAccountForm.postalCode}
                onChange={(event) => updateCarrierAccountForm('postalCode', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="Country code"
                value={carrierAccountForm.countryCode}
                onChange={(event) => updateCarrierAccountForm('countryCode', event.target.value.toUpperCase())}
                disabled={busy}
                inputProps={{ maxLength: 2 }}
                sx={fieldSx}
              />
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={1}>
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowSenderBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowSenderBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Sender"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowRecipientBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowRecipientBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Recipient"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowThirdPartyBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowThirdPartyBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Third party"
              />
            </Stack>
            <Button
              type="submit"
              variant="outlined"
              startIcon={<AddRounded />}
              disabled={busy}
              sx={buttonSx}
            >
              {editingCarrierAccountGlobalId ? 'Save account' : 'Add account'}
            </Button>
          </Box>
        </Box>
      ) : null}

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
                {rateTest.carrierAccountGlobalId} | {rateTest.billingRelationship.replace('_', ' ')} | Evidence{' '}
                {rateTest.evidenceGlobalId}
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
                  setRevealedCredential(null)
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
